import type { ClientResult } from "@metis/app-protocol";
import {
	forceCollide,
	forceLink,
	forceManyBody,
	forceSimulation,
	forceX,
	forceY,
	type SimulationNodeDatum,
} from "d3-force";

export type KnowledgeGraphData = ClientResult<"knowledge/scan">;
export interface GraphNode extends SimulationNodeDatum {
	readonly path: string;
	title: string;
	x: number;
	y: number;
	degree: number;
}
export interface GraphView {
	x: number;
	y: number;
	zoom: number;
}
export interface GraphSize {
	width: number;
	height: number;
}

export function nodeRadius(degree: number, dense = false): number {
	return dense ? Math.min(7, 2.5 + Math.sqrt(degree)) : Math.min(10, 4.5 + Math.sqrt(degree) * 1.5);
}

/** The simulation owns copies; scanning results and note links remain untouched. */
export class KnowledgeGraphLayout {
	nodes: GraphNode[] = [];
	edges: { source: string; target: string }[] = [];
	readonly byPath = new Map<string, GraphNode>();
	private topology = "";
	readonly simulation = forceSimulation<GraphNode>()
		.stop()
		.alphaDecay(0.045)
		.velocityDecay(0.38)
		.force("charge", forceManyBody<GraphNode>().strength(-220).distanceMax(900))
		.force(
			"collision",
			forceCollide<GraphNode>().radius((node) => nodeRadius(node.degree) + 10),
		)
		.force("x", forceX<GraphNode>(0).strength(0.025))
		.force("y", forceY<GraphNode>(0).strength(0.025));

	update(graph: KnowledgeGraphData): boolean {
		const titles = new Map(graph.notes.map((note) => [note.path, note.title]));
		for (const node of this.nodes) node.title = titles.get(node.path) ?? node.title;
		const paths = graph.notes.map((note) => note.path).sort();
		const available = new Set(paths);
		const edges = graph.edges.filter((edge) => available.has(edge.source) && available.has(edge.target));
		const topology = JSON.stringify([paths, edges.map((edge) => [edge.source, edge.target]).sort()]);
		if (topology === this.topology) return false;
		this.topology = topology;
		this.edges = edges.map((edge) => ({ source: edge.source, target: edge.target }));
		const degree = new Map<string, number>();
		for (const edge of edges) {
			degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
			degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
		}
		this.nodes = paths.map((path, index) => {
			const previous = this.byPath.get(path);
			const angle = index * Math.PI * (3 - Math.sqrt(5));
			const radius = paths.length === 1 ? 0 : 22 * Math.sqrt(index + 0.5);
			const node = previous ?? {
				path,
				title: titles.get(path)!,
				x: Math.cos(angle) * radius,
				y: Math.sin(angle) * radius,
				degree: 0,
			};
			node.degree = degree.get(path) ?? 0;
			return node;
		});
		this.byPath.clear();
		for (const node of this.nodes) this.byPath.set(node.path, node);
		this.simulation.nodes(this.nodes).force(
			"link",
			forceLink<GraphNode, { source: string | GraphNode; target: string | GraphNode }>(
				edges.map((edge) => ({ source: edge.source, target: edge.target })),
			)
				.id((node) => node.path)
				.distance(78)
				.strength(0.35),
		);
		this.simulation.alpha(0.8);
		return true;
	}

	step(iterations = 1): boolean {
		this.simulation.tick(iterations);
		return this.simulation.alpha() >= this.simulation.alphaMin() || this.simulation.alphaTarget() > 0;
	}

	pin(path: string, x: number, y: number): void {
		const node = this.byPath.get(path);
		if (!node) return;
		node.fx = node.x = x;
		node.fy = node.y = y;
		node.vx = node.vy = 0;
		this.simulation.alpha(Math.max(0.3, this.simulation.alpha())).alphaTarget(0.12);
	}

	release(path: string): void {
		const node = this.byPath.get(path);
		if (node) node.fx = node.fy = null;
		this.simulation.alphaTarget(0);
	}

	stop(): void {
		this.simulation.stop();
	}
}

export function fitGraph(nodes: readonly GraphNode[], size: GraphSize): GraphView {
	if (!nodes.length) return { x: size.width / 2, y: size.height / 2, zoom: 1 };
	let left = Infinity;
	let right = -Infinity;
	let top = Infinity;
	let bottom = -Infinity;
	for (const node of nodes) {
		left = Math.min(left, node.x);
		right = Math.max(right, node.x);
		top = Math.min(top, node.y);
		bottom = Math.max(bottom, node.y);
	}
	const paddingX = Math.min(56, size.width * 0.14);
	const paddingY = Math.min(32, size.height * 0.12);
	const zoom = Math.max(
		0.02,
		Math.min(
			1.5,
			Math.max(1, size.width - paddingX * 2) / Math.max(90, right - left),
			Math.max(1, size.height - paddingY * 2) / Math.max(90, bottom - top),
		),
	);
	return { x: size.width / 2 - ((left + right) / 2) * zoom, y: size.height / 2 - ((top + bottom) / 2) * zoom, zoom };
}

export function zoomGraph(view: GraphView, factor: number, point: { x: number; y: number }): GraphView {
	const zoom = Math.max(0.02, Math.min(8, view.zoom * factor));
	const ratio = zoom / view.zoom;
	return { x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio, zoom };
}

export function graphPoint(view: GraphView, point: { x: number; y: number }): { x: number; y: number } {
	return { x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom };
}
