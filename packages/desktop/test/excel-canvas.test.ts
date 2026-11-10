import { describe, expect, it } from "vitest";
import { buildSheetLayout, visibleRange, wrapTextLines } from "../src/renderer/components/preview/excel-canvas.ts";
import { type ExcelSheetView, offsetIndex } from "../src/renderer/components/preview/excel-grid.ts";

const sheet = {
	name: "Data",
	startRow: 0,
	startCol: 0,
	rowCount: 4,
	colCount: 3,
	cells: new Map(),
	hidden: new Set(),
	merges: [],
	columnWidths: [96, 112, 80],
	rowHeights: [28, 40, 20, 28],
} satisfies ExcelSheetView;

describe("buildSheetLayout", () => {
	it("scales widths, heights and offsets", () => {
		const layout = buildSheetLayout(sheet, 1);
		expect(layout.columnWidths).toEqual([96, 112, 80]);
		expect(layout.rowHeights).toEqual([28, 40, 20, 28]);
		expect(layout.columnOffsets).toEqual([0, 96, 208, 288]);
		expect(layout.rowOffsets).toEqual([0, 28, 68, 88, 116]);
		expect(layout.totalWidth).toBe(44 + 288);
		expect(layout.totalHeight).toBe(28 + 116);
	});

	it("grows the layout with zoom", () => {
		const layout = buildSheetLayout(sheet, 1.5);
		expect(layout.columnWidths[0]).toBe(144);
		expect(layout.rowHeights[1]).toBe(60);
		expect(layout.totalWidth).toBe(layout.indexWidth + 432);
	});
});

describe("offsetIndex / visibleRange", () => {
	const offsets = [0, 96, 208, 288];

	it("maps positions to the owning index", () => {
		expect(offsetIndex(offsets, 0)).toBe(0);
		expect(offsetIndex(offsets, 95)).toBe(0);
		expect(offsetIndex(offsets, 96)).toBe(1);
		expect(offsetIndex(offsets, 287)).toBe(2);
		expect(offsetIndex(offsets, 10_000)).toBe(3);
	});

	it("returns the inclusive range intersecting the viewport", () => {
		expect(visibleRange(offsets, 0, 100)).toEqual({ start: 0, end: 1 });
		expect(visibleRange(offsets, 96, 120)).toEqual({ start: 1, end: 2 });
		expect(visibleRange(offsets, 500, 120)).toEqual({ start: 2, end: 2 });
		expect(visibleRange([0], 0, 120)).toEqual({ start: 0, end: -1 });
	});
});

describe("wrapTextLines", () => {
	const measure = (value: string) => value.length;

	it("keeps short paragraphs on one line", () => {
		expect(wrapTextLines("hello", 10, measure)).toEqual(["hello"]);
	});

	it("wraps at character boundaries when words do not fit", () => {
		expect(wrapTextLines("abcdefghij", 4, measure)).toEqual(["abcd", "efgh", "ij"]);
	});

	it("honors explicit newlines", () => {
		expect(wrapTextLines("one\ntwo", 10, measure)).toEqual(["one", "two"]);
	});

	it("breaks between CJK characters", () => {
		expect(wrapTextLines("你好世界", 2, measure)).toEqual(["你好", "世界"]);
	});
});
