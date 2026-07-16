import type { ItemContentBlockView, ItemView } from "@arcmind/app-protocol";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useRef } from "react";

interface TranscriptProps {
	readonly hasOlder: boolean;
	readonly itemIds: readonly string[];
	readonly itemsById: ReadonlyMap<string, ItemView>;
	readonly loadingOlder: boolean;
	readonly onLoadOlder: () => Promise<void>;
}

function ContentBlock({ block }: { readonly block: ItemContentBlockView }) {
	switch (block.type) {
		case "text":
			return <p>{block.text}</p>;
		case "image":
			return <p className="transcript-attachment">Image · {block.image.mediaType}</p>;
		case "tool_call":
			return (
				<details className="tool-block" open={block.state === "running"}>
					<summary>{block.name}</summary>
					{block.inputPreview && <pre>{block.inputPreview}</pre>}
				</details>
			);
		case "tool_result":
			return (
				<details className={block.isError ? "tool-block tool-block-error" : "tool-block"}>
					<summary>{block.name} result</summary>
					<pre>{block.output}</pre>
				</details>
			);
		case "notice":
			return <p className={`notice notice-${block.level}`}>{block.text}</p>;
	}
}

export function Transcript({ hasOlder, itemIds, itemsById, loadingOlder, onLoadOlder }: TranscriptProps) {
	const scrollRef = useRef<HTMLDivElement>(null);
	const virtualizer = useVirtualizer({
		count: itemIds.length,
		getScrollElement: () => scrollRef.current,
		getItemKey: (index) => itemIds[index]!,
		estimateSize: () => 112,
		overscan: 8,
		initialRect: { width: 800, height: 640 },
	});
	const measuredRows = virtualizer.getVirtualItems();
	const rows =
		measuredRows.length > 0
			? measuredRows
			: Array.from({ length: Math.min(itemIds.length, 8) }, (_, index) => ({
					index,
					key: itemIds[index]!,
					start: index * 112,
					size: 112,
					end: (index + 1) * 112,
					lane: 0,
				}));

	return (
		<section className="transcript" aria-label="Conversation transcript">
		{hasOlder && (
			<button className="history-button button-secondary" disabled={loadingOlder} onClick={() => void onLoadOlder()} type="button">
				{loadingOlder ? "Loading…" : "Load older messages"}
			</button>
		)}
			<div className="transcript-scroll" ref={scrollRef}>
				<div className="transcript-space" style={{ height: `${virtualizer.getTotalSize()}px` }}>
					{rows.map((row) => {
						const item = itemsById.get(itemIds[row.index]!);
						if (!item) return null;
						return (
							<article
								className={`message message-${item.role}`}
								data-index={row.index}
								data-transcript-item={item.itemId}
								key={row.key}
								ref={virtualizer.measureElement}
								style={{ transform: `translateY(${row.start}px)` }}
							>
								<header>{item.role === "assistant" ? "ArcMind" : item.role}</header>
								{item.content.map((block, index) => (
									<ContentBlock block={block} key={`${block.type}-${index}`} />
								))}
							</article>
						);
					})}
				</div>
			</div>
		</section>
	);
}
