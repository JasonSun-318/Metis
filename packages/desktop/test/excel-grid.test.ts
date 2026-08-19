import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";
import { parseExcelBytes } from "../src/renderer/components/preview/excel-grid.ts";

describe("parseExcelBytes", () => {
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
	});

	it("parses csv without building a dense matrix", () => {
		const bytes = new TextEncoder().encode("h1,h2\n1,2\n");
		const view = parseExcelBytes(bytes, "a.csv");
		expect(view.sheets[view.activeSheet].cells.get("0:0")?.formatted).toBe("h1");
		expect(view.sheets[view.activeSheet].rowCount).toBe(2);
	});
});
