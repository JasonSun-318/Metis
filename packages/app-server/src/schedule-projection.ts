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
	return target.workspace === "fixed"
		? { kind: "general", workspace: "fixed", cwd: target.cwd }
		: {
				kind: "general",
				workspace: "task",
				...(target.additionalWorkspaceCwd === undefined
					? {}
					: { additionalWorkspaceCwd: target.additionalWorkspaceCwd }),
			};
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
		name: task.title,
		...(task.description === undefined ? {} : { description: task.description }),
		instruction: task.instruction,
		model: task.model,
		schedule: scheduleView(task.schedule),
		timezone: task.timezone,
		target: targetView(task.target),
		status: task.status,
		createdAt: task.createdAt,
		updatedAt: task.updatedAt,
		nextRunAt: task.nextRunAt,
		...(task.activeRunId ? { activeRunId: task.activeRunId } : {}),
		unreadCount: task.unreadCount,
		...(task.lastRun ? { lastRun: runSummaryView(task.lastRun) } : {}),
		...(task.pauseReason ? { pauseReason: task.pauseReason } : {}),
	};
}

export function scheduleRunView(run: ScheduleRun): ScheduleRunView {
	return {
		...runSummaryView(run),
		...(run.startedAt ? { startedAt: run.startedAt } : {}),
		trigger: run.trigger,
		snapshot: {
			name: run.snapshot.name,
			...(run.snapshot.description === undefined ? {} : { description: run.snapshot.description }),
			instruction: run.snapshot.instruction,
			model: run.snapshot.model,
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
	return {
		type: "schedule/runUpdated",
		task: scheduleTaskView(event.task),
		run: runSummaryView(event.run),
	};
}
