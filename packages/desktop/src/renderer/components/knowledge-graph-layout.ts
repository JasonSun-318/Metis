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
	private graph: KnowledgeGraphData | undefined;
	private homes = new Map<string, { x: number; y: number; radius: number }>();
	private componentHomes = new Map<string, { x: number; y: number }>();
	readonly simulation = forceSimulation<GraphNode>()
		.stop()
		.alphaDecay(0.038)
		.velocityDecay(0.42)
		.force("charge", forceManyBody<GraphNode>().strength(-190).distanceMax(900))
		.force(
			"collision",
			forceCollide<GraphNode>().radius((node) => nodeRadius(node.degree) + 10),
		)
		.force("x", forceX<GraphNode>((node) => this.homes.get(node.path)?.x ?? 0).strength(0.014))
		.force("y", forceY<GraphNode>((node) => this.homes.get(node.path)?.y ?? 0).strength(0.014))
		.force("boundary", (alpha) => {
			for (const node of this.nodes) {
				if (node.fx !== null && node.fx !== undefined) continue;
				const home = this.homes.get(node.path);
				if (!home) continue;
				const dx = node.x - home.x;
				const dy = node.y - home.y;
				const distance = Math.hypot(dx, dy);
				if (distance <= home.radius) continue;
				const pull = ((distance - home.radius) / distance) * 0.08 * alpha;
				node.vx = (node.vx ?? 0) - dx * pull;
				node.vy = (node.vy ?? 0) - dy * pull;
			}
		});

	update(graph: KnowledgeGraphData): boolean {
		this.graph = graph;
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
		const neighbors = new Map(paths.map((path) => [path, [] as string[]]));
		for (const edge of edges) {
			degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
			degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
			neighbors.get(edge.source)?.push(edge.target);
			neighbors.get(edge.target)?.push(edge.source);
		}
		this.updateHomes(paths, neighbors);
		const created = new Map<string, GraphNode>();
		this.nodes = paths.map((path, index) => {
			const previous = this.byPath.get(path);
			const angle = index * Math.PI * (3 - Math.sqrt(5));
			const adjacent = (neighbors.get(path) ?? []).flatMap((neighbor) => {
				const node = this.byPath.get(neighbor) ?? created.get(neighbor);
				return node ? [node] : [];
			});
			const home = this.homes.get(path) ?? { x: 0, y: 0 };
			const center = adjacent.length
				? {
						x: adjacent.reduce((sum, node) => sum + node.x, 0) / adjacent.length,
						y: adjacent.reduce((sum, node) => sum + node.y, 0) / adjacent.length,
					}
				: home;
			const radius = adjacent.length ? 30 : paths.length === 1 || !neighbors.get(path)?.length ? 0 : 20;
			const node = previous ?? {
				path,
				title: titles.get(path)!,
				x: center.x + Math.cos(angle) * radius,
				y: center.y + Math.sin(angle) * radius,
				degree: 0,
			};
			node.degree = degree.get(path) ?? 0;
			created.set(path, node);
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
				.distance(82)
				.strength(0.3),
		);
		this.simulation.alpha(0.75);
		return true;
	}

	private updateHomes(paths: readonly string[], neighbors: ReadonlyMap<string, readonly string[]>): void {
		const visited = new Set<string>();
		const homes = new Map<string, { x: number; y: number; radius: number }>();
		const components: string[][] = [];
		for (const path of paths) {
			if (visited.has(path)) continue;
			const component: string[] = [];
			const pending = [path];
			visited.add(path);
			while (pending.length) {
				const next = pending.pop()!;
				component.push(next);
				for (const neighbor of neighbors.get(next) ?? []) {
					if (visited.has(neighbor)) continue;
					visited.add(neighbor);
					pending.push(neighbor);
				}
			}
			components.push(component.sort());
		}
		components.sort((left, right) => right.length - left.length || left[0]!.localeCompare(right[0]!));
		const componentHomes = new Map<string, { x: number; y: number }>();
		let placed = 0;
		for (const [index, component] of components.entries()) {
			const key = component[0]!;
			const previous = this.componentHomes.get(key);
			const angle = index * Math.PI * (3 - Math.sqrt(5));
			const distance = index ? 52 * Math.sqrt(placed) + 22 * Math.sqrt(component.length) : 0;
			const home = previous ?? { x: Math.cos(angle) * distance, y: Math.sin(angle) * distance };
			componentHomes.set(key, home);
			for (const path of component)
				homes.set(path, { ...home, radius: Math.max(180, Math.sqrt(component.length) * 46) });
			placed += component.length;
		}
		this.homes = homes;
		this.componentHomes = componentHomes;
	}

	/** Explicit reflow is separate from fitting the camera or receiving an equivalent scan. */
	reflow(): void {
		if (!this.graph) return;
		this.nodes = [];
		this.byPath.clear();
		this.componentHomes.clear();
		this.topology = "";
		this.update(this.graph);
		this.simulation.alphaTarget(0);
	}

	step(iterations = 1): boolean {
		this.simulation.tick(iterations);
		return this.simulation.alpha() >= this.simulation.alphaMin() || this.simulation.alphaTarget() > 0;
	}

	pin(path: string, x: number, y: number): void {
		const node = this.byPath.get(path);
		if (!node || !Number.isFinite(x) || !Number.isFinite(y)) return;
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
	const width = Number.isFinite(size.width) ? Math.max(0, size.width) : 0;
	const height = Number.isFinite(size.height) ? Math.max(0, size.height) : 0;
	let left = Infinity;
	let right = -Infinity;
	let top = Infinity;
	let bottom = -Infinity;
	for (const node of nodes) {
		if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) continue;
		left = Math.min(left, node.x);
		right = Math.max(right, node.x);
		top = Math.min(top, node.y);
		bottom = Math.max(bottom, node.y);
	}
	if (left === Infinity) return { x: width / 2, y: height / 2, zoom: 1 };
	const paddingX = Math.min(56, width * 0.14);
	const paddingY = Math.min(32, height * 0.12);
	const zoom = Math.max(
		Number.EPSILON,
		Math.min(
			1.5,
			Math.max(1, width - paddingX * 2) / Math.max(90, right - left),
			Math.max(1, height - paddingY * 2) / Math.max(90, bottom - top),
		),
	);
	return { x: width / 2 - ((left + right) / 2) * zoom, y: height / 2 - ((top + bottom) / 2) * zoom, zoom };
}

export function zoomGraph(
	view: GraphView,
	factor: number,
	point: { x: number; y: number },
	limits = { min: 0.02, max: 8 },
): GraphView {
	const zoom = Math.max(limits.min, Math.min(limits.max, view.zoom * factor));
	const ratio = zoom / view.zoom;
	return { x: point.x - (point.x - view.x) * ratio, y: point.y - (point.y - view.y) * ratio, zoom };
}

export function graphPoint(view: GraphView, point: { x: number; y: number }): { x: number; y: number } {
	return { x: (point.x - view.x) / view.zoom, y: (point.y - view.y) / view.zoom };
}
