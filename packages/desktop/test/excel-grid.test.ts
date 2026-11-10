import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
	DEFAULT_SPREADSHEET_LIMITS,
	excelSelectionContext,
	expandExcelSelection,
	mergesInRowRange,
	offsetIndex,
	paintedCellsForRow,
	parseExcelBytes,
	parseSheetView,
	parseWorkbook,
	prefixOffsets,
	SpreadsheetTooLargeError,
} from "../src/renderer/components/preview/excel-grid.ts";

describe("parseExcelBytes", () => {
	it("keeps real cell addresses and formulas when data starts at C5", () => {
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(
			wb,
			{
				C5: { t: "n", v: 12, f: "SUM(C6:C7)" },
				C6: { t: "n", v: 5 },
				C7: { t: "n", v: 7 },
				"!ref": "C5:D7",
				"!merges": [{ s: { r: 4, c: 2 }, e: { r: 4, c: 3 } }],
			},
			"收入",
		);
		const view = parseExcelBytes(new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" })), "test.xlsx");
		const sheet = view.sheets.收入!;
		expect([sheet.startRow, sheet.startCol]).toEqual([4, 2]);
		const range = expandExcelSelection(sheet, { row: 0, col: 1 }, { row: 1, col: 1 });
		expect(range).toEqual({ startRow: 0, startCol: 0, endRow: 1, endCol: 1 });
		const context = excelSelectionContext(sheet, range);
		expect(context.target).toEqual({ kind: "spreadsheet", sheet: "收入", range: "C5:D6" });
		expect(JSON.parse(context.excerpt).cells).toContainEqual(
			expect.objectContaining({ address: "C5", value: 12, formula: "SUM(C6:C7)" }),
		);
		expect(JSON.parse(context.excerpt).cells).toContainEqual(
			expect.objectContaining({ address: "D5", mergedInto: "C5" }),
		);
	});
	it("stores only populated cells and merge anchors", () => {
		const sheet = XLSX.utils.aoa_to_sheet([
			["A", "B"],
			["", "2"],
		]);
		sheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 1 } }];
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, sheet, "Data");
		const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
		const view = parseExcelBytes(bytes, "a.xlsx");
		expect(view.sheetNames).toEqual(["Data"]);
		expect(view.sheets.Data.rowCount).toBe(2);
		expect(view.sheets.Data.colCount).toBe(2);
		expect(view.sheets.Data.cells.get("0:0")).toMatchObject({ formatted: "A", colSpan: 2 });
		expect(view.sheets.Data.cells.has("0:1")).toBe(false);
		expect(view.sheets.Data.cells.get("1:1")?.formatted).toBe("2");
		expect(view.sheets.Data.cells.size).toBe(2);
		expect(view.sheets.Data.merges).toEqual([{ row: 0, col: 0, rowSpan: 1, colSpan: 2, formatted: "A" }]);
		expect(paintedCellsForRow(view.sheets.Data, 0)).toEqual([
			{ col: 0, formatted: "A", covered: false, rowSpan: 1, colSpan: 2, type: "s" },
			{ col: 1, formatted: "", covered: true, rowSpan: 1, colSpan: 1 },
		]);
		expect(paintedCellsForRow(view.sheets.Data, 1)).toHaveLength(2);
	});

	it("parses csv without building a dense matrix", () => {
		const bytes = new TextEncoder().encode("h1,h2\n1,2\n");
		const view = parseExcelBytes(bytes, "a.csv");
		expect(view.sheets[view.activeSheet].cells.get("0:0")?.formatted).toBe("h1");
		expect(view.sheets[view.activeSheet].rowCount).toBe(2);
	});

	it("keeps vertical merges as overlays that still intersect later rows", () => {
		const sheet = XLSX.utils.aoa_to_sheet([
			["Title", "x"],
			["", "y"],
			["", "z"],
		]);
		sheet["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 2, c: 0 } }];
		const wb = XLSX.utils.book_new();
		XLSX.utils.book_append_sheet(wb, sheet, "Data");
		const bytes = new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
		const view = parseExcelBytes(bytes, "a.xlsx");
		expect(view.sheets.Data.merges).toEqual([{ row: 0, col: 0, rowSpan: 3, colSpan: 1, formatted: "Title" }]);
		expect(mergesInRowRange(view.sheets.Data.merges, 2, 2)).toHaveLength(1);
		expect(paintedCellsForRow(view.sheets.Data, 2)[0]).toMatchObject({ covered: true, formatted: "" });
	});
});

describe("spreadsheet preview limits", () => {
	const sheetOf = (values: Record<string, unknown>): XLSX.WorkSheet => values as unknown as XLSX.WorkSheet;
	const cell = (value: string | number): XLSX.CellObject => ({ t: typeof value === "number" ? "n" : "s", v: value });

	it("ignores a whole-sheet dimension left behind by formatting", () => {
		const view = parseSheetView("Data", sheetOf({ "!ref": "A1:XFD1048576", A1: cell("hi"), B2: cell(1) }));
		expect([view.startRow, view.startCol, view.rowCount, view.colCount]).toEqual([0, 0, 2, 2]);
		expect(view.cells.size).toBe(2);
	});

	it("rejects ranges that would stall rendering", () => {
		const wide = sheetOf({ A1: cell("a"), XFD10: cell("b") });
		expect(() => parseSheetView("Data", wide)).toThrow(SpreadsheetTooLargeError);
		const tall = sheetOf({ A1: cell("a"), A200001: cell("b") });
		expect(() => parseSheetView("Data", tall)).toThrow(SpreadsheetTooLargeError);
	});

	it("reports which limit a sheet exceeded", () => {
		const wide = sheetOf({ A1: cell("a"), XFD10: cell("b") });
		expect(() => parseSheetView("Data", wide)).toThrow(
			expect.objectContaining({ name: "SpreadsheetTooLargeError", reason: "columns" }),
		);
		const area = sheetOf({ A1: cell("a"), A50: cell("b") });
		expect(() => parseSheetView("Data", area, { ...DEFAULT_SPREADSHEET_LIMITS, maxArea: 40 })).toThrow(
			expect.objectContaining({ reason: "area" }),
		);
	});

	it("rejects sheets with more populated cells than the preview budget", () => {
		const dense = sheetOf({ A1: cell("a"), B1: cell("b"), C1: cell("c") });
		expect(() => parseSheetView("Data", dense, { ...DEFAULT_SPREADSHEET_LIMITS, maxCells: 2 })).toThrow(
			expect.objectContaining({ reason: "cells" }),
		);
	});

	it("skips oversized merge ranges that come from whole-sheet formatting", () => {
		const sheet = sheetOf({
			A1: cell("title"),
			"!merges": [{ s: { r: 0, c: 0 }, e: { r: 2_000_000, c: 0 } }],
		});
		const view = parseSheetView("Data", sheet);
		expect(view.rowCount).toBe(1);
		expect(view.merges).toEqual([]);
	});

	it("uses the workbook column widths and row heights", () => {
		const sheet = sheetOf({
			A1: cell("a"),
			B1: cell("b"),
			"!cols": [{ wpx: 96 }, { wpx: 160 }],
			"!rows": [{ hpt: 78 }],
		});
		const view = parseSheetView("Data", sheet);
		expect(view.columnWidths).toEqual([96, 160]);
		expect(view.rowHeights).toEqual([104]);
	});

	it("grows default-height rows enough to wrap long text", () => {
		const short = parseSheetView("Data", sheetOf({ A1: cell("hi") }));
		expect(short.rowHeights).toEqual([28]);
		const long = parseSheetView("Data", sheetOf({ A1: cell("很长的说明文字".repeat(30)) }));
		expect(long.rowHeights[0]).toBeGreaterThan(28);
	});

	it("keeps stored row heights even when text is long", () => {
		const sheet = sheetOf({ A1: cell("很长的说明文字".repeat(30)), "!rows": [{ hpt: 20 }] });
		expect(parseSheetView("Data", sheet).rowHeights).toEqual([27]);
	});

	it("rejects a workbook whose sheets together exceed the cell budget", () => {
		const workbook = {
			SheetNames: ["A", "B"],
			Sheets: { A: sheetOf({ A1: cell("a"), B1: cell("b") }), B: sheetOf({ A1: cell("c") }) },
		} as unknown as XLSX.WorkBook;
		expect(() => parseWorkbook(workbook, { ...DEFAULT_SPREADSHEET_LIMITS, maxCells: 2 })).toThrow(
			expect.objectContaining({ reason: "cells" }),
		);
	});
});

describe("layout offsets", () => {
	it("accumulates sizes and resolves positions to indices", () => {
		const offsets = prefixOffsets([96, 156, 156]);
		expect(offsets).toEqual([0, 96, 252, 408]);
		expect(offsetIndex(offsets, 0)).toBe(0);
		expect(offsetIndex(offsets, 95)).toBe(0);
		expect(offsetIndex(offsets, 96)).toBe(1);
		expect(offsetIndex(offsets, 251)).toBe(1);
		expect(offsetIndex(offsets, 252)).toBe(2);
		expect(offsetIndex(offsets, 10000)).toBe(3);
	});
});
