import type { CwdOrigin } from "../../session-workspace.ts";
import type { MemorySettings } from "../../settings-manager.ts";
import type { VaultProjectIdentity } from "../vault-project.ts";
import type { MemoryScope, NoteType } from "../vault-types.ts";

/** Configured memory model pointer; resolution to a full Model happens in llm.ts. */
export interface DreamModelRef {
	provider: string;
	modelId: string;
}

/** Dream settings with all defaults applied. `enabled` already folds in autoMemoryEnabled. */
export interface DreamSettings {
	enabled: boolean;
	/** Explicit `memory.dream.model` override; null means "cheapest credentialed model". */
	model: DreamModelRef | null;
	minHours: number;
	minSessions: number;
	maxUnusedDays: number;
}

export const DREAM_SETTING_DEFAULTS = {
	minHours: 24,
	minSessions: 5,
	maxUnusedDays: 90,
} as const;

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.min(Math.max(Math.trunc(value), min), max);
}

/** Resolve the raw `memory` settings block into DreamSettings with defaults and clamps. */
export function resolveDreamSettings(memory: MemorySettings | undefined, autoMemoryEnabled = true): DreamSettings {
	const dream = memory?.dream ?? {};
	const model =
		typeof dream.model?.provider === "string" &&
		dream.model.provider.length > 0 &&
		typeof dream.model.modelId === "string" &&
		dream.model.modelId.length > 0
			? { provider: dream.model.provider, modelId: dream.model.modelId }
			: null;
	return {
		enabled: autoMemoryEnabled && dream.enabled !== false,
		model,
		minHours: boundedInteger(dream.minHours, DREAM_SETTING_DEFAULTS.minHours, 1, 8_760),
		minSessions: boundedInteger(dream.minSessions, DREAM_SETTING_DEFAULTS.minSessions, 1, 100_000),
		maxUnusedDays: boundedInteger(dream.maxUnusedDays, DREAM_SETTING_DEFAULTS.maxUnusedDays, 1, 3_650),
	};
}

/** Persisted `.dream/state.json` content. */
export interface DreamState {
	lastRunAt?: string;
	lastRun?: { runId: string; added: number; updated: number; deleted: number; at: string } | null;
	/** Session ids already mined by phase 1; pruned to existing files, capped. */
	processedSessionIds: string[];
}

export function emptyDreamState(): DreamState {
	return { processedSessionIds: [] };
}

/** A session file that passed per-file eligibility (not yet filtered by processed ids). */
export interface EligibleSession {
	path: string;
	sessionId: string;
	cwd: string;
	cwdOrigin?: CwdOrigin;
	/** Session file mtime in ms since epoch. */
	updatedAt: number;
}

/** One memory candidate produced by phase 1 for a session. */
export interface DreamCandidate {
	sessionId: string;
	type?: NoteType;
	scope: MemoryScope;
	/** Model-provided topic/slug hint; normalized to the safe-slug alphabet. */
	slug?: string;
	text: string;
	evidence?: string;
	/** True when the source session used web/MCP tools (untrusted content). */
	polluted: boolean;
	/** Resolved project identity; present exactly when scope === "project". */
	project?: VaultProjectIdentity;
}

export type DreamGateReason = "disabled" | "too-soon" | "insufficient-sessions" | "no-model" | "locked";

export type DreamGateResult =
	| { eligible: false; reason: DreamGateReason }
	| { eligible: true; sessions: EligibleSession[] };

export type DreamRunResult =
	| {
			ran: true;
			runId: string;
			added: number;
			updated: number;
			deleted: number;
			/** Sessions that completed phase 1 this run. */
			sessions: number;
			/** Total candidates produced by phase 1. */
			candidates: number;
	  }
	| {
			ran: false;
			reason: DreamGateReason | "error";
			error?: string;
			/** Present when the run started and failed mid-flight; its writes stay attributable/undoable. */
			runId?: string;
	  };
