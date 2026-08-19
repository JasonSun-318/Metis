import { MagnifyingGlass, SpinnerGap, Table } from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { mergesInRowRange, paintedCellsForRow, parseExcelBytes, type ExcelWorkbookView } from "./excel-grid.ts";
import { PreviewToolbar } from "./PreviewToolbar.tsx";

export interface ExcelViewerProps {
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

export function ExcelViewer({ fileName, byteLength, bytes, onClose, onOpenDefault, onReveal }: ExcelViewerProps) {
	const { t } = useTranslation();
	const viewportRef = useRef<HTMLDivElement>(null);
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
	const virtualizer = useVirtualizer({
		count: sheet?.rowCount ?? 0,
		getScrollElement: () => viewportRef.current,
		estimateSize: () => rowHeight,
		overscan: 16,
	});

	const handleMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
		if (event.button !== 0 && event.button !== 1) return;
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

	const handleMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
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
			<div
				className={`preview-viewport excel-viewport${isPanning ? " is-panning" : ""}`}
				onMouseDown={handleMouseDown}
				onMouseLeave={handleMouseUp}
				onMouseMove={handleMouseMove}
				onMouseUp={handleMouseUp}
				ref={viewportRef}
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
								<div className="excel-col-header" key={col} style={{ width: colWidth, minWidth: colWidth }}>
									{getColumnLetter(col)}
								</div>
							))}
						</div>
						<div className="excel-grid-body" style={{ height: virtualizer.getTotalSize(), width: gridWidth }}>
							{visibleRows.map((virtualRow) => (
								<div
									className="excel-grid-row"
									key={virtualRow.index}
									style={{ height: virtualRow.size, top: virtualRow.start, width: gridWidth }}
								>
									<div className="excel-row-header" style={{ width: indexWidth, minWidth: indexWidth }}>
										{virtualRow.index + 1}
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
			</div>
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
