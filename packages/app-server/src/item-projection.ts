import { createHash } from "node:crypto";
import type {
	DurableImageRefView,
	ItemContentBlockView,
	ItemUsageView,
	ItemView,
	PlanView,
	SessionDeliveredFileView,
	SessionGoalView,
	SessionTaskView,
} from "@metis/app-protocol";
import { AskUserAnswersSchema, type PermissionDecisionView, PermissionDecisionViewSchema } from "@metis/app-protocol";
import {
	formatSessionAttachmentDisplayText,
	parseDeliverFileDetails,
	type StoredPlan,
	splitSessionAttachmentPrompt,
	type ThreadGoal,
} from "@metis/coding-agent/host";
import { Value } from "typebox/value";
import { projectCodeChanges } from "./code-change-projection.ts";

export type PermissionDecisionSource = "rule" | "model" | "user" | "full";
export type ProjectedPermissionDecision = PermissionDecisionSource | PermissionDecisionView;

/** Host-owned final authorization records only; provider content cannot supply this field. */
export function projectPermissionDecisions(
	journal: readonly unknown[],
): ReadonlyMap<string, ProjectedPermissionDecision> {
	const decisions = new Map<string, ProjectedPermissionDecision>();
	for (const entry of journal) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		if (
			record.type !== "session_permission_audit" ||
			(record.decision !== "allow" && !(record.source === "user" && record.decision === "deny")) ||
			typeof record.actionId !== "string"
		)
			continue;
		const source = record.source;
		if (source === "rule" || source === "model" || source === "user" || source === "full") {
			const detail = {
				source,
				...(source === "user"
					? {
							outcome:
								typeof record.reason === "string" && record.reason.includes("unavailable")
									? "unavailable"
									: record.decision,
							...(record.remember ? { remember: record.remember } : {}),
						}
					: {}),
				...(record.ruleIds === undefined ? {} : { ruleIds: record.ruleIds }),
				...(record.matchedRule === undefined ? {} : { matchedRule: record.matchedRule }),
				...(record.manualReason === undefined ? {} : { manualReason: record.manualReason }),
			};
			const hasDetails =
				source === "user" ||
				record.ruleIds !== undefined ||
				record.matchedRule !== undefined ||
				record.manualReason !== undefined;
			decisions.set(
				opaqueId(record.actionId, "tool"),
				hasDetails && Value.Check(PermissionDecisionViewSchema, detail) ? detail : source,
			);
		}
	}
	return decisions;
}

export const MAX_PROJECTED_THINKING_BYTES = 8 * 1024;
export const MAX_PROJECTED_VISIBLE_TEXT_BYTES = 20 * 1024;
const MAX_ITEM_BLOCKS = 16;
const MAX_ITEM_TEXT_BYTES = 16 * 1024;
const MAX_ASSISTANT_TOOL_INPUT_BYTES = 4 * 1024;

function boundedText(value: string, maximumBytes: number): string {
	if (maximumBytes <= 0) return "";
	const bytes = Buffer.from(value, "utf8");
	if (bytes.byteLength <= maximumBytes) return value;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	const suffix = maximumBytes >= 3 ? "…" : "";
	let end = maximumBytes - Buffer.byteLength(suffix, "utf8");
	while (end > 0) {
		try {
			return `${decoder.decode(bytes.subarray(0, end))}${suffix}`;
		} catch {
			end -= 1;
		}
	}
	return suffix;
}

export function textPrefixWithinBytes(value: string, maximumBytes: number): string {
	if (maximumBytes <= 0) return "";
	const bytes = Buffer.from(value, "utf8");
	if (bytes.byteLength <= maximumBytes) return value;
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let end = maximumBytes;
	while (end > 0) {
		try {
			return decoder.decode(bytes.subarray(0, end));
		} catch {
			end -= 1;
		}
	}
	return "";
}

export function opaqueId(value: unknown, namespace: string): string {
	if (typeof value === "string" && value.length <= 128 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) {
		return value;
	}
	return `${namespace}:${createHash("sha256").update(String(value)).digest("hex")}`;
}

export function timestamp(value: unknown, fallback: string): string {
	return typeof value === "string" &&
		value.length <= 40 &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
		Number.isFinite(Date.parse(value))
		? value
		: fallback;
}

function projectedName(value: unknown, fallback: string): string {
	if (typeof value !== "string") return fallback;
	const normalized = value
		.replace(/[\r\n]+/g, " ")
		.trim()
		.slice(0, 256);
	return normalized.length > 0 ? normalized : fallback;
}

function durableImage(value: Record<string, unknown>): DurableImageRefView | undefined {
	const mediaType = value.mimeType;
	if (
		value.type !== "image_ref" ||
		typeof value.hash !== "string" ||
		!/^[a-f0-9]{64}$/.test(value.hash) ||
		(mediaType !== "image/jpeg" &&
			mediaType !== "image/png" &&
			mediaType !== "image/gif" &&
			mediaType !== "image/webp") ||
		typeof value.size !== "number" ||
		!Number.isSafeInteger(value.size) ||
		value.size < 1 ||
		value.size > 32 * 1024 * 1024
	) {
		return undefined;
	}
	return { hash: value.hash, mediaType, byteLength: value.size };
}

interface TextBudget {
	remaining: number;
}

function takeText(value: string, budget: TextBudget): string | undefined {
	if (budget.remaining <= 0) return undefined;
	const text = boundedText(value, budget.remaining);
	budget.remaining = Math.max(0, budget.remaining - Buffer.byteLength(text, "utf8"));
	return text;
}

function textBlocks(content: unknown, budget: TextBudget): ItemContentBlockView[] {
	if (typeof content === "string") {
		const text = takeText(content, budget);
		return text === undefined ? [] : [{ type: "text", text }];
	}
	if (!Array.isArray(content)) return [];
	const blocks: ItemContentBlockView[] = [];
	for (const candidate of content.slice(0, 256)) {
		if (blocks.length >= MAX_ITEM_BLOCKS) break;
		if (typeof candidate !== "object" || candidate === null) continue;
		const block = candidate as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") {
			const text = takeText(block.text, budget);
			if (text !== undefined) blocks.push({ type: "text", text });
			continue;
		}
		const image = durableImage(block);
		if (image) blocks.push({ type: "image", image });
	}
	return blocks;
}

function assistantBlocks(
	content: unknown,
	budgets: { readonly text: TextBudget; readonly thinking: TextBudget; readonly tool: TextBudget },
	toolStates: ReadonlyMap<string, "active" | "completed" | "interrupted">,
	permissionDecisions?: ReadonlyMap<string, ProjectedPermissionDecision>,
): ItemContentBlockView[] {
	if (typeof content === "string") return textBlocks(content, budgets.text);
	if (!Array.isArray(content)) return [];
	const blocks: ItemContentBlockView[] = [];
	for (const candidate of content.slice(0, 256)) {
		if (blocks.length >= MAX_ITEM_BLOCKS) break;
		if (typeof candidate !== "object" || candidate === null) continue;
		const block = candidate as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") {
			const text = takeText(block.text, budgets.text);
			if (text !== undefined) blocks.push({ type: "text", text });
			continue;
		}
		if (block.type === "thinking" && block.redacted !== true && typeof block.thinking === "string") {
			const text = takeText(block.thinking, budgets.thinking);
			if (text) blocks.push({ type: "thinking", text });
			continue;
		}
		const image = durableImage(block);
		if (image) {
			blocks.push({ type: "image", image });
			continue;
		}
		if (block.type !== "toolCall") continue;
		if (block.name === "submit_plan") continue;
		const toolCallId = opaqueId(block.id, "tool");
		const toolState = toolStates.get(toolCallId) ?? "completed";
		let inputPreview: string | undefined;
		try {
			if (block.arguments !== undefined) {
				const serialized = JSON.stringify(block.arguments);
				if (serialized !== undefined) inputPreview = takeText(serialized, budgets.tool);
			}
		} catch {
			// Omit non-JSON tool details.
		}
		blocks.push({
			type: "tool_call",
			toolCallId,
			name: projectedName(block.name, "tool"),
			state: toolState === "active" ? "running" : toolState,
			...(inputPreview === undefined ? {} : { inputPreview }),
			...(permissionDecisions?.has(toolCallId)
				? {
						permissionDecision:
							typeof permissionDecisions.get(toolCallId) === "string"
								? { source: permissionDecisions.get(toolCallId) as PermissionDecisionSource }
								: (permissionDecisions.get(toolCallId) as PermissionDecisionView),
					}
				: {}),
		});
	}
	return blocks;
}

function userContent(
	content: unknown,
	budget: TextBudget,
): Pick<ItemView, "content" | "attachments" | "fileSelections" | "conversationQuotes"> {
	const attachments: NonNullable<ItemView["attachments"]> = [];
	const fileSelections: NonNullable<ItemView["fileSelections"]> = [];
	const conversationQuotes: NonNullable<ItemView["conversationQuotes"]> = [];
	const publicText = (text: string): string => {
		const prompt = splitSessionAttachmentPrompt(text);
		for (const attachment of prompt.attachments) {
			if (attachments.length >= 16) break;
			if (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > 128 * 1024 * 1024)
				continue;
			attachments.push({ name: attachment.name.slice(0, 255), byteLength: attachment.size });
		}
		for (const file of prompt.fileSelections) {
			if (fileSelections.length >= 8) break;
			const selectedText = boundedText(file.selectedText, 2048);
			const target = file.target;
			fileSelections.push({
				name: file.name,
				source: file.source,
				selectedText,
				...(selectedText === file.selectedText ? {} : { selectedTextTruncated: true }),
				...(file.startLine === undefined ? {} : { startLine: file.startLine, endLine: file.endLine }),
				...(target === undefined
					? {}
					: {
							target:
								target.kind === "pptx"
									? { kind: target.kind, page: target.page, objectName: target.objectName }
									: target.kind === "pdf"
										? {
												kind: target.kind,
												page: target.page,
												...(target.endPage === undefined ? {} : { endPage: target.endPage }),
											}
										: { kind: target.kind, sheet: target.sheet, range: target.range },
						}),
			});
		}
		for (const quote of prompt.conversationQuotes ?? []) {
			if (conversationQuotes.length >= 8) break;
			const selectedText = boundedText(quote.selectedText, 2048);
			conversationQuotes.push({
				sourceItemId: quote.sourceItemId,
				sourceRole: quote.sourceRole,
				selectedText,
				...(selectedText === quote.selectedText ? {} : { selectedTextTruncated: true }),
			});
		}
		// Keep editor display formatting while projecting uploads and quotes separately.
		return formatSessionAttachmentDisplayText(prompt.text);
	};
	const sanitized =
		typeof content === "string"
			? publicText(content)
			: Array.isArray(content)
				? content.slice(0, 256).map((candidate) => {
						if (typeof candidate !== "object" || candidate === null) return candidate;
						const block = candidate as Record<string, unknown>;
						return block.type === "text" && typeof block.text === "string"
							? { ...block, text: publicText(block.text) }
							: candidate;
					})
				: [];
	return {
		content: textBlocks(sanitized, budget).filter((block) => block.type !== "text" || block.text.trim() !== ""),
		...(attachments.length > 0 ? { attachments } : {}),
		...(fileSelections.length > 0 ? { fileSelections } : {}),
		...(conversationQuotes.length > 0 ? { conversationQuotes } : {}),
	};
}

export interface MessageProjectionInput {
	readonly entry: Record<string, unknown>;
	readonly sessionId: string;
	readonly turnStates: ReadonlyMap<string, "active" | "completed" | "interrupted">;
	readonly toolStates: ReadonlyMap<string, "active" | "completed" | "interrupted">;
	readonly permissionDecisions?: ReadonlyMap<string, ProjectedPermissionDecision>;
	readonly deliveredFiles?: ReadonlyMap<string, SessionDeliveredFileView>;
	readonly fallbackTimestamp: string;
}

export function projectAssistantOutputTokens(message: object): number | undefined {
	const record = message as Record<string, unknown>;
	if (record.role !== "assistant" || typeof record.usage !== "object" || record.usage === null) return undefined;
	const output = (record.usage as Record<string, unknown>).output;
	return Number.isSafeInteger(output) && Number(output) >= 0 ? Number(output) : undefined;
}

/** Full assistant usage projection; only non-negative safe integers are carried onto the wire. */
export function projectAssistantUsage(message: object): ItemUsageView | undefined {
	const outputTokens = projectAssistantOutputTokens(message);
	if (outputTokens === undefined) return undefined;
	const record = (message as Record<string, unknown>).usage as Record<string, unknown> | undefined;
	const positive = (value: unknown): number | undefined =>
		Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
	const inputTokens = positive(record?.input);
	const cacheReadTokens = positive(record?.cacheRead);
	const cacheWriteTokens = positive(record?.cacheWrite);
	if (inputTokens === undefined && cacheReadTokens === undefined && cacheWriteTokens === undefined) {
		return { outputTokens };
	}
	return {
		outputTokens,
		...(inputTokens === undefined ? {} : { inputTokens }),
		...(cacheReadTokens === undefined ? {} : { cacheReadTokens }),
		...(cacheWriteTokens === undefined ? {} : { cacheWriteTokens }),
	};
}

export function projectTasksFromToolResult(message: unknown): SessionTaskView[] | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const record = message as Record<string, unknown>;
	if (record.role !== "toolResult" || record.toolName !== "set_tasks" || record.isError !== false) return undefined;
	if (typeof record.details !== "object" || record.details === null) return undefined;
	const tasks = (record.details as Record<string, unknown>).tasks;
	if (!Array.isArray(tasks) || tasks.length > 256) return undefined;
	const projected: SessionTaskView[] = [];
	for (const candidate of tasks) {
		if (typeof candidate !== "object" || candidate === null) return undefined;
		const item = candidate as Record<string, unknown>;
		if (
			typeof item.task !== "string" ||
			item.task.trim().length < 1 ||
			item.task.length > 512 ||
			typeof item.completed !== "boolean"
		) {
			return undefined;
		}
		projected.push({ task: item.task.trim(), completed: item.completed });
	}
	return projected;
}

export function projectGoal(goal: ThreadGoal | null): SessionGoalView | null {
	if (!goal) return null;
	return {
		goalId: goal.goalId,
		objective: goal.objective,
		status: goal.status,
		timeUsedSeconds: goal.timeUsedSeconds,
		activeStartedAt: goal.activeStartedAt === null ? null : new Date(goal.activeStartedAt).toISOString(),
	};
}

export function projectLatestTasks(entries: readonly unknown[]): SessionTaskView[] {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		if (record.type !== "message") continue;
		const tasks = projectTasksFromToolResult(record.message);
		if (tasks !== undefined) return tasks;
	}
	return [];
}

export function projectDeliveredFileFromToolResult(
	message: unknown,
	deliveredFiles: ReadonlyMap<string, SessionDeliveredFileView> = new Map(),
): SessionDeliveredFileView | undefined {
	if (typeof message !== "object" || message === null) return undefined;
	const record = message as Record<string, unknown>;
	if (record.role !== "toolResult" || record.toolName !== "deliver_file" || record.isError !== false) {
		return undefined;
	}
	const details = parseDeliverFileDetails(record.details);
	if (!details) return undefined;
	const current = deliveredFiles.get(details.fileId);
	return {
		...details,
		byteLength: current?.byteLength ?? details.byteLength,
		availability: current?.availability ?? "unavailable",
	};
}

export function projectPlanView(plan: StoredPlan): PlanView {
	return {
		planId: opaqueId(plan.planId, "plan"),
		revision: plan.revision,
		title: plan.title,
		markdown: plan.markdown,
		status: plan.status,
		createdAt: plan.createdAt,
	};
}

export interface PlanProposalProjectionEntry {
	readonly id: string;
	readonly timestamp: string;
}

export function projectPlanEntry(input: {
	readonly entry: PlanProposalProjectionEntry;
	readonly plan: StoredPlan;
	readonly sessionId: string;
	readonly fallbackTimestamp: string;
}): ItemView {
	const createdAt = timestamp(input.entry.timestamp, input.fallbackTimestamp);
	return {
		itemId: opaqueId(input.entry.id, "item"),
		sessionId: input.sessionId,
		role: "assistant",
		state: "completed",
		content: [{ type: "plan", plan: projectPlanView(input.plan) }],
		createdAt,
		completedAt: createdAt,
	};
}

function hasScheduledRetry(message: Record<string, unknown>): boolean {
	return (
		Array.isArray(message.diagnostics) &&
		message.diagnostics.some((diagnostic) => {
			if (typeof diagnostic !== "object" || diagnostic === null || diagnostic.type !== "auto_retry_scheduled")
				return false;
			const details = diagnostic.details;
			return (
				typeof details === "object" &&
				details !== null &&
				Number.isSafeInteger(details.attempt) &&
				Number.isSafeInteger(details.maxAttempts) &&
				details.attempt > 0 &&
				details.attempt <= details.maxAttempts
			);
		})
	);
}

export function projectMessageEntry(input: MessageProjectionInput): ItemView | undefined {
	const { entry, sessionId, turnStates, toolStates, deliveredFiles, fallbackTimestamp } = input;
	if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return undefined;
	const message = entry.message as Record<string, unknown>;
	const itemId = opaqueId(entry.id, "item");
	const turnId = entry.turnId === undefined ? undefined : opaqueId(entry.turnId, "turn");
	const turnState = turnId === undefined ? undefined : turnStates.get(turnId);
	const createdAt = timestamp(entry.timestamp, fallbackTimestamp);
	const state = turnState === "active" ? "streaming" : turnState === "interrupted" ? "interrupted" : "completed";

	if (message.role === "user") {
		const budget = { remaining: MAX_ITEM_TEXT_BYTES };
		return {
			itemId,
			sessionId,
			...(turnId === undefined ? {} : { turnId }),
			role: "user",
			state,
			...userContent(message.content, budget),
			createdAt,
			...(state === "streaming" ? {} : { completedAt: createdAt }),
		};
	}

	if (message.role === "toolResult" && message.toolName === "submit_plan") return undefined;

	if (message.role === "assistant") {
		const failed = message.stopReason === "error";
		const retryScheduled = failed && hasScheduledRetry(message);
		const assistantState = failed ? "interrupted" : state;
		const usage = projectAssistantUsage(message);
		const content = assistantBlocks(
			message.content,
			{
				text: { remaining: MAX_PROJECTED_VISIBLE_TEXT_BYTES },
				thinking: { remaining: MAX_PROJECTED_THINKING_BYTES },
				tool: { remaining: MAX_ASSISTANT_TOOL_INPUT_BYTES },
			},
			toolStates,
			input.permissionDecisions,
		);
		// Persist a visible failure even when the provider produced no output. Raw
		// diagnostics can contain credentials and endpoint URLs, so never project them.
		if (failed && !retryScheduled) {
			content.push({
				type: "notice",
				level: "error",
				text: "The model provider could not complete the request. Try again or choose another configured model.",
			});
		}
		if (content.length === 0 && assistantState !== "streaming" && !retryScheduled) return undefined;
		return {
			itemId,
			sessionId,
			...(turnId === undefined ? {} : { turnId }),
			role: "assistant",
			state: assistantState,
			content,
			...(usage === undefined ? {} : { usage }),
			createdAt,
			...(assistantState === "streaming" ? {} : { completedAt: createdAt }),
		};
	}

	if (message.role === "toolResult") {
		const codeChanges = projectCodeChanges(message.details);
		const tasks = projectTasksFromToolResult(message);
		const details =
			typeof message.details === "object" && message.details !== null
				? (message.details as Record<string, unknown>)
				: undefined;
		const userAnswers =
			message.toolName === "ask_user" &&
			message.isError === false &&
			details?.cancelled === false &&
			Value.Check(AskUserAnswersSchema, details.answers)
				? details.answers
				: undefined;
		const budget = { remaining: MAX_ITEM_TEXT_BYTES };
		const blocks = textBlocks(message.content, budget);
		const output = blocks
			.filter((block): block is Extract<ItemContentBlockView, { type: "text" }> => block.type === "text")
			.map((block) => block.text)
			.join("\n");
		const images = blocks
			.filter((block): block is Extract<ItemContentBlockView, { type: "image" }> => block.type === "image")
			.map((block) => block.image)
			.slice(0, 4);
		const deliveredFile =
			message.toolName === "deliver_file" && message.isError !== true
				? projectDeliveredFileFromToolResult(message, deliveredFiles)
				: undefined;
		return {
			itemId,
			sessionId,
			...(turnId === undefined ? {} : { turnId }),
			role: "tool",
			state,
			content: [
				{
					type: "tool_result",
					toolCallId: opaqueId(message.toolCallId, "tool"),
					name: projectedName(message.toolName, "tool"),
					isError: message.isError === true,
					output: boundedText(output, MAX_ITEM_TEXT_BYTES),
					...(images.length > 0 ? { images } : {}),
					...(deliveredFile ? { deliveredFile } : {}),
					...(codeChanges ? { codeChanges } : {}),
					...(tasks === undefined ? {} : { tasks }),
					...(userAnswers === undefined ? {} : { userAnswers }),
				},
			],
			createdAt,
			...(state === "streaming" ? {} : { completedAt: createdAt }),
		};
	}
}

export function projectSessionEntry(input: MessageProjectionInput): ItemView | undefined {
	const message = projectMessageEntry(input);
	if (message) return message;
	if (input.entry.type !== "compaction") return undefined;

	const createdAt = timestamp(input.entry.timestamp, input.fallbackTimestamp);
	return {
		itemId: opaqueId(input.entry.id, "item"),
		sessionId: input.sessionId,
		role: "system",
		state: "completed",
		content: [{ type: "compaction" }],
		createdAt,
		completedAt: createdAt,
	};
}

export function projectLiveMessage(input: {
	readonly itemId: string;
	readonly sessionId: string;
	readonly turnId?: string;
	readonly message: object;
	readonly state: ItemView["state"];
	readonly permissionDecisions?: ReadonlyMap<string, ProjectedPermissionDecision>;
	readonly deliveredFiles?: ReadonlyMap<string, SessionDeliveredFileView>;
	readonly fallbackTimestamp: string;
}): ItemView | undefined {
	const record = input.message as Record<string, unknown>;
	const createdAt =
		typeof record.timestamp === "number" && Number.isFinite(record.timestamp)
			? new Date(record.timestamp).toISOString()
			: input.fallbackTimestamp;
	const item = projectMessageEntry({
		entry: {
			type: "message",
			id: input.itemId,
			...(input.turnId === undefined ? {} : { turnId: input.turnId }),
			timestamp: createdAt,
			// A start event is provisional, even if a provider filled its error
			// fields early. Decide final failure visibility only at message_end.
			message:
				input.state === "streaming" && record.role === "assistant" && record.stopReason === "error"
					? { ...input.message, stopReason: "stop" }
					: input.message,
		},
		sessionId: input.sessionId,
		turnStates:
			input.turnId === undefined
				? new Map()
				: new Map([
						[
							input.turnId,
							input.state === "streaming"
								? "active"
								: input.state === "interrupted"
									? "interrupted"
									: "completed",
						] as const,
					]),
		toolStates: new Map(),
		permissionDecisions: input.permissionDecisions,
		deliveredFiles: input.deliveredFiles,
		fallbackTimestamp: createdAt,
	});
	const state =
		input.state !== "streaming" && record.role === "assistant" && record.stopReason === "error"
			? "interrupted"
			: input.state;
	return item
		? {
				...item,
				state,
				...(state === "streaming" ? {} : { completedAt: createdAt }),
			}
		: undefined;
}

export function appendProjectedDelta(
	item: ItemView,
	delta: { readonly type: "text" | "thinking"; readonly text: string; readonly outputTokens?: number },
):
	| {
			readonly item: ItemView;
			readonly delta: {
				readonly type: "text" | "thinking";
				readonly text: string;
				readonly outputTokens?: number;
			};
	  }
	| undefined {
	const maximum = delta.type === "thinking" ? MAX_PROJECTED_THINKING_BYTES : MAX_PROJECTED_VISIBLE_TEXT_BYTES;
	const used = item.content.reduce(
		(total, block) => total + (block.type === delta.type ? Buffer.byteLength(block.text, "utf8") : 0),
		0,
	);
	const accepted = textPrefixWithinBytes(delta.text, maximum - used);
	if (!accepted) return undefined;
	const content = [...item.content];
	const last = content.at(-1);
	if (last?.type === delta.type) content[content.length - 1] = { ...last, text: last.text + accepted };
	else content.push({ type: delta.type, text: accepted });
	const usage = delta.outputTokens === undefined ? item.usage : { ...item.usage, outputTokens: delta.outputTokens };
	return {
		item: { ...item, content, ...(usage === undefined ? {} : { usage }) },
		delta: { ...delta, text: accepted },
	};
}
