import { describe, expect, it } from "vitest";
import {
	fitGraph,
	graphPoint,
	type KnowledgeGraphData,
	KnowledgeGraphLayout,
	zoomGraph,
} from "../src/renderer/components/knowledge-graph-layout.ts";

const graph: KnowledgeGraphData = {
	notes: ["Source", "Concept", "Related"].map((title) => ({ path: `${title}.md`, title, links: [] })),
	edges: [
		{ source: "Source.md", target: "Concept.md" },
		{ source: "Concept.md", target: "Related.md" },
	],
	warnings: [],
};

describe("knowledge force layout", () => {
	it("moves connected notes toward a dragged node without mutating scan results", () => {
		const original = structuredClone(graph);
		const layout = new KnowledgeGraphLayout();
		layout.update(graph);
		layout.step(180);
		const source = layout.byPath.get("Source.md")!;
		const concept = layout.byPath.get("Concept.md")!;
		const before = { x: concept.x, y: concept.y };
		layout.pin(source.path, source.x + 220, source.y + 70);
		layout.step(20);
		expect(concept.x - before.x).toBeGreaterThan(20);
		expect(source.x).toBe(source.fx);
		expect(source.y).toBe(source.fy);
		expect(graph).toEqual(original);
		expect(layout.edges).toEqual(graph.edges);
		layout.release(source.path);
		expect(source.fx).toBeNull();
		expect(source.fy).toBeNull();
		expect(layout.simulation.alphaTarget()).toBe(0);
		layout.stop();
	});

	it("preserves positions and cooling across equivalent scans and title edits", () => {
		const layout = new KnowledgeGraphLayout();
		layout.update(graph);
		layout.step(180);
		const node = layout.byPath.get("Concept.md")!;
		const before = { x: node.x, y: node.y, alpha: layout.simulation.alpha() };
		expect(
			layout.update({
				...graph,
				notes: [...graph.notes].reverse().map((note) => ({ ...note, title: "Renamed" })),
				edges: [...graph.edges].reverse(),
			}),
		).toBe(false);
		expect(layout.byPath.get(node.path)).toBe(node);
		expect({ x: node.x, y: node.y, alpha: layout.simulation.alpha() }).toEqual(before);
		expect(node.title).toBe("Renamed");
		layout.stop();
	});

	it("keeps surviving nodes on add/remove and ignores unresolved endpoints", () => {
		const layout = new KnowledgeGraphLayout();
		layout.update(graph);
		layout.step(20);
		const concept = layout.byPath.get("Concept.md")!;
		const before = { x: concept.x, y: concept.y };
		expect(
			layout.update({
				...graph,
				notes: [graph.notes[1]!, { path: "New.md", title: "New", links: [] }],
				edges: [...graph.edges, { source: concept.path, target: "New.md" }],
			}),
		).toBe(true);
		expect(layout.byPath.get(concept.path)).toBe(concept);
		expect({ x: concept.x, y: concept.y }).toEqual(before);
		expect(layout.byPath.has("Source.md")).toBe(false);
		expect(layout.edges).toEqual([{ source: concept.path, target: "New.md" }]);
		layout.step(10);
		expect(layout.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
		layout.stop();
	});

	it("introduces new notes near surviving neighbors instead of restarting the layout", () => {
		const layout = new KnowledgeGraphLayout();
		layout.update(graph);
		layout.step(60);
		const source = layout.byPath.get("Source.md")!;
		layout.pin(source.path, 1200, -900);
		layout.release(source.path);
		layout.update({
			...graph,
			notes: [...graph.notes, { path: "Added.md", title: "Added", links: [] }],
			edges: [...graph.edges, { source: source.path, target: "Added.md" }],
		});
		const added = layout.byPath.get("Added.md")!;
		expect(layout.byPath.get(source.path)).toBe(source);
		expect(source.x).toBe(1200);
		expect(source.y).toBe(-900);
		expect(Math.hypot(added.x - source.x, added.y - source.y)).toBeCloseTo(30);
		layout.stop();
	});

	it("uses soft world bounds after release while preserving an active pin", () => {
		const layout = new KnowledgeGraphLayout();
		layout.update({ ...graph, notes: [graph.notes[0]!], edges: [] });
		const node = layout.nodes[0]!;
		layout.pin(node.path, 2400, -1800);
		layout.step(30);
		expect({ x: node.x, y: node.y }).toEqual({ x: 2400, y: -1800 });
		layout.release(node.path);
		layout.step(180);
		expect(Math.hypot(node.x, node.y)).toBeLessThan(1500);
		expect(Number.isFinite(node.x) && Number.isFinite(node.y)).toBe(true);
		layout.stop();
	});

	it("reflows only on an explicit request and discards stale drag state", () => {
		const layout = new KnowledgeGraphLayout();
		layout.update(graph);
		layout.step(60);
		const original = layout.nodes[0]!;
		layout.pin(original.path, 4000, 4000);
		expect(layout.update(graph)).toBe(false);
		expect(layout.byPath.get(original.path)).toBe(original);
		layout.reflow();
		const reset = layout.byPath.get(original.path)!;
		expect(reset).not.toBe(original);
		expect(reset.fx).toBeUndefined();
		expect(reset.fy).toBeUndefined();
		expect(Math.hypot(reset.x, reset.y)).toBeLessThan(100);
		expect(layout.edges).toEqual(graph.edges);
		expect(layout.simulation.alphaTarget()).toBe(0);
		layout.step(60);
		expect(layout.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
		layout.stop();
	});

	it("settles disconnected components without sharing a single origin", () => {
		const layout = new KnowledgeGraphLayout();
		layout.update({
			notes: Array.from({ length: 20 }, (_, index) => ({ path: `${index}.md`, title: `${index}`, links: [] })),
			edges: [],
			warnings: [],
		});
		layout.step(180);
		const distances = layout.nodes.flatMap((node, index) =>
			layout.nodes.slice(index + 1).map((other) => Math.hypot(node.x - other.x, node.y - other.y)),
		);
		expect(Math.min(...distances)).toBeGreaterThan(24);
		expect(layout.nodes.every((node) => Math.hypot(node.x, node.y) < 1000)).toBe(true);
		layout.stop();
	});

	// Keep the 2,000-node/180-tick convergence contract independent of CI CPU speed.
	it("keeps a large sparse library finite and settles within bounded ticks", () => {
		const layout = new KnowledgeGraphLayout();
		const notes = Array.from({ length: 2000 }, (_, index) => ({ path: `${index}.md`, title: `${index}`, links: [] }));
		layout.update({
			notes,
			edges: notes.slice(1).map((note, index) => ({ source: notes[index]!.path, target: note.path })),
			warnings: [],
		});
		expect(layout.step(180)).toBe(false);
		expect(layout.nodes).toHaveLength(2000);
		expect(layout.nodes.every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
		expect(layout.edges).toHaveLength(1999);
		layout.stop();
	}, 15_000);

	it.each([
		{ width: 280, height: 780 },
		{ width: 920, height: 250 },
	])("fits an asymmetric layout in %j", (size) => {
		const nodes = [
			{ path: "a", title: "a", degree: 0, x: -340, y: -190 },
			{ path: "b", title: "b", degree: 1, x: 600, y: 310 },
		];
		const view = fitGraph(nodes, size);
		for (const node of nodes) {
			const x = node.x * view.zoom + view.x;
			const y = node.y * view.zoom + view.y;
			expect(x).toBeGreaterThanOrEqual(24);
			expect(x).toBeLessThanOrEqual(size.width - 24);
			expect(y).toBeGreaterThanOrEqual(24);
			expect(y).toBeLessThanOrEqual(size.height - 24);
		}
	});

	it("centers empty and single-note libraries without invalid or excessive zoom", () => {
		const size = { width: 280, height: 700 };
		expect(fitGraph([], size)).toEqual({ x: 140, y: 350, zoom: 1 });
		const node = { path: "a", title: "a", degree: 0, x: 50, y: -20 };
		const view = fitGraph([node], size);
		expect(node.x * view.zoom + view.x).toBe(140);
		expect(node.y * view.zoom + view.y).toBe(350);
		expect(view.zoom).toBeLessThanOrEqual(1.5);
	});

	it("fits widely separated components below the old fixed minimum zoom", () => {
		const size = { width: 280, height: 700 };
		const nodes = [-1_000_000, 1_000_000].map((x) => ({ path: String(x), title: String(x), degree: 0, x, y: 0 }));
		const view = fitGraph(nodes, size);
		expect(view.zoom).toBeLessThan(0.02);
		for (const node of nodes) {
			expect(node.x * view.zoom + view.x).toBeGreaterThanOrEqual(24);
			expect(node.x * view.zoom + view.x).toBeLessThanOrEqual(size.width - 24);
		}
	});

	it("zooms around the cursor and preserves its world coordinate at zoom limits", () => {
		const view = { x: 100, y: 220, zoom: 1.2 };
		const cursor = { x: 37, y: 400 };
		const point = graphPoint(view, cursor);
		for (const factor of [1.25, 0.8, 100, 0.0001]) {
			const next = zoomGraph(view, factor, cursor);
			expect(next.zoom).toBeGreaterThanOrEqual(0.02);
			expect(next.zoom).toBeLessThanOrEqual(8);
			expect(graphPoint(next, cursor).x).toBeCloseTo(point.x);
			expect(graphPoint(next, cursor).y).toBeCloseTo(point.y);
		}
	});
});
