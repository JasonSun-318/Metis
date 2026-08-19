import type {
	DurableImageRefView,
	ItemContentBlockView,
	ItemView,
	SessionDeliveredFileView,
} from "@metis/app-protocol";

export type TextBlock = Extract<ItemContentBlockView, { type: "text" }>;
export type ThinkingBlock = Extract<ItemContentBlockView, { type: "thinking" }>;
export type ToolCallBlock = Extract<ItemContentBlockView, { type: "tool_call" }>;
export type ToolResultBlock = Extract<ItemContentBlockView, { type: "tool_result" }>;
export type VisibleCodeBlock = Extract<ItemContentBlockView, { type: "text" | "image" | "notice" }>;
type Translator = (key: string, options?: Record<string, unknown>) => string;
const identity: Translator = (key, options) =>
	Object.entries(options ?? {}).reduce(
		(text, [name, value]) => (value === undefined ? text : text.replaceAll(`{{${name}}}`, String(value))),
		key,
	);

export interface ToolDetailLine {
	readonly label?: string;
	readonly value: string;
}

export interface ToolTranscriptPresentation {
	readonly label: string;
	readonly detailLines: readonly ToolDetailLine[];
	readonly rawInput?: string;
	readonly rawOutput?: string;
	readonly rawOutputIsError: boolean;
}

const INTERNAL_TOOL_NAMES = new Set([
	"set_tasks",
	"deliver_file",
	"ask_user",
	"tool_search",
	"activate_subagents",
	"spawn_agent",
	"inspect_agents",
	"message_agent",
	"interrupt_agent",
	"close_agent",
]);
const TERMINAL_SUBAGENT_STATUSES = new Set(["done", "failed", "stopped"]);
const PREVIEW_LINES = 10;
const PREVIEW_CHARS = 2_000;

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
	readonly deliveredFiles: readonly SessionDeliveredFileView[];
	/** Final assistant reply item, when this turn has one. */
	readonly final?: ItemView;
	/** Final assistant reply item id, when this turn has one. */
	readonly finalItemId?: string;
}

export type ChatTranscriptSegment =
	| {
			readonly type: "activity";
			readonly blocks: readonly (ThinkingBlock | ToolCallBlock | ToolResultBlock)[];
			readonly calls: readonly ToolCallBlock[];
			readonly running: boolean;
	  }
	| {
			readonly type: "intermediate";
			readonly blocks: readonly TextBlock[];
	  };

export interface TurnPresentation {
	readonly users: readonly ItemView[];
	readonly segments: readonly ChatTranscriptSegment[];
	readonly final?: ItemView;
	readonly results: ReadonlyMap<string, ToolResultBlock>;
	readonly deliveredFiles: readonly SessionDeliveredFileView[];
}

function textBlocks(item: ItemView): TextBlock[] {
	return item.content.filter((block): block is TextBlock => block.type === "text");
}

/** Visible markdown/plain text of a message, concatenated in block order. */
export function messageText(item: ItemView): string {
	return textBlocks(item)
		.map((block) => block.text)
		.join("\n");
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

export function toolResultImagesFromBlocks(
	blocks: readonly ItemContentBlockView[],
	results: ReadonlyMap<string, ToolResultBlock>,
): DurableImageRefView[] {
	const images: DurableImageRefView[] = [];
	for (const block of blocks) {
		if (block.type === "tool_call") {
			const result = results.get(block.toolCallId);
			if (result?.images) images.push(...result.images);
		} else if (block.type === "tool_result" && block.images) {
			images.push(...block.images);
		}
	}
	return images;
}

export function toolResultImagesFromCalls(
	calls: readonly ToolCallBlock[],
	results: ReadonlyMap<string, ToolResultBlock>,
	orphanResults: readonly ToolResultBlock[],
): DurableImageRefView[] {
	const images: DurableImageRefView[] = [];
	for (const call of calls) {
		const result = results.get(call.toolCallId);
		if (result?.images) images.push(...result.images);
	}
	for (const result of orphanResults) {
		if (result.images) images.push(...result.images);
	}
	return images;
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

export function toolLabel(call: ToolCallBlock, t: Translator = identity): string {
	if (isCommandTool(call.name))
		return t(call.state === "running" || call.state === "pending" ? "Running command" : "Ran command");
	if (/request.*(?:directory|folder)|cowork.*directory/iu.test(call.name)) return t("Asked to access a folder");
	return t(call.state === "running" || call.state === "pending" ? "Using {{name}}" : "Used {{name}}", {
		name: call.name,
	});
}

function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function jsonValue(text: string | undefined): unknown {
	if (!text) return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function inputRecord(call: ToolCallBlock | undefined): Record<string, unknown> | undefined {
	return record(jsonValue(call?.inputPreview));
}

function resultRecord(result: ToolResultBlock | undefined): Record<string, unknown> | undefined {
	return record(jsonValue(result?.output));
}

function stringField(value: Record<string, unknown> | undefined, key: string): string | undefined {
	const candidate = value?.[key];
	return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
}

function booleanField(value: Record<string, unknown> | undefined, key: string): boolean | undefined {
	const candidate = value?.[key];
	return typeof candidate === "boolean" ? candidate : undefined;
}

function boundedPreview(value: string): string {
	const byCharacters = value.trim().slice(0, PREVIEW_CHARS);
	const lines = byCharacters.split("\n");
	const preview = lines.slice(0, PREVIEW_LINES).join("\n");
	return value.trim().length > byCharacters.length || lines.length > PREVIEW_LINES ? `${preview}\n…` : preview;
}

function safeShortError(output: string | undefined): string | undefined {
	const text = output?.trim();
	if (!text || text.length > 240 || text.includes("\n") || /^(?:\{|\[)/u.test(text)) return undefined;
	return text;
}

function detail(label: string | undefined, value: string | undefined): ToolDetailLine[] {
	return value ? [{ ...(label ? { label } : {}), value }] : [];
}

function internalFailureLabel(name: string, t: Translator): string {
	switch (name) {
		case "set_tasks":
			return t("Failed to update task list");
		case "deliver_file":
			return t("Failed to deliver file");
		case "ask_user":
			return t("Failed to ask user");
		case "activate_subagents":
			return t("Failed to activate subagents");
		case "spawn_agent":
			return t("Failed to spawn subagent");
		case "inspect_agents":
			return t("Failed to inspect subagents");
		case "message_agent":
			return t("Failed to message subagent");
		case "interrupt_agent":
			return t("Failed to interrupt subagent");
		case "close_agent":
			return t("Failed to close subagent");
		case "tool_search":
			return t("Tool search failed");
		default:
			return t("Folder access failed");
	}
}

function setTasksPresentation(
	call: ToolCallBlock | undefined,
	result: ToolResultBlock | undefined,
	t: Translator,
): ToolTranscriptPresentation {
	const input = inputRecord(call);
	const inputTasks = Array.isArray(input?.tasks)
		? input.tasks.flatMap((candidate) => {
				const task = record(candidate);
				const text = stringField(task, "task");
				const completed = booleanField(task, "completed");
				return text && completed !== undefined ? [{ task: text, completed }] : [];
			})
		: [];
	const resultTasks =
		result?.output.split("\n").flatMap((line) => {
			const match = /^- \[([ x])\] (.+)$/u.exec(line.trim());
			return match ? [{ task: match[2]!, completed: match[1] === "x" }] : [];
		}) ?? [];
	const tasks = inputTasks.length > 0 ? inputTasks : resultTasks;
	const completed = tasks.filter((task) => task.completed).length;
	const running = call?.state === "running" || call?.state === "pending";
	const label = running
		? t("Updating task list")
		: tasks.length > 0
			? t("Updated task list · {{completed}}/{{total}} completed", { completed, total: tasks.length })
			: t("Updated task list");
	return {
		label,
		detailLines: tasks.map((task) => ({ value: `${task.completed ? "✓" : "○"} ${task.task}` })),
		rawOutputIsError: false,
	};
}

function deliverFilePresentation(
	call: ToolCallBlock | undefined,
	result: ToolResultBlock | undefined,
	t: Translator,
): ToolTranscriptPresentation {
	const input = inputRecord(call);
	const name = stringField(input, "name") ?? stringField(input, "path");
	const message = stringField(input, "message");
	const running = call?.state === "running" || call?.state === "pending";
	const label = running ? t("Delivering file") : t("Delivered file to user");
	const errorLine = result?.isError ? safeShortError(result.output) : undefined;
	const detailLines = [
		...(name ? [{ value: name }] : []),
		...(message ? [{ value: message }] : []),
		...(errorLine ? [{ value: errorLine }] : []),
	];
	return { label, detailLines, rawOutputIsError: Boolean(result?.isError) };
}

interface AskAnswer {
	readonly question: string;
	readonly answer?: string;
}

function askAnswers(result: ToolResultBlock | undefined): AskAnswer[] {
	const prefix = "User answers:\n";
	if (!result?.output.startsWith(prefix)) return [];
	const value = jsonValue(result.output.slice(prefix.length));
	if (!Array.isArray(value)) return [];
	return value.flatMap((candidate) => {
		const answer = record(candidate);
		const question = stringField(answer, "question");
		if (!question) return [];
		const selected = Array.isArray(answer?.selected)
			? answer.selected.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
			: [];
		const custom = stringField(answer, "customAnswer");
		const parts = [...selected, ...(custom ? [custom] : [])];
		return [{ question, ...(parts.length > 0 ? { answer: parts.join(" · ") } : {}) }];
	});
}

function askUserPresentation(
	call: ToolCallBlock | undefined,
	result: ToolResultBlock | undefined,
	t: Translator,
): ToolTranscriptPresentation {
	const input = inputRecord(call);
	const questions = Array.isArray(input?.questions)
		? input.questions.flatMap((candidate) => {
				const question = stringField(record(candidate), "question");
				return question ? [question] : [];
			})
		: [];
	const answers = askAnswers(result);
	const cancelled = result?.output.includes("cancelled these questions") === true;
	const running = call?.state === "running" || call?.state === "pending";
	const lines: ToolDetailLine[] = [];
	if (answers.length > 0) {
		for (const answer of answers) {
			lines.push({ label: t("Question"), value: answer.question });
			if (answer.answer) lines.push({ label: t("Answer"), value: answer.answer });
		}
	} else {
		for (const question of questions) lines.push({ label: t("Question"), value: question });
		if (cancelled) lines.push({ value: t("The user cancelled") });
		else if (result && !running) lines.push({ value: t("Answer details unavailable") });
	}
	return {
		label: t(running ? "Asking user" : "Asked user"),
		detailLines: lines,
		rawOutputIsError: false,
	};
}

function subagentName(
	input: Record<string, unknown> | undefined,
	output: Record<string, unknown> | undefined,
): string | undefined {
	return stringField(input, "name") ?? stringField(output, "name");
}

function withName(label: string, name: string | undefined): string {
	return name ? `${label} · ${name}` : label;
}

function spawnAgentPresentation(
	call: ToolCallBlock | undefined,
	result: ToolResultBlock | undefined,
	t: Translator,
): ToolTranscriptPresentation {
	const input = inputRecord(call);
	const output = resultRecord(result);
	const name = subagentName(input, output);
	const background = booleanField(input, "background") ?? booleanField(output, "background");
	const status = stringField(output, "status");
	const completed = background === false && status !== undefined && TERMINAL_SUBAGENT_STATUSES.has(status);
	const task = stringField(output, "taskSummary") ?? stringField(input, "task");
	const finalSummary = stringField(output, "finalSummary");
	const lines = [
		...detail(t("Task"), task && boundedPreview(task)),
		...detail(t("Mode"), background === undefined ? undefined : t(background ? "Background" : "Foreground")),
		...detail(t("Status"), status),
	];
	if (completed) lines.push(...detail(t("Result"), finalSummary && boundedPreview(finalSummary)));
	return {
		label: withName(t(completed ? "Subagent completed" : "Spawned subagent"), name),
		detailLines: lines,
		rawOutputIsError: false,
	};
}

function inspectAgentsPresentation(result: ToolResultBlock | undefined, t: Translator): ToolTranscriptPresentation {
	const lines: ToolDetailLine[] = [];
	let count = 0;
	for (const line of result?.output.split("\n") ?? []) {
		const session = /^Session "(.+)": (\S+)$/u.exec(line);
		if (session) {
			count += 1;
			lines.push({ value: `${session[1]} · ${session[2]}` });
			continue;
		}
		if (/^Agent ID:/u.test(line) || !line.trim()) continue;
		if (/^\[(?:user|assistant)\] /u.test(line)) lines.push({ value: boundedPreview(line) });
		else if (line === "No subagent sessions.") lines.push({ value: line });
	}
	return {
		label: count > 0 ? t("Inspected {{count}} subagents", { count }) : t("Inspected subagents"),
		detailLines: lines.slice(0, PREVIEW_LINES),
		rawOutputIsError: false,
	};
}

function messageAgentPresentation(
	call: ToolCallBlock | undefined,
	result: ToolResultBlock | undefined,
	t: Translator,
): ToolTranscriptPresentation {
	const input = inputRecord(call);
	const output = resultRecord(result);
	const mode = stringField(input, "mode");
	const background = booleanField(input, "background") ?? booleanField(output, "background");
	const status = [stringField(output, "status"), stringField(output, "delivery")].filter(Boolean).join(" · ");
	const message = stringField(input, "message");
	const finalSummary = stringField(output, "finalSummary");
	const lines = [
		...detail(t("Message"), message && boundedPreview(message)),
		...detail(t("Mode"), background === undefined ? mode : t(background ? "Background" : "Foreground")),
		...detail(t("Status"), status || undefined),
	];
	if (background === false) lines.push(...detail(t("Result"), finalSummary && boundedPreview(finalSummary)));
	return {
		label: t(mode === "follow_up" ? "Sent subagent follow-up" : "Messaged subagent"),
		detailLines: lines,
		rawOutputIsError: false,
	};
}

function interruptAgentPresentation(result: ToolResultBlock | undefined, t: Translator): ToolTranscriptPresentation {
	const output = resultRecord(result);
	return {
		label: withName(t("Interrupted subagent"), stringField(output, "name")),
		detailLines: [
			...detail(t("Task"), stringField(output, "taskSummary")),
			...detail(t("Status"), stringField(output, "status")),
		],
		rawOutputIsError: false,
	};
}

function closeAgentPresentation(result: ToolResultBlock | undefined, t: Translator): ToolTranscriptPresentation {
	const output = resultRecord(result);
	const status = booleanField(output, "alreadyClosed") ? "already closed" : stringField(output, "status");
	return {
		label: t("Closed subagent"),
		detailLines: detail(t("Status"), status),
		rawOutputIsError: false,
	};
}

function toolSearchPresentation(
	call: ToolCallBlock | undefined,
	result: ToolResultBlock | undefined,
	t: Translator,
): ToolTranscriptPresentation {
	const input = inputRecord(call);
	const matches =
		result?.output.split("\n").flatMap((line) => {
			const separator = line.indexOf(":");
			return separator > 0 ? [line.slice(0, separator).trim()] : [];
		}) ?? [];
	const running = call?.state === "running" || call?.state === "pending";
	return {
		label: t(running ? "Searching tools" : "Searched tools"),
		detailLines: [
			...detail(t("Query"), stringField(input, "query")),
			...detail(t("Matches"), matches.length > 0 ? matches.join(", ") : undefined),
		],
		rawOutputIsError: false,
	};
}

function folderAccessPresentation(
	call: ToolCallBlock | undefined,
	result: ToolResultBlock | undefined,
	t: Translator,
): ToolTranscriptPresentation {
	const folder =
		result && !result.isError && jsonValue(result.output) === undefined && !result.output.includes("\n")
			? result.output.trim()
			: undefined;
	return {
		label: call ? toolLabel(call, t) : t("Requested folder access"),
		detailLines: detail(t("Folder"), folder),
		rawOutputIsError: false,
	};
}

function internalToolPresentation(
	name: string,
	call: ToolCallBlock | undefined,
	result: ToolResultBlock | undefined,
	t: Translator,
): ToolTranscriptPresentation {
	if (result?.isError) {
		return {
			label: internalFailureLabel(name, t),
			detailLines: detail(undefined, safeShortError(result.output)),
			rawOutputIsError: false,
		};
	}
	switch (name) {
		case "set_tasks":
			return setTasksPresentation(call, result, t);
		case "deliver_file":
			return deliverFilePresentation(call, result, t);
		case "ask_user":
			return askUserPresentation(call, result, t);
		case "activate_subagents":
			return { label: t("Activated subagents"), detailLines: [], rawOutputIsError: false };
		case "spawn_agent":
			return spawnAgentPresentation(call, result, t);
		case "inspect_agents":
			return inspectAgentsPresentation(result, t);
		case "message_agent":
			return messageAgentPresentation(call, result, t);
		case "interrupt_agent":
			return interruptAgentPresentation(result, t);
		case "close_agent":
			return closeAgentPresentation(result, t);
		case "tool_search":
			return toolSearchPresentation(call, result, t);
		default:
			return folderAccessPresentation(call, result, t);
	}
}

export function toolTranscriptPresentation(
	call: ToolCallBlock | undefined,
	result: ToolResultBlock | undefined,
	t: Translator = identity,
): ToolTranscriptPresentation {
	const name = call?.name ?? result?.name ?? "tool";
	const internal = INTERNAL_TOOL_NAMES.has(name) || /request.*(?:directory|folder)|cowork.*directory/iu.test(name);
	if (internal) {
		const presentation = internalToolPresentation(name, call, result, t);
		return result && !result.isError && name !== "activate_subagents" && presentation.detailLines.length === 0
			? { ...presentation, detailLines: [{ value: t("Details unavailable") }] }
			: presentation;
	}
	return {
		label: call ? toolLabel(call, t) : t("{{name}} result", { name }),
		detailLines: [],
		...(call?.inputPreview ? { rawInput: call.inputPreview } : {}),
		...(result ? { rawOutput: result.output } : {}),
		rawOutputIsError: result?.isError ?? false,
	};
}

export function actionSummary(calls: readonly ToolCallBlock[], t: Translator = identity): string {
	const commands = calls.filter((call) => isCommandTool(call.name));
	const others = calls.length - commands.length;
	const running = calls.some((call) => call.state === "running" || call.state === "pending");
	if (commands.length > 0 && others > 0)
		return t(running ? "Running a command, using a tool" : "Ran a command, used a tool");
	if (commands.length > 0)
		return running
			? t("Running a command")
			: commands.length === 1
				? t("Ran a command")
				: t("Ran {{count}} commands", { count: commands.length });
	if (others > 0)
		return running
			? t("Using a tool")
			: others === 1
				? t("Used a tool")
				: t("Used {{count}} tools", { count: others });
	return t("Thought process");
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
	const segments: ChatTranscriptSegment[] = [];
	let activity: (ThinkingBlock | ToolCallBlock | ToolResultBlock)[] = [];
	let activityCalls: ToolCallBlock[] = [];
	let intermediateText: TextBlock[] = [];
	const deliveredFiles: SessionDeliveredFileView[] = [];
	const flushActivity = () => {
		if (activity.length === 0) return;
		segments.push({
			type: "activity",
			blocks: activity,
			calls: activityCalls,
			running: activityCalls.some((call) => call.state === "running" || call.state === "pending"),
		});
		activity = [];
		activityCalls = [];
	};
	const flushIntermediateText = () => {
		if (intermediateText.length === 0) return;
		segments.push({ type: "intermediate", blocks: intermediateText });
		intermediateText = [];
	};

	for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
		const item = items[itemIndex]!;
		if (item.role === "user") continue;
		const thinking = item.content.filter((block): block is ThinkingBlock => block.type === "thinking");
		for (const block of item.content) {
			if (block.type === "text") {
				if (itemIndex === finalIndex || thinking.some((candidate) => isThinkingEcho(block.text, candidate.text)))
					continue;
				flushActivity();
				intermediateText.push(block);
				continue;
			}
			if (block.type === "tool_call" && block.name === "deliver_file") continue;
			if (block.type === "tool_result") {
				if (block.deliveredFile) {
					deliveredFiles.push(block.deliveredFile);
					continue;
				}
				if (block.name === "deliver_file") continue;
			}
			if (
				block.type !== "thinking" &&
				block.type !== "tool_call" &&
				(block.type !== "tool_result" || callIds.has(block.toolCallId))
			)
				continue;
			flushIntermediateText();
			activity.push(block);
			if (block.type === "tool_call") activityCalls.push(block);
		}
	}
	flushActivity();
	flushIntermediateText();
	return {
		users,
		segments,
		final: finalIndex >= 0 ? items[finalIndex] : undefined,
		results,
		deliveredFiles,
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
	const deliveredFiles: SessionDeliveredFileView[] = [];

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
		const visibleCalls = calls.filter((call) => call.name !== "deliver_file");
		const visibleOrphans = orphanResults.filter((result) => result.name !== "deliver_file" && !result.deliveredFile);
		if (visibleCalls.length === 0 && visibleOrphans.length === 0) return;
		segments.push({
			type: "tools",
			calls: visibleCalls,
			orphanResults: visibleOrphans,
			running: visibleCalls.some((call) => call.state === "running" || call.state === "pending"),
		});
		calls = [];
		orphanResults = [];
	};

	for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
		const item = items[itemIndex]!;
		if (item.role === "user") continue;
		const thinking = item.content.filter((block): block is ThinkingBlock => block.type === "thinking");
		const answer = itemIndex === finalIndex;
		const markdown = item.role === "assistant";
		for (const block of item.content) {
			if (block.type === "thinking" || block.type === "compaction") continue;
			if (block.type === "tool_call") {
				if (block.name === "deliver_file") continue;
				flushContent();
				calls.push(block);
				continue;
			}
			if (block.type === "tool_result") {
				const delivered = block.deliveredFile;
				if (delivered) {
					flushContent();
					flushTools();
					deliveredFiles.push(delivered);
					continue;
				}
				if (block.name === "deliver_file") continue;
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
		deliveredFiles,
		final: finalIndex >= 0 ? items[finalIndex] : undefined,
		finalItemId: finalIndex >= 0 ? items[finalIndex]!.itemId : undefined,
	};
}
