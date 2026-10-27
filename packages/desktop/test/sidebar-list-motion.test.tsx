// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SidebarListMotion } from "../src/renderer/components/SidebarListMotion.tsx";

interface MockAnimation {
	cancelled: boolean;
	keyframes: unknown[];
	options: unknown;
	oncancel: (() => void) | null;
	cancel(): void;
	finished: Promise<void>;
}

function rect(left: number, top: number, width = 10, height = 10): DOMRect {
	return {
		left,
		top,
		right: left + width,
		bottom: top + height,
		width,
		height,
		x: left,
		y: top,
		toJSON: () => ({}),
	} as DOMRect;
}

const positions = new Map<string, DOMRect>();
/** Live first-keyframe translations applied by the animate mock, like WAAPI. */
const activeTransforms = new Map<Element, { dx: number; dy: number }>();
const animations: MockAnimation[] = [];
const focusCalls: { options?: FocusOptions }[] = [];

const originalGetBoundingClientRect = Element.prototype.getBoundingClientRect;
const originalFocus = HTMLElement.prototype.focus;
const originalAnimate = Element.prototype.animate;

type TrackedElement = HTMLElement & { __oldRect?: DOMRect; __fresh?: boolean };

function layoutRect(this: TrackedElement): DOMRect {
	const key = this.getAttribute?.("data-sidebar-motion-key");
	if (key === null || key === undefined) return this.__oldRect ?? rect(0, 0);
	return (this.__fresh ? this.__oldRect : (positions.get(key) ?? this.__oldRect)) ?? rect(0, 0);
}

/**
 * Two-phase geometry mock: the first read of an element during a commit returns
 * its pre-commit position (getSnapshotBeforeUpdate), later reads return the
 * live map (componentDidUpdate finals).
 */
beforeEach(() => {
	animations.length = 0;
	positions.clear();
	focusCalls.length = 0;
	Object.defineProperty(HTMLElement.prototype, "offsetLeft", {
		configurable: true,
		get(this: TrackedElement) {
			return layoutRect.call(this).left;
		},
	});
	Object.defineProperty(HTMLElement.prototype, "offsetTop", {
		configurable: true,
		get(this: TrackedElement) {
			return layoutRect.call(this).top;
		},
	});
	Object.defineProperty(HTMLElement.prototype, "offsetWidth", {
		configurable: true,
		get(this: TrackedElement) {
			return layoutRect.call(this).width;
		},
	});
	Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
		configurable: true,
		get(this: TrackedElement) {
			return layoutRect.call(this).height;
		},
	});
	Element.prototype.getBoundingClientRect = function getBoundingClientRect(this: TrackedElement) {
		const key = this.getAttribute?.("data-sidebar-motion-key");
		let base: DOMRect;
		if (key === null || key === undefined) base = rect(0, 0);
		else if (this.__fresh) {
			this.__fresh = false;
			base = this.__oldRect ?? rect(0, 0);
		} else base = positions.get(key) ?? this.__oldRect ?? rect(0, 0);
		// In-flight ancestor/self transforms shift the reported visual position.
		let dx = 0;
		let dy = 0;
		for (let node: Element | null = this; node; node = node.parentElement) {
			const active = activeTransforms.get(node);
			if (active) {
				dx += active.dx;
				dy += active.dy;
			}
		}
		return dx === 0 && dy === 0 ? base : rect(base.left + dx, base.top + dy);
	};
	const animateMock = function animate(this: Element, keyframes: unknown[], options: unknown) {
		const animation: MockAnimation = {
			cancelled: false,
			keyframes,
			options,
			oncancel: null,
			cancel() {
				this.cancelled = true;
				activeTransforms.delete(holder.target);
				this.oncancel?.();
			},
			// Stays pending like a real in-flight animation; tests settle manually.
			finished: new Promise<void>(() => undefined),
		};
		const first = (keyframes as { transform?: string }[])[0]?.transform ?? "";
		const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(first);
		const holder: { target: Element } = { target: this };
		if (match) activeTransforms.set(this, { dx: Number(match[1]), dy: Number(match[2]) });
		animations.push(animation);
		return animation as unknown as Animation;
	} as unknown as typeof Element.prototype.animate;
	Element.prototype.animate = animateMock;
	HTMLElement.prototype.focus = function focus(this: HTMLElement, options?: FocusOptions) {
		focusCalls.push({ options });
		originalFocus.call(this, options);
	};
	if (typeof window.matchMedia !== "function") {
		const mediaMock = (query: string): MediaQueryList =>
			({
				matches: false,
				media: query,
				addEventListener: () => undefined,
				removeEventListener: () => undefined,
			}) as unknown as MediaQueryList;
		window.matchMedia = mediaMock as unknown as typeof window.matchMedia;
	}
});

afterEach(async () => {
	for (const root of roots.splice(0)) await act(async () => root.unmount());
	for (const container of containers.splice(0)) container.remove();
	scroller?.remove();
	delete (document.documentElement as HTMLElement).dataset.motion;
	Element.prototype.getBoundingClientRect = originalGetBoundingClientRect;
	Element.prototype.animate = originalAnimate;
	for (const property of ["offsetLeft", "offsetTop", "offsetWidth", "offsetHeight"]) {
		Reflect.deleteProperty(HTMLElement.prototype, property);
	}
	HTMLElement.prototype.focus = originalFocus;
	animations.length = 0;
	positions.clear();
	activeTransforms.clear();
});

const roots: Root[] = [];
const containers: HTMLElement[] = [];
let scroller: HTMLElement | null = null;

function markCommit(): void {
	for (const element of document.querySelectorAll<TrackedElement>("[data-sidebar-motion-key]")) {
		const key = element.getAttribute("data-sidebar-motion-key") ?? "";
		element.__oldRect = positions.get(key) ?? element.__oldRect ?? rect(0, 0);
		element.__fresh = true;
	}
}

function item(key: string, exit = false) {
	return (
		<div data-sidebar-motion-key={key} data-sidebar-motion-exit={exit ? "true" : undefined} key={key}>
			<button type="button">primary</button>
			<button className="secondary" type="button">
				secondary
			</button>
		</div>
	);
}

const SCOPE = "chat:none:tasks:open";

async function mount(children: React.ReactNode) {
	scroller = document.createElement("nav");
	scroller.className = "project-list";
	const container = document.createElement("div");
	scroller.append(container);
	document.body.append(scroller);
	containers.push(container);
	const root = createRoot(container);
	roots.push(root);
	const rerender = async (
		next: React.ReactNode,
		nextPositions?: Map<string, DOMRect>,
		scope: string = SCOPE,
		snapshotOverrides?: Map<string, DOMRect>,
	) => {
		markCommit();
		if (snapshotOverrides) {
			for (const [key, value] of snapshotOverrides) {
				const el = document.querySelector(`[data-sidebar-motion-key="${key}"]`) as TrackedElement | null;
				if (el) el.__oldRect = value;
			}
		}
		if (nextPositions) for (const [key, value] of nextPositions) positions.set(key, value);
		await act(async () => {
			root.render(<SidebarListMotion scope={scope}>{next}</SidebarListMotion>);
		});
	};
	await rerender(children);
	return rerender;
}

function motionRoot(): HTMLElement {
	return document.querySelector(".sidebar-list-motion") as HTMLElement;
}

function firstTransforms(): string[] {
	return animations.map((animation) => (animation.keyframes as { transform: string }[])[0]?.transform ?? "");
}

describe("SidebarListMotion", () => {
	it("translates moved items with a 230ms ease and flags data-animating", async () => {
		const rerender = await mount([item("session:a"), item("session:b")]);
		await rerender(
			[item("session:a"), item("session:b")],
			new Map([
				["session:a", rect(0, 100)],
				["session:b", rect(0, 0)],
			]),
		);
		const transforms = firstTransforms();
		expect(transforms).toEqual(["translate(0px, -100px)"]);
		expect(animations[0].options).toEqual({ duration: 230, easing: "cubic-bezier(.22,.8,.24,1)" });
		expect(animations[0].keyframes.at(-1)).toEqual({ transform: "translate(0px, 0px)" });
		expect(motionRoot().getAttribute("data-animating")).toBe("true");
	});

	it("moves the project wrapper as a unit without double-animating inner sessions", async () => {
		const tree = (projectKey: string) => (
			<div data-sidebar-motion-key={projectKey} key={projectKey}>
				{item("session:s1")}
				{item("session:s2")}
			</div>
		);
		const rerender = await mount(tree("project:chat:/a"));
		await rerender(
			tree("project:chat:/b"),
			new Map([
				["project:chat:/b", rect(0, 100)],
				["session:s1", rect(0, 110)],
				["session:s2", rect(0, 150)],
			]),
		);
		// New wrapper has no before-position, so only the sessions slide from their
		// old visual spots; the wrapper itself never animates.
		expect(firstTransforms()).toEqual(["translate(0px, -110px)", "translate(0px, -150px)"]);
	});

	it("subtracts the nearest animated ancestor's displacement", async () => {
		const tree = (swapped: boolean) => (
			<div data-sidebar-motion-key="project:chat:/a" key="p">
				{item(swapped ? "session:b" : "session:a")}
				{item(swapped ? "session:a" : "session:b")}
			</div>
		);
		const rerender = await mount(tree(false));
		await rerender(
			tree(true),
			new Map([
				["project:chat:/a", rect(0, 100)],
				["session:a", rect(0, 150)],
				["session:b", rect(0, 110)],
			]),
		);
		const transforms = firstTransforms();
		expect(transforms).toContain("translate(0px, -100px)"); // project block
		// Each session moved 150/110 total; minus the parent's 100 → local slides.
		expect(transforms).toContain("translate(0px, -50px)");
		expect(transforms).toContain("translate(0px, -10px)");
	});

	it("starts interrupted motion from the current mid-flight visual position", async () => {
		const rerender = await mount([item("session:a")]);
		await rerender([item("session:a")], new Map([["session:a", rect(0, 100)]]));
		expect(animations).toHaveLength(1);
		// The first animation still holds translate(0, -100) over layout 100;
		// the visual mid-flight position is 60, the next layout slot is 200.
		await rerender(
			[item("session:a")],
			new Map([["session:a", rect(0, 200)]]),
			SCOPE,
			new Map([["session:a", rect(0, 160)]]),
		);
		expect(firstTransforms()[1]).toBe("translate(0px, -140px)");
	});

	it("does not animate no-op geometry", async () => {
		const rerender = await mount([item("session:a")]);
		await rerender([item("session:a")], new Map([["session:a", rect(0, 0)]]));
		expect(animations).toHaveLength(0);
		expect(motionRoot().hasAttribute("data-animating")).toBe(false);
	});

	it("restores focus inside a remounted matching item with preventScroll", async () => {
		const tree = (parentKey: string) => (
			<div data-sidebar-motion-key={parentKey} key={parentKey}>
				{item("session:a")}
			</div>
		);
		const rerender = await mount(tree("group:pinned"));
		const secondary = document.querySelector<HTMLButtonElement>(".secondary");
		secondary?.focus();
		expect(document.activeElement).toBe(secondary);
		await rerender(tree("group:date"));
		const nextSecondary = motionRoot().querySelector<HTMLButtonElement>(".secondary");
		expect(nextSecondary).not.toBe(secondary);
		expect(document.activeElement).toBe(nextSecondary);
		expect(focusCalls.at(-1)?.options).toEqual({ preventScroll: true });
	});

	it("keeps the commit-time scrollTop clamped to the new range", async () => {
		const rerender = await mount([item("session:a")]);
		const list = scroller as HTMLElement;
		Object.defineProperty(list, "scrollHeight", { configurable: true, get: () => 100 });
		Object.defineProperty(list, "clientHeight", { configurable: true, get: () => 120 });
		list.scrollTop = 80;
		await rerender([item("session:a")], new Map([["session:a", rect(0, 10)]]));
		expect(list.scrollTop).toBe(0);
	});

	it.each(["inert", "aria-hidden"])(
		"focuses the destination section heading when a moved row is %s",
		async (hidden) => {
			const sections = (moved: boolean) => [
				<section className="session-section" data-sidebar-motion-key="section:running" key="running">
					<button className="session-section-heading" type="button">
						Running
					</button>
					<div>{!moved && item("session:moving")}</div>
				</section>,
				<section
					className="session-section"
					data-open="false"
					data-sidebar-motion-key="section:completed"
					key="completed"
				>
					<button aria-expanded="false" className="session-section-heading" type="button">
						Completed
					</button>
					<div inert={hidden === "inert"} aria-hidden={hidden === "aria-hidden" ? true : undefined}>
						{moved && item("session:moving")}
					</div>
				</section>,
			];
			const rerender = await mount(sections(false));
			motionRoot().querySelector<HTMLButtonElement>(".secondary")!.focus();
			await rerender(sections(true));
			const destination = motionRoot().querySelector<HTMLElement>('[data-sidebar-motion-key="section:completed"]')!;
			expect(document.activeElement).toBe(destination.querySelector(".session-section-heading"));
			expect(destination.querySelector(".session-section-heading")?.getAttribute("aria-expanded")).toBe("false");
			expect(destination.dataset.open).toBe("false");
			expect(focusCalls.at(-1)?.options).toEqual({ preventScroll: true });
		},
	);

	it("skips animation for resolved reduced motion and honours data-motion=full", async () => {
		(document.documentElement as HTMLElement).dataset.motion = "reduced";
		const rerender = await mount([item("session:a")]);
		await rerender([item("session:a")], new Map([["session:a", rect(0, 100)]]));
		expect(animations).toHaveLength(0);
		(document.documentElement as HTMLElement).dataset.motion = "full";
		await rerender([item("session:a")], new Map([["session:a", rect(0, 0)]]));
		expect(animations).toHaveLength(1);
	});

	it("leaves only an inert header remnant when an exit-marked header disappears", async () => {
		const rerender = await mount([item("section:header", true), item("session:a")]);
		await rerender([item("session:a")], new Map([["session:a", rect(0, 0)]]));
		const remnant = motionRoot().querySelector<HTMLElement>('[aria-hidden="true"]');
		expect(remnant).not.toBeNull();
		expect(remnant?.hasAttribute("inert")).toBe(true);
		expect(remnant?.style.pointerEvents).toBe("none");
		expect(remnant?.getAttribute("data-sidebar-motion-key")).toBeNull();
		expect(remnant?.querySelectorAll("[data-sidebar-motion-key]")).toHaveLength(0);
		// Live session rows are never duplicated.
		expect(motionRoot().querySelectorAll('[data-sidebar-motion-key="session:a"]')).toHaveLength(1);
	});

	it("skips animation on scope change and cancels effects on unmount", async () => {
		const rerender = await mount([item("session:a")]);
		await rerender([item("session:a")], new Map([["session:a", rect(0, 100)]]), "code:none:tasks:open");
		expect(animations).toHaveLength(0);
		await rerender([item("session:a")], new Map([["session:a", rect(0, 0)]]), "code:none:tasks:open");
		expect(animations).toHaveLength(1);
		expect(animations[0].cancelled).toBe(false);
		await act(async () => {
			roots[0]?.unmount();
		});
		expect(animations[0].cancelled).toBe(true);
		expect(document.querySelectorAll(".sidebar-list-motion")).toHaveLength(0);
	});

	it("batch-reads final rects before applying parent transforms", async () => {
		const tree = () => (
			<div data-sidebar-motion-key="project:p" key="p">
				<div data-sidebar-motion-key="session:c" key="c" />
			</div>
		);
		const rerender = await mount(tree());
		await rerender(
			tree(),
			new Map([
				["project:p", rect(0, 100)],
				["session:c", rect(0, 110)],
			]),
		);
		const transforms = firstTransforms();
		// The parent's translate is applied before the child is measured in a
		// naive implementation; the batch read must prevent the +90 double count.
		expect(transforms).toContain("translate(0px, -100px)");
		expect(transforms).toContain("translate(0px, -10px)");
		expect(transforms).not.toContain("translate(0px, 90px)");
	});

	it("creates neither animation nor remnant under reduced motion", async () => {
		(document.documentElement as HTMLElement).dataset.motion = "reduced";
		const rerender = await mount([item("section:header", true), item("session:a")]);
		await rerender([item("session:a")], new Map([["session:a", rect(0, 100)]]));
		expect(animations).toHaveLength(0);
		expect(motionRoot().querySelector('[aria-hidden="true"]')).toBeNull();
	});

	it("handles exit headers whose keys contain quotes and backslashes", async () => {
		const tricky = 'project:chat:/a"b\\c:header';
		const rerender = await mount([item(tricky, true), item("session:a")]);
		await rerender([item("session:a")], new Map([["session:a", rect(0, 0)]]));
		const remnant = motionRoot().querySelector<HTMLElement>('[aria-hidden="true"]');
		expect(remnant).not.toBeNull();
		expect(remnant?.getAttribute("data-sidebar-motion-key")).toBeNull();
	});

	it("fades in a newly appearing header without animating its group", async () => {
		const tree = (withHeader: boolean) => (
			<div data-sidebar-motion-key="project:p" key="p">
				{withHeader && item("project:p:header", true)}
				{item("session:a")}
			</div>
		);
		const rerender = await mount(tree(false));
		await rerender(
			tree(true),
			new Map([
				["project:p", rect(0, 0)],
				["session:a", rect(0, 0)],
			]),
		);
		expect(animations).toHaveLength(1);
		expect((animations[0].keyframes as { opacity?: string }[])[0]).toEqual({ opacity: "0" });
	});

	it("keeps a 230ms header exit running through a content-only update", async () => {
		const rerender = await mount([item("section:header", true), item("session:a")]);
		await rerender([item("session:a")], new Map([["session:a", rect(0, 0)]]));
		const running = animations[0];
		expect(running.cancelled).toBe(false);
		expect(running.options).toMatchObject({ duration: 230 });
		const live = motionRoot().querySelector<HTMLButtonElement>('[data-sidebar-motion-key="session:a"] button');
		expect(live).not.toBeNull();
		await act(async () => {
			if (live) live.textContent = "updated";
		});
		await rerender([item("session:a")], new Map([["session:a", rect(0, 0)]]));
		expect(animations).toHaveLength(1);
		expect(running.cancelled).toBe(false);
		expect(motionRoot().querySelector('[aria-hidden="true"]')).not.toBeNull();
		expect(motionRoot().getAttribute("data-animating")).toBe("true");
	});

	it("retargets a real move from the current visual position after a content update", async () => {
		const rerender = await mount([item("session:a"), item("session:b")]);
		await rerender(
			[item("session:a"), item("session:b")],
			new Map([
				["session:a", rect(0, 100)],
				["session:b", rect(0, 0)],
			]),
		);
		const running = animations[0];
		await rerender(
			[item("session:a"), item("session:b")],
			new Map([
				["session:a", rect(0, 180)],
				["session:b", rect(0, 0)],
			]),
			SCOPE,
			new Map([["session:a", rect(0, 140)]]),
		);
		expect(running.cancelled).toBe(true);
		expect(firstTransforms().at(-1)).toBe("translate(0px, -140px)");
		expect(animations.at(-1)?.options).toMatchObject({ duration: 230 });
	});

	it("animates the first and second inserted children without restarting unchanged rows", async () => {
		const row = (key: string, label: string) => (
			<div data-sidebar-motion-key={key} key={key}>
				<button type="button">{label}</button>
			</div>
		);
		const rerender = await mount(row("session:root", "root"));
		await rerender(
			<div data-sidebar-motion-key="session:root" key="session:root">
				{row("agent:root:first", "first")}
			</div>,
			new Map([
				["session:root", rect(0, 0, 10, 40)],
				["agent:root:first", rect(12, 20)],
			]),
		);
		expect(animations).toHaveLength(0);
		expect(motionRoot().querySelector('[data-sidebar-motion-key="agent:root:first"]')).not.toBeNull();
		await rerender(
			<div data-sidebar-motion-key="session:root" key="session:root">
				{row("agent:root:first", "first")}
				{row("agent:root:second", "second")}
			</div>,
			new Map([
				["session:root", rect(0, 0, 10, 70)],
				["agent:root:first", rect(12, 20)],
				["agent:root:second", rect(12, 44)],
			]),
		);
		expect(animations.map((animation) => animation.cancelled)).not.toContain(true);
		expect(motionRoot().querySelector('[data-sidebar-motion-key="agent:root:second"]')).not.toBeNull();
	});

	it("moves a nested subtree across groups from its current visual position", async () => {
		const tree = (group: string) => (
			<div data-sidebar-motion-key={group} key={group}>
				<div data-sidebar-motion-key="session:root" key="session:root">
					<div data-sidebar-motion-key="agent:root:child" key="agent:root:child">
						<div data-sidebar-motion-key="agent:root:grandchild" key="agent:root:grandchild" />
					</div>
				</div>
			</div>
		);
		const rerender = await mount(tree("section:running"));
		await rerender(
			tree("section:completed"),
			new Map([
				["section:completed", rect(0, 80)],
				["session:root", rect(0, 100)],
				["agent:root:child", rect(12, 130)],
				["agent:root:grandchild", rect(24, 160)],
			]),
		);
		expect(firstTransforms()).toEqual(expect.arrayContaining(["translate(0px, -100px)"]));
		expect(firstTransforms().length).toBeGreaterThan(0);
	});

	it("never steals focus that has moved outside the motion root", async () => {
		const dialog = document.createElement("div");
		const dialogButton = document.createElement("button");
		dialogButton.type = "button";
		dialog.append(dialogButton);
		document.body.append(dialog);
		const tree = (parentKey: string) => (
			<div data-sidebar-motion-key={parentKey} key={parentKey}>
				{item("session:a")}
			</div>
		);
		const rerender = await mount(tree("group:pinned"));
		motionRoot().querySelector<HTMLButtonElement>(".secondary")?.focus();
		dialogButton.focus();
		await rerender(tree("group:date"), new Map([["session:a", rect(0, 40)]]));
		expect(document.activeElement).toBe(dialogButton);
		dialog.remove();
	});
});
