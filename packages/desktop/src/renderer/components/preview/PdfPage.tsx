import * as pdfjsLib from "pdfjs-dist";
import { type RefObject, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { type PreviewSize, type PreviewZoom, previewScale } from "./preview-layout.ts";

export function PdfPage({
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
