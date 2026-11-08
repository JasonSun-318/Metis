import type { ArchivedConversationView, ClientParams, ClientResult } from "@metis/app-protocol";
import { type AgentCatalogMetadata, AgentStore, SessionManager } from "@metis/coding-agent/host";
import { AppServerError, type SessionRef } from "./session-runtime-host.ts";

const MAX_METADATA_CACHE_BYTES = 8 * 1024 * 1024;
type Position = { updatedAt: string; key: string };

function position(conversation: ArchivedConversationView): Position {
	return {
		updatedAt: conversation.kind === "session" ? conversation.session.updatedAt : conversation.updatedAt,
		key: `${conversation.session.sessionId}:${conversation.kind}:${conversation.kind === "agent" ? conversation.agentId : ""}`,
	};
}

function compare(left: Position, right: Position): number {
	return right.updatedAt.localeCompare(left.updatedAt) || right.key.localeCompare(left.key);
}

function decodeCursor(cursor: string): Position {
	try {
		const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
		if (
			typeof value === "object" &&
			value !== null &&
			"updatedAt" in value &&
			typeof value.updatedAt === "string" &&
			Number.isFinite(Date.parse(value.updatedAt)) &&
			"key" in value &&
			typeof value.key === "string" &&
			value.key.length > 0
		)
			return { updatedAt: value.updatedAt, key: value.key };
	} catch {
		// Cursors are client-controlled opaque tokens, never file paths or storage identities.
	}
	throw new AppServerError("INVALID_CURSOR");
}

function agentStore(ref: SessionRef, agentDir: string): AgentStore {
	const header = SessionManager.readHeaderReadOnly(ref.path);
	if (!header || header.id !== ref.summary.sessionId || header.agent || header.scheduled) {
		throw new AppServerError("NOT_FOUND", { sessionId: ref.summary.sessionId });
	}
	return new AgentStore({ getSessionId: () => header.id, getSessionFile: () => ref.path }, agentDir);
}

/** This settings-only catalog retains display metadata, never conversations or model runtimes. */
export class ArchivedConversationCatalog {
	private readonly agentDir: string;
	private readonly metadata = new Map<string, { fingerprint: string; value: AgentCatalogMetadata; bytes: number }>();
	private bytes = 0;

	constructor(agentDir: string) {
		this.agentDir = agentDir;
	}

	async list(
		refs: readonly SessionRef[],
		input: ClientParams<"session/archived/list">,
	): Promise<ClientResult<"session/archived/list">> {
		const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
		const conversations: ArchivedConversationView[] = [];
		for (const ref of refs) {
			if (ref.summary.archived) conversations.push({ kind: "session", session: structuredClone(ref.summary) });
			if (ref.scheduled || ref.summary.state === "unsupported" || ref.summary.state === "corrupt") continue;
			const tree = await agentStore(ref, this.agentDir).listMetadata(async (path, stat, load) => {
				const fingerprint = `${ref.summary.sessionId}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
				const cached = this.metadata.get(path);
				const value = cached?.fingerprint === fingerprint ? cached.value : await load();
				const previous = this.metadata.get(path);
				if (previous) {
					this.metadata.delete(path);
					this.bytes -= previous.bytes;
				}
				const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
				if (bytes <= MAX_METADATA_CACHE_BYTES) {
					while (this.bytes + bytes > MAX_METADATA_CACHE_BYTES) {
						const oldest = this.metadata.entries().next().value;
						if (!oldest) break;
						this.metadata.delete(oldest[0]);
						this.bytes -= oldest[1].bytes;
					}
					this.metadata.set(path, { fingerprint, value, bytes });
					this.bytes += bytes;
				}
				return value;
			});
			const archivedIds = new Set(tree.agents.filter((agent) => agent.archived).map((agent) => agent.agentId));
			for (const agent of tree.agents) {
				if (!ref.summary.archived && !agent.agentPath.some((id) => archivedIds.has(id))) continue;
				conversations.push({
					kind: "agent",
					// Wire envelopes reject shared object references, including repeated parent metadata.
					session: structuredClone(ref.summary),
					agentId: agent.agentId,
					name: agent.name,
					updatedAt: agent.updatedAt,
				});
			}
		}
		const remaining = conversations
			.filter((conversation) => !cursor || compare(position(conversation), cursor) > 0)
			.sort((left, right) => compare(position(left), position(right)));
		const page = remaining.slice(0, input.limit ?? 30);
		return {
			conversations: page,
			nextCursor:
				remaining.length > page.length && page.length > 0
					? Buffer.from(JSON.stringify(position(page.at(-1)!))).toString("base64url")
					: null,
		};
	}
}

/** The dispatcher holds the archived root closed and its project mutation guard throughout deletion. */
export async function deleteArchivedAgent(
	ref: SessionRef,
	agentDir: string,
	input: ClientParams<"agent/delete">,
): Promise<ClientResult<"agent/delete">> {
	if (!ref.summary.archived) throw new AppServerError("INVALID_PARAMS", input);
	const store = agentStore(ref, agentDir);
	await store.recoverDeleteMarkers();
	const tree = store.listTree();
	const target = tree.agents.find((agent) => agent.agentId === input.agentId);
	if (!target) {
		if (store.listTombstones().some((agent) => agent.agentId === input.agentId))
			return { agentId: input.agentId, status: "deleted" };
		throw new AppServerError("NOT_FOUND", input);
	}
	const descendants = tree.agents
		.filter((agent) => target.config.agentPath.every((id, index) => agent.config.agentPath[index] === id))
		.sort((left, right) => right.config.agentPath.length - left.config.agentPath.length);
	store.beginDeleteGroup(
		input.agentId,
		descendants.map((agent) => ({
			agentId: agent.agentId,
			name: agent.name,
			status: "deleted",
			deletedAt: new Date().toISOString(),
		})),
	);
	const result = await store.finishDeleteGroup(input.agentId);
	if (result.status !== "deleted") throw new AppServerError("OPERATION_FAILED", input);
	return { agentId: input.agentId, status: "deleted" };
}
