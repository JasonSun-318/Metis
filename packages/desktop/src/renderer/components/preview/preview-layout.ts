import { useLayoutEffect, useRef, useState } from "react";

export type PreviewZoom = "width" | "page" | number;
export interface PreviewSize {
	width: number;
	height: number;
}

export function previewScale(mode: PreviewZoom, page: PreviewSize, viewport: PreviewSize): number {
	if (typeof mode === "number") return mode / 100;
	if (viewport.width <= 0 || viewport.height <= 0 || page.width <= 0 || page.height <= 0) return 1;
	const widthScale = viewport.width / page.width;
	return mode === "width" ? widthScale : Math.min(widthScale, viewport.height / page.height);
}

export function usePreviewViewport() {
	const ref = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState<PreviewSize>({ width: 0, height: 0 });
	useLayoutEffect(() => {
		const element = ref.current;
		if (!element) return;
		const measure = () => {
			const style = getComputedStyle(element);
			const width = Math.max(
				0,
				element.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0),
			);
			const height = Math.max(
				0,
				element.clientHeight - (parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0),
			);
			setSize((previous) => (previous.width === width && previous.height === height ? previous : { width, height }));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	return { ref, size };
}
