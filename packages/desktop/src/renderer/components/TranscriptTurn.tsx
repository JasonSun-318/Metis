import type { ItemContentBlockView, ItemView } from "@arcmind/app-protocol";
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
import { Markdown } from "./Markdown.tsx";

type TextBlock = Extract<ItemContentBlockView, { type: "text" }>;
type ThinkingBlock = Extract<ItemContentBlockView, { type: "thinking" }>;
type ToolCall = Extract<ItemContentBlockView, { type: "tool_call" }>;
type ToolResult = Extract<ItemContentBlockView, { type: "tool_result" }>;

function textBlocks(item: ItemView): TextBlock[] {
	return item.content.filter((block): block is TextBlock => block.type === "text");
}

function toolCalls(item: ItemView): ToolCall[] {
	return item.content.filter((block): block is ToolCall => block.type === "tool_call");
}

function finalResponseIndex(items: readonly ItemView[]): number {
	let lastToolIndex = -1;
	for (let index = 0; index < items.length; index += 1) {
		if (items[index]!.content.some((block) => block.type === "tool_call" || block.type === "tool_result")) {
			lastToolIndex = index;
		}
	}
	for (let index = items.length - 1; index > lastToolIndex; index -= 1) {
		const item = items[index]!;
		if (item.role === "assistant" && textBlocks(item).length > 0 && toolCalls(item).length === 0) return index;
	}
	return -1;
}

function isCommandTool(name: string): boolean {
	return /(?:^|[_-])(bash|shell|run_command|command)(?:$|[_-])/iu.test(`_${name}_`);
}

function commandText(inputPreview: string | undefined): string | undefined {
	if (!inputPreview) return undefined;
	try {
		const value: unknown = JSON.parse(inputPreview);
		if (typeof value === "string") return value;
		if (typeof value === "object" && value !== null) {
			for (const key of ["command", "cmd"] as const) {
				const candidate = (value as Record<string, unknown>)[key];
				if (typeof candidate === "string") return candidate;
			}
			return JSON.stringify(value, null, 2);
		}
	} catch {
		// The preview is already display-safe public text.
	}
	return inputPreview;
}

function toolLabel(call: ToolCall): string {
	if (isCommandTool(call.name)) return call.state === "running" ? "Running command" : "Ran command";
	if (/request.*(?:directory|folder)|cowork.*directory/iu.test(call.name)) return "Asked to access a folder";
	return call.state === "running" ? `Using ${call.name}` : `Used ${call.name}`;
}

function actionSummary(calls: readonly ToolCall[]): string {
	const commands = calls.filter((call) => isCommandTool(call.name));
	const others = calls.length - commands.length;
	const running = calls.some((call) => call.state === "running" || call.state === "pending");
	if (commands.length > 0 && others > 0) return running ? "Running a command, using a tool" : "Ran a command, used a tool";
	if (commands.length > 0) return running ? "Running a command" : commands.length === 1 ? "Ran a command" : `Ran ${commands.length} commands`;
	if (others > 0) return running ? "Using a tool" : others === 1 ? "Used a tool" : `Used ${others} tools`;
	return "Thought process";
}

function StaticBlock({ block }: { readonly block: ItemContentBlockView }) {
	switch (block.type) {
		case "text":
			return <p>{block.text}</p>;
		case "image":
			return <p className="transcript-attachment"><ImageSquare aria-hidden="true" size={18} /> Image · {block.image.mediaType}</p>;
		case "notice":
			return <p className={`notice notice-${block.level}`}>{block.text}</p>;
		case "thinking":
		case "tool_call":
		case "tool_result":
			return null;
	}
}

function ToolStep({ call, result }: { readonly call: ToolCall; readonly result?: ToolResult }) {
	const commandTool = isCommandTool(call.name);
	if (!commandTool) {
		return (
			<div className="tool-step tool-step-static">
				<div className="tool-step-static-label">
					<Wrench aria-hidden="true" size={17} />
					<span>{toolLabel(call)}</span>
					{call.state === "running" && <CircleNotch aria-label="Running" className="tool-step-spinner" size={15} />}
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
				<span>{toolLabel(call)}</span>
				{call.state === "running" && <CircleNotch aria-label="Running" className="tool-step-spinner" size={15} />}
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

function activityLength(blocks: readonly ItemContentBlockView[], results: ReadonlyMap<string, ToolResult>): number {
	return blocks.reduce((total, block) => {
		if (block.type === "thinking") return total + block.text.length;
		if (block.type === "tool_call") return total + (block.inputPreview?.length ?? 0) + (results.get(block.toolCallId)?.output.length ?? 0);
		if (block.type === "tool_result") return total + block.output.length;
		return total;
	}, 0);
}

export function TranscriptTurn({ items }: { readonly items: readonly ItemView[] }) {
	const [open, setOpen] = useState(false);
	const [showAll, setShowAll] = useState(false);
	const finalIndex = finalResponseIndex(items);
	const users = items.filter((item) => item.role === "user");
	const calls = items.filter((item) => item.role !== "user").flatMap(toolCalls);
	const callIds = new Set(calls.map((call) => call.toolCallId));
	const results = new Map<string, ToolResult>();
	for (const item of items) {
		for (const block of item.content) if (block.type === "tool_result") results.set(block.toolCallId, block);
	}
	const activity = items
		.filter((item) => item.role !== "user")
		.flatMap((item) => item.content)
		.filter(
			(block): block is ThinkingBlock | ToolCall | ToolResult =>
				block.type === "thinking" || block.type === "tool_call" || (block.type === "tool_result" && !callIds.has(block.toolCallId)),
		);
	const intermediateText = items.flatMap((item, index) =>
		item.role === "assistant" && index !== finalIndex ? textBlocks(item) : [],
	);
	const final = finalIndex >= 0 ? items[finalIndex] : undefined;
	const running = calls.some((call) => call.state === "running" || call.state === "pending");
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
					{intermediateText.map((block, index) => <p key={`intermediate-${index}`}>{block.text}</p>)}
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
						<span>{actionSummary(calls)}</span>
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
											<p>{block.name} result</p>
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
							Show more
						</button>
					)}
					</div>
					{(!canExpand || showAll) && (
						<div className="execution-chain-done">
							{running ? <CircleNotch aria-hidden="true" className="tool-step-spinner" size={17} /> : <CheckCircle aria-hidden="true" size={17} />}
							<span>{running ? "Working" : "Done"}</span>
						</div>
					)}
					{canExpand && showAll && (
						<button
							className="execution-chain-show-more is-show-less"
							onClick={() => setShowAll(false)}
							type="button"
						>
							Show less
						</button>
					)}
				</details>
			)}
			{final && (
				<div className="turn-answer" data-transcript-answer>
					{final.content.map((block, index) =>
						block.type === "text"
							? final.state === "streaming"
								? <p key={`${block.type}-${index}`}>{block.text}</p>
								: <Markdown key={`${block.type}-${index}`} text={block.text} />
							: <StaticBlock block={block} key={`${block.type}-${index}`} />,
					)}
				</div>
			)}
		</>
	);
}
