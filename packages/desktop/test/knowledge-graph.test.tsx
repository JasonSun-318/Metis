// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "../src/renderer/components/AppErrorBoundary.tsx";
import { KnowledgeGraph } from "../src/renderer/components/KnowledgeGraph.tsx";
import type { KnowledgeGraphData } from "../src/renderer/components/knowledge-graph-layout.ts";
import { setLocale } from "../src/renderer/i18n.ts";

let root: Root;
let host: HTMLDivElement;
let width: number;
let height: number;
let time: number;
let nextFrame: number;
let resize: () => void;
const frames = new Map<number, FrameRequestCallback>();
const onOpen = vi.fn();
const graph: KnowledgeGraphData = {
	notes: ["Home", "Note"].map((title) => ({ path: `${title}.md`, title, links: [] })),
	edges: [{ source: "Home.md", target: "Note.md" }],
	warnings: [],
};

beforeEach(async () => {
	(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
	await setLocale("en");
	width = 360;
	height = 600;
	time = 0;
	nextFrame = 1;
	frames.clear();
	onOpen.mockReset();
	vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
		const id = nextFrame++;
		frames.set(id, callback);
		return id;
	});
	vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
	vi.stubGlobal(
		"ResizeObserver",
		class {
			constructor(callback: () => void) {
				resize = callback;
			}
			observe() {}
			disconnect() {}
		},
	);
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, width, height));
	vi.spyOn(SVGElement.prototype, "getBoundingClientRect").mockImplementation(() => new DOMRect(0, 0, width, height));
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	host.remove();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

function pointer(target: Element, type: string, x: number, y: number) {
	const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
	Object.defineProperty(event, "pointerId", { value: 1 });
	target.dispatchEvent(event);
}

function view(canvas: SVGSVGElement) {
	const transform = canvas.querySelector(".knowledge-graph-viewport")!.getAttribute("transform")!;
	const [x, y, zoom] = transform.match(/-?[\d.]+(?:e[+-]?\d+)?/g)!.map(Number);
	return { x: x!, y: y!, zoom: zoom! };
}

function position(node: Element) {
	const [x, y] = node
		.getAttribute("transform")!
		.match(/-?[\d.]+(?:e[+-]?\d+)?/g)!
		.map(Number);
	return { x: x!, y: y! };
}

async function advance(count: number) {
	await act(async () => {
		for (let i = 0; i < count; i++) {
			time += 17;
			const scheduled = [...frames.values()];
			frames.clear();
			for (const callback of scheduled) callback(time);
		}
	});
}

async function mount(strict = false, active = true, data = graph) {
	await act(async () => {
		const content = (
			<AppErrorBoundary>
				<KnowledgeGraph graph={data} onOpen={onOpen} active={active} />
			</AppErrorBoundary>
		);
		root.render(strict ? <StrictMode>{content}</StrictMode> : content);
	});
	return host.querySelector<SVGSVGElement>("svg.knowledge-graph-canvas")!;
}

describe.each([true, false])("Knowledge graph drag lifecycle (StrictMode: %s)", (strict) => {
	it.each(["pointerup", "pointercancel", "lostpointercapture"])(
		"ends batched moves after %s without crashing",
		async (end) => {
			const errors = vi.spyOn(console, "error").mockImplementation(() => {});
			const canvas = await mount(strict);
			const before = view(canvas);
			await act(async () => {
				pointer(canvas, "pointerdown", 10, 20);
				pointer(canvas, "pointermove", 20, 35);
				pointer(canvas, "pointermove", 45, 70);
				pointer(canvas, end, 45, 70);
				pointer(canvas, "pointermove", 100, 100);
			});
			expect(errors).not.toHaveBeenCalled();
			expect(host.querySelector('[role="alert"]')).toBeNull();
			expect(host.querySelector(".knowledge-graph-canvas")).toBe(canvas);
			expect(view(canvas)).toEqual({ x: before.x + 35, y: before.y + 50, zoom: before.zoom });
		},
	);

	it("preserves wheel zoom and button controls during a batched drag", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const canvas = await mount(strict);
		const initial = view(canvas);
		const wheel = new WheelEvent("wheel", {
			bubbles: true,
			cancelable: true,
			deltaY: 100,
			clientX: 100,
			clientY: 200,
		});
		await act(async () => {
			pointer(canvas, "pointerdown", 10, 20);
			pointer(canvas, "pointermove", 45, 70);
			canvas.dispatchEvent(wheel);
			pointer(canvas, "pointermove", 55, 85);
			pointer(canvas, "pointerup", 55, 85);
		});
		expect(errors).not.toHaveBeenCalled();
		expect(wheel.defaultPrevented).toBe(true);
		expect(view(canvas).zoom).toBeCloseTo(initial.zoom * Math.exp(-0.2));
		await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
		expect(view(canvas).zoom).toBeCloseTo(initial.zoom * Math.exp(-0.2) * 1.25);
		await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Reset view"]')!.click());
		expect(view(canvas)).toEqual(initial);
	});
});

it("drags a node, moves its linked neighbor, and suppresses opening on release", async () => {
	const canvas = await mount();
	await advance(180);
	const node = canvas.querySelector('[data-knowledge-path="Home.md"]')!;
	const neighbor = canvas.querySelector('[data-knowledge-path="Note.md"]')!;
	const start = position(node);
	const other = position(neighbor);
	const camera = view(canvas);
	const screen = { x: start.x * camera.zoom + camera.x, y: start.y * camera.zoom + camera.y };
	await act(async () => {
		pointer(node, "pointerdown", screen.x, screen.y);
		pointer(node, "pointermove", screen.x + 140, screen.y + 50);
	});
	expect(position(node).x).toBeCloseTo(start.x + 140 / camera.zoom);
	await advance(20);
	expect(position(neighbor).x - other.x).toBeGreaterThan(10);
	await act(async () => {
		pointer(node, "pointerup", screen.x + 140, screen.y + 50);
		node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	expect(onOpen).not.toHaveBeenCalled();
	await act(async () => node.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })));
	expect(onOpen).toHaveBeenCalledWith("Home.md");
});

it("opens a node on a click without movement", async () => {
	const canvas = await mount();
	const node = canvas.querySelector('[data-knowledge-path="Home.md"]')!;
	await act(async () => {
		pointer(node, "pointerdown", 180, 300);
		pointer(node, "pointerup", 180, 300);
		node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	expect(onOpen).toHaveBeenCalledExactlyOnceWith("Home.md");
});

it("uses the actual rectangular viewport and recenters it on resize", async () => {
	const canvas = await mount();
	expect(canvas.getAttribute("viewBox")).toBe("0 0 360 600");
	await act(async () => {
		pointer(canvas, "pointerdown", 0, 0);
		pointer(canvas, "pointermove", 35, 40);
		pointer(canvas, "pointerup", 35, 40);
	});
	const before = view(canvas);
	width = 800;
	height = 280;
	await act(async () => resize());
	expect(canvas.getAttribute("viewBox")).toBe("0 0 800 280");
	expect(view(canvas)).toEqual({ ...before, x: before.x + 220, y: before.y - 160 });
});

it("keeps positions on refresh, stops when settled, and pauses the hidden sidebar", async () => {
	const canvas = await mount();
	await advance(200);
	expect(frames.size).toBe(0);
	const before = canvas.querySelector('[data-knowledge-path="Home.md"]')!.getAttribute("transform");
	await mount(false, true, structuredClone(graph));
	expect(canvas.querySelector('[data-knowledge-path="Home.md"]')!.getAttribute("transform")).toBe(before);
	expect(frames.size).toBe(0);
	const node = canvas.querySelector('[data-knowledge-path="Home.md"]')!;
	await act(async () => pointer(node, "pointerdown", 180, 300));
	expect(frames.size).toBe(1);
	await mount(false, false);
	expect(frames.size).toBe(0);
});
