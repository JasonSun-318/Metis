import { type GraphNode, type GraphSize, type GraphView, nodeRadius } from "./knowledge-graph-layout.ts";

interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}
export interface GraphLabel {
	text: string;
	x: number;
	y: number;
}

function shortLabel(title: string, width: number): { text: string; width: number } {
	let used = 0;
	let text = "";
	for (const character of title) {
		const next = character.codePointAt(0)! > 255 ? 11 : 6;
		if (used + next > width - 12) return { text: `${text}…`, width: used + 12 };
		used += next;
		text += character;
	}
	return { text, width: used };
}

function overlaps(a: Box, b: Box): boolean {
	return a.x < b.x + b.width + 3 && a.x + a.width + 3 > b.x && a.y < b.y + b.height + 3 && a.y + a.height + 3 > b.y;
}

/** Pixel-sized labels avoid other labels and nodes; prioritize the hovered note and hubs. */
export function graphLabels(
	nodes: readonly GraphNode[],
	view: GraphView,
	size: GraphSize,
	hovered: string | null,
): Map<string, GraphLabel> {
	const result = new Map<string, GraphLabel>();
	if (nodes.length > 150 && !hovered) return result;
	const occupied = nodes.map((node) => {
		const radius = nodeRadius(node.degree, nodes.length > 300);
		return {
			x: node.x * view.zoom + view.x - radius,
			y: node.y * view.zoom + view.y - radius,
			width: radius * 2,
			height: radius * 2,
		};
	});
	const candidates = nodes
		.filter((node) => nodes.length <= 150 || node.path === hovered)
		.sort(
			(a, b) =>
				Number(b.path === hovered) - Number(a.path === hovered) ||
				b.degree - a.degree ||
				a.path.localeCompare(b.path),
		);
	for (const node of candidates) {
		const x = node.x * view.zoom + view.x;
		const y = node.y * view.zoom + view.y;
		if (x < 0 || x > size.width || y < 0 || y > size.height) continue;
		const radius = nodeRadius(node.degree, nodes.length > 300);
		const label = shortLabel(node.title, Math.min(180, size.width * 0.45));
		const right = { x: x + radius + 8, y: y - 7, width: label.width, height: 14 };
		const left = { ...right, x: x - radius - 8 - label.width };
		const positions = [
			x >= size.width / 2 ? left : right,
			{ ...right, x: x - label.width / 2, y: y + radius + 7 },
			{ ...right, x: x - label.width / 2, y: y - radius - 21 },
			x >= size.width / 2 ? right : left,
		];
		const withinPanel = (box: Box) =>
			box.x >= 8 && box.y >= 8 && box.x + box.width <= size.width - 8 && box.y + box.height <= size.height - 8;
		const free = positions.find((box) => withinPanel(box) && occupied.every((other) => !overlaps(box, other)));
		// Hover must still reveal a title in a crowded cluster.
		const box = free ?? (node.path === hovered ? positions.find(withinPanel) : undefined);
		if (!box) continue;
		occupied.push(box);
		result.set(node.path, { text: label.text, x: (box.x - x) / view.zoom, y: (box.y + 11 - y) / view.zoom });
	}
	return result;
}
