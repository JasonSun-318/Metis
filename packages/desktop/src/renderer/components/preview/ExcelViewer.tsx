import { MagnifyingGlass, SpinnerGap, Table } from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	cellKey,
	type ExcelSelection,
	type ExcelWorkbookView,
	excelSelectionContext,
	expandExcelSelection,
	mergesInRowRange,
	paintedCellsForRow,
	parseExcelBytes,
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

const ROW_HEIGHT = 28;
const COL_WIDTH = 88;
const INDEX_WIDTH = 44;

function getColumnLetter(colIndex: number): string {
	let letter = "";
	let temp = colIndex;
	while (temp >= 0) {
		letter = String.fromCharCode((temp % 26) + 65) + letter;
		temp = Math.floor(temp / 26) - 1;
	}
	return letter;
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
	const viewportRef = useRef<HTMLElement>(null);
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
			setError(cause instanceof Error ? cause.message : t("Failed to parse Excel spreadsheet"));
			setLoading(false);
		}
	}, [bytes, fileName, t]);

	const sheet = workbook?.sheets[activeSheetName];
	const scale = zoom / 100;
	const rowHeight = Math.max(18, Math.round(ROW_HEIGHT * scale));
	const colWidth = Math.max(56, Math.round(COL_WIDTH * scale));
	const indexWidth = Math.max(36, Math.round(INDEX_WIDTH * scale));
	const query = searchQuery.trim().toLowerCase();
	// biome-ignore lint/correctness/useExhaustiveDependencies(bytes): New workbook bytes invalidate the previous cell selection.
	// biome-ignore lint/correctness/useExhaustiveDependencies(activeSheetName): Switching sheets clears the previous cell selection and scroll position.
	useEffect(() => {
		setRange(null);
		rangeRef.current = null;
		selecting.current = false;
		setDragging(false);
		selection.clear();
		if (viewportRef.current) viewportRef.current.scrollTo?.(0, 0);
	}, [activeSheetName, bytes, selection.clear]);
	const virtualizer = useVirtualizer({
		count: sheet?.rowCount ?? 0,
		getScrollElement: () => viewportRef.current,
		estimateSize: () => rowHeight,
		overscan: 16,
	});

	const handleMouseDown = (event: React.MouseEvent<HTMLElement>) => {
		if (event.button !== 1) return;
		event.preventDefault();
		if (event.target instanceof HTMLInputElement || event.target instanceof HTMLButtonElement) return;
		const viewport = viewportRef.current;
		if (!viewport) return;
		isDraggingRef.current = true;
		setIsPanning(true);
		startPosRef.current = {
			x: event.clientX,
			y: event.clientY,
			scrollLeft: viewport.scrollLeft,
			scrollTop: viewport.scrollTop,
		};
	};

	const handleMouseMove = (event: React.MouseEvent<HTMLElement>) => {
		if (!isDraggingRef.current) return;
		const viewport = viewportRef.current;
		if (!viewport) return;
		viewport.scrollLeft = startPosRef.current.scrollLeft - (event.clientX - startPosRef.current.x);
		viewport.scrollTop = startPosRef.current.scrollTop - (event.clientY - startPosRef.current.y);
	};

	const handleMouseUp = () => {
		isDraggingRef.current = false;
		setIsPanning(false);
	};

	const cellAt = useCallback(
		(x: number, y: number) => {
			const viewport = viewportRef.current;
			if (!viewport || !sheet || !sheet.rowCount || !sheet.colCount) return null;
			const body = viewport.querySelector(".excel-grid-body");
			if (!body) return null;
			const rect = body.getBoundingClientRect();
			return {
				row: Math.max(0, Math.min(sheet.rowCount - 1, Math.floor((y - rect.top) / rowHeight))),
				col: Math.max(0, Math.min(sheet.colCount - 1, Math.floor((x - rect.left - indexWidth) / colWidth))),
			};
		},
		[colWidth, indexWidth, rowHeight, sheet],
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
	useEffect(() => {
		let frame = 0;
		const tick = () => {
			const viewport = viewportRef.current;
			if (selecting.current && viewport) {
				const rect = viewport.getBoundingClientRect(),
					{ x, y } = pointer.current;
				const dx = x < rect.left + 24 ? -12 : x > rect.right - 24 ? 12 : 0;
				const dy = y < rect.top + rowHeight + 24 ? -12 : y > rect.bottom - 24 ? 12 : 0;
				if (dx || dy) {
					viewport.scrollLeft += dx;
					viewport.scrollTop += dy;
					moveSelection(x, y);
				}
			}
			frame = requestAnimationFrame(tick);
		};
		if (dragging) frame = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(frame);
	}, [dragging, moveSelection, rowHeight]);
	// biome-ignore lint/correctness/useExhaustiveDependencies(rowHeight): Zoom changes require measuring virtual rows again.
	useEffect(() => {
		virtualizer.measure();
	}, [rowHeight, virtualizer]);
	const visibleRows = virtualizer.getVirtualItems();
	const sheetNames = workbook?.sheetNames ?? [];
	const gridWidth = sheet ? indexWidth + sheet.colCount * colWidth : 0;
	const firstVisibleRow = visibleRows[0]?.index ?? 0;
	const lastVisibleRow = visibleRows[visibleRows.length - 1]?.index ?? 0;
	const visibleMerges = sheet ? mergesInRowRange(sheet.merges, firstVisibleRow, lastVisibleRow) : [];

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
								const cell = sheet.cells.get(cellKey(range.startRow, range.startCol));
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
					event.currentTarget.focus();
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
				onPointerCancel={() => {
					selecting.current = false;
					setDragging(false);
				}}
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
					virtualizer.scrollToIndex(row);
					offerRequest();
				}}
				onMouseMove={handleMouseMove}
				onMouseUp={handleMouseUp}
				ref={viewportRef}
				// biome-ignore lint/a11y/noNoninteractiveTabindex: The scrollable sheet receives focus for arrow-key cell selection and Escape.
				tabIndex={0}
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
				) : !sheet || sheet.rowCount === 0 ? (
					<div className="preview-empty-state">
						<Table aria-hidden="true" size={32} />
						<span>{t("Empty sheet")}</span>
					</div>
				) : (
					<div className="excel-grid" style={{ width: gridWidth, height: rowHeight + virtualizer.getTotalSize() }}>
						<div className="excel-grid-header" style={{ height: rowHeight, width: gridWidth }}>
							<div className="excel-corner-cell" style={{ width: indexWidth, minWidth: indexWidth }}>
								#
							</div>
							{Array.from({ length: sheet.colCount }, (_, col) => (
								/* biome-ignore lint/suspicious/noArrayIndexKey: Columns have fixed worksheet positions and do not reorder within a sheet. */
								<div className="excel-col-header" key={col} style={{ width: colWidth, minWidth: colWidth }}>
									{getColumnLetter(col + sheet.startCol)}
								</div>
							))}
						</div>
						<div className="excel-grid-body" style={{ height: virtualizer.getTotalSize(), width: gridWidth }}>
							{range && (
								<div
									ref={rangeAnchor}
									className="excel-range-selection"
									style={{
										top: range.startRow * rowHeight,
										left: indexWidth + range.startCol * colWidth,
										height: (range.endRow - range.startRow + 1) * rowHeight,
										width: (range.endCol - range.startCol + 1) * colWidth,
									}}
								/>
							)}
							{visibleRows.map((virtualRow) => (
								<div
									className="excel-grid-row"
									key={virtualRow.index}
									style={{ height: virtualRow.size, top: virtualRow.start, width: gridWidth }}
								>
									<div className="excel-row-header" style={{ width: indexWidth, minWidth: indexWidth }}>
										{virtualRow.index + sheet.startRow + 1}
									</div>
									{paintedCellsForRow(sheet, virtualRow.index).map((cell) => {
										const merged = cell.covered || cell.rowSpan > 1 || cell.colSpan > 1;
										const match = Boolean(!merged && query && cell.formatted.toLowerCase().includes(query));
										return (
											<div
												className={`excel-cell${merged ? " is-covered" : ""}${match ? " is-search-match" : ""}`}
												key={cell.col}
												style={{ width: colWidth, minWidth: colWidth }}
												title={merged ? undefined : cell.formatted}
											>
												{merged ? "" : cell.formatted}
											</div>
										);
									})}
								</div>
							))}
							{visibleMerges.map((merge) => {
								const match = Boolean(query && merge.formatted.toLowerCase().includes(query));
								return (
									<div
										className={`excel-merge${match ? " is-search-match" : ""}`}
										key={`${merge.row}:${merge.col}`}
										style={{
											height: merge.rowSpan * rowHeight,
											left: indexWidth + merge.col * colWidth,
											top: merge.row * rowHeight,
											width: merge.colSpan * colWidth,
										}}
										title={merge.formatted}
									>
										{merge.formatted}
									</div>
								);
							})}
						</div>
					</div>
				)}
			</section>
			{selection.popover}
			{sheetNames.length > 1 && (
				<nav aria-label={t("Sheets")} className="excel-sheet-tabs">
					{sheetNames.map((name) => (
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
