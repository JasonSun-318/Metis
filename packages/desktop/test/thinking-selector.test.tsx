// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThinkingSelector } from "../src/renderer/components/ThinkingSelector.tsx";

let animationFrames: Map<number, FrameRequestCallback>;
let animationFrameId: number;

const setReducedMotion = (matches: boolean) => {
	vi.stubGlobal("matchMedia", vi.fn(() => ({
		addEventListener: vi.fn(),
		matches,
		media: "(prefers-reduced-motion: reduce)",
		removeEventListener: vi.fn(),
	})));
};

const flushAnimationFrames = async () => {
	let time = performance.now();
	for (let step = 0; step < 240 && animationFrames.size > 0; step += 1) {
		const pending = [...animationFrames.values()];
		animationFrames.clear();
		time += 16;
		await act(async () => pending.forEach((callback) => callback(time)));
	}
};

beforeEach(() => {
	animationFrames = new Map();
	animationFrameId = 0;
	vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
		animationFrameId += 1;
		animationFrames.set(animationFrameId, callback);
		return animationFrameId;
	}));
	vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => animationFrames.delete(id)));
	setReducedMotion(false);
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	document.body.replaceChildren();
});

describe("ThinkingSelector", () => {
	it("opens and closes from an external command request", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const props = {
			actualThinkingLevel: "high" as const,
			available: ["off", "high"] as const,
			disabled: false,
			onChange: vi.fn(),
			value: "high" as const,
		};
		await act(async () => root.render(<ThinkingSelector {...props} commandRequest={{ id: 0, open: false }} />));
		await act(async () => root.render(<ThinkingSelector {...props} commandRequest={{ id: 1, open: true }} />));
		expect(container.querySelector('[role="dialog"]')).not.toBeNull();
		await act(async () => root.render(<ThinkingSelector {...props} commandRequest={{ id: 2, open: false }} />));
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		await act(async () => root.unmount());
	});

	it("opens a horizontal effort control and emits the selected real level", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onChange = vi.fn();
		await act(async () => {
			root.render(
				<ThinkingSelector
					actualThinkingLevel="max"
					available={["off", "high", "max", "ultra"]}
					disabled={false}
					onChange={onChange}
					value="ultra"
				/>,
			);
		});
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select effort, current Ultra"]')!.click());
		expect(container.querySelector(".effort-title")?.textContent).toContain("Effort Ultra");
		expect(container.querySelectorAll(".effort-ticks > span")).toHaveLength(4);
		expect(container.textContent).toContain("multiple model calls");
		const range = container.querySelector<HTMLInputElement>('input[type="range"]')!;
		await act(async () => {
			range.dispatchEvent(new Event("pointerdown", { bubbles: true }));
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(range, "1.35");
			range.dispatchEvent(new Event("input", { bubbles: true }));
		});
		expect(onChange).not.toHaveBeenCalled();
		expect(container.querySelector<HTMLButtonElement>('[aria-label="Select effort, current Ultra"]')?.textContent).toContain("High");
		expect(container.querySelector('[role="dialog"]')).not.toBeNull();
		await act(async () => range.dispatchEvent(new Event("pointerup", { bubbles: true })));
		expect(onChange).not.toHaveBeenCalled();
		await flushAnimationFrames();
		expect(onChange).toHaveBeenCalledWith("high");
		expect(onChange).toHaveBeenCalledTimes(1);
		expect(container.querySelector('[role="dialog"]')).not.toBeNull();
		expect(container.querySelector(".effort-ultra-field")).toBeNull();
		await act(async () => {
			root.render(
				<ThinkingSelector
					actualThinkingLevel="high"
					available={["off", "high", "max", "ultra"]}
					disabled={false}
					onChange={onChange}
					value="high"
				/>,
			);
		});
		await act(async () => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select effort, current High"]')!.click());
		expect(container.querySelector<HTMLInputElement>('input[type="range"]')?.value).toBe("1");
		await act(async () => root.unmount());
	});

	it("renders the animated ultra trail only at the actual ultra stop", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => {
			root.render(
				<ThinkingSelector
					actualThinkingLevel="max"
					available={["off", "high", "max", "ultra"]}
					disabled={false}
					onChange={() => undefined}
					value="ultra"
				/>,
			);
		});
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select effort, current Ultra"]')!.click());
		expect(container.querySelector(".effort-ultra-field")).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("commits a real supported stop immediately when reduced motion is enabled", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		setReducedMotion(true);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const onChange = vi.fn();
		await act(async () => {
			root.render(
				<ThinkingSelector
					actualThinkingLevel="low"
					available={["off", "low", "ultra"]}
					disabled={false}
					onChange={onChange}
					value="off"
				/>,
			);
		});
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Select effort, current Off"]')!.click());
		const range = container.querySelector<HTMLInputElement>('input[type="range"]')!;
		await act(async () => {
			range.dispatchEvent(new Event("pointerdown", { bubbles: true }));
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(range, "1.8");
			range.dispatchEvent(new Event("input", { bubbles: true }));
			range.dispatchEvent(new Event("pointerup", { bubbles: true }));
		});
		expect(onChange).toHaveBeenCalledOnce();
		expect(onChange).toHaveBeenCalledWith("ultra");
		expect(container.querySelector('[role="dialog"]')).not.toBeNull();
		await act(async () => range.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" })));
		expect(onChange).toHaveBeenNthCalledWith(2, "low");
		await act(async () => root.unmount());
	});

	it("keeps the highest Chat and Code selections when closed during snapping", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		for (const testCase of [
			{ available: ["off", "low", "medium", "high"] as const, current: "medium" as const, expected: "high" as const },
			{ available: ["off", "low", "medium", "high", "ultra"] as const, current: "high" as const, expected: "ultra" as const },
		]) {
			const container = document.createElement("div");
			document.body.append(container);
			const root = createRoot(container);
			const onChange = vi.fn();
			await act(async () => root.render(
				<ThinkingSelector
					actualThinkingLevel={testCase.current}
					available={testCase.available}
					disabled={false}
					onChange={onChange}
					value={testCase.current}
				/>,
			));
			const trigger = container.querySelector<HTMLButtonElement>(".composer-selector-trigger")!;
			await act(async () => trigger.click());
			const range = container.querySelector<HTMLInputElement>('input[type="range"]')!;
			await act(async () => {
				range.dispatchEvent(new Event("pointerdown", { bubbles: true }));
				Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(range, String(Number(range.max) - .2));
				range.dispatchEvent(new Event("input", { bubbles: true }));
				range.dispatchEvent(new Event("pointerup", { bubbles: true }));
				trigger.click();
			});

			expect(onChange).toHaveBeenCalledOnce();
			expect(onChange).toHaveBeenCalledWith(testCase.expected);
			await act(async () => root.unmount());
			container.remove();
		}
	});

});
