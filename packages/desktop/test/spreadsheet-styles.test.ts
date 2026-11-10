import { describe, expect, it } from "vitest";
import { parseSheetView } from "../src/renderer/components/preview/excel-grid.ts";
import {
	normalizeColor,
	parseCellStyleIndexes,
	parseStylesXml,
	styleAt,
} from "../src/renderer/components/preview/spreadsheet-styles.ts";

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8"?>
<x:styleSheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
	<x:fonts count="3">
		<x:font><x:sz val="11"/><x:color rgb="FF000000"/></x:font>
		<x:font><x:b/><x:sz val="22"/><x:color rgb="FF1F3864"/></x:font>
		<x:font><x:i/><x:sz val="9"/></x:font>
	</x:fonts>
	<x:fills count="3">
		<x:fill><x:patternFill patternType="none"/></x:fill>
		<x:fill><x:patternFill patternType="solid"><x:fgColor rgb="FFFFF2CC"/></x:patternFill></x:fill>
		<x:fill><x:patternFill patternType="solid"><x:fgColor rgb="FF1F3864"/></x:patternFill></x:fill>
	</x:fills>
	<x:borders count="2">
		<x:border/>
		<x:border><x:left style="thin"><x:color rgb="FFD0D0D0"/></x:left><x:bottom style="medium"/></x:border>
	</x:borders>
	<x:cellXfs count="4">
		<x:xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
		<x:xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1"><x:alignment horizontal="center" vertical="center" wrapText="1"/></x:xf>
		<x:xf numFmtId="0" fontId="2" fillId="1" borderId="0" xfId="0"/>
		<x:xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"><x:alignment horizontal="right" vertical="top"/></x:xf>
	</x:cellXfs>
</x:styleSheet>`;

const SHEET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
	<x:cols><x:col min="1" max="1" width="16" customWidth="1"/></x:cols>
	<x:sheetData>
		<x:row r="1"><x:c r="A1" s="1" t="s"><x:v>0</x:v></x:c><x:c r="B1" t="s"><x:v>1</x:v></x:c></x:row>
		<x:row r="2"><x:c r="A2" s="2" t="s"><x:v>2</x:v></x:c><x:c r="C3" s="3" t="s"><x:v>3</x:v></x:c></x:row>
	</x:sheetData>
</x:worksheet>`;

describe("parseStylesXml", () => {
	it("reads fonts, fills, borders and cell xf composition", () => {
		const table = parseStylesXml(STYLES_XML);
		expect(table.styles).toHaveLength(4);
		expect(table.styles[0]).toEqual({});
		expect(table.styles[1]).toEqual({
			font: { bold: true, size: 22, color: "#1F3864" },
			fill: "#1F3864",
			borders: { left: { style: "solid", width: 1, color: "#D0D0D0" }, bottom: { style: "solid", width: 2 } },
			align: "center",
			valign: "middle",
			wrap: true,
		});
		expect(table.styles[2]).toEqual({ font: { italic: true, size: 9 }, fill: "#FFF2CC" });
		expect(table.styles[3]).toEqual({ align: "right", valign: "top" });
	});

	it("tolerates a stylesheet without cell formats", () => {
		expect(parseStylesXml("<styleSheet/>").styles).toEqual([]);
		expect(parseStylesXml("").styles).toEqual([]);
	});
});

describe("normalizeColor", () => {
	it("normalizes 6- and 8-digit colors and rejects malformed values", () => {
		expect(normalizeColor("FFF2CC")).toBe("#FFF2CC");
		expect(normalizeColor("FFFFF2CC")).toBe("#FFF2CC");
		expect(normalizeColor("#1f3864")).toBe("#1F3864");
		expect(normalizeColor("not-a-color")).toBeUndefined();
		expect(normalizeColor("")).toBeUndefined();
		expect(normalizeColor(undefined)).toBeUndefined();
	});
});

describe("parseCellStyleIndexes", () => {
	it("maps worksheet coordinates to style indexes and skips unstyled cells", () => {
		const indexes = parseCellStyleIndexes(SHEET_XML);
		expect([...indexes.entries()].sort()).toEqual([
			["0:0", 1],
			["1:0", 2],
			["2:2", 3],
		]);
	});
});

describe("styleAt", () => {
	it("returns undefined for missing or out-of-range indexes", () => {
		const table = parseStylesXml(STYLES_XML);
		expect(styleAt(table, undefined)).toBeUndefined();
		expect(styleAt(table, 0)).toEqual({});
		expect(styleAt(table, 99)).toBeUndefined();
	});
});

describe("parseSheetView with an OOXML style overlay", () => {
	const sheet = {
		A1: { t: "s" as const, v: "标题" },
		B1: { t: "n" as const, v: 3 },
		A2: { t: "s" as const, v: "说明" },
	} as unknown as import("xlsx").WorkSheet;

	it("applies font, alignment, wrapping and borders to cells", () => {
		const view = parseSheetView("Data", sheet, undefined, new Map([["0:0", parseStylesXml(STYLES_XML).styles[1]!]]));
		expect(view.cells.get("0:0")).toMatchObject({
			font: { bold: true, size: 22, color: "#1F3864" },
			fill: "#1F3864",
			align: "center",
			valign: "middle",
			wrap: true,
			borders: { left: { style: "solid", width: 1, color: "#D0D0D0" } },
		});
	});

	it("keeps explicit clip behavior and leaves unstyled cells untouched", () => {
		const noWrap = { ...parseStylesXml(STYLES_XML).styles[1]!, wrap: false };
		const view = parseSheetView("Data", sheet, undefined, new Map([["0:0", noWrap]]));
		expect(view.cells.get("0:0")?.wrap).toBe(false);
		expect(view.cells.get("1:0")?.font).toBeUndefined();
	});
});
