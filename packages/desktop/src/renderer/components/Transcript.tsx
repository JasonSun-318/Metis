import type { AgentMode, ItemView, PlanView, RetryStatusView, SessionDeliveredFileView } from "@metis/app-protocol";
import { defaultRangeExtractor, useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTranscriptScrollFade } from "../hooks/use-transcript-scroll-fade.ts";
import { ArrowDown } from "../icons.tsx";
import { CodeTranscriptTurn } from "./CodeTranscriptTurn.tsx";
import {
	ConversationInteractionContext,
	type ConversationInteractions,
	type InteractionReceipt,
	interactionToolId,
	PendingInteractionCard,
} from "./ConversationInteractionCards.tsx";
import { ConversationNavigation, type ConversationNavigationEntry } from "./ConversationNavigation.tsx";
import { PlanCard } from "./PlanCard.tsx";
import { TranscriptQuoteSelection } from "./TranscriptQuoteSelection.tsx";
import { TranscriptTurn } from "./TranscriptTurn.tsx";
import { TurnRuntimeStatus } from "./TurnRuntimeStatus.tsx";
import { isInternalAgentCoordinationItem, messageText } from "./transcript-turn-model.ts";

interface TranscriptProps {
	readonly interactions?: ConversationInteractions;
	readonly quoteSessionId?: string;
	readonly showNavigation?: boolean;
	readonly submittedTurnId?: string;
	readonly submittedMessageId?: string;
	readonly waitingForAnswer?: boolean;
	readonly retry?: RetryStatusView;
	readonly activeTurnId?: string | null;
	readonly activeRunId?: string;
	readonly activeTurnStartedAt?: string;
	readonly appearance: AgentMode;
	readonly autoLoadOlder?: boolean;
	readonly hasOlder: boolean;
	readonly itemIds: readonly string[];
	readonly itemsById: ReadonlyMap<string, ItemView>;
	readonly loadingOlder: boolean;
	readonly onLoadOlder: () => Promise<void>;
	readonly onFork?: (entryId: string) => void;
	readonly onCopy?: (text: string) => void;
	readonly onOpenDeliveredFile?: (fileId: string, action: "default" | "reveal") => void;
	readonly onPreviewDeliveredFile?: (file: SessionDeliveredFileView) => void;
	readonly onStartPlan?: (plan: PlanView) => void;
	readonly onCancelPlan?: (plan: PlanView) => void;
	readonly onOpenPlan?: (plan: PlanView) => void;
	readonly onRevisePlan?: (plan: PlanView) => void;
	readonly planActionsBusy?: boolean;
	readonly ariaLabel?: string;
	readonly latestLabel?: string;
	readonly olderLabel?: string;
}

interface TranscriptRow {
	readonly key: string;
	readonly itemIds: string[];
}

export function shouldAdjustTranscriptScroll(rowEnd: number, scrollTop: number): boolean {
	return rowEnd < scrollTop;
}

export function shouldFollowTranscript(scrollHeight: number, scrollTop: number, clientHeight: number): boolean {
	return scrollHeight - scrollTop - clientHeight <= 48;
}

function transcriptRows(
	appearance: AgentMode,
	itemIds: readonly string[],
	itemsById: ReadonlyMap<string, ItemView>,
): TranscriptRow[] {
	const rows: TranscriptRow[] = [];
	const byKey = new Map<string, number>();
	let boundaryId: string | undefined;
	let legacyRow: { sessionId: string; index: number } | undefined;
	for (const itemId of itemIds) {
		const item = itemsById.get(itemId);
		if (!item || isInternalAgentCoordinationItem(item) || (item.role === "assistant" && item.content.length === 0))
			continue;
		const boundary =
			item.role === "system" || item.content.some((block) => block.type === "compaction" || block.type === "plan");
		if (boundary) {
			// A standalone card ends this visual segment even if the runtime turn continues.
			byKey.clear();
			legacyRow = undefined;
			boundaryId = item.itemId;
			rows.push({ key: `${item.sessionId}:${appearance}:${item.itemId}`, itemIds: [item.itemId] });
			continue;
		}
		if (item.turnId) legacyRow = undefined;
		else if (item.role !== "user" && legacyRow?.sessionId === item.sessionId) {
			// Older automatic continuations had no durable turn ID. Keep their
			// assistant/tool sequence together so results pair with their calls.
			rows[legacyRow.index]!.itemIds.push(item.itemId);
			continue;
		}
		const key = item.turnId
			? `${item.sessionId}:${appearance}:${item.turnId}${boundaryId ? `:after:${boundaryId}` : ""}`
			: `${item.sessionId}:${appearance}:${item.itemId}`;
		const existingIndex = byKey.get(key);
		if (existingIndex === undefined) {
			byKey.set(key, rows.length);
			rows.push({ key, itemIds: [item.itemId] });
		} else {
			rows[existingIndex]!.itemIds.push(item.itemId);
		}
		if (!item.turnId) legacyRow = { sessionId: item.sessionId, index: existingIndex ?? rows.length - 1 };
	}
	return rows;
}

export function Transcript({
	interactions,
	quoteSessionId,
	showNavigation = false,
	submittedTurnId,
	submittedMessageId,
	waitingForAnswer = false,
	retry,
	activeTurnId,
	activeRunId,
	activeTurnStartedAt,
	appearance,
	ariaLabel = "Conversation transcript",
	autoLoadOlder = false,
	hasOlder,
	itemIds,
	itemsById,
	latestLabel,
	loadingOlder,
	onCancelPlan,
	onCopy,
	onFork,
	onOpenDeliveredFile,
	onOpenPlan,
	onPreviewDeliveredFile,
	onLoadOlder,
	onRevisePlan,
	onStartPlan,
	olderLabel = "Load older messages",
	planActionsBusy = false,
}: TranscriptProps) {
	const { t } = useTranslation();
	const [receipts, setReceipts] = useState<ReadonlyMap<string, InteractionReceipt>>(new Map());
	const boundInteractions = useMemo(() => {
		if (!interactions) return undefined;
		const calls = itemIds.flatMap(
			(id) => itemsById.get(id)?.content.filter((block) => block.type === "tool_call") ?? [],
		);
		return {
			...interactions,
			requests: interactions.requests.map((request) => {
				if (interactionToolId(request)) return request;
				const candidates = calls.filter(
					(call) => call.name === "ask_user" && (call.state === "running" || call.state === "pending"),
				);
				return candidates.length === 1 ? { ...request, toolCallId: candidates[0]!.toolCallId } : request;
			}),
		};
	}, [interactions, itemIds, itemsById]);
	useEffect(() => {
		if (!boundInteractions?.requests.length) return;
		setReceipts((previous) => {
			const next = new Map(previous);
			for (const request of boundInteractions.requests) {
				const id = interactionToolId(request);
				if (id && !next.has(id)) next.set(id, { request });
			}
			return next.size === previous.size ? previous : next;
		});
	}, [boundInteractions]);
	const interactionContext = useMemo(
		() =>
			boundInteractions && {
				...boundInteractions,
				receipts,
				onRespond: async (response: Parameters<ConversationInteractions["onRespond"]>[0]) => {
					const request = boundInteractions.requests.find(
						(request) => request.interactionId === response.interactionId,
					);
					await boundInteractions.onRespond(response);
					const id = request && interactionToolId(request);
					if (id && request) setReceipts((previous) => new Map(previous).set(id, { request, response }));
				},
			},
		[boundInteractions, receipts],
	);
	const rootRef = useRef<HTMLElement>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const scrollContentRef = useRef<HTMLDivElement>(null);
	useTranscriptScrollFade(scrollRef, scrollContentRef);
	const [quoteJump, setQuoteJump] = useState<readonly string[] | null>(null);
	const [quoteLoading, setQuoteLoading] = useState(false);
	const [quoteNotice, setQuoteNotice] = useState("");
	useEffect(() => {
		if (!quoteNotice) return;
		const timer = setTimeout(() => setQuoteNotice(""), 5000);
		return () => clearTimeout(timer);
	}, [quoteNotice]);
	const quoteRequestedCount = useRef<number | null>(null);
	const loadingOlderRef = useRef(false);
	const followLatest = useRef(true);
	const previousScrollTop = useRef(0);
	const railDragging = useRef(false);
	const scrollIntent = useRef(0);
	const consumedSubmission = useRef<string | undefined>(undefined);
	const previousSessionId = useRef<string | undefined>(undefined);
	const [hasNewItems, setHasNewItems] = useState(false);
	const [activeNavigationIndex, setActiveNavigationIndex] = useState(0);
	const [pendingJump, setPendingJump] = useState<string | null>(null);
	const beginManualScroll = useCallback(() => {
		scrollIntent.current += 1;
		followLatest.current = false;
		setPendingJump(null);
		setQuoteJump(null);
	}, []);
	const transcript = useMemo(() => {
		const rows = transcriptRows(appearance, itemIds, itemsById);
		const calls = new Set(
			itemIds.flatMap(
				(id) =>
					itemsById.get(id)?.content.flatMap((block) => (block.type === "tool_call" ? [block.toolCallId] : [])) ??
					[],
			),
		);
		if (boundInteractions?.requests.some((request) => !calls.has(interactionToolId(request) ?? "")))
			rows.push({ key: "pending-interactions", itemIds: [] });
		return rows;
	}, [appearance, itemIds, itemsById, boundInteractions]);
	const pendingRows = transcript.flatMap((row, index) => {
		const calls = new Set(
			row.itemIds.flatMap(
				(id) =>
					itemsById.get(id)?.content.flatMap((block) => (block.type === "tool_call" ? [block.toolCallId] : [])) ??
					[],
			),
		);
		return row.key === "pending-interactions" ||
			boundInteractions?.requests.some((request) => calls.has(interactionToolId(request) ?? ""))
			? [index]
			: [];
	});
	const activeTurnHasRow =
		activeTurnId != null &&
		transcript.some((row) => row.itemIds.some((id) => itemsById.get(id)?.turnId === activeTurnId));
	const navigation = useMemo<ConversationNavigationEntry[]>(
		() =>
			!showNavigation
				? []
				: transcript.flatMap((row, rowIndex) => {
						const items = row.itemIds.flatMap((id) => {
							const item = itemsById.get(id);
							return item ? [item] : [];
						});
						const user = items.find((item) => item.role === "user");
						if (!user) return [];
						const answer = [...items]
							.reverse()
							.find((item) => item.role === "assistant" && messageText(item).trim() !== "");
						return [
							{
								itemId: user.itemId,
								rowIndex,
								text: messageText(user).slice(0, 1200),
								answer: answer ? messageText(answer).slice(0, 1200) : "",
								attachments: user.attachments?.map((file) => file.name) ?? [],
							},
						];
					}),
		[showNavigation, transcript, itemsById],
	);
	const virtualizer = useVirtualizer({
		count: transcript.length,
		// Keep active forms mounted while reading history so focus, drafts and in-flight submissions survive virtualization.
		rangeExtractor: (range) => [...new Set([...defaultRangeExtractor(range), ...pendingRows])].sort((a, b) => a - b),
		getScrollElement: () => scrollRef.current,
		getItemKey: (index) => transcript[index]!.key,
		estimateSize: () => 128,
		overscan: 8,
		initialRect: { width: 760, height: 640 },
	});
	virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) =>
		!railDragging.current && shouldAdjustTranscriptScroll(item.end, scrollRef.current?.scrollTop ?? 0);
	const jumpToMessage = (entry: ConversationNavigationEntry) => {
		scrollIntent.current += 1;
		followLatest.current = false;
		setHasNewItems(false);
		setPendingJump(entry.itemId);
		setActiveNavigationIndex(navigation.findIndex((candidate) => candidate.itemId === entry.itemId));
		virtualizer.scrollToIndex(entry.rowIndex, { align: "start" });
	};
	// Keep the anchor while newly mounted virtual rows are being measured.
	// A turn can contain several user messages, so its row offset alone is insufficient.
	useLayoutEffect(() => {
		if (!pendingJump) return;
		let frame = 0;
		let stableFrames = 0;
		const startedAt = performance.now();
		const intent = scrollIntent.current;
		const alignMessage = () => {
			if (railDragging.current || scrollIntent.current !== intent) return;
			const scroll = scrollRef.current;
			const target = Array.from(
				scroll?.querySelectorAll<HTMLElement>("[data-user-message], [data-quote-item]") ?? [],
			).find((node) => (node.dataset.userMessage ?? node.dataset.quoteItem) === pendingJump);
			if (scroll && target) {
				const desired =
					scroll.scrollTop + target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - 56;
				const offset = Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight, desired));
				if (Math.abs(offset - scroll.scrollTop) > 1) {
					stableFrames = 0;
					virtualizer.scrollToOffset(offset);
				} else stableFrames += 1;
			}
			if (stableFrames >= 4 || performance.now() - startedAt > 2000) {
				setPendingJump(null);
				return;
			}
			frame = requestAnimationFrame(alignMessage);
		};
		frame = requestAnimationFrame(alignMessage);
		return () => cancelAnimationFrame(frame);
	}, [pendingJump, virtualizer]);

	const lastItem = useMemo(() => {
		for (let index = itemIds.length - 1; index >= 0; index -= 1) {
			const item = itemsById.get(itemIds[index]!);
			if (item && !isInternalAgentCoordinationItem(item)) return item;
		}
		return undefined;
	}, [itemIds, itemsById]);
	const submittedUser = useMemo(
		() =>
			itemIds
				.map((id) => itemsById.get(id))
				.find(
					(item) =>
						item?.role === "user" &&
						(submittedMessageId
							? item.agentMessageId === submittedMessageId &&
								(item.deliveryState === "accepted" || item.deliveryState === "delivered")
							: submittedTurnId && item.turnId === submittedTurnId),
				),
		[itemIds, itemsById, submittedMessageId, submittedTurnId],
	);
	const submittedIdentity = submittedMessageId ?? submittedTurnId;
	useLayoutEffect(() => {
		if (lastItem?.sessionId !== previousSessionId.current) {
			scrollIntent.current += 1;
			railDragging.current = false;
			previousSessionId.current = lastItem?.sessionId;
			previousScrollTop.current = 0;
			followLatest.current = true;
			setHasNewItems(false);
			setActiveNavigationIndex(0);
			setPendingJump(null);
			setQuoteJump(null);
			setQuoteLoading(false);
			setQuoteNotice("");
			quoteRequestedCount.current = null;
		}
		if (submittedUser && consumedSubmission.current !== submittedIdentity) {
			consumedSubmission.current = submittedIdentity;
			scrollIntent.current += 1;
			followLatest.current = true;
			setHasNewItems(false);
			setPendingJump(null);
			setQuoteJump(null);
		}
		const scroll = scrollRef.current;
		if (!scroll || !lastItem || transcript.length === 0) return;
		if (!followLatest.current || railDragging.current) {
			if (activeTurnId != null || latestLabel || boundInteractions?.requests.length) setHasNewItems(true);
			return;
		}
		const frame = requestAnimationFrame(() => {
			if (followLatest.current && !railDragging.current)
				virtualizer.scrollToIndex(transcript.length - 1, { align: "end" });
		});
		return () => cancelAnimationFrame(frame);
	}, [
		lastItem,
		latestLabel,
		activeTurnId,
		transcript.length,
		virtualizer,
		boundInteractions?.requests,
		submittedUser,
		submittedIdentity,
	]);
	useLayoutEffect(() => {
		const scroll = scrollRef.current;
		if (!scroll) return;
		const observer = new ResizeObserver(() => {
			if (followLatest.current && !railDragging.current) scroll.scrollTop = scroll.scrollHeight;
		});
		observer.observe(scroll);
		if (scrollContentRef.current) observer.observe(scrollContentRef.current);
		return () => observer.disconnect();
	}, []);

	const scrollToLatest = () => {
		scrollIntent.current += 1;
		followLatest.current = true;
		setHasNewItems(false);
		setPendingJump(null);
		setQuoteJump(null);
		virtualizer.scrollToIndex(transcript.length - 1, { align: "end" });
	};
	const loadOlderAtTop = useCallback(
		async (scroll: HTMLDivElement, requested = false) => {
			if (
				!hasOlder ||
				loadingOlder ||
				loadingOlderRef.current ||
				railDragging.current ||
				(!requested && (!autoLoadOlder || scroll.scrollTop > 48))
			)
				return;
			if (requested) followLatest.current = false;
			loadingOlderRef.current = true;
			const previousHeight = scroll.scrollHeight;
			const previousTop = scroll.scrollTop;
			const scrollTop = scroll.getBoundingClientRect().top;
			const anchor = Array.from(
				scroll.querySelectorAll<HTMLElement>("[data-transcript-turn], [data-transcript-plan]"),
			).find((node) => node.getBoundingClientRect().bottom > scrollTop);
			const anchorKey = anchor?.dataset.transcriptTurn ?? anchor?.dataset.transcriptPlan;
			const anchorOffset = anchor ? anchor.getBoundingClientRect().top - scrollTop : 0;
			const sourceSession = previousSessionId.current;
			const intent = scrollIntent.current;
			try {
				await onLoadOlder();
			} finally {
				await new Promise<void>((resolve) => {
					let stableFrames = 0;
					let lastHeight = previousHeight;
					const startedAt = performance.now();
					const restore = () => {
						if (
							scrollRef.current === scroll &&
							previousSessionId.current === sourceSession &&
							scrollIntent.current === intent &&
							!railDragging.current
						) {
							// A native wheel's state update may commit after the first frame.
							// Keep the visible row anchored while virtual rows settle their measurements.
							const target = anchorKey
								? Array.from(
										scroll.querySelectorAll<HTMLElement>("[data-transcript-turn], [data-transcript-plan]"),
									).find((node) => (node.dataset.transcriptTurn ?? node.dataset.transcriptPlan) === anchorKey)
								: undefined;
							const height = scroll.scrollHeight;
							const desired = target
								? scroll.scrollTop +
									target.getBoundingClientRect().top -
									scroll.getBoundingClientRect().top -
									anchorOffset
								: previousTop + Math.max(0, height - previousHeight);
							const changed = Math.abs(desired - scroll.scrollTop) > 1 || height !== lastHeight;
							if (changed) scroll.scrollTop = desired;
							stableFrames = changed ? 0 : stableFrames + 1;
							lastHeight = height;
							if (stableFrames < 4 && performance.now() - startedAt < 1000) {
								requestAnimationFrame(restore);
								return;
							}
						}
						loadingOlderRef.current = false;
						resolve();
					};
					requestAnimationFrame(restore);
				});
			}
		},
		[autoLoadOlder, hasOlder, loadingOlder, onLoadOlder],
	);
	const scrollFromNavigation = useCallback(
		(offset: number) => {
			const scroll = scrollRef.current;
			if (!scroll) return;
			if (!railDragging.current) beginManualScroll();
			virtualizer.scrollToOffset(Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight, offset)));
			if (!railDragging.current) {
				followLatest.current = shouldFollowTranscript(scroll.scrollHeight, scroll.scrollTop, scroll.clientHeight);
				if (followLatest.current) setHasNewItems(false);
				if (scroll.scrollTop <= 48) void loadOlderAtTop(scroll);
			}
		},
		[beginManualScroll, loadOlderAtTop, virtualizer],
	);
	const onRailGesture = useCallback(
		(active: boolean) => {
			if (lastItem?.sessionId !== previousSessionId.current) return;
			const wasDragging = railDragging.current;
			railDragging.current = active;
			if (active) {
				beginManualScroll();
				return;
			}
			const scroll = scrollRef.current;
			if (!wasDragging || !scroll) return;
			followLatest.current = shouldFollowTranscript(scroll.scrollHeight, scroll.scrollTop, scroll.clientHeight);
			if (followLatest.current) setHasNewItems(false);
			if (scroll.scrollTop <= 48) void loadOlderAtTop(scroll);
		},
		[beginManualScroll, lastItem?.sessionId, loadOlderAtTop],
	);

	const jumpToQuote = useCallback((itemId: string, liveItemId?: string) => {
		scrollIntent.current += 1;
		followLatest.current = false;
		setHasNewItems(false);
		setQuoteNotice("");
		quoteRequestedCount.current = null;
		setQuoteJump(liveItemId && liveItemId !== itemId ? [itemId, liveItemId] : [itemId]);
	}, []);
	useEffect(() => {
		if (!quoteJump) return;
		const rowIndex = transcript.findIndex((row) => quoteJump.some((id) => row.itemIds.includes(id)));
		if (rowIndex >= 0) {
			setPendingJump(quoteJump.find((id) => transcript[rowIndex]!.itemIds.includes(id))!);
			virtualizer.scrollToIndex(rowIndex, { align: "start" });
			setQuoteJump(null);
			return;
		}
		if (!hasOlder) {
			setQuoteNotice(t("Original message is unavailable"));
			setQuoteJump(null);
			return;
		}
		const scroll = scrollRef.current;
		if (!scroll || quoteLoading || loadingOlder || loadingOlderRef.current) return;
		if (quoteRequestedCount.current === itemIds.length) return;
		quoteRequestedCount.current = itemIds.length;
		const sourceSession = previousSessionId.current;
		setQuoteLoading(true);
		void loadOlderAtTop(scroll, true)
			.catch(() => {
				if (sourceSession !== previousSessionId.current) return;
				setQuoteNotice(t("Original message is unavailable"));
				setQuoteJump(null);
			})
			.finally(() => {
				if (sourceSession === previousSessionId.current) setQuoteLoading(false);
			});
	}, [quoteJump, quoteLoading, hasOlder, loadingOlder, loadOlderAtTop, itemIds.length, transcript, virtualizer, t]);

	const measuredRows = virtualizer.getVirtualItems();
	const contentHeight = virtualizer.getTotalSize();
	const rows =
		measuredRows.length > 0
			? measuredRows
			: Array.from({ length: Math.min(transcript.length, 8) }, (_, index) => ({
					index,
					key: transcript[index]!.key,
					start: index * 128,
					size: 128,
					end: (index + 1) * 128,
					lane: 0,
				}));

	return (
		<ConversationInteractionContext.Provider value={interactionContext}>
			<section
				ref={rootRef}
				className={`transcript transcript-${appearance}${navigation.length > 0 ? " has-navigation" : ""}`}
				aria-label={t(ariaLabel)}
			>
				{showNavigation && (
					<ConversationNavigation
						key={`navigation:${lastItem?.sessionId ?? "empty"}`}
						entries={navigation}
						activeIndex={activeNavigationIndex}
						scrollRef={scrollRef}
						contentHeight={contentHeight}
						onScrollToOffset={scrollFromNavigation}
						onScrollGesture={onRailGesture}
						onJump={jumpToMessage}
					/>
				)}
				{hasOlder && (
					<button
						className={autoLoadOlder ? "transcript-history-access sr-only" : "history-button button-secondary"}
						disabled={loadingOlder}
						onClick={() => {
							const scroll = scrollRef.current;
							if (scroll) void loadOlderAtTop(scroll, true);
						}}
						type="button"
					>
						{loadingOlder ? t("Loading…") : t(olderLabel)}
					</button>
				)}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: Observe bubbled native scroll intent without changing the scroller's default behavior or focus order. */}
				<div
					aria-busy={loadingOlder || undefined}
					className="transcript-scroll"
					onClickCapture={(event) => {
						if (
							event.target instanceof Element &&
							event.target.closest(
								".execution-chain > summary, .tool-step-command > summary, .thinking-show-more, .code-execution > summary, .code-command > summary, .code-turn-file > summary, .code-turn-more > summary",
							)
						)
							beginManualScroll();
					}}
					onKeyDown={(event) => {
						if (
							event.defaultPrevented ||
							!["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown", " "].includes(event.key)
						)
							return;
						const target = event.target instanceof HTMLElement ? event.target : null;
						if (target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'))
							return;
						if (event.key === " " && target?.closest('button, summary, [role="button"]')) return;
						beginManualScroll();
					}}
					onWheel={(event) => {
						scrollIntent.current += 1;
						setPendingJump(null);
						setQuoteJump(null);
						if (event.deltaY < 0) followLatest.current = false;
						if (event.deltaY < 0 && event.currentTarget.scrollTop <= 48) void loadOlderAtTop(event.currentTarget);
					}}
					onScroll={(event) => {
						const scroll = event.currentTarget;
						if (!pendingJump && !railDragging.current) {
							const atBottom = shouldFollowTranscript(
								scroll.scrollHeight,
								scroll.scrollTop,
								scroll.clientHeight,
							);
							// Growing content can emit scroll before its final measurement. Preserve
							// bottom-follow intent unless the reader actually moves upward.
							if (atBottom) followLatest.current = true;
							else if (scroll.scrollTop < previousScrollTop.current - 1) followLatest.current = false;
						}
						previousScrollTop.current = scroll.scrollTop;
						if (navigation.length > 0 && !pendingJump) {
							const rowIndex = virtualizer.getVirtualItemForOffset(scroll.scrollTop + 56)?.index ?? 0;
							let index = 0;
							for (let cursor = navigation.length - 1; cursor >= 0; cursor -= 1) {
								if (navigation[cursor]!.rowIndex <= rowIndex) {
									index = cursor;
									break;
								}
							}
							setActiveNavigationIndex(Math.max(0, index));
						}
						if (followLatest.current) setHasNewItems(false);
						else if (activeTurnId != null || pendingRows.length > 0) setHasNewItems(true);
						if (!pendingJump && !railDragging.current && scroll.scrollTop <= 48) void loadOlderAtTop(scroll);
					}}
					ref={scrollRef}
				>
					<div className="transcript-space" ref={scrollContentRef} style={{ height: `${contentHeight}px` }}>
						{rows.map((row) => {
							const transcriptRow = transcript[row.index];
							if (!transcriptRow) return null;
							const items = transcriptRow.itemIds.flatMap((itemId) => {
								const item = itemsById.get(itemId);
								return item ? [item] : [];
							});
							const nextItems = transcript[row.index + 1]?.itemIds.map((id) => itemsById.get(id)) ?? [];
							const continues =
								nextItems.length > 0 &&
								!nextItems.some((item) => item?.role === "user" || item?.role === "system") &&
								[...items, ...nextItems].some((item) => item?.content.some((block) => block.type === "plan"));
							if (transcriptRow.key === "pending-interactions") {
								const callIds = new Set(
									itemIds.flatMap(
										(id) =>
											itemsById
												.get(id)
												?.content.flatMap((block) =>
													block.type === "tool_call" ? [block.toolCallId] : [],
												) ?? [],
									),
								);
								return (
									<article
										className="transcript-turn"
										data-index={row.index}
										key={row.key}
										ref={virtualizer.measureElement}
										style={{ transform: `translateY(${row.start}px)` }}
									>
										{boundInteractions?.requests
											.filter((request) => !callIds.has(interactionToolId(request) ?? ""))
											.map((request) => (
												<PendingInteractionCard key={request.interactionId} request={request} />
											))}
									</article>
								);
							}
							if (items.length === 0) return null;
							const planBlock = items
								.flatMap((item) => item.content)
								.find(
									(block): block is Extract<ItemView["content"][number], { type: "plan" }> =>
										block.type === "plan",
								);
							if (planBlock) {
								return (
									<article
										className="transcript-plan-row"
										data-index={row.index}
										data-transcript-plan={planBlock.plan.planId}
										data-continues={continues || undefined}
										key={row.key}
										ref={virtualizer.measureElement}
										style={{ transform: `translateY(${row.start}px)` }}
									>
										<PlanCard
											busy={planActionsBusy}
											onCancel={(plan) => onCancelPlan?.(plan)}
											onOpen={(plan) => onOpenPlan?.(plan)}
											onRevise={(plan) => onRevisePlan?.(plan)}
											onStart={(plan) => onStartPlan?.(plan)}
											plan={planBlock.plan}
										/>
									</article>
								);
							}
							const compaction = items.some((item) => item.content.some((block) => block.type === "compaction"));
							const running =
								activeTurnId !== null &&
								activeTurnId !== undefined &&
								items.some((item) => item.turnId === activeTurnId);
							return (
								<article
									className={
										compaction
											? "transcript-compaction-row"
											: appearance === "chat"
												? "transcript-turn"
												: "code-transcript-turn"
									}
									data-index={row.index}
									data-transcript-item={appearance === "code" ? transcriptRow.itemIds.at(-1) : undefined}
									data-transcript-turn={transcriptRow.key}
									data-continues={continues || undefined}
									key={row.key}
									ref={virtualizer.measureElement}
									style={{ transform: `translateY(${row.start}px)` }}
								>
									{compaction ? (
										<div>
											<hr aria-label={t("Compacted")} className="sr-only" />
											<span aria-hidden="true">{t("Compacted")}</span>
										</div>
									) : appearance === "chat" ? (
										<TranscriptTurn
											items={items}
											onJumpToQuote={jumpToQuote}
											onCopy={onCopy}
											onFork={onFork}
											onOpenDeliveredFile={onOpenDeliveredFile}
											onPreviewDeliveredFile={onPreviewDeliveredFile}
											running={running}
											retry={running ? retry : undefined}
											waitingForAnswer={running && waitingForAnswer}
											startedAt={activeTurnStartedAt}
											runId={activeRunId ?? activeTurnId ?? undefined}
										/>
									) : (
										<CodeTranscriptTurn
											items={items}
											onJumpToQuote={jumpToQuote}
											onCopy={onCopy}
											onFork={onFork}
											onOpenDeliveredFile={onOpenDeliveredFile}
											onPreviewDeliveredFile={onPreviewDeliveredFile}
											running={running}
											retry={running ? retry : undefined}
											waitingForAnswer={running && waitingForAnswer}
											startedAt={activeTurnStartedAt}
											runId={activeRunId ?? activeTurnId ?? undefined}
										/>
									)}
								</article>
							);
						})}
					</div>
				</div>
				{activeTurnId != null && !activeTurnHasRow && (
					<TurnRuntimeStatus
						items={[]}
						running
						retry={retry}
						startedAt={activeTurnStartedAt}
						runId={activeRunId ?? activeTurnId ?? undefined}
						waitingForAnswer={waitingForAnswer}
					/>
				)}
				<TranscriptQuoteSelection
					key={`quote-selection:${quoteSessionId ?? "readonly"}`}
					root={rootRef}
					sessionId={quoteSessionId}
					items={itemsById}
					onSelectText={() => {
						beginManualScroll();
					}}
				/>
				{(quoteJump || quoteNotice) && (
					<output className="status-block transcript-quote-notice">
						{quoteJump ? t("Finding original message…") : quoteNotice}
					</output>
				)}
				{pendingRows.length > 0 && hasNewItems ? (
					<button
						className="transcript-latest"
						type="button"
						onClick={() => {
							beginManualScroll();
							const card = scrollRef.current?.querySelector<HTMLElement>("[data-interaction-id]");
							if (card) card.scrollIntoView({ block: "center", behavior: "instant" });
							else virtualizer.scrollToIndex(pendingRows[0]!, { align: "center" });
							setHasNewItems(false);
						}}
					>
						<ArrowDown aria-hidden="true" size={14} />
						{t("View pending request")}
					</button>
				) : (
					(activeTurnId != null || latestLabel) &&
					hasNewItems && (
						<button className="transcript-latest" onClick={scrollToLatest} type="button">
							<ArrowDown aria-hidden="true" size={14} />
							{t(latestLabel ?? "Scroll to bottom")}
						</button>
					)
				)}
			</section>
		</ConversationInteractionContext.Provider>
	);
}
