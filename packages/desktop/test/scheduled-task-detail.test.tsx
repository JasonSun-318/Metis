// @vitest-environment jsdom

import type { ScheduleRunView, ScheduleTaskView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduledTaskDetail } from "../src/renderer/components/ScheduledTaskDetail.tsx";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

const TASK: ScheduleTaskView = {
	id: "20000000-0000-4000-8000-000000000001",
	name: "Morning brief",
	description: "Calendar and inbox",
	instruction: "Summarize the calendar.",
	model: { provider: "openai", modelId: "gpt-4" },
	schedule: { kind: "daily", time: "08:00" },
	timezone: "Asia/Shanghai",
	target: { kind: "general", workspace: "task" },
	status: "active",
	createdAt: "2026-07-31T00:00:00Z",
	updatedAt: "2026-07-31T00:00:00Z",
	nextRunAt: "2026-08-01T00:00:00Z",
	unreadCount: 1,
};

const RUN: ScheduleRunView = {
	id: "30000000-0000-4000-8000-000000000001",
	taskId: TASK.id,
	status: "succeeded",
	trigger: "scheduled",
	scheduledFor: "2026-07-31T00:00:00Z",
	createdAt: "2026-07-31T00:00:00Z",
	completedAt: "2026-07-31T00:01:00Z",
	sessionId: "40000000-0000-4000-8000-000000000001",
	resultPreview: "Ready",
	unread: true,
	snapshot: {
		name: TASK.name,
		description: TASK.description,
		instruction: TASK.instruction,
		model: TASK.model,
		schedule: TASK.schedule,
		timezone: TASK.timezone,
		target: TASK.target,
	},
};

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const OLDER_RUN: ScheduleRunView = { ...RUN, id: "30000000-0000-4000-8000-000000000002", resultPreview: "Older" };
const LAST_RUN = {
	id: "30000000-0000-4000-8000-000000000003",
	taskId: TASK.id,
	status: "succeeded" as const,
	scheduledFor: "2026-07-31T02:00:00Z",
	createdAt: "2026-07-31T02:00:00Z",
	completedAt: "2026-07-31T02:01:00Z",
	unread: false,
};

afterEach(() => {
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("ScheduledTaskDetail", () => {
	it("reuses the Run now request id after a lost response", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const runScheduleNow = vi.fn().mockRejectedValueOnce(new Error("response lost")).mockResolvedValue({ run: RUN });
		const api = {
			listScheduleRuns: vi.fn().mockResolvedValue({ runs: [], nextBeforeRunId: null }),
			runScheduleNow,
			getSchedule: vi.fn().mockResolvedValue({ task: TASK }),
		} as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<ScheduledTaskDetail
					api={api}
					onBack={() => undefined}
					onChanged={() => undefined}
					onDeleted={() => undefined}
					onEdit={() => undefined}
					onOpenSession={() => undefined}
					task={TASK}
				/>,
			),
		);
		await flush();
		const runNow = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("Run now"),
		)!;
		await act(async () => runNow.click());
		await flush();
		await act(async () => runNow.click());
		await flush();
		expect(runScheduleNow).toHaveBeenCalledTimes(2);
		expect(runScheduleNow.mock.calls[1]?.[0].requestId).toBe(runScheduleNow.mock.calls[0]?.[0].requestId);
		await act(async () => root.unmount());
	});

	it("opens validated run sessions and deletes history only when the user checks the exact option", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const deleteSchedule = vi
			.fn()
			.mockResolvedValue({ taskId: TASK.id, deleted: true, deletedSessionCount: 1, retainedSessionCount: 0 });
		const api = {
			listScheduleRuns: vi.fn().mockResolvedValue({ runs: [RUN], nextBeforeRunId: null }),
			getScheduleRun: vi.fn().mockResolvedValue({ run: RUN }),
			markScheduleRunRead: vi.fn().mockResolvedValue({ run: { ...RUN, unread: false }, unreadCount: 0 }),
			deleteSchedule,
		} as unknown as MetisDesktopApi;
		const onOpenSession = vi.fn();
		const onDeleted = vi.fn();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<ScheduledTaskDetail
					api={api}
					onBack={() => undefined}
					onChanged={() => undefined}
					onDeleted={onDeleted}
					onEdit={() => undefined}
					onOpenSession={onOpenSession}
					task={TASK}
				/>,
			),
		);
		await flush();
		const history = [...container.querySelectorAll("button")].find((button) =>
			button.textContent?.includes("succeeded"),
		)!;
		await act(async () => history.click());
		expect(onOpenSession).toHaveBeenCalledWith(RUN.sessionId);
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Delete task"]')!.click());
		const deleteDialog = container.querySelector<HTMLDialogElement>(".scheduled-task-delete-dialog")!;
		const checkbox = deleteDialog.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
		expect(checkbox.checked).toBe(false);
		expect(checkbox.closest("label")?.textContent).toContain("Also delete all session files generated by this task");
		await act(async () => checkbox.click());
		const remove = [...deleteDialog.querySelectorAll("button")].find((button) => button.textContent === "Delete")!;
		await act(async () => remove.click());
		expect(deleteSchedule).toHaveBeenCalledWith(expect.objectContaining({ taskId: TASK.id, deleteSessions: true }));
		expect(onDeleted).toHaveBeenCalledWith(TASK.id);
		await act(async () => root.unmount());
	});

	it("shows a retryable history error instead of a false empty history when the first page fails", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const listScheduleRuns = vi
			.fn()
			.mockRejectedValueOnce(new Error("Run history unavailable."))
			.mockResolvedValueOnce({ runs: [RUN], nextBeforeRunId: null });
		const api = { listScheduleRuns } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<ScheduledTaskDetail
					api={api}
					onBack={() => undefined}
					onChanged={() => undefined}
					onDeleted={() => undefined}
					onEdit={() => undefined}
					onOpenSession={() => undefined}
					task={TASK}
				/>,
			),
		);
		await flush();
		const alert = container.querySelector<HTMLElement>('[role="alert"]')!;
		expect(alert.textContent).toContain("Run history unavailable.");
		expect(container.textContent).not.toContain("No runs yet.");
		const retry = [...alert.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
		await act(async () => retry.click());
		await flush();
		expect(container.textContent).toContain("Ready");
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(listScheduleRuns).toHaveBeenCalledTimes(2);
		expect(listScheduleRuns.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ taskId: TASK.id, limit: 40 }));
		expect(listScheduleRuns.mock.calls[1]?.[0].beforeRunId).toBeUndefined();
		await act(async () => root.unmount());
	});

	it("keeps loaded runs and the older-page cursor when Load older fails, then retries that page", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const listScheduleRuns = vi
			.fn()
			.mockResolvedValueOnce({ runs: [RUN], nextBeforeRunId: "cursor-1" })
			.mockRejectedValueOnce(new Error("Older page unavailable."))
			.mockResolvedValueOnce({ runs: [OLDER_RUN], nextBeforeRunId: null });
		const api = { listScheduleRuns, getScheduleRun: vi.fn() } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<ScheduledTaskDetail
					api={api}
					onBack={() => undefined}
					onChanged={() => undefined}
					onDeleted={() => undefined}
					onEdit={() => undefined}
					onOpenSession={() => undefined}
					task={TASK}
				/>,
			),
		);
		await flush();
		const loadOlder = [...container.querySelectorAll("button")].find(
			(button) => button.textContent === "Load older runs",
		)!;
		await act(async () => loadOlder.click());
		await flush();
		const alert = container.querySelector<HTMLElement>('[role="alert"]')!;
		expect(alert.textContent).toContain("Older page unavailable.");
		expect(container.textContent).toContain("Ready");
		expect([...container.querySelectorAll("button")].some((button) => button.textContent === "Load older runs")).toBe(
			true,
		);
		const retry = [...alert.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
		await act(async () => retry.click());
		await flush();
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.textContent).toContain("Ready");
		expect(container.textContent).toContain("Older");
		expect(listScheduleRuns).toHaveBeenCalledTimes(3);
		expect(listScheduleRuns.mock.calls[2]?.[0]).toEqual(expect.objectContaining({ beforeRunId: "cursor-1" }));
		await act(async () => root.unmount());
	});

	it("ignores a stale older-page failure after a newer history load", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const olderPage = deferred<{ runs: readonly ScheduleRunView[]; nextBeforeRunId: string | null }>();
		const listScheduleRuns = vi
			.fn()
			.mockResolvedValueOnce({ runs: [RUN], nextBeforeRunId: "cursor-1" })
			.mockReturnValueOnce(olderPage.promise)
			.mockResolvedValueOnce({ runs: [RUN], nextBeforeRunId: null });
		const api = { listScheduleRuns } as unknown as MetisDesktopApi;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const render = (task: ScheduleTaskView) =>
			root.render(
				<ScheduledTaskDetail
					api={api}
					onBack={() => undefined}
					onChanged={() => undefined}
					onDeleted={() => undefined}
					onEdit={() => undefined}
					onOpenSession={() => undefined}
					task={task}
				/>,
			);
		await act(async () => render(TASK));
		await flush();
		await act(async () =>
			[...container.querySelectorAll("button")].find((button) => button.textContent === "Load older runs")!.click(),
		);
		await act(async () => render({ ...TASK, lastRun: LAST_RUN }));
		await flush();
		await act(async () => {
			olderPage.reject(new Error("Stale older page failed."));
			await olderPage.promise.catch(() => undefined);
		});
		await flush();
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(listScheduleRuns).toHaveBeenCalledTimes(3);
		await act(async () => root.unmount());
	});
});
