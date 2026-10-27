// @vitest-environment jsdom

import type { SessionSummary } from "@metis/app-protocol";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionGroupingMenu } from "../src/renderer/components/SessionGroupingMenu.tsx";
import { SessionSidebar } from "../src/renderer/components/SessionSidebar.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";

let roots: Root[] = [];
beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
	localStorage.clear();
});
afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots = [];
	document.body.replaceChildren();
	delete document.documentElement.dataset.motion;
	vi.restoreAllMocks();
});

async function mount(element: ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const render = async (next: ReactNode) => {
		await act(async () => root.render(next));
	};
	await render(element);
	return { container, render };
}

function trigger(container: ParentNode) {
	return container.querySelector<HTMLButtonElement>('[aria-label="Group sessions"]')!;
}

function options() {
	return [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
}

function key(target: EventTarget, name: string, shiftKey = false) {
	const event = new KeyboardEvent("keydown", { key: name, shiftKey, bubbles: true, cancelable: true });
	target.dispatchEvent(event);
	return event;
}

describe("single-level session grouping menu", () => {
	it("opens all five radio options directly and focuses the current grouping", async () => {
		const onChange = vi.fn();
		const view = await mount(<SessionGroupingMenu onChange={onChange} value="status" />);
		const control = trigger(view.container);
		await act(async () => control.click());
		expect(document.querySelectorAll('[role="menu"]')).toHaveLength(1);
		expect(options().map((option) => option.textContent)).toEqual(["Date", "Project", "Status", "Unread", "None"]);
		expect(document.activeElement).toBe(options()[2]);
		expect(options()[2]!.getAttribute("aria-checked")).toBe("true");
		expect(control.getAttribute("aria-description")).toBe("Group by Status");
		await act(async () => options()[2]!.click());
		expect(onChange).not.toHaveBeenCalled();
		expect(document.querySelector('[role="menu"]')).toBeNull();
		expect(document.activeElement).toBe(control);
	});

	it("supports wrapping arrow navigation, Home, End, and one selection response without scrolling", async () => {
		const onChange = vi.fn();
		const view = await mount(<SessionGroupingMenu onChange={onChange} value="date" />);
		const control = trigger(view.container);
		control.focus();
		await act(async () => key(control, "ArrowDown"));
		await act(async () => key(document.activeElement!, "ArrowUp"));
		expect(document.activeElement).toBe(options()[4]);
		await act(async () => key(document.activeElement!, "Home"));
		expect(document.activeElement).toBe(options()[0]);
		await act(async () => key(document.activeElement!, "End"));
		expect(document.activeElement).toBe(options()[4]);
		await act(async () => key(document.activeElement!, "ArrowDown"));
		expect(document.activeElement).toBe(options()[0]);
		const focus = vi.spyOn(control, "focus");
		await act(async () => options()[2]!.click());
		expect(onChange).toHaveBeenCalledExactlyOnceWith("status");
		expect(document.activeElement).toBe(control);
		expect(focus).toHaveBeenCalledWith({ preventScroll: true });
	});

	it("closes on Escape or Tab, preserving the natural Tab origin and outside focus", async () => {
		const view = await mount(
			<>
				<SessionGroupingMenu onChange={vi.fn()} value="project" />
				<button type="button">Next pane</button>
			</>,
		);
		const control = trigger(view.container);
		await act(async () => control.click());
		await act(async () => expect(key(document.activeElement!, "Escape").defaultPrevented).toBe(true));
		expect(document.activeElement).toBe(control);
		await act(async () => control.click());
		await act(async () => expect(key(document.activeElement!, "Tab").defaultPrevented).toBe(false));
		expect(document.querySelector('[role="menu"]')).toBeNull();
		expect(document.activeElement).toBe(control);
		await act(async () => control.click());
		const next = view.container.querySelector<HTMLButtonElement>(":scope > button")!;
		await act(async () => next.dispatchEvent(new Event("pointerdown", { bubbles: true })));
		next.focus();
		expect(document.querySelector('[role="menu"]')).toBeNull();
		expect(document.activeElement).toBe(next);
	});

	it("keeps the floating menu inside the viewport near the bottom-right edge", async () => {
		const view = await mount(<SessionGroupingMenu onChange={vi.fn()} value="date" />);
		const control = trigger(view.container);
		vi.spyOn(control, "getBoundingClientRect").mockReturnValue({
			x: window.innerWidth - 28,
			y: window.innerHeight - 28,
			left: window.innerWidth - 28,
			top: window.innerHeight - 28,
			right: window.innerWidth - 4,
			bottom: window.innerHeight - 4,
			width: 24,
			height: 24,
			toJSON: () => ({}),
		});
		await act(async () => control.click());
		const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
		expect(Number.parseFloat(menu.style.left)).toBeGreaterThanOrEqual(8);
		expect(Number.parseFloat(menu.style.left) + Number.parseFloat(menu.style.width)).toBeLessThanOrEqual(
			window.innerWidth - 8,
		);
		expect(Number.parseFloat(menu.style.top)).toBeGreaterThanOrEqual(8);
		expect(Number.parseFloat(menu.style.top) + 156).toBeLessThanOrEqual(window.innerHeight - 8);
	});
});

function session(sessionId: string, overrides: Partial<SessionSummary> = {}): SessionSummary {
	return {
		sessionId,
		mode: "chat",
		name: sessionId,
		cwdOrigin: "user-selected",
		cwd: "/tmp/project",
		createdAt: "2026-10-25T12:00:00Z",
		updatedAt: "2026-10-25T12:00:00Z",
		state: "idle",
		archived: false,
		unread: false,
		useMemory: true,
		contributeMemory: true,
		...overrides,
	};
}

function sidebarProps(store: AppStore): ComponentProps<typeof SessionSidebar> {
	return {
		state: store.getSnapshot(),
		destination: "tasks",
		width: 286,
		scheduleTasks: [],
		selectedScheduleTaskId: null,
		updateState: { status: "unavailable" },
		onSettings: vi.fn(),
		onUpdate: vi.fn(),
		onSkills: vi.fn(),
		onSchedules: vi.fn(),
		onOpenSchedule: vi.fn(),
		onDeleteSchedule: vi.fn(),
		onWidthChange: vi.fn(),
		workspace: {
			busy: false,
			mode: "chat",
			newTaskOpen: false,
			preferences: new Map(),
			pinnedSessionIds: new Set(),
			onModeChange: vi.fn(),
			onNewTask: vi.fn(),
			onOpen: vi.fn(),
			onDeleteSession: vi.fn(),
			onPinSession: vi.fn(),
			onRenameSession: vi.fn(),
			onCopySessionTitle: vi.fn(),
			onCreateProjectSession: vi.fn(),
			onDeleteProject: vi.fn(),
			onPinProject: vi.fn(),
			onPreviewProjectDelete: vi.fn(),
			onRenameProject: vi.fn(),
			projectBusy: vi.fn(() => false),
		},
	};
}

describe("sidebar status grouping", () => {
	it.each(["full", "reduced"])("preserves focus and scroll through status changes with %s motion", async (motion) => {
		document.documentElement.dataset.motion = motion;
		localStorage.setItem("metis.session-grouping.v1", '{"chat":"status","code":"date"}');
		const store = new AppStore();
		const update = (value: SessionSummary) =>
			store.setSessions({ sessions: [value, session("idle")], nextAfterSessionId: null });
		update(session("moving", { state: "running" }));
		const props = sidebarProps(store);
		const view = await mount(<SessionSidebar {...props} />);
		const scroller = view.container.querySelector<HTMLElement>(".project-list")!;
		Object.defineProperties(scroller, {
			scrollHeight: { configurable: true, value: 500 },
			clientHeight: { configurable: true, value: 100 },
		});
		scroller.scrollTop = 120;
		view.container.querySelector<HTMLButtonElement>('[aria-label="moving"]')!.focus();
		update(session("moving", { lastTurnOutcome: "completed", unread: true }));
		await view.render(<SessionSidebar {...props} state={store.getSnapshot()} />);
		const moved = view.container.querySelector<HTMLButtonElement>('[aria-label="moving"]')!;
		expect(moved.closest(".session-section")?.querySelector(".session-section-heading")?.textContent).toBe(
			"Completed",
		);
		expect(document.activeElement).toBe(moved);
		expect(scroller.scrollTop).toBe(120);
		update(session("moving", { lastTurnOutcome: "completed", unread: false }));
		await view.render(<SessionSidebar {...props} state={store.getSnapshot()} />);
		expect(view.container.querySelector('[aria-label="moving"]')).toBe(moved);
		expect(document.activeElement).toBe(moved);
		expect(localStorage.getItem("metis.session-grouping.v1")).toBe('{"chat":"status","code":"date"}');
	});

	it("keeps pinned and scheduled sessions outside state sections and retains whole projects in project mode", async () => {
		localStorage.setItem("metis.session-grouping.v1", '{"chat":"status","code":"project"}');
		const store = new AppStore();
		store.setSessions({
			sessions: [
				session("pinned", { state: "running" }),
				session("ordinary"),
				session("scheduled", { scheduled: { taskId: "schedule", runId: "run" } }),
			],
			nextAfterSessionId: null,
		});
		const props = sidebarProps(store);
		const view = await mount(
			<SessionSidebar {...props} workspace={{ ...props.workspace, pinnedSessionIds: new Set(["pinned"]) }} />,
		);
		expect(view.container.querySelector('[aria-label="pinned"]')?.closest(".session-section")?.textContent).toContain(
			"Pinned",
		);
		expect(
			view.container.querySelector('[aria-label="scheduled"]')?.closest(".scheduled-task-quick-list"),
		).not.toBeNull();
		expect(view.container.querySelectorAll('[aria-label="pinned"]')).toHaveLength(1);
		await act(async () => trigger(view.container).click());
		await act(async () =>
			options()
				.find((option) => option.textContent === "Project")!
				.click(),
		);
		const project = view.container.querySelector(".project-group");
		expect(project?.querySelector('[aria-label="ordinary"]')).not.toBeNull();
		expect(project?.querySelector('[aria-label="pinned"]')).toBeNull();
		expect(localStorage.getItem("metis.session-grouping.v1")).toBe('{"chat":"project","code":"project"}');
	});
});
