import { describe, expect, it } from "vitest";
import { type GraphLabel, graphLabels } from "../src/renderer/components/knowledge-graph-labels.ts";
import type { GraphNode, GraphSize, GraphView } from "../src/renderer/components/knowledge-graph-layout.ts";

function nodes(count: number): GraphNode[] {
	const columns = Math.ceil(Math.sqrt(count));
	return Array.from({ length: count }, (_, index) => ({
		path: `${index}.md`,
		title: `Topic ${index}`,
		x: (index % columns) * 24,
		y: Math.floor(index / columns) * 24,
		degree: index === 0 ? 8 : index % 4,
	}));
}

function fittedView(items: readonly GraphNode[], size: GraphSize): GraphView {
	const span = Math.max(1, Math.ceil(Math.sqrt(items.length)) - 1) * 24;
	return { x: 28, y: 28, zoom: Math.min((size.width - 56) / span, (size.height - 56) / span) };
}

function box(node: GraphNode, label: GraphLabel, view: GraphView) {
	return {
		x: node.x * view.zoom + view.x + label.x * view.zoom,
		y: node.y * view.zoom + view.y + label.y * view.zoom - 12,
		width: label.width ?? 0,
		height: 16,
	};
}

describe("knowledge graph labels", () => {
	it.each([30, 150, 500, 2000])("keeps useful labels for %i nodes instead of switching them all off", (count) => {
		for (const width of [280, 360, 460]) {
			const size = { width, height: 500 };
			const items = nodes(count);
			const labels = graphLabels(items, fittedView(items, size), size, null);
			expect(labels.size).toBeGreaterThan(0);
			expect(labels.size).toBeLessThanOrEqual(120);
		}
	});

	it("does not lose the graph's labels when the 151st note appears", () => {
		const size = { width: 460, height: 500 };
		const first = nodes(150);
		const next = nodes(151);
		const labels = graphLabels(first, fittedView(first, size), size, null);
		expect(graphLabels(next, fittedView(next, size), size, null).size).toBeGreaterThanOrEqual(labels.size / 2);
	});

	it("uses viewport area and zoom detail to budget labels", () => {
		const items = Array.from({ length: 100 }, (_, index) => ({
			path: `${index}.md`,
			title: `N${index}`,
			x: 25 + (index % 10) * 42,
			y: 25 + Math.floor(index / 10) * 46,
			degree: 0,
		}));
		const size = { width: 460, height: 500 };
		const detailed = graphLabels(items, { x: 0, y: 0, zoom: 1 }, size, null);
		const overview = graphLabels(
			items.map((node) => ({ ...node, x: node.x / 0.2, y: node.y / 0.2 })),
			{ x: 0, y: 0, zoom: 0.2 },
			size,
			null,
		);
		expect(detailed.size).toBeGreaterThan(overview.size);
		expect([...overview.values()].every((label) => label.opacity! < 1)).toBe(true);
		const smaller = graphLabels(items, { x: 0, y: 0, zoom: 1 }, { width: 280, height: 500 }, null);
		expect(detailed.size).toBeGreaterThan(smaller.size);
	});

	it("prioritizes hover, selected and related notes ahead of unrelated hubs", () => {
		const items = nodes(40).map((node) => ({ ...node, x: 0, y: 0, degree: 100 }));
		items[0]!.degree = 0;
		items[1]!.degree = 0;
		items[2]!.degree = 0;
		const labels = graphLabels(items, { x: 180, y: 150, zoom: 1 }, { width: 360, height: 300 }, "1.md", {
			selected: "0.md",
			related: new Set(["2.md"]),
		});
		expect([...labels.keys()].slice(0, 3)).toEqual(["1.md", "0.md", "2.md"]);
		expect(labels.get("1.md")?.opacity).toBe(1);
		expect(labels.get("0.md")?.opacity).toBe(1);
	});

	it("keeps long edge labels inside the panel and truncates at whole characters", () => {
		const size = { width: 280, height: 500 };
		for (const [x, y] of [
			[0, 0],
			[280, 0],
			[0, 500],
			[280, 500],
		]) {
			const item = { path: "edge.md", title: "知识图谱📚与长标题".repeat(50), x: x!, y: y!, degree: 2 };
			const view = { x: 0, y: 0, zoom: 1 };
			const label = graphLabels([item], view, size, item.path).get(item.path);
			expect(label).toBeDefined();
			const bounds = box(item, label!, view);
			expect(bounds.x).toBeGreaterThanOrEqual(8);
			expect(bounds.y).toBeGreaterThanOrEqual(8);
			expect(bounds.x + bounds.width).toBeLessThanOrEqual(size.width - 8);
			expect(bounds.y + bounds.height).toBeLessThanOrEqual(size.height - 8);
			expect(label!.text).toMatch(/…$/u);
		}
	});

	it("keeps label offsets stable while a node moves or zoom changes", () => {
		const size = { width: 460, height: 500 };
		const item = { path: "a.md", title: "Stable title", x: 0, y: 0, degree: 4 };
		const view = { x: 200, y: 200, zoom: 1 };
		const initial = graphLabels([item], view, size, null);
		const moved = graphLabels([{ ...item, x: 5, y: 4 }], view, size, null, { previous: initial, moving: true });
		expect(moved.get(item.path)?.x).toBe(initial.get(item.path)?.x);
		expect(moved.get(item.path)?.y).toBe(initial.get(item.path)?.y);
		const zoomed = graphLabels([item], { ...view, zoom: 2 }, size, null, { previous: initial, moving: true });
		expect(zoomed.get(item.path)!.x * 2).toBe(initial.get(item.path)!.x);
	});

	it("does not jump the focused label while dragging through a cluster", () => {
		const item = { path: "focus.md", title: "Focused title", x: 0, y: 0, degree: 4 };
		const view = { x: 200, y: 200, zoom: 1 };
		const size = { width: 460, height: 500 };
		const initial = graphLabels([item], view, size, item.path);
		const occupied = box(item, initial.get(item.path)!, view);
		const blocker = {
			path: "blocker.md",
			title: "Other",
			degree: 0,
			x: occupied.x + occupied.width / 2 - view.x,
			y: occupied.y + 8 - view.y,
		};
		const moving = graphLabels([item, blocker], view, size, item.path, { previous: initial, moving: true });
		expect(moving.get(item.path)?.x).toBe(initial.get(item.path)?.x);
		expect(moving.get(item.path)?.y).toBe(initial.get(item.path)?.y);
		expect(moving.get(item.path)?.opacity).toBe(1);
	});

	it("culls offscreen and non-finite nodes before assigning label space", () => {
		const item = { path: "visible.md", title: "Visible", x: 40, y: 50, degree: 0 };
		const others = nodes(2000).map((node) => ({ ...node, x: node.x + 10_000, y: node.y + 10_000 }));
		const invalid = { path: "invalid.md", title: "Invalid", x: Number.NaN, y: 0, degree: 1000 };
		const labels = graphLabels(
			[...others, invalid, item],
			{ x: 0, y: 0, zoom: 1 },
			{ width: 280, height: 500 },
			null,
		);
		expect([...labels.keys()]).toEqual([item.path]);
	});

	it("fades a colliding moving label instead of jumping it to another side", () => {
		const size = { width: 460, height: 500 };
		const view = { x: 200, y: 200, zoom: 1 };
		const item = { path: "a.md", title: "Stable title", x: 0, y: 0, degree: 4 };
		const initial = graphLabels([item], view, size, null);
		const occupied = box(item, initial.get(item.path)!, view);
		const blocker = {
			path: "blocker.md",
			title: "Other",
			degree: 0,
			x: occupied.x + occupied.width / 2 - view.x,
			y: occupied.y + 8 - view.y,
		};
		const moving = graphLabels([item, blocker], view, size, null, { previous: initial, moving: true });
		expect(moving.get(item.path)?.x).toBe(initial.get(item.path)?.x);
		expect(moving.get(item.path)?.opacity).toBe(0);
		const settled = graphLabels([item, blocker], view, size, null, { previous: moving, moving: false });
		expect(settled.get(item.path)!.opacity).toBeGreaterThan(0);
		expect(
			settled.get(item.path)?.x === moving.get(item.path)?.x &&
				settled.get(item.path)?.y === moving.get(item.path)?.y,
		).toBe(false);
	});

	it("produces non-overlapping visible labels independently of input order", () => {
		const items = nodes(500);
		const size = { width: 460, height: 500 };
		const view = fittedView(items, size);
		const labels = graphLabels(items, view, size, null);
		expect(graphLabels([...items].reverse(), view, size, null)).toEqual(labels);
		const byPath = new Map(items.map((node) => [node.path, node]));
		const boxes = [...labels]
			.filter(([, label]) => (label.opacity ?? 1) > 0)
			.map(([path, label]) => box(byPath.get(path)!, label, view));
		for (let a = 0; a < boxes.length; a++)
			for (let b = a + 1; b < boxes.length; b++) {
				const left = boxes[a]!;
				const right = boxes[b]!;
				expect(
					left.x < right.x + right.width &&
						left.x + left.width > right.x &&
						left.y < right.y + right.height &&
						left.y + left.height > right.y,
				).toBe(false);
			}
	});

	it("handles empty, invalid and tiny viewports without invalid coordinates", () => {
		expect(graphLabels([], { x: 0, y: 0, zoom: 1 }, { width: 280, height: 500 }, null).size).toBe(0);
		expect(graphLabels(nodes(1), { x: 0, y: 0, zoom: 0 }, { width: 280, height: 500 }, null).size).toBe(0);
		expect(graphLabels(nodes(1), { x: 0, y: 0, zoom: 1 }, { width: 10, height: 10 }, "0.md").size).toBe(0);
	});
});
