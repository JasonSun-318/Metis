// @vitest-environment jsdom

import type { ScheduleTaskView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduledTasksPanel } from "../src/renderer/components/ScheduledTasksPanel.tsx";
import { ScheduleStore } from "../src/renderer/store/schedule-store.ts";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

const EPOCH = "10000000-0000-4000-8000-000000000001";
const TASK_ID = "20000000-0000-4000-8000-000000000001";

function task(): ScheduleTaskView {
	return {
		id: TASK_ID,
		name: "Morning brief",
		description: "Calendar and inbox summary",
		instruction: "Summarize today's calendar.",
		model: { provider: "openai", modelId: "gpt-4" },
		schedule: { kind: "daily", time: "08:00" },
		timezone: "Asia/Shanghai",
		target: { kind: "general", workspace: "task" },
		status: "active",
		createdAt: "2026-07-31T00:00:00Z",
		updatedAt: "2026-07-31T00:00:00Z",
		nextRunAt: "2026-08-01T00:00:00Z",
		unreadCount: 0,
	};
}

function harness(tasks: readonly ScheduleTaskView[] = [task()]) {
	const api = {
		setScheduleKeepAwake: vi.fn().mockResolvedValue(undefined),
		selectProjectFolder: vi.fn().mockResolvedValue("/work/project"),
		listModels: vi.fn().mockResolvedValue({ models: [{ provider: "openai", modelId: "gpt-4", name: "GPT-4" }] }),
		listSchedules: vi.fn().mockResolvedValue({ tasks, nextAfterTaskId: null, unreadCount: 0 }),
	} as unknown as MetisDesktopApi;
	const store = new ScheduleStore();
	store.applySnapshot({ serverEpoch: EPOCH, tasks: [...tasks], unreadCount: 0, cursor: 0 });
	return { api, store };
}

async function wait(ms = 0) {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, ms));
	});
}

afterEach(() => {
	localStorage.clear();
	document.body.replaceChildren();
	vi.restoreAllMocks();
});

describe("ScheduledTasksPanel", () => {
	it("matches the overview hierarchy, forwards search, and opens the real create form without templates", async () => {
		const { api, store } = harness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<ScheduledTasksPanel
					api={api}
					onCreateWithMetis={async () => {}}
					onOpenSession={() => undefined}
					onSelectTask={() => undefined}
					selectedTaskId={null}
					serverReady
					sessions={[]}
					store={store}
				/>,
			),
		);
		await wait(220);
		expect(container.textContent).toContain("Scheduled tasks");
		expect(container.textContent).toContain("Morning brief");
		expect(container.textContent).not.toContain("Daily template");
		const search = container.querySelector<HTMLInputElement>('[aria-label="Search scheduled tasks"]')!;
		await act(async () => {
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(search, "calendar");
			search.dispatchEvent(new Event("input", { bubbles: true }));
		});
		await wait(220);
		expect(api.listSchedules).toHaveBeenLastCalledWith(
			expect.objectContaining({ query: "calendar", sort: "next_run" }),
		);
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Sort scheduled tasks"]')!.click());
		const lastUpdated = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
			(button) => button.textContent === "Last updated",
		)!;
		await act(async () => lastUpdated.click());
		await wait(220);
		expect(api.listSchedules).toHaveBeenLastCalledWith(
			expect.objectContaining({ query: "calendar", sort: "updated" }),
		);
		const newTask = [...container.querySelectorAll("button")].find(
			(button) => button.textContent?.trim() === "New task",
		)!;
		// Native modal dialogs reject focus moves to the inert page behind them.
		const focus = HTMLElement.prototype.focus;
		vi.spyOn(HTMLElement.prototype, "focus").mockImplementation(function (this: HTMLElement, options) {
			const modal = document.querySelector("dialog[open]");
			if (!modal || modal.contains(this)) focus.call(this, options);
		});
		vi.spyOn(HTMLDialogElement.prototype, "showModal").mockImplementation(function (this: HTMLDialogElement) {
			this.open = true;
		});
		vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (this: HTMLDialogElement) {
			this.open = false;
		});
		await act(async () => newTask.click());
		const manual = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
			(button) => button.textContent?.trim() === "Set up manually",
		)!;
		await act(async () => {
			manual.focus();
			manual.click();
		});
		expect(container.querySelector("dialog")?.textContent).toContain("Create scheduled task");
		expect(container.querySelector('[aria-label="Repeat"]')).not.toBeNull();
		await act(async () => container.querySelector<HTMLButtonElement>('dialog [aria-label="Close"]')!.click());
		expect(container.querySelector("dialog")).toBeNull();
		expect(document.activeElement).toBe(newTask);
		await act(async () => root.unmount());
	});

	it("creates with Metis only after an explicit folder or default-workspace choice", async () => {
		const { api, store } = harness([]);
		api.selectProjectFolder = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("/work/selected-project");
		const onCreateWithMetis = vi.fn().mockResolvedValue(undefined);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<ScheduledTasksPanel
					api={api}
					onCreateWithMetis={onCreateWithMetis}
					onOpenSession={() => undefined}
					onSelectTask={() => undefined}
					selectedTaskId={null}
					serverReady
					sessions={[]}
					store={store}
				/>,
			),
		);
		await wait(220);
		expect(
			[...container.querySelectorAll("button")].filter((button) => button.textContent?.trim() === "New task"),
		).toHaveLength(1);

		const openAssisted = async () => {
			const newTask = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
				(button) => button.textContent?.trim() === "New task",
			)!;
			await act(async () => newTask.click());
			const assisted = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find(
				(button) => button.textContent?.trim() === "Create with Metis",
			)!;
			await act(async () => assisted.click());
		};

		await openAssisted();
		expect(container.querySelector("dialog")?.textContent).toContain("Where should this task work?");
		const chooseFolder = [...container.querySelectorAll<HTMLButtonElement>("dialog button")].find((button) =>
			button.textContent?.includes("Choose folder"),
		)!;
		await act(async () => chooseFolder.click());
		await wait();
		expect(api.selectProjectFolder).toHaveBeenCalledTimes(1);
		expect(onCreateWithMetis).not.toHaveBeenCalled();
		expect(container.querySelector("dialog")).not.toBeNull();

		await act(async () => chooseFolder.click());
		await wait();
		expect(onCreateWithMetis).toHaveBeenCalledWith("/work/selected-project");
		expect(container.querySelector("dialog")).toBeNull();

		await openAssisted();
		const useDefault = [...container.querySelectorAll<HTMLButtonElement>("dialog button")].find((button) =>
			button.textContent?.includes("Use default workspace"),
		)!;
		await act(async () => useDefault.click());
		await wait();
		expect(onCreateWithMetis).toHaveBeenLastCalledWith(null);
		await act(async () => root.unmount());
	});

	it("shows the saved Keep Awake state and persists only a successful native change", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.scheduleKeepAwake.v1", "true");
		const { api, store } = harness([]);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<ScheduledTasksPanel
					api={api}
					onCreateWithMetis={async () => {}}
					onOpenSession={() => undefined}
					onSelectTask={() => undefined}
					selectedTaskId={null}
					serverReady
					sessions={[]}
					store={store}
				/>,
			),
		);
		await wait(220);
		expect(container.querySelector<HTMLInputElement>('[role="switch"]')?.checked).toBe(true);
		const toggle = container.querySelector<HTMLInputElement>('[role="switch"]')!;
		expect(toggle.getAttribute("aria-checked")).toBe("true");
		api.setScheduleKeepAwake = vi.fn().mockRejectedValue(new Error("native failure"));
		await act(async () => toggle.click());
		await wait();
		expect(localStorage.getItem("metis.scheduleKeepAwake.v1")).toBe("true");
		expect(toggle.getAttribute("aria-checked")).toBe("true");
		const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === "Retry")!;
		await act(async () => retry.click());
		expect(api.setScheduleKeepAwake).toHaveBeenLastCalledWith(true);
		await act(async () => root.unmount());
	});

	it("does not present a failed task load as an empty catalog and can retry", async () => {
		const { api, store } = harness([]);
		vi.mocked(api.listSchedules).mockRejectedValueOnce(new Error("task list offline"));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<ScheduledTasksPanel
					api={api}
					store={store}
					serverReady
					sessions={[]}
					selectedTaskId={null}
					onCreateWithMetis={async () => {}}
					onOpenSession={() => {}}
					onSelectTask={() => {}}
				/>,
			),
		);
		await wait(220);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("task list offline");
		expect(container.textContent).not.toContain("Create your first scheduled task");
		await act(async () =>
			[...container.querySelectorAll("button")].find((button) => button.textContent === "Retry")!.click(),
		);
		await wait(220);
		expect(container.querySelector('[role="alert"]')).toBeNull();
		expect(container.textContent).toContain("Create your first scheduled task");
		await act(async () => root.unmount());
	});

	it("keeps a model-loading error visible when the task list succeeds", async () => {
		const { api, store } = harness([]);
		vi.mocked(api.listModels).mockRejectedValue(new Error("model catalog failed"));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () =>
			root.render(
				<ScheduledTasksPanel
					api={api}
					onCreateWithMetis={async () => {}}
					onOpenSession={() => undefined}
					onSelectTask={() => undefined}
					selectedTaskId={null}
					serverReady
					sessions={[]}
					store={store}
				/>,
			),
		);
		await wait(220);
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("model catalog failed");
		const create = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent?.trim() === "New task",
		)!;
		expect(create.disabled).toBe(true);
		await act(async () => root.unmount());
	});
});
