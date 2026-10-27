// @vitest-environment jsdom

import { act, createElement, useCallback, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyWorkspaceTabSizing,
	calculateWorkspaceTabWidth,
	useWorkspaceTabSizing,
	visibleWorkspaceTabElements,
	WORKSPACE_TAB_MAX_WIDTH,
	WORKSPACE_TAB_MIN_WIDTH,
} from "../src/renderer/workspace-tab-sizing.ts";

const roots: Root[] = [];

beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots) await act(async () => root.unmount());
	roots.length = 0;
	document.body.replaceChildren();
});

function rect(width: number): DOMRect {
	return {
		width,
		height: 0,
		top: 0,
		left: 0,
		right: width,
		bottom: 0,
		x: 0,
		y: 0,
		toJSON: () => ({}),
	} as DOMRect;
}

interface HarnessProps {
	readonly width: number;
	readonly title: string;
	readonly onWidthChange: () => void;
}

function Harness({ width, title, onWidthChange }: HarnessProps) {
	const register = useWorkspaceTabSizing(onWidthChange);
	const previous = useRef<HTMLDivElement | null>(null);
	const ref = useCallback(
		(el: HTMLDivElement | null) => {
			register(el, previous.current);
			previous.current = el;
		},
		[register],
	);
	return createElement(
		"div",
		{ className: "workspace-tabbar", "data-width": width },
		createElement(
			"div",
			{ className: "tool-tabs-scroll", ref },
			createElement("div", { className: "tool-tab" }),
			createElement("span", null, title),
		),
		createElement("div", { className: "tool-add" }),
	);
}

describe("workspace tab sizing", () => {
	it("grows with the real strip width instead of the window", () => {
		const narrow = calculateWorkspaceTabWidth({ availableWidth: 320, visibleTabs: 3 });
		const wide = calculateWorkspaceTabWidth({ availableWidth: 900, visibleTabs: 3 });
		expect(narrow).toBeLessThan(wide);
		expect(wide).toBe(WORKSPACE_TAB_MAX_WIDTH);
	});

	it("uses one equal, finite width for every visible tab", () => {
		const width = calculateWorkspaceTabWidth({ availableWidth: 600, reservedWidth: 80, visibleTabs: 4 });
		expect(width).toBe(130);
		expect(width).toBeGreaterThanOrEqual(WORKSPACE_TAB_MIN_WIDTH);
		expect(width).toBeLessThanOrEqual(WORKSPACE_TAB_MAX_WIDTH);
		expect([0, 1, 2, 3].map(() => width)).toEqual([130, 130, 130, 130]);
	});

	it("shares space down to 104px and lets twenty tabs overflow", () => {
		const width = calculateWorkspaceTabWidth({ availableWidth: 800, visibleTabs: 20 });
		expect(width).toBe(WORKSPACE_TAB_MIN_WIDTH);
		expect(width * 20).toBeGreaterThan(800);
	});

	it("counts project labels and narrower tools strips in the available width", () => {
		const lessLabels = calculateWorkspaceTabWidth({ availableWidth: 600, reservedWidth: 0, visibleTabs: 4 });
		const withLabels = calculateWorkspaceTabWidth({
			availableWidth: 600,
			reservedWidth: 300,
			visibleTabs: 4,
		});
		const tools = calculateWorkspaceTabWidth({ availableWidth: 260, visibleTabs: 3 });
		expect(withLabels).toBeLessThan(lessLabels);
		expect(tools).toBe(WORKSPACE_TAB_MIN_WIDTH);
	});

	it("falls back safely for hidden or empty strips", () => {
		expect(calculateWorkspaceTabWidth({ availableWidth: 0, visibleTabs: 4 })).toBe(WORKSPACE_TAB_MAX_WIDTH);
		expect(calculateWorkspaceTabWidth({ availableWidth: Number.NaN, visibleTabs: 4 })).toBe(WORKSPACE_TAB_MAX_WIDTH);
		expect(calculateWorkspaceTabWidth({ availableWidth: 600, visibleTabs: 0 })).toBe(WORKSPACE_TAB_MAX_WIDTH);
	});

	it("stops counting a group's tabs once collapsing removes its body", () => {
		const scroll = document.createElement("div");
		scroll.innerHTML = `
			<div class="tool-tab-group">
				<div class="tool-tab-group-body">
					<div class="tool-tab" id="grouped-a"></div>
					<div class="tool-tab" id="grouped-b"></div>
				</div>
			</div>
			<div class="tool-tab" id="loose"></div>
			<div class="tool-tab tool-tab-motion-ghost" id="ghost" inert></div>
		`;
		expect(visibleWorkspaceTabElements(scroll).map((tab) => tab.id)).toEqual(["grouped-a", "grouped-b", "loose"]);
		const group = scroll.querySelector<HTMLElement>(".tool-tab-group")!;
		group.classList.add("is-collapsed");
		group.querySelector(".tool-tab-group-body")?.remove();
		expect(visibleWorkspaceTabElements(scroll).map((tab) => tab.id)).toEqual(["loose"]);
	});

	it("projects the measured strip and add control into the bar property", () => {
		const bar = document.createElement("div");
		bar.className = "workspace-tabbar";
		bar.style.padding = "0 6px 0 8px";
		bar.style.gap = "2px";
		const scroll = document.createElement("div");
		scroll.className = "tool-tabs-scroll";
		const add = document.createElement("div");
		add.className = "tool-add";
		const fill = document.createElement("div");
		fill.className = "workspace-tabbar-fill";
		bar.append(scroll, add, fill);
		for (let index = 0; index < 3; index += 1) {
			const tab = document.createElement("div");
			tab.className = "tool-tab";
			Object.defineProperty(tab, "offsetLeft", { configurable: true, value: index * 160 });
			Object.defineProperty(tab, "offsetWidth", { configurable: true, value: 160 });
			scroll.append(tab);
		}
		Object.defineProperty(bar, "getBoundingClientRect", {
			configurable: true,
			value: () => ({ width: 600, height: 40 }),
		});
		Object.defineProperty(add, "getBoundingClientRect", {
			configurable: true,
			value: () => ({ width: 26, height: 26 }),
		});
		document.body.append(bar);

		expect(applyWorkspaceTabSizing(scroll)).toBe(140);
		expect(bar.style.getPropertyValue("--workspace-tab-width")).toBe("140px");
		bar.remove();
	});

	it("ignores absolute motion ghosts in both the count and reserved width", () => {
		const bar = document.createElement("div");
		bar.className = "workspace-tabbar";
		bar.style.padding = "0 6px 0 8px";
		const scroll = document.createElement("div");
		scroll.className = "tool-tabs-scroll";
		const add = document.createElement("div");
		add.className = "tool-add";
		bar.append(scroll, add);
		for (let index = 0; index < 5; index += 1) {
			const tab = document.createElement("div");
			tab.className = "tool-tab";
			Object.defineProperty(tab, "offsetLeft", { configurable: true, value: index * 160 });
			Object.defineProperty(tab, "offsetWidth", { configurable: true, value: 160 });
			scroll.append(tab);
		}
		const ghost = document.createElement("div");
		ghost.className = "tool-tab tool-tab-motion-ghost";
		ghost.setAttribute("inert", "");
		Object.defineProperty(ghost, "offsetLeft", { configurable: true, value: 640 });
		Object.defineProperty(ghost, "offsetWidth", { configurable: true, value: 480 });
		scroll.append(ghost);
		Object.defineProperty(bar, "getBoundingClientRect", {
			configurable: true,
			value: () => ({ width: 600, height: 40 }),
		});
		Object.defineProperty(add, "getBoundingClientRect", {
			configurable: true,
			value: () => ({ width: 26, height: 26 }),
		});
		document.body.append(bar);

		expect(visibleWorkspaceTabElements(scroll)).toHaveLength(5);
		expect(applyWorkspaceTabSizing(scroll)).toBe(112);
		bar.remove();
	});

	it("notifies only when the projected width changes", async () => {
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
			const width = this.classList.contains("workspace-tabbar")
				? Number(this.dataset.width)
				: this.classList.contains("tool-add")
					? 26
					: 0;
			return rect(width);
		});
		const onWidthChange = vi.fn();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		roots.push(root);
		const render = (width: number, title: string) =>
			act(async () => root.render(createElement(Harness, { width, title, onWidthChange })));

		await render(600, "one");
		expect(onWidthChange).toHaveBeenCalledTimes(1);
		await render(600, "two");
		expect(onWidthChange).toHaveBeenCalledTimes(1);
		await render(500, "two");
		expect(onWidthChange).toHaveBeenCalledTimes(2);
		expect(onWidthChange.mock.calls[0]![0]).toBe(container.querySelector(".tool-tabs-scroll"));
	});
});
