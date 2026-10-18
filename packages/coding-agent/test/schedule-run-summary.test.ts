import { describe, expect, it } from "vitest";
import { summarizeRun } from "../src/core/schedules/run-summary.ts";
import type { ScheduleRun } from "../src/core/schedules/types.ts";

const run: ScheduleRun = {
	id: "run-1",
	taskId: "task-1",
	sequence: 1,
	trigger: "scheduled",
	status: "succeeded",
	scheduledFor: "2026-10-17T10:00:00.000Z",
	createdAt: "2026-10-17T10:00:00.000Z",
	unread: false,
	snapshot: {
		name: "Task",
		instruction: "Private task instruction",
		model: { provider: "test", modelId: "test" },
		schedule: { kind: "daily", time: "10:00" },
		timezone: "UTC",
		target: { kind: "general", workspace: "fixed", cwd: "/tmp/workspace" },
	},
};

describe("schedule run summaries", () => {
	it("includes summary fields without leaking execution details", () => {
		expect(summarizeRun({ ...run, runnerId: "runner", sessionFile: "/private/session.jsonl" })).toEqual({
			id: run.id,
			taskId: run.taskId,
			sequence: run.sequence,
			status: run.status,
			scheduledFor: run.scheduledFor,
			createdAt: run.createdAt,
			unread: false,
		});
	});

	it("preserves empty result previews and zero skipped counts", () => {
		const summary = summarizeRun({ ...run, resultPreview: "", skippedCount: 0 });
		expect(summary).toMatchObject({ resultPreview: "", skippedCount: 0 });
		expect(summary).not.toHaveProperty("completedAt");
		expect(summary).not.toHaveProperty("sessionId");
	});

	it("keeps completion and failure information", () => {
		const details = {
			completedAt: "2026-10-17T10:01:00.000Z",
			sessionId: "session-1",
			resultPreview: "Partial output",
			error: { code: "EXECUTION_FAILED", message: "Failed" },
			reason: "interrupted" as const,
			skippedCount: 2,
			unread: true,
		};
		expect(summarizeRun({ ...run, status: "failed", ...details })).toMatchObject({ status: "failed", ...details });
	});
});
