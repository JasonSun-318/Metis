// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTabMenu, type WorkspaceTabMenuItem } from "../src/renderer/components/WorkspaceTabMenu.tsx";

const ITEMS: WorkspaceTabMenuItem[] = [
	{ key: "split-right", label: "Split right", onSelect: vi.fn() },
	{ key: "split-down", label: "Split down", disabled: true, title: "No room", onSelect: vi.fn() },
	{ key: "move", label: "Move to pane 2", onSelect: vi.fn() },
	{ key: "close", label: "Close", onSelect: vi.fn() },
];

let roots: Root[] = [];

function menu(container: HTMLElement) {
	return container.querySelector<HTMLElement>(".workspace-tab-menu");
}

async function mountMenu(
	props: Partial<Parameters<typeof WorkspaceTabMenu>[0]> = {},
): Promise<{ root: Root; host: HTMLElement }> {
	const host = document.createElement("div");
	document.body.append(host);
	const root = createRoot(host);
	roots.push(root);
	await act(async () =>
		root.render(
			<WorkspaceTabMenu
				anchor={{ kind: "point", x: 100, y: 100 }}
				ariaLabel="Tab actions"
				items={ITEMS.map((item) => ({ ...item, onSelect: vi.fn() }))}
				onClose={vi.fn()}
				{...props}
			/>,
		),
	);
	return { root, host };
}

function size(width: number, height: number) {
	Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: width });
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: height });
}

beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	size(200, 300);
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const root of roots) await act(async () => root.unmount());
	roots = [];
	document.body.replaceChildren();
});

describe("WorkspaceTabMenu", () => {
	it("renders into a body portal with fixed positioning at the pointer point", async () => {
		const { host } = await mountMenu({ anchor: { kind: "point", x: 40, y: 60 } });
		const portal = menu(document.body as unknown as HTMLElement);
		expect(portal).not.toBeNull();
		expect(portal?.contains(host)).toBe(false);
		expect(portal?.getAttribute("role")).toBe("menu");
		expect(portal?.style.left).toBe("40px");
		expect(portal?.style.top).toBe("60px");
	});

	it("flips and clamps to the 8px viewport margin when the point would overflow", async () => {
		await mountMenu({ anchor: { kind: "point", x: 900, y: 700 } });
		const portal = menu(document.body as unknown as HTMLElement);
		// 900 + 200 > 1024 - 8 shifts left; 700 + 300 > 768 - 8 flips above the point.
		expect(portal?.style.left).toBe("700px");
		expect(portal?.style.top).toBe("400px");
	});

	it("anchors below the focused tab rectangle and flips above on overflow", async () => {
		const trigger = document.createElement("button");
		vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue({
			top: 600,
			bottom: 628,
			left: 50,
		} as DOMRect);
		document.body.append(trigger);
		const { root } = await mountMenu({ anchor: { kind: "element", element: trigger } });
		const portal = menu(document.body as unknown as HTMLElement);
		expect(portal?.style.left).toBe("50px");
		expect(portal?.style.top).toBe("296px"); // 628 + 4 + 300 overflows; 600 - 300 - 4 fits.
		await act(async () => root.unmount());
	});

	it("focuses the first enabled item on open and skips disabled items while navigating", async () => {
		const items = ITEMS.map((item) => ({ ...item, onSelect: vi.fn() }));
		await mountMenu({ anchor: { kind: "point", x: 10, y: 10 }, items });
		const portal = menu(document.body as unknown as HTMLElement)!;
		const buttons = [...portal.querySelectorAll<HTMLButtonElement>("button")];
		expect(document.activeElement).toBe(buttons[0]);
		await act(async () => {
			buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
		});
		expect(document.activeElement).toBe(buttons[2]);
		await act(async () => {
			buttons[2]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
		});
		// Wrap-around from the first enabled item lands back on itself.
		expect(document.activeElement).toBe(buttons[0]);
		await act(async () => {
			buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
		});
		expect(document.activeElement).toBe(buttons[3]);
		await act(async () => {
			buttons[3]!.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
		});
		expect(document.activeElement).toBe(buttons[0]);
	});

	it("closes on Escape and restores focus to the trigger", async () => {
		const trigger = document.createElement("button");
		document.body.append(trigger);
		const onClose = vi.fn();
		await mountMenu({ anchor: { kind: "element", element: trigger }, onClose, restoreFocusTo: trigger });
		await act(async () => {
			document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		});
		expect(onClose).toHaveBeenCalledWith({ restoreFocus: true });
		expect(document.activeElement).toBe(trigger);
	});

	it("preserves the focused menu item when the parent supplies fresh callbacks and anchors", async () => {
		const { root } = await mountMenu();
		const portal = menu(document.body as unknown as HTMLElement)!;
		const move = portal.querySelectorAll<HTMLButtonElement>("button")[2]!;
		move.focus();

		await act(async () =>
			root.render(
				<WorkspaceTabMenu
					anchor={{ kind: "point", x: 100, y: 100 }}
					ariaLabel="Tab actions"
					items={ITEMS.map((item) => ({ ...item, onSelect: vi.fn() }))}
					onClose={vi.fn()}
				/>,
			),
		);

		expect(document.activeElement).toBe(move);
		await act(async () => window.dispatchEvent(new Event("resize")));
		expect(document.activeElement).toBe(move);
	});

	it("closes on an outside pointerdown without stealing the new focus target", async () => {
		const trigger = document.createElement("button");
		document.body.append(trigger);
		const outside = document.createElement("button");
		document.body.append(outside);
		const onClose = vi.fn();
		await mountMenu({ anchor: { kind: "element", element: trigger }, onClose, restoreFocusTo: trigger });
		outside.focus();
		await act(async () => {
			document.dispatchEvent(new PointerEvent("pointerdown"));
		});
		expect(onClose).toHaveBeenCalledWith({ restoreFocus: false });
		// The outside element keeps its focus; the menu never re-focuses the trigger.
		expect(document.activeElement).toBe(outside);
	});

	it("closes on window blur", async () => {
		const onClose = vi.fn();
		await mountMenu({ onClose });
		await act(async () => {
			window.dispatchEvent(new Event("blur"));
		});
		expect(onClose).toHaveBeenCalledWith({ restoreFocus: false });
	});

	it("repositions on window resize and closes when the anchor element disappears", async () => {
		const trigger = document.createElement("button");
		document.body.append(trigger);
		const rect = { top: 20, bottom: 48, left: 30 } as DOMRect;
		const spy = vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(rect);
		const onClose = vi.fn();
		const { root } = await mountMenu({ anchor: { kind: "element", element: trigger }, onClose });
		let portal = menu(document.body as unknown as HTMLElement);
		expect(portal?.style.left).toBe("30px");
		spy.mockReturnValue({ top: 240, bottom: 268, left: 260 } as DOMRect);
		await act(async () => {
			window.dispatchEvent(new Event("resize"));
		});
		portal = menu(document.body as unknown as HTMLElement);
		expect(portal?.style.left).toBe("260px");

		// A scroll event with the trigger detached closes instead of floating.
		trigger.remove();
		await act(async () => {
			window.dispatchEvent(new Event("scroll"));
		});
		expect(onClose).toHaveBeenCalledWith({ restoreFocus: false });
		await act(async () => root.unmount());
	});

	it("runs the selected item and closes", async () => {
		const onSelect = vi.fn();
		const onClose = vi.fn();
		const items = [{ key: "close", label: "Close", onSelect }];
		await mountMenu({ anchor: { kind: "point", x: 10, y: 10 }, items, onClose });
		const button = menu(document.body as unknown as HTMLElement)!.querySelector("button")!;
		await act(async () => button.click());
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onClose).toHaveBeenCalled();
	});
});
