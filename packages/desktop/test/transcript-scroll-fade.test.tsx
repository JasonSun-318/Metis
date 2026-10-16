// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTranscriptScrollFade } from "../src/renderer/hooks/use-transcript-scroll-fade.ts";

interface ScrollMetrics {
	contentHeight: number;
	viewportHeight: number;
	top: number;
}

const observers: { callback: ResizeObserverCallback; targets: Set<Element>; observer: ResizeObserver }[] = [];
let root: Root | undefined;
let container: HTMLDivElement;
let viewport: HTMLDivElement;
let content: HTMLDivElement;
let metrics: ScrollMetrics;

function Harness() {
	const scrollRef = useRef<HTMLDivElement>(null);
	const contentRef = useRef<HTMLDivElement>(null);
	useTranscriptScrollFade(scrollRef, contentRef);
	return (
		<div
			ref={(element) => {
				scrollRef.current = element;
				if (!element) return;
				Object.defineProperties(element, {
					scrollHeight: { configurable: true, get: () => metrics.contentHeight },
					clientHeight: { configurable: true, get: () => metrics.viewportHeight },
					scrollTop: { configurable: true, get: () => metrics.top },
				});
			}}
		>
			<div ref={contentRef}>Conversation</div>
		</div>
	);
}

async function mount() {
	root = createRoot(container);
	await act(async () => root!.render(<Harness />));
	viewport = container.firstElementChild as HTMLDivElement;
	content = viewport.firstElementChild as HTMLDivElement;
}

function fades() {
	return [
		viewport.style.getPropertyValue("--transcript-fade-top"),
		viewport.style.getPropertyValue("--transcript-fade-bottom"),
	];
}

async function scrollTo(top: number) {
	metrics.top = top;
	await act(async () => {
		viewport.dispatchEvent(new Event("scroll"));
		vi.runOnlyPendingTimers();
	});
}

async function resize(target: Element) {
	await act(async () => {
		for (const { callback, targets, observer } of observers) {
			if (targets.has(target)) callback([{ target } as ResizeObserverEntry], observer);
		}
		vi.runOnlyPendingTimers();
	});
}

beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal(
		"ResizeObserver",
		class implements ResizeObserver {
			readonly targets = new Set<Element>();
			constructor(callback: ResizeObserverCallback) {
				observers.push({ callback, targets: this.targets, observer: this });
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
		},
	);
	observers.length = 0;
	metrics = { contentHeight: 1_000, viewportHeight: 600, top: 0 };
	container = document.createElement("div");
	document.body.append(container);
});

afterEach(async () => {
	if (root) await act(async () => root!.unmount());
	root = undefined;
	document.body.replaceChildren();
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("transcript scroll fades", () => {
	it("leaves short conversations fully visible", async () => {
		metrics.contentHeight = 300;
		await mount();
		expect(fades()).toEqual(["0px", "0px"]);
		expect(viewport.dataset.scrollFade).toBe("false");
	});

	it("only fades the edge that has content beyond it", async () => {
		await mount();
		expect(fades()).toEqual(["0px", "56px"]);
		await scrollTo(200);
		expect(fades()).toEqual(["48px", "56px"]);
		expect(viewport.dataset.scrollFade).toBe("true");
		await scrollTo(400);
		expect(fades()).toEqual(["48px", "0px"]);
	});

	it("shortens the fade near an edge and ignores subpixel overflow", async () => {
		await mount();
		await scrollTo(10);
		expect(fades()).toEqual(["10px", "56px"]);
		await scrollTo(390);
		expect(fades()).toEqual(["48px", "10px"]);
		await scrollTo(399.5);
		expect(fades()).toEqual(["48px", "0px"]);
	});

	it("updates when streamed content grows without a scroll event", async () => {
		metrics.top = 400;
		await mount();
		expect(fades()).toEqual(["48px", "0px"]);
		metrics.contentHeight = 1_400;
		await resize(content);
		expect(fades()).toEqual(["48px", "56px"]);
	});

	it("clears both fades when content shrinks or the viewport grows", async () => {
		metrics.top = 200;
		await mount();
		metrics.contentHeight = 400;
		await resize(content);
		expect(fades()).toEqual(["0px", "0px"]);
		metrics.contentHeight = 1_000;
		await resize(content);
		expect(fades()).toEqual(["48px", "56px"]);
		metrics.viewportHeight = 1_200;
		await resize(viewport);
		expect(fades()).toEqual(["0px", "0px"]);
	});

	it("handles hidden views and clamps overscroll at both ends", async () => {
		metrics.viewportHeight = 0;
		await mount();
		expect(fades()).toEqual(["0px", "0px"]);
		metrics.viewportHeight = 600;
		await resize(viewport);
		await scrollTo(-15);
		expect(fades()).toEqual(["0px", "56px"]);
		await scrollTo(420);
		expect(fades()).toEqual(["48px", "0px"]);
	});

	it("disconnects observers and cancels a queued update on unmount", async () => {
		await mount();
		metrics.top = 200;
		viewport.dispatchEvent(new Event("scroll"));
		await act(async () => root!.unmount());
		root = undefined;
		vi.runOnlyPendingTimers();
		expect(fades()).toEqual(["", ""]);
		expect(viewport.dataset.scrollFade).toBeUndefined();
		expect(observers.every(({ targets }) => targets.size === 0)).toBe(true);
	});
});
