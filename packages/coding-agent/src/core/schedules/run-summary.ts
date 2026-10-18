import type { ScheduleRun, ScheduleRunSummary } from "./types.ts";

export function summarizeRun(run: ScheduleRun): ScheduleRunSummary {
	return {
		id: run.id,
		taskId: run.taskId,
		sequence: run.sequence,
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
