// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	DesktopWorkspaceReviewFile,
	DesktopWorkspaceReviewSnapshot,
	MetisDesktopApi,
} from "../src/shared/desktop-api.ts";

vi.mock("@pierre/diffs/react", () => ({
	PatchDiff: ({ patch }: { readonly patch: string }) => <pre data-testid="patch">{patch}</pre>,
	WorkerPoolContextProvider: ({ children }: { readonly children: ReactNode }) => (
		<div data-testid="worker-provider">{children}</div>
	),
}));

import { ReviewPanel } from "../src/renderer/components/ReviewPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";

const sessionId = "123e4567-e89b-42d3-a456-426614174000";
const commitHash = "0123456789abcdef0123456789abcdef01234567";
const FILE_COUNT = 60;
const VIEWPORT_HEIGHT = 600;
const ROW_HEIGHT = 37;
const EXPANDED_HEIGHT = 337;
const LIST_OFFSET = 32;

function rectangle(height: number): DOMRect {
	return {
		x: 0,
		y: 0,
		left: 0,
		right: 800,
		top: 0,
		bottom: height,
		width: 800,
		height,
		toJSON: () => ({}),
	} as DOMRect;
}

function rowHeight(element: Element): number {
	return element.querySelector('[data-testid="patch"]') ? EXPANDED_HEIGHT : ROW_HEIGHT;
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

const originalOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
const originalOffsetTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetTop");
const originalClientHeight = Object.getOwnPropertyDescriptor(Element.prototype, "clientHeight");
const originalScrollHeight = Object.getOwnPropertyDescriptor(Element.prototype, "scrollHeight");
const originalRect = Element.prototype.getBoundingClientRect;

let frames: Map<number, FrameRequestCallback>;
let frameId: number;
let roots: Root[];

function makeFiles(count: number): DesktopWorkspaceReviewFile[] {
	return Array.from(
		{ length: count },
		(_, index) =>
			({
				relativePath: `src/file-${String(index).padStart(2, "0")}.ts`,
				previousRelativePath: null,
				status: "modified",
				additions: index + 1,
				deletions: 0,
				binary: false,
			}) as DesktopWorkspaceReviewFile,
	);
}

function makeSnapshot(files: readonly DesktopWorkspaceReviewFile[]): DesktopWorkspaceReviewSnapshot {
	return {
		kind: "review",
		repositoryRoot: "/tmp/project",
		branch: "main",
		head: commitHash,
		revision: "working-tree",
		files: [...files],
		commits: [
			{
				hash: commitHash,
				shortHash: "0123456",
				subject: "Initial commit",
				authorName: "Ada",
				authoredAt: "2026-08-05T00:00:00Z",
			},
		],
	};
}

async function flush() {
	await act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
}

async function flushFrames() {
	for (let index = 0; index < 6; index += 1) {
		await act(async () => {
			const pending = [...frames.values()];
			frames.clear();
			for (const callback of pending) callback(performance.now());
			await Promise.resolve();
		});
	}
}

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
	roots = [];
	frames = new Map();
	frameId = 0;
	vi.stubGlobal("ResizeObserver", ControlledResizeObserver);
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		const id = ++frameId;
		frames.set(id, callback);
		return id;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
		configurable: true,
		get() {
			if (this.classList.contains("review-content")) return VIEWPORT_HEIGHT;
			if (this.classList.contains("review-file")) return rowHeight(this);
			return originalOffsetHeight?.get?.call(this) ?? 0;
		},
	});
	Object.defineProperty(HTMLElement.prototype, "offsetTop", {
		configurable: true,
		get() {
			if (this.classList.contains("review-files")) return LIST_OFFSET;
			return originalOffsetTop?.get?.call(this) ?? 0;
		},
	});
	Object.defineProperty(Element.prototype, "clientHeight", {
		configurable: true,
		get() {
			if (this.classList.contains("review-content")) return VIEWPORT_HEIGHT;
			return originalClientHeight?.get?.call(this) ?? 0;
		},
	});
	Object.defineProperty(Element.prototype, "scrollHeight", {
		configurable: true,
		get(this: Element) {
			if (this.classList.contains("review-content")) {
				const files = this.querySelector<HTMLElement>(".review-files");
				const listHeight = Number.parseFloat(files?.style.height ?? "") || 0;
				return Math.max(VIEWPORT_HEIGHT, LIST_OFFSET + listHeight);
			}
			return originalScrollHeight?.get?.call(this) ?? 0;
		},
	});
	vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
		if (this.classList.contains("review-content")) return rectangle(VIEWPORT_HEIGHT);
		if (this.classList.contains("review-file")) return rectangle(rowHeight(this));
		return originalRect.call(this);
	});
});

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots = [];
	document.body.replaceChildren();
	ControlledResizeObserver.instances.length = 0;
	frames.clear();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	for (const [target, key, descriptor] of [
		[HTMLElement.prototype, "offsetHeight", originalOffsetHeight],
		[HTMLElement.prototype, "offsetTop", originalOffsetTop],
		[Element.prototype, "clientHeight", originalClientHeight],
		[Element.prototype, "scrollHeight", originalScrollHeight],
	] as const) {
		if (descriptor) Object.defineProperty(target, key, descriptor);
		else Reflect.deleteProperty(target, key);
	}
});

async function mountReview(options: { readonly files?: readonly DesktopWorkspaceReviewFile[] } = {}) {
	const files = options.files ?? makeFiles(FILE_COUNT);
	const snapshot = makeSnapshot(files);
	const api = {
		getWorkspaceReview: vi.fn().mockResolvedValue(snapshot),
		getWorkspaceReviewFileDiff: vi.fn().mockResolvedValue({ kind: "text", patch: "diff patch" }),
	} as unknown as MetisDesktopApi;
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const render = (focusRequest?: { readonly id: string; readonly path?: string }) =>
		act(async () => root.render(<ReviewPanel api={api} sessionId={sessionId} visible focusRequest={focusRequest} />));
	await render();
	await flush();
	await flushFrames();
	const scroll = container.querySelector<HTMLElement>(".review-content")!;
	const scrollTo = vi.fn((next: ScrollToOptions) => {
		const top = Math.max(0, next.top ?? scroll.scrollTop);
		if (top === scroll.scrollTop) return;
		scroll.scrollTop = top;
		queueMicrotask(() => {
			if (scroll.isConnected) scroll.dispatchEvent(new Event("scroll"));
		});
	});
	Object.defineProperty(scroll, "scrollTo", { configurable: true, value: scrollTo });
	const mountedIndices = () =>
		[...container.querySelectorAll<HTMLElement>(".review-file")].map((row) => Number(row.dataset.index));
	const row = (index: number) => container.querySelector<HTMLElement>(`.review-file[data-index="${index}"]`);
	const scrollToTop = async (top: number) => {
		await act(async () => {
			scroll.scrollTop = top;
			scroll.dispatchEvent(new Event("scroll"));
			await Promise.resolve();
		});
		await flushFrames();
	};
	return { api, container, files, render, row, mountedIndices, scroll, scrollTo, scrollToTop };
}

describe("ReviewPanel virtualization", () => {
	it("mounts only the visible window and follows the scroll position", async () => {
		const { container, mountedIndices, row, scrollToTop } = await mountReview();
		const initial = mountedIndices();
		expect(initial[0]).toBe(0);
		expect(initial.length).toBeGreaterThan(5);
		expect(initial.length).toBeLessThan(FILE_COUNT);
		expect(initial).not.toContain(FILE_COUNT - 1);
		expect(row(FILE_COUNT - 1)).toBeNull();
		expect(container.querySelector<HTMLElement>(".review-files")?.style.height).toBe(
			`${FILE_COUNT * ROW_HEIGHT + 20}px`,
		);

		await scrollToTop(FILE_COUNT * ROW_HEIGHT + 20 - VIEWPORT_HEIGHT);
		const scrolled = mountedIndices();
		expect(scrolled).toContain(FILE_COUNT - 1);
		expect(scrolled).not.toContain(0);
	});

	it("reacts to a focus request for a distant file and keeps it in place when the diff arrives", async () => {
		let resolveDiff!: (value: { readonly kind: "text"; readonly patch: string }) => void;
		const { api, container, files, render, row, scroll, scrollTo } = await mountReview();
		api.getWorkspaceReviewFileDiff = vi.fn(
			() =>
				new Promise<{ readonly kind: "text"; readonly patch: string }>((resolve) => {
					resolveDiff = resolve;
				}),
		) as unknown as MetisDesktopApi["getWorkspaceReviewFileDiff"];
		const targetIndex = 30;
		const target = files[targetIndex]!;
		await render({ id: "focus-far", path: target.relativePath });
		await flushFrames();

		expect(api.getWorkspaceReviewFileDiff).toHaveBeenCalledWith({
			sessionId,
			revision: "working-tree",
			relativePath: target.relativePath,
		});
		// The row is far outside the initial window, so the virtualizer jumps by its measured offset.
		const targetTop = LIST_OFFSET + targetIndex * ROW_HEIGHT;
		expect(scrollTo).toHaveBeenCalledWith({ top: targetTop, behavior: "smooth" });
		expect(scroll.scrollTop).toBe(targetTop);
		const targetRow = row(targetIndex);
		expect(targetRow).not.toBeNull();
		expect(targetRow?.querySelector(".review-file-header")?.getAttribute("aria-expanded")).toBe("true");
		expect(targetRow?.querySelector('[data-testid="patch"]')).toBeNull();

		await act(async () => resolveDiff({ kind: "text", patch: "far patch" }));
		await flush();
		await flushFrames();
		expect(row(targetIndex)?.querySelector('[data-testid="patch"]')?.textContent).toBe("far patch");
		expect(scroll.scrollTop).toBe(targetTop);
		expect(container.querySelector('[data-testid="worker-provider"]')).not.toBeNull();
	});

	it("measures expanded rows and keeps later rows at their real offsets", async () => {
		const { container, row } = await mountReview();
		const provider = container.querySelector('[data-testid="worker-provider"]');
		const expandedIndex = 2;
		const expandedRow = row(expandedIndex)!;

		await act(async () => expandedRow.querySelector<HTMLButtonElement>(".review-file-header")!.click());
		await flush();
		expect(row(5)?.style.transform).toBe(`translateY(${5 * ROW_HEIGHT}px)`);

		await act(async () => ControlledResizeObserver.trigger(row(expandedIndex)!));
		await flushFrames();

		const delta = EXPANDED_HEIGHT - ROW_HEIGHT;
		expect(row(5)?.style.transform).toBe(`translateY(${5 * ROW_HEIGHT + delta}px)`);
		expect(container.querySelector<HTMLElement>(".review-files")?.style.height).toBe(
			`${FILE_COUNT * ROW_HEIGHT + 20 + delta}px`,
		);
		expect(row(expandedIndex)?.querySelector('[data-testid="patch"]')?.textContent).toBe("diff patch");

		await act(async () => row(expandedIndex)!.querySelector<HTMLButtonElement>(".review-file-header")!.click());
		await flushFrames();
		expect(container.querySelector('[data-testid="worker-provider"]')).toBe(provider);
	});

	it("drops stale expanded heights when the review is refreshed", async () => {
		const { container, row } = await mountReview();
		await act(async () => row(2)!.querySelector<HTMLButtonElement>(".review-file-header")!.click());
		await flush();
		await act(async () => ControlledResizeObserver.trigger(row(2)!));
		await flushFrames();
		const expandedHeight = FILE_COUNT * ROW_HEIGHT + 20 + EXPANDED_HEIGHT - ROW_HEIGHT;
		expect(container.querySelector<HTMLElement>(".review-files")?.style.height).toBe(`${expandedHeight}px`);

		await act(async () =>
			[...container.querySelectorAll<HTMLButtonElement>("button")]
				.find((candidate) => candidate.getAttribute("aria-label") === "Refresh review")!
				.click(),
		);
		await flush();
		await flushFrames();
		expect(container.querySelector<HTMLElement>(".review-files")?.style.height).toBe(
			`${FILE_COUNT * ROW_HEIGHT + 20}px`,
		);
		expect(row(2)?.querySelector(".review-file-header")?.getAttribute("aria-expanded")).toBe("false");
	});

	it("jumps from the file tree to a distant file", async () => {
		const { api, container, files, row, scroll, scrollTo } = await mountReview();
		const targetIndex = 30;
		const target = files[targetIndex]!;
		const targetName = target.relativePath.split("/").at(-1)!;
		await act(async () =>
			[...container.querySelectorAll<HTMLButtonElement>("button")]
				.find((candidate) => candidate.getAttribute("aria-label") === "Show review details")!
				.click(),
		);
		await flush();
		const treeButton = [...container.querySelectorAll<HTMLButtonElement>(".review-tree button")].find((candidate) =>
			candidate.textContent?.includes(targetName),
		)!;
		await act(async () => treeButton.click());
		await flushFrames();

		const targetTop = LIST_OFFSET + targetIndex * ROW_HEIGHT;
		expect(api.getWorkspaceReviewFileDiff).toHaveBeenCalledWith({
			sessionId,
			revision: "working-tree",
			relativePath: target.relativePath,
		});
		expect(scrollTo).toHaveBeenCalledWith({ top: targetTop, behavior: "smooth" });
		expect(scroll.scrollTop).toBe(targetTop);
		expect(row(targetIndex)?.querySelector(".review-file-header")?.getAttribute("aria-expanded")).toBe("true");
	});
});
