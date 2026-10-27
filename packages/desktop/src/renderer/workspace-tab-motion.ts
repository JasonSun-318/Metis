/** Strip-local tab lifecycle motion. The tab model changes immediately; this only times chrome. */
export const TAB_MOTION_DURATION_MS = 180;
export const TAB_MOTION_EASING = "cubic-bezier(.16, 1, .3, 1)";
export const TAB_MOTION_KEY_ATTRIBUTE = "data-tab-motion-key";
export const TAB_MOTION_GHOST_CLASS = "tool-tab-motion-ghost";

/** Flow coordinates relative to the strip, unaffected by in-flight transforms. */
export function tabStripLayout(
	el: HTMLElement,
	host: HTMLElement | null,
): { left: number; top: number; width: number; height: number } {
	let left = 0;
	let top = 0;
	let node: HTMLElement | null = el;
	while (node && node !== host) {
		left += node.offsetLeft;
		top += node.offsetTop;
		node = node.offsetParent instanceof HTMLElement ? node.offsetParent : null;
	}
	return { left, top, width: el.offsetWidth, height: el.offsetHeight };
}

/**
 * Either application or OS reduced motion suppresses effects. The root's `full`
 * value is resolved presentation state, not a user override of the OS setting.
 */
export function tabMotionReduced(root: ParentNode | null = globalThis.document?.documentElement ?? null): boolean {
	const preference = root instanceof HTMLElement ? root.dataset.motion : undefined;
	if (preference === "reduced") return true;
	return typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function tabMotionAnimationsSupported(): boolean {
	return typeof HTMLElement === "function" && typeof HTMLElement.prototype.animate === "function";
}

/**
 * A removed tab leaves only inert visual chrome behind. Strip every role, ID and
 * focusable affordance so the remnant can never duplicate the tab's semantics or
 * intercept a gesture before its exit animation ends.
 */
export function sanitizeTabMotionGhost(ghost: HTMLElement): void {
	for (const el of [ghost, ...Array.from(ghost.querySelectorAll<HTMLElement>("*"))]) {
		el.removeAttribute("id");
		el.removeAttribute("role");
		el.removeAttribute("tabindex");
		el.removeAttribute("draggable");
		el.removeAttribute("data-tab-id");
		el.removeAttribute("data-drop-index");
		el.removeAttribute(TAB_MOTION_KEY_ATTRIBUTE);
		for (const attribute of Array.from(el.attributes)) {
			if (attribute.name.startsWith("aria-") || attribute.name === "contenteditable") {
				el.removeAttribute(attribute.name);
			}
		}
	}
	ghost.setAttribute("aria-hidden", "true");
	ghost.setAttribute("inert", "");
}
