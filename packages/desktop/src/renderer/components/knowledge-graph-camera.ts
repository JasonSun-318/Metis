import { fitGraph, type GraphNode, type GraphSize, type GraphView, nodeRadius } from "./knowledge-graph-layout.ts";

export interface GraphPoint {
	readonly x: number;
	readonly y: number;
}

function dimension(value: number): number {
	return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clamp(value: number, low: number, high: number): number {
	return Math.max(low, Math.min(high, value));
}

/** The pointer is constrained in panel pixels before it is converted back into world coordinates. */
export function clampGraphDrag(point: GraphPoint, size: GraphSize, radius = 16): GraphPoint {
	const width = dimension(size.width);
	const height = dimension(size.height);
	const inset = Math.max(18, Number.isFinite(radius) ? radius + 6 : 22);
	const xInset = Math.min(inset, width / 2);
	const yInset = Math.min(inset, height / 2);
	return {
		x: clamp(Number.isFinite(point.x) ? point.x : width / 2, xInset, width - xInset),
		y: clamp(Number.isFinite(point.y) ? point.y : height / 2, yInset, height - yInset),
	};
}

/** Content-relative limits keep zooming useful for both a single note and a large library. */
export function graphZoomLimits(nodes: readonly GraphNode[], size: GraphSize): { min: number; max: number } {
	const fitted = fitGraph(nodes, size).zoom;
	return {
		min: Math.max(Number.EPSILON, Math.min(0.65, fitted * 0.55)),
		max: Math.max(1.5, Math.min(6, fitted * 12)),
	};
}

/**
 * Keep at least one actual note inside the inset viewport. A graph's bounding box can
 * intersect the panel while every disconnected component is offscreen, so bounds alone
 * cannot establish visibility. The smallest translation to a real note prevents a blank pan.
 */
export function constrainGraphView(view: GraphView, nodes: readonly GraphNode[], size: GraphSize): GraphView {
	const width = dimension(size.width);
	const height = dimension(size.height);
	const available = nodes.filter((node) => Number.isFinite(node.x) && Number.isFinite(node.y));
	if (!available.length) return { x: width / 2, y: height / 2, zoom: 1 };
	const limits = graphZoomLimits(available, { width, height });
	const previousZoom = Number.isFinite(view.zoom) && view.zoom > 0 ? view.zoom : 1;
	const zoom = clamp(previousZoom, limits.min, limits.max);
	const x = Number.isFinite(view.x) ? view.x : width / 2;
	const y = Number.isFinite(view.y) ? view.y : height / 2;
	const next = {
		x: width / 2 - ((width / 2 - x) * zoom) / previousZoom,
		y: height / 2 - ((height / 2 - y) * zoom) / previousZoom,
		zoom,
	};
	if (!width || !height) return next;
	let correction = { x: 0, y: 0 };
	let distance = Infinity;
	for (const node of available) {
		const screen = { x: node.x * zoom + next.x, y: node.y * zoom + next.y };
		const visible = clampGraphDrag(screen, { width, height }, nodeRadius(node.degree, available.length > 300));
		const dx = visible.x - screen.x;
		const dy = visible.y - screen.y;
		const squared = dx * dx + dy * dy;
		if (squared === 0) return next;
		if (squared < distance) {
			distance = squared;
			correction = { x: dx, y: dy };
		}
	}
	return { ...next, x: next.x + correction.x, y: next.y + correction.y };
}
