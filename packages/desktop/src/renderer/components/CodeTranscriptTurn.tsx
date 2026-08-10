import type { ItemContentBlockView, ItemView } from "@metis/app-protocol";
import { CaretRight, CircleNotch, ImageSquare, TerminalWindow, Wrench } from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "./Markdown.tsx";
import { TurnRuntimeStatus } from "./TurnRuntimeStatus.tsx";
import {
	actionSummary,
	buildCodeTurnPresentation,
	commandText,
	isCommandTool,
	toolLabel,
	type ToolCallBlock,
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
			return null;
	}
}

function CodeToolStep({ call, result, initiallyOpen }: {
	readonly call: ToolCallBlock;
	readonly result?: ToolResultBlock;
	readonly initiallyOpen: boolean;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(initiallyOpen);
	const input = commandText(call.inputPreview);
	const running = call.state === "running" || call.state === "pending";
	const Icon = isCommandTool(call.name) ? TerminalWindow : Wrench;
	return (
		<details className={isCommandTool(call.name) ? "code-command code-command-shell" : "code-command code-command-tool"} open={open}>
			<summary onClick={(event) => {
				event.preventDefault();
				setOpen((current) => !current);
			}}>
				<Icon aria-hidden="true" size={15} />
				<span>{toolLabel(call, t)}</span>
				{running && <CircleNotch aria-label={t("Running")} className="code-command-spinner" size={14} />}
				<CaretRight aria-hidden="true" className="code-command-caret" size={12} />
			</summary>
			{open && (input || result) && (
				<div className="code-command-details">
					{input && <pre className="code-command-input">{isCommandTool(call.name) ? `$ ${input}` : input}</pre>}
					{result && (
						<pre className={result.isError ? "code-command-output code-command-output-error" : "code-command-output"}>
							{result.output}
						</pre>
					)}
				</div>
			)}
		</details>
	);
}

function CodeExecution({ calls, results, orphanResults, running }: {
	readonly calls: readonly ToolCallBlock[];
	readonly results: ReadonlyMap<string, ToolResultBlock>;
	readonly orphanResults: readonly ToolResultBlock[];
	readonly running: boolean;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(running);
	const firstCommandIndex = calls.findIndex((call) => isCommandTool(call.name));
	const initiallyOpenIndex = firstCommandIndex >= 0 ? firstCommandIndex : 0;
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
					{calls.map((call, index) => (
						<CodeToolStep
							call={call}
							initiallyOpen={index === initiallyOpenIndex || call.state === "running" || call.state === "pending"}
							key={call.toolCallId}
							result={results.get(call.toolCallId)}
						/>
					))}
					{orphanResults.map((result) => (
						<div className="code-command" key={`orphan-${result.toolCallId}`}>
							<div className="code-command-orphan-label"><Wrench aria-hidden="true" size={15} /> {t("{{name}} result", { name: result.name })}</div>
							<pre className={result.isError ? "code-command-output code-command-output-error" : "code-command-output"}>{result.output}</pre>
						</div>
					))}
				</div>
			)}
		</details>
	);
}

export function CodeTranscriptTurn({ items, running = false, startedAt }: {
	readonly items: readonly ItemView[];
	readonly running?: boolean;
	readonly startedAt?: string;
}) {
	const { users, segments, results } = buildCodeTurnPresentation(items);

	return (
		<>
			{users.map((item) => (
				<div className="code-turn-user" key={item.itemId}>
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
						running={segment.running}
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
			{running && <TurnRuntimeStatus items={items} running startedAt={startedAt} />}
		</>
	);
}
