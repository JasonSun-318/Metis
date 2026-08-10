import type { ItemContentBlockView, ItemView } from "@metis/app-protocol";
import {
	CaretRight,
	CheckCircle,
	CircleNotch,
	ClockCounterClockwise,
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
	toolLabel,
	type ToolCallBlock,
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
			return null;
	}
}

function ToolStep({ call, result }: { readonly call: ToolCallBlock; readonly result?: ToolResultBlock }) {
	const { t } = useTranslation();
	const commandTool = isCommandTool(call.name);
	if (!commandTool) {
		return (
			<div className="tool-step tool-step-static">
				<div className="tool-step-static-label">
					<Wrench aria-hidden="true" size={17} />
					<span>{toolLabel(call, t)}</span>
					{call.state === "running" && <CircleNotch aria-label={t("Running")} className="tool-step-spinner" size={15} />}
				</div>
				{result?.isError && <pre className="tool-step-output tool-step-output-error">{result.output}</pre>}
			</div>
		);
	}
	const command = commandText(call.inputPreview);
	return (
		<details className="tool-step tool-step-command">
			<summary>
				<TerminalWindow aria-hidden="true" size={17} />
				<span>{toolLabel(call, t)}</span>
				{call.state === "running" && <CircleNotch aria-label={t("Running")} className="tool-step-spinner" size={15} />}
			</summary>
			{(command || result) && (
				<div className="tool-step-details">
					{command && <pre className="tool-step-input">{command}</pre>}
					{result && <pre className={result.isError ? "tool-step-output tool-step-output-error" : "tool-step-output"}>{result.output}</pre>}
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

export function TranscriptTurn({ items, running: runtimeRunning = false, startedAt }: {
	readonly items: readonly ItemView[];
	readonly running?: boolean;
	readonly startedAt?: string;
}) {
	const { t } = useTranslation();
	const [open, setOpen] = useState(false);
	const [showAll, setShowAll] = useState(false);
	const { users, calls, results, activity, intermediateText, final, running } = buildTurnPresentation(items);
	// ponytail: content-size heuristic avoids layout observers; measure actual overflow if transcript typography becomes user-configurable.
	const canExpand = activity.length > 4 || activityLength(activity, results) > 600;

	return (
		<>
			{users.map((item) => (
				<div className="turn-user" key={item.itemId}>
					<div className="message message-user">
						{item.content.map((block, index) => <StaticBlock block={block} key={`${block.type}-${index}`} />)}
					</div>
				</div>
			))}
			{intermediateText.length > 0 && (
				<div className="turn-intermediate">
					{intermediateText.map((block, index) => <Markdown key={`intermediate-${index}`} text={block.text} />)}
				</div>
			)}
			{activity.length > 0 && (
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
									return (
										<div className="activity-step tool-step-orphan" key={`result-${block.toolCallId}`}>
											<span className="activity-step-icon"><CheckCircle aria-hidden="true" size={17} /></span>
											<p>{t("{{name}} result", { name: block.name })}</p>
											<pre className={block.isError ? "tool-step-output tool-step-output-error" : "tool-step-output"}>{block.output}</pre>
										</div>
									);
								})}
							</div>
						</div>
					{canExpand && !showAll && (
						<button
							className="execution-chain-show-more"
							onClick={() => setShowAll(true)}
							type="button"
						>
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
						<button
							className="execution-chain-show-more is-show-less"
							onClick={() => setShowAll(false)}
							type="button"
						>
							{t("Show less")}
						</button>
					)}
				</details>
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
			{runtimeRunning && <TurnRuntimeStatus items={items} running startedAt={startedAt} />}
		</>
	);
}
