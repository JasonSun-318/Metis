export type ScheduleSpec =
	| { readonly kind: "once"; readonly date: string; readonly time: string }
	| { readonly kind: "daily"; readonly time: string }
	| { readonly kind: "weekly"; readonly weekdays: readonly number[]; readonly time: string }
	| { readonly kind: "monthly"; readonly day: number; readonly time: string }
	| { readonly kind: "interval"; readonly every: number; readonly unit: "minute" | "hour"; readonly startAt: string };

export type ScheduleInputSpec =
	| Exclude<ScheduleSpec, { kind: "interval" }>
	| {
			readonly kind: "interval";
			readonly every: number;
			readonly unit: "minute" | "hour";
			readonly startDate: string;
			readonly startTime: string;
	  };

export type ScheduleTarget =
	| { readonly kind: "project"; readonly cwd: string }
	| { readonly kind: "general"; readonly workspace: "task"; readonly cwd: string }
	| { readonly kind: "general"; readonly workspace: "fixed"; readonly cwd: string };

export type ScheduleTaskStatus = "active" | "paused" | "completed" | "deleting";
export type ScheduleRunStatus = "queued" | "running" | "succeeded" | "failed" | "missed" | "skipped" | "cancelled";

export type ScheduleErrorCode =
	| "SCHEDULE_NOT_FOUND"
	| "RUN_NOT_FOUND"
	| "TASK_ID_REUSED"
	| "RUN_ID_REUSED"
	| "TASK_BUSY"
	| "TASK_DELETING"
	| "INVALID_SCHEDULE"
	| "EXECUTION_FAILED"
	| "WORKSPACE_MISSING"
	| "SANDBOX_UNAVAILABLE"
	| "STORE_LIMIT"
	| "STORE_CORRUPT";

export class ScheduleError extends Error {
	readonly code: ScheduleErrorCode;
	readonly executionSession?: { readonly sessionId: string; readonly sessionFile: string };

	constructor(
		code: ScheduleErrorCode,
		message: string,
		options?: ErrorOptions & { executionSession?: { readonly sessionId: string; readonly sessionFile: string } },
	) {
		super(message, options);
		this.name = "ScheduleError";
		this.code = code;
		this.executionSession = options?.executionSession;
	}
}

export interface ScheduleRunSummary {
	readonly id: string;
	readonly taskId: string;
	readonly sequence: number;
	readonly status: ScheduleRunStatus;
	readonly scheduledFor: string;
	readonly createdAt: string;
	readonly completedAt?: string;
	readonly sessionId?: string;
	readonly resultPreview?: string;
	readonly error?: { readonly code: string; readonly message: string };
	readonly reason?: "overlap" | "offline" | "interrupted" | "deleted";
	readonly skippedCount?: number;
	readonly unread: boolean;
}

export interface ScheduleTask {
	readonly id: string;
	readonly title: string;
	readonly instruction: string;
	readonly schedule: ScheduleSpec;
	readonly timezone: string;
	readonly target: ScheduleTarget;
	readonly status: ScheduleTaskStatus;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly nextRunAt: string | null;
	readonly activeRunId?: string;
	readonly unreadCount: number;
	readonly lastRun?: ScheduleRunSummary;
	readonly pauseReason?: "user" | "workspace_missing";
	readonly createdFromSessionId?: string;
	readonly deletingSince?: string;
	readonly nextRunSequence: number;
}

export interface ScheduleTaskSnapshot {
	readonly instruction: string;
	readonly schedule: ScheduleSpec;
	readonly timezone: string;
	readonly target: ScheduleTarget;
}

export interface ScheduleRun {
	readonly id: string;
	readonly taskId: string;
	readonly sequence: number;
	readonly trigger: "scheduled" | "manual";
	readonly status: ScheduleRunStatus;
	readonly scheduledFor: string;
	readonly createdAt: string;
	readonly startedAt?: string;
	readonly completedAt?: string;
	readonly runnerId?: string;
	readonly sessionId?: string;
	readonly sessionFile?: string;
	readonly resultPreview?: string;
	readonly error?: { readonly code: string; readonly message: string };
	readonly reason?: "overlap" | "offline" | "interrupted" | "deleted";
	readonly skippedCount?: number;
	readonly unread: boolean;
	readonly snapshot: ScheduleTaskSnapshot;
}

export type ScheduleCreateTarget =
	| { readonly kind: "project"; readonly cwd: string }
	| { readonly kind: "general"; readonly workspace: "fixed"; readonly cwd: string }
	| { readonly kind: "general"; readonly workspace: "task" };

export interface ScheduleCreateInput {
	readonly id: string;
	readonly instruction: string;
	readonly schedule: ScheduleInputSpec;
	readonly timezone: string;
	readonly target: ScheduleCreateTarget;
	readonly createdFromSessionId?: string;
}

export interface ScheduleUpdateInput {
	readonly instruction?: string;
	readonly schedule?: ScheduleInputSpec;
}

export interface ScheduleTaskPage {
	readonly tasks: readonly ScheduleTask[];
	readonly nextAfterTaskId: string | null;
}

export interface ScheduleRunListInput {
	readonly beforeRunId?: string;
	readonly limit?: number;
}

export interface ScheduleRunPage {
	readonly runs: readonly ScheduleRun[];
	readonly nextBeforeRunId: string | null;
}

export interface ScheduleRunClaim {
	readonly taskId: string;
	readonly runId: string;
	readonly scheduledFor: string;
	readonly snapshot: ScheduleTaskSnapshot;
}

export interface ScheduleExecutionResult {
	readonly runId: string;
	readonly sessionId: string;
	readonly sessionFile: string;
	readonly result: string;
}

export type ScheduleEvent =
	| { readonly type: "schedule/updated"; readonly revision: number; readonly task: ScheduleTask }
	| { readonly type: "schedule/deleted"; readonly revision: number; readonly taskId: string }
	| {
			readonly type: "schedule/run-updated";
			readonly revision: number;
			readonly task: ScheduleTask;
			readonly run: ScheduleRun;
	  }
	| { readonly type: "schedule/refreshed"; readonly revision: number };

export interface ScheduleStoreEvent {
	readonly sequence: number;
	readonly revision: number;
	readonly createdAt: string;
	readonly type: "task-updated" | "task-deleted" | "run-updated";
	readonly taskId: string;
	readonly runId?: string;
}
