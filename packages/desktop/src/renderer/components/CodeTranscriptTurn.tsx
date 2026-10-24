import type { CodeChangesView, ItemContentBlockView } from "@metis/app-protocol";
import { CaretRight, CircleNotch, GitFork, ImageSquare, TerminalWindow, Wrench } from "@phosphor-icons/react";
import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { AskUserAnswerSummary } from "./AskUserAnswerSummary.tsx";
import { DeliveredFileCards } from "./DeliveredFileCards.tsx";
import { Markdown } from "./Markdown.tsx";
import { MessageAnnotations } from "./MessageAnnotations.tsx";
import { MessageAttachments } from "./MessageAttachments.tsx";
import { MessageFileSelections } from "./MessageFileSelections.tsx";
import { MessageOrigin } from "./MessageOrigin.tsx";
import { CodeChangeCounts, codeStepCounts, ToolCodeChanges } from "./ToolCodeChanges.tsx";
import { ToolResultImages } from "./ToolResultImages.tsx";
import { TurnCopyButton } from "./TranscriptTurn.tsx";
import { TurnRuntimeStatus } from "./TurnRuntimeStatus.tsx";
import {
	actionSummary,
	buildCodeTurnPresentation,
	commandText,
	isCommandTool,
	messageText,
	type ToolCallBlock,
	type ToolDetailLine,
	type ToolResultBlock,
	toolResultImagesFromCalls,
	toolTranscriptPresentation,
} from "./transcript-turn-model.ts";
import { type TranscriptTurnProps as CodeTranscriptTurnProps, sameTurnProps } from "./transcript-turn-props.ts";

function VisibleBlock({
	block,
	markdown = false,
	quoteItemId,
}: {
	readonly block: ItemContentBlockView;
	readonly markdown?: boolean;
	readonly quoteItemId?: string;
}) {
	const { t } = useTranslation();
	switch (block.type) {
		case "text":
			return markdown ? (
				<Markdown text={block.text} quoteItemId={quoteItemId} />
			) : (
				<p data-quote-item={quoteItemId}>{block.text}</p>
			);
		case "image":
			return (
				<p className="transcript-attachment">
					<ImageSquare aria-hidden="true" size={16} /> {t("Image")} · {block.image.mediaType}
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

function CodeToolDetails({
	call,
	lines,
	rawInput,
	rawOutput,
	rawOutputIsError,
	changes,
}: {
	readonly call?: ToolCallBlock;
	readonly lines: readonly ToolDetailLine[];
	readonly rawInput?: string;
	readonly rawOutput?: string;
	readonly rawOutputIsError: boolean;
	readonly changes?: CodeChangesView;
}) {
	const { t } = useTranslation();
	const input = commandText(rawInput);
	if (lines.length === 0 && !input && rawOutput === undefined && !changes) return null;
	const rawDetails = (
		<>
			{lines.length > 0 && (
				<dl className="tool-safe-details">
					{lines.map((line, index) => (
						<div className="tool-safe-row" key={`${line.label ?? "detail"}-${index}`}>
							{line.label && <dt>{line.label}</dt>}
							<dd>{line.value}</dd>
						</div>
					))}
				</dl>
			)}
			{input && <pre className="code-command-input">{call && isCommandTool(call.name) ? `$ ${input}` : input}</pre>}
			{rawOutput !== undefined && (
				<pre className={rawOutputIsError ? "code-command-output code-command-output-error" : "code-command-output"}>
					{rawOutput}
				</pre>
			)}
		</>
	);
	return (
		<div className="code-command-details">
			{changes && <ToolCodeChanges changes={changes} />}
			{changes
				? (lines.length > 0 || input || rawOutput !== undefined) && (
						<details className="code-tool-raw-details">
							<summary>
								<CaretRight aria-hidden="true" size={12} />
								{t("Tool details")}
							</summary>
							{rawDetails}
						</details>
					)
				: rawDetails}
		</div>
	);
}

function CodeToolStep({ call, result }: { readonly call: ToolCallBlock; readonly result?: ToolResultBlock }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const presentation = toolTranscriptPresentation(call, result, t);
	const changes = result?.codeChanges?.files.length ? result.codeChanges : undefined;
	const running = call.state === "running" || call.state === "pending";
	const Icon = isCommandTool(call.name) ? TerminalWindow : Wrench;
	return (
		<details
			className={isCommandTool(call.name) ? "code-command code-command-shell" : "code-command code-command-tool"}
			open={open}
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: Native summary supplies keyboard activation; this handler synchronizes controlled details state. */}
			<summary
				onClick={(event) => {
					event.preventDefault();
					setOpen((current) => !current);
				}}
			>
				<Icon aria-hidden="true" size={15} />
				<span>{presentation.label}</span>
				{changes && (
					<>
						{changes.files.length === 1 && (
							<span className="code-change-path" title={changes.files[0]!.path}>
								{changes.files[0]!.path}
							</span>
						)}
						<CodeChangeCounts counts={codeStepCounts(changes)} />
					</>
				)}
				{running && <CircleNotch aria-label={t("Running")} className="code-command-spinner" size={14} />}
				<CaretRight aria-hidden="true" className="code-command-caret" size={12} />
			</summary>
			<div className="transcript-drawer" data-open={open ? "true" : undefined} inert={!open}>
				<CodeToolDetails
					call={call}
					changes={open ? changes : undefined}
					lines={presentation.detailLines}
					rawInput={presentation.rawInput}
					rawOutput={presentation.rawOutput}
					rawOutputIsError={presentation.rawOutputIsError}
				/>
			</div>
		</details>
	);
}

function CodeOrphanToolStep({ result }: { readonly result: ToolResultBlock }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const presentation = toolTranscriptPresentation(undefined, result, t);
	const changes = result.codeChanges?.files.length ? result.codeChanges : undefined;
	return (
		<details className="code-command code-command-tool" open={open}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: Native summary supplies keyboard activation; this handler synchronizes controlled details state. */}
			<summary
				onClick={(event) => {
					event.preventDefault();
					setOpen((current) => !current);
				}}
			>
				<Wrench aria-hidden="true" size={15} />
				<span>{presentation.label}</span>
				{changes && <CodeChangeCounts counts={codeStepCounts(changes)} />}
				<CaretRight aria-hidden="true" className="code-command-caret" size={12} />
			</summary>
			<div className="transcript-drawer" data-open={open ? "true" : undefined} inert={!open}>
				<CodeToolDetails
					changes={open ? changes : undefined}
					lines={presentation.detailLines}
					rawOutput={presentation.rawOutput}
					rawOutputIsError={presentation.rawOutputIsError}
				/>
			</div>
		</details>
	);
}

function CodeExecutionTitle({ text }: { readonly text: string }) {
	const previous = useRef(text);
	const [leaving, setLeaving] = useState<string | null>(null);
	const leavingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => {
		if (text === previous.current) return;
		setLeaving(previous.current);
		previous.current = text;
		if (leavingTimer.current) clearTimeout(leavingTimer.current);
		leavingTimer.current = setTimeout(() => setLeaving(null), 180);
		return () => {
			if (leavingTimer.current) clearTimeout(leavingTimer.current);
		};
	}, [text]);
	return (
		<span className="code-execution-title-roller">
			{leaving !== null && (
				<span aria-hidden="true" className="code-execution-title-leave">
					{leaving}
				</span>
			)}
			<span className={`code-execution-title-enter${leaving !== null ? " from-top" : ""}`} key={text}>
				{text}
			</span>
		</span>
	);
}

function CodeExecution({
	calls,
	results,
	orphanResults,
	turnChanges,
}: {
	readonly calls: readonly ToolCallBlock[];
	readonly results: ReadonlyMap<string, ToolResultBlock>;
	readonly orphanResults: readonly ToolResultBlock[];
	readonly turnChanges?: CodeChangesView;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	return (
		<details className="code-execution" open={open}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: Native summary supplies keyboard activation; this handler synchronizes controlled details state. */}
			<summary
				onClick={(event) => {
					event.preventDefault();
					setOpen((current) => !current);
				}}
			>
				<CodeExecutionTitle text={calls.length > 0 ? actionSummary(calls, t) : t("Used a tool")} />
				{turnChanges && <CodeChangeCounts counts={turnChanges.turn} turn />}
				<CaretRight aria-hidden="true" className="code-execution-caret" size={12} />
			</summary>
			<div className="transcript-drawer" data-open={open ? "true" : undefined} inert={!open}>
				<div className="code-execution-card">
					{calls.map((call) => (
						<CodeToolStep call={call} key={call.toolCallId} result={results.get(call.toolCallId)} />
					))}
					{orphanResults.map((result) => (
						<CodeOrphanToolStep key={`orphan-${result.toolCallId}`} result={result} />
					))}
				</div>
			</div>
		</details>
	);
}

// Items are rebuilt per render, so compare element-wise — the reducer replaces
// item objects instead of mutating them.
export const CodeTranscriptTurn = memo(function CodeTranscriptTurn({
	items,
	waitingForAnswer = false,
	running = false,
	retry,
	startedAt,
	onFork,
	onCopy,
	onJumpToQuote,
	onOpenDeliveredFile,
	onPreviewDeliveredFile,
}: CodeTranscriptTurnProps) {
	const { t } = useTranslation();
	const { users, segments, results, final, deliveredFiles } = buildCodeTurnPresentation(items);
	const enteringUserId = running ? users.at(-1)?.itemId : undefined;
	const finalCopyText = final ? messageText(final) : "";
	const sessionId = items[0]?.sessionId;
	const lastToolSegment = segments.reduce((last, segment, index) => (segment.type === "tools" ? index : last), -1);
	let turnChanges: CodeChangesView | undefined;
	let hasObservedChanges = false;
	for (const result of results.values()) {
		if (result.codeChanges?.files.length) hasObservedChanges = true;
		if (result.codeChanges && (!turnChanges || result.codeChanges.sequence > turnChanges.sequence))
			turnChanges = result.codeChanges;
	}
	// Old journals may contain empty diffs emitted solely because scanning was
	// incomplete. A coverage warning alone must not imply any file was edited.
	const showTurnChanges = hasObservedChanges || Boolean(turnChanges?.turn.additions || turnChanges?.turn.deletions);

	return (
		<>
			{segments.map((segment, segmentIndex) => {
				if (segment.type === "system")
					return (
						<div className="code-turn-status" data-quote-item={segment.item.itemId} key={segment.item.itemId}>
							{segment.item.content.map((block, blockIndex) => (
								<VisibleBlock block={block} key={`${block.type}-${blockIndex}`} />
							))}
						</div>
					);
				if (segment.type === "user") {
					const copyText = messageText(segment.item);
					return (
						<div
							className={`code-turn-user${segment.item.itemId === enteringUserId ? " is-entering" : ""}`}
							key={segment.item.itemId}
							data-user-message={segment.item.itemId}
						>
							<MessageOrigin item={segment.item} />
							<MessageAttachments attachments={segment.item.attachments} />
							<MessageFileSelections selections={segment.item.fileSelections} />
							{segment.item.content.length > 0 && (
								<div className="code-turn-user-bubble" data-quote-item={segment.item.itemId}>
									{segment.item.content.map((block, blockIndex) => (
										<VisibleBlock block={block} key={`${block.type}-${blockIndex}`} />
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
				if (segment.type === "tools") {
					return (
						/* biome-ignore lint/suspicious/noArrayIndexKey: Transcript segments are append-only; positional keys preserve disclosure state while the active segment streams. */
						<div key={`tools-${segmentIndex}`}>
							<CodeExecution
								calls={segment.calls}
								orphanResults={segment.orphanResults}
								results={results}
								turnChanges={segmentIndex === lastToolSegment && showTurnChanges ? turnChanges : undefined}
							/>
							{segment.calls
								.filter((call) => call.name === "ask_user")
								.map((call) => (
									<AskUserAnswerSummary key={call.toolCallId} result={results.get(call.toolCallId)} />
								))}
							{sessionId ? (
								<ToolResultImages
									images={toolResultImagesFromCalls(segment.calls, results, segment.orphanResults)}
									sessionId={sessionId}
								/>
							) : null}
						</div>
					);
				}
				if (segment.answer && final?.state === "streaming") return null;
				return (
					<div
						className={segment.answer ? "code-turn-answer" : "code-turn-status"}
						data-transcript-answer={segment.answer ? true : undefined}
						// biome-ignore lint/suspicious/noArrayIndexKey: Transcript segments are append-only; positional keys preserve disclosure state while the active segment streams.
						key={`content-${segmentIndex}`}
					>
						{segment.blocks.map((block, blockIndex) => (
							<VisibleBlock
								block={block}
								key={`${block.type}-${blockIndex}`}
								markdown={segment.markdown}
								quoteItemId={
									items.find((item) => item.role === "assistant" && item.content.includes(block))?.itemId
								}
							/>
						))}
					</div>
				);
			})}
			{deliveredFiles.length > 0 && !running && onOpenDeliveredFile ? (
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
			{running && (
				<TurnRuntimeStatus
					items={items}
					running
					retry={retry}
					startedAt={startedAt}
					waitingForAnswer={waitingForAnswer}
				/>
			)}
		</>
	);
}, sameTurnProps);
