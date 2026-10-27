import {
	type GraphSize,
	type GraphView,
	type KnowledgeGraphData,
	KnowledgeGraphLayout,
} from "./knowledge-graph-layout.ts";

/** Owned by the library panel so reading a note does not discard exploration. */
export type GraphSession = {
	layout: KnowledgeGraphLayout;
	view: GraphView;
	size: GraphSize;
	initialized: boolean;
	selected: string | null;
	scope: "all" | "1" | "2";
	grouped: boolean;
	matchingOnly: boolean;
};

export function createGraphSession(): GraphSession {
	return {
		layout: new KnowledgeGraphLayout(),
		view: { x: 0, y: 0, zoom: 1 },
		size: { width: 0, height: 0 },
		initialized: false,
		selected: null,
		scope: "all",
		grouped: false,
		matchingOnly: false,
	};
}

export function graphNeighbors(graph: KnowledgeGraphData): Map<string, Set<string>> {
	const neighbors = new Map(graph.notes.map((note) => [note.path, new Set<string>()]));
	for (const edge of graph.edges) {
		neighbors.get(edge.source)?.add(edge.target);
		neighbors.get(edge.target)?.add(edge.source);
	}
	return neighbors;
}

export function graphScope(neighbors: ReadonlyMap<string, ReadonlySet<string>>, path: string | null, depth: number) {
	const paths = new Set<string>();
	if (!path || !neighbors.has(path)) return paths;
	paths.add(path);
	let frontier = [path];
	for (let hop = 0; hop < depth; hop++) {
		const next: string[] = [];
		for (const source of frontier) {
			for (const target of neighbors.get(source) ?? []) {
				if (paths.has(target)) continue;
				paths.add(target);
				next.push(target);
			}
		}
		frontier = next;
	}
	return paths;
}

export function graphDirectoryColor(path: string): string {
	const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
	let hash = 0;
	for (const character of directory) hash = (hash * 31 + character.charCodeAt(0)) | 0;
	return `hsl(${((hash % 360) + 360) % 360} 24% 58%)`;
}
