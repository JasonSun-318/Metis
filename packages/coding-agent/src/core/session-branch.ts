import type { AgentMessage } from "@metis/agent-core";
import { resolveSessionMessage } from "./indexed-session-records.ts";
import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage } from "./messages.ts";
import type {
	CompactionContextCarry,
	CompactionEntry,
	CustomEntry,
	SessionContext,
	SessionEntry,
} from "./session-manager.ts";

export const CONTEXT_CARRY_MIGRATION_TYPE = "metis_context_carry_v1";

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}

export function buildEntryIndex(entries: SessionEntry[], byId?: Map<string, SessionEntry>): Map<string, SessionEntry> {
	if (byId) return byId;
	const index = new Map<string, SessionEntry>();
	for (const entry of entries) {
		index.set(entry.id, entry);
	}
	return index;
}

export function buildSessionPath(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	const index = buildEntryIndex(entries, byId);
	let leaf: SessionEntry | undefined;
	if (leafId === null) {
		return [];
	}
	if (leafId) {
		leaf = index.get(leafId);
	}
	leaf ??= entries[entries.length - 1];
	if (!leaf) {
		return [];
	}

	const path: SessionEntry[] = [];
	let current: SessionEntry | undefined = leaf;
	while (current) {
		path.push(current);
		current = current.parentId ? index.get(current.parentId) : undefined;
	}
	path.reverse();
	return path;
}

function getSessionContextSettings(path: SessionEntry[]): Pick<SessionContext, "thinkingLevel" | "model"> {
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		} else if (entry.type === "message" && entry.message.role === "assistant") {
			model = { provider: entry.message.provider, modelId: entry.message.model };
		}
	}

	return { thinkingLevel, model };
}

/**
 * Project one selected session entry into LLM/runtime messages.
 * Plain custom entries are display/state entries and do not participate in context.
 */
export function sessionEntryToContextMessages(entry: SessionEntry): AgentMessage[] {
	if (entry.type === "message") {
		const message = resolveSessionMessage(entry);
		// Session files are parsed without validation; old versions, forks, or
		// hand-edited files can contain messages with null/missing content.
		if (
			(message.role === "user" || message.role === "assistant" || message.role === "toolResult") &&
			message.content == null
		) {
			return [{ ...message, content: [] }];
		}
		return [message];
	}
	if (entry.type === "custom_message") {
		return [
			createCustomMessage(entry.customType, entry.content ?? [], entry.display, entry.details, entry.timestamp),
		];
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return [createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp)];
	}
	if (entry.type === "compaction") {
		return [createCompactionSummaryMessage(entry.summary, entry.tokensBefore, entry.timestamp)];
	}
	return [];
}

/**
 * Build the active, compaction-aware session entry list.
 *
 * This follows the current leaf path. If the path contains compaction entries,
 * the latest compaction is represented by the compaction entry itself, followed
 * by the kept entries starting at firstKeptEntryId and all entries after the
 * compaction entry. Older summarized entries are omitted.
 */
export function buildContextEntries(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] {
	const path = buildSessionPath(entries, leafId, byId);
	let compaction: CompactionEntry | null = null;

	for (const entry of path) {
		if (entry.type === "compaction") {
			compaction = entry;
		}
	}

	if (!compaction) {
		return path;
	}

	const compactionIdx = path.findIndex((entry) => entry.id === compaction.id);
	if (compactionIdx < 0) {
		return path;
	}

	const contextEntries: SessionEntry[] = [compaction];
	let foundFirstKept = false;
	for (let i = 0; i < compactionIdx; i++) {
		const entry = path[i];
		if (entry.id === compaction.firstKeptEntryId) {
			foundFirstKept = true;
		}
		if (foundFirstKept) {
			contextEntries.push(entry);
		}
	}
	contextEntries.push(...path.slice(compactionIdx + 1));
	return contextEntries;
}

function isCarryMessage(message: unknown): message is AgentMessage {
	const m = message as { role?: unknown; customType?: unknown; display?: unknown };
	return (
		typeof m === "object" &&
		m !== null &&
		m.role === "custom" &&
		m.customType === "latest_tasks" &&
		m.display === false
	);
}

export function isContextCarry(carry: unknown): carry is CompactionContextCarry {
	const c = carry as { version?: unknown; messages?: unknown };
	return (
		typeof c === "object" &&
		c !== null &&
		c.version === 1 &&
		Array.isArray(c.messages) &&
		c.messages.every(isCarryMessage)
	);
}

export function isCarryMigration(
	data: unknown,
	compactionEntryId: string,
): data is { compactionEntryId: string; carry: CompactionContextCarry } {
	const d = data as { compactionEntryId?: unknown; carry?: unknown };
	return typeof d === "object" && d !== null && d.compactionEntryId === compactionEntryId && isContextCarry(d.carry);
}

/**
 * The latest-tasks carry for a compaction boundary: the newest non-error
 * set_tasks result that falls outside the kept range and still has
 * incomplete tasks. Empty result is a decision, not "unknown".
 */
export function computeCompactionTasksCarry(
	path: readonly SessionEntry[],
	isKept: (entryId: string) => boolean,
): AgentMessage[] {
	for (let index = path.length - 1; index >= 0; index--) {
		const entry = path[index];
		if (
			entry?.type !== "message" ||
			entry.message.role !== "toolResult" ||
			entry.message.toolName !== "set_tasks" ||
			entry.message.isError !== false
		) {
			continue;
		}
		if (isKept(entry.id)) return [];
		const details = entry.message.details;
		const tasks =
			typeof details === "object" && details !== null ? (details as { tasks?: unknown }).tasks : undefined;
		if (
			!Array.isArray(tasks) ||
			!tasks.some(
				(task) =>
					typeof task === "object" && task !== null && (task as { completed?: unknown }).completed === false,
			)
		) {
			return [];
		}
		return [createCustomMessage("latest_tasks", entry.message.content ?? [], false, undefined, entry.timestamp)];
	}
	return [];
}

export function latestCompactedTasksMessage(
	path: SessionEntry[],
	contextEntries: SessionEntry[],
): AgentMessage | undefined {
	if (!contextEntries.some(({ type }) => type === "compaction")) return undefined;
	const contextIds = new Set(contextEntries.map(({ id }) => id));
	return computeCompactionTasksCarry(path, (id) => contextIds.has(id))[0];
}

/**
 * Build the session context from entries using tree traversal.
 * If leafId is provided, walks from that entry to root.
 * Handles compaction and branch summaries along the path.
 */
export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionContext {
	const path = buildSessionPath(entries, leafId, byId);
	const { thinkingLevel, model } = getSessionContextSettings(path);
	const contextEntries = buildContextEntries(entries, leafId, byId);
	const messages = contextEntries.flatMap(sessionEntryToContextMessages);
	const compaction = contextEntries.find((e): e is CompactionEntry => e.type === "compaction");
	let carryMessages: AgentMessage[] = [];
	if (compaction) {
		if (isContextCarry(compaction.contextCarry)) {
			carryMessages = compaction.contextCarry.messages;
		} else {
			const migration = contextEntries.find(
				(e): e is CustomEntry =>
					e.type === "custom" &&
					e.customType === CONTEXT_CARRY_MIGRATION_TYPE &&
					isCarryMigration(e.data, compaction.id),
			);
			if (migration) {
				carryMessages = (migration.data as { carry: CompactionContextCarry }).carry.messages;
			} else {
				const live = latestCompactedTasksMessage(path, contextEntries);
				if (live) carryMessages = [live];
			}
		}
	}
	if (carryMessages.length > 0) messages.splice(1, 0, ...carryMessages);
	return { messages, thinkingLevel, model };
}
