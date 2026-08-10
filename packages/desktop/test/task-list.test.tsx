// @vitest-environment jsdom

import type { SessionTaskView } from "@metis/app-protocol";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskList } from "../src/renderer/components/TaskList.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

const tasks = [
	{ task: "First task", completed: false },
	{ task: "Second task", completed: true },
	{ task: "Third task", completed: false },
	{ task: "Fourth task", completed: false },
	{ task: "Fifth task", completed: false },
	{ task: "Sixth task", completed: false },
] satisfies readonly SessionTaskView[];

let roots: Root[] = [];

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
});

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots = [];
	document.body.replaceChildren();
	vi.useRealTimers();
});

function mount(tasks: readonly SessionTaskView[], epoch = "epoch-a") {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	act(() => root.render(<TaskList key={epoch} tasks={tasks} />));
	return {
		container,
		rerender(nextTasks: readonly SessionTaskView[], nextEpoch = epoch) {
			act(() => root.render(<TaskList key={nextEpoch} tasks={nextTasks} />));
		},
	};
}

const render = (taskItems: readonly SessionTaskView[]) => mount(taskItems).container;

describe("TaskList", () => {
	it("shows at most five rows before scrolling and marks task states", () => {
		const container = render(tasks);

		expect(container.querySelectorAll(".task-list-row")).toHaveLength(6);
		expect(container.querySelector(".task-list-items")?.classList).toContain("is-scrollable");
		expect(container.querySelectorAll(".task-list-spinner")).toHaveLength(5);
		expect(container.querySelectorAll(".task-list-row.is-completed")).toHaveLength(1);
		expect(container.textContent).toContain("Tasks1/6");
	});

	it("collapses to the first incomplete task without remounting its rows", () => {
		const mounted = mount(tasks);
		const { container } = mounted;
		const toggle = container.querySelector<HTMLButtonElement>('.task-list-header.task-list-toggle[aria-expanded="true"]');
		const firstRow = container.querySelector(".task-list-items .task-list-row");
		expect(toggle?.getAttribute("aria-label")).toBe("Collapse task list");

		act(() => toggle?.click());

		expect(container.querySelector(".task-list-panel")?.classList).toContain("is-collapsed");
		expect(container.querySelector(".task-list-summary .task-list-text")?.textContent).toBe("First task");
		expect(container.querySelectorAll(".task-list-items .task-list-row")).toHaveLength(6);
		expect(container.querySelector(".task-list-items .task-list-row")).toBe(firstRow);
		expect(container.querySelector(".task-list-drawer")?.hasAttribute("inert")).toBe(true);
		const summary = container.querySelector<HTMLButtonElement>(".task-list-summary.task-list-toggle");
		expect(summary?.getAttribute("aria-expanded")).toBe("false");
		expect(summary?.getAttribute("aria-label")).toBeNull();
		expect(summary?.getAttribute("aria-live")).toBe("polite");
		expect(summary?.getAttribute("aria-atomic")).toBe("true");
		expect(summary?.textContent).toContain("Working");
		expect(summary?.textContent).toContain("First task");
		expect(summary?.textContent).toContain("Expand task list");
		mounted.rerender(tasks.map((task, index) => index === 0 ? { ...task, completed: true } : task));
		expect(container.querySelector(".task-list-summary .task-list-text")?.textContent).toBe("Third task");

		act(() => summary?.click());
		expect(container.querySelector(".task-list-panel")?.classList).not.toContain("is-collapsed");
		expect(container.querySelector(".task-list-items .task-list-row")).toBe(firstRow);
		expect(container.querySelector(".task-list-drawer")?.hasAttribute("inert")).toBe(false);
	});

	it("holds a live completed snapshot, then closes it automatically", () => {
		vi.useFakeTimers();
		const mounted = mount(tasks);
		mounted.rerender(tasks.map((task) => ({ ...task, completed: true })));

		expect(mounted.container.querySelectorAll(".task-list-row.is-completed")).toHaveLength(6);
		expect(mounted.container.querySelector(".task-list-slot")?.classList).not.toContain("is-closing");

		act(() => vi.advanceTimersByTime(450));
		expect(mounted.container.querySelector(".task-list-slot")?.classList).toContain("is-closing");

		act(() => vi.advanceTimersByTime(200));
		expect(mounted.container.childElementCount).toBe(0);
	});

	it("keeps a completed snapshot hidden on mount and reopens for new incomplete work", () => {
		const completed = tasks.map((task) => ({ ...task, completed: true }));
		const mounted = mount(completed);
		expect(mounted.container.childElementCount).toBe(0);

		mounted.rerender(tasks);
		expect(mounted.container.querySelector(".task-list-slot")).not.toBeNull();
		expect(mounted.container.querySelectorAll(".task-list-spinner")).toHaveLength(5);
	});

	it("keeps a restored completed snapshot hidden after the server epoch changes", () => {
		const mounted = mount(tasks, "epoch-a");
		mounted.rerender(tasks.map((task) => ({ ...task, completed: true })), "epoch-b");

		expect(mounted.container.childElementCount).toBe(0);
	});

	it("renders nothing for an empty task list", () => {
		expect(render([]).childElementCount).toBe(0);

		const mounted = mount(tasks);
		act(() => mounted.container.querySelector<HTMLButtonElement>(".task-list-header")?.click());
		expect(() => mounted.rerender([])).not.toThrow();
		expect(mounted.container.childElementCount).toBe(0);
	});
});
