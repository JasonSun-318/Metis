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
}

export interface ExcelMergeView {
	readonly row: number;
	readonly col: number;
	readonly rowSpan: number;
	readonly colSpan: number;
	readonly formatted: string;
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
		cells.set(cellKey(row - startRow, column - startCol), {
			formatted,
			value: cell.v instanceof Date ? cell.v.toISOString() : (cell.v ?? null),
			type: cell.t,
			...(cell.f ? { formula: cell.f } : {}),
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
			merges.push({ row, col, rowSpan, colSpan, formatted: existing.formatted });
		}
		for (let mergedRow = row; mergedRow < row + rowSpan; mergedRow += 1) {
			for (let mergedCol = col; mergedCol < col + colSpan; mergedCol += 1) {
				if (mergedRow === row && mergedCol === col) continue;
				hidden.add(cellKey(mergedRow, mergedCol));
				cells.delete(cellKey(mergedRow, mergedCol));
			}
		}
	}
	return { name, startRow, startCol, rowCount, colCount, cells, hidden, merges };
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
		? XLSX.read(new TextDecoder().decode(bytes), { type: "string", cellDates: true })
		: XLSX.read(bytes, { type: "array", cellDates: true });
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
