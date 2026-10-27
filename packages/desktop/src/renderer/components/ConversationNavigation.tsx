import {
	type MouseEvent,
	type PointerEvent,
	type RefObject,
	useEffect,
	useId,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
	clamp,
	clampOffset,
	DRAG_THRESHOLD,
	dragScrollTop,
	MARK_SPACING,
	MARK_WIDTH,
	MAX_TRACK_HEIGHT,
	markWidth,
	navigationEntryTitle,
	navigationViewportHeight,
} from "../conversation-navigation.ts";
import { useConversationNavigationWindow } from "./use-conversation-navigation-window.ts";

export interface ConversationNavigationEntry {
	readonly itemId: string;
	readonly rowIndex: number;
	readonly text: string;
	readonly answer: string;
	readonly attachments: readonly string[];
}

interface ScrollMetrics {
	readonly top: number;
	readonly viewport: number;
	readonly span: number;
}

interface DragGesture {
	readonly pointerId: number;
	readonly startY: number;
	readonly startTop: number;
	dragging: boolean;
}

export function ConversationNavigation({
	entries,
	activeIndex,
	scrollRef,
	contentHeight,
	onScrollToOffset,
	onJump,
	onScrollGesture,
}: {
	readonly entries: readonly ConversationNavigationEntry[];
	readonly activeIndex: number;
	readonly scrollRef: RefObject<HTMLDivElement | null>;
	readonly contentHeight: number;
	readonly onScrollToOffset: (offset: number) => void;
	readonly onJump: (entry: ConversationNavigationEntry) => void;
	readonly onScrollGesture?: (active: boolean) => void;
}) {
	const { t } = useTranslation();
	const hintId = useId();
	const previewRef = useRef<HTMLButtonElement>(null);
	const gesture = useRef<DragGesture | null>(null);
	const suppressClick = useRef(false);
	const gestureCallback = useRef(onScrollGesture);
	const scrollCallback = useRef(onScrollToOffset);
	const scrollFrame = useRef(0);
	const pendingOffset = useRef<number | null>(null);
	const previewCloseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const [previewId, setPreviewId] = useState<string | null>(null);
	const pointerY = useRef<number | null>(null);
	const keyboardBrowsing = useRef(false);
	const [previewTop, setPreviewTop] = useState(0);
	const [dragging, setDragging] = useState(false);
	const [metrics, setMetrics] = useState<ScrollMetrics>({ top: 0, viewport: 0, span: 0 });
	const rail = useConversationNavigationWindow(entries, activeIndex, dragging);
	const { navRef, trackRef } = rail;
	gestureCallback.current = onScrollGesture;
	scrollCallback.current = onScrollToOffset;
	const foundPreview = previewId === null ? -1 : entries.findIndex((entry) => entry.itemId === previewId);
	const previewIndex = foundPreview >= 0 ? foundPreview : null;
	const cancelPreviewClose = () => {
		if (previewCloseTimer.current !== null) clearTimeout(previewCloseTimer.current);
		previewCloseTimer.current = null;
	};
	const ownsKeyboardPreview = () =>
		previewRef.current?.contains(document.activeElement) ||
		(keyboardBrowsing.current && trackRef.current === document.activeElement);
	const setPreviewIndex = (index: number | null) => {
		cancelPreviewClose();
		setPreviewId(index === null ? null : (entries[clamp(index, 0, entries.length - 1)]?.itemId ?? null));
	};

	// Read the live transcript scroll range without polling. contentHeight and
	// history length re-measure because scrollHeight moves without a scroll event.
	// biome-ignore lint/correctness/useExhaustiveDependencies: Reattach after empty-history mounting and remeasure non-scroll DOM content growth.
	useEffect(() => {
		const scroll = scrollRef.current;
		const nav = navRef.current;
		if (!scroll || !nav) return;
		let frame = 0;
		const read = () => {
			const next = {
				top: scroll.scrollTop,
				viewport: scroll.clientHeight,
				span: scroll.scrollHeight,
			};
			setMetrics((current) =>
				current.top === next.top && current.viewport === next.viewport && current.span === next.span
					? current
					: next,
			);
		};
		const schedule = () => {
			if (frame) return;
			frame = requestAnimationFrame(() => {
				frame = 0;
				read();
			});
		};
		const observer = new ResizeObserver(schedule);
		observer.observe(scroll);
		if (scroll.firstElementChild) observer.observe(scroll.firstElementChild);
		scroll.addEventListener("scroll", schedule, { passive: true });
		window.addEventListener("resize", schedule);
		read();
		return () => {
			if (frame) cancelAnimationFrame(frame);
			observer.disconnect();
			scroll.removeEventListener("scroll", schedule);
			window.removeEventListener("resize", schedule);
		};
	}, [scrollRef, contentHeight, entries.length]);

	// Native overflow scrolling browses index rows. Only an active document drag
	// consumes wheel input; no index wheel writes the transcript's scroll position.
	useEffect(() => {
		if (entries.length === 0) return;
		const track = trackRef.current;
		if (!track) return;
		const browseIndex = (event: WheelEvent) => {
			if (gesture.current?.dragging) {
				event.preventDefault();
				return;
			}
			pointerY.current = event.clientY;
			keyboardBrowsing.current = false;
			rail.browse();
		};
		track.addEventListener("wheel", browseIndex, { passive: false });
		return () => track.removeEventListener("wheel", browseIndex);
	}, [entries.length, trackRef, rail.browse]);

	// A drag must never leave the parent gesture callback active.
	useEffect(() => {
		const endGesture = () => {
			const active = gesture.current;
			if (!active) return;
			gesture.current = null;
			if (scrollFrame.current) cancelAnimationFrame(scrollFrame.current);
			scrollFrame.current = 0;
			pendingOffset.current = null;
			setDragging(false);
			setPreviewId(null);
			if (previewCloseTimer.current !== null) clearTimeout(previewCloseTimer.current);
			previewCloseTimer.current = null;
			if (active.dragging) gestureCallback.current?.(false);
			if (trackRef.current?.hasPointerCapture?.(active.pointerId))
				trackRef.current.releasePointerCapture(active.pointerId);
		};
		window.addEventListener("blur", endGesture);
		return () => {
			window.removeEventListener("blur", endGesture);
			if (gesture.current?.dragging) gestureCallback.current?.(false);
			gesture.current = null;
			if (scrollFrame.current) cancelAnimationFrame(scrollFrame.current);
			scrollFrame.current = 0;
			pendingOffset.current = null;
			if (previewCloseTimer.current !== null) clearTimeout(previewCloseTimer.current);
			previewCloseTimer.current = null;
		};
	}, [trackRef]);

	const span = metrics.span > 0 ? metrics.span : contentHeight;

	const selectedIndex = Math.max(0, Math.min(entries.length - 1, previewIndex ?? activeIndex));
	const previewOpen = previewIndex !== null && !dragging;
	const selected = entries[selectedIndex];
	const title = selected ? navigationEntryTitle(selected, t("Attachment message")) : "";
	const preferredTop = rail.positionAt(selectedIndex);
	useLayoutEffect(() => {
		const element = previewRef.current;
		if (!previewOpen || !element) return;
		const measure = () => {
			const half = Math.min(element.getBoundingClientRect().height, Math.max(0, rail.viewport.available - 8)) / 2;
			const next = clamp(preferredTop, half + 4, Math.max(half + 4, rail.viewport.available - half - 4));
			setPreviewTop((current) => (Math.abs(current - next) < 0.1 ? current : next));
		};
		const observer = new ResizeObserver(measure);
		observer.observe(element);
		measure();
		return () => observer.disconnect();
	}, [preferredTop, previewOpen, rail.viewport.available]);
	if (!selected) return null;
	const sigma = Math.max(3, (rail.viewport.height / MARK_SPACING) * 0.12);

	const releaseGesture = (event?: PointerEvent<HTMLDivElement>) => {
		const active = gesture.current;
		if (!active) return;
		if (event && event.pointerId !== active.pointerId) return;
		const wasDragging = active.dragging;
		gesture.current = null;
		if (scrollFrame.current) cancelAnimationFrame(scrollFrame.current);
		scrollFrame.current = 0;
		if (wasDragging && event?.type === "pointerup" && pendingOffset.current !== null)
			scrollCallback.current(pendingOffset.current);
		pendingOffset.current = null;
		if (wasDragging) {
			setDragging(false);
			gestureCallback.current?.(false);
		}
		if (event) {
			try {
				event.currentTarget.releasePointerCapture(event.pointerId);
			} catch {
				// The pointer or its capture may already be gone; drag state clears regardless.
			}
		}
	};

	const handlePointerDown = (event: PointerEvent<HTMLDivElement>) => {
		if (event.button !== 0 || event.isPrimary === false) return;
		event.preventDefault();
		keyboardBrowsing.current = false;
		if (gesture.current?.dragging) releaseGesture();
		suppressClick.current = false;
		gesture.current = {
			pointerId: event.pointerId,
			startY: event.clientY,
			startTop: scrollRef.current?.scrollTop ?? metrics.top,
			dragging: false,
		};
		try {
			event.currentTarget.setPointerCapture(event.pointerId);
		} catch {
			// Capture is best-effort; dragging still works while the pointer stays over the rail.
		}
		event.currentTarget.focus({ preventScroll: true });
	};

	const handlePointerMove = (event: PointerEvent<HTMLDivElement>) => {
		const active = gesture.current;
		if (!active || event.pointerId !== active.pointerId) {
			pointerY.current = event.clientY;
			keyboardBrowsing.current = false;
			rail.browse();
			setPreviewIndex(rail.indexAt(event.clientY));
			return;
		}
		const deltaY = event.clientY - active.startY;
		if (!active.dragging && Math.abs(deltaY) > DRAG_THRESHOLD) {
			active.dragging = true;
			suppressClick.current = true;
			setDragging(true);
			pointerY.current = null;
			rail.stopBrowsing();
			setPreviewIndex(null);
			gestureCallback.current?.(true);
		}
		if (!active.dragging) return;
		const scroll = scrollRef.current;
		if (!scroll) return;
		const range = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
		pendingOffset.current = dragScrollTop(active.startTop, deltaY, trackRef.current?.clientHeight ?? 0, range);
		if (!scrollFrame.current)
			scrollFrame.current = requestAnimationFrame(() => {
				scrollFrame.current = 0;
				if (gesture.current?.dragging && pendingOffset.current !== null) {
					scrollCallback.current(pendingOffset.current);
					pendingOffset.current = null;
				}
			});
	};

	const handleClick = (event: MouseEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		if (suppressClick.current) {
			suppressClick.current = false;
			return;
		}
		const index = rail.indexAt(event.clientY);
		pointerY.current = null;
		setPreviewIndex(null);
		onJump(entries[index]!);
	};

	const scrollByViewport = (direction: number) => {
		keyboardBrowsing.current = false;
		setPreviewIndex(null);
		rail.stopBrowsing(true);
		const scroll = scrollRef.current;
		if (!scroll) return;
		const range = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
		onScrollToOffset(clampOffset(scroll.scrollTop + direction * scroll.clientHeight, range));
	};

	return (
		<nav
			ref={navRef}
			hidden={entries.length === 1 && metrics.viewport > 0 && span <= metrics.viewport}
			className={`conversation-navigation${dragging ? " is-dragging" : ""}`}
			aria-label={t("Conversation navigation")}
			onPointerEnter={cancelPreviewClose}
			onPointerLeave={() => {
				if (dragging) return;
				if (!ownsKeyboardPreview()) rail.stopBrowsing();
				pointerY.current = null;
				cancelPreviewClose();
				previewCloseTimer.current = setTimeout(() => {
					previewCloseTimer.current = null;
					if (ownsKeyboardPreview()) return;
					setPreviewId(null);
				}, 120);
			}}
			onKeyDown={(event) => {
				if (event.key !== "Escape" || event.defaultPrevented) return;
				event.preventDefault();
				trackRef.current?.focus({ preventScroll: true });
				keyboardBrowsing.current = false;
				rail.stopBrowsing(true);
				setPreviewIndex(null);
			}}
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) {
					rail.stopBrowsing(true);
					pointerY.current = null;
					keyboardBrowsing.current = false;
					setPreviewIndex(null);
				}
			}}
		>
			<div
				className={`conversation-navigation-window${rail.canScrollUp ? " is-scrollable-above" : ""}${rail.canScrollDown ? " is-scrollable-below" : ""}`}
				data-fade-top={rail.canScrollUp}
				data-fade-bottom={rail.canScrollDown}
				style={{ height: `${navigationViewportHeight(entries.length, MAX_TRACK_HEIGHT)}px` }}
			>
				<div
					ref={trackRef}
					className="conversation-navigation-track"
					role="slider"
					tabIndex={0}
					aria-label={t("Conversation navigation")}
					aria-describedby={hintId}
					aria-orientation="vertical"
					aria-valuemin={1}
					aria-valuemax={entries.length}
					aria-valuenow={selectedIndex + 1}
					aria-valuetext={`${t("Message {{index}} of {{count}}", { index: selectedIndex + 1, count: entries.length })}: ${title}`}
					onFocus={() => {
						pointerY.current = null;
						keyboardBrowsing.current = trackRef.current?.matches(":focus-visible") ?? false;
						rail.browse();
						rail.reveal(selectedIndex);
						setPreviewIndex(selectedIndex);
					}}
					onScroll={() => {
						rail.onScroll();
						if (pointerY.current !== null && !gesture.current?.dragging)
							setPreviewIndex(rail.indexAt(pointerY.current));
					}}
					onPointerEnter={(event) => {
						pointerY.current = event.clientY;
						rail.browse();
					}}
					onPointerLeave={() => {
						pointerY.current = null;
					}}
					onPointerDown={handlePointerDown}
					onPointerMove={handlePointerMove}
					onPointerUp={releaseGesture}
					onPointerCancel={releaseGesture}
					onLostPointerCapture={releaseGesture}
					onClick={handleClick}
					onKeyDown={(event) => {
						pointerY.current = null;
						let next = selectedIndex;
						switch (event.key) {
							case "ArrowUp":
							case "ArrowLeft":
								next -= 1;
								break;
							case "ArrowDown":
							case "ArrowRight":
								next += 1;
								break;
							case "Home":
								next = 0;
								break;
							case "End":
								next = entries.length - 1;
								break;
							case "PageUp":
								scrollByViewport(-1);
								event.preventDefault();
								return;
							case "PageDown":
								scrollByViewport(1);
								event.preventDefault();
								return;
							case "Enter":
							case " ":
								event.preventDefault();
								keyboardBrowsing.current = false;
								rail.stopBrowsing();
								onJump(selected);
								setPreviewIndex(null);
								return;
							case "Escape":
								event.preventDefault();
								keyboardBrowsing.current = false;
								rail.stopBrowsing(true);
								setPreviewIndex(null);
								return;
							default:
								return;
						}
						event.preventDefault();
						const index = clamp(next, 0, entries.length - 1);
						keyboardBrowsing.current = true;
						rail.browse();
						rail.reveal(index);
						setPreviewIndex(index);
					}}
				>
					<div
						className="conversation-navigation-ticks"
						aria-hidden="true"
						style={{ height: `${rail.contentHeight}px` }}
					>
						{rail.marks.map((mark) => {
							const distance = Math.abs(mark.index - selectedIndex);
							const width = previewOpen ? markWidth(distance) : MARK_WIDTH;
							const alpha = previewOpen
								? Math.max(0.25, 1 - distance * 0.16)
								: 0.25 + 0.75 * Math.exp(-(((mark.index - activeIndex) / sigma) ** 2));
							return (
								<span
									key={mark.key}
									data-navigation-turn={mark.key}
									data-navigation-index={mark.index}
									className={mark.index === selectedIndex ? "is-current" : undefined}
									style={{
										top: `${mark.top}px`,
										width: `${width}px`,
										opacity: alpha.toFixed(3),
									}}
								/>
							);
						})}
					</div>
				</div>
			</div>
			<span className="sr-only" id={hintId}>
				{t("Use arrow keys to preview messages, Enter to jump.")}{" "}
				{t("Scroll to browse messages; drag to scroll the conversation.")}
			</span>
			{previewOpen && (
				<button
					ref={previewRef}
					type="button"
					className="conversation-navigation-preview"
					style={{ top: `${previewTop}px` }}
					onClick={() => {
						onJump(selected);
						setPreviewIndex(null);
					}}
					aria-label={t("Jump to message")}
				>
					<strong>{title}</strong>
					{selected.answer && (
						<span className="conversation-navigation-excerpt">
							{selected.answer
								.replace(/^#{1,6}\s+/gm, "")
								.replace(/\*\*([^*]+)\*\*/g, "$1")
								.replace(/\n{2,}/g, "\n")}
						</span>
					)}
					{selected.attachments.length > 0 && (
						<span className="conversation-navigation-files">{selected.attachments.join(" · ")}</span>
					)}
				</button>
			)}
		</nav>
	);
}
