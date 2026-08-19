import { CaretLeft, CaretRight, SpinnerGap } from "@phosphor-icons/react";
import * as pdfjsLib from "pdfjs-dist";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { pdfCMapUrl, pdfStandardFontDataUrl, pdfWorkerSrc } from "./pdf-assets.ts";
import { PreviewToolbar } from "./PreviewToolbar.tsx";

const workerSrc = pdfWorkerSrc();
if (workerSrc) pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export interface PdfViewerProps {
	readonly fileName: string;
	readonly byteLength?: number;
	readonly bytes: Uint8Array;
	readonly onClose?: () => void;
	readonly onOpenDefault?: () => void;
	readonly onReveal?: () => void;
}

export function PdfViewer({ fileName, byteLength, bytes, onClose, onOpenDefault, onReveal }: PdfViewerProps) {
	const { t } = useTranslation();
	const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
	const [totalPages, setTotalPages] = useState(0);
	const [currentPage, setCurrentPage] = useState(1);
	const [pageSizes, setPageSizes] = useState<readonly { width: number; height: number }[]>([]);
	const [zoom, setZoom] = useState(100);
	const [inverted, setInverted] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const canvasMapRef = useRef<Map<number, HTMLCanvasElement>>(new Map());
	const textLayerMapRef = useRef<Map<number, HTMLDivElement>>(new Map());
	const renderedPages = useRef<Set<number>>(new Set());
	const queueRef = useRef<number[]>([]);
	const isProcessingRef = useRef(false);
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const pdfDocRef = useRef<pdfjsLib.PDFDocumentProxy | null>(null);
	const zoomRef = useRef(zoom);
	const renderTasksRef = useRef<Map<number, { cancel: () => void }>>(new Map());

	useEffect(() => {
		pdfDocRef.current = pdfDoc;
	}, [pdfDoc]);

	useEffect(() => {
		zoomRef.current = zoom;
	}, [zoom]);

	const renderPageDirect = useCallback(async (pageNum: number) => {
		const doc = pdfDocRef.current;
		const canvas = canvasMapRef.current.get(pageNum);
		const textLayerDiv = textLayerMapRef.current.get(pageNum);
		if (!doc || !canvas) return;
		try {
			const page = await doc.getPage(pageNum);
			const context = canvas.getContext("2d");
			if (!context) return;
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			const scale = (zoomRef.current / 100) * dpr;
			const viewport = page.getViewport({ scale });
			canvas.height = viewport.height;
			canvas.width = viewport.width;
			canvas.style.width = `${viewport.width / dpr}px`;
			canvas.style.height = `${viewport.height / dpr}px`;
			const unscaled = page.getViewport({ scale: 1 });
			setPageSizes((current) => {
				const next = [...current];
				next[pageNum - 1] = { width: unscaled.width, height: unscaled.height };
				return next;
			});
			renderTasksRef.current.get(pageNum)?.cancel();
			const renderTask = page.render({ canvasContext: context, viewport });
			renderTasksRef.current.set(pageNum, renderTask);
			await renderTask.promise;
			if (textLayerDiv && pdfjsLib.TextLayer) {
				textLayerDiv.replaceChildren();
				textLayerDiv.style.width = `${viewport.width / dpr}px`;
				textLayerDiv.style.height = `${viewport.height / dpr}px`;
				const textLayer = new pdfjsLib.TextLayer({
					container: textLayerDiv,
					textContentSource: page.streamTextContent(),
					viewport: page.getViewport({ scale: zoomRef.current / 100 }),
				});
				await textLayer.render();
			}
			renderedPages.current.add(pageNum);
		} catch {
			// cancelled or failed
		} finally {
			renderTasksRef.current.delete(pageNum);
		}
	}, []);

	const scheduleProcessQueue = useCallback(() => {
		if (isProcessingRef.current) return;
		isProcessingRef.current = true;
		void (async () => {
			try {
				while (queueRef.current.length > 0) {
					const pageNum = queueRef.current.shift()!;
					if (renderedPages.current.has(pageNum)) continue;
					await renderPageDirect(pageNum);
				}
			} finally {
				isProcessingRef.current = false;
			}
		})();
	}, [renderPageDirect]);

	const enqueuePage = useCallback(
		(pageNum: number, highPriority = false) => {
			if (renderedPages.current.has(pageNum)) return;
			if (highPriority) {
				queueRef.current = [pageNum, ...queueRef.current.filter((p) => p !== pageNum)];
			} else if (!queueRef.current.includes(pageNum)) {
				queueRef.current.push(pageNum);
			}
			scheduleProcessQueue();
		},
		[scheduleProcessQueue],
	);

	useEffect(() => {
		let cancelled = false;
		setLoading(true);
		setError(null);
		setPdfDoc(null);
		setTotalPages(0);
		setCurrentPage(1);
		renderedPages.current.clear();
		queueRef.current = [];
		canvasMapRef.current.clear();
		if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
			setError(t("Failed to load PDF document"));
			setLoading(false);
			return;
		}
		const loadingTask = pdfjsLib.getDocument({
			data: bytes,
			cMapUrl: pdfCMapUrl(),
			cMapPacked: true,
			standardFontDataUrl: pdfStandardFontDataUrl(),
		});
		void loadingTask.promise.then(
			async (doc) => {
				if (cancelled) {
					void doc.destroy();
					return;
				}
				pdfDocRef.current = doc;
				setPdfDoc(doc);
				setTotalPages(doc.numPages);
				setPageSizes(Array.from({ length: doc.numPages }, () => ({ width: 800, height: 1130 })));
				setLoading(false);
				enqueuePage(1, true);
				if (doc.numPages >= 2) enqueuePage(2);
				if (doc.numPages >= 3) enqueuePage(3);
			},
			(err) => {
				if (cancelled) return;
				setError(err instanceof Error ? err.message : t("Failed to load PDF document"));
				setLoading(false);
			},
		);
		return () => {
			cancelled = true;
			for (const task of renderTasksRef.current.values()) task.cancel();
			renderTasksRef.current.clear();
			void pdfDocRef.current?.destroy();
			pdfDocRef.current = null;
			void loadingTask.destroy?.();
		};
	}, [bytes, enqueuePage, t]);

	useEffect(() => {
		if (!pdfDoc || totalPages <= 0) return;
		const toRender = Array.from(renderedPages.current);
		renderedPages.current.clear();
		for (const pageNum of toRender) enqueuePage(pageNum);
	}, [zoom, pdfDoc, totalPages, enqueuePage]);

	useEffect(() => {
		if (!pdfDoc || totalPages <= 0) return;
		const scrollContainer = scrollContainerRef.current;
		if (!scrollContainer || typeof IntersectionObserver === "undefined") return;
		const lazyObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					if (!entry.isIntersecting) continue;
					const pageNumStr = (entry.target as HTMLElement).dataset.page;
					if (!pageNumStr) continue;
					const pageNum = Number.parseInt(pageNumStr, 10);
					enqueuePage(pageNum, true);
					for (const neighbor of [pageNum - 1, pageNum + 1]) {
						if (neighbor >= 1 && neighbor <= totalPages) enqueuePage(neighbor, false);
					}
				}
			},
			{ root: scrollContainer, rootMargin: "300px 0px", threshold: 0.05 },
		);
		const visibleRatios = new Map<number, number>();
		const visibilityObserver = new IntersectionObserver(
			(entries) => {
				for (const entry of entries) {
					const pageNumStr = (entry.target as HTMLElement).dataset.page;
					if (!pageNumStr) continue;
					visibleRatios.set(Number.parseInt(pageNumStr, 10), entry.intersectionRatio);
				}
				let maxRatio = 0;
				let maxPage = 1;
				for (const [page, ratio] of visibleRatios) {
					if (ratio > maxRatio) {
						maxRatio = ratio;
						maxPage = page;
					}
				}
				if (maxRatio > 0) setCurrentPage(maxPage);
			},
			{ root: scrollContainer, threshold: [0, 0.2, 0.5, 0.8, 1] },
		);
		const wrappers = Array.from(scrollContainer.querySelectorAll<HTMLElement>(".pdf-page-wrapper"));
		for (const wrapper of wrappers) {
			lazyObserver.observe(wrapper);
			visibilityObserver.observe(wrapper);
		}
		return () => {
			lazyObserver.disconnect();
			visibilityObserver.disconnect();
		};
	}, [pdfDoc, totalPages, enqueuePage]);

	const scrollToPage = (pageNum: number) => {
		scrollContainerRef.current
			?.querySelector<HTMLElement>(`.pdf-page-wrapper[data-page="${pageNum}"]`)
			?.scrollIntoView({ behavior: "smooth", block: "start" });
	};

	const pageControls =
		totalPages > 0 ? (
			<div className="preview-page-navigator">
				<button
					aria-label={t("Previous page")}
					className="preview-toolbar-btn"
					disabled={currentPage <= 1}
					onClick={() => currentPage > 1 && scrollToPage(currentPage - 1)}
					type="button"
				>
					<CaretLeft aria-hidden="true" size={13} />
				</button>
				<span className="preview-page-info">
					{currentPage} / {totalPages}
				</span>
				<button
					aria-label={t("Next page")}
					className="preview-toolbar-btn"
					disabled={currentPage >= totalPages}
					onClick={() => currentPage < totalPages && scrollToPage(currentPage + 1)}
					type="button"
				>
					<CaretRight aria-hidden="true" size={13} />
				</button>
			</div>
		) : null;

	return (
		<div className="universal-previewer pdf-previewer">
			<PreviewToolbar
				byteLength={byteLength}
				extraActions={pageControls}
				fileName={fileName}
				isInverted={inverted}
				onClose={onClose}
				onOpenDefault={onOpenDefault}
				onReveal={onReveal}
				onToggleInvert={() => setInverted((value) => !value)}
				onZoomIn={() => setZoom((value) => Math.min(300, value + 20))}
				onZoomOut={() => setZoom((value) => Math.max(50, value - 20))}
				onZoomReset={() => setZoom(100)}
				showInvertToggle
				zoom={zoom}
			/>
			<div className={`preview-viewport pdf-viewport${inverted ? " is-inverted" : ""}`}>
				{loading ? (
					<div className="preview-loading-state">
						<SpinnerGap aria-hidden="true" className="is-spinning" size={28} />
						<span>{t("Loading PDF document…")}</span>
					</div>
				) : error ? (
					<div className="preview-error-state">
						<span>{error}</span>
					</div>
				) : (
					<div className="pdf-canvas-container" ref={scrollContainerRef}>
						{Array.from({ length: totalPages }, (_, index) => {
							const pageNum = index + 1;
							const size = pageSizes[index] ?? { width: 800, height: 1130 };
							return (
								<div
									className="pdf-page-wrapper"
									data-page={pageNum}
									key={pageNum}
									style={{
										width: `${Math.round(size.width * (zoom / 100))}px`,
										aspectRatio: `${size.width} / ${size.height}`,
									}}
								>
									<canvas
										ref={(element) => {
											if (element) canvasMapRef.current.set(pageNum, element);
											else canvasMapRef.current.delete(pageNum);
										}}
									/>
									<div
										className="textLayer"
										ref={(element) => {
											if (element) textLayerMapRef.current.set(pageNum, element);
											else textLayerMapRef.current.delete(pageNum);
										}}
									/>
								</div>
							);
						})}
					</div>
				)}
			</div>
		</div>
	);
}
