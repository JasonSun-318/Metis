import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { ensureDirectoryDurablySync } from "../../durable-file.ts";
import { withMemoryRootLock } from "../memory-lock.ts";
import { MemoryVault } from "../vault.ts";
import type { MemoryEvents } from "../vault-events.ts";
import { pruneSnapshots, readChangelog } from "../vault-history.ts";
import { memoryUsageKey } from "../vault-identity.ts";
import { getDreamDir, getVaultRoot } from "../vault-paths.ts";
import { MEMORY_LIMITS } from "../vault-types.ts";
import { removeUsage } from "../vault-usage.ts";
import { checkDreamGate, enumerateSessions } from "./gate.ts";
import { type DreamPromptFn, runDreamPhase1 } from "./phase1.ts";
import { type DreamPromptAgent, runDreamPhase2 } from "./phase2.ts";
import { readDreamState, writeDreamState } from "./state.ts";
import type { DreamModelRef, DreamRunResult, DreamSettings, EligibleSession } from "./types.ts";

interface RunCounts {
	added: number;
	updated: number;
	deleted: number;
	deletedKeys: string[];
}

/** Tally this run's changelog entries: create→added, delete→deleted, everything else→updated. */
function countRunChanges(root: string, runId: string): RunCounts {
	const counts: RunCounts = { added: 0, updated: 0, deleted: 0, deletedKeys: [] };
	for (const entry of readChangelog(root)) {
		if (entry.actor.kind !== "dream" || entry.actor.runId !== runId) continue;
		if (entry.op === "create" && entry.snapshot === undefined) {
			counts.added++;
		} else if (entry.op === "delete") {
			counts.deleted++;
			if ("slug" in entry.target) {
				counts.deletedKeys.push(memoryUsageKey(entry.scope, entry.target.slug, entry.projectKey));
			}
		} else if (entry.op !== "undo" && entry.op !== "migrate") {
			// append/replace/str_replace/rename and the create leg of a rename.
			counts.updated++;
		}
	}
	return counts;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: undefined;
}

export interface RunDreamOptions {
	agentDir: string;
	settings: DreamSettings;
	/** Pre-enumerated sessions (e.g. from a host session catalog); enumerated on disk when omitted. */
	sessions?: EligibleSession[];
	/** Ids of all existing session files; enumerated on disk when omitted. Used to prune state. */
	existingIds?: ReadonlySet<string>;
	/** Resolved dream model; the run is gated out when absent. */
	model?: DreamModelRef | null;
	promptFn: DreamPromptFn;
	promptAgent: DreamPromptAgent;
	events?: MemoryEvents;
	/** ms since epoch; defaults to Date.now(). */
	now?: number;
	/** Manual runs skip enabled/timing/count thresholds; model, lock, and processed ids still apply. */
	ignoreGate?: boolean;
	concurrency?: number;
	maxWrites?: number;
	/** Overall run bound shared by phase 1 and phase 2; defaults to ~10 minutes. */
	timeoutMs?: number;
	phase2TimeoutMs?: number;
	activeContextEnabled?: () => boolean;
}

/** Whole-run bound; phase 2 additionally has its own timeout for the agent loop. */
export const DREAM_RUN_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * One background consolidation run over eligible sessions. Returns
 * `{ran:false, reason}` when the gate fails. On a mid-run error the staging
 * directory is cleaned and no session is marked processed, so the next run
 * retries the whole batch.
 */
export async function runDream(options: RunDreamOptions): Promise<DreamRunResult> {
	const { agentDir, settings, promptFn, promptAgent } = options;
	const now = options.now ?? Date.now();
	const ignoreGate = options.ignoreGate === true;
	const events = options.events;

	// Layout must exist before lock probes; cheap when already present.
	new MemoryVault({ agentDir }).ensureLayout();
	const root = getVaultRoot(agentDir);

	let sessions = options.sessions;
	let existingIds = options.existingIds;
	if (sessions === undefined || existingIds === undefined) {
		const enumerated = enumerateSessions(agentDir, { now });
		sessions ??= enumerated.sessions;
		existingIds ??= enumerated.existingIds;
	}
	// Injected sessions exist by definition; keep them in the prune set.
	existingIds = new Set([...existingIds, ...sessions.map((session) => session.sessionId)]);

	const gate = await checkDreamGate({
		agentDir,
		settings,
		sessions,
		modelAvailable: options.model != null,
		now,
		ignoreGate,
	});
	if (!gate.eligible) return { ran: false, reason: gate.reason };

	const dreamDir = getDreamDir(root);
	const stagingDir = join(dreamDir, "staging");
	const cleanStaging = () => {
		rmSync(stagingDir, { recursive: true, force: true });
		ensureDirectoryDurablySync(stagingDir);
	};

	let attemptedRunId: string | undefined;
	try {
		// Hold the dream lock for the whole run; the vault root lock is still
		// taken per write so interactive sessions are never blocked.
		return await withMemoryRootLock(dreamDir, async () => {
			const runId = randomUUID();
			attemptedRunId = runId;
			cleanStaging(); // drop leftovers from a crashed run
			const runSignal = AbortSignal.timeout(options.timeoutMs ?? DREAM_RUN_TIMEOUT_MS);
			try {
				const phase1 = await runDreamPhase1({
					sessions: gate.sessions,
					promptFn,
					stagingDir,
					signal: runSignal,
					...(options.concurrency !== undefined ? { concurrency: options.concurrency } : {}),
				});
				if (runSignal.aborted) throw new Error("dream run timed out during phase 1");
				const failed = phase1.sessions.filter((session) => !session.processed);
				if (failed.length > 0 && failed.length === phase1.sessions.length) {
					throw new Error(`all ${failed.length} session extractions failed`);
				}
				if (phase1.candidates.length > 0) {
					const phase2 = await runDreamPhase2({
						agentDir,
						runId,
						candidates: phase1.candidates,
						promptAgent,
						signal: runSignal,
						...(events ? { events } : {}),
						maxUnusedDays: settings.maxUnusedDays,
						...(options.phase2TimeoutMs !== undefined ? { timeoutMs: options.phase2TimeoutMs } : {}),
						...(options.maxWrites !== undefined ? { maxWrites: options.maxWrites } : {}),
						...(options.activeContextEnabled ? { activeContextEnabled: options.activeContextEnabled } : {}),
					});
					if (runSignal.aborted) throw new Error("dream run timed out during phase 2");
					if (!phase2.finished) {
						throw new Error("dream consolidation ended without finish_dream");
					}
				}
				const counts = countRunChanges(root, runId);
				await removeUsage(root, counts.deletedKeys);
				// Snapshot retention mutates shared vault state; take the root lock
				// briefly rather than pinning it for the whole LLM run.
				await withMemoryRootLock(root, () =>
					pruneSnapshots(root, {
						snapshotsPerTarget: MEMORY_LIMITS.snapshotsPerTarget,
						snapshotMaxAgeDays: MEMORY_LIMITS.snapshotMaxAgeDays,
					}),
				);
				const at = new Date(now).toISOString();
				const state = readDreamState(agentDir);
				state.lastRunAt = at;
				state.lastRun = { runId, added: counts.added, updated: counts.updated, deleted: counts.deleted, at };
				state.processedSessionIds = [...state.processedSessionIds, ...phase1.processed];
				writeDreamState(agentDir, state, existingIds);
				cleanStaging();
				events?.emit("dreamCompleted", {
					runId,
					added: counts.added,
					updated: counts.updated,
					deleted: counts.deleted,
				});
				return {
					ran: true,
					runId,
					added: counts.added,
					updated: counts.updated,
					deleted: counts.deleted,
					sessions: phase1.processed.length,
					candidates: phase1.candidates.length,
				};
			} catch (error) {
				// Least state on failure: clean staging, record nothing processed; the
				// next run retries this batch. Committed vault writes stand on their own.
				cleanStaging();
				throw error;
			}
		});
	} catch (error) {
		if (errorCode(error) === "ELOCKED") return { ran: false, reason: "locked" };
		return {
			ran: false,
			reason: "error",
			error: error instanceof Error ? error.message : String(error),
			...(attemptedRunId !== undefined ? { runId: attemptedRunId } : {}),
		};
	}
}
