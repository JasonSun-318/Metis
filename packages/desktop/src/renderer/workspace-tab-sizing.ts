import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import { TAB_MOTION_GHOST_CLASS, tabStripLayout } from "./workspace-tab-motion.ts";

/** Equal tab widths stay readable below the previous fixed 160px and cap there. */
export const WORKSPACE_TAB_MIN_WIDTH = 104;
export const WORKSPACE_TAB_MAX_WIDTH = 160;
export const WORKSPACE_TAB_WIDTH_PROPERTY = "--workspace-tab-width";

export interface WorkspaceTabWidthInput {
	/** Strip width left after padding, fixed controls and their gaps. */
	availableWidth: number;
	/** Visible group labels, separators and inter-tab gaps. */
	reservedWidth?: number;
	/** Tabs actually on screen; collapsed group members are excluded. */
	visibleTabs: number;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/**
 * Prefer roughly four tabs per strip, then share the remaining room between
 * the tabs that are actually visible. The 104px floor turns extra tabs into
 * horizontal overflow rather than ever narrower labels.
 */
export function calculateWorkspaceTabWidth({
	availableWidth,
	reservedWidth = 0,
	visibleTabs,
}: WorkspaceTabWidthInput): number {
	const available = Number.isFinite(availableWidth) ? Math.max(0, availableWidth) : 0;
	const tabs = Number.isFinite(visibleTabs) ? Math.max(0, Math.floor(visibleTabs)) : 0;
	if (available === 0 || tabs === 0) return WORKSPACE_TAB_MAX_WIDTH;
	const reserved = Number.isFinite(reservedWidth) ? Math.max(0, reservedWidth) : 0;
	const preferred = clamp(available / 4, WORKSPACE_TAB_MIN_WIDTH, WORKSPACE_TAB_MAX_WIDTH);
	const fitted = Math.max(0, available - reserved) / tabs;
	return Math.floor(clamp(Math.min(preferred, fitted), WORKSPACE_TAB_MIN_WIDTH, WORKSPACE_TAB_MAX_WIDTH));
}

function isMotionGhost(el: HTMLElement): boolean {
	return el.closest(`.${TAB_MOTION_GHOST_CLASS}, [inert]`) !== null;
}

/**
 * Collapsed groups omit their body, so their tabs leave the DOM and stop
 * sharing width. A drawer that is still closing keeps its body (clipped) and
 * must keep its width until the layout commit removes it. Removed tabs leave
 * inert, absolutely positioned ghost clones carrying the same class; those
 * are visual remnants and must never share layout.
 */
export function visibleWorkspaceTabElements(scroll: HTMLElement): HTMLElement[] {
	return Array.from(scroll.querySelectorAll<HTMLElement>(".tool-tab")).filter((tab) => !isMotionGhost(tab));
}

/** Flow geometry stays independent of FLIP transforms and absolute ghosts. */
function flowContentWidth(scroll: HTMLElement): number {
	let right = 0;
	for (const el of Array.from(
		scroll.querySelectorAll<HTMLElement>(".tool-tab-group, .tool-tab-group-gap, .tool-tab"),
	)) {
		if (isMotionGhost(el)) continue;
		const layout = tabStripLayout(el, scroll);
		right = Math.max(right, layout.left + layout.width);
	}
	return right;
}

function pixels(value: string): number {
	const parsed = Number.parseFloat(value);
	return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Read the real strip instead of a window breakpoint: padding and the add
 * control are measured outside the scroll area, while labels and separators
 * are the scroll content that is not a tab body.
 */
export function applyWorkspaceTabSizing(scroll: HTMLElement): number | null {
	const bar = scroll.closest<HTMLElement>(".workspace-tabbar");
	if (!bar) return null;
	const barRect = bar.getBoundingClientRect();
	if (!(barRect.width > 0)) return null;
	const style = getComputedStyle(bar);
	const horizontalInset =
		pixels(style.paddingLeft) +
		pixels(style.paddingRight) +
		pixels(style.borderLeftWidth) +
		pixels(style.borderRightWidth);
	const gap = pixels(style.columnGap);
	const children = Array.from(bar.children).filter(
		(child): child is HTMLElement => child instanceof HTMLElement && getComputedStyle(child).display !== "none",
	);
	const fixedControls = children
		.filter((child) => child !== scroll && !child.classList.contains("workspace-tabbar-fill"))
		.reduce((total, child) => total + child.getBoundingClientRect().width, 0);
	const barGaps = Math.max(0, children.length - 1) * gap;
	const availableWidth = Math.max(0, barRect.width - horizontalInset - fixedControls - barGaps);
	const tabs = visibleWorkspaceTabElements(scroll);
	const currentTabWidth = tabs.reduce((total, tab) => total + tab.offsetWidth, 0);
	const reservedWidth = Math.max(0, flowContentWidth(scroll) - currentTabWidth);
	const width = calculateWorkspaceTabWidth({ availableWidth, reservedWidth, visibleTabs: tabs.length });
	const next = `${width}px`;
	if (bar.style.getPropertyValue(WORKSPACE_TAB_WIDTH_PROPERTY) !== next) {
		bar.style.setProperty(WORKSPACE_TAB_WIDTH_PROPERTY, next);
	}
	return width;
}

/**
 * Registers each strip and observes its bar (never the scrolling content) so
 * pane/sidebar resizes recalculate without reacting to the width we just wrote.
 */
export function useWorkspaceTabSizing(
	onSizingChange?: (strip: HTMLDivElement) => void,
): (el: HTMLDivElement | null, previous?: HTMLDivElement | null) => void {
	const strips = useRef(new Set<HTMLDivElement>());
	const bars = useRef(new WeakMap<HTMLDivElement, HTMLElement>());
	const lastWidths = useRef(new WeakMap<HTMLDivElement, number>());
	const onSizingChangeRef = useRef(onSizingChange);
	onSizingChangeRef.current = onSizingChange;
	const observer = useRef<ResizeObserver | null>(null);
	const applyStrip = useCallback((strip: HTMLDivElement, resized = false) => {
		const width = applyWorkspaceTabSizing(strip);
		if (width === null) return;
		const changed = lastWidths.current.get(strip) !== width;
		lastWidths.current.set(strip, width);
		// A resize can clip the same active tab even when the projected width is
		// unchanged (for example at the 104px floor); React renders only notify
		// when that projection actually moved.
		if (changed || resized) onSizingChangeRef.current?.(strip);
	}, []);
	const applyAll = useCallback(() => {
		for (const strip of strips.current) applyStrip(strip);
	}, [applyStrip]);
	const handleResize = useCallback(() => {
		for (const strip of strips.current) applyStrip(strip, true);
	}, [applyStrip]);
	const registerTabStrip = useCallback(
		(el: HTMLDivElement | null, previous?: HTMLDivElement | null) => {
			if (previous && previous !== el) {
				const previousBar = bars.current.get(previous);
				if (previousBar) observer.current?.unobserve(previousBar);
				bars.current.delete(previous);
				lastWidths.current.delete(previous);
				strips.current.delete(previous);
			}
			if (!el) return;
			strips.current.add(el);
			const bar = el.closest<HTMLElement>(".workspace-tabbar");
			if (bar && bars.current.get(el) !== bar) {
				const previousBar = bars.current.get(el);
				if (previousBar) observer.current?.unobserve(previousBar);
				bars.current.set(el, bar);
				observer.current?.observe(bar);
			}
			if (!observer.current && typeof ResizeObserver !== "undefined") {
				observer.current = new ResizeObserver(handleResize);
				for (const strip of strips.current) {
					const observedBar = bars.current.get(strip);
					if (observedBar) observer.current.observe(observedBar);
				}
			}
			applyStrip(el);
		},
		[applyStrip, handleResize],
	);
	// Group collapse, add controls and tab additions are React commits, not bar
	// resizes, so refresh after the motion boundary read its final geometry and
	// reveal the active tab only when the projected width actually changed.
	useLayoutEffect(() => {
		applyAll();
	});
	useEffect(
		() => () => {
			observer.current?.disconnect();
			observer.current = null;
			strips.current.clear();
		},
		[],
	);
	return registerTabStrip;
}
