import type { ItemContentBlockView, ItemView } from "@metis/app-protocol";
import { CaretRight, CircleNotch, GitFork, ImageSquare, TerminalWindow, Wrench } from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "./Markdown.tsx";
import { TurnRuntimeStatus } from "./TurnRuntimeStatus.tsx";
import {
	actionSummary,
	buildCodeTurnPresentation,
	commandText,
	isCommandTool,
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
				<span>{calls.length > 0 ? actionSummary(calls, t) : t("Used a tool")}</span>
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

export function CodeTranscriptTurn({ items, running = false, startedAt, onFork }: {
	readonly items: readonly ItemView[];
	readonly running?: boolean;
	readonly startedAt?: string;
	readonly onFork?: (entryId: string) => void;
}) {
	const { t } = useTranslation();
	const { users, segments, results, finalItemId } = buildCodeTurnPresentation(items);
	const enteringUserId = running ? users.at(-1)?.itemId : undefined;

	return (
		<>
			{users.map((item) => (
				<div className={`code-turn-user${item.itemId === enteringUserId ? " is-entering" : ""}`} key={item.itemId}>
					<div>{item.content.map((block, index) => <VisibleBlock block={block} key={`${block.type}-${index}`} />)}</div>
				</div>
			))}
			{segments.map((segment, segmentIndex) =>
				segment.type === "tools" ? (
					<CodeExecution
						calls={segment.calls}
						key={`tools-${segmentIndex}`}
						orphanResults={segment.orphanResults}
						results={results}
					/>
				) : (
					<div
						className={segment.answer ? "code-turn-answer" : "code-turn-status"}
						data-transcript-answer={segment.answer ? true : undefined}
						key={`content-${segmentIndex}`}
					>
						{segment.blocks.map((block, blockIndex) => (
							<VisibleBlock block={block} key={`${block.type}-${blockIndex}`} markdown={segment.markdown} />
						))}
					</div>
				),
			)}
			{finalItemId && onFork && (
				<button
					aria-label={t("Fork conversation")}
					className="turn-fork-button"
					onClick={() => onFork(finalItemId)}
					title={t("Fork this conversation from this reply")}
					type="button"
				>
					<GitFork aria-hidden="true" size={13} />
					{t("Fork")}
				</button>
			)}
			{running && <TurnRuntimeStatus items={items} running startedAt={startedAt} />}
		</>
	);
}
