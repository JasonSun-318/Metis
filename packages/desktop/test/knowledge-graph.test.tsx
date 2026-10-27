// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppErrorBoundary } from "../src/renderer/components/AppErrorBoundary.tsx";
import { KnowledgeGraph } from "../src/renderer/components/KnowledgeGraph.tsx";
import type { KnowledgeGraphData } from "../src/renderer/components/knowledge-graph-layout.ts";
import { createGraphSession, type GraphSession } from "../src/renderer/components/knowledge-graph-session.ts";
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
const auxiliaryElements: HTMLElement[] = [];
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
	document.documentElement.dataset.motion = "reduced";
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
	for (const element of auxiliaryElements.splice(0)) element.remove();
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

async function mount(
	strict = false,
	active = true,
	data = graph,
	extra: { query?: string; session?: GraphSession } = {},
) {
	await act(async () => {
		const content = (
			<AppErrorBoundary>
				<KnowledgeGraph graph={data} onOpen={onOpen} active={active} {...extra} />
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
	expect(position(node).x * camera.zoom + camera.x).toBeCloseTo(Math.min(width - 22, screen.x + 140));
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

it("selects on click, opens on double click, and clears selection with Escape", async () => {
	const canvas = await mount();
	const node = canvas.querySelector('[data-knowledge-path="Home.md"]')!;
	await act(async () => {
		pointer(node, "pointerdown", 180, 300);
		pointer(node, "pointerup", 180, 300);
		node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	expect(onOpen).not.toHaveBeenCalled();
	expect(node.getAttribute("aria-pressed")).toBe("true");
	await act(async () => node.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
	expect(onOpen).toHaveBeenCalledExactlyOnceWith("Home.md");
	await act(async () => node.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
	expect(node.getAttribute("aria-pressed")).toBe("false");
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

it.each([
	[-5000, 300],
	[5000, 300],
	[180, -5000],
	[180, 5000],
])("keeps a dragged node inside the canvas at %s,%s", async (x, y) => {
	const canvas = await mount();
	await advance(200);
	const node = canvas.querySelector('[data-knowledge-path="Home.md"]')!;
	const point = position(node);
	const camera = view(canvas);
	await act(async () => {
		pointer(node, "pointerdown", point.x * camera.zoom + camera.x, point.y * camera.zoom + camera.y);
		pointer(node, "pointermove", x, y);
	});
	const moved = position(node);
	const screen = { x: moved.x * camera.zoom + camera.x, y: moved.y * camera.zoom + camera.y };
	expect(screen.x).toBeGreaterThanOrEqual(14);
	expect(screen.x).toBeLessThanOrEqual(width - 14);
	expect(screen.y).toBeGreaterThanOrEqual(14);
	expect(screen.y).toBeLessThanOrEqual(height - 14);
});

it.each(["blur", "pointercancel", "lostpointercapture"])(
	"releases a pinned node on %s and suppresses accidental opening",
	async (event) => {
		const canvas = await mount();
		const node = canvas.querySelector('[data-knowledge-path="Home.md"]')!;
		await act(async () => {
			pointer(node, "pointerdown", 180, 300);
			pointer(node, "pointermove", 200, 320);
			if (event === "blur") window.dispatchEvent(new Event("blur"));
			else pointer(node, event, 200, 320);
			node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			node.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
		});
		expect(onOpen).not.toHaveBeenCalled();
		expect(node.getAttribute("aria-pressed")).toBe("false");
		expect(canvas.hasAttribute("data-dragging")).toBe(false);
		await advance(240);
		expect(frames.size).toBe(0);
	},
);

it("keeps the camera still while physics converges and fits without changing layout", async () => {
	const canvas = await mount();
	const camera = view(canvas);
	const node = canvas.querySelector('[data-knowledge-path="Home.md"]')!;
	const initial = position(node);
	await advance(20);
	expect(view(canvas)).toEqual(camera);
	expect(position(node)).not.toEqual(initial);
	const settled = node.getAttribute("transform");
	await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Reset view"]')!.click());
	expect(node.getAttribute("transform")).toBe(settled);
});

it("supports persistent selection, one/two-hop exploration and keyboard navigation", async () => {
	const data: KnowledgeGraphData = {
		notes: ["A", "B", "C", "D"].map((title) => ({ path: `${title}.md`, title, links: [] })),
		edges: [
			{ source: "A.md", target: "B.md" },
			{ source: "B.md", target: "C.md" },
		],
		warnings: [],
	};
	const canvas = await mount(false, true, data);
	const a = canvas.querySelector('[data-knowledge-path="A.md"]')!;
	await act(async () => a.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: " " })));
	expect(a.getAttribute("aria-pressed")).toBe("true");
	const scope = host.querySelector<HTMLSelectElement>('[aria-label="Graph scope"]')!;
	await act(async () => {
		scope.value = "1";
		scope.dispatchEvent(new Event("change", { bubbles: true }));
	});
	expect(canvas.querySelectorAll(".knowledge-node")).toHaveLength(2);
	await act(async () => {
		scope.value = "2";
		scope.dispatchEvent(new Event("change", { bubbles: true }));
	});
	expect(canvas.querySelectorAll(".knowledge-node")).toHaveLength(3);
	await act(async () => a.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" })));
	expect(onOpen).toHaveBeenCalledWith("A.md");
	await act(async () => canvas.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Escape" })));
	expect(canvas.querySelectorAll(".knowledge-node")).toHaveLength(4);
});

it("animates explicit camera controls and honors reduced motion immediately", async () => {
	document.documentElement.dataset.motion = "full";
	const canvas = await mount();
	await advance(200);
	const initial = view(canvas);
	await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
	expect(view(canvas)).toEqual(initial);
	await advance(12);
	expect(view(canvas).zoom).toBeCloseTo(initial.zoom * 1.25);
	expect(frames.size).toBe(0);
	document.documentElement.dataset.motion = "reduced";
	await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom out"]')!.click());
	expect(view(canvas).zoom).toBeCloseTo(initial.zoom);
	expect(frames.size).toBe(0);
});

it("preserves the camera when a search projection has no nodes", async () => {
	const session = createGraphSession();
	const canvas = await mount(false, true, graph, { session });
	await advance(200);
	await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="Zoom in"]')!.click());
	const before = view(canvas);
	await act(async () => host.querySelectorAll<HTMLInputElement>(".knowledge-graph-options input")[1]!.click());
	await mount(false, true, graph, { session, query: "no such note" });
	expect(canvas.querySelectorAll(".knowledge-node")).toHaveLength(0);
	expect(view(canvas)).toEqual(before);
	await mount(false, true, graph, { session });
	expect(canvas.querySelectorAll(".knowledge-node")).toHaveLength(2);
	expect(view(canvas)).toEqual(before);
});

it("pans with arrow keys while keeping a real note visible", async () => {
	const canvas = await mount();
	await advance(200);
	const before = view(canvas);
	await act(async () => canvas.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" })));
	expect(view(canvas).x).toBeGreaterThan(before.x);
	for (let i = 0; i < 30; i++)
		await act(async () => canvas.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowLeft" })));
	const camera = view(canvas);
	expect(
		[...canvas.querySelectorAll(".knowledge-node")].some((node) => {
			const p = position(node);
			const x = p.x * camera.zoom + camera.x;
			const y = p.y * camera.zoom + camera.y;
			return x >= 14 && x <= width - 14 && y >= 14 && y <= height - 14;
		}),
	).toBe(true);
});

function outsideGraphElement(tag: "div" | "input") {
	const element = document.createElement(tag);
	document.body.append(element);
	auxiliaryElements.push(element);
	return element;
}

async function selectHomeWithHover(canvas: SVGSVGElement) {
	const node = canvas.querySelector<SVGGElement>('[data-knowledge-path="Home.md"]')!;
	await act(async () => {
		pointer(node, "pointerover", 180, 300);
		node.focus();
		pointer(node, "pointerdown", 180, 300);
		pointer(node, "pointerup", 180, 300);
		node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	expect(node.getAttribute("aria-pressed")).toBe("true");
	expect(canvas.querySelector(".knowledge-edge.is-highlighted")).not.toBeNull();
	return node;
}

function expectGraphSelectionCleared(canvas: SVGSVGElement) {
	expect(canvas.querySelector('[aria-pressed="true"]')).toBeNull();
	expect(canvas.querySelector(".knowledge-node.is-selected")).toBeNull();
	expect(canvas.querySelector(".knowledge-node.is-highlighted")).toBeNull();
	expect(canvas.querySelector(".knowledge-edge.is-highlighted")).toBeNull();
	expect(canvas.querySelector(".is-muted")).toBeNull();
}

it.each(["canvas", "viewport"])(
	"clears selection and retained hover when clicking the graph %s background",
	async (target) => {
		const canvas = await mount();
		await selectHomeWithHover(canvas);
		const background = target === "canvas" ? canvas : canvas.querySelector(".knowledge-graph-viewport")!;
		await act(async () => {
			// No pointerleave: focus or the native pointer can still belong to the old node.
			pointer(background, "pointerdown", 12, 20);
			pointer(background, "pointerup", 12, 20);
			background.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expectGraphSelectionCleared(canvas);
		expect(host.querySelector(".knowledge-graph-selection")).toBeNull();
		expect(onOpen).not.toHaveBeenCalled();
	},
);

it.each(["pointerup", "pointercancel", "lostpointercapture"])(
	"keeps selection when a background pan ends with %s",
	async (end) => {
		const canvas = await mount();
		const node = await selectHomeWithHover(canvas);
		await act(async () => {
			pointer(canvas, "pointerdown", 12, 20);
			pointer(canvas, "pointermove", 52, 60);
			pointer(canvas, end, 52, 60);
			canvas.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(node.getAttribute("aria-pressed")).toBe("true");
		expect(canvas.querySelector(".knowledge-edge.is-highlighted")).not.toBeNull();
		expect(onOpen).not.toHaveBeenCalled();
	},
);

it("does not clear selection after a cancelled background press without movement", async () => {
	const canvas = await mount();
	const node = await selectHomeWithHover(canvas);
	await act(async () => {
		pointer(canvas, "pointerdown", 12, 20);
		pointer(canvas, "pointercancel", 12, 20);
		canvas.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	expect(node.getAttribute("aria-pressed")).toBe("true");
	expect(canvas.querySelector(".knowledge-edge.is-highlighted")).not.toBeNull();
});

it("clears selection on an outside non-focusable pointer target and permits selecting a different node", async () => {
	const canvas = await mount();
	const home = await selectHomeWithHover(canvas);
	const outside = outsideGraphElement("div");
	await act(async () => pointer(outside, "pointerdown", 500, 300));
	// Non-focusable content does not blur the old SVG node or synthesize pointerleave.
	expect(document.activeElement).toBe(home);
	expectGraphSelectionCleared(canvas);
	const next = canvas.querySelector<SVGGElement>('[data-knowledge-path="Note.md"]')!;
	await act(async () => {
		pointer(next, "pointerdown", 180, 300);
		pointer(next, "pointerup", 180, 300);
		next.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	expect(next.getAttribute("aria-pressed")).toBe("true");
	expect(next.classList.contains("is-highlighted")).toBe(true);
	expect(home.classList.contains("is-highlighted")).toBe(false);
	expect(onOpen).not.toHaveBeenCalled();
});

it("clears selection when keyboard focus enters a conversation input outside the explorer", async () => {
	const canvas = await mount();
	await selectHomeWithHover(canvas);
	const input = outsideGraphElement("input");
	await act(async () => input.focus());
	expect(document.activeElement).toBe(input);
	expectGraphSelectionCleared(canvas);
});

it("keeps selection while focusing search and controls inside the knowledge explorer boundary", async () => {
	const boundary = document.createElement("section");
	boundary.dataset.knowledgeExplorer = "";
	host.replaceWith(boundary);
	boundary.append(host);
	const search = document.createElement("input");
	search.setAttribute("aria-label", "Knowledge search");
	boundary.append(search);
	auxiliaryElements.push(boundary);
	const canvas = await mount();
	const node = await selectHomeWithHover(canvas);
	await act(async () => {
		pointer(search, "pointerdown", 20, 10);
		search.focus();
	});
	expect(document.activeElement).toBe(search);
	expect(node.getAttribute("aria-pressed")).toBe("true");
	expect(canvas.querySelector(".knowledge-edge.is-highlighted")).not.toBeNull();
	const scope = host.querySelector<HTMLSelectElement>('[aria-label="Graph scope"]')!;
	await act(async () => scope.focus());
	expect(document.activeElement).toBe(scope);
	expect(node.getAttribute("aria-pressed")).toBe("true");
});

it("ignores outside focus and pointer events while inactive and resumes clearing when shown", async () => {
	const canvas = await mount();
	const node = await selectHomeWithHover(canvas);
	const outside = outsideGraphElement("div");
	const input = outsideGraphElement("input");
	await mount(false, false);
	await act(async () => {
		pointer(outside, "pointerdown", 500, 300);
		input.focus();
	});
	expect(document.activeElement).toBe(input);
	expect(node.getAttribute("aria-pressed")).toBe("true");
	await mount(false, true);
	expect(node.getAttribute("aria-pressed")).toBe("true");
	await act(async () => pointer(outside, "pointerdown", 500, 300));
	expectGraphSelectionCleared(canvas);
});

it("keeps node hit-area clicks selectable instead of treating them as graph background", async () => {
	const canvas = await mount();
	const node = canvas.querySelector('[data-knowledge-path="Home.md"]')!;
	const hit = node.querySelector(".knowledge-node-hit")!;
	await act(async () => {
		pointer(hit, "pointerdown", 180, 300);
		pointer(hit, "pointerup", 180, 300);
		hit.dispatchEvent(new MouseEvent("click", { bubbles: true }));
	});
	expect(node.getAttribute("aria-pressed")).toBe("true");
	expect(onOpen).not.toHaveBeenCalled();
});
