import { randomUUID } from "node:crypto";
import type { SessionManager } from "../session-manager.ts";
import {
	GOAL_CUSTOM_TYPE,
	MAX_GOAL_OBJECTIVE_CHARS,
	THREAD_GOAL_STATUSES,
	type ThreadGoal,
	type ThreadGoalStatus,
} from "./types.ts";

export {
	GOAL_CUSTOM_TYPE,
	isActiveGoalStatus,
	isTerminalGoalStatus,
	MAX_GOAL_OBJECTIVE_CHARS,
	type ThreadGoal,
	type ThreadGoalStatus,
} from "./types.ts";

export function validateGoalObjective(raw: string): string {
	const objective = raw.trim();
	if (objective.length === 0) throw new TypeError("Goal objective must not be empty");
	if ([...objective].length > MAX_GOAL_OBJECTIVE_CHARS) {
		throw new TypeError(`Goal objective must be at most ${MAX_GOAL_OBJECTIVE_CHARS} characters`);
	}
	return objective;
}

function isGoalStatus(value: unknown): value is ThreadGoalStatus {
	return typeof value === "string" && (THREAD_GOAL_STATUSES as readonly string[]).includes(value);
}

function parseGoal(data: unknown): ThreadGoal | null {
	if (typeof data !== "object" || data === null) return null;
	const record = data as Record<string, unknown>;
	if (typeof record.goalId !== "string" || record.goalId.length === 0) return null;
	if (typeof record.objective !== "string") return null;
	if (!isGoalStatus(record.status)) return null;
	if (typeof record.timeUsedSeconds !== "number" || !Number.isFinite(record.timeUsedSeconds)) return null;
	if (record.activeStartedAt !== null && typeof record.activeStartedAt !== "number") return null;
	if (typeof record.createdAt !== "number" || typeof record.updatedAt !== "number") return null;
	return {
		goalId: record.goalId,
		objective: record.objective,
		status: record.status,
		timeUsedSeconds: Math.max(0, Math.floor(record.timeUsedSeconds)),
		activeStartedAt: record.activeStartedAt,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
	};
}

export function readThreadGoal(session: Pick<SessionManager, "getEntries">): ThreadGoal | null {
	const entries = session.getEntries();
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type === "custom" && entry.customType === GOAL_CUSTOM_TYPE) {
			if (entry.data === null) return null;
			return parseGoal(entry.data);
		}
	}
	return null;
}

export function writeThreadGoal(
	session: SessionManager,
	input: {
		objective: string;
		status: ThreadGoalStatus;
		goalId?: string;
		timeUsedSeconds?: number;
		createdAt?: number;
		now?: number;
		/** When staying active, force a new activeStartedAt (used after flushing elapsed). */
		resetActiveClock?: boolean;
	},
): ThreadGoal {
	const now = input.now ?? Date.now();
	const existing = readThreadGoal(session);
	const objective = validateGoalObjective(input.objective);
	const replacing = input.goalId !== undefined && (existing === null || existing.goalId !== input.goalId);
	const sameGoal = existing !== null && !replacing && (input.goalId === undefined || existing.goalId === input.goalId);
	const createdAt = sameGoal ? (input.createdAt ?? existing.createdAt) : now;
	const previousElapsed = sameGoal ? existing.timeUsedSeconds : 0;
	const leavingActive =
		sameGoal && existing.status === "active" && existing.activeStartedAt !== null && input.status !== "active";
	const flushed = leavingActive
		? previousElapsed + Math.max(0, Math.floor((now - existing.activeStartedAt!) / 1_000))
		: (input.timeUsedSeconds ?? (sameGoal ? previousElapsed : 0));
	const goal: ThreadGoal = {
		goalId: input.goalId ?? (sameGoal ? existing.goalId : randomUUID()),
		objective,
		status: input.status,
		timeUsedSeconds: flushed,
		activeStartedAt:
			input.status === "active"
				? input.resetActiveClock || !(sameGoal && existing.status === "active")
					? now
					: (existing.activeStartedAt ?? now)
				: null,
		createdAt,
		updatedAt: now,
	};
	session.appendCustomEntry(GOAL_CUSTOM_TYPE, goal);
	return goal;
}

export function flushGoalElapsed(session: SessionManager, goal: ThreadGoal, now = Date.now()): ThreadGoal {
	if (goal.status !== "active" || goal.activeStartedAt === null) return goal;
	return writeThreadGoal(session, {
		...goal,
		timeUsedSeconds: goal.timeUsedSeconds + Math.max(0, Math.floor((now - goal.activeStartedAt) / 1_000)),
		resetActiveClock: true,
		now,
	});
}

export function clearThreadGoal(session: SessionManager): boolean {
	if (readThreadGoal(session) === null) return false;
	session.appendCustomEntry(GOAL_CUSTOM_TYPE, null);
	return true;
}
