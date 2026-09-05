import type { ItemContentBlockView, ItemView, SessionDeliveredFileView } from "@metis/app-protocol";
import { CaretRight, CircleNotch, GitFork, ImageSquare, TerminalWindow, Wrench } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DeliveredFileCards } from "./DeliveredFileCards.tsx";
import { Markdown } from "./Markdown.tsx";
import { ToolResultImages } from "./ToolResultImages.tsx";
import { TurnCopyButton } from "./TranscriptTurn.tsx";
import { TurnRuntimeStatus } from "./TurnRuntimeStatus.tsx";
import {
	actionSummary,
	buildCodeTurnPresentation,
	commandText,
	isCommandTool,
	messageText,
	toolResultImagesFromCalls,
	toolTranscriptPresentation,
	type ToolCallBlock,
	type ToolDetailLine,
	type ToolResultBlock,
} from "./transcript-turn-model.ts";

function VisibleBlock({ block, markdown = false }: { readonly block: ItemContentBlockView; readonly markdown?: boolean }) {
	const { t } = useTranslation();
	switch (block.type) {
		case "text":
			return markdown ? <Markdown text={block.text} /> : <p>{block.text}</p>;
		case "image":
			return <p className="transcript-attachment"><ImageSquare aria-hidden="true" size={16} /> {t("Image")} · {block.image.mediaType}</p>;
		case "notice":
			return <p className={`notice notice-${block.level}`}>{block.text}</p>;
		case "thinking":
		case "tool_call":
		case "tool_result":
		case "compaction":
		case "plan":
			return null;
	}
}

function CodeToolDetails({ call, lines, rawInput, rawOutput, rawOutputIsError }: {
	readonly call?: ToolCallBlock;
	readonly lines: readonly ToolDetailLine[];
	readonly rawInput?: string;
	readonly rawOutput?: string;
	readonly rawOutputIsError: boolean;
}) {
	const input = commandText(rawInput);
	if (lines.length === 0 && !input && rawOutput === undefined) return null;
	return (
		<div className="code-command-details">
			{lines.length > 0 && <dl className="tool-safe-details">
				{lines.map((line, index) => <div className="tool-safe-row" key={`${line.label ?? "detail"}-${index}`}>
					{line.label && <dt>{line.label}</dt>}
					<dd>{line.value}</dd>
				</div>)}
			</dl>}
			{input && <pre className="code-command-input">{call && isCommandTool(call.name) ? `$ ${input}` : input}</pre>}
			{rawOutput !== undefined && (
				<pre className={rawOutputIsError ? "code-command-output code-command-output-error" : "code-command-output"}>{rawOutput}</pre>
			)}
		</div>
	);
}

function CodeToolStep({ call, result }: {
	readonly call: ToolCallBlock;
	readonly result?: ToolResultBlock;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const presentation = toolTranscriptPresentation(call, result, t);
	const running = call.state === "running" || call.state === "pending";
	const Icon = isCommandTool(call.name) ? TerminalWindow : Wrench;
	return (
		<details className={isCommandTool(call.name) ? "code-command code-command-shell" : "code-command code-command-tool"} open={open}>
			<summary onClick={(event) => {
				event.preventDefault();
				setOpen((current) => !current);
			}}>
				<Icon aria-hidden="true" size={15} />
				<span>{presentation.label}</span>
				{running && <CircleNotch aria-label={t("Running")} className="code-command-spinner" size={14} />}
				<CaretRight aria-hidden="true" className="code-command-caret" size={12} />
			</summary>
			{open && <CodeToolDetails
				call={call}
				lines={presentation.detailLines}
				rawInput={presentation.rawInput}
				rawOutput={presentation.rawOutput}
				rawOutputIsError={presentation.rawOutputIsError}
			/>}
		</details>
	);
}

function CodeOrphanToolStep({ result }: { readonly result: ToolResultBlock }) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const presentation = toolTranscriptPresentation(undefined, result, t);
	return (
		<details className="code-command code-command-tool" open={open}>
			<summary onClick={(event) => {
				event.preventDefault();
				setOpen((current) => !current);
			}}>
				<Wrench aria-hidden="true" size={15} />
				<span>{presentation.label}</span>
				<CaretRight aria-hidden="true" className="code-command-caret" size={12} />
			</summary>
			{open && <CodeToolDetails
				lines={presentation.detailLines}
				rawOutput={presentation.rawOutput}
				rawOutputIsError={presentation.rawOutputIsError}
			/>}
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
				<span aria-hidden="true" className="code-execution-title-leave">{leaving}</span>
			)}
			<span className={`code-execution-title-enter${leaving !== null ? " from-top" : ""}`} key={text}>{text}</span>
		</span>
	);
}

function CodeExecution({ calls, results, orphanResults }: {
	readonly calls: readonly ToolCallBlock[];
	readonly results: ReadonlyMap<string, ToolResultBlock>;
	readonly orphanResults: readonly ToolResultBlock[];
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	return (
		<details className="code-execution" open={open}>
			<summary onClick={(event) => {
				event.preventDefault();
				setOpen((current) => !current);
			}}>
				<CodeExecutionTitle text={calls.length > 0 ? actionSummary(calls, t) : t("Used a tool")} />
				<CaretRight aria-hidden="true" className="code-execution-caret" size={12} />
			</summary>
			{open && (
				<div className="code-execution-card">
					{calls.map((call) => (
						<CodeToolStep
							call={call}
							key={call.toolCallId}
							result={results.get(call.toolCallId)}
						/>
					))}
					{orphanResults.map((result) => (
						<CodeOrphanToolStep key={`orphan-${result.toolCallId}`} result={result} />
					))}
				</div>
			)}
		</details>
	);
}

export function CodeTranscriptTurn({
	items,
	running = false,
	startedAt,
	onFork,
	onCopy,
	onOpenDeliveredFile,
	onPreviewDeliveredFile,
}: {
	readonly items: readonly ItemView[];
	readonly running?: boolean;
	readonly startedAt?: string;
	readonly onFork?: (entryId: string) => void;
	readonly onCopy?: (text: string) => void;
	readonly onOpenDeliveredFile?: (fileId: string, action: "default" | "reveal") => void;
	readonly onPreviewDeliveredFile?: (file: SessionDeliveredFileView) => void;
}) {
	const { t } = useTranslation();
	const { users, segments, results, final, deliveredFiles } = buildCodeTurnPresentation(items);
	const enteringUserId = running ? users.at(-1)?.itemId : undefined;
	const finalCopyText = final ? messageText(final) : "";
	const sessionId = items[0]?.sessionId;

		return (
			<>
				{segments.map((segment, segmentIndex) => {
					if (segment.type === "user") {
						const copyText = messageText(segment.item);
						return (
							<div className={`code-turn-user${segment.item.itemId === enteringUserId ? " is-entering" : ""}`} key={segment.item.itemId}>
								<div className="code-turn-user-bubble">{segment.item.content.map((block, blockIndex) => <VisibleBlock block={block} key={`${block.type}-${blockIndex}`} />)}</div>
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
							<div key={`tools-${segmentIndex}`}>
								<CodeExecution
									calls={segment.calls}
									orphanResults={segment.orphanResults}
									results={results}
								/>
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
							key={`content-${segmentIndex}`}
						>
							{segment.blocks.map((block, blockIndex) => (
								<VisibleBlock block={block} key={`${block.type}-${blockIndex}`} markdown={segment.markdown} />
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
					{onCopy && finalCopyText.trim() !== "" && (
						<TurnCopyButton onCopy={onCopy} text={finalCopyText} />
					)}
				</div>
			)}
			{running && <TurnRuntimeStatus items={items} running startedAt={startedAt} />}
		</>
	);
}
