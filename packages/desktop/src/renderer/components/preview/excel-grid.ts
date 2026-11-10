import * as XLSX from "xlsx";

/**
 * Rendering guards. The viewer draws every column of the used range on each
 * visible row and materializes each populated cell, so a workbook that declares
 * a whole-sheet dimension (for example after formatting entire columns) or
 * scatters cells across a huge range would otherwise freeze the renderer. The
 * limits keep ordinary spreadsheets previewable and reject pathological ranges
 * with a clear message.
 */
export interface SpreadsheetPreviewLimits {
	readonly maxRows: number;
	readonly maxColumns: number;
	readonly maxCells: number;
	readonly maxArea: number;
	readonly maxMergeCells: number;
}

export const DEFAULT_SPREADSHEET_LIMITS: SpreadsheetPreviewLimits = {
	maxRows: 200_000,
	maxColumns: 1_024,
	maxCells: 200_000,
	maxArea: 2_000_000,
	maxMergeCells: 100_000,
};

export type SpreadsheetLimitReason = "rows" | "columns" | "area" | "cells";

/** Thrown when a worksheet cannot be previewed without exhausting the renderer. */
export class SpreadsheetTooLargeError extends Error {
	readonly reason: SpreadsheetLimitReason;

	constructor(reason: SpreadsheetLimitReason) {
		super(`Spreadsheet preview limit exceeded (${reason})`);
		this.name = "SpreadsheetTooLargeError";
		this.reason = reason;
	}
}

export interface ExcelCellView {
	readonly formatted: string;
	readonly value?: string | number | boolean | null;
	readonly formula?: string;
	readonly type?: string;
	readonly rowSpan?: number;
	readonly colSpan?: number;
	/** Solid fill as `#RRGGBB`; styles other than solid fills are not exposed. */
	readonly fill?: string;
}

export interface ExcelMergeView {
	readonly row: number;
	readonly col: number;
	readonly rowSpan: number;
	readonly colSpan: number;
	readonly formatted: string;
	readonly fill?: string;
}

export interface ExcelSheetView {
	readonly name: string;
	readonly startRow: number;
	readonly startCol: number;
	readonly rowCount: number;
	readonly colCount: number;
	readonly cells: ReadonlyMap<string, ExcelCellView>;
	readonly hidden: ReadonlySet<string>;
	readonly merges: readonly ExcelMergeView[];
	/** Column widths in CSS pixels, taken from the workbook when it stores them. */
	readonly columnWidths: readonly number[];
	/** Row heights in CSS pixels, stored by the workbook or estimated from wrapped text. */
	readonly rowHeights: readonly number[];
}

export interface ExcelWorkbookView {
	readonly sheetNames: readonly string[];
	readonly activeSheet: string;
	readonly sheets: Record<string, ExcelSheetView>;
}

export function cellKey(row: number, col: number): string {
	return `${row}:${col}`;
}

export interface ExcelPaintedCell {
	readonly col: number;
	readonly formatted: string;
	readonly covered: boolean;
	readonly rowSpan: number;
	readonly colSpan: number;
	readonly type?: string;
	readonly fill?: string;
}

export function paintedCellsForRow(sheet: ExcelSheetView, row: number): readonly ExcelPaintedCell[] {
	return Array.from({ length: sheet.colCount }, (_, col) => {
		const cell = sheet.cells.get(cellKey(row, col));
		return {
			col,
			formatted: cell?.formatted ?? "",
			covered: sheet.hidden.has(cellKey(row, col)),
			rowSpan: cell?.rowSpan ?? 1,
			colSpan: cell?.colSpan ?? 1,
			...(cell?.type ? { type: cell.type } : {}),
			...(cell?.fill ? { fill: cell.fill } : {}),
		};
	});
}

export function mergesInRowRange(
	merges: readonly ExcelMergeView[],
	fromRow: number,
	toRow: number,
): readonly ExcelMergeView[] {
	return merges.filter((merge) => merge.row <= toRow && merge.row + merge.rowSpan - 1 >= fromRow);
}

const CELL_ADDRESS = /^[A-Za-z]{1,3}[0-9]{1,7}$/;
const DEFAULT_COLUMN_WIDTH = 112;
const MIN_COLUMN_WIDTH = 40;
const MAX_COLUMN_WIDTH = 480;
const DEFAULT_ROW_HEIGHT = 28;
const MIN_ROW_HEIGHT = 16;
const MAX_ROW_HEIGHT = 400;
const CELL_LINE_HEIGHT = 16;
const CELL_VERTICAL_PADDING = 8;
const CELL_HORIZONTAL_PADDING = 16;
const NARROW_CHARACTER_WIDTH = 7;
const WIDE_CHARACTER_WIDTH = 11;

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/** Cumulative pixel offsets for a list of sizes, with a trailing total. */
export function prefixOffsets(sizes: readonly number[]): readonly number[] {
	const offsets = new Array<number>(sizes.length + 1);
	offsets[0] = 0;
	for (let index = 0; index < sizes.length; index += 1) {
		offsets[index + 1] = (offsets[index] ?? 0) + (sizes[index] ?? 0);
	}
	return offsets;
}

/** Greatest index whose offset is at or before the given position. */
export function offsetIndex(offsets: readonly number[], position: number): number {
	let low = 0;
	let high = Math.max(0, offsets.length - 1);
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if ((offsets[middle] ?? 0) <= position) low = middle;
		else high = middle - 1;
	}
	return low;
}

function cellFill(cell: XLSX.CellObject): string | undefined {
	const style = (
		cell as unknown as {
			readonly s?: { readonly patternType?: string; readonly fgColor?: { readonly rgb?: string } };
		}
	).s;
	if (!style || style.patternType !== "solid") return undefined;
	const rgb = style.fgColor?.rgb;
	if (typeof rgb !== "string") return undefined;
	const hex = rgb.length === 8 ? rgb.slice(2) : rgb;
	return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toUpperCase()}` : undefined;
}

/** Black or white text, whichever contrasts with the fill. */
export function readableTextColor(fill: string): string {
	const red = Number.parseInt(fill.slice(1, 3), 16);
	const green = Number.parseInt(fill.slice(3, 5), 16);
	const blue = Number.parseInt(fill.slice(5, 7), 16);
	const luminance = (0.299 * red + 0.587 * green + 0.114 * blue) / 255;
	return luminance > 0.6 ? "#111111" : "#FFFFFF";
}

/** Approximates the rendered width of one line of the 11px monospace cell font. */
function measureTextWidth(text: string): number {
	let width = 0;
	for (const character of text) {
		// CJK ideographs and full-width punctuation occupy a full monospace cell.
		width += /[\u2e80-\u9fff\uff00-\uffef]/.test(character) ? WIDE_CHARACTER_WIDTH : NARROW_CHARACTER_WIDTH;
	}
	return width;
}

function decodeCellAddress(key: string): { row: number; column: number } | undefined {
	if (!CELL_ADDRESS.test(key)) return undefined;
	const address = XLSX.utils.decode_cell(key);
	if (!Number.isFinite(address.r) || !Number.isFinite(address.c)) return undefined;
	return { row: address.r, column: address.c };
}

function isUsableRange(value: XLSX.Range | undefined): value is XLSX.Range {
	return (
		!!value &&
		[value.s?.r, value.s?.c, value.e?.r, value.e?.c].every((coordinate) => Number.isFinite(coordinate)) &&
		value.e.r >= value.s.r &&
		value.e.c >= value.s.c
	);
}

function emptySheetView(name: string): ExcelSheetView {
	return {
		name,
		startRow: 0,
		startCol: 0,
		rowCount: 0,
		colCount: 0,
		cells: new Map(),
		hidden: new Set(),
		merges: [],
		columnWidths: [],
		rowHeights: [],
	};
}

/**
 * Builds one sheet view from the populated cells instead of walking the declared
 * `!ref` rectangle: a stale whole-sheet dimension must not cost rows × columns
 * iterations, and the preview only needs cells that actually exist.
 */
export function parseSheetView(
	name: string,
	sheet: XLSX.WorkSheet,
	limits: SpreadsheetPreviewLimits = DEFAULT_SPREADSHEET_LIMITS,
): ExcelSheetView {
	const entries = Object.entries(sheet as unknown as Record<string, unknown>);
	const rawCells: { row: number; column: number; cell: XLSX.CellObject }[] = [];
	let startRow = Number.POSITIVE_INFINITY;
	let startCol = Number.POSITIVE_INFINITY;
	let endRow = -1;
	let endCol = -1;
	for (const [key, value] of entries) {
		const address = decodeCellAddress(key);
		if (!address || !value || typeof value !== "object") continue;
		rawCells.push({ row: address.row, column: address.column, cell: value as XLSX.CellObject });
		startRow = Math.min(startRow, address.row);
		startCol = Math.min(startCol, address.column);
		endRow = Math.max(endRow, address.row);
		endCol = Math.max(endCol, address.column);
	}
	const mergeRanges: XLSX.Range[] = [];
	for (const merge of sheet["!merges"] ?? []) {
		if (!isUsableRange(merge)) continue;
		const rowSpan = merge.e.r - merge.s.r + 1;
		const colSpan = merge.e.c - merge.s.c + 1;
		// Oversized merges come from whole-sheet formatting, not from content: skip
		// them so they neither extend the grid nor cost span iterations.
		if (rowSpan * colSpan > limits.maxMergeCells) continue;
		mergeRanges.push(merge);
		startRow = Math.min(startRow, merge.s.r);
		startCol = Math.min(startCol, merge.s.c);
		endRow = Math.max(endRow, merge.e.r);
		endCol = Math.max(endCol, merge.e.c);
	}
	if (endRow < 0 || endCol < 0) return emptySheetView(name);
	const rowCount = endRow - startRow + 1;
	const colCount = endCol - startCol + 1;
	if (rowCount > limits.maxRows) throw new SpreadsheetTooLargeError("rows");
	if (colCount > limits.maxColumns) throw new SpreadsheetTooLargeError("columns");
	if (rowCount * colCount > limits.maxArea) throw new SpreadsheetTooLargeError("area");
	const cells = new Map<string, ExcelCellView>();
	const hidden = new Set<string>();
	for (const { row, column, cell } of rawCells) {
		const formatted = cell.w ?? (cell.v !== undefined ? String(cell.v) : "");
		if (formatted === "" && !cell.f) continue;
		if (cells.size >= limits.maxCells) throw new SpreadsheetTooLargeError("cells");
		const fill = cellFill(cell);
		cells.set(cellKey(row - startRow, column - startCol), {
			formatted,
			value: cell.v instanceof Date ? cell.v.toISOString() : (cell.v ?? null),
			type: cell.t,
			...(cell.f ? { formula: cell.f } : {}),
			...(fill ? { fill } : {}),
		});
	}
	const merges: ExcelMergeView[] = [];
	for (const merge of mergeRanges) {
		const row = merge.s.r - startRow;
		const col = merge.s.c - startCol;
		const rowSpan = merge.e.r - merge.s.r + 1;
		const colSpan = merge.e.c - merge.s.c + 1;
		const key = cellKey(row, col);
		const existing = cells.get(key) ?? { formatted: "" };
		cells.set(key, {
			...existing,
			rowSpan: rowSpan > 1 ? rowSpan : undefined,
			colSpan: colSpan > 1 ? colSpan : undefined,
		});
		if (rowSpan > 1 || colSpan > 1) {
			merges.push({
				row,
				col,
				rowSpan,
				colSpan,
				formatted: existing.formatted,
				...(existing.fill ? { fill: existing.fill } : {}),
			});
		}
		for (let mergedRow = row; mergedRow < row + rowSpan; mergedRow += 1) {
			for (let mergedCol = col; mergedCol < col + colSpan; mergedCol += 1) {
				if (mergedRow === row && mergedCol === col) continue;
				hidden.add(cellKey(mergedRow, mergedCol));
				cells.delete(cellKey(mergedRow, mergedCol));
			}
		}
	}
	const sheetLayout = sheet as unknown as {
		readonly "!cols"?: readonly ({ readonly wpx?: number; readonly wch?: number } | undefined)[];
		readonly "!rows"?: readonly ({ readonly hpt?: number } | undefined)[];
	};
	const columnWidths = Array.from({ length: colCount }, (_, index) => {
		const stored = sheetLayout["!cols"]?.[startCol + index];
		const pixels =
			typeof stored?.wpx === "number"
				? stored.wpx
				: typeof stored?.wch === "number"
					? stored.wch * 7 + 5
					: DEFAULT_COLUMN_WIDTH;
		return clamp(Math.round(pixels), MIN_COLUMN_WIDTH, MAX_COLUMN_WIDTH);
	});
	const storedRows = sheetLayout["!rows"];
	const rowHeights = Array.from({ length: rowCount }, (_, index) => {
		const points = storedRows?.[startRow + index]?.hpt;
		return points !== undefined && points > 0
			? clamp(Math.round((points * 4) / 3), MIN_ROW_HEIGHT, MAX_ROW_HEIGHT)
			: DEFAULT_ROW_HEIGHT;
	});
	// Rows the workbook leaves on the default height grow when wrapped text needs
	// more lines; stored heights are authoritative because Excel already wrapped.
	for (let index = 0; index < rowCount; index += 1) {
		if (storedRows?.[startRow + index]?.hpt) continue;
		let required = DEFAULT_ROW_HEIGHT;
		for (let column = 0; column < colCount; column += 1) {
			const cell = cells.get(cellKey(index, column));
			if (!cell) continue;
			let available = 0;
			for (let offset = 0; offset < (cell.colSpan ?? 1); offset += 1) {
				available += columnWidths[column + offset] ?? DEFAULT_COLUMN_WIDTH;
			}
			const lineWidth = Math.max(available - CELL_HORIZONTAL_PADDING, MIN_COLUMN_WIDTH);
			const lines = Math.max(1, Math.ceil(measureTextWidth(cell.formatted) / lineWidth));
			required = Math.max(
				required,
				clamp(lines * CELL_LINE_HEIGHT + CELL_VERTICAL_PADDING, MIN_ROW_HEIGHT, MAX_ROW_HEIGHT),
			);
		}
		rowHeights[index] = required;
	}
	return { name, startRow, startCol, rowCount, colCount, cells, hidden, merges, columnWidths, rowHeights };
}

export function parseWorkbook(
	workbook: XLSX.WorkBook,
	limits: SpreadsheetPreviewLimits = DEFAULT_SPREADSHEET_LIMITS,
): ExcelWorkbookView {
	const sheets: Record<string, ExcelSheetView> = {};
	let totalCells = 0;
	for (const name of workbook.SheetNames) {
		const sheet = workbook.Sheets[name];
		if (!sheet) continue;
		const view = parseSheetView(name, sheet, limits);
		totalCells += view.cells.size;
		if (totalCells > limits.maxCells) throw new SpreadsheetTooLargeError("cells");
		sheets[name] = view;
	}
	const sheetNames = workbook.SheetNames;
	return { sheetNames, activeSheet: sheetNames[0] ?? "", sheets };
}

export function parseExcelBytes(
	bytes: Uint8Array,
	fileName: string,
	limits: SpreadsheetPreviewLimits = DEFAULT_SPREADSHEET_LIMITS,
): ExcelWorkbookView {
	const isCsv = fileName.toLowerCase().endsWith(".csv");
	const workbook = isCsv
		? XLSX.read(new TextDecoder().decode(bytes), { type: "string", cellDates: true, cellStyles: true })
		: XLSX.read(bytes, { type: "array", cellDates: true, cellStyles: true });
	return parseWorkbook(workbook, limits);
}

export interface ExcelSelection {
	startRow: number;
	startCol: number;
	endRow: number;
	endCol: number;
}

export function expandExcelSelection(
	sheet: ExcelSheetView,
	first: { row: number; col: number },
	last: { row: number; col: number },
): ExcelSelection {
	const range = {
		startRow: Math.min(first.row, last.row),
		startCol: Math.min(first.col, last.col),
		endRow: Math.max(first.row, last.row),
		endCol: Math.max(first.col, last.col),
	};
	let changed = true;
	while (changed) {
		changed = false;
		for (const m of sheet.merges) {
			const bottom = m.row + m.rowSpan - 1,
				right = m.col + m.colSpan - 1;
			if (m.row > range.endRow || bottom < range.startRow || m.col > range.endCol || right < range.startCol)
				continue;
			if (m.row < range.startRow || m.col < range.startCol || bottom > range.endRow || right > range.endCol) {
				range.startRow = Math.min(range.startRow, m.row);
				range.startCol = Math.min(range.startCol, m.col);
				range.endRow = Math.max(range.endRow, bottom);
				range.endCol = Math.max(range.endCol, right);
				changed = true;
			}
		}
	}
	return range;
}

export function excelSelectionContext(sheet: ExcelSheetView, range: ExcelSelection) {
	const address = XLSX.utils.encode_range({
		s: { r: sheet.startRow + range.startRow, c: sheet.startCol + range.startCol },
		e: { r: sheet.startRow + range.endRow, c: sheet.startCol + range.endCol },
	});
	const cells: {
		address: string;
		value: ExcelCellView["value"];
		formatted: string;
		formula?: string;
		type?: string;
		mergedInto?: string;
	}[] = [];
	const total = (range.endRow - range.startRow + 1) * (range.endCol - range.startCol + 1);
	outer: for (let row = range.startRow; row <= range.endRow; row++)
		for (let col = range.startCol; col <= range.endCol; col++) {
			const cell = sheet.cells.get(cellKey(row, col));
			const merge = sheet.merges.find(
				(m) => row >= m.row && row < m.row + m.rowSpan && col >= m.col && col < m.col + m.colSpan,
			);
			const next = {
				address: XLSX.utils.encode_cell({ r: sheet.startRow + row, c: sheet.startCol + col }),
				value: cell?.value ?? null,
				formatted: cell?.formatted ?? "",
				...(cell?.formula ? { formula: cell.formula } : {}),
				...(cell?.type ? { type: cell.type } : {}),
				...(merge && (merge.row !== row || merge.col !== col)
					? {
							mergedInto: XLSX.utils.encode_cell({
								r: sheet.startRow + merge.row,
								c: sheet.startCol + merge.col,
							}),
						}
					: {}),
			};
			if (cells.length >= 32 || JSON.stringify([...cells, next]).length > 3400) break outer;
			cells.push(next);
		}
	const truncated = cells.length < total;
	return {
		target: { kind: "spreadsheet" as const, sheet: sheet.name, range: address },
		text: `${sheet.name}!${address}\n${cells.map((c) => `${c.address}: ${c.formatted}${c.formula ? ` [=${c.formula}]` : ""}`).join("\n")}${truncated ? "\n… (partial snapshot)" : ""}`,
		excerpt: JSON.stringify({ cells, totalCells: total, truncated }),
	};
}
