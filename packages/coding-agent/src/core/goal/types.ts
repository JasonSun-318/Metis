export const MAX_GOAL_OBJECTIVE_CHARS = 4_000;
export const GOAL_CUSTOM_TYPE = "thread_goal";

export const THREAD_GOAL_STATUSES = ["active", "paused", "blocked", "usage_limited", "complete"] as const;

export type ThreadGoalStatus = (typeof THREAD_GOAL_STATUSES)[number];

export interface ThreadGoal {
	readonly goalId: string;
	readonly objective: string;
	readonly status: ThreadGoalStatus;
	readonly timeUsedSeconds: number;
	readonly activeStartedAt: number | null;
	readonly createdAt: number;
	readonly updatedAt: number;
}

export function isTerminalGoalStatus(status: ThreadGoalStatus): boolean {
	return status === "complete";
}

export function isActiveGoalStatus(status: ThreadGoalStatus): boolean {
	return status === "active";
}
