import * as XLSX from "xlsx";

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
				if (formatted === "" && !cell.f) continue;
				cells.set(cellKey(row - range.s.r, col - range.s.c), {
					formatted,
					value: cell.v instanceof Date ? cell.v.toISOString() : (cell.v ?? null),
					type: cell.t,
					...(cell.f ? { formula: cell.f } : {}),
				});
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
		sheets[name] = { name, startRow: range.s.r, startCol: range.s.c, rowCount, colCount, cells, hidden, merges };
	}
	const sheetNames = workbook.SheetNames;
	return { sheetNames, activeSheet: sheetNames[0] ?? "", sheets };
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
