import type { ItemContentBlockView, ItemView } from "@metis/app-protocol";
import {
	CaretRight,
	CheckCircle,
	CircleNotch,
	ClockCounterClockwise,
	GitFork,
	ImageSquare,
	TerminalWindow,
	Wrench,
} from "@phosphor-icons/react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Markdown } from "./Markdown.tsx";
import { TurnRuntimeStatus } from "./TurnRuntimeStatus.tsx";
import {
	actionSummary,
	buildTurnPresentation,
	commandText,
	isCommandTool,
	toolTranscriptPresentation,
	type ToolCallBlock,
	type ToolDetailLine,
	type ToolResultBlock,
} from "./transcript-turn-model.ts";

function StaticBlock({ block }: { readonly block: ItemContentBlockView }) {
	const { t } = useTranslation();
	switch (block.type) {
		case "text":
			return <p>{block.text}</p>;
		case "image":
			return <p className="transcript-attachment"><ImageSquare aria-hidden="true" size={18} /> {t("Image")} · {block.image.mediaType}</p>;
		case "notice":
			return <p className={`notice notice-${block.level}`}>{block.text}</p>;
		case "thinking":
		case "tool_call":
		case "tool_result":
		case "compaction":
			return null;
	}
}

function SafeToolDetails({ lines }: { readonly lines: readonly ToolDetailLine[] }) {
	if (lines.length === 0) return null;
	return (
		<dl className="tool-safe-details">
			{lines.map((line, index) => <div className="tool-safe-row" key={`${line.label ?? "detail"}-${index}`}>
				{line.label && <dt>{line.label}</dt>}
				<dd>{line.value}</dd>
			</div>)}
		</dl>
	);
}

function ToolStep({ call, result }: { readonly call: ToolCallBlock; readonly result?: ToolResultBlock }) {
	const { t } = useTranslation();
	const commandTool = isCommandTool(call.name);
	const presentation = toolTranscriptPresentation(call, result, t);
	if (!commandTool) {
		return (
			<div className="tool-step tool-step-static">
				<div className="tool-step-static-label">
					<Wrench aria-hidden="true" size={17} />
					<span>{presentation.label}</span>
					{call.state === "running" && <CircleNotch aria-label={t("Running")} className="tool-step-spinner" size={15} />}
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
		<details className="tool-step tool-step-command">
			<summary>
				<TerminalWindow aria-hidden="true" size={17} />
				<span>{presentation.label}</span>
				{call.state === "running" && <CircleNotch aria-label={t("Running")} className="tool-step-spinner" size={15} />}
			</summary>
			{(command || presentation.rawOutput !== undefined) && (
				<div className="tool-step-details">
					{command && <pre className="tool-step-input">{command}</pre>}
					{presentation.rawOutput !== undefined && <pre className={presentation.rawOutputIsError ? "tool-step-output tool-step-output-error" : "tool-step-output"}>{presentation.rawOutput}</pre>}
				</div>
			)}
		</details>
	);
}

function activityLength(blocks: readonly ItemContentBlockView[], results: ReadonlyMap<string, ToolResultBlock>): number {
	return blocks.reduce((total, block) => {
		if (block.type === "thinking") return total + block.text.length;
		if (block.type === "tool_call") return total + (block.inputPreview?.length ?? 0) + (results.get(block.toolCallId)?.output.length ?? 0);
		if (block.type === "tool_result") return total + block.output.length;
		return total;
	}, 0);
}

function ExecutionChain({
	activity,
	calls,
	results,
	running,
}: {
	readonly activity: readonly ItemContentBlockView[];
	readonly calls: readonly ToolCallBlock[];
	readonly results: ReadonlyMap<string, ToolResultBlock>;
	readonly running: boolean;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [showAll, setShowAll] = useState(false);
	// ponytail: content-size heuristic avoids layout observers; measure actual overflow if transcript typography becomes user-configurable.
	const canExpand = activity.length > 4 || activityLength(activity, results) > 600;

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
			<summary onClick={() => {
				if (open) setShowAll(false);
			}}>
				<span>{actionSummary(calls, t)}</span>
				<CaretRight aria-hidden="true" className="execution-chain-caret" size={16} />
			</summary>
			<div className={`execution-chain-content${canExpand && !showAll ? " is-capped" : ""}`}>
				<div className="execution-chain-viewport">
					<div className="execution-chain-timeline">
						{activity.map((block, index) => {
							if (block.type === "thinking") {
								return (
									<div className="activity-step" key={`thinking-${index}`}>
										<span className="activity-step-icon"><ClockCounterClockwise aria-hidden="true" size={17} /></span>
										<p>{block.text}</p>
									</div>
								);
							}
							if (block.type === "tool_call") {
								return <ToolStep call={block} key={`tool-${block.toolCallId}`} result={results.get(block.toolCallId)} />;
							}
							if (block.type === "tool_result") {
								const presentation = toolTranscriptPresentation(undefined, block, t);
								return (
									<div className="activity-step tool-step-orphan" key={`result-${block.toolCallId}`}>
										<span className="activity-step-icon"><CheckCircle aria-hidden="true" size={17} /></span>
										<p>{presentation.label}</p>
										<SafeToolDetails lines={presentation.detailLines} />
										{presentation.rawOutput !== undefined && <pre className={presentation.rawOutputIsError ? "tool-step-output tool-step-output-error" : "tool-step-output"}>{presentation.rawOutput}</pre>}
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
			{(!canExpand || showAll) && (
				<div className="execution-chain-done">
					{running ? <CircleNotch aria-hidden="true" className="tool-step-spinner" size={17} /> : <CheckCircle aria-hidden="true" size={17} />}
					<span>{t(running ? "Working" : "Done")}</span>
				</div>
			)}
			{canExpand && showAll && (
				<button className="execution-chain-show-more is-show-less" onClick={() => setShowAll(false)} type="button">
					{t("Show less")}
				</button>
			)}
		</details>
	);
}

export function TranscriptTurn({ items, running: runtimeRunning = false, startedAt, onFork }: {
	readonly items: readonly ItemView[];
	readonly running?: boolean;
	readonly startedAt?: string;
	readonly onFork?: (entryId: string) => void;
}) {
	const { t } = useTranslation();
	const { users, segments, results, final } = buildTurnPresentation(items);
	const enteringUserId = runtimeRunning ? users.at(-1)?.itemId : undefined;

	return (
		<>
			{users.map((item) => (
				<div className={`turn-user${item.itemId === enteringUserId ? " is-entering" : ""}`} key={item.itemId}>
					<div className="message message-user">
						{item.content.map((block, index) => <StaticBlock block={block} key={`${block.type}-${index}`} />)}
					</div>
				</div>
			))}
			{segments.map((segment, index) =>
				segment.type === "intermediate" ? (
					<div className="turn-intermediate" key={`intermediate-${index}`}>
						{segment.blocks.map((block, blockIndex) => <Markdown key={`text-${blockIndex}`} text={block.text} />)}
					</div>
				) : (
					<ExecutionChain
						activity={segment.blocks}
						calls={segment.calls}
						key={`activity-${index}`}
						results={results}
						running={segment.running}
					/>
				),
			)}
			{final && (
				<div className="turn-answer" data-transcript-answer>
					{final.content.map((block, index) =>
						block.type === "text"
							? <Markdown key={`${block.type}-${index}`} text={block.text} />
							: <StaticBlock block={block} key={`${block.type}-${index}`} />,
					)}
				</div>
			)}
			{final && onFork && (
				<button
					aria-label={t("Fork conversation")}
					className="turn-fork-button"
					onClick={() => onFork(final.itemId)}
					title={t("Fork this conversation from this reply")}
					type="button"
				>
					<GitFork aria-hidden="true" size={13} />
					{t("Fork")}
				</button>
			)}
			{runtimeRunning && <TurnRuntimeStatus items={items} running startedAt={startedAt} />}
		</>
	);
}
