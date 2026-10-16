import type { AgentMode, ItemView, PlanView, SessionDeliveredFileView } from "@metis/app-protocol";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useTranscriptScrollFade } from "../hooks/use-transcript-scroll-fade.ts";
import { CodeTranscriptTurn } from "./CodeTranscriptTurn.tsx";
import { ConversationNavigation, type ConversationNavigationEntry } from "./ConversationNavigation.tsx";
import { useConversationQuotes } from "./ConversationQuoteContext.tsx";
import { PlanCard } from "./PlanCard.tsx";
import { TranscriptQuoteSelection } from "./TranscriptQuoteSelection.tsx";
import { TranscriptTurn } from "./TranscriptTurn.tsx";
import { messageText } from "./transcript-turn-model.ts";

interface TranscriptProps {
	readonly quoteSessionId?: string;
	readonly showNavigation?: boolean;
	readonly waitingForAnswer?: boolean;
	readonly activeTurnId?: string | null;
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
	for (const itemId of itemIds) {
		const item = itemsById.get(itemId);
		if (!item) continue;
		const key = item.turnId
			? `${item.sessionId}:${appearance}:${item.turnId}`
			: `${item.sessionId}:${appearance}:${item.itemId}`;
		const existingIndex = byKey.get(key);
		if (existingIndex === undefined) {
			byKey.set(key, rows.length);
			rows.push({ key, itemIds: [item.itemId] });
		} else {
			rows[existingIndex]!.itemIds.push(item.itemId);
		}
	}
	return rows;
}

export function Transcript({
	quoteSessionId,
	showNavigation = false,
	waitingForAnswer = false,
	activeTurnId,
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
	const quoteContext = useConversationQuotes();
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
	useLayoutEffect(() => {
		if (quoteContext?.lastAccepted?.sessionId !== quoteSessionId || !quoteSessionId) return;
		followLatest.current = true;
		const scroll = scrollRef.current;
		if (scroll) scroll.scrollTop = scroll.scrollHeight;
	}, [quoteContext?.lastAccepted, quoteSessionId]);
	const previousSessionId = useRef<string | undefined>(undefined);
	const [hasNewItems, setHasNewItems] = useState(false);
	const [activeNavigationIndex, setActiveNavigationIndex] = useState(0);
	const [pendingJump, setPendingJump] = useState<string | null>(null);
	const transcript = useMemo(() => transcriptRows(appearance, itemIds, itemsById), [appearance, itemIds, itemsById]);
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
		getScrollElement: () => scrollRef.current,
		getItemKey: (index) => transcript[index]!.key,
		estimateSize: () => 128,
		overscan: 8,
		initialRect: { width: 760, height: 640 },
	});
	virtualizer.shouldAdjustScrollPositionOnItemSizeChange = (item) =>
		shouldAdjustTranscriptScroll(item.end, scrollRef.current?.scrollTop ?? 0);
	const jumpToMessage = (entry: ConversationNavigationEntry) => {
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
		const alignMessage = () => {
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

	const lastItemId = itemIds.at(-1);
	const lastItem = lastItemId ? itemsById.get(lastItemId) : undefined;
	useLayoutEffect(() => {
		if (lastItem?.sessionId !== previousSessionId.current) {
			previousSessionId.current = lastItem?.sessionId;
			followLatest.current = true;
			setHasNewItems(false);
			setActiveNavigationIndex(0);
			setPendingJump(null);
			setQuoteJump(null);
			setQuoteLoading(false);
			setQuoteNotice("");
			quoteRequestedCount.current = null;
		}
		const scroll = scrollRef.current;
		if (!scroll || !lastItem || transcript.length === 0) return;
		if (!followLatest.current) {
			if (latestLabel) setHasNewItems(true);
			return;
		}
		const frame = requestAnimationFrame(() => {
			if (followLatest.current) virtualizer.scrollToIndex(transcript.length - 1, { align: "end" });
		});
		return () => cancelAnimationFrame(frame);
	}, [lastItem, latestLabel, transcript.length, virtualizer]);
	useLayoutEffect(() => {
		const scroll = scrollRef.current;
		if (!scroll) return;
		const observer = new ResizeObserver(() => {
			if (followLatest.current) scroll.scrollTop = scroll.scrollHeight;
		});
		observer.observe(scroll);
		return () => observer.disconnect();
	}, []);

	const scrollToLatest = () => {
		followLatest.current = true;
		setHasNewItems(false);
		const scroll = scrollRef.current;
		if (scroll) scroll.scrollTop = scroll.scrollHeight;
	};
	const loadOlderAtTop = useCallback(
		async (scroll: HTMLDivElement, requested = false) => {
			if (
				!hasOlder ||
				loadingOlder ||
				loadingOlderRef.current ||
				(!requested && (!autoLoadOlder || scroll.scrollTop > 48))
			)
				return;
			if (requested) followLatest.current = false;
			loadingOlderRef.current = true;
			const previousHeight = scroll.scrollHeight;
			const previousTop = scroll.scrollTop;
			try {
				await onLoadOlder();
			} finally {
				await new Promise<void>((resolve) =>
					requestAnimationFrame(() => {
						if (scrollRef.current === scroll)
							scroll.scrollTop = previousTop + Math.max(0, scroll.scrollHeight - previousHeight);
						loadingOlderRef.current = false;
						resolve();
					}),
				);
			}
		},
		[autoLoadOlder, hasOlder, loadingOlder, onLoadOlder],
	);

	const jumpToQuote = useCallback((itemId: string, liveItemId?: string) => {
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
		<section
			ref={rootRef}
			className={`transcript transcript-${appearance}${navigation.length > 1 ? " has-navigation" : ""}`}
			aria-label={t(ariaLabel)}
		>
			{showNavigation && (
				<ConversationNavigation
					key={lastItem?.sessionId ?? "empty"}
					entries={navigation}
					activeIndex={activeNavigationIndex}
					hasOlder={hasOlder}
					loadingOlder={loadingOlder}
					onLoadOlder={() => {
						const scroll = scrollRef.current;
						if (scroll) void loadOlderAtTop(scroll, true);
					}}
					onJump={jumpToMessage}
				/>
			)}
			{hasOlder && !autoLoadOlder && (
				<button
					className="history-button button-secondary"
					disabled={loadingOlder}
					onClick={() => void onLoadOlder()}
					type="button"
				>
					{loadingOlder ? t("Loading…") : t(olderLabel)}
				</button>
			)}
			<div
				aria-busy={loadingOlder || undefined}
				className="transcript-scroll"
				onWheel={() => {
					setPendingJump(null);
					setQuoteJump(null);
				}}
				onScroll={(event) => {
					const scroll = event.currentTarget;
					if (!pendingJump)
						followLatest.current = shouldFollowTranscript(
							scroll.scrollHeight,
							scroll.scrollTop,
							scroll.clientHeight,
						);
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
					if (!pendingJump && scroll.scrollTop <= 48) void loadOlderAtTop(scroll);
				}}
				ref={scrollRef}
			>
				<div
					className="transcript-space"
					ref={scrollContentRef}
					style={{ height: `${virtualizer.getTotalSize()}px` }}
				>
					{rows.map((row) => {
						const transcriptRow = transcript[row.index];
						if (!transcriptRow) return null;
						const items = transcriptRow.itemIds.flatMap((itemId) => {
							const item = itemsById.get(itemId);
							return item ? [item] : [];
						});
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
										waitingForAnswer={running && waitingForAnswer}
										startedAt={activeTurnStartedAt}
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
										waitingForAnswer={running && waitingForAnswer}
										startedAt={activeTurnStartedAt}
									/>
								)}
							</article>
						);
					})}
				</div>
			</div>
			<TranscriptQuoteSelection
				key={quoteSessionId ?? "readonly"}
				root={rootRef}
				sessionId={quoteSessionId}
				items={itemsById}
				onSelectText={() => {
					followLatest.current = false;
					setPendingJump(null);
					setQuoteJump(null);
				}}
			/>
			{(quoteJump || quoteNotice) && (
				<output className="status-block transcript-quote-notice">
					{quoteJump ? t("Finding original message…") : quoteNotice}
				</output>
			)}
			{latestLabel && hasNewItems && (
				<button className="transcript-latest" onClick={scrollToLatest} type="button">
					{t(latestLabel)}
				</button>
			)}
		</section>
	);
}
