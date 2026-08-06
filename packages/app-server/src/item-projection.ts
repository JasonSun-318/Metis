import { createHash } from "node:crypto";
import type { DurableImageRefView, ItemContentBlockView, ItemView } from "@arcmind/app-protocol";
import { formatSessionAttachmentDisplayText } from "@arcmind/coding-agent";

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
		});
	}
	return blocks;
}

function userBlocks(content: unknown, budget: TextBudget): ItemContentBlockView[] {
	if (typeof content === "string") return textBlocks(formatSessionAttachmentDisplayText(content), budget);
	if (!Array.isArray(content)) return [];
	return textBlocks(
		content.map((candidate) =>
			typeof candidate === "object" &&
			candidate !== null &&
			(candidate as Record<string, unknown>).type === "text" &&
			typeof (candidate as Record<string, unknown>).text === "string"
				? {
						...candidate,
						text: formatSessionAttachmentDisplayText((candidate as Record<string, unknown>).text as string),
					}
				: candidate,
		),
		budget,
	);
}

export interface MessageProjectionInput {
	readonly entry: Record<string, unknown>;
	readonly sessionId: string;
	readonly turnStates: ReadonlyMap<string, "active" | "completed" | "interrupted">;
	readonly toolStates: ReadonlyMap<string, "active" | "completed" | "interrupted">;
	readonly fallbackTimestamp: string;
}

export function projectMessageEntry(input: MessageProjectionInput): ItemView | undefined {
	const { entry, sessionId, turnStates, toolStates, fallbackTimestamp } = input;
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
			content: userBlocks(message.content, budget),
			createdAt,
			...(state === "streaming" ? {} : { completedAt: createdAt }),
		};
	}

	if (message.role === "assistant") {
		const content = assistantBlocks(
			message.content,
			{
				text: { remaining: MAX_PROJECTED_VISIBLE_TEXT_BYTES },
				thinking: { remaining: MAX_PROJECTED_THINKING_BYTES },
				tool: { remaining: MAX_ASSISTANT_TOOL_INPUT_BYTES },
			},
			toolStates,
		);
		return {
			itemId,
			sessionId,
			...(turnId === undefined ? {} : { turnId }),
			role: "assistant",
			state,
			content,
			createdAt,
			...(state === "streaming" ? {} : { completedAt: createdAt }),
		};
	}

	if (message.role === "toolResult") {
		const budget = { remaining: MAX_ITEM_TEXT_BYTES };
		const output = textBlocks(message.content, budget)
			.filter((block): block is Extract<ItemContentBlockView, { type: "text" }> => block.type === "text")
			.map((block) => block.text)
			.join("\n");
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
				},
			],
			createdAt,
			...(state === "streaming" ? {} : { completedAt: createdAt }),
		};
	}
}

export function projectLiveMessage(input: {
	readonly itemId: string;
	readonly sessionId: string;
	readonly turnId?: string;
	readonly message: object;
	readonly state: ItemView["state"];
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
			message: input.message,
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
		fallbackTimestamp: createdAt,
	});
	return item
		? {
				...item,
				state: input.state,
				...(input.state === "streaming" ? {} : { completedAt: createdAt }),
			}
		: undefined;
}

export function appendProjectedDelta(
	item: ItemView,
	delta: { readonly type: "text" | "thinking"; readonly text: string },
):
	| { readonly item: ItemView; readonly delta: { readonly type: "text" | "thinking"; readonly text: string } }
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
	return { item: { ...item, content }, delta: { type: delta.type, text: accepted } };
}
