/** Shared drawer motion. Panels own their domain state; this only times the stack height. */
export const COMPOSER_PANEL_MOTION_MS = 180;
export const COMPOSER_PANEL_MOTION_EASING = "cubic-bezier(.16, 1, .3, 1)";

/**
 * Resolved motion preference: an explicit `data-motion` value wins, otherwise the OS setting.
 * `full` is an intentional override of `prefers-reduced-motion`.
 */
export function composerPanelMotionReduced(
	root: ParentNode | null = globalThis.document?.documentElement ?? null,
): boolean {
	const preference = root instanceof HTMLElement ? root.dataset.motion : undefined;
	if (preference === "reduced") return true;
	if (preference === "full") return false;
	return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * One height sample of the live content. `null` means geometry is not measurable yet
 * (detached, or the browser has not laid the content out), so callers must not animate.
 */
export function measureComposerPanelContent(content: HTMLElement): number | null {
	if (!content.isConnected) return null;
	const height = content.getBoundingClientRect().height;
	return Number.isFinite(height) ? height : null;
}
