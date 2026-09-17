import { join } from "node:path";
import {
	ensureDirectoryDurablySync,
	readSingleLinkTextFileSync,
	replaceFileAtomicallySync,
} from "../../durable-file.ts";
import { getDreamDir, getVaultRoot } from "../vault-paths.ts";
import { type DreamState, emptyDreamState } from "./types.ts";

/** Keep the processed-id list bounded; pruning prefers the most recently appended ids. */
const MAX_PROCESSED_SESSION_IDS = 5_000;

export function getDreamStatePath(agentDir: string): string {
	return join(getDreamDir(getVaultRoot(agentDir)), "state.json");
}

/** Read `.dream/state.json`; missing or corrupt content reads as defaults. */
export function readDreamState(agentDir: string): DreamState {
	const raw = readSingleLinkTextFileSync(getDreamStatePath(agentDir), { maxBytes: 4 * 1024 * 1024 });
	if (!raw) return emptyDreamState();
	try {
		const parsed = JSON.parse(raw) as Partial<DreamState>;
		const state = emptyDreamState();
		if (typeof parsed.lastRunAt === "string") state.lastRunAt = parsed.lastRunAt;
		const lastRun = parsed.lastRun;
		if (
			lastRun &&
			typeof lastRun === "object" &&
			typeof lastRun.runId === "string" &&
			typeof lastRun.added === "number" &&
			typeof lastRun.updated === "number" &&
			typeof lastRun.deleted === "number" &&
			typeof lastRun.at === "string"
		) {
			state.lastRun = {
				runId: lastRun.runId,
				added: lastRun.added,
				updated: lastRun.updated,
				deleted: lastRun.deleted,
				at: lastRun.at,
			};
		}
		if (Array.isArray(parsed.processedSessionIds)) {
			state.processedSessionIds = parsed.processedSessionIds.filter(
				(id): id is string => typeof id === "string" && id.length > 0,
			);
		}
		return state;
	} catch {
		return emptyDreamState();
	}
}

/**
 * Write `.dream/state.json` atomically. When `existingIds` is given,
 * processedSessionIds is pruned to sessions whose files still exist, then
 * capped to the most recent 5000 entries.
 */
export function writeDreamState(agentDir: string, state: DreamState, existingIds?: ReadonlySet<string>): void {
	let processed = [...new Set(state.processedSessionIds)];
	if (existingIds !== undefined) processed = processed.filter((id) => existingIds.has(id));
	if (processed.length > MAX_PROCESSED_SESSION_IDS) {
		processed = processed.slice(processed.length - MAX_PROCESSED_SESSION_IDS);
	}
	const next: DreamState = {
		processedSessionIds: processed,
		...(state.lastRunAt !== undefined ? { lastRunAt: state.lastRunAt } : {}),
		lastRun: state.lastRun ?? null,
	};
	const path = getDreamStatePath(agentDir);
	ensureDirectoryDurablySync(getDreamDir(getVaultRoot(agentDir)));
	replaceFileAtomicallySync(path, JSON.stringify(next, null, "\t"), { mode: 0o600 });
}
