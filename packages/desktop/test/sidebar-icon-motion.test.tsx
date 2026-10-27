// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnimatedNavIcon } from "../src/renderer/components/AnimatedNavIcon.tsx";
import { SidebarModeIcon } from "../src/renderer/components/SidebarModeIcon.tsx";
import { AddSquare, AlarmClock, ChatDots, Customize, Programming } from "../src/renderer/icons.tsx";

interface Effect {
	readonly target: Element;
	readonly frames: Keyframe[];
	readonly options: KeyframeAnimationOptions;
	readonly animation: Animation;
	finish(): void;
}

let effects: Effect[];
let roots: Set<Root>;
let styles: Map<Element, { transform: string; opacity: string }>;
let mediaReduced: boolean;
let mediaListeners: Set<() => void>;
let originalAnimate: PropertyDescriptor | undefined;

beforeEach(() => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	effects = [];
	roots = new Set();
	styles = new Map();
	mediaReduced = false;
	mediaListeners = new Set();
	document.documentElement.dataset.motion = "full";
	vi.stubGlobal("matchMedia", () => ({
		get matches() {
			return mediaReduced;
		},
		addEventListener: (_type: string, listener: () => void) => mediaListeners.add(listener),
		removeEventListener: (_type: string, listener: () => void) => mediaListeners.delete(listener),
	}));
	originalAnimate = Object.getOwnPropertyDescriptor(Element.prototype, "animate");
	Object.defineProperty(Element.prototype, "animate", {
		configurable: true,
		writable: true,
		value(this: Element, frames: Keyframe[], options: KeyframeAnimationOptions) {
			let resolve!: () => void;
			let reject!: () => void;
			const finished = new Promise<void>((done, fail) => {
				resolve = done;
				reject = fail;
			});
			const animation = { finished, cancel: vi.fn(() => reject()) } as unknown as Animation;
			effects.push({
				target: this,
				frames,
				options,
				animation,
				finish: () => {
					const last = frames.at(-1);
					styles.set(this, { transform: String(last?.transform ?? "none"), opacity: String(last?.opacity ?? 1) });
					resolve();
				},
			});
			return animation;
		},
	});
	const computed = getComputedStyle;
	vi.spyOn(globalThis, "getComputedStyle").mockImplementation((element) =>
		styles.has(element) ? (styles.get(element) as CSSStyleDeclaration) : computed(element),
	);
});

afterEach(async () => {
	await act(async () => {
		for (const root of roots) root.unmount();
	});
	document.body.replaceChildren();
	delete document.documentElement.dataset.motion;
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	if (originalAnimate) Object.defineProperty(Element.prototype, "animate", originalAnimate);
	else Reflect.deleteProperty(Element.prototype, "animate");
});

async function mount(content: ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.add(root);
	const render = async (next: ReactNode) => act(async () => root.render(next));
	await render(content);
	return { container, render, root };
}

function control(content: ReactNode, sidebar = true, disabled = false) {
	return (
		<div className={sidebar ? "session-sidebar" : "settings-page"}>
			<button disabled={disabled} type="button">
				{content}
			</button>
		</div>
	);
}

async function pointer(button: HTMLButtonElement, type: "pointerenter" | "pointerleave") {
	await act(async () => button.dispatchEvent(new MouseEvent(type)));
}

async function flush() {
	await act(async () => {
		await Promise.resolve();
	});
}

describe("Sidebar semantic icon motion", () => {
	it("uses the approved official glyphs", async () => {
		const pairs = [
			[() => <AnimatedNavIcon kind="task" />, () => <AddSquare />],
			[() => <AnimatedNavIcon kind="customize" />, () => <Customize />],
			[() => <AnimatedNavIcon kind="schedule" />, () => <AlarmClock />],
			[() => <SidebarModeIcon kind="chat" />, () => <ChatDots />],
			[() => <SidebarModeIcon kind="code" />, () => <Programming />],
		];
		const view = await mount(null);
		for (const [decorated, official] of pairs) {
			await view.render(decorated!());
			const svg = view.container.querySelector("svg")!;
			const artwork = svg.innerHTML;
			expect(svg.getAttribute("aria-hidden")).toBe("true");
			expect(svg.getAttribute("focusable")).toBe("false");
			await view.render(official!());
			expect(view.container.querySelector("svg")?.innerHTML).toBe(artwork);
		}
		await view.render(<SidebarModeIcon kind="chat" />);
		expect(view.container.querySelector("svg")?.getAttribute("width")).toBe("15");
	});

	it("holds separate official parts while engaged and recovers once on leave", async () => {
		const cases: [() => ReactNode, number[]][] = [
			[() => <AnimatedNavIcon kind="task" />, [1, 2]],
			[() => <AnimatedNavIcon kind="customize" />, [1, 2, 3, 4]],
			[() => <AnimatedNavIcon kind="schedule" />, [1, 2, 3]],
			[() => <SidebarModeIcon kind="chat" />, [2, 3, 4]],
			[() => <SidebarModeIcon kind="code" />, [1, 2, 3]],
		];
		for (const [icon, parts] of cases) {
			const view = await mount(control(icon()));
			const button = view.container.querySelector("button")!;
			const svg = button.querySelector("svg")!;
			const paths = [...svg.querySelectorAll("path")];
			const artwork = svg.innerHTML;
			const before = effects.length;
			await pointer(button, "pointerenter");
			const started = effects.slice(before);
			expect(started.map((effect) => paths.indexOf(effect.target as SVGPathElement) + 1)).toEqual(parts);
			expect(started.every((effect) => effect.target !== svg)).toBe(true);
			expect(started.every((effect) => Number(effect.options.duration) <= 340)).toBe(true);
			expect(started.every((effect) => effect.options.fill === "both")).toBe(true);
			expect(
				started.every((effect) => effect.options.iterations === undefined || effect.options.iterations === 1),
			).toBe(true);
			expect(svg.innerHTML).toBe(artwork);
			for (const effect of started) effect.finish();
			await flush();
			await pointer(button, "pointerenter");
			expect(effects).toHaveLength(before + started.length);
			expect(started.every((effect) => vi.mocked(effect.animation.cancel).mock.calls.length === 0)).toBe(true);
			await pointer(button, "pointerleave");
			for (const effect of started) expect(effect.animation.cancel).toHaveBeenCalledOnce();
			const recovery = effects.slice(before + started.length);
			expect(recovery).toHaveLength(started.length);
			for (const effect of recovery) {
				expect(effect.options.duration).toBe(180);
				expect(effect.frames.at(-1)).toEqual({ transform: "none", opacity: 1 });
			}
		}
	});

	it("reattaches folder motion only to the current layer through rapid expansion changes", async () => {
		const view = await mount(control(<AnimatedNavIcon kind="folder" />));
		for (const expanded of [false, true, false, true]) {
			await view.render(control(<AnimatedNavIcon expanded={expanded} kind="folder" />));
			const before = effects.length;
			await pointer(view.container.querySelector("button")!, "pointerenter");
			const started = effects.slice(before);
			expect(started.length).toBeGreaterThan(0);
			for (const effect of started)
				expect(effect.target.closest("svg")?.getAttribute("data-folder-state")).toBe(expanded ? "open" : "closed");
			for (const effect of effects.slice(0, before)) expect(effect.animation.cancel).toHaveBeenCalledOnce();
		}
	});

	it("leaves icons outside the sidebar and disabled sidebar buttons static", async () => {
		const view = await mount(
			<>
				{control(<AnimatedNavIcon kind="schedule" />, false)}
				{control(<SidebarModeIcon kind="chat" />, true, true)}
			</>,
		);
		for (const button of view.container.querySelectorAll("button")) {
			await pointer(button, "pointerenter");
			await act(async () => button.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
		}
		expect(effects).toHaveLength(0);
	});

	it("recovers from the current frame on quick leave and retargets a rapid return", async () => {
		const view = await mount(control(<AnimatedNavIcon kind="task" />));
		const button = view.container.querySelector("button")!;
		await pointer(button, "pointerenter");
		const started = [...effects];
		for (const effect of started)
			styles.set(effect.target, { transform: "matrix(.9, 0, 0, .9, 0, 0)", opacity: ".8" });
		await pointer(button, "pointerleave");
		const recovery = effects.slice(started.length);
		expect(recovery).toHaveLength(2);
		for (const effect of started) expect(effect.animation.cancel).toHaveBeenCalledOnce();
		for (const effect of recovery) {
			expect(effect.options.duration).toBe(180);
			expect(effect.frames[0]).toEqual({ transform: "matrix(.9, 0, 0, .9, 0, 0)", opacity: ".8" });
			expect(effect.frames.at(-1)).toEqual({ transform: "none", opacity: 1 });
		}
		await pointer(button, "pointerenter");
		for (const effect of recovery) expect(effect.animation.cancel).toHaveBeenCalledOnce();
		expect(effects.at(-1)?.frames[0]).toEqual(recovery[0]?.frames[0]);
	});

	it("uses focus-visible and avoids replay when pointer and keyboard focus overlap", async () => {
		const view = await mount(control(<SidebarModeIcon kind="chat" />));
		const button = view.container.querySelector("button")!;
		let visible = false;
		const matches = button.matches.bind(button);
		vi.spyOn(button, "matches").mockImplementation((selector) =>
			selector === ":focus-visible" ? visible : matches(selector),
		);
		await act(async () => button.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
		expect(effects).toHaveLength(0);
		visible = true;
		await act(async () => button.dispatchEvent(new FocusEvent("focusin", { bubbles: true })));
		expect(effects).toHaveLength(3);
		for (const effect of effects) effect.finish();
		await flush();
		await pointer(button, "pointerenter");
		await pointer(button, "pointerleave");
		expect(effects).toHaveLength(3);
		expect(effects.every((effect) => vi.mocked(effect.animation.cancel).mock.calls.length === 0)).toBe(true);
		await act(async () =>
			button.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: document.body })),
		);
		for (const effect of effects.slice(0, 3)) expect(effect.animation.cancel).toHaveBeenCalledOnce();
		const recovery = effects.slice(3);
		expect(recovery).toHaveLength(3);
		for (const effect of recovery) expect(effect.frames.at(-1)).toEqual({ transform: "none", opacity: 1 });
	});

	it("cancels immediately for disabled, app-reduced and OS-reduced changes", async () => {
		const view = await mount(control(<SidebarModeIcon kind="code" />));
		const button = view.container.querySelector("button")!;
		for (const disable of [
			() => {
				button.disabled = true;
			},
			() => button.setAttribute("aria-disabled", "true"),
			() => {
				document.documentElement.dataset.motion = "reduced";
			},
			() => {
				mediaReduced = true;
				for (const listener of mediaListeners) listener();
			},
		]) {
			button.disabled = false;
			button.removeAttribute("aria-disabled");
			document.documentElement.dataset.motion = "full";
			mediaReduced = false;
			await pointer(button, "pointerleave");
			await pointer(button, "pointerenter");
			const started = effects.slice(-3);
			expect(started).toHaveLength(3);
			for (const effect of started) effect.finish();
			await flush();
			disable();
			await flush();
			for (const effect of started) expect(effect.animation.cancel).toHaveBeenCalledOnce();
			const count = effects.length;
			await pointer(button, "pointerenter");
			expect(effects).toHaveLength(count);
		}
	});

	it("removes listeners and cancels outstanding parts on unmount", async () => {
		const view = await mount(control(<AnimatedNavIcon kind="schedule" />));
		const button = view.container.querySelector("button")!;
		await pointer(button, "pointerenter");
		expect(mediaListeners.size).toBe(1);
		for (const effect of effects) effect.finish();
		await flush();
		await act(async () => view.root.unmount());
		roots.delete(view.root);
		expect(mediaListeners.size).toBe(0);
		for (const effect of effects) expect(effect.animation.cancel).toHaveBeenCalledOnce();
		await pointer(button, "pointerenter");
		expect(effects).toHaveLength(3);
	});

	it("scopes SVG-part geometry and reduced-motion resets without generic rocking", () => {
		const css = readFileSync(path.join(process.cwd(), "src/renderer/styles/sidebar-icon-motion.css"), "utf8");
		const appCss = readFileSync(path.join(process.cwd(), "src/renderer/styles/app.css"), "utf8");
		expect(css).toContain(".session-sidebar .sidebar-semantic-icon > path");
		expect(css).toContain(':root[data-motion="reduced"] .session-sidebar');
		expect(css).toContain("@media (prefers-reduced-motion: reduce)");
		expect(css).toContain("transform: none !important");
		expect(css).toContain("transform-origin: 12px 12.5px");
		expect(appCss).not.toContain("nav-icon-folder");
	});
});
