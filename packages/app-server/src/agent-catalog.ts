import type { ClientParams, ClientResult, ItemView } from "@metis/app-protocol";
import {
	AgentStore,
	agentSummaryFromRecord,
	agentTaskWindow,
	type FileEntry,
	queuedAdmissionRequestId,
	queuedAgentMessages,
	reduceRuntimeJournal,
	SessionManager,
} from "@metis/coding-agent/host";
import {
	latestAgentInputs,
	projectAgentMailboxItem,
	projectPendingAgentInput,
	withAgentInput,
} from "./agent-conversation-projection.ts";
import { projectAgentQueuedTurns } from "./agent-queued-message-projection.ts";
import { boundedAgentSummaryViews } from "./agent-summary-projection.ts";
import { opaqueId, projectMessageEntry } from "./item-projection.ts";
import { AppServerError, type SessionRef } from "./session-runtime-host.ts";

/** Catalog reads do not acquire a writer lease, recover tasks, or construct a model runtime. */
function withStore<T>(ref: SessionRef, agentDir: string, read: (store: AgentStore) => T): T {
	const root = SessionManager.openReadOnly(ref.path);
	const header = root.getHeader();
	if (!header || header.id !== ref.summary.sessionId || header.agent || header.scheduled) {
		throw new AppServerError("NOT_FOUND", { sessionId: ref.summary.sessionId });
	}
	return read(new AgentStore(root, agentDir));
}

export function listAgentCatalog(
	ref: SessionRef,
	agentDir: string,
	input: ClientParams<"agent/list">,
): ClientResult<"agent/list"> {
	return withStore(ref, agentDir, (store) => {
		const tree = store.listTree();
		const archivedIds = new Set(tree.agents.filter((record) => record.archived).map((record) => record.agentId));
		const summaries = tree.agents
			.filter((record) => input.includeArchived || !record.config.agentPath.some((id) => archivedIds.has(id)))
			.map((record) => agentSummaryFromRecord(record))
			.sort(
				(left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.agentId.localeCompare(left.agentId),
			);
		const cursor = input.afterAgentId ? summaries.findIndex((agent) => agent.agentId === input.afterAgentId) : -1;
		if (input.afterAgentId && cursor < 0) throw new AppServerError("INVALID_CURSOR", { sessionId: input.sessionId });
		const start = cursor + 1;
		const agents = boundedAgentSummaryViews(summaries.slice(start), input.limit ?? 20);
		return {
			agents,
			nextAfterAgentId: start + agents.length < summaries.length ? (agents.at(-1)?.agentId ?? null) : null,
			...(tree.diagnostics.length ? { unreadableAgentCount: tree.diagnostics.length } : {}),
		};
	});
}

export function projectAgentItems(
	journal: readonly FileEntry[],
	input: ClientParams<"agent/readItems">,
	fallbackTimestamp: string,
	liveItems: readonly ItemView[] = [],
): ClientResult<"agent/readItems"> {
	let selected = journal;
	if (input.taskId) {
		const window = agentTaskWindow(journal, input.taskId);
		if (!window) throw new AppServerError("NOT_FOUND", { sessionId: input.sessionId });
		// Admission precedes the running boundary, and delivery may be recorded after
		// the terminal boundary. Keep the task's complete receipt history in either case.
		selected = journal.filter((entry, index) =>
			entry.type === "agent_input"
				? entry.taskId === input.taskId
				: entry.type === "session" || (index >= window.start && index <= window.end),
		);
	}
	const reduced = reduceRuntimeJournal(selected);
	const turns = new Map(reduced.turns.map((turn) => [opaqueId(turn.turnId, "turn"), turn.state]));
	const tools = new Map(reduced.tools.map((tool) => [opaqueId(tool.toolCallId, "tool"), tool.state]));
	const inputs = latestAgentInputs(selected);
	const admissionMessages = new Map(
		journal.flatMap((entry) =>
			entry.type === "agent_input"
				? [[queuedAdmissionRequestId(entry.messageId, entry.id), entry.messageId] as const]
				: [],
		),
	);
	const inputForMessage = (messageId: string) =>
		inputs.get(messageId) ?? inputs.get(admissionMessages.get(messageId) ?? "");
	const persistedMessageIds = new Set(
		selected.flatMap((entry) =>
			entry.type === "message" && entry.agentMessageId
				? [inputForMessage(entry.agentMessageId)?.messageId ?? entry.agentMessageId]
				: [],
		),
	);
	const emittedInputs = new Set<string>();
	const items = selected
		.map((entry) => {
			if (entry.type === "agent_input") {
				if (persistedMessageIds.has(entry.messageId) || emittedInputs.has(entry.messageId)) return undefined;
				emittedInputs.add(entry.messageId);
				const pending = inputs.get(entry.messageId)!;
				// A deleted draft was never conversation history; persisted messages remain visible above.
				if (pending.origin.kind === "user" && pending.delivery === "queue" && pending.state === "cancelled")
					return undefined;
				return projectPendingAgentInput(pending, input.agentId, fallbackTimestamp);
			}
			if (entry.type === "agent_mailbox_event")
				return projectAgentMailboxItem(entry, input.agentId, fallbackTimestamp, inputs);
			const item = projectMessageEntry({
				entry: entry as unknown as Record<string, unknown>,
				sessionId: input.agentId,
				turnStates: turns,
				toolStates: tools,
				fallbackTimestamp,
			});
			return item
				? withAgentInput(
						item,
						entry.type === "message" && entry.agentMessageId ? inputForMessage(entry.agentMessageId) : undefined,
					)
				: undefined;
		})
		.filter((item): item is ItemView => item !== undefined)
		.concat(liveItems.filter((item) => item.role !== "user" || inputs.size === 0));
	const end = input.beforeItemId ? items.findIndex((item) => item.itemId === input.beforeItemId) : items.length;
	if (end < 0) throw new AppServerError("INVALID_CURSOR", { sessionId: input.sessionId });
	const start = Math.max(0, end - input.limit);
	return { items: items.slice(start, end), nextBeforeItemId: start > 0 ? items[start]!.itemId : null };
}

export function readAgentCatalogItems(
	ref: SessionRef,
	agentDir: string,
	input: ClientParams<"agent/readItems">,
): ClientResult<"agent/readItems"> {
	return withStore(ref, agentDir, (store) => {
		const tree = store.listTree();
		const record = tree.agents.find((agent) => agent.agentId === input.agentId);
		if (!record) throw new AppServerError("NOT_FOUND", { sessionId: input.sessionId });
		return projectAgentItems(store.readJournal(record.agentId, record), input, ref.summary.createdAt);
	});
}

/** Queue inspection has the same read-only lifetime as the child transcript. */
export function readAgentCatalogQueue(
	ref: SessionRef,
	agentDir: string,
	input: ClientParams<"agent/queue/read">,
): ClientResult<"agent/queue/read"> {
	return withStore(ref, agentDir, (store) => {
		const record = store.listTree().agents.find((agent) => agent.agentId === input.agentId);
		if (!record) throw new AppServerError("NOT_FOUND", { sessionId: input.sessionId });
		return { queuedTurns: projectAgentQueuedTurns(queuedAgentMessages(record)) };
	});
}
