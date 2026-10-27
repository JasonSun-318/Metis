import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	clamp,
	computeNavigationMarks,
	MARK_SPACING,
	type NavigationEntryLike,
	navigationMarkTop,
	navigationScrollOffset,
	pickNavigationIndex,
} from "../conversation-navigation.ts";

interface IndexViewport {
	readonly height: number;
	readonly top: number;
	readonly available: number;
	readonly offset: number;
}

/** Own only the index viewport; the parent Transcript continues to own document scrolling. */
export function useConversationNavigationWindow(
	entries: readonly NavigationEntryLike[],
	activeIndex: number,
	dragging: boolean,
) {
	const navRef = useRef<HTMLElement>(null);
	const trackRef = useRef<HTMLDivElement>(null);
	const entriesRef = useRef(entries);
	entriesRef.current = entries;
	const browsing = useRef(false);
	const browse = useCallback(() => {
		browsing.current = true;
	}, []);
	const anchor = useRef<{ itemId: string; offset: number } | null>(null);
	const [viewport, setViewport] = useState<IndexViewport>({ height: 0, top: 0, available: 0, offset: 0 });
	const read = useCallback(() => {
		const nav = navRef.current;
		const track = trackRef.current;
		if (!nav || !track) return;
		const history = entriesRef.current;
		const next = {
			height: track.clientHeight,
			top: track.getBoundingClientRect().top - nav.getBoundingClientRect().top,
			available: nav.clientHeight,
			offset: track.scrollTop,
		};
		const index = clamp(Math.floor(next.offset / MARK_SPACING), 0, history.length - 1);
		anchor.current = history[index]
			? { itemId: history[index].itemId, offset: next.offset - index * MARK_SPACING }
			: null;
		setViewport((current) =>
			current.height === next.height &&
			current.top === next.top &&
			current.available === next.available &&
			current.offset === next.offset
				? current
				: next,
		);
	}, []);
	const reveal = useCallback(
		(index: number) => {
			const track = trackRef.current;
			if (!track) return;
			track.scrollTop = navigationScrollOffset(
				index,
				entriesRef.current.length,
				track.clientHeight,
				track.scrollTop,
			);
			read();
		},
		[read],
	);
	const stopBrowsing = useCallback(
		(follow = false) => {
			browsing.current = false;
			if (follow) reveal(activeIndex);
		},
		[activeIndex, reveal],
	);
	const empty = entries.length === 0;
	useLayoutEffect(() => {
		if (empty) return;
		const nav = navRef.current;
		const track = trackRef.current;
		if (!nav || !track) return;
		const observer = new ResizeObserver(read);
		observer.observe(nav);
		observer.observe(track);
		read();
		return () => observer.disconnect();
	}, [empty, read]);
	useLayoutEffect(() => {
		const track = trackRef.current;
		if (!track || viewport.height <= 0) return;
		if (browsing.current && !dragging && anchor.current) {
			const index = entries.findIndex((entry) => entry.itemId === anchor.current!.itemId);
			if (index >= 0)
				track.scrollTop = clamp(
					index * MARK_SPACING + anchor.current.offset,
					0,
					Math.max(0, entries.length * MARK_SPACING - track.clientHeight),
				);
		} else {
			reveal(activeIndex);
		}
		read();
	}, [entries, activeIndex, dragging, viewport.height, read, reveal]);
	const marks = useMemo(
		() => computeNavigationMarks(entries, viewport.height, viewport.offset),
		[entries, viewport.height, viewport.offset],
	);
	return {
		navRef,
		trackRef,
		viewport,
		marks,
		contentHeight: Math.max(viewport.height, entries.length * MARK_SPACING),
		canScrollUp: viewport.offset > 1,
		canScrollDown: viewport.offset + viewport.height < entries.length * MARK_SPACING - 1,
		browse,
		stopBrowsing,
		onScroll: read,
		reveal,
		indexAt: (clientY: number) => {
			const track = trackRef.current;
			return track
				? pickNavigationIndex(
						entries.length,
						track.clientHeight,
						track.scrollTop,
						clientY - track.getBoundingClientRect().top,
					)
				: 0;
		},
		positionAt: (index: number) =>
			viewport.top + navigationMarkTop(index, entries.length, viewport.height) - viewport.offset,
	};
}
