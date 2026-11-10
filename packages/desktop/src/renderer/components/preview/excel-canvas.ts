// Canvas renderer for the spreadsheet preview. The grid is drawn the way the
// workbook authors it - fonts, borders, fills, merges and wrapping - instead of
// mapping every cell to a DOM node. Only the visible rectangle is painted, so
// large sheets scroll without mounting thousands of elements.

import type { ExcelCellView, ExcelMergeView, ExcelSheetView } from "./excel-grid.ts";
import { offsetIndex, readableTextColor } from "./excel-grid.ts";

export interface SheetCanvasTheme {
	readonly background: string;
	readonly text: string;
	readonly border: string;
	readonly headerBackground: string;
	readonly headerText: string;
	readonly searchFill: string;
	readonly searchText: string;
}

export interface SheetCanvasLayout {
	readonly columnWidths: readonly number[];
	readonly rowHeights: readonly number[];
	readonly columnOffsets: readonly number[];
	readonly rowOffsets: readonly number[];
	readonly indexWidth: number;
	readonly headerHeight: number;
	readonly totalWidth: number;
	readonly totalHeight: number;
}

export interface SheetScroll {
	readonly left: number;
	readonly top: number;
}

export interface SheetViewport {
	readonly width: number;
	readonly height: number;
}

export interface SheetSelectionRect {
	readonly startRow: number;
	readonly startCol: number;
	readonly endRow: number;
	readonly endCol: number;
}

export interface DrawSheetOptions {
	readonly context: CanvasRenderingContext2D;
	readonly sheet: ExcelSheetView;
	readonly layout: SheetCanvasLayout;
	readonly scroll: SheetScroll;
	readonly viewport: SheetViewport;
	readonly theme: SheetCanvasTheme;
	readonly query: string;
	readonly scale: number;
	readonly selection?: SheetSelectionRect | null;
}

const INDEX_WIDTH = 44;
const DEFAULT_HEADER_HEIGHT = 28;
const CELL_PADDING_X = 8;
const CELL_PADDING_Y = 4;
const DEFAULT_FONT_SIZE = 11;
const LINE_HEIGHT_RATIO = 1.4;
const MIN_COLUMN_WIDTH = 24;
const MAX_FONT_SIZE = 48;

export function buildSheetLayout(
	sheet: ExcelSheetView,
	scale: number,
	indexWidth = INDEX_WIDTH,
	headerHeight = DEFAULT_HEADER_HEIGHT,
): SheetCanvasLayout {
	const columnWidths = sheet.columnWidths.map((width) => Math.max(MIN_COLUMN_WIDTH, Math.round(width * scale)));
	const rowHeights = sheet.rowHeights.map((height) => Math.max(12, Math.round(height * scale)));
	const scaledIndexWidth = Math.max(36, Math.round(indexWidth * scale));
	const scaledHeaderHeight = Math.max(18, Math.round(headerHeight * scale));
	const columnOffsets = prefixSums(columnWidths);
	const rowOffsets = prefixSums(rowHeights);
	return {
		columnWidths,
		rowHeights,
		columnOffsets,
		rowOffsets,
		indexWidth: scaledIndexWidth,
		headerHeight: scaledHeaderHeight,
		totalWidth: scaledIndexWidth + (columnOffsets[columnOffsets.length - 1] ?? 0),
		totalHeight: scaledHeaderHeight + (rowOffsets[rowOffsets.length - 1] ?? 0),
	};
}

function prefixSums(sizes: readonly number[]): readonly number[] {
	const offsets = new Array<number>(sizes.length + 1);
	offsets[0] = 0;
	for (let index = 0; index < sizes.length; index += 1) {
		offsets[index + 1] = (offsets[index] ?? 0) + (sizes[index] ?? 0);
	}
	return offsets;
}

/** Inclusive index range intersecting [scroll, scroll + viewport). */
export function visibleRange(
	offsets: readonly number[],
	scroll: number,
	viewport: number,
): { readonly start: number; readonly end: number } {
	const count = Math.max(0, offsets.length - 1);
	if (count === 0) return { start: 0, end: -1 };
	const start = Math.max(0, Math.min(count - 1, offsetIndex(offsets, scroll)));
	const end = Math.max(start, Math.min(count - 1, offsetIndex(offsets, scroll + viewport - 1)));
	return { start, end };
}

/** Splits text into lines that fit `maxWidth`, honoring explicit newlines. */
export function wrapTextLines(text: string, maxWidth: number, measure: (value: string) => number): readonly string[] {
	if (maxWidth <= 0) return [text];
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		let current = "";
		const push = () => {
			lines.push(current);
			current = "";
		};
		for (const segment of splitSegments(paragraph)) {
			if (current.length > 0 && measure(current + segment) > maxWidth) push();
			if (measure(segment) <= maxWidth) {
				current += segment;
				continue;
			}
			// A single segment wider than the cell: split per character.
			for (const character of segment) {
				if (current.length > 0 && measure(current + character) > maxWidth) push();
				current += character;
			}
		}
		push();
	}
	return lines.length > 0 ? lines : [""];
}

/** Word-like segments: keep latin runs together, break between CJK characters. */
function splitSegments(text: string): readonly string[] {
	const segments: string[] = [];
	let latin = "";
	const flush = () => {
		if (latin.length > 0) {
			segments.push(latin);
			latin = "";
		}
	};
	for (const character of text) {
		if (/[\u2e80-\u9fff\uff00-\uffef\s]/.test(character)) {
			flush();
			segments.push(character);
		} else {
			latin += character;
		}
	}
	flush();
	return segments;
}

function hexToRgb(color: string): readonly [number, number, number] | undefined {
	const hex = color.replace("#", "");
	if (!/^[0-9a-fA-F]{6}$/.test(hex)) return undefined;
	return [
		Number.parseInt(hex.slice(0, 2), 16),
		Number.parseInt(hex.slice(2, 4), 16),
		Number.parseInt(hex.slice(4, 6), 16),
	];
}

function withAlpha(color: string, alpha: number): string {
	const rgb = hexToRgb(color);
	return rgb ? `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})` : color;
}

function relativeLuminance(color: string): number {
	const rgb = hexToRgb(color);
	if (!rgb) return 0;
	const channel = (value: number) => {
		const normalized = value / 255;
		return normalized <= 0.03928 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * channel(rgb[0]) + 0.7152 * channel(rgb[1]) + 0.0722 * channel(rgb[2]);
}

function contrastRatio(left: string, right: string): number {
	const brighter = Math.max(relativeLuminance(left), relativeLuminance(right));
	const darker = Math.min(relativeLuminance(left), relativeLuminance(right));
	return (brighter + 0.05) / (darker + 0.05);
}

function fontSpec(
	style: ExcelCellView | ExcelMergeView,
	scale: number,
): { readonly css: string; readonly size: number } {
	const font = style.font;
	const size = font?.size ? Math.min(MAX_FONT_SIZE, Math.max(8, Math.round(font.size * scale))) : DEFAULT_FONT_SIZE;
	const weight = font?.bold ? "600" : "400";
	const italic = font?.italic ? "italic " : "";
	return { css: `${italic}${weight} ${size}px ui-monospace, SFMono-Regular, Menlo, monospace`, size };
}

function textColorFor(style: ExcelCellView | ExcelMergeView, theme: SheetCanvasTheme, highlighted: boolean): string {
	if (highlighted) return theme.searchText;
	const fontColor = style.font?.color;
	if (fontColor && contrastRatio(fontColor, style.fill ?? theme.background) >= 3) return fontColor;
	if (style.fill) return readableTextColor(style.fill);
	return theme.text;
}

function horizontalAlign(style: ExcelCellView | ExcelMergeView, type: string | undefined): "left" | "center" | "right" {
	if (style.align) return style.align;
	return type === "n" || type === "d" ? "right" : "left";
}

function fillRect(
	context: CanvasRenderingContext2D,
	x: number,
	y: number,
	width: number,
	height: number,
	fill: string | undefined,
): void {
	if (!fill) return;
	context.fillStyle = fill;
	context.fillRect(x, y, width, height);
}

function drawBorders(
	context: CanvasRenderingContext2D,
	style: ExcelCellView | ExcelMergeView | undefined,
	x: number,
	y: number,
	width: number,
	height: number,
	theme: SheetCanvasTheme,
	scale: number,
): void {
	const borders = style?.borders;
	const sides: readonly [string, number, number, number, number][] = [
		["top", x, y, width, 0],
		["right", x + width, y, 0, height],
		["bottom", x, y + height, width, 0],
		["left", x, y, 0, height],
	];
	for (const [side, sx, sy, lineWidth, lineHeight] of sides) {
		const border = borders?.[side as "top" | "right" | "bottom" | "left"];
		context.strokeStyle = border?.color ?? theme.border;
		context.lineWidth = border ? Math.max(1, Math.round(border.width * scale)) : 1;
		context.setLineDash(border?.style === "dashed" ? [4, 3] : border?.style === "dotted" ? [1, 2] : []);
		context.beginPath();
		const align = 0.5 * (context.lineWidth % 2);
		if (lineWidth >= lineHeight) {
			context.moveTo(sx, Math.round(sy) + align);
			context.lineTo(sx + lineWidth, Math.round(sy) + align);
		} else {
			context.moveTo(Math.round(sx) + align, sy);
			context.lineTo(Math.round(sx) + align, sy + lineHeight);
		}
		context.stroke();
	}
	context.setLineDash([]);
}

function drawCellText(
	context: CanvasRenderingContext2D,
	style: ExcelCellView | ExcelMergeView,
	type: string | undefined,
	x: number,
	y: number,
	width: number,
	height: number,
	scale: number,
	theme: SheetCanvasTheme,
	highlighted: boolean,
): void {
	const text = style.formatted;
	if (text === "") return;
	const { css, size } = fontSpec(style, scale);
	context.save();
	context.font = css;
	context.fillStyle = textColorFor(style, theme, highlighted);
	context.textBaseline = "alphabetic";
	context.beginPath();
	context.rect(x + 1, y + 1, Math.max(0, width - 2), Math.max(0, height - 2));
	context.clip();
	const maxWidth = Math.max(1, width - CELL_PADDING_X * 2);
	const lines =
		style.wrap === false ? [text] : wrapTextLines(text, maxWidth, (value) => context.measureText(value).width);
	const lineHeight = size * LINE_HEIGHT_RATIO;
	const align = horizontalAlign(style, type);
	const textX =
		align === "right" ? x + width - CELL_PADDING_X : align === "center" ? x + width / 2 : x + CELL_PADDING_X;
	context.textAlign = align === "right" ? "right" : align === "center" ? "center" : "left";
	const blockHeight = lines.length * lineHeight;
	const available = height - CELL_PADDING_Y * 2;
	const blockTop =
		style.valign === "middle"
			? y + CELL_PADDING_Y + Math.max(0, (available - blockHeight) / 2)
			: style.valign === "bottom"
				? y + height - CELL_PADDING_Y - blockHeight
				: y + CELL_PADDING_Y;
	lines.forEach((line, index) => {
		const baseline = blockTop + index * lineHeight + lineHeight / 2 + size / 3;
		if (baseline > y + height + size) return;
		context.fillText(line, textX, baseline);
	});
	context.restore();
}

function drawGridHeaders(
	context: CanvasRenderingContext2D,
	layout: SheetCanvasLayout,
	scroll: SheetScroll,
	viewport: SheetViewport,
	sheet: ExcelSheetView,
	theme: SheetCanvasTheme,
): void {
	const { columnOffsets, rowOffsets, columnWidths, rowHeights, indexWidth, headerHeight } = layout;
	context.fillStyle = theme.headerBackground;
	context.fillRect(0, 0, viewport.width, headerHeight);
	context.fillRect(0, 0, indexWidth, viewport.height);
	const columns = visibleRange(columnOffsets, scroll.left, Math.max(1, viewport.width - indexWidth));
	const rows = visibleRange(rowOffsets, scroll.top, Math.max(1, viewport.height - headerHeight));
	context.font = `600 ${Math.max(9, Math.round(10 * (headerHeight / DEFAULT_HEADER_HEIGHT)))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
	context.fillStyle = theme.headerText;
	context.textBaseline = "middle";
	context.textAlign = "center";
	for (let column = columns.start; column <= columns.end; column += 1) {
		const width = columnWidths[column] ?? 0;
		const left = indexWidth + (columnOffsets[column] ?? 0) - scroll.left;
		if (left + width < indexWidth || left > viewport.width) continue;
		context.fillText(columnLetter(column + sheet.startCol), left + width / 2, headerHeight / 2);
	}
	context.textAlign = "center";
	for (let row = rows.start; row <= rows.end; row += 1) {
		const height = rowHeights[row] ?? 0;
		const top = headerHeight + (rowOffsets[row] ?? 0) - scroll.top;
		if (top + height < headerHeight || top > viewport.height) continue;
		context.fillText(String(row + sheet.startRow + 1), indexWidth / 2, top + height / 2);
	}
	// Separators and the corner block sit above the header fill.
	context.strokeStyle = theme.border;
	context.lineWidth = 1;
	context.beginPath();
	context.moveTo(0, Math.round(headerHeight) + 0.5);
	context.lineTo(viewport.width, Math.round(headerHeight) + 0.5);
	context.moveTo(Math.round(indexWidth) + 0.5, 0);
	context.lineTo(Math.round(indexWidth) + 0.5, viewport.height);
	context.stroke();
}

function columnLetter(colIndex: number): string {
	let letter = "";
	let temp = colIndex;
	while (temp >= 0) {
		letter = String.fromCharCode((temp % 26) + 65) + letter;
		temp = Math.floor(temp / 26) - 1;
	}
	return letter;
}

export function drawSheet(options: DrawSheetOptions): void {
	const { context, sheet, layout, scroll, viewport, theme, query, scale, selection } = options;
	const { columnOffsets, rowOffsets, columnWidths, rowHeights, indexWidth, headerHeight } = layout;
	context.clearRect(0, 0, viewport.width, viewport.height);
	context.fillStyle = theme.background;
	context.fillRect(0, 0, viewport.width, viewport.height);
	const columns = visibleRange(columnOffsets, scroll.left, Math.max(1, viewport.width - indexWidth));
	const rows = visibleRange(rowOffsets, scroll.top, Math.max(1, viewport.height - headerHeight));
	const matches = (value: string) => query.length > 0 && value.toLowerCase().includes(query);

	// Body cells (content coordinates translated into the viewport).
	context.save();
	context.beginPath();
	context.rect(
		indexWidth,
		headerHeight,
		Math.max(0, viewport.width - indexWidth),
		Math.max(0, viewport.height - headerHeight),
	);
	context.clip();
	context.translate(indexWidth - scroll.left, headerHeight - scroll.top);
	for (let row = rows.start; row <= rows.end; row += 1) {
		const y = rowOffsets[row] ?? 0;
		const height = rowHeights[row] ?? 0;
		for (let column = columns.start; column <= columns.end; column += 1) {
			const key = `${row}:${column}`;
			if (sheet.hidden.has(key)) continue;
			const cell = sheet.cells.get(key);
			const x = columnOffsets[column] ?? 0;
			const width = columnWidths[column] ?? 0;
			if (cell && (cell.rowSpan ?? 1) > 1) continue;
			if (cell && (cell.colSpan ?? 1) > 1) continue;
			const highlighted = Boolean(cell && matches(cell.formatted));
			fillRect(context, x, y, width, height, highlighted ? undefined : cell?.fill);
			if (highlighted) {
				context.fillStyle = withAlpha(theme.searchFill, 0.25);
				context.fillRect(x, y, width, height);
			}
			if (cell) drawCellText(context, cell, cell.type, x, y, width, height, scale, theme, highlighted);
			drawBorders(context, cell, x, y, width, height, theme, scale);
		}
	}
	// Merged regions paint over their covered cells.
	for (const merge of sheet.merges) {
		if (merge.row > rows.end || merge.row + merge.rowSpan - 1 < rows.start) continue;
		if (merge.col > columns.end || merge.col + merge.colSpan - 1 < columns.start) continue;
		const x = columnOffsets[merge.col] ?? 0;
		const y = rowOffsets[merge.row] ?? 0;
		const width = (columnOffsets[merge.col + merge.colSpan] ?? 0) - (columnOffsets[merge.col] ?? 0);
		const height = (rowOffsets[merge.row + merge.rowSpan] ?? 0) - (rowOffsets[merge.row] ?? 0);
		const highlighted = matches(merge.formatted);
		fillRect(context, x, y, width, height, highlighted ? undefined : merge.fill);
		if (highlighted) {
			context.fillStyle = withAlpha(theme.searchFill, 0.25);
			context.fillRect(x, y, width, height);
		}
		drawCellText(context, merge, undefined, x, y, width, height, scale, theme, highlighted);
		drawBorders(context, merge, x, y, width, height, theme, scale);
	}
	context.restore();

	// Selection outline in content coordinates.
	if (selection) {
		const left = columnOffsets[selection.startCol] ?? 0;
		const top = rowOffsets[selection.startRow] ?? 0;
		const width = (columnOffsets[selection.endCol + 1] ?? 0) - left;
		const height = (rowOffsets[selection.endRow + 1] ?? 0) - top;
		context.save();
		context.beginPath();
		context.rect(
			indexWidth,
			headerHeight,
			Math.max(0, viewport.width - indexWidth),
			Math.max(0, viewport.height - headerHeight),
		);
		context.clip();
		context.translate(indexWidth - scroll.left, headerHeight - scroll.top);
		context.strokeStyle = theme.searchText;
		context.lineWidth = 2;
		context.strokeRect(left + 1, top + 1, Math.max(0, width - 2), Math.max(0, height - 2));
		context.restore();
	}

	drawGridHeaders(context, layout, scroll, viewport, sheet, theme);
}
