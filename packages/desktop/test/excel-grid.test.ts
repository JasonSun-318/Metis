import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import {
	excelSelectionContext,
	expandExcelSelection,
	mergesInRowRange,
	paintedCellsForRow,
	parseExcelBytes,
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
			{ col: 0, formatted: "A", covered: false, rowSpan: 1, colSpan: 2 },
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
