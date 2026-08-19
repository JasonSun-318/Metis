import type { AgentMode, ItemView, SessionDeliveredFileView } from "@metis/app-protocol";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CodeTranscriptTurn } from "./CodeTranscriptTurn.tsx";
import { TranscriptTurn } from "./TranscriptTurn.tsx";

interface TranscriptProps {
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

function transcriptRows(appearance: AgentMode, itemIds: readonly string[], itemsById: ReadonlyMap<string, ItemView>): TranscriptRow[] {
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

export function Transcript({ activeTurnId, activeTurnStartedAt, appearance, ariaLabel = "Conversation transcript", autoLoadOlder = false, hasOlder, itemIds, itemsById, latestLabel, loadingOlder, onCopy, onFork, onOpenDeliveredFile, onPreviewDeliveredFile, onLoadOlder, olderLabel = "Load older messages" }: TranscriptProps) {
	const { t } = useTranslation();
	const scrollRef = useRef<HTMLDivElement>(null);
	const loadingOlderRef = useRef(false);
	const followLatest = useRef(true);
	const previousSessionId = useRef<string | undefined>(undefined);
	const [hasNewItems, setHasNewItems] = useState(false);
	const transcript = useMemo(() => transcriptRows(appearance, itemIds, itemsById), [appearance, itemIds, itemsById]);
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
	const lastItemId = itemIds.at(-1);
	const lastItem = lastItemId ? itemsById.get(lastItemId) : undefined;
	useLayoutEffect(() => {
		if (lastItem?.sessionId !== previousSessionId.current) {
			previousSessionId.current = lastItem?.sessionId;
			followLatest.current = true;
			setHasNewItems(false);
		}
		const scroll = scrollRef.current;
		if (!scroll || !lastItem || transcript.length === 0) return;
		if (!followLatest.current) {
			if (latestLabel) setHasNewItems(true);
			return;
		}
		const frame = requestAnimationFrame(() => {
			if (followLatest.current) scroll.scrollTop = scroll.scrollHeight;
		});
		return () => cancelAnimationFrame(frame);
	}, [lastItem, latestLabel, transcript.length]);
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
	const loadOlderAtTop = async (scroll: HTMLDivElement) => {
		if (!autoLoadOlder || !hasOlder || loadingOlder || loadingOlderRef.current || scroll.scrollTop > 48) return;
		loadingOlderRef.current = true;
		const previousHeight = scroll.scrollHeight;
		const previousTop = scroll.scrollTop;
		try {
			await onLoadOlder();
		} finally {
			requestAnimationFrame(() => {
				if (scrollRef.current === scroll)
					scroll.scrollTop = previousTop + Math.max(0, scroll.scrollHeight - previousHeight);
				loadingOlderRef.current = false;
			});
		}
	};

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
		<section className={`transcript transcript-${appearance}`} aria-label={t(ariaLabel)}>
			{hasOlder && !autoLoadOlder && (
				<button className="history-button button-secondary" disabled={loadingOlder} onClick={() => void onLoadOlder()} type="button">
					{loadingOlder ? t("Loading…") : t(olderLabel)}
				</button>
			)}
			<div
				aria-busy={loadingOlder || undefined}
				className="transcript-scroll"
				onScroll={(event) => {
					const scroll = event.currentTarget;
					followLatest.current = shouldFollowTranscript(scroll.scrollHeight, scroll.scrollTop, scroll.clientHeight);
					if (followLatest.current) setHasNewItems(false);
					if (scroll.scrollTop <= 48) void loadOlderAtTop(scroll);
				}}
				ref={scrollRef}
			>
				<div className="transcript-space" style={{ height: `${virtualizer.getTotalSize()}px` }}>
					{rows.map((row) => {
						const transcriptRow = transcript[row.index];
						if (!transcriptRow) return null;
						const items = transcriptRow.itemIds.flatMap((itemId) => {
							const item = itemsById.get(itemId);
							return item ? [item] : [];
						});
						if (items.length === 0) return null;
						const compaction = items.some((item) => item.content.some((block) => block.type === "compaction"));
						const running = activeTurnId !== null && activeTurnId !== undefined &&
							items.some((item) => item.turnId === activeTurnId);
						return (
							<article
								className={compaction ? "transcript-compaction-row" : appearance === "chat" ? "transcript-turn" : "code-transcript-turn"}
								data-index={row.index}
								data-transcript-item={appearance === "code" ? transcriptRow.itemIds.at(-1) : undefined}
								data-transcript-turn={transcriptRow.key}
								key={row.key}
								ref={virtualizer.measureElement}
								style={{ transform: `translateY(${row.start}px)` }}
							>
								{compaction ? <div role="separator"><span>{t("Compacted")}</span></div> : appearance === "chat"
									? <TranscriptTurn items={items} onCopy={onCopy} onFork={onFork} onOpenDeliveredFile={onOpenDeliveredFile} onPreviewDeliveredFile={onPreviewDeliveredFile} running={running} startedAt={activeTurnStartedAt} />
									: <CodeTranscriptTurn items={items} onCopy={onCopy} onFork={onFork} onOpenDeliveredFile={onOpenDeliveredFile} onPreviewDeliveredFile={onPreviewDeliveredFile} running={running} startedAt={activeTurnStartedAt} />}
							</article>
						);
					})}
				</div>
			</div>
			{latestLabel && hasNewItems && (
				<button className="transcript-latest" onClick={scrollToLatest} type="button">{t(latestLabel)}</button>
			)}
		</section>
	);
}
