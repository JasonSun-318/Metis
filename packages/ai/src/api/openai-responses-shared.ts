import type OpenAI from "openai";
import type {
	Tool as OpenAITool,
	ResponseCreateParamsStreaming,
	ResponseFunctionCallOutputItemList,
	ResponseInput,
	ResponseInputContent,
	ResponseInputImage,
	ResponseInputItem,
	ResponseInputText,
	ResponseOutputItem,
	ResponseOutputMessage,
	ResponseReasoningItem,
	ResponseStreamEvent,
	ResponseToolSearchOutputItemParam,
} from "openai/resources/responses/responses.js";
import { calculateCost } from "../models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	PromptCacheHints,
	PromptCacheObservation,
	StopReason,
	TextContent,
	TextSignatureV1,
	ThinkingContent,
	Tool,
	ToolCall,
	Usage,
} from "../types.ts";
import type { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { shortHash } from "../utils/hash.ts";
import { parseStreamingJson } from "../utils/json-parse.ts";
import {
	type CacheCandidate,
	digestCacheFrame,
	digestCacheValue,
	selectCacheLayout,
} from "../utils/prompt-cache-layout.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";
import { transformMessages } from "./transform-messages.ts";

// =============================================================================
// Utilities
// =============================================================================

function encodeTextSignatureV1(id: string, phase?: TextSignatureV1["phase"]): string {
	const payload: TextSignatureV1 = { v: 1, id };
	if (phase) payload.phase = phase;
	return JSON.stringify(payload);
}

function parseTextSignature(
	signature: string | undefined,
): { id: string; phase?: TextSignatureV1["phase"] } | undefined {
	if (!signature) return undefined;
	if (signature.startsWith("{")) {
		try {
			const parsed = JSON.parse(signature) as Partial<TextSignatureV1>;
			if (parsed.v === 1 && typeof parsed.id === "string") {
				if (parsed.phase === "commentary" || parsed.phase === "final_answer") {
					return { id: parsed.id, phase: parsed.phase };
				}
				return { id: parsed.id };
			}
		} catch {
			// Fall through to legacy plain-string handling.
		}
	}
	return { id: signature };
}

export interface OpenAIResponsesStreamOptions {
	serviceTier?: ResponseCreateParamsStreaming["service_tier"];
	resolveServiceTier?: (
		responseServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
		requestServiceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => ResponseCreateParamsStreaming["service_tier"] | undefined;
	applyServiceTierPricing?: (
		usage: Usage,
		serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	) => void;
}

function getServiceTierCostMultiplier(
	model: Pick<Model<Api>, "id">,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
): number {
	switch (serviceTier) {
		case "flex":
			return 0.5;
		case "priority":
			return model.id === "gpt-5.5" ? 2.5 : 2;
		default:
			return 1;
	}
}

export function applyServiceTierPricing(
	usage: Usage,
	serviceTier: ResponseCreateParamsStreaming["service_tier"] | undefined,
	model: Pick<Model<Api>, "id">,
) {
	const multiplier = getServiceTierCostMultiplier(model, serviceTier);
	if (multiplier === 1) return;

	usage.cost.input *= multiplier;
	usage.cost.output *= multiplier;
	usage.cost.cacheRead *= multiplier;
	usage.cost.cacheWrite *= multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
}

export interface ConvertResponsesMessagesOptions {
	includeSystemPrompt?: boolean;
	deferredTools?: ReadonlyMap<string, Tool>;
	/**
	 * For every item appended to the converted input, reports the item index
	 * and the index of the `Context.messages` entry that produced it — null
	 * for synthesized items such as the system prompt or repaired tool
	 * results. Used to map prompt-cache breakpoints back to history origins.
	 */
	onOutput?: (inputIndex: number, sourceIndex: number | null) => void;
}

export interface ConvertResponsesToolsOptions {
	strict?: boolean | null;
	deferLoading?: boolean;
}

type OpenAIFunctionTool = Extract<OpenAITool, { type: "function" }>;

// =============================================================================
// Message conversion
// =============================================================================

export function convertResponsesMessages<TApi extends Api>(
	model: Model<TApi>,
	context: Context,
	allowedToolCallProviders: ReadonlySet<string>,
	options?: ConvertResponsesMessagesOptions,
): ResponseInput {
	const messages: ResponseInput = [];
	const loadedToolNames = new Set<string>();

	const normalizeIdPart = (part: string): string => {
		const sanitized = part.replace(/[^a-zA-Z0-9_-]/g, "_");
		const normalized = sanitized.length > 64 ? sanitized.slice(0, 64) : sanitized;
		return normalized.replace(/_+$/, "");
	};

	const buildForeignResponsesItemId = (itemId: string): string => {
		const normalized = `fc_${shortHash(itemId)}`;
		return normalized.length > 64 ? normalized.slice(0, 64) : normalized;
	};

	const normalizeToolCallId = (id: string, _targetModel: Model<TApi>, source: AssistantMessage): string => {
		if (!allowedToolCallProviders.has(model.provider)) return normalizeIdPart(id);
		if (!id.includes("|")) return normalizeIdPart(id);
		const [callId, itemId] = id.split("|");
		const normalizedCallId = normalizeIdPart(callId);
		const isForeignToolCall = source.provider !== model.provider || source.api !== model.api;
		let normalizedItemId = isForeignToolCall ? buildForeignResponsesItemId(itemId) : normalizeIdPart(itemId);
		// OpenAI Responses API requires item id to start with "fc"
		if (!normalizedItemId.startsWith("fc_")) {
			normalizedItemId = normalizeIdPart(`fc_${normalizedItemId}`);
		}
		return `${normalizedCallId}|${normalizedItemId}`;
	};

	const transformedToSource: (number | null)[] = [];
	const transformedMessages = transformMessages(
		context.messages,
		model,
		normalizeToolCallId,
		options?.onOutput
			? {
					onOutput: (outputIndex, sourceIndex) => {
						transformedToSource[outputIndex] = sourceIndex;
					},
				}
			: undefined,
	);

	const emit = (item: ResponseInput[number], transformedIndex: number | null): void => {
		messages.push(item);
		options?.onOutput?.(
			messages.length - 1,
			transformedIndex === null ? null : (transformedToSource[transformedIndex] ?? null),
		);
	};

	const includeSystemPrompt = options?.includeSystemPrompt ?? true;
	if (includeSystemPrompt && context.systemPrompt) {
		const compat = model.compat as { supportsDeveloperRole?: boolean } | undefined;
		const role = model.reasoning && compat?.supportsDeveloperRole !== false ? "developer" : "system";
		emit(
			{
				role,
				content: sanitizeSurrogates(context.systemPrompt),
			},
			null,
		);
	}

	let msgIndex = 0;
	for (const [ti, msg] of transformedMessages.entries()) {
		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				emit(
					{
						role: "user",
						content: [{ type: "input_text", text: sanitizeSurrogates(msg.content) }],
					},
					ti,
				);
			} else {
				const content: ResponseInputContent[] = msg.content.map((item): ResponseInputContent => {
					if (item.type === "text") {
						return {
							type: "input_text",
							text: sanitizeSurrogates(item.text),
						} satisfies ResponseInputText;
					}
					return {
						type: "input_image",
						detail: "auto",
						image_url: `data:${item.mimeType};base64,${item.data}`,
					} satisfies ResponseInputImage;
				});
				if (content.length === 0) continue;
				emit(
					{
						role: "user",
						content,
					},
					ti,
				);
			}
		} else if (msg.role === "assistant") {
			const output: ResponseInput = [];
			const assistantMsg = msg as AssistantMessage;
			const isDifferentModel =
				assistantMsg.model !== model.id &&
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api;
			let textBlockIndex = 0;

			for (const block of msg.content) {
				if (block.type === "thinking") {
					if (block.thinkingSignature) {
						const reasoningItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
						output.push(reasoningItem);
					}
				} else if (block.type === "text") {
					const textBlock = block as TextContent;
					const parsedSignature = parseTextSignature(textBlock.textSignature);
					const fallbackMessageId =
						textBlockIndex === 0 ? `msg_metis_${msgIndex}` : `msg_metis_${msgIndex}_${textBlockIndex}`;
					textBlockIndex++;
					// OpenAI requires id to be max 64 characters
					let msgId = parsedSignature?.id;
					if (!msgId) {
						msgId = fallbackMessageId;
					} else if (msgId.length > 64) {
						msgId = `msg_${shortHash(msgId)}`;
					}
					output.push({
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: sanitizeSurrogates(textBlock.text), annotations: [] }],
						status: "completed",
						id: msgId,
						phase: parsedSignature?.phase,
					} satisfies ResponseOutputMessage);
				} else if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					const [callId, itemIdRaw] = toolCall.id.split("|");
					let itemId: string | undefined = itemIdRaw;

					// For different-model messages, set id to undefined to avoid pairing validation.
					// OpenAI tracks which fc_xxx IDs were paired with rs_xxx reasoning items.
					// By omitting the id, we avoid triggering that validation (like cross-provider does).
					if (isDifferentModel && itemId?.startsWith("fc_")) {
						itemId = undefined;
					}

					output.push({
						type: "function_call",
						id: itemId,
						call_id: callId,
						name: toolCall.name,
						arguments: JSON.stringify(toolCall.arguments),
					});
				}
			}
			if (output.length === 0) continue;
			for (const item of output) emit(item, ti);
		} else if (msg.role === "toolResult") {
			const textResult = msg.content
				.filter((c): c is TextContent => c.type === "text")
				.map((c) => c.text)
				.join("\n");
			const hasImages = msg.content.some((c): c is ImageContent => c.type === "image");
			const hasText = textResult.length > 0;
			const [callId] = msg.toolCallId.split("|");

			let output: string | ResponseFunctionCallOutputItemList;
			if (hasImages && model.input.includes("image")) {
				const contentParts: ResponseFunctionCallOutputItemList = [];

				if (hasText) {
					contentParts.push({
						type: "input_text",
						text: sanitizeSurrogates(textResult),
					});
				}

				for (const block of msg.content) {
					if (block.type === "image") {
						contentParts.push({
							type: "input_image",
							detail: "auto",
							image_url: `data:${block.mimeType};base64,${block.data}`,
						});
					}
				}

				output = contentParts;
			} else {
				output = sanitizeSurrogates(hasText ? textResult : hasImages ? "(see attached image)" : "(no tool output)");
			}

			emit(
				{
					type: "function_call_output",
					call_id: callId,
					output,
				},
				ti,
			);

			const deferredTools: Tool[] = [];
			for (const name of msg.addedToolNames ?? []) {
				const tool = options?.deferredTools?.get(name);
				if (!tool || loadedToolNames.has(name)) continue;
				loadedToolNames.add(name);
				deferredTools.push(tool);
			}
			if (deferredTools.length > 0) {
				const names = deferredTools.map((tool) => tool.name);
				const searchCallId = `metis_tool_load_${shortHash(`${msg.toolCallId}:${names.join(",")}`)}`;
				emit(
					{
						type: "tool_search_call",
						call_id: searchCallId,
						execution: "client",
						status: "completed",
						arguments: { query: names.join(" "), limit: names.length },
					} satisfies ResponseInputItem,
					ti,
				);
				emit(
					{
						type: "tool_search_output",
						call_id: searchCallId,
						execution: "client",
						status: "completed",
						tools: convertResponsesTools(deferredTools, { deferLoading: true }),
					} satisfies ResponseToolSearchOutputItemParam,
					ti,
				);
			}
		}
		msgIndex++;
	}

	return messages;
}

// =============================================================================
// Explicit prompt-cache layout
// =============================================================================

/**
 * Inputs gathered while building a Responses request so stable history
 * endpoints can be marked with explicit `prompt_cache_breakpoint` fields.
 * `itemSources` is populated only when tracing was enabled during conversion.
 */
export interface ResponsesCacheLayoutInput {
	hints: PromptCacheHints;
	itemSources: (number | null)[];
	supported: boolean;
	enabled: boolean;
	messageCount: number;
}

type ExplicitCacheText = {
	type: "input_text";
	text: string;
	prompt_cache_breakpoint?: { mode: "explicit" };
};

interface ResponsesMarkedCandidate extends CacheCandidate {
	itemIndex: number;
	blockIndex: number;
	bytes: number;
}

/**
 * A breakpoint this layout added, with enough data to re-verify it after an
 * `onPayload` hook may have rewritten the request.
 */
export interface ResponsesCacheMark {
	itemIndex: number;
	blockIndex: number;
	prefixDigest: string;
	/** Serialized item before the marker was applied. */
	itemJson: string;
	/** True when the marker wrapped a raw string `output` into input_text. */
	stringOutput: boolean;
}

export interface ResponsesCacheLayoutResult {
	observation: PromptCacheObservation;
	settingsDigest?: string;
	marks: ResponsesCacheMark[];
}

/**
 * Markable block positions inside a converted input item: `input_text` blocks
 * in message content, plus `function_call_output` text (a raw string output
 * counts as block 0 and is wrapped only when it is actually marked).
 */
function markableResponseBlocks(item: ResponseInput[number]): number[] {
	if (item.type === "function_call_output") {
		if (typeof item.output === "string") return [0];
		if (Array.isArray(item.output)) {
			return item.output
				.map((block, index) => (block?.type === "input_text" ? index : -1))
				.filter((index) => index >= 0);
		}
		return [];
	}
	const content = (item as { content?: unknown }).content;
	if (!Array.isArray(content)) return [];
	return content.map((block, index) => (block?.type === "input_text" ? index : -1)).filter((index) => index >= 0);
}

function markResponseBlock(item: ResponseInput[number], blockIndex: number): boolean {
	if (item.type === "function_call_output") {
		if (typeof item.output === "string" && blockIndex === 0) {
			const wrapped: ExplicitCacheText = {
				type: "input_text",
				text: item.output,
				prompt_cache_breakpoint: { mode: "explicit" },
			};
			item.output = [wrapped] as unknown as typeof item.output;
			return true;
		}
		if (Array.isArray(item.output)) {
			const block = item.output[blockIndex] as ExplicitCacheText | undefined;
			if (block?.type !== "input_text") return false;
			block.prompt_cache_breakpoint = { mode: "explicit" };
			return true;
		}
		return false;
	}
	const content = (item as { content?: unknown }).content;
	if (!Array.isArray(content)) return false;
	const block = content[blockIndex] as ExplicitCacheText | undefined;
	if (block?.type !== "input_text") return false;
	block.prompt_cache_breakpoint = { mode: "explicit" };
	return true;
}

/**
 * Place explicit `prompt_cache_breakpoint` markers on stable history
 * endpoints. Only legal `input_text` blocks can carry the marker; when a
 * source's trailing items are not markable (e.g. deferred tool-search items),
 * the endpoint retreats to that source's last markable block.
 */
export async function applyResponsesCacheLayout<TParams extends { input?: unknown }>(
	params: TParams,
	layout: ResponsesCacheLayoutInput,
	model: Pick<Model<"openai-responses">, "provider" | "id">,
): Promise<ResponsesCacheLayoutResult> {
	const { hints, itemSources } = layout;
	const diagnostic = (reason: PromptCacheObservation["reason"]): ResponsesCacheLayoutResult => ({
		observation: { reason, reusableInputBytes: 0, stableInputBytes: 0 },
		marks: [],
	});
	if (!layout.supported) return diagnostic("unsupported");
	if (!layout.enabled) return diagnostic("disabled");
	const input = params.input;
	if (hints.origins.length !== layout.messageCount || !Array.isArray(input) || itemSources.length !== input.length) {
		return diagnostic("unmapped");
	}

	const { input: _input, ...settingsFrame } = params;
	const settingsDigest = await digestCacheValue(settingsFrame);
	// Mark prefix digests chain from the prompt-relevant frame only. Request
	// settings that don't shape the prompt (metadata, sampling) may be
	// changed by a payload hook without invalidating breakpoints.
	let chain = await digestCacheValue(responsesPromptFrame(params));
	let bytes = new TextEncoder().encode(JSON.stringify(settingsFrame)).length;
	const extend = (frame: unknown): void | Promise<void> => {
		const json = JSON.stringify(frame);
		const result = digestCacheFrame(chain, json);
		bytes += new TextEncoder().encode(json).length;
		if (typeof result === "string") {
			chain = result;
			return;
		}
		return result.then((digest) => {
			chain = digest;
		});
	};

	// Last markable block per source, plus the first volatile item that ends
	// the stable prefix. Leading source-less items (the system prompt) are
	// settings frame content; source-less items after real history are
	// synthesized and volatile.
	const lastMarkable = new Map<number, { itemIndex: number; blockIndex: number }>();
	let firstVolatile: number | undefined;
	let seenSourced = false;
	for (let itemIndex = 0; itemIndex < input.length; itemIndex++) {
		const sourceIndex = itemSources[itemIndex];
		if (sourceIndex === null || sourceIndex === undefined) {
			if (seenSourced) firstVolatile ??= itemIndex;
			continue;
		}
		seenSourced = true;
		const origin = hints.origins[sourceIndex];
		if (origin?.kind !== "stable") {
			firstVolatile ??= itemIndex;
			continue;
		}
		const blocks = markableResponseBlocks(input[itemIndex]!);
		if (blocks.length > 0) {
			lastMarkable.set(sourceIndex, { itemIndex, blockIndex: blocks[blocks.length - 1]! });
		}
	}

	const candidates: ResponsesMarkedCandidate[] = [];
	const ordinals = new Map<string, number>();
	let stableBytes = 0;
	for (let itemIndex = 0; itemIndex < input.length; itemIndex++) {
		{
			const pending = extend(input[itemIndex]);
			if (pending) await pending;
		}
		if (firstVolatile !== undefined && itemIndex >= firstVolatile) continue;
		const sourceIndex = itemSources[itemIndex];
		if (sourceIndex === null || sourceIndex === undefined) continue;
		const last = lastMarkable.get(sourceIndex);
		if (!last || last.itemIndex !== itemIndex) continue;
		const origin = hints.origins[sourceIndex];
		if (origin?.kind !== "stable") continue;
		const ordinal = ordinals.get(origin.id) ?? 0;
		ordinals.set(origin.id, ordinal + 1);
		candidates.push({
			originId: origin.id,
			ordinal,
			prefixDigest: chain,
			index: candidates.length,
			itemIndex,
			blockIndex: last.blockIndex,
			bytes,
		});
		stableBytes = bytes;
	}

	if (candidates.length === 0) return diagnostic("unmapped");

	const { chosen, observation } = selectCacheLayout(candidates, hints.previous, model, settingsDigest, stableBytes);

	const marks: ResponsesCacheMark[] = [];
	for (const candidate of chosen) {
		const item = input[candidate.itemIndex];
		if (!item) continue;
		const stringOutput = item.type === "function_call_output" && typeof item.output === "string";
		const itemJson = JSON.stringify(item);
		if (markResponseBlock(item, candidate.blockIndex)) {
			marks.push({
				itemIndex: candidate.itemIndex,
				blockIndex: candidate.blockIndex,
				prefixDigest: candidate.prefixDigest,
				itemJson,
				stringOutput,
			});
		}
	}

	return {
		observation,
		settingsDigest,
		marks,
	};
}

/**
 * The request params that shape the prompt prefix for cache purposes —
 * everything else (metadata, sampling, limits) may be changed by a payload
 * hook without invalidating breakpoint placement.
 */
function responsesPromptFrame(params: { input?: unknown }): unknown {
	const record = params as Record<string, unknown>;
	return {
		model: record.model ?? null,
		instructions: record.instructions ?? null,
		tool_choice: record.tool_choice ?? null,
		tools: record.tools ?? null,
		previous_response_id: record.previous_response_id ?? null,
	};
}

/**
 * Reproduce the pre-marking digest form of an input item: breakpoint fields
 * are stripped, and a string output wrapped by a mark collapses back to its
 * original string.
 */
function responsesItemDigestFrame(item: unknown, mark?: ResponsesCacheMark): unknown {
	if (item === null || typeof item !== "object") return item;
	const record = item as Record<string, unknown>;
	const strip = (block: unknown): unknown => {
		if (block === null || typeof block !== "object") return block;
		const { prompt_cache_breakpoint: _breakpoint, ...rest } = block as Record<string, unknown>;
		return rest;
	};
	if (record.type === "function_call_output") {
		if (mark?.stringOutput && Array.isArray(record.output) && record.output.length === 1) {
			const block = record.output[0] as { type?: string; text?: string };
			if (block?.type === "input_text") return { ...record, output: block.text };
		}
		if (Array.isArray(record.output)) return { ...record, output: record.output.map(strip) };
		return record;
	}
	if (Array.isArray(record.content)) return { ...record, content: record.content.map(strip) };
	return record;
}

function responsesMarkMatchesItem(item: unknown, mark: ResponsesCacheMark): boolean {
	return JSON.stringify(responsesItemDigestFrame(item, mark)) === mark.itemJson;
}

function responsesItemHasBreakpoint(item: unknown): boolean {
	if (item === null || typeof item !== "object") return false;
	const record = item as Record<string, unknown>;
	for (const key of ["content", "output"] as const) {
		const blocks = record[key];
		if (!Array.isArray(blocks)) continue;
		for (const block of blocks) {
			if (
				block !== null &&
				typeof block === "object" &&
				(block as { prompt_cache_breakpoint?: unknown }).prompt_cache_breakpoint !== undefined
			) {
				return true;
			}
		}
	}
	return false;
}

function responsesClearBreakpoints(item: unknown): void {
	if (item === null || typeof item !== "object") return;
	const record = item as Record<string, unknown>;
	for (const key of ["content", "output"] as const) {
		const blocks = record[key];
		if (!Array.isArray(blocks)) continue;
		for (const block of blocks) {
			if (block !== null && typeof block === "object") {
				delete (block as { prompt_cache_breakpoint?: unknown }).prompt_cache_breakpoint;
			}
		}
	}
}

/**
 * Remove one recorded breakpoint wherever it can still be identified — at its
 * recorded position, or on any item whose pre-marker serialization matches
 * (covers hook reordering). Hook-written breakpoints on other items are left
 * untouched.
 */
function dropResponsesMark(input: unknown[], mark: ResponsesCacheMark): boolean {
	const target = input[mark.itemIndex];
	if (responsesItemHasBreakpoint(target) && responsesMarkMatchesItem(target, mark)) {
		responsesClearBreakpoints(target);
		return true;
	}
	for (const item of input) {
		if (responsesItemHasBreakpoint(item) && responsesMarkMatchesItem(item, mark)) {
			responsesClearBreakpoints(item);
			return true;
		}
	}
	return false;
}

/** Remove every breakpoint this layout added that can still be identified. */
export function revokeResponsesMarks(input: unknown[], marks: ResponsesCacheMark[]): void {
	for (const mark of marks) dropResponsesMark(input, mark);
}

/**
 * Re-verify recorded breakpoints against the post-`onPayload` payload. A
 * breakpoint stays valid only while its target keeps the same prefix digest;
 * volatile suffix changes are ignored.
 */
export async function validateResponsesCacheLayout<TParams extends { input?: unknown }>(
	params: TParams,
	marks: ResponsesCacheMark[],
): Promise<boolean> {
	const input = params.input;
	if (!Array.isArray(input)) return false;
	const marksByItem = new Map(marks.map((mark) => [mark.itemIndex, mark]));
	const lastMarkIndex = marks.reduce((max, mark) => Math.max(max, mark.itemIndex), -1);
	if (input.length <= lastMarkIndex) return false;
	let chain = await digestCacheValue(responsesPromptFrame(params));
	for (let itemIndex = 0; itemIndex <= lastMarkIndex; itemIndex++) {
		const mark = marksByItem.get(itemIndex);
		const digest = digestCacheFrame(chain, JSON.stringify(responsesItemDigestFrame(input[itemIndex], mark)));
		chain = typeof digest === "string" ? digest : await digest;
		if (mark && (chain !== mark.prefixDigest || !responsesItemHasBreakpoint(input[itemIndex]))) {
			return false;
		}
	}
	return true;
}

// =============================================================================
// Tool conversion
// =============================================================================

export function convertResponsesTools(tools: readonly Tool[], options?: ConvertResponsesToolsOptions): OpenAITool[] {
	const strict = options?.strict === undefined ? false : options.strict;
	return tools.map(
		(tool): OpenAIFunctionTool => ({
			type: "function",
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as Record<string, unknown>, // TypeBox already generates JSON Schema
			strict,
			...(options?.deferLoading ? { defer_loading: true } : {}),
		}),
	);
}

// =============================================================================
// Stream processing
// =============================================================================

type StreamingToolCall = ToolCall & { partialJson: string };

type ResponsesOutputSlot =
	| { type: "thinking"; block: ThinkingContent; contentIndex: number }
	| { type: "text"; block: TextContent; contentIndex: number }
	| { type: "toolCall"; block: StreamingToolCall; contentIndex: number };

export async function processResponsesStream<TApi extends Api>(
	openaiStream: AsyncIterable<ResponseStreamEvent>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	model: Model<TApi>,
	options?: OpenAIResponsesStreamOptions,
): Promise<void> {
	let sawTerminalResponseEvent = false;
	const outputSlots = new Map<number, ResponsesOutputSlot>();
	const reasoningBlocksById = new Map<string, ThinkingContent>();
	const getSlot = <TType extends ResponsesOutputSlot["type"]>(
		outputIndex: number,
		type: TType,
	): Extract<ResponsesOutputSlot, { type: TType }> | undefined => {
		const slot = outputSlots.get(outputIndex);
		return slot?.type === type ? (slot as Extract<ResponsesOutputSlot, { type: TType }>) : undefined;
	};
	const createSlot = (outputIndex: number, item: ResponseOutputItem): ResponsesOutputSlot | undefined => {
		if (item.type === "reasoning") {
			const block: ThinkingContent = { type: "thinking", thinking: "" };
			output.content.push(block);
			const slot = {
				type: "thinking",
				block,
				contentIndex: output.content.length - 1,
			} satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "thinking_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		if (item.type === "message") {
			const block: TextContent = { type: "text", text: "" };
			output.content.push(block);
			const slot = { type: "text", block, contentIndex: output.content.length - 1 } satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "text_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		if (item.type === "function_call") {
			const block: StreamingToolCall = {
				type: "toolCall",
				id: `${item.call_id}|${item.id}`,
				name: item.name,
				arguments: {},
				partialJson: item.arguments || "",
			};
			output.content.push(block);
			const slot = {
				type: "toolCall",
				block,
				contentIndex: output.content.length - 1,
			} satisfies ResponsesOutputSlot;
			outputSlots.set(outputIndex, slot);
			stream.push({ type: "toolcall_start", contentIndex: slot.contentIndex, partial: output });
			return slot;
		}
		return undefined;
	};
	const getOrCreateSlot = (outputIndex: number, item: ResponseOutputItem): ResponsesOutputSlot | undefined => {
		return outputSlots.get(outputIndex) ?? createSlot(outputIndex, item);
	};
	// Azure OpenAI can omit reasoning.encrypted_content from response.output_item.done
	// and provide it only in response.completed.response.output. Backfill the
	// persisted reasoning signature from the terminal response to keep store:false
	// multi-turn replay stateless. See https://gitee.com/sun124578963_0/metis/issues/6409.
	const backfillReasoningSignatures = (responseOutput: ResponseOutputItem[]): void => {
		for (const item of responseOutput) {
			if (item.type !== "reasoning" || !item.encrypted_content) continue;
			const block = reasoningBlocksById.get(item.id);
			if (!block?.thinkingSignature) continue;

			const storedItem = JSON.parse(block.thinkingSignature) as ResponseReasoningItem;
			if (storedItem.encrypted_content) continue;
			block.thinkingSignature = JSON.stringify({
				...storedItem,
				encrypted_content: item.encrypted_content,
			});
		}
	};
	const finalizeResponse = (
		response: Extract<ResponseStreamEvent, { type: "response.completed" | "response.incomplete" }>["response"],
	): void => {
		sawTerminalResponseEvent = true;
		backfillReasoningSignatures(response.output ?? []);
		if (response?.id) {
			output.responseId = response.id;
		}
		if (response?.usage) {
			const inputDetails = response.usage.input_tokens_details as
				| { cached_tokens?: number; cache_write_tokens?: number }
				| undefined;
			const cachedTokens = inputDetails?.cached_tokens || 0;
			const cacheWriteTokens = inputDetails?.cache_write_tokens || 0;
			output.usage = {
				cacheReported: inputDetails?.cached_tokens != null || inputDetails?.cache_write_tokens != null,
				// OpenAI includes cached and cache-write tokens in input_tokens, so subtract both.
				input: Math.max(0, (response.usage.input_tokens || 0) - cachedTokens - cacheWriteTokens),
				output: response.usage.output_tokens || 0,
				cacheRead: cachedTokens,
				cacheWrite: cacheWriteTokens,
				reasoning: response.usage.output_tokens_details?.reasoning_tokens || 0,
				totalTokens: response.usage.total_tokens || 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};
		}
		calculateCost(model, output.usage);
		if (options?.applyServiceTierPricing) {
			const serviceTier = options.resolveServiceTier
				? options.resolveServiceTier(response?.service_tier, options.serviceTier)
				: (response?.service_tier ?? options.serviceTier);
			options.applyServiceTierPricing(output.usage, serviceTier);
		}
		// Map status to stop reason
		output.stopReason = mapStopReason(response?.status);
		if (output.content.some((b) => b.type === "toolCall") && output.stopReason === "stop") {
			output.stopReason = "toolUse";
		}
	};

	for await (const event of openaiStream) {
		if (event.type === "response.created") {
			output.responseId = event.response.id;
		} else if (event.type === "response.output_item.added") {
			createSlot(event.output_index, event.item);
		} else if (event.type === "response.reasoning_summary_text.delta") {
			const slot = getSlot(event.output_index, "thinking");
			if (!slot) continue;
			slot.block.thinking += event.delta;
			stream.push({
				type: "thinking_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.reasoning_summary_part.done") {
			const slot = getSlot(event.output_index, "thinking");
			if (!slot) continue;
			slot.block.thinking += "\n\n";
			stream.push({
				type: "thinking_delta",
				contentIndex: slot.contentIndex,
				delta: "\n\n",
				partial: output,
			});
		} else if (event.type === "response.reasoning_text.delta") {
			const slot = getSlot(event.output_index, "thinking");
			if (!slot) continue;
			slot.block.thinking += event.delta;
			stream.push({
				type: "thinking_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.output_text.delta") {
			const slot = getSlot(event.output_index, "text");
			if (!slot) continue;
			slot.block.text += event.delta;
			stream.push({
				type: "text_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.refusal.delta") {
			const slot = getSlot(event.output_index, "text");
			if (!slot) continue;
			slot.block.text += event.delta;
			stream.push({
				type: "text_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.function_call_arguments.delta") {
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot) continue;
			slot.block.partialJson += event.delta;
			slot.block.arguments = parseStreamingJson(slot.block.partialJson);
			stream.push({
				type: "toolcall_delta",
				contentIndex: slot.contentIndex,
				delta: event.delta,
				partial: output,
			});
		} else if (event.type === "response.function_call_arguments.done") {
			const slot = getSlot(event.output_index, "toolCall");
			if (!slot) continue;
			const previousPartialJson = slot.block.partialJson;
			slot.block.partialJson = event.arguments;
			slot.block.arguments = parseStreamingJson(slot.block.partialJson);

			if (event.arguments.startsWith(previousPartialJson)) {
				const delta = event.arguments.slice(previousPartialJson.length);
				if (delta.length > 0) {
					stream.push({
						type: "toolcall_delta",
						contentIndex: slot.contentIndex,
						delta,
						partial: output,
					});
				}
			}
		} else if (event.type === "response.output_item.done") {
			const item = event.item;
			const slot = getOrCreateSlot(event.output_index, item);

			if (item.type === "reasoning" && slot?.type === "thinking") {
				const summaryText = item.summary?.map((s) => s.text).join("\n\n") || "";
				const contentText = item.content?.map((c) => c.text).join("\n\n") || "";
				slot.block.thinking = summaryText || contentText || slot.block.thinking;
				slot.block.thinkingSignature = JSON.stringify(item);
				reasoningBlocksById.set(item.id, slot.block);
				stream.push({
					type: "thinking_end",
					contentIndex: slot.contentIndex,
					content: slot.block.thinking,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (item.type === "message" && slot?.type === "text") {
				slot.block.text = item.content?.map((c) => (c.type === "output_text" ? c.text : c.refusal)).join("") || "";
				slot.block.textSignature = encodeTextSignatureV1(item.id, item.phase ?? undefined);
				stream.push({
					type: "text_end",
					contentIndex: slot.contentIndex,
					content: slot.block.text,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			} else if (item.type === "function_call" && slot?.type === "toolCall") {
				slot.block.arguments = parseStreamingJson(item.arguments || slot.block.partialJson || "{}");
				// Finalize in-place and strip the scratch buffer so replay only
				// carries parsed arguments.
				delete (slot.block as { partialJson?: string }).partialJson;
				stream.push({
					type: "toolcall_end",
					contentIndex: slot.contentIndex,
					toolCall: slot.block,
					partial: output,
				});
				outputSlots.delete(event.output_index);
			}
		} else if (event.type === "response.completed" || event.type === "response.incomplete") {
			finalizeResponse(event.response);
		} else if (event.type === "error") {
			throw new Error(`Error Code ${event.code}: ${event.message}` || "Unknown error");
		} else if (event.type === "response.failed") {
			sawTerminalResponseEvent = true;
			const error = event.response?.error;
			const details = event.response?.incomplete_details;
			const msg = error
				? `${error.code || "unknown"}: ${error.message || "no message"}`
				: details?.reason
					? `incomplete: ${details.reason}`
					: "Unknown error (no error details in response)";
			throw new Error(msg);
		}
	}
	if (!sawTerminalResponseEvent) {
		throw new Error("OpenAI Responses stream ended before a terminal response event");
	}
}

function mapStopReason(status: OpenAI.Responses.ResponseStatus | undefined): StopReason {
	if (!status) return "stop";
	switch (status) {
		case "completed":
			return "stop";
		case "incomplete":
			return "length";
		case "failed":
		case "cancelled":
			return "error";
		// These two are wonky ...
		case "in_progress":
		case "queued":
			return "stop";
		default: {
			const _exhaustive: never = status;
			throw new Error(`Unhandled stop reason: ${_exhaustive}`);
		}
	}
}
