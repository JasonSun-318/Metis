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
	"spawn_agent",
	"inspect_agents",
	"send_message",
	"followup_task",
	"wait_agents",
	"interrupt_agent",
	"memory_search",
]);
const PREVIEW_LINES = 10;
const PREVIEW_CHARS = 2_000;

export type CodeTranscriptSegment =
	| { readonly type: "system"; readonly item: ItemView }
	| {
			readonly type: "user";
			readonly item: ItemView;
	  }
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
	| { readonly type: "system"; readonly item: ItemView }
	| {
			readonly type: "notice";
			readonly block: Extract<ItemContentBlockView, { type: "notice" }>;
			readonly itemId: string;
	  }
	| {
			readonly type: "user";
			readonly item: ItemView;
	  }
	| {
			readonly type: "activity";
			readonly blocks: readonly (TextBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock)[];
			readonly calls: readonly ToolCallBlock[];
			readonly running: boolean;
	  }
	| {
			readonly type: "intermediate";
			readonly blocks: readonly TextBlock[];
	  }
	| {
			readonly type: "answer";
			readonly item: ItemView;
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

/** Mailbox events stay in history/model context, but are not conversation messages. */
export function isInternalAgentCoordinationItem(item: ItemView): boolean {
	return item.role === "system" && item.origin?.kind === "system" && Boolean(item.agentTargetId);
}

/** Visible markdown/plain text of a message, concatenated in block order. */
export function messageText(item: ItemView): string {
	const text = textBlocks(item)
		.map((block) => block.text)
		.join("\n");
	if (item.role !== "user" || !item.fileSelections?.length) return text;
	const references = item.fileSelections
		.map((file) => `[${file.name}${file.startLine === undefined ? "" : `:${file.startLine}–${file.endLine}`}]`)
		.join(" ");
	return [text, references].filter(Boolean).join("\n\n");
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
		if (item.role !== "assistant" || item.state === "interrupted" || toolCalls(item).length > 0) continue;
		const thinking = item.content.filter((block): block is ThinkingBlock => block.type === "thinking");
		if (
			textBlocks(item).some(
				(block) =>
					block.text.trim().length > 0 &&
					!thinking.some((candidate) => isThinkingEcho(block.text, candidate.text)),
			)
		)
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
		case "spawn_agent":
			return t("Failed to spawn agent");
		case "inspect_agents":
			return t("Failed to inspect agents");
		case "send_message":
			return t("Failed to message agent");
		case "followup_task":
			return t("Failed to send agent follow-up");
		case "wait_agents":
			return t("Failed to wait for agents");
		case "interrupt_agent":
			return t("Failed to interrupt agent");
		case "tool_search":
			return t("Tool search failed");
		case "memory_search":
			return t("Memory search failed");
		default:
			return t("Folder access failed");
	}
}

export function tasksFromTool(call: ToolCallBlock | undefined, result: ToolResultBlock | undefined) {
	if (result?.tasks) return result.tasks;
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
	return resultTasks.length > 0 ? resultTasks : inputTasks;
}

function setTasksPresentation(
	call: ToolCallBlock | undefined,
	result: ToolResultBlock | undefined,
	t: Translator,
): ToolTranscriptPresentation {
	const tasks = tasksFromTool(call, result);
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

export function askAnswers(result: ToolResultBlock | undefined): AskAnswer[] {
	if (result?.userAnswers)
		return result.userAnswers.map((answer) => ({
			question: answer.question,
			answer: [...answer.selected, ...(answer.customAnswer ? [answer.customAnswer] : [])].join(" · "),
		}));
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

function agentName(
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
	const name = agentName(input, output);
	const status = stringField(output, "status");
	const task = stringField(input, "task");
	const lines = [...detail(t("Task"), task && boundedPreview(task)), ...detail(t("Status"), status)];
	return {
		label: withName(t("Spawned agent"), name),
		detailLines: lines,
		rawOutputIsError: false,
	};
}

function inspectAgentsPresentation(result: ToolResultBlock | undefined, t: Translator): ToolTranscriptPresentation {
	const lines: ToolDetailLine[] = [];
	let count = 0;
	for (const line of result?.output.split("\n") ?? []) {
		if (/^Agent ".+" \(.+\) ·/u.test(line)) {
			count += 1;
			lines.push({ value: boundedPreview(line) });
			continue;
		}
		if (!line.trim() || /^Agent .+ \(.+\)$/u.test(line)) continue;
		if (/^(?:Task |\[(?:LLM|Final)\]|\[Tool(?: [^\]]+)?\])/u.test(line)) {
			lines.push({ value: boundedPreview(line) });
		} else if (line === "No agent sessions.") lines.push({ value: line });
	}
	return {
		label: count > 0 ? t("Inspected {{count}} agents", { count }) : t("Inspected agents"),
		detailLines: lines.slice(0, PREVIEW_LINES),
		rawOutputIsError: false,
	};
}

function sendMessagePresentation(
	call: ToolCallBlock | undefined,
	result: ToolResultBlock | undefined,
	t: Translator,
): ToolTranscriptPresentation {
	const input = inputRecord(call);
	const output = resultRecord(result);
	const message = stringField(input, "message");
	const status = stringField(output, "delivery");
	const lines = [
		...detail(t("Message"), message && boundedPreview(message)),
		...detail(t("Status"), status || undefined),
	];
	return {
		label: t("Messaged agent"),
		detailLines: lines,
		rawOutputIsError: false,
	};
}

function followupTaskPresentation(
	call: ToolCallBlock | undefined,
	result: ToolResultBlock | undefined,
	t: Translator,
): ToolTranscriptPresentation {
	const input = inputRecord(call);
	const output = resultRecord(result);
	const task = stringField(input, "task");
	const status = stringField(output, "status");
	const lines = [...detail(t("Task"), task && boundedPreview(task)), ...detail(t("Status"), status || undefined)];
	return {
		label: t("Sent agent follow-up"),
		detailLines: lines,
		rawOutputIsError: false,
	};
}

function waitAgentsPresentation(result: ToolResultBlock | undefined, t: Translator): ToolTranscriptPresentation {
	const lines: ToolDetailLine[] = [];
	for (const line of result?.output.split("\n") ?? []) {
		if (!line.trim()) continue;
		lines.push({ value: boundedPreview(line) });
	}
	return {
		label: t("Waited for agents"),
		detailLines: lines.slice(0, PREVIEW_LINES),
		rawOutputIsError: false,
	};
}

function interruptAgentPresentation(result: ToolResultBlock | undefined, t: Translator): ToolTranscriptPresentation {
	const output = resultRecord(result);
	const task = stringField(output, "taskSummary") ?? stringField(record(output?.latestTask), "taskSummary");
	return {
		label: withName(t("Interrupted agent"), stringField(output, "name")),
		detailLines: [...detail(t("Task"), task), ...detail(t("Status"), stringField(output, "status"))],
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

function memorySearchPresentation(
	call: ToolCallBlock | undefined,
	result: ToolResultBlock | undefined,
	t: Translator,
): ToolTranscriptPresentation {
	const input = inputRecord(call);
	const hits =
		result?.output.split("\n").flatMap((line) => {
			const trimmed = line.trim();
			return trimmed.startsWith("- [") ? [trimmed] : [];
		}) ?? [];
	const running = call?.state === "running" || call?.state === "pending";
	const label = running
		? t("Searching memory")
		: hits.length > 0
			? t("Recalled {{count}} memory notes", { count: hits.length })
			: t("Searched memory");
	return {
		label,
		detailLines: [
			...detail(t("Query"), stringField(input, "query")),
			...hits.slice(0, PREVIEW_LINES).map((hit) => ({ value: hit })),
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
		case "spawn_agent":
			return spawnAgentPresentation(call, result, t);
		case "inspect_agents":
			return inspectAgentsPresentation(result, t);
		case "send_message":
			return sendMessagePresentation(call, result, t);
		case "followup_task":
			return followupTaskPresentation(call, result, t);
		case "wait_agents":
			return waitAgentsPresentation(result, t);
		case "interrupt_agent":
			return interruptAgentPresentation(result, t);
		case "tool_search":
			return toolSearchPresentation(call, result, t);
		case "memory_search":
			return memorySearchPresentation(call, result, t);
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
		return result && !result.isError && presentation.detailLines.length === 0
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

export function buildTurnPresentation(sourceItems: readonly ItemView[]): TurnPresentation {
	const items = sourceItems.filter((item) => !isInternalAgentCoordinationItem(item));
	const finalIndex = finalResponseIndex(items);
	const users = items.filter((item) => item.role === "user");
	const calls = items.filter((item) => item.role !== "user").flatMap(toolCalls);
	const taskAnchor = calls.find((call) => call.name === "set_tasks");
	const callIds = new Set(calls.map((call) => call.toolCallId));
	const results = new Map<string, ToolResultBlock>();
	for (const item of items) {
		for (const block of item.content) {
			if (block.type === "tool_result") results.set(block.toolCallId, block);
		}
	}
	const segments: ChatTranscriptSegment[] = [];
	let phase: (TextBlock | ThinkingBlock | ToolCallBlock | ToolResultBlock)[] = [];
	let phaseCalls: ToolCallBlock[] = [];
	let phaseHasActivity = false;
	const deliveredFiles: SessionDeliveredFileView[] = [];
	const flushPhase = () => {
		if (phase.length === 0) return;
		if (phaseHasActivity) {
			segments.push({
				type: "activity",
				blocks: phase,
				calls: phaseCalls,
				running: phaseCalls.some((call) => call.state === "running" || call.state === "pending"),
			});
		} else {
			segments.push({ type: "intermediate", blocks: phase as TextBlock[] });
		}
		phase = [];
		phaseCalls = [];
		phaseHasActivity = false;
	};

	for (let itemIndex = 0; itemIndex < items.length; itemIndex += 1) {
		const item = items[itemIndex]!;
		if (item.role === "system" && item.origin?.kind === "system") {
			flushPhase();
			segments.push({ type: "system", item });
			continue;
		}
		if (item.role === "user") {
			flushPhase();
			segments.push({ type: "user", item });
			continue;
		}
		const thinking = item.content.filter((block): block is ThinkingBlock => block.type === "thinking");
		for (const block of item.content) {
			if (block.type === "notice") {
				if (itemIndex !== finalIndex) {
					flushPhase();
					segments.push({ type: "notice", block, itemId: item.itemId });
				}
				continue;
			}
			if (block.type === "text") {
				if (
					!block.text.trim() ||
					itemIndex === finalIndex ||
					thinking.some((candidate) => isThinkingEcho(block.text, candidate.text))
				)
					continue;
				if (phaseHasActivity) flushPhase();
				phase.push(block);
				continue;
			}
			if (block.type === "tool_result") {
				if (block.deliveredFile) {
					deliveredFiles.push(block.deliveredFile);
					continue;
				}
			}
			if (
				block.type !== "thinking" &&
				block.type !== "tool_call" &&
				(block.type !== "tool_result" || callIds.has(block.toolCallId))
			)
				continue;
			const card = block.type === "tool_call" && (block.name === "ask_user" || block === taskAnchor);
			if (card || !phaseHasActivity) flushPhase();
			phase.push(block);
			phaseHasActivity = true;
			if (block.type === "tool_call") phaseCalls.push(block);
			if (card) flushPhase();
		}
		if (itemIndex === finalIndex) {
			flushPhase();
			segments.push({ type: "answer", item });
		}
	}
	flushPhase();
	return {
		users,
		segments,
		final: finalIndex >= 0 ? items[finalIndex] : undefined,
		results,
		deliveredFiles,
	};
}

export function buildCodeTurnPresentation(sourceItems: readonly ItemView[]): CodeTurnPresentation {
	const items = sourceItems.filter((item) => !isInternalAgentCoordinationItem(item));
	const finalIndex = finalResponseIndex(items);
	const results = new Map<string, ToolResultBlock>();
	for (const item of items) {
		for (const block of item.content) {
			if (block.type === "tool_result") results.set(block.toolCallId, block);
		}
	}

	const segments: CodeTranscriptSegment[] = [];
	const callIds = new Set(items.flatMap((item) => toolCalls(item).map((call) => call.toolCallId)));
	const taskAnchor = items.flatMap(toolCalls).find((call) => call.name === "set_tasks");
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
		if (item.role === "system" && item.origin?.kind === "system") {
			flushContent();
			flushTools();
			segments.push({ type: "system", item });
			continue;
		}
		if (item.role === "user") {
			flushContent();
			flushTools();
			segments.push({ type: "user", item });
			continue;
		}
		const thinking = item.content.filter((block): block is ThinkingBlock => block.type === "thinking");
		const hasToolCall = toolCalls(item).length > 0;
		const answer = itemIndex === finalIndex;
		const markdown = item.role === "assistant";
		for (const block of item.content) {
			if (block.type === "thinking" || block.type === "compaction" || block.type === "plan") continue;
			if (block.type === "text" && hasToolCall) continue;
			if (block.type === "tool_call") {
				flushContent();
				const card = block.name === "ask_user" || block === taskAnchor || block.name === "deliver_file";
				if (card) flushTools();
				calls.push(block);
				if (card) flushTools();
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
				flushContent();
				if (!callIds.has(block.toolCallId)) orphanResults.push(block);
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
