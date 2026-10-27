import { type ReactNode, useLayoutEffect, useRef } from "react";
import {
	COMPOSER_PANEL_MOTION_EASING,
	COMPOSER_PANEL_MOTION_MS,
	composerPanelMotionReduced,
	measureComposerPanelContent,
} from "../composer-panel-motion.ts";

export function ComposerPanelStack({ children }: { readonly children: ReactNode }) {
	const stack = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);

	useLayoutEffect(() => {
		const element = stack.current;
		const body = content.current;
		if (!element || !body) return;

		const pane = element.closest<HTMLElement>(".conversation-column");
		const composer = element.parentElement?.querySelector<HTMLElement>(".composer");
		let previousInteraction: Element | null = null;
		let previousOffset = -1;
		let previousHeight = -1;
		let frame = 0;
		let revealTimer: ReturnType<typeof setTimeout> | undefined;
		let heightAnimation: Animation | null = null;
		let reduced = composerPanelMotionReduced();

		const cancelHeight = () => {
			heightAnimation?.cancel();
			heightAnimation = null;
		};
		let targetHeight = -1;
		const displayedHeight = () => element.getBoundingClientRect().height;
		const settle = (height: number) => {
			cancelHeight();
			element.style.height = `${height}px`;
		};
		/** Retarget the one outer height animation. A newer measurement always replaces the previous one. */
		const animateHeight = (height: number) => {
			if (targetHeight === height || (height > 0 && targetHeight > 0 && Math.abs(targetHeight - height) < 0.5))
				return;
			targetHeight = height;
			const from = displayedHeight();
			if (Math.abs(from - height) < 0.5) {
				settle(height);
				return;
			}
			if (reduced || typeof element.animate !== "function") {
				settle(height);
				return;
			}
			cancelHeight();
			element.style.height = `${height}px`;
			try {
				const animation = element.animate([{ height: `${from}px` }, { height: `${height}px` }], {
					duration: COMPOSER_PANEL_MOTION_MS,
					easing: COMPOSER_PANEL_MOTION_EASING,
					fill: "none",
				});
				heightAnimation = animation;
				void animation.finished
					.catch(() => undefined)
					.finally(() => {
						if (heightAnimation === animation) heightAnimation = null;
					});
			} catch {
				settle(height);
			}
		};
		const resize = () => {
			const paneHeight = pane?.clientHeight || window.innerHeight;
			const composerHeight = composer?.getBoundingClientRect().height ?? 0;
			const pendingRequest = body.querySelector(".ask-user-slot, .permission-approval-slot");
			const limit = Math.max(
				40,
				Math.min(
					360,
					paneHeight * (pendingRequest ? 0.65 : 0.45),
					paneHeight - composerHeight - (pendingRequest ? 48 : 120),
				),
			);
			element.style.setProperty("--composer-panels-limit", `${Math.floor(limit)}px`);
			const measured = measureComposerPanelContent(body);
			if (measured !== null) {
				const height = Math.min(measured, Math.floor(limit));
				// A disclosure/closing transition already owns layout. Follow its measured
				// height rather than adding a second, delayed animation to each frame.
				const layoutMoving = body
					.getAnimations?.({ subtree: true })
					.some(
						(animation) =>
							animation.playState === "running" &&
							animation.effect instanceof KeyframeEffect &&
							animation.effect
								.getKeyframes()
								.some((keyframe) => "height" in keyframe || "gridTemplateRows" in keyframe),
					);
				if (layoutMoving && !heightAnimation) {
					targetHeight = height;
					settle(height);
				} else animateHeight(height);
			}

			const interaction = body.querySelector<HTMLElement>(
				".ask-user-slot, .ask-user-resume, .permission-approval-slot",
			);
			if (!interaction) {
				previousInteraction = null;
				return;
			}
			const target = interaction.getBoundingClientRect();
			const offset = interaction.offsetTop;
			// Reveal a new or resized request once. Unrelated updates must not undo a manual scroll.
			if (
				interaction !== previousInteraction ||
				Math.abs(offset - previousOffset) > 0.5 ||
				(Math.abs(target.height - previousHeight) > 0.5 && interaction.contains(document.activeElement))
			) {
				clearTimeout(revealTimer);
				revealTimer = setTimeout(
					() => {
						if (!interaction.isConnected) return;
						const available = element.clientHeight;
						element.scrollTop =
							interaction.offsetHeight <= available
								? Math.max(0, interaction.offsetTop + interaction.offsetHeight - available)
								: interaction.offsetTop;
					},
					reduced ? 0 : COMPOSER_PANEL_MOTION_MS,
				);
			}
			previousInteraction = interaction;
			previousOffset = offset;
			previousHeight = target.height;
		};
		const schedule = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				resize();
			});
		};
		const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(schedule);
		if (pane) observer?.observe(pane);
		if (composer) observer?.observe(composer);
		observer?.observe(body);
		let observed: Element[] = [];
		const observePanels = () => {
			for (const panel of observed) observer?.unobserve(panel);
			observed = Array.from(body.children);
			for (const panel of observed) observer?.observe(panel);
			resize();
		};
		const mutations = new MutationObserver(observePanels);
		mutations.observe(body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["hidden", "class"],
		});
		const motion = new MutationObserver(() => {
			reduced = composerPanelMotionReduced();
			if (reduced) {
				cancelHeight();
				resize();
			}
		});
		motion.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
		const media = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
		const onMotionChange = () => {
			reduced = composerPanelMotionReduced();
			if (reduced) {
				cancelHeight();
				resize();
			}
		};
		media?.addEventListener?.("change", onMotionChange);
		observePanels();
		window.addEventListener("resize", schedule);
		return () => {
			cancelHeight();
			clearTimeout(revealTimer);
			if (frame) cancelAnimationFrame(frame);
			observer?.disconnect();
			mutations.disconnect();
			motion.disconnect();
			media?.removeEventListener?.("change", onMotionChange);
			window.removeEventListener("resize", schedule);
		};
	}, []);

	return (
		<div className="composer-panels" ref={stack} style={{ height: 0 }}>
			<div className="composer-panels-content" ref={content}>
				{children}
			</div>
		</div>
	);
}
