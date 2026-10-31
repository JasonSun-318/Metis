import type { ItemContentBlockView } from "@metis/app-protocol";
import { memo, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { GitFork, ImageSquare } from "../icons.tsx";
import { ChatExecutionChain } from "./ChatExecutionChain.tsx";
import {
	ConversationInteractionContext,
	ConversationToolCards,
	interactionToolId,
} from "./ConversationInteractionCards.tsx";
import { CopyFeedbackIcon } from "./CopyFeedbackIcon.tsx";
import { DeliveredFileCards } from "./DeliveredFileCards.tsx";
import { Markdown } from "./Markdown.tsx";
import { MessageAnnotations } from "./MessageAnnotations.tsx";
import { MessageAttachments } from "./MessageAttachments.tsx";
import { MessageFileSelections } from "./MessageFileSelections.tsx";
import { MessageOrigin } from "./MessageOrigin.tsx";
import { ToolResultImages } from "./ToolResultImages.tsx";
import { TurnRuntimeStatus } from "./TurnRuntimeStatus.tsx";
import {
	buildTurnPresentation,
	messageText,
	type ToolCallBlock,
	toolResultImagesFromBlocks,
} from "./transcript-turn-model.ts";
import { sameTurnProps, type TranscriptTurnProps } from "./transcript-turn-props.ts";

function StaticBlock({ block }: { readonly block: ItemContentBlockView }) {
	const { t } = useTranslation();
	switch (block.type) {
		case "text":
			return <p>{block.text}</p>;
		case "image":
			return (
				<p className="transcript-attachment">
					<ImageSquare aria-hidden="true" size={18} /> {t("Image")} · {block.image.mediaType}
				</p>
			);
		case "notice":
			return <p className={`notice notice-${block.level}`}>{t(block.text)}</p>;
		case "thinking":
		case "tool_call":
		case "tool_result":
		case "compaction":
		case "plan":
			return null;
	}
}

export function TurnCopyButton({ onCopy, text }: { readonly onCopy: (text: string) => void; readonly text: string }) {
	const { t } = useTranslation();
	const [copied, setCopied] = useState(false);
	const resetTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(
		() => () => {
			if (resetTimer.current) clearTimeout(resetTimer.current);
		},
		[],
	);
	const copy = () => {
		onCopy(text);
		setCopied(true);
		if (resetTimer.current) clearTimeout(resetTimer.current);
		resetTimer.current = setTimeout(() => setCopied(false), 1500);
	};
	return (
		<button
			aria-label={t("Copy message")}
			className="turn-copy-button"
			onClick={copy}
			title={t("Copy this message")}
			type="button"
		>
			<CopyFeedbackIcon copied={copied} />
		</button>
	);
}

// Rows are re-created per render, so items compare element-wise — item objects
// are replaced (never mutated) when the reducer applies an event.
export const TranscriptTurn = memo(function TranscriptTurn({
	waitingForAnswer = false,
	items,
	running: runtimeRunning = false,
	retry,
	startedAt,
	runId,
	onFork,
	onCopy,
	onJumpToQuote,
	onOpenDeliveredFile,
	onPreviewDeliveredFile,
}: TranscriptTurnProps) {
	const { t } = useTranslation();
	const interactions = useContext(ConversationInteractionContext);
	const pendingToolIds = new Set(interactions?.requests.map(interactionToolId));
	const allCalls = items.flatMap((item) =>
		item.content.filter((block): block is ToolCallBlock => block.type === "tool_call"),
	);
	const { users, segments, results, final, deliveredFiles } = buildTurnPresentation(items);
	const enteringUserId = runtimeRunning ? users.at(-1)?.itemId : undefined;
	const finalCopyText = final ? messageText(final) : "";
	const sessionId = items[0]?.sessionId;
	let activeActivityIndex = -1;
	if (runtimeRunning) {
		for (let index = segments.length - 1; index >= 0; index -= 1) {
			if (segments[index]?.type === "user") break;
			if (segments[index]?.type === "activity") {
				activeActivityIndex = index;
				break;
			}
		}
	}

	return (
		<>
			{segments.map((segment, index) => {
				if (segment.type === "notice")
					return (
						/* biome-ignore lint/suspicious/noArrayIndexKey: Transcript notice segments are append-only, like the neighboring streamed content segments. */
						<div className="turn-intermediate" data-quote-item={segment.itemId} key={`notice-${index}`}>
							<StaticBlock block={segment.block} />
						</div>
					);
				if (segment.type === "system")
					return (
						<div className="turn-intermediate" data-quote-item={segment.item.itemId} key={segment.item.itemId}>
							{segment.item.content.map((block, blockIndex) => (
								<StaticBlock block={block} key={`${block.type}-${blockIndex}`} />
							))}
						</div>
					);
				if (segment.type === "user") {
					const copyText = messageText(segment.item);
					return (
						<div
							className={`turn-user${segment.item.itemId === enteringUserId ? " is-entering" : ""}`}
							key={segment.item.itemId}
							data-user-message={segment.item.itemId}
						>
							<MessageOrigin item={segment.item} />
							<MessageAttachments attachments={segment.item.attachments} />
							<MessageFileSelections selections={segment.item.fileSelections} />
							{segment.item.content.length > 0 && (
								<div className="message message-user" data-quote-item={segment.item.itemId}>
									{segment.item.content.map((block, blockIndex) => (
										<StaticBlock block={block} key={`${block.type}-${blockIndex}`} />
									))}
								</div>
							)}
							<MessageAnnotations quotes={segment.item.conversationQuotes} onJumpToSource={onJumpToQuote} />
							{onCopy && copyText.trim() !== "" && (
								<div className="turn-actions">
									<TurnCopyButton onCopy={onCopy} text={copyText} />
								</div>
							)}
						</div>
					);
				}
				if (segment.type === "answer") {
					return (
						<div
							className="turn-answer"
							data-quote-item={segment.item.itemId}
							data-transcript-answer
							key={`answer-${segment.item.itemId}`}
						>
							{segment.item.content.map((block, blockIndex) =>
								block.type === "text" ? (
									<Markdown key={`${block.type}-${blockIndex}`} text={block.text} />
								) : (
									<StaticBlock block={block} key={`${block.type}-${blockIndex}`} />
								),
							)}
						</div>
					);
				}
				if (segment.type === "intermediate") {
					return (
						/* biome-ignore lint/suspicious/noArrayIndexKey: Transcript blocks are append-only; positional keys preserve drawer state as the active block streams. */
						<div className="turn-intermediate" key={`intermediate-${index}`}>
							{segment.blocks.map((block, blockIndex) => (
								<Markdown
									// biome-ignore lint/suspicious/noArrayIndexKey: Transcript blocks are append-only; positional keys preserve drawer state as the active block streams.
									key={`text-${blockIndex}`}
									text={block.text}
									quoteItemId={
										items.find((item) => item.role === "assistant" && item.content.includes(block))?.itemId
									}
								/>
							))}
						</div>
					);
				}
				return (
					/* biome-ignore lint/suspicious/noArrayIndexKey: Transcript blocks are append-only; positional keys preserve drawer state as the active block streams. */
					<div className="transcript-tool-group" key={`activity-${index}`}>
						<ChatExecutionChain
							activity={segment.blocks.filter(
								(block) =>
									!(block.type === "tool_call" || block.type === "tool_result") ||
									(!pendingToolIds.has(block.toolCallId) &&
										block.name !== "ask_user" &&
										(block.name !== "deliver_file" || results.get(block.toolCallId)?.isError) &&
										(block.name !== "set_tasks" || results.get(block.toolCallId)?.isError)),
							)}
							items={items}
							results={results}
							running={index === activeActivityIndex}
							startedAt={startedAt}
							runId={runId}
							retry={retry}
							waitingForAnswer={waitingForAnswer}
							replyVisible={final?.state === "streaming"}
						/>
						<ConversationToolCards calls={segment.calls} allCalls={allCalls} results={results} />
						{sessionId ? (
							<ToolResultImages
								images={toolResultImagesFromBlocks(segment.blocks, results)}
								sessionId={sessionId}
							/>
						) : null}
					</div>
				);
			})}
			{deliveredFiles.length > 0 && !runtimeRunning && onOpenDeliveredFile ? (
				<DeliveredFileCards
					files={deliveredFiles}
					onOpen={onOpenDeliveredFile}
					onPreview={onPreviewDeliveredFile}
				/>
			) : null}
			{final && final.state === "completed" && (onFork || (onCopy && finalCopyText.trim() !== "")) && (
				<div className="turn-actions">
					{onFork && (
						<button
							aria-label={t("Fork conversation")}
							className="turn-fork-button"
							onClick={() => onFork(final.itemId)}
							title={t("Fork this conversation from this reply")}
							type="button"
						>
							<GitFork aria-hidden="true" size={13} />
						</button>
					)}
					{onCopy && finalCopyText.trim() !== "" && <TurnCopyButton onCopy={onCopy} text={finalCopyText} />}
				</div>
			)}
			{runtimeRunning && activeActivityIndex < 0 && (
				<TurnRuntimeStatus
					items={items}
					running
					retry={retry}
					startedAt={startedAt}
					runId={runId}
					waitingForAnswer={waitingForAnswer}
					replyVisible={final?.state === "streaming"}
				/>
			)}
		</>
	);
}, sameTurnProps);
