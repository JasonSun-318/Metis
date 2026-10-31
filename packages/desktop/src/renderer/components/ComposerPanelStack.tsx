import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import { COMPOSER_PANEL_MOTION_MS, composerPanelMotionReduced } from "../composer-panel-motion.ts";

export function ComposerPanelStack({
	children,
	transient,
	transientClosing = false,
}: {
	readonly children: ReactNode;
	readonly transient?: ReactNode;
	readonly transientClosing?: boolean;
}) {
	const stack = useRef<HTMLDivElement>(null);
	const [lastTransient, setLastTransient] = useState(transient);

	// Retain the outgoing panel only for its exit animation; it becomes inert immediately.
	useLayoutEffect(() => {
		if (transientClosing) {
			setLastTransient(undefined);
			return;
		}
		if (transient) {
			setLastTransient(transient);
			return;
		}
		if (composerPanelMotionReduced()) {
			setLastTransient(undefined);
			return;
		}
		const timer = setTimeout(() => setLastTransient(undefined), COMPOSER_PANEL_MOTION_MS);
		return () => clearTimeout(timer);
	}, [transient, transientClosing]);

	useLayoutEffect(() => {
		const element = stack.current!;
		const surface = element.parentElement!;
		const pane = surface.closest<HTMLElement>(".conversation-column");
		const persistent = element.querySelector<HTMLElement>(".composer-panels-content")!;
		const resize = () => {
			const available = surface.getBoundingClientRect().top - (pane?.getBoundingClientRect().top ?? 0) - 20;
			element.style.setProperty("--composer-panels-limit", `${Math.max(0, Math.min(280, available))}px`);
			// Persistent controls need readable space beneath the last message. Keep that
			// space stable while a temporary menu replaces them.
			if (!persistent.hidden) {
				const height = persistent.getBoundingClientRect().height;
				pane?.style.setProperty("--composer-persistent-height", `${height ? height + 8 : 0}px`);
			}
		};
		const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(resize);
		observer?.observe(surface);
		observer?.observe(persistent);
		if (pane) observer?.observe(pane);
		window.addEventListener("resize", resize);
		resize();
		return () => {
			observer?.disconnect();
			pane?.style.removeProperty("--composer-persistent-height");
			window.removeEventListener("resize", resize);
		};
	}, []);

	const shownTransient = transient || lastTransient;
	return (
		<div className="composer-panels" ref={stack}>
			<div className="composer-panels-content" hidden={Boolean(shownTransient)} inert={Boolean(shownTransient)}>
				{children}
			</div>
			{shownTransient && (
				<div
					className={`composer-transient-panel${transient && !transientClosing ? "" : " is-closing"}`}
					inert={!transient || transientClosing}
					aria-hidden={!transient || transientClosing || undefined}
				>
					{shownTransient}
				</div>
			)}
		</div>
	);
}
