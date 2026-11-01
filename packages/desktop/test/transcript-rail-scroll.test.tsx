// @vitest-environment jsdom

import type { ItemView } from "@metis/app-protocol";
import { act, type ComponentProps, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Transcript } from "../src/renderer/components/Transcript.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

vi.mock("../src/renderer/components/ConversationNavigation.tsx", () => ({
	ConversationNavigation: ({
		scrollRef,
		onScrollGesture,
		onScrollToOffset,
	}: {
		readonly scrollRef: RefObject<HTMLDivElement | null>;
		readonly onScrollGesture?: (active: boolean) => void;
		readonly onScrollToOffset: (offset: number) => void;
	}) => (
		<nav aria-label="Test rail">
			<button onClick={() => onScrollGesture?.(true)} type="button">
				Start drag
			</button>
			<button onClick={() => onScrollGesture?.(false)} type="button">
				End drag
			</button>
			<button onClick={() => onScrollToOffset(300)} type="button">
				Scroll middle
			</button>
			<button
				onClick={() =>
					onScrollToOffset((scrollRef.current?.scrollHeight ?? 0) - (scrollRef.current?.clientHeight ?? 0))
				}
				type="button"
			>
				Scroll bottom
			</button>
		</nav>
	),
}));

const FIRST_SESSION = "11111111-1111-4111-8111-111111111111";
const SECOND_SESSION = "22222222-2222-4222-8222-222222222222";
let roots: Root[] = [];
let frames: Map<number, FrameRequestCallback>;
let frameId = 0;
let metrics: { contentHeight: number; viewportHeight: number };

function rectangle(height: number, top = 0): DOMRect {
	return { x: 0, y: top, left: 0, right: 760, top, bottom: top + height, width: 760, height, toJSON: () => ({}) };
}

class ControlledResizeObserver implements ResizeObserver {
	static readonly instances: ControlledResizeObserver[] = [];
	readonly targets = new Set<Element>();
	private readonly callback: ResizeObserverCallback;
	constructor(callback: ResizeObserverCallback) {
		this.callback = callback;
		ControlledResizeObserver.instances.push(this);
	}
	observe(target: Element) {
		this.targets.add(target);
	}
	unobserve(target: Element) {
		this.targets.delete(target);
	}
	disconnect() {
		this.targets.clear();
	}
	static trigger(target: Element) {
		const rect = target.getBoundingClientRect();
		const entry = {
			target,
			contentRect: rect,
			borderBoxSize: [{ inlineSize: rect.width, blockSize: rect.height }],
		} as unknown as ResizeObserverEntry;
		for (const observer of ControlledResizeObserver.instances) {
			if (observer.targets.has(target)) observer.callback([entry], observer);
		}
	}
}

const originalScrollTo = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollTo");
const originalClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight");
const originalScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");
const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetWidth");

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	// virtual-core uses the owning window, which jsdom keeps separate from
	// Vitest's global timer bindings. Share the same controlled clock.
	const setWindowTimeout = globalThis.setTimeout;
	const clearWindowTimeout = globalThis.clearTimeout;
	vi.spyOn(window, "setTimeout").mockImplementation(setWindowTimeout);
	vi.spyOn(window, "clearTimeout").mockImplementation(clearWindowTimeout);
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
	frames = new Map();
	metrics = { contentHeight: 1_000, viewportHeight: 600 };
	vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		const id = ++frameId;
		frames.set(id, callback);
		return id;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	Object.defineProperty(Element.prototype, "clientHeight", {
		configurable: true,
		get() {
			return this.classList.contains("transcript-scroll")
				? metrics.viewportHeight
				: (originalClientHeight?.get?.call(this) ?? 0);
		},
	});
	Object.defineProperty(Element.prototype, "scrollHeight", {
		configurable: true,
		get() {
			return this.classList.contains("transcript-scroll")
				? Math.max(metrics.contentHeight, metrics.viewportHeight)
				: (originalScrollHeight?.get?.call(this) ?? 0);
		},
	});
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
		configurable: true,
		get() {
			if (this.classList.contains("transcript-scroll")) return metrics.viewportHeight;
			if (this.hasAttribute("data-index")) return metrics.contentHeight;
			return originalOffsetHeight?.get?.call(this) ?? 0;
		},
	});
	Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
		configurable: true,
		get() {
			return this.classList.contains("transcript-scroll") ? 760 : (originalOffsetWidth?.get?.call(this) ?? 0);
		},
	});
	const originalRect = Element.prototype.getBoundingClientRect;
	vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
		if (this.classList.contains("transcript-scroll")) return rectangle(metrics.viewportHeight);
		if (this.classList.contains("transcript-space") || this.hasAttribute("data-index"))
			return rectangle(metrics.contentHeight);
		return originalRect.call(this);
	});
	Object.defineProperty(HTMLElement.prototype, "scrollTo", {
		configurable: true,
		value(this: HTMLElement, options: ScrollToOptions) {
			const before = this.scrollTop;
			const maximum = Math.max(0, this.scrollHeight - this.clientHeight);
			this.scrollTop = Math.max(0, Math.min(maximum, options.top ?? before));
			if (before !== this.scrollTop)
				queueMicrotask(() => {
					if (this.isConnected) this.dispatchEvent(new Event("scroll"));
				});
		},
	});
});

afterEach(async () => {
	// Flush virtual-core's trailing scroll debounce before jsdom is destroyed.
	await act(async () => {
		await vi.runOnlyPendingTimersAsync();
	});
	for (const root of roots) await act(async () => root.unmount());
	roots = [];
	document.body.replaceChildren();
	ControlledResizeObserver.instances.length = 0;
	frames.clear();
	vi.restoreAllMocks();
	vi.useRealTimers();
	vi.unstubAllGlobals();
	for (const [target, key, descriptor] of [
		[HTMLElement.prototype, "scrollTo", originalScrollTo],
		[Element.prototype, "clientHeight", originalClientHeight],
		[Element.prototype, "scrollHeight", originalScrollHeight],
		[HTMLElement.prototype, "offsetHeight", originalOffsetHeight],
		[HTMLElement.prototype, "offsetWidth", originalOffsetWidth],
	] as const) {
		if (descriptor) Object.defineProperty(target, key, descriptor);
		else Reflect.deleteProperty(target, key);
	}
});

async function flushFrames() {
	for (let index = 0; index < 4; index += 1) {
		await act(async () => {
			const pending = [...frames.values()];
			frames.clear();
			for (const callback of pending) callback(performance.now());
			await Promise.resolve();
		});
	}
}

function messages(sessionId: string, text: string): ItemView[] {
	return ["user", "assistant"].map((role) => ({
		itemId: `${sessionId}-${role}`,
		sessionId,
		turnId: `${sessionId}-turn`,
		role: role as ItemView["role"],
		state: role === "assistant" ? "streaming" : "completed",
		createdAt: "2026-10-25T12:00:00Z",
		content: [{ type: "text", text: role === "user" ? "Question" : text }],
	}));
}

async function mount(options: { hasOlder?: boolean; onLoadOlder?: () => Promise<void> } = {}) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const onLoadOlder = options.onLoadOlder ?? vi.fn(async () => undefined);
	const render = async (
		sessionId = FIRST_SESSION,
		text = "Streaming answer",
		hasOlder = options.hasOlder ?? false,
		overrides: Partial<ComponentProps<typeof Transcript>> = {},
	) => {
		const items = messages(sessionId, text);
		await act(async () =>
			root.render(
				<Transcript
					appearance="chat"
					autoLoadOlder
					hasOlder={hasOlder}
					itemIds={items.map((item) => item.itemId)}
					itemsById={new Map(items.map((item) => [item.itemId, item]))}
					latestLabel="Latest"
					loadingOlder={false}
					onLoadOlder={onLoadOlder}
					quoteSessionId={sessionId}
					showNavigation
					{...overrides}
				/>,
			),
		);
	};
	await render();
	const scroll = container.querySelector<HTMLDivElement>(".transcript-scroll")!;
	let top = 0;
	Object.defineProperty(scroll, "scrollTop", {
		configurable: true,
		get: () => top,
		set(value: number) {
			top = Math.max(0, Math.min(Math.max(0, metrics.contentHeight - metrics.viewportHeight), value));
		},
	});
	const click = async (text: string) => {
		const control = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
			(button) => button.textContent === text,
		)!;
		await act(async () => control.click());
	};
	const resize = async () => {
		await act(async () => {
			const row = container.querySelector("[data-index]");
			if (row) ControlledResizeObserver.trigger(row);
			ControlledResizeObserver.trigger(scroll);
		});
		await flushFrames();
	};
	await flushFrames();
	return { container, scroll, render, click, resize, onLoadOlder };
}

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((complete) => {
		resolve = complete;
	});
	return { promise, resolve };
}

describe("Transcript rail scroll ownership", () => {
	it("keeps following when content grows before the browser reports its new scroll position", async () => {
		const view = await mount();
		await view.click("Scroll bottom");
		const content = view.container.querySelector(".transcript-space")!;
		metrics.contentHeight = 1_500;
		await act(async () => view.scroll.dispatchEvent(new Event("scroll")));
		await act(async () => ControlledResizeObserver.trigger(content));
		await flushFrames();
		expect(view.scroll.scrollTop).toBe(900);

		await view.click("Scroll middle");
		metrics.contentHeight = 1_800;
		await act(async () => ControlledResizeObserver.trigger(content));
		await flushFrames();
		expect(view.scroll.scrollTop).toBe(300);
	});

	it("follows delayed content measurement after an accepted user submission", async () => {
		const view = await mount();
		await view.click("Scroll middle");
		const items = messages(FIRST_SESSION, "").map((item) => ({ ...item, turnId: "submitted-turn" }));
		await view.render(FIRST_SESSION, "", false, {
			submittedTurnId: "submitted-turn",
			itemIds: items.map((item) => item.itemId),
			itemsById: new Map(items.map((item) => [item.itemId, item])),
		});
		await flushFrames();
		expect(view.scroll.scrollTop).toBe(400);
		metrics.contentHeight = 1_600;
		await act(async () => view.scroll.dispatchEvent(new Event("scroll")));
		await act(async () => ControlledResizeObserver.trigger(view.container.querySelector(".transcript-space")!));
		await flushFrames();
		expect(view.scroll.scrollTop).toBe(1_000);
	});

	it("does not treat the new session's initial scroll reset as browsing upward", async () => {
		const view = await mount();
		await view.click("Scroll bottom");
		await view.render(SECOND_SESSION);
		await act(async () => {
			view.scroll.scrollTop = 0;
			view.scroll.dispatchEvent(new Event("scroll"));
		});
		await flushFrames();
		expect(view.scroll.scrollTop).toBe(400);
	});

	it.each(["turn", "agent message"] as const)(
		"follows an accepted %s only after its user message is visible and only once",
		async (identity) => {
			const view = await mount();
			await view.click("Scroll middle");
			const submission =
				identity === "turn" ? { submittedTurnId: "next-turn" } : { submittedMessageId: "next-message" };
			await view.render(FIRST_SESSION, "Streaming answer", false, submission);
			await flushFrames();
			expect(view.scroll.scrollTop).toBe(300);
			const items = [
				...messages(FIRST_SESSION, "Previous answer"),
				{
					...messages(FIRST_SESSION, "")[0]!,
					itemId: "next-user",
					turnId: "next-turn",
					agentMessageId: "next-message",
					deliveryState: "accepted" as const,
				},
			];
			const visible = {
				...submission,
				itemIds: items.map((item) => item.itemId),
				itemsById: new Map(items.map((item) => [item.itemId, item])),
			};
			if (identity === "agent message") {
				for (const deliveryState of ["queued", "failed", "cancelled"] as const) {
					const pending = items.map((item) => (item.itemId === "next-user" ? { ...item, deliveryState } : item));
					await view.render(FIRST_SESSION, "", false, {
						...visible,
						itemsById: new Map(pending.map((item) => [item.itemId, item])),
					});
					await flushFrames();
					expect(view.scroll.scrollTop).toBe(300);
				}
			}
			await view.render(FIRST_SESSION, "", false, visible);
			await flushFrames();
			expect(view.scroll.scrollTop).toBe(400);
			await view.click("Scroll middle");
			const durable = items.map((item) =>
				item.itemId === "next-user"
					? { ...item, itemId: "durable-user", deliveryState: "delivered" as const }
					: item,
			);
			await view.render(FIRST_SESSION, "", false, {
				...submission,
				itemIds: durable.map((item) => item.itemId),
				itemsById: new Map(durable.map((item) => [item.itemId, item])),
			});
			await flushFrames();
			expect(view.scroll.scrollTop).toBe(300);
		},
	);

	it("keeps a dragged position through streaming and resize, then follows after release at the bottom", async () => {
		const view = await mount();
		await view.click("Start drag");
		await view.click("Scroll middle");
		expect(view.scroll.scrollTop).toBe(300);
		metrics.contentHeight = 1_600;
		await view.render(FIRST_SESSION, "A longer streaming answer");
		await view.resize();
		expect(view.scroll.scrollTop).toBe(300);
		metrics.viewportHeight = 500;
		await view.resize();
		expect(view.scroll.scrollTop).toBe(300);
		await view.click("Scroll bottom");
		expect(view.scroll.scrollTop).toBe(1_100);
		metrics.contentHeight = 1_800;
		await view.render(FIRST_SESSION, "Still streaming while the pointer is down");
		await view.resize();
		expect(view.scroll.scrollTop).toBe(1_100);
		await view.click("Scroll bottom");
		await view.click("End drag");
		metrics.contentHeight = 2_000;
		await view.render(FIRST_SESSION, "Streaming after release at the bottom");
		await view.resize();
		expect(view.scroll.scrollTop).toBe(1_500);
		expect(view.container.querySelector(".transcript-latest")).toBeNull();
	});

	it("does not let a late history prepend overwrite a later completed drag", async () => {
		const older = deferred();
		const onLoadOlder = vi.fn(() => older.promise);
		const view = await mount({ hasOlder: true, onLoadOlder });
		await act(async () => {
			view.scroll.scrollTop = 0;
			view.scroll.dispatchEvent(new Event("scroll"));
		});
		expect(onLoadOlder).toHaveBeenCalledOnce();
		await view.click("Start drag");
		await view.click("Scroll middle");
		await view.click("End drag");
		metrics.contentHeight = 1_400;
		await act(async () => older.resolve());
		await flushFrames();
		expect(view.scroll.scrollTop).toBe(300);
	});

	it("keeps a native PageDown position when older history finishes later", async () => {
		const older = deferred();
		const view = await mount({ hasOlder: true, onLoadOlder: vi.fn(() => older.promise) });
		const row = view.container.querySelector<HTMLElement>("[data-transcript-turn]")!;
		const originalHeight = metrics.contentHeight;
		Object.defineProperty(row, "getBoundingClientRect", {
			configurable: true,
			value: () => rectangle(originalHeight, metrics.contentHeight - originalHeight - view.scroll.scrollTop),
		});
		await act(async () => {
			view.scroll.scrollTop = 0;
			view.scroll.dispatchEvent(new Event("scroll"));
		});
		expect(view.onLoadOlder).toHaveBeenCalledOnce();
		const pageDown = new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true });
		await act(async () => {
			view.scroll.dispatchEvent(pageDown);
			// jsdom has no native scrolling default action; apply the browser's resulting position.
			view.scroll.scrollTop = 300;
			view.scroll.dispatchEvent(new Event("scroll"));
		});
		expect(pageDown.defaultPrevented).toBe(false);
		metrics.contentHeight = 1_400;
		await act(async () => older.resolve());
		await flushFrames();
		expect(view.scroll.scrollTop).toBe(300);
	});

	it.each([
		{ tag: "input", key: "PageDown", label: "an input's navigation" },
		{ tag: "button", key: " ", label: "a button's Space activation" },
	] as const)("preserves history anchoring during $label", async ({ tag, key }) => {
		const older = deferred();
		const view = await mount({ hasOlder: true, onLoadOlder: vi.fn(() => older.promise) });
		const row = view.container.querySelector<HTMLElement>("[data-transcript-turn]")!;
		const originalHeight = metrics.contentHeight;
		Object.defineProperty(row, "getBoundingClientRect", {
			configurable: true,
			value: () => rectangle(originalHeight, metrics.contentHeight - originalHeight - view.scroll.scrollTop),
		});
		const control = document.createElement(tag);
		row.append(control);
		await act(async () => {
			view.scroll.scrollTop = 0;
			view.scroll.dispatchEvent(new Event("scroll"));
		});
		expect(view.onLoadOlder).toHaveBeenCalledOnce();
		const keyDown = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
		await act(async () => {
			control.focus();
			control.dispatchEvent(keyDown);
		});
		expect(keyDown.defaultPrevented).toBe(false);
		metrics.contentHeight = 1_400;
		expect(row.isConnected).toBe(true);
		expect(row.getBoundingClientRect().top).toBe(400);
		await act(async () => older.resolve());
		await flushFrames();
		expect(view.scroll.scrollTop).toBe(400);
		expect(document.activeElement).toBe(control);
	});

	it("ignores an old session's history completion when the scroll element is reused", async () => {
		const older = deferred();
		const view = await mount({ hasOlder: true, onLoadOlder: vi.fn(() => older.promise) });
		await act(async () => {
			view.scroll.scrollTop = 0;
			view.scroll.dispatchEvent(new Event("scroll"));
		});
		expect(view.onLoadOlder).toHaveBeenCalledOnce();
		metrics.contentHeight = 1_400;
		await view.render(SECOND_SESSION, "New session", false);
		await flushFrames();
		expect(view.container.querySelector(".transcript-scroll")).toBe(view.scroll);
		await view.click("Start drag");
		await view.click("Scroll middle");
		await view.click("End drag");
		await act(async () => older.resolve());
		await flushFrames();
		expect(view.scroll.scrollTop).toBe(300);
	});

	it("loads older history once on upward wheel at a top that cannot scroll", async () => {
		metrics.contentHeight = 400;
		const older = deferred();
		const onLoadOlder = vi.fn(() => older.promise);
		const view = await mount({ hasOlder: true, onLoadOlder });
		expect(view.scroll.scrollTop).toBe(0);
		expect(onLoadOlder).not.toHaveBeenCalled();
		await act(async () => {
			view.scroll.dispatchEvent(new WheelEvent("wheel", { deltaY: -80, bubbles: true }));
			view.scroll.dispatchEvent(new WheelEvent("wheel", { deltaY: -80, bubbles: true }));
		});
		expect(onLoadOlder).toHaveBeenCalledOnce();
		expect(view.scroll.scrollTop).toBe(0);
		await act(async () => older.resolve());
		await flushFrames();
	});
});
