import { SpinnerGap } from "@phosphor-icons/react";
import * as pdfjsLib from "pdfjs-dist";
import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePreviewExpansion } from "./PreviewFrame.tsx";
import { PreviewPageControls, PreviewToolbar } from "./PreviewToolbar.tsx";
import { pdfCMapUrl, pdfStandardFontDataUrl, pdfWorkerSrc } from "./pdf-assets.ts";
import { type PreviewSize, type PreviewZoom, previewScale, usePreviewViewport } from "./preview-layout.ts";
import type { UniversalPreviewTarget } from "./PreviewHost.tsx";
import { pdfTextSelection } from "./pdf-selection.ts";
import { useDocumentSelection } from "./use-document-selection.tsx";

const workerSrc = pdfWorkerSrc();
if (workerSrc) pdfjsLib.GlobalWorkerOptions.workerSrc = workerSrc;

export interface PdfViewerProps {
	readonly file?: UniversalPreviewTarget;
	readonly fileName: string;
	readonly byteLength?: number;
	readonly bytes: Uint8Array;
	readonly onClose?: () => void;
	readonly onOpenDefault?: () => void;
	readonly onReveal?: () => void;
}

function PdfPage({
	doc,
	number,
	mode,
	viewport,
	initialSize,
	scrollRef,
}: {
	doc: pdfjsLib.PDFDocumentProxy;
	number: number;
	mode: PreviewZoom;
	viewport: PreviewSize;
	initialSize: PreviewSize;
	scrollRef: RefObject<HTMLDivElement | null>;
}) {
	const { t } = useTranslation();
	const wrapper = useRef<HTMLDivElement>(null);
	const canvas = useRef<HTMLCanvasElement>(null);
	const textLayer = useRef<HTMLDivElement>(null);
	const renderChain = useRef<Promise<void>>(Promise.resolve());
	const [nearby, setNearby] = useState(number <= 3);
	const [page, setPage] = useState<pdfjsLib.PDFPageProxy | null>(null);
	const [error, setError] = useState(false);
	const size = page?.getViewport({ scale: 1 }) ?? initialSize;
	const scale = previewScale(mode, size, viewport);

	useEffect(() => {
		if (!wrapper.current || typeof IntersectionObserver === "undefined") {
			setNearby(true);
			return;
		}
		const observer = new IntersectionObserver((entries) => setNearby(entries.some((entry) => entry.isIntersecting)), {
			root: scrollRef.current,
			rootMargin: "600px 0px",
		});
		observer.observe(wrapper.current);
		return () => observer.disconnect();
	}, [scrollRef]);

	useEffect(() => {
		if (!nearby || page) return;
		let cancelled = false;
		void doc.getPage(number).then(
			(value) => {
				if (!cancelled) setPage(value);
			},
			() => {
				if (!cancelled) setError(true);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [doc, number, nearby, page]);

	useEffect(() => {
		if (!page || !nearby || !canvas.current || !textLayer.current) return;
		let cancelled = false;
		let task: ReturnType<pdfjsLib.PDFPageProxy["render"]> | undefined;
		let layer: InstanceType<typeof pdfjsLib.TextLayer> | undefined;
		const target = canvas.current;
		const textTarget = textLayer.current;
		// A cancelled render must settle before the same canvas can be reused.
		renderChain.current = renderChain.current
			.catch(() => {})
			.then(async () => {
				if (cancelled) return;
				const context = target.getContext("2d");
				if (!context) return;
				setError(false);
				const dpr = window.devicePixelRatio || 1;
				const displayViewport = page.getViewport({ scale });
				const renderViewport = page.getViewport({ scale: scale * dpr });
				target.width = Math.ceil(renderViewport.width);
				target.height = Math.ceil(renderViewport.height);
				target.style.width = `${displayViewport.width}px`;
				target.style.height = `${displayViewport.height}px`;
				task = page.render({ canvasContext: context, viewport: renderViewport });
				await task.promise;
				if (cancelled) return;
				textTarget.replaceChildren();
				textTarget.style.setProperty("--scale-factor", String(scale));
				layer = new pdfjsLib.TextLayer({
					container: textTarget,
					textContentSource: page.streamTextContent(),
					viewport: displayViewport,
				});
				await layer.render();
			})
			.catch(() => {
				if (!cancelled) setError(true);
			});
		return () => {
			cancelled = true;
			task?.cancel();
			layer?.cancel();
		};
	}, [page, nearby, scale]);

	return (
		<div
			ref={wrapper}
			className="pdf-page-wrapper"
			data-page={number}
			style={{ width: size.width * scale, height: size.height * scale }}
		>
			<canvas ref={canvas} />
			<div ref={textLayer} className="textLayer" />
			{error && (
				<div className="preview-error-state" role="alert">
					{t("Failed to render page")}
				</div>
			)}
		</div>
	);
}

export function PdfViewer({ fileName, file, byteLength, bytes, onClose, onOpenDefault, onReveal }: PdfViewerProps) {
	const { t } = useTranslation();
	const selection = useDocumentSelection(file, bytes);
	const [doc, setDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
	const [initialSize, setInitialSize] = useState<PreviewSize>({ width: 800, height: 1130 });
	const [currentPage, setCurrentPage] = useState(1);
	const [mode, setMode] = useState<PreviewZoom>("width");
	const [inverted, setInverted] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const { ref: scrollRef, size } = usePreviewViewport();
	const resizing = usePreviewExpansion()?.resizing ?? false;
	const anchor = useRef({ page: 1, fraction: 0 });
	const zoom = previewScale(mode, initialSize, size) * 100;
	const capture = () => {
		const native = window.getSelection();
		if (!selection.enabled || !native?.rangeCount || !scrollRef.current) return;
		const range = native.getRangeAt(0).cloneRange();
		const value = pdfTextSelection(scrollRef.current, range, native.toString());
		if (value) selection.select(value.target, value.text, range);
	};

	useEffect(() => {
		let cancelled = false;
		setDoc(null);
		setError(null);
		setMode("width");
		setCurrentPage(1);
		anchor.current = { page: 1, fraction: 0 };
		if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
			setError(t("Failed to load PDF document"));
			return;
		}
		// PDF.js transfers ownership to its worker. Keep the preview cache's bytes intact.
		const task = pdfjsLib.getDocument({
			data: Uint8Array.from(bytes),
			cMapUrl: pdfCMapUrl(),
			cMapPacked: true,
			standardFontDataUrl: pdfStandardFontDataUrl(),
		});
		void task.promise
			.then(async (document) => {
				const first = await document.getPage(1);
				if (cancelled) return;
				const viewport = first.getViewport({ scale: 1 });
				setInitialSize({ width: viewport.width, height: viewport.height });
				setDoc(document);
			})
			.catch((cause) => {
				if (!cancelled) setError(cause instanceof Error ? cause.message : t("Failed to load PDF document"));
			});
		return () => {
			cancelled = true;
			void task.destroy();
		};
	}, [bytes, t]);

	useLayoutEffect(() => {
		const container = scrollRef.current;
		const page = container?.querySelector<HTMLElement>(`[data-page="${anchor.current.page}"]`);
		if (!container || !page) return;
		container.scrollTop +=
			page.getBoundingClientRect().top -
			container.getBoundingClientRect().top -
			16 +
			anchor.current.fraction * page.offsetHeight;
	}, [mode, size, scrollRef, resizing]);

	const trackPosition = () => {
		if (resizing) return;
		const container = scrollRef.current;
		if (!container) return;
		const top = container.getBoundingClientRect().top + 16;
		const pages = Array.from(container.querySelectorAll<HTMLElement>(".pdf-page-wrapper"));
		const page =
			pages.find(
				(element) =>
					element.getBoundingClientRect().bottom >
					top + Math.min(element.offsetHeight / 2, container.clientHeight / 2),
			) ?? pages.at(-1);
		if (!page) return;
		const number = Number(page.dataset.page);
		anchor.current = {
			page: number,
			fraction: (top - page.getBoundingClientRect().top) / Math.max(1, page.offsetHeight),
		};
		setCurrentPage(number);
	};
	const goToPage = (number: number) => {
		const container = scrollRef.current;
		const page = container?.querySelector<HTMLElement>(`[data-page="${number}"]`);
		if (!container || !page) return;
		container.scrollTop += page.getBoundingClientRect().top - container.getBoundingClientRect().top - 16;
		anchor.current = { page: number, fraction: 0 };
		setCurrentPage(number);
	};
	return (
		<div className="universal-previewer pdf-previewer">
			<PreviewToolbar
				byteLength={byteLength}
				fileName={fileName}
				onClose={onClose}
				onOpenDefault={onOpenDefault}
				onReveal={onReveal}
				zoom={zoom}
				zoomMode={mode}
				onZoomModeChange={setMode}
				onZoomIn={() => setMode(Math.max(10, Math.min(300, Math.round(zoom) + 20)))}
				onZoomOut={() => setMode(Math.max(10, Math.min(300, Math.round(zoom) - 20)))}
				isInverted={inverted}
				onToggleInvert={() => setInverted((value) => !value)}
				showInvertToggle
				extraActions={doc && <PreviewPageControls current={currentPage} total={doc.numPages} onChange={goToPage} />}
			/>
			<div
				ref={scrollRef}
				onPointerUp={(event) => {
					if (event.button === 0) capture();
				}}
				onKeyUp={(event) => {
					if (event.key === "Shift") capture();
				}}
				role="document"
				aria-label={fileName}
				onScroll={trackPosition}
				className={`preview-viewport pdf-canvas-container${inverted ? " is-inverted" : ""}`}
			>
				{error ? (
					<div className="preview-error-state" role="alert">
						{error}
					</div>
				) : !doc ? (
					<div className="preview-loading-state">
						<SpinnerGap className="is-spinning" size={28} />
						<span>{t("Loading PDF document…")}</span>
					</div>
				) : (
					Array.from({ length: doc.numPages }, (_, index) => (
						<PdfPage
							key={index}
							doc={doc}
							number={index + 1}
							mode={mode}
							viewport={size}
							initialSize={initialSize}
							scrollRef={scrollRef}
						/>
					))
				)}
			</div>
			{selection.popover}
		</div>
	);
}
