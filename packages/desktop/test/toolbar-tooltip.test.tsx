// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ToolbarTooltip } from "../src/renderer/components/ToolbarTooltip.tsx";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
	HTMLElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
});

function pointer(target: Element, type: "pointerenter" | "pointerleave") {
	act(() => {
		target.dispatchEvent(new MouseEvent(type));
	});
}

function tooltip(): HTMLElement | null {
	return document.querySelector<HTMLElement>('[role="tooltip"]');
}

it("shows a delayed portal hint for a disabled button and closes on pointer leave", async () => {
	const node = document.createElement("div");
	document.body.append(node);
	const root = createRoot(node);
	let clicks = 0;
	try {
		await act(async () =>
			root.render(
				<ToolbarTooltip label="Save">
					<button aria-label="Save file" disabled onClick={() => clicks++} type="button">
						Save
					</button>
				</ToolbarTooltip>,
			),
		);
		const button = node.querySelector("button")!;
		const anchor = node.querySelector(".toolbar-tooltip-anchor")!;
		expect(button.disabled).toBe(true);

		pointer(anchor, "pointerenter");
		act(() => vi.advanceTimersByTime(349));
		expect(tooltip()).toBeNull();
		act(() => vi.advanceTimersByTime(1));
		const hint = tooltip();
		expect(hint?.textContent).toBe("Save");
		expect(hint?.contains(button)).toBe(false);
		expect(button.getAttribute("aria-describedby")).toBe(hint?.id);
		expect(document.activeElement).toBe(document.body);
		expect(clicks).toBe(0);

		pointer(anchor, "pointerleave");
		expect(tooltip()).toBeNull();
		expect(button.getAttribute("aria-describedby")).toBeNull();
		expect(document.activeElement).toBe(document.body);
	} finally {
		await act(async () => root.unmount());
		node.remove();
	}
});

it("closes on focus loss, click, Escape, scroll, hide and unmount without moving focus", async () => {
	const node = document.createElement("div");
	document.body.append(node);
	const root = createRoot(node);
	const action = vi.fn();
	const render = (active = true) =>
		root.render(
			<ToolbarTooltip active={active} label="Copy path">
				<button aria-label="Copy path" onClick={action} type="button">
					Copy
				</button>
			</ToolbarTooltip>,
		);
	try {
		await act(async () => render());
		const anchor = node.querySelector(".toolbar-tooltip-anchor")!;
		const button = node.querySelector("button")!;

		pointer(anchor, "pointerenter");
		act(() => vi.advanceTimersByTime(350));
		expect(tooltip()).not.toBeNull();
		act(() => button.focus());
		act(() => button.blur());
		expect(tooltip()).toBeNull();

		pointer(anchor, "pointerenter");
		act(() => vi.advanceTimersByTime(350));
		expect(tooltip()).not.toBeNull();
		act(() => button.click());
		expect(action).toHaveBeenCalledOnce();
		expect(tooltip()).toBeNull();

		act(() => button.focus());
		act(() => vi.advanceTimersByTime(350));
		expect(tooltip()).not.toBeNull();
		act(() => window.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
		expect(tooltip()).toBeNull();
		expect(document.activeElement).toBe(button);

		pointer(anchor, "pointerenter");
		act(() => vi.advanceTimersByTime(350));
		expect(tooltip()).not.toBeNull();
		act(() => window.dispatchEvent(new Event("scroll")));
		expect(tooltip()).toBeNull();

		pointer(anchor, "pointerenter");
		act(() => vi.advanceTimersByTime(350));
		expect(tooltip()).not.toBeNull();
		await act(async () => render(false));
		expect(tooltip()).toBeNull();

		await act(async () => render());
		pointer(anchor, "pointerenter");
		act(() => vi.advanceTimersByTime(350));
		expect(tooltip()).not.toBeNull();
		await act(async () => root.unmount());
		expect(tooltip()).toBeNull();
	} finally {
		node.remove();
	}
});

it("clamps the portal inside the viewport at the lower right edge", async () => {
	const width = Object.getOwnPropertyDescriptor(document.documentElement, "clientWidth");
	const height = Object.getOwnPropertyDescriptor(document.documentElement, "clientHeight");
	Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 320 });
	Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 480 });
	HTMLElement.prototype.getBoundingClientRect = function getBoundingClientRect() {
		if (this.classList.contains("toolbar-tooltip-anchor")) {
			return {
				bottom: 486,
				height: 26,
				left: 310,
				right: 336,
				top: 460,
				width: 26,
				x: 310,
				y: 460,
				toJSON: () => ({}),
			} as DOMRect;
		}
		if (this.classList.contains("toolbar-tooltip")) {
			return {
				bottom: 24,
				height: 24,
				left: 0,
				right: 140,
				top: 0,
				width: 140,
				x: 0,
				y: 0,
				toJSON: () => ({}),
			} as DOMRect;
		}
		return originalGetBoundingClientRect.call(this);
	};
	const node = document.createElement("div");
	document.body.append(node);
	const root = createRoot(node);
	try {
		await act(async () =>
			root.render(
				<ToolbarTooltip label="Reveal in file manager">
					<button aria-label="More" type="button">
						More
					</button>
				</ToolbarTooltip>,
			),
		);
		pointer(node.querySelector(".toolbar-tooltip-anchor")!, "pointerenter");
		act(() => vi.advanceTimersByTime(350));
		const hint = tooltip()!;
		expect(hint.style.left).toBe("172px");
		expect(hint.style.top).toBe("430px");
		expect(hint.style.visibility).toBe("");
	} finally {
		await act(async () => root.unmount());
		node.remove();
		if (width) Object.defineProperty(document.documentElement, "clientWidth", width);
		else Reflect.deleteProperty(document.documentElement, "clientWidth");
		if (height) Object.defineProperty(document.documentElement, "clientHeight", height);
		else Reflect.deleteProperty(document.documentElement, "clientHeight");
	}
});
