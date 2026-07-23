import { ImageSquare, TerminalWindow } from "@phosphor-icons/react";
import type { AgentMode, ItemContentBlockView, ItemView } from "@arcmind/app-protocol";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useLayoutEffect, useMemo, useRef } from "react";
import { TranscriptTurn } from "./TranscriptTurn.tsx";

interface TranscriptProps {
	readonly appearance: AgentMode;
	readonly hasOlder: boolean;
	readonly itemIds: readonly string[];
	readonly itemsById: ReadonlyMap<string, ItemView>;
	readonly loadingOlder: boolean;
	readonly onLoadOlder: () => Promise<void>;
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
		if (appearance === "code") {
			rows.push({ key: `${item.sessionId}:${item.itemId}`, itemIds: [item.itemId] });
			continue;
		}
		const key = item.turnId ? `${item.sessionId}:${item.turnId}` : `${item.sessionId}:${item.itemId}`;
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

function ContentBlock({ block }: { readonly block: ItemContentBlockView }) {
	switch (block.type) {
		case "text":
			return <p>{block.text}</p>;
		case "image":
			return <p className="transcript-attachment"><ImageSquare aria-hidden="true" size={18} /> Image · {block.image.mediaType}</p>;
		case "tool_call":
			return (
				<details className="tool-block" open={block.state === "running"}>
					<summary><TerminalWindow aria-hidden="true" size={17} /> {block.name}</summary>
					{block.inputPreview && <pre>{block.inputPreview}</pre>}
				</details>
			);
		case "tool_result":
			return (
				<details className={block.isError ? "tool-block tool-block-error" : "tool-block"}>
					<summary><TerminalWindow aria-hidden="true" size={17} /> {block.name} result</summary>
					<pre>{block.output}</pre>
				</details>
			);
		case "notice":
			return <p className={`notice notice-${block.level}`}>{block.text}</p>;
		case "thinking":
			return null;
	}
}

export function Transcript({ appearance, hasOlder, itemIds, itemsById, loadingOlder, onLoadOlder, olderLabel = "Load older messages" }: TranscriptProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const followLatest = useRef(true);
	const previousSessionId = useRef<string | undefined>(undefined);
	const transcript = useMemo(() => transcriptRows(appearance, itemIds, itemsById), [appearance, itemIds, itemsById]);
	const virtualizer = useVirtualizer({
		count: transcript.length,
		getScrollElement: () => scrollRef.current,
		getItemKey: (index) => transcript[index]!.key,
		estimateSize: () => 128,
		overscan: 8,
		initialRect: { width: 760, height: 640 },
	});
	virtualizer.shouldAdjustScrollPositionOnItemSizeChange = appearance === "chat"
		? (item) => shouldAdjustTranscriptScroll(item.end, scrollRef.current?.scrollTop ?? 0)
		: undefined;
	const lastItemId = itemIds.at(-1);
	const lastItem = lastItemId ? itemsById.get(lastItemId) : undefined;
	useLayoutEffect(() => {
		if (lastItem?.sessionId !== previousSessionId.current) {
			previousSessionId.current = lastItem?.sessionId;
			followLatest.current = true;
		}
		const scroll = scrollRef.current;
		if (!scroll || !lastItem || transcript.length === 0 || !followLatest.current) return;
		const frame = requestAnimationFrame(() => {
			if (followLatest.current) scroll.scrollTop = scroll.scrollHeight;
		});
		return () => cancelAnimationFrame(frame);
	}, [lastItem, transcript.length]);

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
		<section className={`transcript transcript-${appearance}`} aria-label="Conversation transcript">
			{hasOlder && (
				<button className="history-button button-secondary" disabled={loadingOlder} onClick={() => void onLoadOlder()} type="button">
					{loadingOlder ? "Loading…" : olderLabel}
				</button>
			)}
			<div
				className="transcript-scroll"
				onScroll={(event) => {
					const scroll = event.currentTarget;
					followLatest.current = shouldFollowTranscript(scroll.scrollHeight, scroll.scrollTop, scroll.clientHeight);
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
						const item = items[0];
						if (!item) return null;
						return (
							<article
								className={appearance === "chat" ? "transcript-turn" : `message message-${item.role}`}
								data-index={row.index}
								data-transcript-item={appearance === "code" ? item.itemId : undefined}
								data-transcript-turn={appearance === "chat" ? transcriptRow.key : undefined}
								key={row.key}
								ref={virtualizer.measureElement}
								style={{ transform: `translateY(${row.start}px)` }}
							>
								{appearance === "chat" ? (
									<TranscriptTurn items={items} />
								) : (
									<>
										{item.role === "tool" && <header>Tool</header>}
										{item.content.map((block, index) => (
											<ContentBlock block={block} key={`${block.type}-${index}`} />
										))}
									</>
								)}
							</article>
						);
					})}
				</div>
			</div>
		</section>
	);
}
