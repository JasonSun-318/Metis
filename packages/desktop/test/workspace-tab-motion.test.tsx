// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceTabMotion } from "../src/renderer/components/WorkspaceTabMotion.tsx";
import { TAB_MOTION_GHOST_CLASS, tabStripLayout } from "../src/renderer/workspace-tab-motion.ts";

interface FakeAnimation {
	readonly target: HTMLElement;
	readonly keyframes: Keyframe[];
	readonly options: KeyframeAnimationOptions;
	readonly cancelled: boolean;
	readonly finished: Promise<FakeAnimation>;
	cancel(): void;
}

let animations: FakeAnimation[] = [];
let roots: Root[] = [];
let layouts = new Map<string, ReadonlyMap<string, number>>();
let originalAnimate: PropertyDescriptor | undefined;

function fakeRect(left: number, width: number): DOMRect {
	return {
		x: left,
		y: 0,
		top: 0,
		left,
		right: left + width,
		bottom: 28,
		width,
		height: 28,
		toJSON: () => ({}),
	} as DOMRect;
}

function createAnimation(target: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions): FakeAnimation {
	let cancelled = false;
	let reject!: (reason: unknown) => void;
	const finished = new Promise<FakeAnimation>((_resolve, rej) => {
		reject = rej;
	});
	const animation: FakeAnimation = {
		target,
		keyframes,
		options,
		get cancelled() {
			return cancelled;
		},
		finished,
		cancel: () => {
			cancelled = true;
			reject(new Error("cancelled"));
		},
	};
	animations.push(animation);
	return animation;
}

function setLayout(ids: readonly string[], positions: readonly number[]): void {
	layouts.set(ids.join(","), new Map(ids.map((id, index) => [id, positions[index] ?? index * 100])));
}

function Harness({
	ids,
	scope = "pane-a",
	suspended = false,
	content = "",
}: {
	readonly ids: readonly string[];
	readonly scope?: string;
	readonly suspended?: boolean;
	readonly content?: string;
}) {
	return (
		<div className="tool-tabs-scroll" style={{ position: "relative" }}>
			<WorkspaceTabMotion layoutKey={ids.join("\0")} scope={scope} suspended={suspended}>
				{ids.map((id) => (
					<div className="tool-tab" data-tab-motion-key={id} key={id}>
						<button id={`tab-${id}`} role="tab" tabIndex={0} type="button">
							{id}
							{content}
						</button>
						<button aria-label={`Close ${id}`} className="tool-tab-close" id={`close-${id}`} type="button">
							x
						</button>
					</div>
				))}
			</WorkspaceTabMotion>
		</div>
	);
}

async function mount(ids: readonly string[], props: { scope?: string; suspended?: boolean; content?: string } = {}) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	const render = async (nextIds: readonly string[], nextProps = props) => {
		await act(async () => {
			root.render(
				<Harness
					content={nextProps.content}
					ids={nextIds}
					scope={nextProps.scope}
					suspended={nextProps.suspended}
				/>,
			);
		});
	};
	await render(ids, props);
	return { container, render, root };
}

function moveAnimations() {
	return animations.filter(
		(animation) =>
			!animation.target.classList.contains(TAB_MOTION_GHOST_CLASS) &&
			JSON.stringify(animation.keyframes[0] ?? {}).includes("translate"),
	);
}

beforeEach(() => {
	animations = [];
	layouts = new Map();
	document.documentElement.dataset.motion = "full";
	originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
	Object.defineProperty(HTMLElement.prototype, "animate", {
		configurable: true,
		writable: true,
		value: function (this: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions) {
			return createAnimation(this, keyframes, options);
		},
	});
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
		if (this.classList.contains("tool-tabs-scroll")) return fakeRect(0, 1000);
		const key = this.getAttribute("data-tab-motion-key");
		if (key === null) return fakeRect(0, 0);
		const strip = this.closest(".tool-tabs-scroll");
		const ids = [...(strip?.querySelectorAll("[data-tab-motion-key]") ?? [])].map((el) =>
			el.getAttribute("data-tab-motion-key"),
		);
		const left = layouts.get(ids.join(","))?.get(key);
		return fakeRect(left ?? 0, 80);
	});
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
	for (const root of roots) await act(async () => root.unmount());
	roots = [];
	document.body.replaceChildren();
	delete document.documentElement.dataset.motion;
	vi.restoreAllMocks();
	if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
	else Reflect.deleteProperty(HTMLElement.prototype, "animate");
});

describe("workspace tab motion", () => {
	it("measures nested flow coordinates without reading transformed rectangles", () => {
		const host = document.createElement("div");
		const wrapper = document.createElement("div");
		const tab = document.createElement("div");
		host.append(wrapper);
		wrapper.append(tab);
		tab.style.transform = "translateX(500px)";
		Object.defineProperties(tab, {
			offsetLeft: { value: 7 },
			offsetTop: { value: 3 },
			offsetWidth: { value: 80 },
			offsetHeight: { value: 28 },
			offsetParent: { value: wrapper },
		});
		Object.defineProperties(wrapper, {
			offsetLeft: { value: 17 },
			offsetTop: { value: 4 },
			offsetParent: { value: host },
		});
		Object.defineProperties(host, {
			offsetLeft: { value: 250 },
			offsetTop: { value: 100 },
		});
		const rectangles = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
		rectangles.mockClear();
		expect(tabStripLayout(tab, host)).toEqual({ left: 24, top: 7, width: 80, height: 28 });
		expect(tabStripLayout(tab, null)).toEqual({ left: 274, top: 107, width: 80, height: 28 });
		expect(rectangles).not.toHaveBeenCalled();
	});

	it("removes the tab immediately and leaves only inert exit chrome", async () => {
		setLayout(["a", "b"], [0, 100]);
		setLayout(["b"], [0]);
		const view = await mount(["a", "b"]);
		expect(animations).toHaveLength(0);

		await view.render(["b"]);
		expect(view.container.querySelectorAll('[role="tab"]')).toHaveLength(1);
		expect(view.container.querySelector('[id="tab-a"]')).toBeNull();

		const ghost = view.container.querySelector<HTMLElement>(`.${TAB_MOTION_GHOST_CLASS}`)!;
		expect(ghost).not.toBeNull();
		expect(ghost.closest(".tool-tabs-scroll")).not.toBeNull();
		expect(ghost.getAttribute("aria-hidden")).toBe("true");
		expect(ghost.hasAttribute("inert")).toBe(true);
		expect(ghost.querySelector("[role]")).toBeNull();
		expect(ghost.querySelector("[id]")).toBeNull();
		expect(ghost.querySelector("[tabindex]")).toBeNull();
		expect(ghost.querySelector("[aria-label]")).toBeNull();
		expect(ghost.style.position).toBe("absolute");
		expect(ghost.style.left).toBe("0px");

		const moves = moveAnimations();
		expect(moves).toHaveLength(1);
		expect(moves[0]!.target.getAttribute("data-tab-motion-key")).toBe("b");
		// Survivors slide from their old visual slot; only the exit chrome fades.
		expect(moves[0]!.keyframes).toEqual([
			{ transform: "translate(100px, 0px)" },
			{ transform: "translate(0px, 0px)" },
		]);
		expect(JSON.stringify(moves[0]!.keyframes)).not.toContain("scale");
	});

	it("retargets rapid removals from the current visual position", async () => {
		setLayout(["a", "b", "c"], [0, 100, 200]);
		setLayout(["b", "c"], [0, 100]);
		setLayout(["c"], [0]);
		const view = await mount(["a", "b", "c"]);
		await view.render(["b", "c"]);
		const first = moveAnimations();
		expect(first).toHaveLength(2);
		const firstB = first.find((animation) => animation.target.getAttribute("data-tab-motion-key") === "b")!;

		// Mid-animation: b has already travelled half way and c follows it.
		layouts.set(
			"b,c",
			new Map([
				["b", 50],
				["c", 150],
			]),
		);
		await view.render(["c"]);
		expect(firstB.cancelled).toBe(true);

		const moves = moveAnimations();
		const last = moves.filter((animation) => animation.target.getAttribute("data-tab-motion-key") === "c").at(-1)!;
		expect(last.keyframes).toEqual([{ transform: "translate(150px, 0px)" }, { transform: "translate(0px, 0px)" }]);
		expect(view.container.querySelectorAll('[role="tab"]')).toHaveLength(1);
	});

	it("skips exit chrome and movement while suspended", async () => {
		setLayout(["a", "b"], [0, 100]);
		setLayout(["b"], [0]);
		const view = await mount(["a", "b"], { suspended: true });
		await view.render(["b"], { suspended: true });
		expect(animations).toHaveLength(0);
		expect(view.container.querySelector(`.${TAB_MOTION_GHOST_CLASS}`)).toBeNull();
	});

	it("honors application reduced motion immediately and mid-animation", async () => {
		setLayout(["a", "b"], [0, 100]);
		setLayout(["b"], [0]);
		document.documentElement.dataset.motion = "reduced";
		const view = await mount(["a", "b"]);
		await view.render(["b"]);
		expect(animations).toHaveLength(0);
		expect(view.container.querySelector(`.${TAB_MOTION_GHOST_CLASS}`)).toBeNull();

		document.documentElement.dataset.motion = "full";
		setLayout(["b", "a"], [0, 100]);
		await view.render(["b", "a"]);
		setLayout(["a"], [0]);
		await view.render(["a"]);
		const ghost = view.container.querySelector<HTMLElement>(`.${TAB_MOTION_GHOST_CLASS}`);
		expect(ghost).not.toBeNull();
		const running = animations.filter((animation) => !animation.cancelled);
		expect(running.length).toBeGreaterThan(0);
		document.documentElement.dataset.motion = "reduced";
		await act(async () => {
			await Promise.resolve();
		});
		expect(view.container.querySelector(`.${TAB_MOTION_GHOST_CLASS}`)).toBeNull();
		expect(animations.every((animation) => animation.cancelled)).toBe(true);
	});

	it("does not animate the initial strip and ignores same-geometry content updates", async () => {
		setLayout(["a"], [0]);
		const view = await mount(["a"]);
		expect(animations).toHaveLength(0);
		await view.render(["a"]);
		expect(animations).toHaveLength(0);
		expect(view.container.querySelector(`.${TAB_MOTION_GHOST_CLASS}`)).toBeNull();
	});

	it("does not read rectangles or interrupt an active animation for same-key streaming updates", async () => {
		setLayout(["a", "b"], [0, 100]);
		setLayout(["b"], [0]);
		const view = await mount(["a", "b"]);
		await view.render(["b"]);
		const running = [...animations];
		expect(running.length).toBeGreaterThan(0);
		const rectangles = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
		rectangles.mockClear();

		for (const content of [" first", " streamed", " completed"]) {
			await view.render(["b"], { content });
		}
		expect(view.container.querySelector('[role="tab"]')?.textContent).toContain("completed");
		expect(rectangles).not.toHaveBeenCalled();
		expect(animations).toEqual(running);
		expect(running.every((animation) => !animation.cancelled)).toBe(true);
		expect(view.container.querySelector(".tool-tabs-scroll")?.getAttribute("data-tab-motion-animating")).toBe("true");
	});

	it("still clears running effects without a snapshot when animations become unsupported", async () => {
		setLayout(["a", "b"], [0, 100]);
		setLayout(["b"], [0]);
		const view = await mount(["a", "b"]);
		await view.render(["b"]);
		expect(animations.length).toBeGreaterThan(0);
		Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: undefined });
		const rectangles = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
		rectangles.mockClear();

		await view.render(["b"], { content: " updated" });
		expect(rectangles).not.toHaveBeenCalled();
		expect(animations.every((animation) => animation.cancelled)).toBe(true);
		expect(view.container.querySelector(`.${TAB_MOTION_GHOST_CLASS}`)).toBeNull();
		expect(view.container.querySelector(".tool-tabs-scroll")?.hasAttribute("data-tab-motion-animating")).toBe(false);
	});
});
