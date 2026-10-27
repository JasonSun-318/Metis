import type { ItemContentBlockView, ItemView } from "@metis/app-protocol";
import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	CaretRight,
	CheckCircle,
	CircleNotch,
	ClockCounterClockwise,
	GitFork,
	ImageSquare,
	TerminalWindow,
	Tool,
} from "../icons.tsx";
import { AskUserAnswerSummary } from "./AskUserAnswerSummary.tsx";
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
	commandText,
	isCommandTool,
	messageText,
	type ToolCallBlock,
	type ToolDetailLine,
	type ToolResultBlock,
	toolResultImagesFromBlocks,
	toolTranscriptPresentation,
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

function SafeToolDetails({ lines }: { readonly lines: readonly ToolDetailLine[] }) {
	if (lines.length === 0) return null;
	return (
		<dl className="tool-safe-details">
			{lines.map((line, index) => (
				<div className="tool-safe-row" key={`${line.label ?? "detail"}-${index}`}>
					{line.label && <dt>{line.label}</dt>}
					<dd>{line.value}</dd>
				</div>
			))}
		</dl>
	);
}

function ToolStep({ call, result }: { readonly call: ToolCallBlock; readonly result?: ToolResultBlock }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const commandTool = isCommandTool(call.name);
	const presentation = toolTranscriptPresentation(call, result, t);
	if (!commandTool) {
		return (
			<div className="tool-step tool-step-static">
				<div className="tool-step-static-label">
					<Tool aria-hidden="true" size={17} />
					<span>{presentation.label}</span>
					{call.state === "running" && (
						<CircleNotch aria-label={t("Running")} className="tool-step-spinner" size={15} />
					)}
				</div>
				<SafeToolDetails lines={presentation.detailLines} />
				{presentation.rawOutputIsError && presentation.rawOutput !== undefined && (
					<pre className="tool-step-output tool-step-output-error">{presentation.rawOutput}</pre>
				)}
			</div>
		);
	}
	const command = commandText(presentation.rawInput);
	return (
		<details
			className="tool-step tool-step-command"
			onToggle={(event) => setOpen(event.currentTarget.open)}
			open={open}
		>
			<summary>
				<TerminalWindow aria-hidden="true" size={17} />
				<span>{presentation.label}</span>
				{call.state === "running" && (
					<CircleNotch aria-label={t("Running")} className="tool-step-spinner" size={15} />
				)}
			</summary>
			{(command || presentation.rawOutput !== undefined) && (
				<div className="transcript-drawer" data-open={open ? "true" : undefined} inert={!open}>
					<div className="tool-step-details">
						{command && <pre className="tool-step-input">{command}</pre>}
						{presentation.rawOutput !== undefined && (
							<pre
								className={
									presentation.rawOutputIsError
										? "tool-step-output tool-step-output-error"
										: "tool-step-output"
								}
							>
								{presentation.rawOutput}
							</pre>
						)}
					</div>
				</div>
			)}
		</details>
	);
}

function executionChainPreviewHeight(): number {
	return Math.min(520, Math.max(360, window.innerHeight * 0.46));
}

function collapsedExecutionChainHeight(timeline: HTMLElement): number {
	const children = Array.from(timeline.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
	const rowGap = Number.parseFloat(getComputedStyle(timeline).rowGap) || 0;
	const contentHeight = children.reduce((total, child) => {
		if (child.matches("details.tool-step-command")) {
			const summary = child.querySelector<HTMLElement>(":scope > summary");
			return total + (summary?.getBoundingClientRect().height ?? 0);
		}
		return total + child.getBoundingClientRect().height;
	}, 0);
	return contentHeight + Math.max(0, children.length - 1) * rowGap;
}

function ExecutionChain({
	activity,
	items,
	results,
	running,
	startedAt,
	runId,
	waitingForAnswer,
	retry,
}: {
	readonly activity: readonly ItemContentBlockView[];
	readonly items: readonly ItemView[];
	readonly results: ReadonlyMap<string, ToolResultBlock>;
	readonly running: boolean;
	readonly startedAt?: string;
	readonly runId?: string;
	readonly waitingForAnswer: boolean;
	readonly retry?: TranscriptTurnProps["retry"];
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(running);
	const [showAll, setShowAll] = useState(false);
	const [canExpand, setCanExpand] = useState(false);
	const viewportRef = useRef<HTMLDivElement>(null);
	const timelineRef = useRef<HTMLDivElement>(null);
	const wasRunning = useRef(running);

	useEffect(() => {
		if (running) setOpen(true);
		else if (wasRunning.current) {
			setOpen(false);
			setShowAll(false);
		}
		wasRunning.current = running;
	}, [running]);

	// biome-ignore lint/correctness/useExhaustiveDependencies(results): Streaming content, results, and expansion styles require measuring the execution drawer again.
	// biome-ignore lint/correctness/useExhaustiveDependencies(canExpand): Streaming content, results, and expansion styles require measuring the execution drawer again.
	// biome-ignore lint/correctness/useExhaustiveDependencies(activity): Streaming content, results, and expansion styles require measuring the execution drawer again.
	useLayoutEffect(() => {
		if (!open || showAll) return;
		const viewport = viewportRef.current;
		const timeline = timelineRef.current;
		if (!viewport || !timeline) return;
		const measure = () => {
			const overflowing = collapsedExecutionChainHeight(timeline) > executionChainPreviewHeight() + 1;
			setCanExpand(overflowing);
			if (overflowing && running) viewport.scrollTop = viewport.scrollHeight;
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(viewport);
		observer.observe(timeline);
		window.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
		};
	}, [activity, canExpand, open, results, running, showAll]);

	return (
		<details
			className="execution-chain"
			onToggle={(event) => {
				const nextOpen = event.currentTarget.open;
				setOpen(nextOpen);
				if (!nextOpen) setShowAll(false);
			}}
			open={open}
		>
			<summary>
				<span aria-live="polite">{t(running ? "Execution process" : "Execution complete")}</span>
				<CaretRight aria-hidden="true" className="execution-chain-caret" size={16} />
			</summary>
			<div className="transcript-drawer" data-open={open ? "true" : undefined} inert={!open}>
				<div>
					<div
						className={`execution-chain-content${showAll ? "" : " is-preview"}${canExpand && !showAll ? " is-capped" : ""}`}
					>
						<div className="execution-chain-viewport" ref={viewportRef}>
							<div className="execution-chain-timeline" ref={timelineRef}>
								{activity.map((block, index) => {
									if (block.type === "thinking") {
										return (
											/* biome-ignore lint/suspicious/noArrayIndexKey: Transcript blocks are append-only; positional keys preserve drawer state as the active block streams. */
											<div className="activity-step" key={`thinking-${index}`}>
												<span className="activity-step-icon">
													<ClockCounterClockwise aria-hidden="true" size={17} />
												</span>
												<p>{block.text}</p>
											</div>
										);
									}
									if (block.type === "text") {
										return (
											/* biome-ignore lint/suspicious/noArrayIndexKey: Transcript blocks are append-only; positional keys preserve drawer state as the active block streams. */
											<div className="activity-step activity-step-message" key={`text-${index}`}>
												<div>
													<Markdown text={block.text} />
												</div>
											</div>
										);
									}
									if (block.type === "tool_call") {
										return (
											<ToolStep
												call={block}
												key={`tool-${block.toolCallId}`}
												result={results.get(block.toolCallId)}
											/>
										);
									}
									if (block.type === "tool_result") {
										const presentation = toolTranscriptPresentation(undefined, block, t);
										return (
											<div className="activity-step tool-step-orphan" key={`result-${block.toolCallId}`}>
												<span className="activity-step-icon">
													<CheckCircle aria-hidden="true" size={17} />
												</span>
												<p>{presentation.label}</p>
												<SafeToolDetails lines={presentation.detailLines} />
												{presentation.rawOutput !== undefined && (
													<pre
														className={
															presentation.rawOutputIsError
																? "tool-step-output tool-step-output-error"
																: "tool-step-output"
														}
													>
														{presentation.rawOutput}
													</pre>
												)}
											</div>
										);
									}
									return null;
								})}
							</div>
						</div>
						{canExpand && !showAll && (
							<button className="execution-chain-show-more" onClick={() => setShowAll(true)} type="button">
								{t("Show more")}
							</button>
						)}
					</div>
					{running ? (
						<TurnRuntimeStatus
							items={items}
							running
							retry={retry}
							startedAt={startedAt}
							runId={runId}
							waitingForAnswer={waitingForAnswer}
						/>
					) : (
						(!canExpand || showAll) && (
							<div className="execution-chain-done">
								<CheckCircle aria-hidden="true" size={17} />
								<span>{t("Done")}</span>
							</div>
						)
					)}
					{canExpand && showAll && (
						<button
							className="execution-chain-show-more is-show-less"
							onClick={() => setShowAll(false)}
							type="button"
						>
							{t("Show less")}
						</button>
					)}
				</div>
			</div>
		</details>
	);
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
					<div key={`activity-${index}`}>
						<ExecutionChain
							activity={segment.blocks}
							items={items}
							results={results}
							running={index === activeActivityIndex}
							startedAt={startedAt}
							runId={runId}
							retry={retry}
							waitingForAnswer={waitingForAnswer}
						/>
						{segment.calls
							.filter((call) => call.name === "ask_user")
							.map((call) => (
								<AskUserAnswerSummary key={call.toolCallId} result={results.get(call.toolCallId)} />
							))}
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
				/>
			)}
		</>
	);
}, sameTurnProps);
