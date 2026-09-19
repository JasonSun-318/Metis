import type { AgentMessage } from "@metis/agent-core";
import { getContextSourceDigest } from "./context-view.ts";
import { type SessionEntry, sessionEntryToContextMessages } from "./session-manager.ts";

interface MessageSource {
	entryId: string;
	originId: string;
	message: AgentMessage;
}

/** Delivery timestamps differ between staging and persistence; event content must still match. */
function sourceDigest(message: AgentMessage): string {
	return getContextSourceDigest(
		message.role === "custom" && message.customType === "agent_mailbox" ? { ...message, timestamp: 0 } : message,
	);
}

export function mailboxOrigin(message: AgentMessage): string | undefined {
	if (message.role !== "custom" || message.customType !== "agent_mailbox") return undefined;
	const details = message.details as { eventId?: unknown } | undefined;
	return typeof details?.eventId === "string" ? `mailbox:${details.eventId}` : undefined;
}

/** One branch-scoped resolver shared by cache attribution and context pruning. */
export class ContextMessageSources {
	private readonly byId = new Map<string, MessageSource>();
	private readonly byObject = new WeakMap<AgentMessage, MessageSource>();
	private byDigest: Map<string, MessageSource | null> | undefined;
	private readonly sources: MessageSource[] = [];

	constructor(entries: readonly SessionEntry[], staged: readonly AgentMessage[] = []) {
		for (const entry of entries) {
			for (const message of sessionEntryToContextMessages(entry)) {
				this.add({
					entryId: entry.id,
					originId:
						mailboxOrigin(message) ?? `${entry.type === "compaction" ? "compaction" : "entry"}:${entry.id}`,
					message,
				});
			}
			const carry =
				entry.type === "compaction"
					? entry.contextCarry
					: entry.type === "custom" && entry.customType === "metis_context_carry_v1"
						? (entry.data as { carry?: { messages?: AgentMessage[] } } | undefined)?.carry
						: undefined;
			carry?.messages?.forEach((message, index) => {
				this.add({ entryId: entry.id, originId: `compaction:${entry.id}:carry:${index}`, message });
			});
		}
		for (const message of staged) {
			const originId = mailboxOrigin(message);
			if (originId) this.add({ entryId: originId, originId, message });
		}
	}

	private add(source: MessageSource): void {
		this.byId.set(source.entryId, source);
		this.byObject.set(source.message, source);
		this.sources.push(source);
	}

	resolve(message: AgentMessage, entryId?: string): MessageSource | undefined {
		const known = (entryId ? this.byId.get(entryId) : undefined) ?? this.byObject.get(message);
		if (known) return known;
		// Ordinary messages resolve by durable identity. Serialize the branch only
		// when a reconstructed summary or extension clone needs content matching.
		if (!this.byDigest) {
			this.byDigest = new Map();
			for (const source of this.sources) {
				const digest = sourceDigest(source.message);
				const previous = this.byDigest.get(digest);
				this.byDigest.set(digest, previous === undefined || previous?.originId === source.originId ? source : null);
			}
		}
		return this.byDigest.get(sourceDigest(message)) ?? undefined;
	}
}
