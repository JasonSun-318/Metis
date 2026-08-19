import { MagnifyingGlass, SpinnerGap, Table } from "@phosphor-icons/react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cellKey, parseExcelBytes, type ExcelWorkbookView } from "./excel-grid.ts";
import { PreviewToolbar } from "./PreviewToolbar.tsx";

export interface ExcelViewerProps {
	readonly fileName: string;
	readonly byteLength?: number;
	readonly bytes: Uint8Array;
	readonly onClose?: () => void;
	readonly onOpenDefault?: () => void;
	readonly onReveal?: () => void;
}

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
	const query = searchQuery.trim().toLowerCase();
	const virtualizer = useVirtualizer({
		count: sheet?.rowCount ?? 0,
		getScrollElement: () => viewportRef.current,
		estimateSize: () => 28,
		overscan: 12,
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
	const leading = visibleRows[0]?.start ?? 0;
	const trailing = Math.max(0, virtualizer.getTotalSize() - (visibleRows[visibleRows.length - 1]?.end ?? 0));

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
					<div className="excel-table-container" style={{ zoom: `${zoom}%` }}>
						<table className="excel-grid-table">
							<thead>
								<tr>
									<th className="excel-corner-cell">#</th>
									{Array.from({ length: sheet.colCount }, (_, col) => (
										<th className="excel-col-header" key={col}>
											{getColumnLetter(col)}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{leading > 0 ? (
									<tr aria-hidden="true">
										<td colSpan={sheet.colCount + 1} style={{ height: leading, padding: 0, border: 0 }} />
									</tr>
								) : null}
								{visibleRows.map((virtualRow) => (
									<tr key={virtualRow.index}>
										<td className="excel-row-header">{virtualRow.index + 1}</td>
										{Array.from({ length: sheet.colCount }, (_, col) => {
											const key = cellKey(virtualRow.index, col);
											if (sheet.hidden.has(key)) return null;
											const cell = sheet.cells.get(key);
											const match = Boolean(query && cell?.formatted.toLowerCase().includes(query));
											return (
												<td
													className={`excel-cell${match ? " is-search-match" : ""}`}
													colSpan={cell?.colSpan}
													key={col}
													rowSpan={cell?.rowSpan}
													title={cell?.formatted}
												>
													{cell?.formatted ?? ""}
												</td>
											);
										})}
									</tr>
								))}
								{trailing > 0 ? (
									<tr aria-hidden="true">
										<td colSpan={sheet.colCount + 1} style={{ height: trailing, padding: 0, border: 0 }} />
									</tr>
								) : null}
							</tbody>
						</table>
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
