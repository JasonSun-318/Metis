/** Shared duration for composer floating panel entry and exit. */
export const COMPOSER_PANEL_MOTION_MS = 180;

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
