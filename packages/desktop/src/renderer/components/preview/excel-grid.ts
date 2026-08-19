import * as XLSX from "xlsx";

export interface ExcelCellView {
	readonly formatted: string;
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

export function parseExcelBytes(bytes: Uint8Array, fileName: string): ExcelWorkbookView {
	const isCsv = fileName.toLowerCase().endsWith(".csv");
	const workbook = isCsv
		? XLSX.read(new TextDecoder().decode(bytes), { type: "string", cellDates: true })
		: XLSX.read(bytes, { type: "array", cellDates: true });
	const sheets: Record<string, ExcelSheetView> = {};
	for (const name of workbook.SheetNames) {
		const sheet = workbook.Sheets[name];
		if (!sheet) continue;
		const ref = sheet["!ref"];
		const range = ref ? XLSX.utils.decode_range(ref) : { s: { r: 0, c: 0 }, e: { r: -1, c: -1 } };
		const rowCount = range.e.r >= range.s.r ? range.e.r - range.s.r + 1 : 0;
		const colCount = range.e.c >= range.s.c ? range.e.c - range.s.c + 1 : 0;
		const cells = new Map<string, ExcelCellView>();
		const hidden = new Set<string>();
		const merges: ExcelMergeView[] = [];
		for (let row = range.s.r; row <= range.e.r; row += 1) {
			for (let col = range.s.c; col <= range.e.c; col += 1) {
				const cell = sheet[XLSX.utils.encode_cell({ r: row, c: col })];
				if (!cell) continue;
				const formatted = cell.w ?? (cell.v !== undefined ? String(cell.v) : "");
				if (formatted === "") continue;
				cells.set(cellKey(row - range.s.r, col - range.s.c), { formatted });
			}
		}
		for (const merge of sheet["!merges"] ?? []) {
			const startRow = merge.s.r - range.s.r;
			const startCol = merge.s.c - range.s.c;
			const rowSpan = merge.e.r - merge.s.r + 1;
			const colSpan = merge.e.c - merge.s.c + 1;
			const key = cellKey(startRow, startCol);
			const existing = cells.get(key) ?? { formatted: "" };
			cells.set(key, {
				...existing,
				rowSpan: rowSpan > 1 ? rowSpan : undefined,
				colSpan: colSpan > 1 ? colSpan : undefined,
			});
			if (rowSpan > 1 || colSpan > 1) {
				merges.push({
					row: startRow,
					col: startCol,
					rowSpan,
					colSpan,
					formatted: existing.formatted,
				});
			}
			for (let row = startRow; row < startRow + rowSpan; row += 1) {
				for (let col = startCol; col < startCol + colSpan; col += 1) {
					if (row === startRow && col === startCol) continue;
					hidden.add(cellKey(row, col));
					cells.delete(cellKey(row, col));
				}
			}
		}
		sheets[name] = { name, rowCount, colCount, cells, hidden, merges };
	}
	const sheetNames = workbook.SheetNames;
	return { sheetNames, activeSheet: sheetNames[0] ?? "", sheets };
}
