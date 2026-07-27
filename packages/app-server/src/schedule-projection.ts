import type { DomainEvent, ScheduleRunView, ScheduleTaskView } from "@arcmind/app-protocol";
import type {
	ScheduleEvent,
	ScheduleRun,
	ScheduleRunSummary,
	ScheduleSpec,
	ScheduleTarget,
	ScheduleTask,
} from "@arcmind/coding-agent";

function scheduleView(schedule: ScheduleSpec): ScheduleTaskView["schedule"] {
	return schedule.kind === "weekly" ? { ...schedule, weekdays: [...schedule.weekdays] } : schedule;
}

function targetView(target: ScheduleTarget): ScheduleTaskView["target"] {
	if (target.kind === "project") return { kind: "project", cwd: target.cwd };
	return target.workspace === "fixed"
		? { kind: "general", workspace: "fixed", cwd: target.cwd }
		: { kind: "general", workspace: "task" };
}

function runSummaryView(run: ScheduleRunSummary): NonNullable<ScheduleTaskView["lastRun"]> {
	return {
		id: run.id,
		taskId: run.taskId,
		status: run.status,
		scheduledFor: run.scheduledFor,
		createdAt: run.createdAt,
		...(run.completedAt ? { completedAt: run.completedAt } : {}),
		...(run.sessionId ? { sessionId: run.sessionId } : {}),
		...(run.resultPreview !== undefined ? { resultPreview: run.resultPreview } : {}),
		...(run.error ? { error: run.error } : {}),
		...(run.reason ? { reason: run.reason } : {}),
		...(run.skippedCount !== undefined ? { skippedCount: run.skippedCount } : {}),
		unread: run.unread,
	};
}

export function scheduleTaskView(task: ScheduleTask): ScheduleTaskView {
	return {
		id: task.id,
		title: task.title,
		instruction: task.instruction,
		schedule: scheduleView(task.schedule),
		timezone: task.timezone,
		target: targetView(task.target),
		status: task.status,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		nextRunAt: task.nextRunAt,
		unreadCount: task.unreadCount,
		...(task.lastRun ? { lastRun: runSummaryView(task.lastRun) } : {}),
		...(task.pauseReason ? { pauseReason: task.pauseReason } : {}),
		...(task.createdFromSessionId ? { createdFromSessionId: task.createdFromSessionId } : {}),
	};
}

export function scheduleRunView(run: ScheduleRun): ScheduleRunView {
	return {
		...runSummaryView(run),
		...(run.startedAt ? { startedAt: run.startedAt } : {}),
		trigger: run.trigger,
		snapshot: {
			instruction: run.snapshot.instruction,
			schedule: scheduleView(run.snapshot.schedule),
			timezone: run.snapshot.timezone,
			target: targetView(run.snapshot.target),
		},
	};
}

export function scheduleEventView(event: ScheduleEvent): DomainEvent | undefined {
	if (event.type === "schedule/updated") return { type: "schedule/updated", task: scheduleTaskView(event.task) };
	if (event.type === "schedule/deleted") return { type: "schedule/deleted", taskId: event.taskId };
	if (event.type === "schedule/refreshed") return { type: "schedule/refreshed" };
	const run = event.run;
	const common = {
		taskId: run.taskId,
		runId: run.id,
		unread: run.unread,
		createdAt: run.createdAt,
		...(run.sessionId ? { sessionId: run.sessionId } : {}),
	};
	if (run.status === "succeeded") {
		return {
			type: "schedule/runCompleted",
			...common,
			...(run.resultPreview ? { resultPreview: run.resultPreview } : {}),
		};
	}
	if (run.status === "failed" && run.error) return { type: "schedule/runFailed", ...common, error: run.error };
	if (run.status === "missed" && run.reason === "offline") {
		return {
			type: "schedule/runMissed",
			...common,
			reason: "offline",
			...(run.skippedCount === undefined ? {} : { skippedCount: run.skippedCount }),
		};
	}
	if (run.status === "skipped" && run.reason === "overlap") {
		return { type: "schedule/runSkipped", ...common, reason: "overlap" };
	}
	return undefined;
}
