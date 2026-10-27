import { type RefObject, useLayoutEffect } from "react";

const MAX_TRACKING_MS = 1000;

/** Keep an open portal menu attached to its sidebar anchor during list motion. */
export function useSidebarMotionPosition(
	anchor: RefObject<HTMLElement | null>,
	open: boolean,
	updatePosition: () => void,
): void {
	useLayoutEffect(() => {
		if (!open) return;
		const root = anchor.current?.closest<HTMLElement>(".sidebar-list-motion");
		if (!root) return;
		let disposed = false;
		let frame: number | null = null;
		let trackUntil = 0;
		let previousRect: Pick<DOMRect, "left" | "top" | "width" | "height"> | null = null;
		const update = () => {
			if (disposed || !anchor.current?.isConnected) return;
			const { left, top, width, height } = anchor.current.getBoundingClientRect();
			if (
				previousRect?.left === left &&
				previousRect.top === top &&
				previousRect.width === width &&
				previousRect.height === height
			)
				return;
			// Position updates can rewrite SVG children. Cache before notifying so
			// their mutation cannot feed an unchanged anchor back into React state.
			previousRect = { left, top, width, height };
			updatePosition();
		};
		const cancelFrame = () => {
			if (frame === null) return;
			cancelAnimationFrame(frame);
			frame = null;
		};
		const followMotion = (timestamp: number) => {
			frame = null;
			if (disposed) return;
			update();
			if (root.dataset.animating === "true" && timestamp < trackUntil) {
				frame = requestAnimationFrame(followMotion);
			}
		};
		const changed = () => {
			if (disposed) return;
			if (root.dataset.animating === "true") {
				// Each new mutation may restart motion. The cap also prevents a stale
				// animating flag from leaving a permanent frame loop behind.
				trackUntil = performance.now() + MAX_TRACKING_MS;
				if (frame === null) frame = requestAnimationFrame(followMotion);
			} else {
				cancelFrame();
				update();
			}
		};
		const observer = new MutationObserver((records) => {
			if (records.some((record) => record.type === "childList" || record.target === root)) changed();
		});
		observer.observe(root, {
			attributes: true,
			attributeFilter: ["data-animating"],
			childList: true,
			subtree: true,
		});
		if (root.dataset.animating === "true") changed();
		return () => {
			disposed = true;
			observer.disconnect();
			cancelFrame();
		};
	}, [anchor, open, updatePosition]);
}
