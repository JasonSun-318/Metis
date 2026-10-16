import type { PptxViewer as PptxRendererInstance } from "@aiden0z/pptx-renderer";
import { SpinnerGap } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { usePreviewExpansion } from "./PreviewFrame.tsx";
import type { UniversalPreviewTarget } from "./PreviewHost.tsx";
import { PreviewPageControls, PreviewToolbar } from "./PreviewToolbar.tsx";
import { mountPptxSelectionLayer } from "./pptx-selection.ts";
import { materializePreviewBlobUrls } from "./preview-blob-urls.ts";
import { type PreviewZoom, previewScale, usePreviewViewport } from "./preview-layout.ts";
import { useDocumentSelection } from "./use-document-selection.tsx";

export interface PptxViewerProps {
	readonly file?: UniversalPreviewTarget;
	readonly fileName: string;
	readonly byteLength?: number;
	readonly bytes: Uint8Array;
	readonly onClose?: () => void;
	readonly onOpenDefault?: () => void;
	readonly onReveal?: () => void;
}

export function PptxViewer({ fileName, file, byteLength, bytes, onClose, onOpenDefault, onReveal }: PptxViewerProps) {
	const { t } = useTranslation();
	const selection = useDocumentSelection(file, bytes);
	const selectionRef = useRef(selection);
	selectionRef.current = selection;
	const hostRef = useRef<HTMLDivElement>(null);
	const { ref: viewportRef, size } = usePreviewViewport();
	const [viewer, setViewer] = useState<PptxRendererInstance | null>(null);
	const [mode, setMode] = useState<PreviewZoom>("page");
	const [currentPage, setCurrentPage] = useState(1);
	const currentPageRef = useRef(currentPage);
	currentPageRef.current = currentPage;
	const resizing = usePreviewExpansion()?.resizing ?? false;
	const resizingRef = useRef(resizing);
	resizingRef.current = resizing;
	const zoom =
		previewScale(mode, { width: viewer?.slideWidth ?? 960, height: viewer?.slideHeight ?? 540 }, size) * 100;
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	const hasFile = file !== undefined;
	// biome-ignore lint/correctness/useExhaustiveDependencies(file?.fileId): Changing the selection target requires remounting slide selection layers.
	// biome-ignore lint/correctness/useExhaustiveDependencies(file?.relativePath): Changing the selection target requires remounting slide selection layers.
	// biome-ignore lint/correctness/useExhaustiveDependencies(file?.sessionId): Changing the selection target requires remounting slide selection layers.
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		let cancelled = false;
		let handle: PptxRendererInstance | undefined;
		let observer: MutationObserver | undefined;
		const rendered = new Map<number, HTMLElement>();
		const mountSelection = (index: number, element: HTMLElement) => {
			const slide = handle?.presentationData?.slides[index];
			if (!slide || !hasFile) return;
			mountPptxSelectionLayer(slide, element, index + 1, (value, anchor) =>
				selectionRef.current.select(value.target, value.text, anchor, value.excerpt),
			);
		};
		setLoading(true);
		setViewer(null);
		setMode("page");
		setCurrentPage(1);
		setError(null);
		void (async () => {
			try {
				const { PptxViewer: PptxRenderer, RECOMMENDED_ZIP_LIMITS } = await import("@aiden0z/pptx-renderer");
				if (cancelled) return;
				handle = await PptxRenderer.open(Uint8Array.from(bytes).buffer, host, {
					zipLimits: RECOMMENDED_ZIP_LIMITS,
					fitMode: "none",
					onSlideRendered: (index, element) => {
						rendered.set(index, element);
						mountSelection(index, element);
					},
					onSlideChange: (index) => {
						if (!cancelled && !resizingRef.current) setCurrentPage(index + 1);
					},
					listOptions: { windowed: true },
					scrollContainer: host.parentElement instanceof HTMLElement ? host.parentElement : host,
				});
				if (cancelled) {
					handle?.destroy?.();

					return;
				}
				await materializePreviewBlobUrls(host);
				for (const [index, element] of rendered) if (element.isConnected) mountSelection(index, element);
				rendered.clear();
				if (cancelled) return;
				observer = new MutationObserver(() => {
					void materializePreviewBlobUrls(host);
				});
				observer.observe(host, { childList: true, subtree: true });
				setViewer(handle);
				setLoading(false);
			} catch (cause) {
				if (cancelled) return;
				setError(cause instanceof Error ? cause.message : t("Failed to parse PowerPoint presentation"));
				setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
			observer?.disconnect();
			handle?.destroy?.();

			host.replaceChildren();
		};
	}, [bytes, t, hasFile, file?.sessionId, file?.relativePath, file?.fileId]);

	// biome-ignore lint/correctness/useExhaustiveDependencies(resizing): Resize completion requires restoring the current slide after layout.
	useEffect(() => {
		if (!viewer || size.width <= 0 || size.height <= 0) return;
		let cancelled = false;
		const index = currentPageRef.current - 1;
		void viewer
			.setZoom(zoom)
			.then(async () => {
				if (!cancelled) await viewer.goToSlide(index, { behavior: "instant", block: "start" });
			})
			.catch((cause) => {
				if (!cancelled)
					setError(cause instanceof Error ? cause.message : t("Failed to parse PowerPoint presentation"));
			});
		return () => {
			cancelled = true;
		};
	}, [viewer, zoom, size.width, size.height, resizing, t]);

	const goToPage = (page: number) => {
		currentPageRef.current = page;
		setCurrentPage(page);
		void viewer
			?.goToSlide(page - 1, { behavior: "instant", block: "start" })
			.catch((cause) => setError(String(cause)));
	};
	return (
		<div className="universal-previewer pptx-previewer">
			<PreviewToolbar
				byteLength={byteLength}
				zoom={zoom}
				zoomMode={mode}
				onZoomModeChange={setMode}
				onZoomIn={() => setMode(Math.max(10, Math.min(300, Math.round(zoom) + 20)))}
				onZoomOut={() => setMode(Math.max(10, Math.min(300, Math.round(zoom) - 20)))}
				extraActions={
					viewer && <PreviewPageControls current={currentPage} total={viewer.slideCount} onChange={goToPage} />
				}
				fileName={fileName}
				onClose={onClose}
				onOpenDefault={onOpenDefault}
				onReveal={onReveal}
			/>
			<div
				ref={viewportRef}
				className={`preview-viewport pptx-viewport${selection.enabled ? " can-select-objects" : ""}`}
			>
				{loading && (
					<div className="preview-loading-state">
						<SpinnerGap aria-hidden="true" className="is-spinning" size={28} />
						<span>{t("Loading PowerPoint presentation…")}</span>
					</div>
				)}
				{error && (
					<div className="preview-error-state">
						<span>{error}</span>
					</div>
				)}
				<div className="pptx-render-host" ref={hostRef} />
			</div>
			{selection.popover}
		</div>
	);
}
