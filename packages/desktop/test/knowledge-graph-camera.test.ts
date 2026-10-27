import { describe, expect, it } from "vitest";
import {
	clampGraphDrag,
	constrainGraphView,
	graphZoomLimits,
} from "../src/renderer/components/knowledge-graph-camera.ts";
import {
	type GraphNode,
	type GraphSize,
	type GraphView,
	graphPoint,
	zoomGraph,
} from "../src/renderer/components/knowledge-graph-layout.ts";

const size = { width: 280, height: 700 };
const node = (x: number, y: number, path = `${x},${y}`): GraphNode => ({ path, title: path, x, y, degree: 1 });
const visible = (view: GraphView, nodes: readonly GraphNode[], bounds: GraphSize): boolean =>
	nodes.some((note) => {
		const x = note.x * view.zoom + view.x;
		const y = note.y * view.zoom + view.y;
		return x >= 0 && x <= bounds.width && y >= 0 && y <= bounds.height;
	});

describe("knowledge graph camera boundaries", () => {
	it("clamps screen points before converting drag positions through arbitrary zoom", () => {
		const view = { x: 130, y: 320, zoom: 0.17 };
		for (const point of [
			{ x: -900, y: -500 },
			{ x: 2000, y: 5000 },
			{ x: 140, y: 350 },
		]) {
			const clamped = clampGraphDrag(point, size, 16);
			const world = graphPoint(view, clamped);
			expect(world.x * view.zoom + view.x).toBeCloseTo(clamped.x);
			expect(world.y * view.zoom + view.y).toBeCloseTo(clamped.y);
			expect(clamped.x).toBeGreaterThanOrEqual(22);
			expect(clamped.x).toBeLessThanOrEqual(size.width - 22);
			expect(clamped.y).toBeGreaterThanOrEqual(22);
			expect(clamped.y).toBeLessThanOrEqual(size.height - 22);
		}
	});

	it("collapses drag bounds to the center of a very narrow or hidden panel", () => {
		expect(clampGraphDrag({ x: -500, y: 900 }, { width: 12, height: 20 })).toEqual({ x: 6, y: 10 });
		expect(clampGraphDrag({ x: NaN, y: Infinity }, { width: 0, height: 0 })).toEqual({ x: 0, y: 0 });
	});

	it("preserves a valid camera without adding movement on simulation frames", () => {
		const view = { x: 140, y: 350, zoom: 1.2 };
		expect(constrainGraphView(view, [node(0, 0)], size)).toEqual(view);
	});

	it("uses actual nodes when separated components surround an otherwise empty viewport", () => {
		const nodes = [node(-10_000, 0), node(10_000, 0)];
		const view = { x: 140, y: 350, zoom: 1 };
		expect(visible(view, nodes, size)).toBe(false);
		const next = constrainGraphView(view, nodes, size);
		expect(visible(next, nodes, size)).toBe(true);
		expect(next.zoom).toBe(view.zoom);
	});

	it.each([
		{ width: 280, height: 700 },
		{ width: 920, height: 180 },
		{ width: 12, height: 20 },
	])("keeps a real note visible after extreme pan, zoom, and resize in %j", (bounds) => {
		const nodes = [node(-600, -400), node(300, 900), node(1300, 100)];
		const limits = graphZoomLimits(nodes, bounds);
		for (const zoom of [0.0000001, 0.5, 1, 1_000_000]) {
			for (const offset of [-1_000_000, 1_000_000]) {
				const next = constrainGraphView({ x: offset, y: -offset, zoom }, nodes, bounds);
				expect(visible(next, nodes, bounds)).toBe(true);
				expect(next.zoom).toBeGreaterThanOrEqual(limits.min);
				expect(next.zoom).toBeLessThanOrEqual(limits.max);
				expect(Number.isFinite(next.x) && Number.isFinite(next.y)).toBe(true);
			}
		}
	});

	it("uses content relative zoom limits while preserving the cursor's world position", () => {
		const nodes = [node(-10_000, -8000), node(10_000, 8000)];
		const limits = graphZoomLimits(nodes, size);
		expect(limits.min).toBeLessThan(0.02);
		expect(limits.max).toBeGreaterThanOrEqual(1.5);
		const view = { x: 140, y: 350, zoom: 1 };
		const cursor = { x: 37, y: 510 };
		const point = graphPoint(view, cursor);
		for (const factor of [0.00000001, 1_000_000]) {
			const next = zoomGraph(view, factor, cursor, limits);
			expect(next.zoom).toBeGreaterThanOrEqual(limits.min);
			expect(next.zoom).toBeLessThanOrEqual(limits.max);
			expect(graphPoint(next, cursor).x).toBeCloseTo(point.x);
			expect(graphPoint(next, cursor).y).toBeCloseTo(point.y);
		}
	});

	it("sanitizes empty libraries and invalid measurements without propagating NaN", () => {
		expect(constrainGraphView({ x: NaN, y: Infinity, zoom: 0 }, [], size)).toEqual({ x: 140, y: 350, zoom: 1 });
		const next = constrainGraphView({ x: NaN, y: Infinity, zoom: NaN }, [node(0, 0)], { width: NaN, height: -20 });
		expect(Object.values(next).every(Number.isFinite)).toBe(true);
	});

	it("constrains a dense graph without mutating layout coordinates", () => {
		const nodes = Array.from({ length: 2000 }, (_, index) => node(index * 5, Math.sin(index) * 500, String(index)));
		const coordinates = nodes.map(({ x, y }) => ({ x, y }));
		const next = constrainGraphView({ x: 1_000_000, y: -1_000_000, zoom: 3 }, nodes, size);
		expect(visible(next, nodes, size)).toBe(true);
		expect(nodes.map(({ x, y }) => ({ x, y }))).toEqual(coordinates);
	});
});
