export interface NavigationEntryLike {
	readonly itemId: string;
}

export interface NavigationMark {
	readonly key: string;
	readonly index: number;
	readonly top: number;
}

/** Every real conversation turn occupies one fixed-height index row. */
export const MARK_SPACING = 8;
export const MAX_TRACK_HEIGHT = 640;
export const MIN_TRACK_HEIGHT = 24;
export const MARK_OVERSCAN = 4;
/** Idle marks stay equal width; only hover fans a mark out. */
export const MARK_WIDTH = 6;
export const MARK_FAN_WIDTH = 26;
export const MARK_FAN_FALLOFF = 6;
/** Pointer travel in pixels before a press becomes a continuous drag. */
export const DRAG_THRESHOLD = 4;

export function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

export function navigationViewportHeight(entryCount: number, availableHeight: number): number {
	if (entryCount === 0 || availableHeight <= 0) return 0;
	return Math.min(Math.max(MIN_TRACK_HEIGHT, entryCount * MARK_SPACING), MAX_TRACK_HEIGHT, availableHeight);
}

export function navigationMarkTop(index: number, entryCount: number, viewportHeight: number): number {
	const padding = Math.max(0, (viewportHeight - entryCount * MARK_SPACING) / 2);
	return padding + (index + 0.5) * MARK_SPACING;
}

/** Virtualize the real index rows, retaining their identities and full-list positions. */
export function computeNavigationMarks(
	entries: readonly NavigationEntryLike[],
	viewportHeight: number,
	scrollTop: number,
): NavigationMark[] {
	if (entries.length === 0 || viewportHeight <= 0) return [];
	const offset = clamp(scrollTop, 0, Math.max(0, entries.length * MARK_SPACING - viewportHeight));
	const padding = Math.max(0, (viewportHeight - entries.length * MARK_SPACING) / 2);
	const start = Math.max(0, Math.floor((offset - padding) / MARK_SPACING) - MARK_OVERSCAN);
	const end = Math.min(entries.length, Math.ceil((offset + viewportHeight - padding) / MARK_SPACING) + MARK_OVERSCAN);
	return Array.from({ length: end - start }, (_, slot) => {
		const index = start + slot;
		return { key: entries[index]!.itemId, index, top: navigationMarkTop(index, entries.length, viewportHeight) };
	});
}

export function markWidth(distance: number): number {
	return Math.max(MARK_WIDTH, MARK_FAN_WIDTH - distance * MARK_FAN_FALLOFF);
}

/** Hit-test the fixed rows in the independently scrolled index. */
export function pickNavigationIndex(
	entryCount: number,
	viewportHeight: number,
	scrollTop: number,
	localY: number,
): number {
	if (entryCount === 0) return 0;
	const padding = Math.max(0, (viewportHeight - entryCount * MARK_SPACING) / 2);
	return clamp(Math.floor((scrollTop + localY - padding) / MARK_SPACING), 0, entryCount - 1);
}

/** Reveal a keyboard/document target without moving an already visible row. */
export function navigationScrollOffset(
	index: number,
	entryCount: number,
	viewportHeight: number,
	currentOffset: number,
): number {
	if (entryCount === 0 || viewportHeight <= 0) return 0;
	const range = Math.max(0, entryCount * MARK_SPACING - viewportHeight);
	const current = clamp(currentOffset, 0, range);
	const top = navigationMarkTop(clamp(index, 0, entryCount - 1), entryCount, viewportHeight) - MARK_SPACING / 2;
	if (top < current) return clamp(top - MARK_SPACING, 0, range);
	if (top + MARK_SPACING > current + viewportHeight) return clamp(top + 2 * MARK_SPACING - viewportHeight, 0, range);
	return current;
}

/** Continuous drag mapping: pointer travel scales by the live scroll range per track pixel. */
export function dragScrollTop(startTop: number, deltaY: number, trackHeight: number, maxScroll: number): number {
	if (trackHeight <= 0) return clamp(startTop, 0, maxScroll);
	return clamp(startTop + (deltaY * maxScroll) / trackHeight, 0, maxScroll);
}

export function clampOffset(offset: number, maxScroll: number): number {
	return clamp(offset, 0, maxScroll);
}

export function navigationEntryTitle(
	entry: { readonly text: string; readonly attachments: readonly string[] },
	fallback: string,
): string {
	return entry.text.trim().split("\n")[0] || entry.attachments[0] || fallback;
}
