import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SpinnerGap } from "../../icons.tsx";
import { PdfPage } from "./PdfPage.tsx";
import { usePreviewExpansion } from "./PreviewFrame.tsx";
import { PreviewPageControls, PreviewToolbar } from "./PreviewToolbar.tsx";
import { pdfTextSelection } from "./pdf-selection.ts";
import type { UniversalPreviewTarget } from "./preview-kinds.ts";
import { type PreviewZoom, previewScale, usePreviewViewport } from "./preview-layout.ts";
import { useDocumentSelection } from "./use-document-selection.tsx";
import { usePdfDocument } from "./use-pdf-document.ts";

export interface PdfViewerProps {
	readonly file?: UniversalPreviewTarget;
	readonly fileName: string;
	readonly byteLength?: number;
	readonly bytes: Uint8Array;
	/** 1-based page to show once the document loads; clamped to the real page count. */
	readonly initialPage?: number;
	readonly onClose?: () => void;
	readonly onOpenDefault?: () => void;
	readonly onReveal?: () => void;
}

export function PdfViewer({
	fileName,
	file,
	byteLength,
	bytes,
	initialPage,
	onClose,
	onOpenDefault,
	onReveal,
}: PdfViewerProps) {
	const { t } = useTranslation();
	const selection = useDocumentSelection(file, bytes);
	const { doc, initialSize, error } = usePdfDocument(bytes);
	const [currentPage, setCurrentPage] = useState(1);
	const [mode, setMode] = useState<PreviewZoom>("width");
	const [inverted, setInverted] = useState(false);
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

	// biome-ignore lint/correctness/useExhaustiveDependencies(bytes): A new bytes payload must reset viewer state even though only the loader reads it.
	useEffect(() => {
		setMode("width");
		setCurrentPage(1);
		anchor.current = { page: 1, fraction: 0 };
	}, [bytes]);

	// biome-ignore lint/correctness/useExhaustiveDependencies(resizing): Mode, viewport size, and resize completion require restoring the saved page anchor after layout.
	// biome-ignore lint/correctness/useExhaustiveDependencies(size): Mode, viewport size, and resize completion require restoring the saved page anchor after layout.
	// biome-ignore lint/correctness/useExhaustiveDependencies(mode): Mode, viewport size, and resize completion require restoring the saved page anchor after layout.
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
	const goToPage = useCallback(
		(number: number) => {
			const container = scrollRef.current;
			const page = container?.querySelector<HTMLElement>(`[data-page="${number}"]`);
			if (!container || !page) return;
			container.scrollTop += page.getBoundingClientRect().top - container.getBoundingClientRect().top - 16;
			anchor.current = { page: number, fraction: 0 };
			setCurrentPage(number);
		},
		[scrollRef],
	);

	useLayoutEffect(() => {
		if (!doc || !initialPage) return;
		goToPage(Math.min(Math.max(1, Math.floor(initialPage)), doc.numPages));
	}, [doc, initialPage, goToPage]);

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
							// biome-ignore lint/suspicious/noArrayIndexKey: PDF pages have fixed ordinal identities and never reorder within the document.
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
