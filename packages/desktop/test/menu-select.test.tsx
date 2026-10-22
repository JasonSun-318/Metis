// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MenuSelect } from "../src/renderer/components/MenuSelect.tsx";

let root: Root;
let container: HTMLDivElement;
let scrollIntoView: ReturnType<typeof vi.fn>;
const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView");

beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	scrollIntoView = vi.fn();
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: scrollIntoView });
});

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.restoreAllMocks();
	if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView);
	else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
});

async function press(target: Element, key: string) {
	await act(async () => target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
}

describe("MenuSelect", () => {
	it("reveals the selected item when a long menu opens without changing its value", async () => {
		const onChange = vi.fn();
		await act(async () =>
			root.render(
				<MenuSelect
					ariaLabel="Models"
					onChange={onChange}
					options={Array.from({ length: 40 }, (_, i) => ({ value: String(i), label: `Model ${i}` }))}
					value="39"
				/>,
			),
		);
		await act(async () => container.querySelector<HTMLButtonElement>("button")!.click());
		expect(document.activeElement?.textContent).toBe("Model 39");
		expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
		expect(scrollIntoView.mock.instances[0]).toBe(document.activeElement);
		expect(onChange).not.toHaveBeenCalled();
	});

	it("skips disabled choices with the keyboard and restores the trigger on Escape", async () => {
		const onChange = vi.fn();
		await act(async () =>
			root.render(
				<MenuSelect
					ariaLabel="Models"
					onChange={onChange}
					options={[
						{ value: "a", label: "A" },
						{ value: "b", label: "B", disabled: true },
						{ value: "c", label: "C" },
					]}
					value="a"
				/>,
			),
		);
		const trigger = container.querySelector<HTMLButtonElement>("button")!;
		await act(async () => trigger.click());
		await press(document.activeElement!, "ArrowDown");
		expect(document.activeElement?.textContent).toBe("C");
		await press(document.activeElement!, "Home");
		expect(document.activeElement?.textContent).toBe("A");
		await press(document.activeElement!, "Escape");
		expect(document.querySelector('[role="listbox"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);
		expect(onChange).not.toHaveBeenCalled();
	});
});
