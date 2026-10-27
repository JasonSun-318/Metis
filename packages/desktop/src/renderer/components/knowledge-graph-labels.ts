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
	/** Screen-space metrics also let the next frame reuse this placement. */
	width?: number;
	opacity?: number;
	scale?: number;
}

export interface GraphLabelOptions {
	selected?: string | null;
	related?: ReadonlySet<string>;
	previous?: ReadonlyMap<string, GraphLabel>;
	moving?: boolean;
}

const LABEL_HEIGHT = 16;
const LABEL_BASELINE = 12;
const PANEL_INSET = 8;
const GAP = 3;
const CELL_SIZE = 32;

function overlaps(a: Box, b: Box): boolean {
	return (
		a.x < b.x + b.width + GAP && a.x + a.width + GAP > b.x && a.y < b.y + b.height + GAP && a.y + a.height + GAP > b.y
	);
}

/** Queries stay local even when thousands of nodes are visible. */
class SpatialBoxes {
	private readonly cells = new Map<number, Map<number, Box[]>>();

	add(box: Box): void {
		for (let x = Math.floor(box.x / CELL_SIZE); x <= Math.floor((box.x + box.width) / CELL_SIZE); x++) {
			let column = this.cells.get(x);
			if (!column) {
				column = new Map();
				this.cells.set(x, column);
			}
			for (let y = Math.floor(box.y / CELL_SIZE); y <= Math.floor((box.y + box.height) / CELL_SIZE); y++) {
				const cell = column.get(y);
				if (cell) cell.push(box);
				else column.set(y, [box]);
			}
		}
	}

	hasOverlap(box: Box): boolean {
		for (let x = Math.floor((box.x - GAP) / CELL_SIZE); x <= Math.floor((box.x + box.width + GAP) / CELL_SIZE); x++) {
			const column = this.cells.get(x);
			if (!column) continue;
			for (
				let y = Math.floor((box.y - GAP) / CELL_SIZE);
				y <= Math.floor((box.y + box.height + GAP) / CELL_SIZE);
				y++
			) {
				const cell = column.get(y);
				if (cell?.some((other) => overlaps(box, other))) return true;
			}
		}
		return false;
	}
}

function characterWidth(character: string): number {
	const code = character.codePointAt(0)!;
	if (code > 0xffff) return 14;
	if (code > 0x2ff) return 12;
	if ("MW@#%&".includes(character)) return 11;
	if (" ilI.,:;'!|".includes(character)) return 4;
	return 7.5;
}

function shortLabel(title: string, maximum: number): { text: string; width: number } {
	const characters: string[] = [];
	const widths: number[] = [];
	let width = 0;
	for (const character of title) {
		const next = characterWidth(character);
		if (width + next > maximum) {
			while (width + 12 > maximum && characters.length) {
				characters.pop();
				width -= widths.pop()!;
			}
			return { text: `${characters.join("")}…`, width: width + 12 };
		}
		characters.push(character);
		widths.push(next);
		width += next;
	}
	return { text: characters.join(""), width };
}

function withinPanel(box: Box, size: GraphSize): boolean {
	return (
		box.x >= PANEL_INSET &&
		box.y >= PANEL_INSET &&
		box.x + box.width <= size.width - PANEL_INSET &&
		box.y + box.height <= size.height - PANEL_INSET
	);
}

function priority(path: string, hovered: string | null, options: GraphLabelOptions): number {
	if (path === hovered) return 3;
	if (path === options.selected) return 2;
	if (options.related?.has(path)) return 1;
	return 0;
}

export function graphLabels(
	nodes: readonly GraphNode[],
	view: GraphView,
	size: GraphSize,
	hovered: string | null,
	options: GraphLabelOptions = {},
): Map<string, GraphLabel> {
	const result = new Map<string, GraphLabel>();
	if (
		!Number.isFinite(view.zoom) ||
		view.zoom <= 0 ||
		!Number.isFinite(view.x) ||
		!Number.isFinite(view.y) ||
		!Number.isFinite(size.width) ||
		!Number.isFinite(size.height) ||
		size.width <= PANEL_INSET * 2 + 12 ||
		size.height <= PANEL_INSET * 2 + LABEL_HEIGHT
	)
		return result;

	const nodeBoxes = new SpatialBoxes();
	const labelBoxes = new SpatialBoxes();
	const dense = nodes.length > 300;
	const candidates: { node: GraphNode; x: number; y: number; radius: number; priority: number }[] = [];
	for (const node of nodes) {
		const x = node.x * view.zoom + view.x;
		const y = node.y * view.zoom + view.y;
		if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
		const radius = nodeRadius(node.degree, dense);
		if (x + radius < 0 || x - radius > size.width || y + radius < 0 || y - radius > size.height) continue;
		nodeBoxes.add({ x: x - radius, y: y - radius, width: radius * 2, height: radius * 2 });
		candidates.push({ node, x, y, radius, priority: priority(node.path, hovered, options) });
	}
	candidates.sort(
		(a, b) => b.priority - a.priority || b.node.degree - a.node.degree || a.node.path.localeCompare(b.node.path),
	);

	const detail = Math.max(0, Math.min(1, (view.zoom - 0.12) / 0.78));
	const areaBudget = Math.min(120, Math.max(4, Math.floor(((size.width - 16) * (size.height - 16)) / 2600)));
	const budget = Math.max(4, Math.floor(areaBudget * (0.35 + detail * 0.65)));
	const maximumWidth = Math.min(192, size.width * 0.52, size.width - PANEL_INSET * 2);
	let regularCount = 0;
	for (const candidate of candidates) {
		const { node, x, y, radius, priority: importance } = candidate;
		if (result.size >= 120) break;
		if (!importance && regularCount >= budget) break;
		const label = shortLabel(node.title, maximumWidth);
		if (!label.text) continue;
		const previous = options.previous?.get(node.path);
		const previousScale = previous?.scale ?? view.zoom;
		const previousBox =
			previous && previous.text === label.text && Number.isFinite(previous.x) && Number.isFinite(previous.y)
				? {
						x: x + previous.x * previousScale,
						y: y + previous.y * previousScale - LABEL_BASELINE,
						width: label.width,
						height: LABEL_HEIGHT,
					}
				: undefined;
		const free = (box: Box): boolean =>
			withinPanel(box, size) && !labelBoxes.hasOverlap(box) && !nodeBoxes.hasOverlap(box);
		let box = previousBox && free(previousBox) ? previousBox : undefined;
		let opacity = importance >= 2 ? 1 : importance === 1 ? 0.9 : 0.45 + detail * 0.55;
		if (!box && previousBox && options.moving) {
			// Keep the anchor while dragging; reveal it after the layout can settle.
			box = previousBox;
			opacity = importance >= 2 && withinPanel(box, size) && !labelBoxes.hasOverlap(box) ? 1 : 0;
		}
		if (!box) {
			const right = { x: x + radius + 8, y: y - LABEL_HEIGHT / 2, width: label.width, height: LABEL_HEIGHT };
			const left = { ...right, x: x - radius - 8 - label.width };
			const positions = [
				x >= size.width / 2 ? left : right,
				{ ...right, x: x - label.width / 2, y: y + radius + 7 },
				{ ...right, x: x - label.width / 2, y: y - radius - 7 - LABEL_HEIGHT },
				x >= size.width / 2 ? right : left,
			];
			box = positions.find(free);
			// A few hub labels still orient a dense overview, with a text halo in the renderer.
			if (!box && (importance > 0 || regularCount < 4)) {
				const clamped = positions.map((position) => ({
					...position,
					x: Math.max(PANEL_INSET, Math.min(size.width - PANEL_INSET - position.width, position.x)),
					y: Math.max(PANEL_INSET, Math.min(size.height - PANEL_INSET - position.height, position.y)),
				}));
				box = [...positions, ...clamped].find(
					(position) => withinPanel(position, size) && !labelBoxes.hasOverlap(position),
				);
			}
		}
		if (!box) continue;
		if (opacity > 0) labelBoxes.add(box);
		result.set(node.path, {
			text: label.text,
			x: (box.x - x) / view.zoom,
			y: (box.y + LABEL_BASELINE - y) / view.zoom,
			width: label.width,
			opacity,
			scale: view.zoom,
		});
		if (!importance) regularCount++;
	}
	return result;
}
