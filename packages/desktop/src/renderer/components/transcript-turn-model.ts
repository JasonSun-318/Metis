import type { ItemContentBlockView, ItemView } from "@arcmind/app-protocol";

export type TextBlock = Extract<ItemContentBlockView, { type: "text" }>;
export type ThinkingBlock = Extract<ItemContentBlockView, { type: "thinking" }>;
export type ToolCallBlock = Extract<ItemContentBlockView, { type: "tool_call" }>;
export type ToolResultBlock = Extract<ItemContentBlockView, { type: "tool_result" }>;
export type VisibleCodeBlock = Extract<ItemContentBlockView, { type: "text" | "image" | "notice" }>;

export type CodeTranscriptSegment =
	| {
			readonly type: "content";
			readonly blocks: readonly VisibleCodeBlock[];
			readonly answer: boolean;
			readonly markdown: boolean;
	  }
	| {
			readonly type: "tools";
			readonly calls: readonly ToolCallBlock[];
			readonly orphanResults: readonly ToolResultBlock[];
			readonly running: boolean;
	  };

export interface CodeTurnPresentation {
	readonly users: readonly ItemView[];
	readonly segments: readonly CodeTranscriptSegment[];
	readonly results: ReadonlyMap<string, ToolResultBlock>;
}

export interface TurnPresentation {
	readonly users: readonly ItemView[];
	readonly activity: readonly (ThinkingBlock | ToolCallBlock | ToolResultBlock)[];
	readonly intermediateText: readonly TextBlock[];
	readonly final?: ItemView;
	readonly calls: readonly ToolCallBlock[];
	readonly results: ReadonlyMap<string, ToolResultBlock>;
	readonly running: boolean;
}

function textBlocks(item: ItemView): TextBlock[] {
	return item.content.filter((block): block is TextBlock => block.type === "text");
}

function isThinkingEcho(text: string, thinking: string): boolean {
	const visible = text.replace(/\s/gu, "");
	const internal = thinking.replace(/\s/gu, "");
	if (visible === internal) return true;
	const shorter = Math.min(visible.length, internal.length);
	if (shorter < 80 || Math.max(visible.length, internal.length) > shorter * 1.2) return false;
	let prefix = 0;
	while (prefix < shorter && visible[prefix] === internal[prefix]) prefix += 1;
	let suffix = 0;
	while (suffix < shorter - prefix && visible[visible.length - 1 - suffix] === internal[internal.length - 1 - suffix])
		suffix += 1;
	return prefix + suffix >= shorter * 0.8;
}

function toolCalls(item: ItemView): ToolCallBlock[] {
	return item.content.filter((block): block is ToolCallBlock => block.type === "tool_call");
}

function finalResponseIndex(items: readonly ItemView[]): number {
	let lastToolIndex = -1;
	for (let index = 0; index < items.length; index += 1) {
		if (items[index]!.content.some((block) => block.type === "tool_call" || block.type === "tool_result"))
			lastToolIndex = index;
	}
	for (let index = items.length - 1; index > lastToolIndex; index -= 1) {
		const item = items[index]!;
		if (item.role !== "assistant" || toolCalls(item).length > 0) continue;
		const thinking = item.content.filter((block): block is ThinkingBlock => block.type === "thinking");
		if (textBlocks(item).some((block) => !thinking.some((candidate) => isThinkingEcho(block.text, candidate.text))))
			return index;
	}
	return -1;
}

export function isCommandTool(name: string): boolean {
	return /(?:^|[_-])(bash|shell|run_command|command)(?:$|[_-])/iu.test(`_${name}_`);
}

export function commandText(inputPreview: string | undefined): string | undefined {
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

export function toolLabel(call: ToolCallBlock): string {
	if (isCommandTool(call.name))
		return call.state === "running" || call.state === "pending" ? "Running command" : "Ran command";
	if (/request.*(?:directory|folder)|cowork.*directory/iu.test(call.name)) return "Asked to access a folder";
	return call.state === "running" || call.state === "pending" ? `Using ${call.name}` : `Used ${call.name}`;
}

export function actionSummary(calls: readonly ToolCallBlock[]): string {
	const commands = calls.filter((call) => isCommandTool(call.name));
	const others = calls.length - commands.length;
	const running = calls.some((call) => call.state === "running" || call.state === "pending");
	if (commands.length > 0 && others > 0)
		return running ? "Running a command, using a tool" : "Ran a command, used a tool";
	if (commands.length > 0)
		return running
			? "Running a command"
			: commands.length === 1
				? "Ran a command"
				: `Ran ${commands.length} commands`;
	if (others > 0) return running ? "Using a tool" : others === 1 ? "Used a tool" : `Used ${others} tools`;
	return "Thought process";
}

export function buildTurnPresentation(items: readonly ItemView[]): TurnPresentation {
	const finalIndex = finalResponseIndex(items);
	const users = items.filter((item) => item.role === "user");
	const calls = items.filter((item) => item.role !== "user").flatMap(toolCalls);
	const callIds = new Set(calls.map((call) => call.toolCallId));
	const results = new Map<string, ToolResultBlock>();
	for (const item of items) {
		for (const block of item.content) {
			if (block.type === "tool_result") results.set(block.toolCallId, block);
		}
	}
	const activity = items
		.filter((item) => item.role !== "user")
		.flatMap((item) => item.content)
		.filter(
			(block): block is ThinkingBlock | ToolCallBlock | ToolResultBlock =>
				block.type === "thinking" ||
				block.type === "tool_call" ||
				(block.type === "tool_result" && !callIds.has(block.toolCallId)),
		);
	const intermediateText = items.flatMap((item, index) => {
		if (item.role !== "assistant" || index === finalIndex) return [];
		const thinking = item.content.filter((block): block is ThinkingBlock => block.type === "thinking");
		return textBlocks(item).filter(
			(block) => !thinking.some((candidate) => isThinkingEcho(block.text, candidate.text)),
		);
	});
	return {
		users,
		activity,
		intermediateText,
		final: finalIndex >= 0 ? items[finalIndex] : undefined,
		calls,
		results,
		running: calls.some((call) => call.state === "running" || call.state === "pending"),
	};
}

export function buildCodeTurnPresentation(items: readonly ItemView[]): CodeTurnPresentation {
	const finalIndex = finalResponseIndex(items);
	const results = new Map<string, ToolResultBlock>();
	for (const item of items) {
		for (const block of item.content) {
			if (block.type === "tool_result") results.set(block.toolCallId, block);
		}
	}

	const segments: CodeTranscriptSegment[] = [];
	let contentBlocks: VisibleCodeBlock[] = [];
	let contentAnswer = false;
	let contentMarkdown = false;
	let calls: ToolCallBlock[] = [];
	let orphanResults: ToolResultBlock[] = [];

	const flushContent = () => {
		if (contentBlocks.length === 0) return;
		segments.push({
			type: "content",
			blocks: contentBlocks,
			answer: contentAnswer,
			markdown: contentMarkdown,
		});
		contentBlocks = [];
	};
	const flushTools = () => {
		if (calls.length === 0 && orphanResults.length === 0) return;
		segments.push({
			type: "tools",
			calls,
			orphanResults,
			running: calls.some((call) => call.state === "running" || call.state === "pending"),
		});
		calls = [];
		orphanResults = [];
	};

	for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
		const item = items[itemIndex]!;
		if (item.role === "user") continue;
		const thinking = item.content.filter((block): block is ThinkingBlock => block.type === "thinking");
		const answer = itemIndex === finalIndex;
		const markdown = answer && item.state !== "streaming";
		for (const block of item.content) {
			if (block.type === "thinking") continue;
			if (block.type === "tool_call") {
				flushContent();
				calls.push(block);
				continue;
			}
			if (block.type === "tool_result") {
				flushContent();
				if (!calls.some((call) => call.toolCallId === block.toolCallId)) orphanResults.push(block);
				continue;
			}
			if (block.type === "text" && thinking.some((candidate) => isThinkingEcho(block.text, candidate.text)))
				continue;
			flushTools();
			if (contentBlocks.length > 0 && (contentAnswer !== answer || contentMarkdown !== markdown)) flushContent();
			contentAnswer = answer;
			contentMarkdown = markdown;
			contentBlocks.push(block);
		}
	}
	flushContent();
	flushTools();

	return {
		users: items.filter((item) => item.role === "user"),
		segments,
		results,
	};
}
