import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { resolvePath } from "../../../utils/paths.ts";
import { inspectSessionLease } from "../../session-lease.ts";
import { readSessionDisplayMetadata, readSessionHeaderInfo } from "../../session-manager.ts";
import { withMemoryRootLock } from "../memory-lock.ts";
import { getDreamDir, getVaultRoot } from "../vault-paths.ts";
import { readDreamState } from "./state.ts";
import type { DreamGateResult, DreamSettings, EligibleSession } from "./types.ts";

/** Sessions must be idle this long before a dream run mines them. */
export const DREAM_SESSION_MIN_IDLE_MS = 2 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

export interface EnumerateSessionsOptions {
	/** ms since epoch; defaults to Date.now(). */
	now?: number;
	/** Minimum session idle time; defaults to 2h. */
	minIdleMs?: number;
	/** Session ids to exclude entirely (e.g. already processed). */
	excludeIds?: ReadonlySet<string>;
}

export interface EnumeratedSessions {
	/** Sessions passing all per-file eligibility filters, oldest first. */
	sessions: EligibleSession[];
	/** Ids of every session file found, eligible or not; used to prune state.json. */
	existingIds: Set<string>;
}

/**
 * Cross-project session enumerator: scans `<agentDir>/sessions/<dir>/*.jsonl`,
 * reads only each file's header line, and filters out scheduled/child sessions,
 * sessions held by a live lease, sessions active within the last `minIdleMs`,
 * sessions opted out via `contributeMemory: false`, and `excludeIds`.
 */
export function enumerateSessions(agentDir: string, options: EnumerateSessionsOptions = {}): EnumeratedSessions {
	const now = options.now ?? Date.now();
	const minIdleMs = options.minIdleMs ?? DREAM_SESSION_MIN_IDLE_MS;
	const sessionsRoot = join(resolvePath(agentDir), "sessions");
	const sessions: EligibleSession[] = [];
	const existingIds = new Set<string>();

	let projectDirs: string[];
	try {
		projectDirs = readdirSync(sessionsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
			.map((entry) => join(sessionsRoot, entry.name));
	} catch {
		return { sessions, existingIds };
	}

	for (const dir of projectDirs) {
		let files: string[];
		try {
			files = readdirSync(dir)
				.filter((name) => name.endsWith(".jsonl"))
				.map((name) => join(dir, name));
		} catch {
			continue;
		}
		for (const path of files) {
			const info = readSessionHeaderInfo(path);
			if (!info) continue;
			const { header, mtimeMs } = info;
			if (typeof header.id !== "string" || header.id.length === 0) continue;
			existingIds.add(header.id);
			if (options.excludeIds?.has(header.id)) continue;
			if (header.scheduled !== undefined) continue;
			if (header.agent !== undefined) continue;
			if (typeof header.cwd !== "string" || header.cwd.length === 0) continue;
			// Sessions opt out of dream mining through their display-metadata sidecar.
			if (readSessionDisplayMetadata(path)?.contributeMemory === false) continue;
			if (now - mtimeMs < minIdleMs) continue;
			const lease = inspectSessionLease(path);
			if (lease !== "free" && lease !== "stale") continue;
			sessions.push({
				path,
				sessionId: header.id,
				cwd: header.cwd,
				...(header.cwdOrigin !== undefined ? { cwdOrigin: header.cwdOrigin } : {}),
				updatedAt: mtimeMs,
			});
		}
	}
	sessions.sort((left, right) => left.updatedAt - right.updatedAt);
	return { sessions, existingIds };
}

/** Probe that both the vault root and the dream directory are lockable right now. */
async function vaultUnlocked(agentDir: string): Promise<boolean> {
	const root = getVaultRoot(agentDir);
	for (const path of [root, getDreamDir(root)]) {
		if (!existsSync(path)) continue;
		try {
			await withMemoryRootLock(path, () => {});
		} catch {
			return false;
		}
	}
	return true;
}

/**
 * Dream gate: all conditions of plan §1.8 must hold. `sessions` are the output
 * of {@link enumerateSessions}; `modelAvailable` is resolved by the caller so
 * the credential check stays injectable.
 *
 * With `ignoreGate`, only model availability and the vault lock are enforced;
 * sessions already in `processedSessionIds` are still excluded (they were mined).
 */
export async function checkDreamGate(options: {
	agentDir: string;
	settings: DreamSettings;
	sessions: EligibleSession[];
	modelAvailable: boolean;
	/** ms since epoch; defaults to Date.now(). */
	now?: number;
	ignoreGate?: boolean;
}): Promise<DreamGateResult> {
	const { agentDir, settings, sessions, modelAvailable } = options;
	const now = options.now ?? Date.now();
	const ignoreGate = options.ignoreGate === true;

	if (!ignoreGate) {
		if (!settings.enabled) return { eligible: false, reason: "disabled" };
	}

	const state = readDreamState(agentDir);
	if (!ignoreGate && typeof state.lastRunAt === "string") {
		const lastRunAt = Date.parse(state.lastRunAt);
		if (Number.isFinite(lastRunAt) && now - lastRunAt < settings.minHours * HOUR_MS) {
			return { eligible: false, reason: "too-soon" };
		}
	}

	const processed = new Set(state.processedSessionIds);
	const pending = sessions.filter((session) => !processed.has(session.sessionId));
	if (!ignoreGate && pending.length < settings.minSessions) {
		return { eligible: false, reason: "insufficient-sessions" };
	}

	if (!modelAvailable) return { eligible: false, reason: "no-model" };

	if (!(await vaultUnlocked(agentDir))) return { eligible: false, reason: "locked" };

	return { eligible: true, sessions: pending };
}
