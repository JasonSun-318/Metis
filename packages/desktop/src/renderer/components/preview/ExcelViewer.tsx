import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { MagnifyingGlass, SpinnerGap, Table } from "../../icons.tsx";
import {
	buildSheetLayout,
	drawSheet,
	type SheetCanvasTheme,
	type SheetScroll,
	type SheetSelectionRect,
	type SheetViewport,
} from "./excel-canvas.ts";
import {
	type ExcelSelection,
	type ExcelWorkbookView,
	excelSelectionContext,
	expandExcelSelection,
	offsetIndex,
	parseExcelBytes,
	SpreadsheetTooLargeError,
} from "./excel-grid.ts";
import { PreviewToolbar } from "./PreviewToolbar.tsx";
import type { UniversalPreviewTarget } from "./preview-kinds.ts";
import { useDocumentSelection } from "./use-document-selection.tsx";

export interface ExcelViewerProps {
	readonly file?: UniversalPreviewTarget;
	readonly fileName: string;
	readonly byteLength?: number;
	readonly bytes: Uint8Array;
	readonly onClose?: () => void;
	readonly onOpenDefault?: () => void;
	readonly onReveal?: () => void;
}

const THEME_FALLBACK: SheetCanvasTheme = {
	background: "#181818",
	text: "#e6e6e6",
	border: "#2c2c2c",
	headerBackground: "#202020",
	headerText: "#9a9a9a",
	searchFill: "#ffd700",
	searchText: "#ffeaa7",
};

function cssColor(name: string, fallback: string): string {
	try {
		const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
		return value.length > 0 ? value : fallback;
	} catch {
		return fallback;
	}
}

function readCanvasTheme(): SheetCanvasTheme {
	return {
		background: cssColor("--panel", THEME_FALLBACK.background),
		text: cssColor("--text", THEME_FALLBACK.text),
		border: cssColor("--border-weak", THEME_FALLBACK.border),
		headerBackground: cssColor("--surface-04", THEME_FALLBACK.headerBackground),
		headerText: cssColor("--text-09", THEME_FALLBACK.headerText),
		searchFill: THEME_FALLBACK.searchFill,
		searchText: THEME_FALLBACK.searchText,
	};
}

export function ExcelViewer({ fileName, file, byteLength, bytes, onClose, onOpenDefault, onReveal }: ExcelViewerProps) {
	const { t } = useTranslation();
	const selection = useDocumentSelection(file, bytes);
	const [range, setRange] = useState<ExcelSelection | null>(null);
	const rangeRef = useRef<ExcelSelection | null>(null);
	const rangeAnchor = useRef<HTMLDivElement>(null);
	const firstCell = useRef({ row: 0, col: 0 });
	const selecting = useRef(false);
	const [dragging, setDragging] = useState(false);
	const lastCell = useRef({ row: 0, col: 0 });
	const pointer = useRef({ x: 0, y: 0 });
	const frameRef = useRef<HTMLDivElement>(null);
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const [viewport, setViewport] = useState<SheetViewport>({ width: 0, height: 0 });
	const [scroll, setScroll] = useState<SheetScroll>({ left: 0, top: 0 });
	const isDraggingRef = useRef(false);
	const startPosRef = useRef({ x: 0, y: 0, scrollLeft: 0, scrollTop: 0 });
	const [isPanning, setIsPanning] = useState(false);
	const [workbook, setWorkbook] = useState<ExcelWorkbookView | null>(null);
	const [activeSheetName, setActiveSheetName] = useState("");
	const [searchQuery, setSearchQuery] = useState("");
	const [zoom, setZoom] = useState(100);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setLoading(true);
		setError(null);
		try {
			const view = parseExcelBytes(bytes, fileName);
			setWorkbook(view);
			setActiveSheetName(view.activeSheet);
			setLoading(false);
		} catch (cause) {
			setError(
				cause instanceof SpreadsheetTooLargeError
					? t("Spreadsheet is too large to preview")
					: cause instanceof Error
						? cause.message
						: t("Failed to parse Excel spreadsheet"),
			);
			setLoading(false);
		}
	}, [bytes, fileName, t]);

	const sheet = workbook?.sheets[activeSheetName];
	const scale = zoom / 100;
	const layout = useMemo(() => (sheet ? buildSheetLayout(sheet, scale) : undefined), [sheet, scale]);
	const theme = useMemo(readCanvasTheme, []);
	const query = searchQuery.trim().toLowerCase();

	// biome-ignore lint/correctness/useExhaustiveDependencies(bytes): New workbook bytes invalidate the previous cell selection.
	// biome-ignore lint/correctness/useExhaustiveDependencies(activeSheetName): Switching sheets clears the previous cell selection and scroll position.
	useEffect(() => {
		setRange(null);
		rangeRef.current = null;
		selecting.current = false;
		setDragging(false);
		selection.clear();
		const viewportElement = scrollRef.current;
		if (viewportElement) {
			viewportElement.scrollLeft = 0;
			viewportElement.scrollTop = 0;
		}
		setScroll({ left: 0, top: 0 });
	}, [activeSheetName, bytes, selection.clear]);

	// Track the canvas viewport size; the canvas is repainted from scratch on resize.
	useEffect(() => {
		const frame = frameRef.current;
		if (!frame || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (!entry) return;
			setViewport({ width: entry.contentRect.width, height: entry.contentRect.height });
		});
		observer.observe(frame);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		const canvas = canvasRef.current;
		if (!canvas || !sheet || !layout || viewport.width <= 0 || viewport.height <= 0) return;
		const ratio = window.devicePixelRatio || 1;
		const pixelWidth = Math.max(1, Math.round(viewport.width * ratio));
		const pixelHeight = Math.max(1, Math.round(viewport.height * ratio));
		if (canvas.width !== pixelWidth) canvas.width = pixelWidth;
		if (canvas.height !== pixelHeight) canvas.height = pixelHeight;
		canvas.style.width = `${viewport.width}px`;
		canvas.style.height = `${viewport.height}px`;
		const context = canvas.getContext("2d");
		if (!context) return;
		context.setTransform(ratio, 0, 0, ratio, 0, 0);
		const selectionRect: SheetSelectionRect | null = range
			? { startRow: range.startRow, startCol: range.startCol, endRow: range.endRow, endCol: range.endCol }
			: null;
		drawSheet({
			context,
			sheet,
			layout,
			scroll,
			viewport,
			theme,
			query,
			scale,
			selection: selectionRect,
		});
	}, [sheet, layout, scroll, viewport, theme, query, scale, range]);

	const scrollToCell = useCallback(
		(row: number, col: number) => {
			const element = scrollRef.current;
			if (!element || !layout) return;
			const left = layout.columnOffsets[col] ?? 0;
			const right = left + (layout.columnWidths[col] ?? 0);
			const top = layout.rowOffsets[row] ?? 0;
			const bottom = top + (layout.rowHeights[row] ?? 0);
			const visibleWidth = element.clientWidth - layout.indexWidth;
			const visibleHeight = element.clientHeight - layout.headerHeight;
			if (left < element.scrollLeft) element.scrollLeft = left;
			else if (right > element.scrollLeft + visibleWidth) element.scrollLeft = right - visibleWidth;
			if (top < element.scrollTop) element.scrollTop = top;
			else if (bottom > element.scrollTop + visibleHeight) element.scrollTop = bottom - visibleHeight;
		},
		[layout],
	);

	const cellAt = useCallback(
		(x: number, y: number) => {
			const element = scrollRef.current;
			if (!element || !sheet || !layout || sheet.rowCount <= 0 || sheet.colCount <= 0) return null;
			const rect = element.getBoundingClientRect();
			const localX = x - rect.left;
			const localY = y - rect.top;
			if (localX < layout.indexWidth || localY < layout.headerHeight) return null;
			if (localX > rect.width || localY > rect.height) return null;
			const contentX = localX - layout.indexWidth + element.scrollLeft;
			const contentY = localY - layout.headerHeight + element.scrollTop;
			return {
				row: Math.max(0, Math.min(sheet.rowCount - 1, offsetIndex(layout.rowOffsets, contentY))),
				col: Math.max(0, Math.min(sheet.colCount - 1, offsetIndex(layout.columnOffsets, contentX))),
			};
		},
		[layout, sheet],
	);

	const moveSelection = useCallback(
		(x: number, y: number) => {
			const last = cellAt(x, y);
			if (!last || !sheet) return;
			lastCell.current = last;
			const next = expandExcelSelection(sheet, firstCell.current, last);
			rangeRef.current = next;
			setRange(next);
		},
		[cellAt, sheet],
	);
	const offerRequest = () => {
		const current = rangeRef.current;
		if (!sheet || !current) return;
		const value = excelSelectionContext(sheet, current);
		requestAnimationFrame(() => {
			if (rangeAnchor.current) selection.select(value.target, value.text, rangeAnchor.current, value.excerpt);
		});
	};

	const handleScroll = () => {
		const element = scrollRef.current;
		if (!element) return;
		setScroll({ left: element.scrollLeft, top: element.scrollTop });
	};

	const handleMouseDown = (event: React.MouseEvent<HTMLElement>) => {
		if (event.button !== 1) return;
		event.preventDefault();
		if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return;
		const element = scrollRef.current;
		if (!element) return;
		isDraggingRef.current = true;
		setIsPanning(true);
		startPosRef.current = {
			x: event.clientX,
			y: event.clientY,
			scrollLeft: element.scrollLeft,
			scrollTop: element.scrollTop,
		};
	};

	const handleMouseMove = (event: React.MouseEvent<HTMLElement>) => {
		if (!isDraggingRef.current) return;
		const element = scrollRef.current;
		if (!element) return;
		element.scrollLeft = startPosRef.current.scrollLeft - (event.clientX - startPosRef.current.x);
		element.scrollTop = startPosRef.current.scrollTop - (event.clientY - startPosRef.current.y);
	};

	const handleMouseUp = () => {
		isDraggingRef.current = false;
		setIsPanning(false);
	};

	useEffect(() => {
		let frame = 0;
		const tick = () => {
			const element = scrollRef.current;
			if (selecting.current && element) {
				const rect = element.getBoundingClientRect();
				const { x, y } = pointer.current;
				const dx = x < rect.left + 24 ? -12 : x > rect.right - 24 ? 12 : 0;
				const dy = y < rect.top + (layout?.headerHeight ?? 0) + 24 ? -12 : y > rect.bottom - 24 ? 12 : 0;
				if (dx || dy) {
					element.scrollLeft += dx;
					element.scrollTop += dy;
					moveSelection(x, y);
				}
			}
			frame = requestAnimationFrame(tick);
		};
		if (dragging) frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [dragging, layout?.headerHeight, moveSelection]);

	return (
		<div className="universal-previewer excel-previewer">
			<PreviewToolbar
				byteLength={byteLength}
				extraActions={
					<div className="excel-search-bar">
						<MagnifyingGlass aria-hidden="true" size={13} />
						<input
							aria-label={t("Filter cells")}
							onChange={(event) => setSearchQuery(event.target.value)}
							placeholder={t("Filter cells…")}
							type="search"
							value={searchQuery}
						/>
					</div>
				}
				fileName={fileName}
				onClose={onClose}
				onOpenDefault={onOpenDefault}
				onReveal={onReveal}
				onZoomIn={() => setZoom((value) => Math.min(200, value + 15))}
				onZoomOut={() => setZoom((value) => Math.max(70, value - 15))}
				onZoomReset={() => setZoom(100)}
				zoom={zoom}
			/>
			<div className="excel-selection-info">
				<span>{range && sheet ? excelSelectionContext(sheet, range).target.range : "—"}</span>
				<span>
					{range && sheet
						? (() => {
								const cell = sheet.cells.get(`${range.startRow}:${range.startCol}`);
								return cell?.formula ? `=${cell.formula}` : (cell?.formatted ?? "");
							})()
						: ""}
				</span>
			</div>
			<section
				aria-label={`${fileName}: ${activeSheetName}`}
				className={`preview-viewport excel-viewport${isPanning ? " is-panning" : ""}`}
				onMouseDown={handleMouseDown}
				onMouseLeave={handleMouseUp}
				onMouseMove={handleMouseMove}
				onMouseUp={handleMouseUp}
			>
				{loading ? (
					<div className="preview-loading-state">
						<SpinnerGap aria-hidden="true" className="is-spinning" size={28} />
						<span>{t("Loading Excel spreadsheet…")}</span>
					</div>
				) : error ? (
					<div className="preview-error-state">
						<span>{error}</span>
					</div>
				) : !sheet || !layout || sheet.rowCount === 0 ? (
					<div className="preview-empty-state">
						<Table aria-hidden="true" size={32} />
						<span>{t("Empty sheet")}</span>
					</div>
				) : (
					<div className="excel-canvas-frame" ref={frameRef}>
						<canvas className="excel-canvas" ref={canvasRef} />
						<div
							aria-label={`${fileName}: ${activeSheetName}`}
							className="excel-canvas-scroll"
							onKeyDown={(event) => {
								if (event.key === "Escape") {
									selection.clear();
									setRange(null);
									rangeRef.current = null;
									return;
								}
								if (
									!sheet ||
									!selection.enabled ||
									!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)
								)
									return;
								event.preventDefault();
								selection.clear();
								const current = rangeRef.current;
								const row = Math.max(
									0,
									Math.min(
										sheet.rowCount - 1,
										(current ? lastCell.current.row : 0) +
											(event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0),
									),
								);
								const col = Math.max(
									0,
									Math.min(
										sheet.colCount - 1,
										(current ? lastCell.current.col : 0) +
											(event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0),
									),
								);
								if (!event.shiftKey || !current) firstCell.current = { row, col };
								lastCell.current = { row, col };
								rangeRef.current = expandExcelSelection(sheet, firstCell.current, { row, col });
								setRange(rangeRef.current);
								scrollToCell(row, col);
								offerRequest();
							}}
							onPointerCancel={() => {
								selecting.current = false;
								setDragging(false);
							}}
							onPointerDown={(event) => {
								if (event.button !== 0 || !selection.enabled) return;
								const cell = cellAt(event.clientX, event.clientY);
								if (!cell) return;
								event.preventDefault();
								selection.clear();
								if (!event.shiftKey || !range) firstCell.current = cell;
								selecting.current = true;
								setDragging(true);
								pointer.current = { x: event.clientX, y: event.clientY };
								event.currentTarget.setPointerCapture(event.pointerId);
								moveSelection(event.clientX, event.clientY);
							}}
							onPointerMove={(event) => {
								if (selecting.current) {
									pointer.current = { x: event.clientX, y: event.clientY };
									moveSelection(event.clientX, event.clientY);
								}
							}}
							onPointerUp={(event) => {
								if (event.button === 0 && selecting.current) {
									selecting.current = false;
									setDragging(false);
									event.currentTarget.releasePointerCapture(event.pointerId);
									offerRequest();
								}
							}}
							onScroll={handleScroll}
							ref={scrollRef}
							role="application"
							// biome-ignore lint/a11y/noNoninteractiveTabindex: The canvas grid receives focus for arrow-key cell selection and Escape.
							tabIndex={0}
						>
							<div
								className="excel-canvas-content"
								style={{ width: layout.totalWidth, height: layout.totalHeight }}
							>
								{range && (
									<div
										className="excel-range-selection"
										ref={rangeAnchor}
										style={{
											top: layout.headerHeight + (layout.rowOffsets[range.startRow] ?? 0),
											left: layout.indexWidth + (layout.columnOffsets[range.startCol] ?? 0),
											height:
												(layout.rowOffsets[range.endRow + 1] ?? 0) -
												(layout.rowOffsets[range.startRow] ?? 0),
											width:
												(layout.columnOffsets[range.endCol + 1] ?? 0) -
												(layout.columnOffsets[range.startCol] ?? 0),
										}}
									/>
								)}
							</div>
						</div>
					</div>
				)}
			</section>
			{selection.popover}
			{workbook && workbook.sheetNames.length > 1 && (
				<nav aria-label={t("Sheets")} className="excel-sheet-tabs">
					{workbook.sheetNames.map((name) => (
						<button
							className={`excel-sheet-tab${activeSheetName === name ? " is-active" : ""}`}
							key={name}
							onClick={() => setActiveSheetName(name)}
							type="button"
						>
							{name}
						</button>
					))}
				</nav>
			)}
		</div>
	);
}
