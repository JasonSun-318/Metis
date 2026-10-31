import type { CodeChangesView, ItemContentBlockView } from "@metis/app-protocol";
import { memo, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CaretRight, CircleNotch, GitFork, ImageSquare } from "../icons.tsx";
import { CodeChangesNavigationContext } from "./CodeChangesNavigationContext.ts";
import { CodeTurnChanges } from "./CodeTurnChanges.tsx";
import {
	ConversationInteractionContext,
	ConversationToolCards,
	interactionToolId,
	PermissionReceipt,
} from "./ConversationInteractionCards.tsx";
import {
	type CodeTextCounts,
	codeStepLabel,
	isTextCodeChange,
	summarizeCodeChanges,
	textCodeChanges,
} from "./code-change-summary.ts";
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
	const changes = textCodeChanges(result?.codeChanges);
	const running = call.state === "running" || call.state === "pending";
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
				<span
					className="code-step-label"
					title={changes?.files.length === 1 ? changes.files[0]!.path : commandText(presentation.rawInput)}
				>
					{codeStepLabel(call, result, presentation.label, t)}
				</span>
				{changes && <CodeChangeCounts counts={codeStepCounts(changes)} />}
				{running && <CircleNotch aria-label={t("Running")} className="code-command-spinner" size={14} />}
				<CaretRight aria-hidden="true" className="code-command-caret" size={12} />
			</summary>
			<div className="transcript-drawer" data-open={open ? "true" : undefined} inert={!open}>
				<div>
					<CodeToolDetails
						call={call}
						changes={open ? changes : undefined}
						lines={presentation.detailLines}
						rawInput={presentation.rawInput}
						rawOutput={presentation.rawOutput}
						rawOutputIsError={presentation.rawOutputIsError}
					/>
					<PermissionReceipt call={call} />
				</div>
			</div>
		</details>
	);
}

function CodeOrphanToolStep({ result }: { readonly result: ToolResultBlock }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const presentation = toolTranscriptPresentation(undefined, result, t);
	const changes = textCodeChanges(result.codeChanges);
	return (
		<details className="code-command code-command-tool" open={open}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: Native summary supplies keyboard activation; this handler synchronizes controlled details state. */}
			<summary
				onClick={(event) => {
					event.preventDefault();
					setOpen((current) => !current);
				}}
			>
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
	turnCounts,
}: {
	readonly calls: readonly ToolCallBlock[];
	readonly results: ReadonlyMap<string, ToolResultBlock>;
	readonly orphanResults: readonly ToolResultBlock[];
	readonly turnCounts?: CodeTextCounts;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	if (calls.length === 0 && orphanResults.length === 0) return null;
	const files = new Map(
		calls.flatMap((call) =>
			(results.get(call.toolCallId)?.codeChanges?.files ?? [])
				.filter(isTextCodeChange)
				.map((file) => [file.path, file] as const),
		),
	);
	const actions = calls.filter(
		(call) => isCommandTool(call.name) || !results.get(call.toolCallId)?.codeChanges?.files.some(isTextCodeChange),
	);
	const fileLabel =
		files.size > 0
			? t(
					[...files.values()].every((file) => file.kind === "added")
						? "Created {{count}} files"
						: "Changed {{count}} files",
					{ count: files.size },
				)
			: "";
	const title =
		actions.length > 0
			? [actionSummary(actions, t), fileLabel].filter(Boolean).join(" · ")
			: fileLabel || t("Used a tool");
	return (
		<details className="code-execution" open={open}>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: Native summary supplies keyboard activation; this handler synchronizes controlled details state. */}
			<summary
				onClick={(event) => {
					event.preventDefault();
					setOpen((current) => !current);
				}}
			>
				<CodeExecutionTitle text={title} />
				{turnCounts && <CodeChangeCounts counts={turnCounts} turn />}
				<CaretRight aria-hidden="true" className="code-execution-caret" size={12} />
			</summary>
			<div className="transcript-drawer" data-open={open ? "true" : undefined} inert={!open}>
				<div>
					<div className="code-execution-card">
						{calls.map((call) => (
							<CodeToolStep call={call} key={call.toolCallId} result={results.get(call.toolCallId)} />
						))}
						{orphanResults.map((result) => (
							<CodeOrphanToolStep key={`orphan-${result.toolCallId}`} result={result} />
						))}
					</div>
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
	runId,
	onFork,
	onCopy,
	onJumpToQuote,
	onOpenDeliveredFile,
	onPreviewDeliveredFile,
}: CodeTranscriptTurnProps) {
	const { t } = useTranslation();
	const interactions = useContext(ConversationInteractionContext);
	const pendingToolIds = new Set(interactions?.requests.map(interactionToolId));
	const navigateChanges = useContext(CodeChangesNavigationContext);
	const allCalls = items.flatMap((item) =>
		item.content.filter((block): block is ToolCallBlock => block.type === "tool_call"),
	);
	const { users, segments, results, final, deliveredFiles } = buildCodeTurnPresentation(items);
	const enteringUserId = running ? users.at(-1)?.itemId : undefined;
	const finalCopyText = final ? messageText(final) : "";
	const sessionId = items[0]?.sessionId;
	const executionCalls = segments.map((segment) =>
		segment.type === "tools"
			? segment.calls.filter(
					(call) =>
						!pendingToolIds.has(call.toolCallId) &&
						call.name !== "ask_user" &&
						(call.name !== "deliver_file" || results.get(call.toolCallId)?.isError) &&
						(call.name !== "set_tasks" || results.get(call.toolCallId)?.isError),
				)
			: [],
	);
	const lastToolSegment = segments.reduce(
		(last, segment, index) =>
			segment.type === "tools" && (executionCalls[index]!.length > 0 || segment.orphanResults.length > 0)
				? index
				: last,
		-1,
	);
	const snapshots = [...results.values()].flatMap((result) => (result.codeChanges ? [result.codeChanges] : []));
	const turnSummary = summarizeCodeChanges(snapshots);

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
						<div className="transcript-tool-group" key={`tools-${segmentIndex}`}>
							<CodeExecution
								calls={executionCalls[segmentIndex]!}
								orphanResults={segment.orphanResults}
								results={results}
								turnCounts={
									segmentIndex === lastToolSegment &&
									turnSummary &&
									(turnSummary.files.length > 0 ||
										Boolean(turnSummary.counts.additions || turnSummary.counts.deletions))
										? turnSummary.counts
										: undefined
								}
							/>
							<ConversationToolCards calls={segment.calls} allCalls={allCalls} results={results} />
							{sessionId ? (
								<ToolResultImages
									images={toolResultImagesFromCalls(segment.calls, results, segment.orphanResults)}
									sessionId={sessionId}
								/>
							) : null}
						</div>
					);
				}
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
			{!running && (
				<CodeTurnChanges
					onViewChanges={navigateChanges && sessionId ? (path) => navigateChanges(sessionId, path) : undefined}
					snapshots={snapshots}
				/>
			)}
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
					runId={runId}
					waitingForAnswer={waitingForAnswer}
					replyVisible={final?.state === "streaming"}
				/>
			)}
		</>
	);
}, sameTurnProps);
