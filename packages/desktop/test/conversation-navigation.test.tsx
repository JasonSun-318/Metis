// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ConversationNavigation,
	type ConversationNavigationEntry,
} from "../src/renderer/components/ConversationNavigation.tsx";

const scrollMetrics = { top: 0, viewport: 640, span: 4000 };
let availableHeight = 420;

function entry(itemId: string, index: number): ConversationNavigationEntry {
	return { itemId, rowIndex: index, text: `Question ${itemId}`, answer: `Answer ${itemId}`, attachments: [] };
}

function entries(count: number): ConversationNavigationEntry[] {
	return Array.from({ length: count }, (_, index) => entry(`item-${index}`, index));
}

interface Handlers {
	onJump?: (entry: ConversationNavigationEntry) => void;
	onScrollToOffset?: (offset: number) => void;
	onScrollGesture?: (active: boolean) => void;
	activeIndex?: number;
}

function Harness({
	entries: history,
	handlers,
}: {
	readonly entries: ConversationNavigationEntry[];
	readonly handlers: Handlers;
}) {
	const scrollRef = useRef<HTMLDivElement>(null);
	return (
		<div style={{ position: "relative", height: availableHeight, width: 760 }}>
			<ConversationNavigation
				entries={history}
				activeIndex={handlers.activeIndex ?? 0}
				scrollRef={scrollRef}
				contentHeight={scrollMetrics.span}
				onJump={handlers.onJump ?? (() => undefined)}
				onScrollToOffset={(offset) => {
					scrollMetrics.top = Math.max(
						0,
						Math.min(Math.max(0, scrollMetrics.span - scrollMetrics.viewport), offset),
					);
					handlers.onScrollToOffset?.(offset);
					scrollRef.current?.dispatchEvent(new Event("scroll"));
				}}
				onScrollGesture={handlers.onScrollGesture}
			/>
			<div
				data-testid="transcript-scroll"
				ref={(element) => {
					scrollRef.current = element;
					if (!element) return;
					Object.defineProperties(element, {
						scrollTop: {
							configurable: true,
							get: () => scrollMetrics.top,
							set: (value: number) => {
								scrollMetrics.top = value;
							},
						},
						clientHeight: { configurable: true, get: () => scrollMetrics.viewport },
						scrollHeight: { configurable: true, get: () => scrollMetrics.span },
					});
				}}
			/>
		</div>
	);
}

function rectangle(height: number, top = 0, width = 24): DOMRect {
	return { top, left: 0, right: width, bottom: top + height, x: 0, y: top, width, height, toJSON: () => ({}) };
}

function viewportHeight(element: Element): number {
	const window = element.classList.contains("conversation-navigation-window")
		? element
		: element.closest(".conversation-navigation-window");
	return Math.min(availableHeight, Number.parseFloat((window as HTMLElement | null)?.style.height ?? "0") || 24);
}

function pointer(type: string, init: PointerEventInit = {}): PointerEvent {
	return new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		pointerId: 1,
		isPrimary: true,
		pointerType: "mouse",
		button: 0,
		buttons: type === "pointerup" || type === "pointercancel" ? 0 : 1,
		...init,
	});
}

describe("ConversationNavigation scrollable index", () => {
	let container: HTMLDivElement;
	let root: Root | undefined;
	let nav: HTMLElement;
	let track: HTMLElement;
	let indexWindow: HTMLElement;
	let frames: Map<number, FrameRequestCallback>;
	let frameId = 0;
	let indexOffsets: WeakMap<Element, number>;
	const originalClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight");
	const originalScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");
	const originalScrollTop = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTop");

	const flush = async () => {
		for (let index = 0; index < 3; index += 1) {
			await act(async () => {
				const pending = [...frames.values()];
				frames.clear();
				for (const callback of pending) callback(performance.now());
				await Promise.resolve();
			});
		}
	};
	const fire = async (target: EventTarget, event: Event) => {
		await act(async () => {
			target.dispatchEvent(event);
		});
		await flush();
	};
	const at = (type: string, localY: number, init: PointerEventInit = {}) =>
		pointer(type, { clientY: track.getBoundingClientRect().top + localY, ...init });
	const clickAt = (localY: number) =>
		new MouseEvent("click", {
			bubbles: true,
			cancelable: true,
			clientY: track.getBoundingClientRect().top + localY,
		});
	const key = (value: string) => new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
	const marks = () => Array.from(track.querySelectorAll<HTMLElement>("[data-navigation-turn]"));
	const preview = () => container.querySelector<HTMLButtonElement>(".conversation-navigation-preview");
	const browseTo = async (offset: number) => {
		await fire(track, new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: offset - track.scrollTop }));
		await act(async () => {
			// jsdom does not implement a wheel's native overflow-scrolling default action.
			track.scrollTop = offset;
			track.dispatchEvent(new Event("scroll"));
		});
		await flush();
	};
	const render = async (history: ConversationNavigationEntry[], handlers: Handlers = {}) => {
		await act(async () => root!.render(<Harness entries={history} handlers={handlers} />));
		nav = container.querySelector<HTMLElement>(".conversation-navigation")!;
		track = container.querySelector<HTMLElement>(".conversation-navigation-track")!;
		indexWindow = container.querySelector<HTMLElement>(".conversation-navigation-window")!;
		await flush();
	};
	const mount = async (history: ConversationNavigationEntry[], handlers: Handlers = {}) => {
		container = document.createElement("div");
		document.body.append(container);
		root = createRoot(container);
		await render(history, handlers);
	};

	beforeEach(() => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		Object.assign(scrollMetrics, { top: 0, viewport: 640, span: 4000 });
		availableHeight = 420;
		frames = new Map();
		indexOffsets = new WeakMap();
		vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
			const id = ++frameId;
			frames.set(id, callback);
			return id;
		});
		vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
		Object.defineProperty(Element.prototype, "clientHeight", {
			configurable: true,
			get(this: Element) {
				if (this.classList.contains("conversation-navigation")) return availableHeight;
				if (
					this.classList.contains("conversation-navigation-window") ||
					this.classList.contains("conversation-navigation-track")
				)
					return viewportHeight(this);
				return originalClientHeight?.get?.call(this) ?? 0;
			},
		});
		Object.defineProperty(Element.prototype, "scrollHeight", {
			configurable: true,
			get(this: Element) {
				if (this.classList.contains("conversation-navigation-track")) {
					const spacer = this.querySelector<HTMLElement>(".conversation-navigation-ticks");
					return Math.max(this.clientHeight, Number.parseFloat(spacer?.style.height ?? "0") || 0);
				}
				return originalScrollHeight?.get?.call(this) ?? 0;
			},
		});
		Object.defineProperty(Element.prototype, "scrollTop", {
			configurable: true,
			get(this: Element) {
				return this.classList.contains("conversation-navigation-track")
					? (indexOffsets.get(this) ?? 0)
					: (originalScrollTop?.get?.call(this) ?? 0);
			},
			set(this: Element, value: number) {
				if (this.classList.contains("conversation-navigation-track"))
					indexOffsets.set(this, Math.max(0, Math.min(Math.max(0, this.scrollHeight - this.clientHeight), value)));
				else originalScrollTop?.set?.call(this, value);
			},
		});
		const originalRect = Element.prototype.getBoundingClientRect;
		vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
			if (this.classList.contains("conversation-navigation")) return rectangle(availableHeight);
			if (
				this.classList.contains("conversation-navigation-window") ||
				this.classList.contains("conversation-navigation-track")
			) {
				const height = viewportHeight(this);
				return rectangle(height, (availableHeight - height) / 2);
			}
			if (this.classList.contains("conversation-navigation-preview")) return rectangle(180, 0, 300);
			return originalRect.call(this);
		});
	});

	afterEach(async () => {
		if (root) await act(async () => root!.unmount());
		root = undefined;
		container?.remove();
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		for (const [name, descriptor] of [
			["clientHeight", originalClientHeight],
			["scrollHeight", originalScrollHeight],
			["scrollTop", originalScrollTop],
		] as const) {
			if (descriptor) Object.defineProperty(Element.prototype, name, descriptor);
			else Reflect.deleteProperty(Element.prototype, name);
		}
	});

	it("keeps a single long turn draggable and hides only empty or non-overflowing single histories", async () => {
		await mount([]);
		expect(nav).toBeNull();
		await render([entry("only", 0)]);
		expect(nav.hidden).toBe(false);
		expect(track.clientHeight).toBe(24);
		expect(marks().map((mark) => mark.dataset.navigationTurn)).toEqual(["only"]);
		await fire(track, at("pointerdown", 4));
		await fire(track, at("pointermove", 16));
		expect(scrollMetrics.top).toBe(1680);
		await fire(track, at("pointerup", 16));
		scrollMetrics.span = scrollMetrics.viewport;
		await render([entry("only", 0)]);
		expect(nav.hidden).toBe(true);
	});

	it.each([1, 2, 3, 15])("shows only %i real marks and grows its centered viewport naturally", async (count) => {
		await mount(entries(count));
		expect(track.clientHeight).toBe(Math.max(24, count * 8));
		expect(marks().map((mark) => mark.dataset.navigationTurn)).toEqual(entries(count).map((item) => item.itemId));
		expect(marks().map((mark) => mark.dataset.navigationIndex)).toEqual(
			entries(count).map((_, index) => String(index)),
		);
		expect(track.getBoundingClientRect().top).toBe((availableHeight - track.clientHeight) / 2);
		expect(track.getAttribute("aria-valuemax")).toBe(String(count));
		if (count === 15) expect(track.clientHeight).toBe(120);
	});

	it("caps a large index at 640px and renders only its real visible rows plus overscan", async () => {
		availableHeight = 900;
		await mount(entries(1000));
		expect(track.clientHeight).toBe(640);
		expect(track.scrollHeight).toBe(8000);
		expect(marks().length).toBeGreaterThanOrEqual(80);
		expect(marks().length).toBeLessThanOrEqual(88);
		expect(marks().every((mark) => mark.dataset.navigationTurn === `item-${mark.dataset.navigationIndex}`)).toBe(
			true,
		);
		await browseTo(3200);
		expect(marks().length).toBeLessThanOrEqual(88);
		expect(marks().some((mark) => mark.dataset.navigationTurn === "item-400")).toBe(true);
		expect(marks().some((mark) => mark.dataset.navigationTurn === "item-0")).toBe(false);
		expect(track.getAttribute("aria-valuemax")).toBe("1000");
	});

	it("caps against the available frame and changes fades only when real rows are hidden", async () => {
		await mount(entries(15));
		expect(indexWindow.dataset.fadeTop).toBe("false");
		expect(indexWindow.dataset.fadeBottom).toBe("false");
		await render(entries(1000));
		expect(track.clientHeight).toBe(420);
		expect(indexWindow.classList.contains("is-scrollable-above")).toBe(false);
		expect(indexWindow.classList.contains("is-scrollable-below")).toBe(true);
		await browseTo(1600);
		expect(indexWindow.dataset.fadeTop).toBe("true");
		expect(indexWindow.dataset.fadeBottom).toBe("true");
		await browseTo(track.scrollHeight - track.clientHeight);
		expect(indexWindow.classList.contains("is-scrollable-above")).toBe(true);
		expect(indexWindow.classList.contains("is-scrollable-below")).toBe(false);
	});

	it("keeps equal idle widths and fans around the hovered real entry", async () => {
		await mount(entries(15));
		expect(marks().every((mark) => mark.style.width === "6px")).toBe(true);
		await fire(track, at("pointermove", 60));
		expect(preview()?.textContent).toContain("Question item-7");
		expect(
			marks()
				.slice(4, 11)
				.map((mark) => mark.style.width),
		).toEqual(["8px", "14px", "20px", "26px", "20px", "14px", "8px"]);
		expect(Number(marks()[7]!.style.opacity)).toBe(1);
		expect(marks()[0]!.style.width).toBe("6px");
	});

	it("previews hovered entries and keeps the short crossing grace period", async () => {
		await mount(entries(3));
		await fire(track, at("pointermove", 12));
		expect(preview()?.textContent).toContain("Question item-1");
		expect(preview()?.textContent).toContain("Answer item-1");
		await fire(nav, new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
		expect(preview()).not.toBeNull();
		await act(async () => new Promise((resolve) => setTimeout(resolve, 140)));
		expect(preview()).toBeNull();
	});

	it("preserves keyboard focus inside a preview after pointer leave and returns it on Escape", async () => {
		await mount(entries(3));
		await act(async () => track.focus());
		const card = preview()!;
		await act(async () => card.focus());
		await fire(nav, new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
		await act(async () => new Promise((resolve) => setTimeout(resolve, 140)));
		expect(document.activeElement).toBe(card);
		expect(card.isConnected).toBe(true);
		await fire(card, key("Escape"));
		expect(preview()).toBeNull();
		expect(document.activeElement).toBe(track);
	});

	it("resolves hover and click against the browsed index offset rather than document position", async () => {
		const onJump = vi.fn();
		const onScrollToOffset = vi.fn();
		await mount(entries(1000), { onJump, onScrollToOffset });
		await browseTo(1600);
		await fire(track, at("pointermove", 20));
		expect(preview()?.textContent).toContain("Question item-202");
		await fire(track, clickAt(20));
		expect(onJump).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ itemId: "item-202" }));
		expect(onScrollToOffset).not.toHaveBeenCalled();
		expect(scrollMetrics.top).toBe(0);
	});

	it.each([0, 1, 2])(
		"lets native wheel deltaMode=%i browse the index without moving the document",
		async (deltaMode) => {
			const onScrollToOffset = vi.fn();
			await mount(entries(1000), { onScrollToOffset });
			const wheel = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 120, deltaMode });
			await fire(track, wheel);
			expect(wheel.defaultPrevented).toBe(false);
			expect(onScrollToOffset).not.toHaveBeenCalled();
			await browseTo(120);
			expect(track.scrollTop).toBe(120);
			expect(scrollMetrics.top).toBe(0);
			expect(marks().some((mark) => mark.dataset.navigationTurn === "item-15")).toBe(true);
		},
	);

	it("does not turn upward wheel at a short index into document history loading", async () => {
		scrollMetrics.span = scrollMetrics.viewport;
		const onScrollToOffset = vi.fn();
		await mount(entries(3), { onScrollToOffset });
		await fire(track, new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -120 }));
		expect(onScrollToOffset).not.toHaveBeenCalled();
		expect(scrollMetrics.top).toBe(0);
	});

	it("drags after the threshold, clamps to the live document range and reports gestures", async () => {
		const onScrollGesture = vi.fn();
		await mount(entries(1000), { onScrollGesture });
		await fire(track, at("pointermove", 40));
		expect(preview()).not.toBeNull();
		await fire(track, at("pointerdown", 100));
		await fire(track, at("pointermove", 104));
		expect(scrollMetrics.top).toBe(0);
		expect(onScrollGesture).not.toHaveBeenCalled();
		await fire(track, at("pointermove", 300));
		expect(scrollMetrics.top).toBe(1600);
		expect(onScrollGesture.mock.calls).toEqual([[true]]);
		expect(nav.className).toContain("is-dragging");
		expect(preview()).toBeNull();
		await fire(track, at("pointermove", 1200));
		expect(scrollMetrics.top).toBe(3360);
		scrollMetrics.span = 8000;
		await fire(track, at("pointermove", 300));
		expect(scrollMetrics.top).toBeCloseTo((200 * 7360) / 420);
		await fire(track, at("pointerup", 300));
		expect(onScrollGesture.mock.calls).toEqual([[true], [false]]);
		expect(nav.className).not.toContain("is-dragging");
	});

	it("jumps on a click and suppresses only the click immediately following a drag", async () => {
		const onJump = vi.fn();
		await mount(entries(15), { onJump });
		await fire(track, at("pointerdown", 12));
		await fire(track, at("pointerup", 12));
		await fire(track, clickAt(12));
		expect(onJump).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ itemId: "item-1" }));
		await fire(track, at("pointerdown", 12));
		await fire(track, at("pointermove", 72));
		await fire(track, at("pointerup", 72));
		await fire(track, clickAt(72));
		expect(onJump).toHaveBeenCalledOnce();
		await fire(track, at("pointerdown", 12));
		await fire(track, at("pointerup", 12));
		await fire(track, clickAt(12));
		expect(onJump).toHaveBeenCalledTimes(2);
	});

	it("flushes the coalesced final document drag on release before its animation frame", async () => {
		const onScrollToOffset = vi.fn();
		const onJump = vi.fn();
		const onScrollGesture = vi.fn();
		await mount(entries(1000), { onJump, onScrollToOffset, onScrollGesture });
		await act(async () => {
			track.dispatchEvent(at("pointerdown", 100));
			track.dispatchEvent(at("pointermove", 180));
			track.dispatchEvent(at("pointermove", 300));
			expect(onScrollToOffset).not.toHaveBeenCalled();
			track.dispatchEvent(at("pointerup", 300));
			track.dispatchEvent(clickAt(300));
		});
		expect(onScrollToOffset).toHaveBeenCalledExactlyOnceWith(1600);
		expect(onJump).not.toHaveBeenCalled();
		expect(onScrollGesture.mock.calls).toEqual([[true], [false]]);
		await flush();
		expect(onScrollToOffset).toHaveBeenCalledOnce();
	});

	it.each(["pointercancel", "lostpointercapture", "blur"])("cleans up an active drag on %s", async (event) => {
		const onScrollGesture = vi.fn();
		await mount(entries(1000), { onScrollGesture });
		await fire(track, at("pointerdown", 100));
		await fire(track, at("pointermove", 300));
		await fire(event === "blur" ? window : track, event === "blur" ? new Event("blur") : at(event, 300));
		expect(onScrollGesture.mock.calls).toEqual([[true], [false]]);
		await fire(track, at("pointermove", 400));
		expect(onScrollGesture).toHaveBeenCalledTimes(2);
	});

	it("reports the document gesture inactive when unmounted during a drag", async () => {
		const onScrollGesture = vi.fn();
		await mount(entries(1000), { onScrollGesture });
		await fire(track, at("pointerdown", 100));
		await fire(track, at("pointermove", 300));
		await act(async () => root!.unmount());
		root = undefined;
		expect(onScrollGesture.mock.calls).toEqual([[true], [false]]);
	});

	it("ignores a non-primary mouse button", async () => {
		const onScrollGesture = vi.fn();
		await mount(entries(15), { onScrollGesture });
		await fire(track, at("pointerdown", 4, { button: 2 }));
		await fire(track, at("pointermove", 100));
		expect(onScrollGesture).not.toHaveBeenCalled();
		expect(scrollMetrics.top).toBe(0);
	});

	it("reveals every real keyboard-selected row while keeping PageUp/Down as document paging", async () => {
		const onJump = vi.fn();
		const onScrollToOffset = vi.fn();
		await mount(entries(1000), { onJump, onScrollToOffset });
		await act(async () => track.focus());
		await fire(track, key("ArrowDown"));
		expect(track.getAttribute("aria-valuenow")).toBe("2");
		await fire(track, key("End"));
		expect(track.getAttribute("aria-valuenow")).toBe("1000");
		expect(track.scrollTop).toBe(7580);
		expect(marks().some((mark) => mark.dataset.navigationTurn === "item-999")).toBe(true);
		expect(preview()?.textContent).toContain("Question item-999");
		await fire(track, key("Home"));
		expect(track.scrollTop).toBe(0);
		await fire(track, key("Enter"));
		expect(onJump).toHaveBeenLastCalledWith(expect.objectContaining({ itemId: "item-0" }));
		await fire(track, key("ArrowDown"));
		await fire(track, key(" "));
		expect(onJump).toHaveBeenLastCalledWith(expect.objectContaining({ itemId: "item-1" }));
		await fire(track, key("PageDown"));
		await fire(track, key("PageUp"));
		expect(onScrollToOffset.mock.calls).toEqual([[640], [0]]);
		await fire(track, key("Escape"));
		expect(preview()).toBeNull();
	});

	it("keeps keyboard browsing after pointer leave and streaming until focus moves outside", async () => {
		const history = entries(1000);
		await mount(history);
		await act(async () => track.focus());
		await fire(track, key("End"));
		expect(track.scrollTop).toBe(7580);
		await fire(track, key("Home"));
		await fire(track, key("ArrowDown"));
		expect(track.scrollTop).toBe(0);
		expect(track.getAttribute("aria-valuenow")).toBe("2");
		await fire(nav, new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
		await act(async () => new Promise((resolve) => setTimeout(resolve, 140)));
		expect(preview()?.textContent).toContain("Question item-1");
		expect(document.activeElement).toBe(track);
		expect(track.scrollTop).toBe(0);
		scrollMetrics.span = 8000;
		await render(history, { activeIndex: 900 });
		expect(preview()?.textContent).toContain("Question item-1");
		expect(track.getAttribute("aria-valuenow")).toBe("2");
		expect(track.scrollTop).toBe(0);
		const outside = document.createElement("button");
		container.append(outside);
		await act(async () => outside.focus());
		await flush();
		expect(document.activeElement).toBe(outside);
		expect(preview()).toBeNull();
		expect(track.getAttribute("aria-valuenow")).toBe("901");
		expect(track.scrollTop).toBeGreaterThan(0);
		expect(marks().some((mark) => mark.dataset.navigationTurn === "item-900")).toBe(true);
		outside.remove();
	});

	it("preserves the first browsed visible message and its fractional offset when history is prepended", async () => {
		const history = entries(1000);
		await mount(history);
		await browseTo(1603);
		await render([
			entry("older-a", 0),
			entry("older-b", 1),
			...history.map((item, index) => ({ ...item, rowIndex: index + 2 })),
		]);
		expect(track.scrollTop).toBe(1619);
		expect(marks().some((mark) => mark.dataset.navigationTurn === "item-200")).toBe(true);
		await fire(track, at("pointermove", 1));
		expect(preview()?.textContent).toContain("Question item-200");
	});

	it("keeps the keyboard-previewed real message identity after a prepend", async () => {
		const history = entries(15);
		const onJump = vi.fn();
		await mount(history, { onJump });
		await act(async () => track.focus());
		await fire(track, key("ArrowDown"));
		await render([entry("older", 0), ...history.map((item, index) => ({ ...item, rowIndex: index + 1 }))], {
			onJump,
		});
		expect(track.getAttribute("aria-valuenow")).toBe("3");
		expect(preview()?.textContent).toContain("Question item-1");
		await fire(track, key("Enter"));
		expect(onJump).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ itemId: "item-1" }));
	});

	it("clamps the preview inside the full available frame even for a short centered index", async () => {
		await mount(entries(3));
		await fire(track, at("pointermove", 0));
		const card = preview()!;
		const half = card.getBoundingClientRect().height / 2;
		expect(Number.parseFloat(card.style.top) - half).toBeGreaterThanOrEqual(4);
		await fire(track, at("pointermove", track.clientHeight));
		expect(Number.parseFloat(card.style.top) + half).toBeLessThanOrEqual(availableHeight - 4);
	});

	it("preserves a browsed index through streaming document growth", async () => {
		const history = entries(1000);
		await mount(history);
		await browseTo(1603);
		scrollMetrics.span = 8000;
		await render(history);
		expect(track.scrollTop).toBe(1603);
		expect(marks().some((mark) => mark.dataset.navigationTurn === "item-200")).toBe(true);
	});
});
