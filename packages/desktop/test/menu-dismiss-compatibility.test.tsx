// @vitest-environment jsdom

import { act, type ComponentProps, type ReactElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerAddMenu } from "../src/renderer/components/ComposerAddMenu.tsx";
import { ThinkingSelector } from "../src/renderer/components/ThinkingSelector.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mounted = { readonly root: Root; readonly container: HTMLElement };

const mounted: Mounted[] = [];
let animationFrames: Map<number, FrameRequestCallback>;
let nextAnimationFrameId: number;

async function render(element: ReactElement): Promise<Mounted> {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	const entry = { root, container };
	mounted.push(entry);
	await act(async () => root.render(element));
	return entry;
}

async function rerender(entry: Mounted, element: ReactElement): Promise<void> {
	await act(async () => entry.root.render(element));
}

async function dispose(entry: Mounted): Promise<void> {
	const index = mounted.indexOf(entry);
	if (index >= 0) mounted.splice(index, 1);
	try {
		await act(async () => entry.root.unmount());
	} finally {
		entry.container.remove();
	}
}

async function pointerDown(target: EventTarget): Promise<void> {
	await act(async () => {
		target.dispatchEvent(new Event("pointerdown", { bubbles: true }));
	});
}

async function keyDown(key: string, target: EventTarget = document): Promise<KeyboardEvent> {
	const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, key });
	await act(async () => {
		target.dispatchEvent(event);
	});
	return event;
}

async function click(target: Element | null): Promise<void> {
	expect(target).not.toBeNull();
	await act(async () => {
		(target as HTMLElement).click();
	});
}

async function flushAnimationFrames(): Promise<void> {
	let time = performance.now();
	for (let step = 0; step < 240 && animationFrames.size > 0; step += 1) {
		const pending = [...animationFrames.values()];
		animationFrames.clear();
		time += 16;
		await act(async () => {
			for (const callback of pending) callback(time);
		});
	}
}

function installListenerTracker(): () => Array<{ type: string; listener: EventListenerOrEventListenerObject | null }> {
	const addSpy = vi.spyOn(document, "addEventListener");
	const removeSpy = vi.spyOn(document, "removeEventListener");
	const trackedTypes = new Set(["keydown", "pointerdown"]);
	return () => {
		const added = addSpy.mock.calls
			.filter(([type]) => trackedTypes.has(type))
			.map(([type, listener]) => ({ type, listener }));
		const removed = removeSpy.mock.calls
			.filter(([type]) => trackedTypes.has(type))
			.map(([type, listener]) => ({ type, listener }));
		return added.filter(
			({ type, listener }) =>
				!removed.some((removedCall) => removedCall.type === type && removedCall.listener === listener),
		);
	};
}

type ThinkingProps = ComponentProps<typeof ThinkingSelector>;

function thinkingProps(overrides: Partial<ThinkingProps> = {}): ThinkingProps {
	return {
		actualThinkingLevel: "low",
		available: ["off", "low", "medium", "high"] as const,
		disabled: false,
		onChange: vi.fn(),
		reducedMotion: true,
		value: "low" as const,
		...overrides,
	};
}

type AddMenuProps = ComponentProps<typeof ComposerAddMenu>;

function addMenuProps(overrides: Partial<AddMenuProps> = {}): AddMenuProps {
	return {
		disabled: false,
		mcpServers: [],
		onAddFiles: vi.fn(),
		onManageMcp: vi.fn(),
		onManageSkills: vi.fn(),
		onSelectSkill: vi.fn(),
		skills: [{ description: "Design deep modules", name: "codebase-design" }],
		...overrides,
	};
}

function effortTrigger(container: HTMLElement): HTMLButtonElement {
	return container.querySelector<HTMLButtonElement>(".composer-selector-trigger")!;
}

function effortRange(container: HTMLElement): HTMLInputElement {
	return container.querySelector<HTMLInputElement>('input[type="range"]')!;
}

function addMenuTrigger(container: HTMLElement): HTMLButtonElement {
	return container.querySelector<HTMLButtonElement>('[aria-label="Add to message"]')!;
}

function menuItem(container: HTMLElement, label: string): HTMLButtonElement {
	return [...container.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
		(item) => item.textContent?.trim() === label,
	)!;
}

async function setRangeValue(range: HTMLInputElement, value: string): Promise<void> {
	await act(async () => {
		Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(range, value);
		range.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

async function beginDrag(range: HTMLInputElement, value: string): Promise<void> {
	await act(async () => {
		range.dispatchEvent(new Event("pointerdown", { bubbles: true }));
	});
	await setRangeValue(range, value);
}

beforeEach(() => {
	animationFrames = new Map();
	nextAnimationFrameId = 0;
	vi.stubGlobal(
		"requestAnimationFrame",
		vi.fn((callback: FrameRequestCallback) => {
			nextAnimationFrameId += 1;
			animationFrames.set(nextAnimationFrameId, callback);
			return nextAnimationFrameId;
		}),
	);
	vi.stubGlobal(
		"cancelAnimationFrame",
		vi.fn((id: number) => animationFrames.delete(id)),
	);
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
});

afterEach(async () => {
	const cleanupErrors: unknown[] = [];
	try {
		for (const entry of mounted.splice(0)) {
			try {
				await act(async () => entry.root.unmount());
			} catch (error) {
				cleanupErrors.push(error);
			} finally {
				entry.container.remove();
			}
		}
	} finally {
		document.body.replaceChildren();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	}
	if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "Failed to unmount compatibility fixtures");
});

describe("ThinkingSelector menu dismissal compatibility", () => {
	it("keeps an inside pointerdown open and closes outside without stealing focus", async () => {
		const entry = await render(<ThinkingSelector {...thinkingProps()} />);
		await click(effortTrigger(entry.container));
		const dialog = entry.container.querySelector('[role="dialog"]');
		expect(dialog).not.toBeNull();

		await pointerDown(dialog!);
		expect(entry.container.querySelector('[role="dialog"]')).not.toBeNull();

		const external = document.createElement("button");
		document.body.append(external);
		external.focus();
		await pointerDown(external);

		expect(entry.container.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement).toBe(external);
		await dispose(entry);
	});

	it("prevents Escape default and restores trigger focus while ignoring other keys", async () => {
		const entry = await render(<ThinkingSelector {...thinkingProps()} />);
		const trigger = effortTrigger(entry.container);
		await click(trigger);

		const otherKey = await keyDown("Enter");
		expect(otherKey.defaultPrevented).toBe(false);
		expect(entry.container.querySelector('[role="dialog"]')).not.toBeNull();

		const external = document.createElement("input");
		document.body.append(external);
		external.focus();
		const escapeEvent = await keyDown("Escape");

		expect(escapeEvent.defaultPrevented).toBe(true);
		expect(entry.container.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);
		await dispose(entry);
	});

	it("uses the latest onChange and current value after rerendering", async () => {
		const first = vi.fn();
		const second = vi.fn();
		const third = vi.fn();
		const entry = await render(
			<ThinkingSelector {...thinkingProps({ actualThinkingLevel: "low", onChange: first, value: "low" })} />,
		);
		await click(effortTrigger(entry.container));

		await rerender(
			entry,
			<ThinkingSelector {...thinkingProps({ actualThinkingLevel: "medium", onChange: second, value: "medium" })} />,
		);
		const range = effortRange(entry.container);
		await beginDrag(range, "1.1");
		await pointerDown(document.body);
		expect(entry.container.querySelector('[role="dialog"]')).toBeNull();
		expect(second).toHaveBeenCalledOnce();
		expect(second).toHaveBeenCalledWith("low");
		expect(first).not.toHaveBeenCalled();

		await rerender(
			entry,
			<ThinkingSelector {...thinkingProps({ actualThinkingLevel: "low", onChange: third, value: "low" })} />,
		);
		const trigger = effortTrigger(entry.container);
		await click(trigger);
		await beginDrag(effortRange(entry.container), "1");
		await keyDown("Escape");

		expect(third).not.toHaveBeenCalled();
		expect(second).toHaveBeenCalledOnce();
		expect(entry.container.querySelector('[role="dialog"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);
		await dispose(entry);
	});

	it("commits the previewed stop when outside pointerdown closes a drag", async () => {
		const onChange = vi.fn();
		const entry = await render(<ThinkingSelector {...thinkingProps({ onChange })} />);
		await click(effortTrigger(entry.container));
		const range = effortRange(entry.container);
		await beginDrag(range, "2.4");
		expect(onChange).not.toHaveBeenCalled();

		const external = document.createElement("button");
		document.body.append(external);
		external.focus();
		await pointerDown(external);

		expect(entry.container.querySelector('[role="dialog"]')).toBeNull();
		expect(onChange).toHaveBeenCalledOnce();
		expect(onChange).toHaveBeenCalledWith("medium");
		expect(document.activeElement).toBe(external);
		await dispose(entry);
	});

	it("commits the snapping target when Escape closes an in-flight spring", async () => {
		const onChange = vi.fn();
		const entry = await render(<ThinkingSelector {...thinkingProps({ onChange, reducedMotion: false })} />);
		const trigger = effortTrigger(entry.container);
		await click(trigger);
		const range = effortRange(entry.container);
		await beginDrag(range, "2.4");
		await act(async () => range.dispatchEvent(new Event("pointerup", { bubbles: true })));

		expect(animationFrames.size).toBeGreaterThan(0);
		expect(onChange).not.toHaveBeenCalled();
		const external = document.createElement("input");
		document.body.append(external);
		external.focus();
		const escapeEvent = await keyDown("Escape");

		expect(escapeEvent.defaultPrevented).toBe(true);
		expect(entry.container.querySelector('[role="dialog"]')).toBeNull();
		expect(onChange).toHaveBeenCalledOnce();
		expect(onChange).toHaveBeenCalledWith("medium");
		expect(document.activeElement).toBe(trigger);
		await flushAnimationFrames();
		expect(onChange).toHaveBeenCalledOnce();
		await dispose(entry);
	});

	it("cancels a pending spring without committing when disabled or externally closed", async () => {
		for (const scenario of ["disabled", "command"] as const) {
			const onChange = vi.fn();
			const props = thinkingProps({ onChange, reducedMotion: false });
			const entry = await render(<ThinkingSelector {...props} />);
			await click(effortTrigger(entry.container));
			const range = effortRange(entry.container);
			await beginDrag(range, "2.4");
			await act(async () => range.dispatchEvent(new Event("pointerup", { bubbles: true })));
			expect(animationFrames.size).toBeGreaterThan(0);
			expect(onChange).not.toHaveBeenCalled();

			if (scenario === "disabled") {
				await rerender(entry, <ThinkingSelector {...props} disabled />);
			} else {
				await rerender(entry, <ThinkingSelector {...props} commandRequest={{ id: 1, open: false }} />);
			}

			expect(entry.container.querySelector('[role="dialog"]')).toBeNull();
			expect(onChange).not.toHaveBeenCalled();
			await flushAnimationFrames();
			expect(onChange).not.toHaveBeenCalled();
			await dispose(entry);
		}
	});

	it("removes document listeners on unmount inside StrictMode", async () => {
		const liveListeners = installListenerTracker();
		const entry = await render(
			<StrictMode>
				<ThinkingSelector {...thinkingProps()} />
			</StrictMode>,
		);
		await click(effortTrigger(entry.container));
		await pointerDown(entry.container.querySelector('[role="dialog"]')!);
		expect(entry.container.querySelector('[role="dialog"]')).not.toBeNull();

		await dispose(entry);
		expect(liveListeners()).toEqual([]);
	});
});

describe("ComposerAddMenu dismissal compatibility", () => {
	it("keeps an inside pointerdown open and closes outside without stealing focus", async () => {
		const entry = await render(<ComposerAddMenu {...addMenuProps()} />);
		await click(addMenuTrigger(entry.container));
		const menu = entry.container.querySelector('[role="menu"]');
		expect(menu).not.toBeNull();

		await pointerDown(menu!);
		expect(entry.container.querySelector('[role="menu"]')).not.toBeNull();

		const external = document.createElement("button");
		document.body.append(external);
		external.focus();
		await pointerDown(external);

		expect(entry.container.querySelector('[role="menu"]')).toBeNull();
		expect(document.activeElement).toBe(external);
		await dispose(entry);
	});

	it("prevents Escape default and restores trigger focus while ignoring other keys", async () => {
		const entry = await render(<ComposerAddMenu {...addMenuProps()} />);
		const trigger = addMenuTrigger(entry.container);
		await click(trigger);

		const otherKey = await keyDown("Enter");
		expect(otherKey.defaultPrevented).toBe(false);
		expect(entry.container.querySelector('[role="menu"]')).not.toBeNull();

		const external = document.createElement("input");
		document.body.append(external);
		external.focus();
		const escapeEvent = await keyDown("Escape");

		expect(escapeEvent.defaultPrevented).toBe(true);
		expect(entry.container.querySelector('[role="menu"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);
		await dispose(entry);
	});

	it("resets an open submenu when the menu is reopened", async () => {
		const entry = await render(<ComposerAddMenu {...addMenuProps()} />);
		const trigger = addMenuTrigger(entry.container);
		await click(trigger);

		await click(menuItem(entry.container, "Skills"));
		expect(entry.container.querySelectorAll('[role="menu"]')).toHaveLength(2);
		await click(menuItem(entry.container, "MCP"));
		expect(entry.container.querySelectorAll('[role="menu"]')).toHaveLength(2);

		await click(trigger);
		expect(entry.container.querySelector('[role="menu"]')).toBeNull();
		await click(trigger);

		expect(entry.container.querySelectorAll('[role="menu"]')).toHaveLength(1);
		expect(menuItem(entry.container, "Skills").getAttribute("aria-expanded")).toBe("false");
		expect(menuItem(entry.container, "MCP").getAttribute("aria-expanded")).toBe("false");
		await dispose(entry);
	});

	it("closes and resets submenus when disabled or externally closed", async () => {
		for (const scenario of ["disabled", "command"] as const) {
			const props = addMenuProps();
			const entry = await render(<ComposerAddMenu {...props} />);
			await click(addMenuTrigger(entry.container));
			await click(menuItem(entry.container, "Skills"));
			expect(entry.container.querySelectorAll('[role="menu"]')).toHaveLength(2);

			if (scenario === "disabled") {
				await rerender(entry, <ComposerAddMenu {...props} disabled />);
			} else {
				await rerender(entry, <ComposerAddMenu {...props} commandRequest={{ id: 1, open: false }} />);
			}

			expect(entry.container.querySelector('[role="menu"]')).toBeNull();
			expect(addMenuTrigger(entry.container).getAttribute("aria-expanded")).toBe("false");
			await dispose(entry);
		}
	});

	it("removes document listeners on unmount inside StrictMode", async () => {
		const liveListeners = installListenerTracker();
		const entry = await render(
			<StrictMode>
				<ComposerAddMenu {...addMenuProps()} />
			</StrictMode>,
		);
		await click(addMenuTrigger(entry.container));
		await click(menuItem(entry.container, "Skills"));
		expect(entry.container.querySelectorAll('[role="menu"]')).toHaveLength(2);

		await dispose(entry);
		expect(liveListeners()).toEqual([]);
	});
});
