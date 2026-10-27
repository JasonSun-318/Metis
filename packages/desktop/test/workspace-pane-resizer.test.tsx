// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacePaneResizer } from "../src/renderer/components/WorkspacePaneResizer.tsx";

if (typeof PointerEvent === "undefined") {
	// jsdom ships no PointerEvent; a MouseEvent subclass carries the fields the component reads.
	class TestPointerEvent extends MouseEvent {
		isPrimary = true;
		pointerId = 1;
	}
	Object.defineProperty(window, "PointerEvent", { configurable: true, writable: true, value: TestPointerEvent });
	Object.defineProperty(globalThis, "PointerEvent", { configurable: true, writable: true, value: TestPointerEvent });
}

type Props = Parameters<typeof WorkspacePaneResizer>[0];

let roots: Root[] = [];

function mount(overrides: Partial<Props>) {
	const props: Props = {
		axis: "column",
		label: "Resize panes",
		sizes: [300, 300, 300],
		boundary: 1,
		minimum: 100,
		onChange: vi.fn(),
		onCommit: vi.fn(),
		onResizingChange: vi.fn(),
		onReset: vi.fn(),
		...overrides,
	};
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const render = async (next: Partial<Props> = {}) => {
		await act(async () => root.render(<WorkspacePaneResizer {...props} {...next} />));
	};
	return {
		props,
		render,
		node: () => container.querySelector(".workspace-pane-resizer") as HTMLHRElement,
	};
}

function pointerDown(node: Element, init: PointerEventInit = {}) {
	act(() => {
		node.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				pointerId: 1,
				isPrimary: true,
				button: 0,
				clientX: 400,
				clientY: 10,
				...init,
			}),
		);
	});
}

function windowPointer(type: string, init: PointerEventInit = {}) {
	act(() => {
		window.dispatchEvent(
			new PointerEvent(type, { pointerId: 1, isPrimary: true, clientX: 400, clientY: 10, ...init }),
		);
	});
}

beforeEach(() => {
	roots = [];
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots) root.unmount();
	});
	roots = [];
	document.body.replaceChildren();
});

describe("WorkspacePaneResizer pointer drag", () => {
	it("emits clamped adjacent resize from the total drag delta", async () => {
		const { props, render, node } = await mount({});
		await render();
		pointerDown(node(), { clientX: 400 });
		windowPointer("pointermove", { clientX: 450 });
		expect(props.onChange).toHaveBeenLastCalledWith([350, 250, 300]);
		windowPointer("pointermove", { clientX: 420 });
		expect(props.onChange).toHaveBeenLastCalledWith([320, 280, 300]);
		expect(props.onResizingChange).toHaveBeenLastCalledWith(true);
	});

	it("keeps non-adjacent panes and total constant when clamping at the minimum", async () => {
		const { props, render, node } = await mount({});
		await render();
		pointerDown(node(), { clientX: 400 });
		windowPointer("pointermove", { clientX: 1000 });
		const last = vi.mocked(props.onChange).mock.calls.at(-1)?.[0] as number[];
		expect(last).toEqual([500, 100, 300]);
		expect(last[0] + last[1] + last[2]).toBe(900);
	});

	it("supports reverse drags with negative delta", async () => {
		const { props, render, node } = await mount({});
		await render();
		pointerDown(node(), { clientX: 400 });
		windowPointer("pointermove", { clientX: 350 });
		expect(props.onChange).toHaveBeenLastCalledWith([250, 350, 300]);
	});

	it("ignores other pointers and non-primary or non-left-button starts", async () => {
		const { props, render, node } = await mount({});
		await render();
		pointerDown(node(), { button: 2 });
		expect(props.onResizingChange).not.toHaveBeenCalled();
		pointerDown(node(), { pointerId: 7, isPrimary: false });
		expect(props.onResizingChange).not.toHaveBeenCalled();
		pointerDown(node(), { clientX: 400 });
		windowPointer("pointermove", { pointerId: 7, clientX: 500 });
		expect(props.onChange).not.toHaveBeenCalled();
	});

	it("commits the last visible vector on pointerup and ends resizing", async () => {
		const { props, render, node } = await mount({});
		await render();
		pointerDown(node(), { clientX: 400 });
		windowPointer("pointermove", { clientX: 460 });
		windowPointer("pointerup", { clientX: 480 });
		expect(props.onChange).toHaveBeenLastCalledWith([360, 240, 300]);
		expect(props.onCommit).toHaveBeenCalledTimes(1);
		expect(props.onResizingChange).toHaveBeenLastCalledWith(false);
		windowPointer("pointermove", { clientX: 200 });
		expect(props.onChange).toHaveBeenCalledTimes(1);
	});

	it("commits and ends on pointercancel", async () => {
		const { props, render, node } = await mount({});
		await render();
		pointerDown(node(), { clientX: 400 });
		windowPointer("pointermove", { clientX: 430 });
		windowPointer("pointercancel");
		expect(props.onChange).toHaveBeenLastCalledWith([330, 270, 300]);
		expect(props.onCommit).toHaveBeenCalledTimes(1);
		expect(props.onResizingChange).toHaveBeenLastCalledWith(false);
	});

	it("commits the last visible value and leaves no drag state on window blur", async () => {
		const { props, render, node } = await mount({});
		await render();
		pointerDown(node(), { clientX: 400 });
		windowPointer("pointermove", { clientX: 440 });
		act(() => {
			window.dispatchEvent(new Event("blur"));
		});
		expect(props.onChange).toHaveBeenLastCalledWith([340, 260, 300]);
		expect(props.onCommit).toHaveBeenCalledTimes(1);
		expect(props.onResizingChange).toHaveBeenLastCalledWith(false);
		windowPointer("pointermove", { clientX: 100 });
		expect(props.onChange).toHaveBeenCalledTimes(1);
	});

	it("rolls back to the start vector on Escape and commits", async () => {
		const { props, render, node } = await mount({});
		await render();
		pointerDown(node(), { clientX: 400 });
		windowPointer("pointermove", { clientX: 470 });
		act(() => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});
		expect(props.onChange).toHaveBeenLastCalledWith([300, 300, 300]);
		expect(props.onCommit).toHaveBeenCalledTimes(1);
		expect(props.onResizingChange).toHaveBeenLastCalledWith(false);
	});

	it("uses the row axis with clientY", async () => {
		const { props, render, node } = await mount({ axis: "row", sizes: [200, 400], boundary: 1 });
		await render();
		expect(node().className).toContain("workspace-pane-resizer--row");
		pointerDown(node(), { clientX: 10, clientY: 100 });
		windowPointer("pointermove", { clientX: 10, clientY: 140 });
		expect(props.onChange).toHaveBeenLastCalledWith([240, 360]);
	});

	it("does not reset the drag start when props re-render mid-drag", async () => {
		const { props, render, node } = await mount({});
		await render();
		pointerDown(node(), { clientX: 400 });
		windowPointer("pointermove", { clientX: 430 });
		await render({ sizes: [330, 270, 300] });
		windowPointer("pointermove", { clientX: 460 });
		expect(props.onChange).toHaveBeenLastCalledWith([360, 240, 300]);
	});

	it("stops cleanly on unmount without committing", async () => {
		const { props, render, node } = await mount({});
		await render();
		pointerDown(node(), { clientX: 400 });
		await act(async () => roots[0].unmount());
		expect(props.onCommit).not.toHaveBeenCalled();
		expect(props.onResizingChange).toHaveBeenLastCalledWith(false);
		windowPointer("pointermove", { clientX: 600 });
		expect(props.onChange).toHaveBeenCalledTimes(0);
	});

	it("ends the drag without committing when groupKey changes", async () => {
		const { props, render, node } = await mount({ groupKey: "a" });
		await render();
		pointerDown(node(), { clientX: 400 });
		windowPointer("pointermove", { clientX: 430 });
		await render({ groupKey: "b" });
		expect(props.onResizingChange).toHaveBeenLastCalledWith(false);
		expect(props.onCommit).not.toHaveBeenCalled();
		windowPointer("pointermove", { clientX: 600 });
		expect(props.onChange).toHaveBeenCalledTimes(1);
	});
});

describe("WorkspacePaneResizer keyboard and reset", () => {
	it("adjusts by 16px with arrows and commits", async () => {
		const { props, render, node } = await mount({});
		await render();
		node().focus();
		act(() => {
			node().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		});
		expect(props.onChange).toHaveBeenLastCalledWith([316, 284, 300]);
		expect(props.onCommit).toHaveBeenCalledTimes(1);
		act(() => {
			node().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
		});
		expect(props.onChange).toHaveBeenLastCalledWith([284, 316, 300]);
		expect(props.onCommit).toHaveBeenCalledTimes(2);
	});

	it("uses Up/Down for the row axis", async () => {
		const { props, render, node } = await mount({ axis: "row", sizes: [200, 400], boundary: 1 });
		await render();
		act(() => {
			node().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		});
		expect(props.onChange).toHaveBeenLastCalledWith([216, 384]);
	});

	it("moves to the pair boundaries with Home and End", async () => {
		const { props, render, node } = await mount({ sizes: [300, 300], boundary: 1, minimum: 100 });
		await render();
		act(() => {
			node().dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
		});
		expect(props.onChange).toHaveBeenLastCalledWith([500, 100]);
		act(() => {
			node().dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
		});
		expect(props.onChange).toHaveBeenLastCalledWith([100, 500]);
		expect(props.onCommit).toHaveBeenCalledTimes(2);
	});

	it("equalizes the group on double-click", async () => {
		const { props, render, node } = await mount({});
		await render();
		act(() => {
			node().dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		});
		expect(props.onReset).toHaveBeenCalledTimes(1);
	});

	it("hides header copies from the accessibility tree and keyboard", async () => {
		const { props, render, node } = await mount({ focusable: false });
		await render();
		expect(node().getAttribute("aria-hidden")).toBe("true");
		expect(node().tabIndex).toBe(-1);
		expect(node().getAttribute("role")).toBeNull();
		act(() => {
			node().dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
		});
		expect(props.onChange).not.toHaveBeenCalled();
	});

	it("exposes labelled separator bounds in pixels", async () => {
		const { render, node } = await mount({ sizes: [260, 340, 300], boundary: 1, minimum: 100 });
		await render();
		expect(node().getAttribute("role")).toBe("separator");
		expect(node().getAttribute("aria-label")).toBe("Resize panes");
		expect(node().getAttribute("aria-orientation")).toBe("vertical");
		expect(node().getAttribute("aria-valuenow")).toBe("260");
		expect(node().getAttribute("aria-valuemin")).toBe("100");
		expect(node().getAttribute("aria-valuemax")).toBe("500");
	});
});
