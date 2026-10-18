import Anthropic from "@anthropic-ai/sdk";
import type {
	CacheControlEphemeral,
	ContentBlockParam,
	MessageCreateParamsStreaming,
	MessageParam,
	RawMessageStreamEvent,
	RefusalStopDetails,
} from "@anthropic-ai/sdk/resources/messages.js";
import { calculateCost } from "../models.ts";
import type {
	AnthropicMessagesCompat,
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	ImageContent,
	Message,
	Model,
	PromptCacheHints,
	PromptCacheObservation,
	ProviderEnv,
	ProviderHeaders,
	SimpleStreamOptions,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types.ts";
import { splitDeferredTools } from "../utils/deferred-tools.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { hasHeader, headersToRecord } from "../utils/headers.ts";
import { parseJsonWithRepair, parseStreamingJson } from "../utils/json-parse.ts";
import { observePromptCacheRequest } from "../utils/prompt-cache-diagnostics.ts";
import {
	type CacheCandidate,
	digestCacheFrame,
	digestCacheValue,
	selectCacheLayout,
} from "../utils/prompt-cache-layout.ts";
import { resolveCacheRetention } from "../utils/provider-env.ts";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.ts";

import { buildCopilotDynamicHeaders, hasCopilotVisionInput } from "./github-copilot-headers.ts";
import {
	adjustMaxTokensForThinking,
	buildBaseOptions,
	clampMaxTokensToContext,
	mapSimpleToolChoice,
} from "./simple-options.ts";
import { transformMessages } from "./transform-messages.ts";

function getCacheControl(
	model: Model<"anthropic-messages">,
	cacheRetention?: CacheRetention,
	env?: ProviderEnv,
): { retention: CacheRetention; cacheControl?: CacheControlEphemeral } {
	const retention = resolveCacheRetention(cacheRetention, env);
	if (retention === "none") {
		return { retention };
	}
	const ttl = retention === "long" && getAnthropicCompat(model).supportsLongCacheRetention ? "1h" : undefined;
	return {
		retention,
		cacheControl: { type: "ephemeral", ...(ttl && { ttl }) },
	};
}

// Stealth mode: Mimic Claude Code's tool naming exactly
const claudeCodeVersion = "2.1.75";

// Claude Code 2.x tool names (canonical casing)
const claudeCodeTools = [
	"Read",
	"Write",
	"Edit",
	"Bash",
	"Grep",
	"Glob",
	"AskUserQuestion",
	"EnterPlanMode",
	"ExitPlanMode",
	"KillShell",
	"NotebookEdit",
	"Skill",
	"Task",
	"TaskOutput",
	"TodoWrite",
	"WebFetch",
	"WebSearch",
];

const ccToolLookup = new Map(claudeCodeTools.map((t) => [t.toLowerCase(), t]));

// Convert tool name to CC canonical casing if it matches (case-insensitive)
const toClaudeCodeName = (name: string) => ccToolLookup.get(name.toLowerCase()) ?? name;
const fromClaudeCodeName = (name: string, tools?: Tool[]) => {
	if (tools && tools.length > 0) {
		const lowerName = name.toLowerCase();
		const matchedTool = tools.find((tool) => tool.name.toLowerCase() === lowerName);
		if (matchedTool) return matchedTool.name;
	}
	return name;
};

/**
 * Convert content blocks to Anthropic API format
 */
function convertContentBlocks(content: (TextContent | ImageContent)[]):
	| string
	| Array<
			| { type: "text"; text: string }
			| {
					type: "image";
					source: {
						type: "base64";
						media_type: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
						data: string;
					};
			  }
	  > {
	// If only text blocks, return as concatenated string for simplicity
	const hasImages = content.some((c) => c.type === "image");
	if (!hasImages) {
		return sanitizeSurrogates(content.map((c) => (c as TextContent).text).join("\n"));
	}

	// If we have images, convert to content block array
	const blocks = content.map((block) => {
		if (block.type === "text") {
			return {
				type: "text" as const,
				text: sanitizeSurrogates(block.text),
			};
		}
		return {
			type: "image" as const,
			source: {
				type: "base64" as const,
				media_type: block.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
				data: block.data,
			},
		};
	});

	// If only images (no text), add placeholder text block
	const hasText = blocks.some((b) => b.type === "text");
	if (!hasText) {
		blocks.unshift({
			type: "text" as const,
			text: "(see attached image)",
		});
	}

	return blocks;
}

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";

export type AnthropicThinkingDisplay = "summarized" | "omitted";

const FINE_GRAINED_TOOL_STREAMING_BETA = "fine-grained-tool-streaming-2025-05-14";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

function getAnthropicCompat(
	model: Model<"anthropic-messages">,
): Required<
	Omit<
		AnthropicMessagesCompat,
		"forceAdaptiveThinking" | "supportsMidConvoEffort" | "allowedFallbackModels" | "sessionAffinityFormat"
	>
> & { sessionAffinityFormat?: AnthropicMessagesCompat["sessionAffinityFormat"] } {
	const isOpenRouter = model.provider === "openrouter" || model.baseUrl.includes("openrouter.ai");
	return {
		supportsEagerToolInputStreaming: model.compat?.supportsEagerToolInputStreaming ?? true,
		supportsLongCacheRetention: model.compat?.supportsLongCacheRetention ?? true,
		sendSessionAffinityHeaders: model.compat?.sendSessionAffinityHeaders ?? isOpenRouter,
		sessionAffinityFormat: model.compat?.sessionAffinityFormat ?? (isOpenRouter ? "openrouter" : undefined),
		supportsCacheControlOnTools: model.compat?.supportsCacheControlOnTools ?? true,
		supportsTemperature: model.compat?.supportsTemperature ?? true,
		allowEmptySignature: model.compat?.allowEmptySignature ?? false,
		supportsStrictTools: model.compat?.supportsStrictTools ?? false,
		supportsToolReferences: model.compat?.supportsToolReferences ?? defaultSupportsToolReferences(model),
	};
}

/**
 * Default for `supportsToolReferences`: first-party Anthropic models except
 * Haiku (rejects client-side tool_reference blocks) and models that predate
 * tool search (Claude 3.x, Opus/Sonnet 4.0, Opus 4.1).
 */
function defaultSupportsToolReferences(model: Model<"anthropic-messages">): boolean {
	if (model.provider !== "anthropic" || model.id.includes("haiku")) return false;
	const version = model.id.match(/^claude-(?:opus|sonnet|fable)-(\d+)(?:-(\d+))?(?:-|$)/);
	if (!version) return false;
	const major = Number(version[1]);
	const minor = version[2] && version[2].length < 8 ? Number(version[2]) : 0;
	return major > 4 || (major === 4 && minor >= 5);
}

export interface AnthropicOptions extends StreamOptions {
	/**
	 * Enable extended thinking.
	 * For adaptive thinking models: the model decides when/how much to think.
	 * For older models: uses budget-based thinking with thinkingBudgetTokens.
	 * Default: undefined (thinking is omitted unless `streamSimple()` maps
	 * a simple reasoning level to this option, or callers set it explicitly).
	 */
	thinkingEnabled?: boolean;
	/**
	 * Token budget for extended thinking (older models only).
	 * Ignored for adaptive thinking models.
	 * Default: 1024 when `thinkingEnabled` is true and no budget is provided.
	 */
	thinkingBudgetTokens?: number;
	/**
	 * Effort level for adaptive thinking models.
	 * Controls how much thinking Claude allocates:
	 * - "max": Always thinks with no constraints (Opus 4.6 only)
	 * - "xhigh": Highest reasoning level (Opus 4.7+, Fable 5)
	 * - "high": Always thinks, deep reasoning
	 * - "medium": Moderate thinking, may skip for simple queries
	 * - "low": Minimal thinking, skips for simple tasks
	 * Ignored for older models.
	 * Default: omitted unless `streamSimple()` maps a simple reasoning
	 * level to this option.
	 */
	effort?: AnthropicEffort;
	/**
	 * Controls how thinking content is returned in API responses.
	 * - "summarized": Thinking blocks contain summarized thinking text.
	 * - "omitted": Thinking blocks return an empty thinking field; the encrypted
	 *   signature still travels back for multi-turn continuity. Use for faster
	 *   time-to-first-text-token when your UI does not surface thinking.
	 *
	 * Note: Anthropic's API default for Claude Opus 4.7 and Claude Mythos Preview
	 * is "omitted". We default to "summarized" here to keep behavior consistent
	 * with older Claude 4 models. Set this explicitly to "omitted" to opt in.
	 * Default: "summarized" when thinking is enabled.
	 */
	thinkingDisplay?: AnthropicThinkingDisplay;
	/**
	 * Whether to request the interleaved thinking beta header for non-adaptive
	 * thinking models. Adaptive thinking models have interleaved thinking built in,
	 * so the header is skipped for them regardless of this setting.
	 * Default: true.
	 */
	interleavedThinking?: boolean;
	/**
	 * Anthropic tool choice behavior. String values map to Anthropic's built-in
	 * choices; `{ type: "tool", name }` forces a specific tool.
	 * Default: omitted (Anthropic default behavior, currently equivalent to auto).
	 */
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/**
	 * Pre-built Anthropic client instance. When provided, skips internal client
	 * construction entirely. Use this to inject alternative SDK clients such as
	 * `AnthropicVertex` that shares the same messaging API.
	 */
	client?: Anthropic;
}

function mergeHeaders(...headerSources: (ProviderHeaders | undefined)[]): ProviderHeaders {
	const merged: ProviderHeaders = {};
	for (const headers of headerSources) {
		if (headers) {
			Object.assign(merged, headers);
		}
	}
	return merged;
}

function assertRequestAuth(provider: string, apiKey: string | undefined, headers: ProviderHeaders | undefined): void {
	if (apiKey) return;
	if (
		hasHeader(headers, "authorization") ||
		hasHeader(headers, "x-api-key") ||
		hasHeader(headers, "cf-aig-authorization")
	) {
		return;
	}
	throw new Error(`No API key for provider: ${provider}`);
}

interface ServerSentEvent {
	event: string | null;
	data: string;
	raw: string[];
}

interface SseDecoderState {
	event: string | null;
	data: string[];
	raw: string[];
}

const ANTHROPIC_MESSAGE_EVENTS: ReadonlySet<string> = new Set([
	"message_start",
	"message_delta",
	"message_stop",
	"content_block_start",
	"content_block_delta",
	"content_block_stop",
]);

function flushSseEvent(state: SseDecoderState): ServerSentEvent | null {
	if (!state.event && state.data.length === 0) {
		return null;
	}

	const event: ServerSentEvent = {
		event: state.event,
		data: state.data.join("\n"),
		raw: [...state.raw],
	};
	state.event = null;
	state.data = [];
	state.raw = [];
	return event;
}

function decodeSseLine(line: string, state: SseDecoderState): ServerSentEvent | null {
	if (line === "") {
		return flushSseEvent(state);
	}

	state.raw.push(line);
	if (line.startsWith(":")) {
		return null;
	}

	const delimiterIndex = line.indexOf(":");
	const fieldName = delimiterIndex === -1 ? line : line.slice(0, delimiterIndex);
	let value = delimiterIndex === -1 ? "" : line.slice(delimiterIndex + 1);
	if (value.startsWith(" ")) {
		value = value.slice(1);
	}

	if (fieldName === "event") {
		state.event = value;
	} else if (fieldName === "data") {
		state.data.push(value);
	}

	return null;
}

function nextLineBreakIndex(text: string): number {
	const carriageReturnIndex = text.indexOf("\r");
	const newlineIndex = text.indexOf("\n");
	if (carriageReturnIndex === -1) {
		return newlineIndex;
	}
	if (newlineIndex === -1) {
		return carriageReturnIndex;
	}
	return Math.min(carriageReturnIndex, newlineIndex);
}

function consumeLine(text: string): { line: string; rest: string } | null {
	const lineBreakIndex = nextLineBreakIndex(text);
	if (lineBreakIndex === -1) {
		return null;
	}

	let nextIndex = lineBreakIndex + 1;
	if (text[lineBreakIndex] === "\r" && text[nextIndex] === "\n") {
		nextIndex += 1;
	}

	return {
		line: text.slice(0, lineBreakIndex),
		rest: text.slice(nextIndex),
	};
}

async function* iterateSseMessages(
	body: ReadableStream<Uint8Array>,
	signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const state: SseDecoderState = { event: null, data: [], raw: [] };
	let buffer = "";

	try {
		while (true) {
			if (signal?.aborted) {
				throw new Error("Request was aborted");
			}

			const { value, done } = await reader.read();
			if (done) {
				break;
			}

			buffer += decoder.decode(value, { stream: true });
			let consumed = consumeLine(buffer);
			while (consumed) {
				buffer = consumed.rest;
				const event = decodeSseLine(consumed.line, state);
				if (event) {
					yield event;
				}
				consumed = consumeLine(buffer);
			}
		}

		buffer += decoder.decode();
		let consumed = consumeLine(buffer);
		while (consumed) {
			buffer = consumed.rest;
			const event = decodeSseLine(consumed.line, state);
			if (event) {
				yield event;
			}
			consumed = consumeLine(buffer);
		}

		if (buffer.length > 0) {
			const event = decodeSseLine(buffer, state);
			if (event) {
				yield event;
			}
		}

		const trailingEvent = flushSseEvent(state);
		if (trailingEvent) {
			yield trailingEvent;
		}
	} finally {
		reader.releaseLock();
	}
}

async function* iterateAnthropicEvents(
	response: Response,
	signal?: AbortSignal,
): AsyncGenerator<RawMessageStreamEvent> {
	if (!response.body) {
		throw new Error("Attempted to iterate over an Anthropic response with no body");
	}

	let sawMessageStart = false;
	let sawMessageEnd = false;

	for await (const sse of iterateSseMessages(response.body, signal)) {
		if (sse.event === "error") {
			throw new Error(sse.data);
		}

		if (!ANTHROPIC_MESSAGE_EVENTS.has(sse.event ?? "")) {
			continue;
		}

		try {
			const event = parseJsonWithRepair<RawMessageStreamEvent>(sse.data);
			if (event.type === "message_start") {
				sawMessageStart = true;
			} else if (event.type === "message_stop") {
				sawMessageEnd = true;
			}
			yield event;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(
				`Could not parse Anthropic SSE event ${sse.event}: ${message}; data=${sse.data}; raw=${sse.raw.join("\\n")}`,
			);
		}
	}

	if (sawMessageStart && !sawMessageEnd) {
		throw new Error("Anthropic stream ended before message_stop");
	}
}

export const stream: StreamFunction<"anthropic-messages", AnthropicOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: AnthropicOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: model.api as Api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};

		try {
			let client: Anthropic;
			let isOAuth: boolean;

			if (options?.client) {
				client = options.client;
				isOAuth = false;
			} else {
				const apiKey = options?.apiKey;
				assertRequestAuth(model.provider, apiKey, options?.headers);

				let copilotDynamicHeaders: Record<string, string> | undefined;
				if (model.provider === "github-copilot") {
					const hasImages = hasCopilotVisionInput(context.messages);
					copilotDynamicHeaders = buildCopilotDynamicHeaders({
						messages: context.messages,
						hasImages,
					});
				}

				const cacheRetention = resolveCacheRetention(options?.cacheRetention, options?.env);
				const cacheSessionId = cacheRetention === "none" ? undefined : options?.sessionId;

				const created = createClient(
					model,
					apiKey,
					options?.interleavedThinking ?? true,
					shouldUseFineGrainedToolStreamingBeta(model, context),
					options?.headers,
					copilotDynamicHeaders,
					cacheSessionId,
				);
				client = created.client;
				isOAuth = created.isOAuthToken;
			}
			const built = buildParams(model, context, isOAuth, options);
			let params = built.params;
			let layoutResult: AnthropicCacheLayoutResult | undefined;
			if (built.layout) {
				try {
					layoutResult = await applyAnthropicCacheLayout(built.params, built.layout, model);
					if (layoutResult) {
						params = layoutResult.payload;
					}
				} catch {
					// Cache layout is an optimization; on failure keep the legacy
					// marker placement rather than risking the request.
					layoutResult = undefined;
				}
				if (!layoutResult) {
					params = buildParams(model, { ...context, cacheHints: undefined }, isOAuth, options).params;
				}
			}
			const nextParams = await options?.onPayload?.(params, model);
			if (nextParams !== undefined) {
				params = nextParams as MessageCreateParamsStreaming;
			}
			let prepared = layoutResult?.observation;
			if (prepared && layoutResult && options?.onPayload) {
				try {
					const valid = await validateAnthropicCacheLayout(params, layoutResult.marks);
					if (!valid) {
						revokeAnthropicMarks(params, layoutResult.marks);
						prepared = {
							reason: "hook-change",
							reusableInputBytes: 0,
							stableInputBytes: prepared.stableInputBytes,
						};
					} else {
						// Markers the hook wrote count against the budget; only our
						// own markers may be revoked to stay within it.
						enforceAnthropicMarkerBudget(params, layoutResult.marks);
					}
				} catch {
					// Layout validation must never break the request path.
				}
			}
			if (prepared) {
				try {
					options?.onPromptCachePrepared?.(prepared);
				} catch {
					// Observation callbacks must never break the request path.
				}
			}
			await observePromptCacheRequest(model, { ...params, stream: true }, options);
			const requestOptions = {
				...(options?.signal ? { signal: options.signal } : {}),
				...(options?.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
				maxRetries: options?.maxRetries ?? 0,
			};
			const response = await client.messages.create({ ...params, stream: true }, requestOptions).asResponse();
			await options?.onResponse?.({ status: response.status, headers: headersToRecord(response.headers) }, model);
			stream.push({ type: "start", partial: output });

			type Block = (ThinkingContent | TextContent | (ToolCall & { partialJson: string })) & { index: number };
			const blocks = output.content as Block[];

			for await (const event of iterateAnthropicEvents(response, options?.signal)) {
				if (event.type === "message_start") {
					output.responseId = event.message.id;
					// Capture initial token usage from message_start event
					// This ensures we have input token counts even if the stream is aborted early
					output.usage.cacheReported =
						event.message.usage.cache_read_input_tokens != null ||
						event.message.usage.cache_creation_input_tokens != null;
					output.usage.input = event.message.usage.input_tokens || 0;
					output.usage.output = event.message.usage.output_tokens || 0;
					output.usage.cacheRead = event.message.usage.cache_read_input_tokens || 0;
					output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens || 0;
					output.usage.cacheWrite1h = event.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0;
					// Anthropic doesn't provide total_tokens, compute from components
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				} else if (event.type === "content_block_start") {
					if (event.content_block.type === "text") {
						const block: Block = {
							type: "text",
							text: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "text_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "thinking") {
						const block: Block = {
							type: "thinking",
							thinking: "",
							thinkingSignature: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "redacted_thinking") {
						const block: Block = {
							type: "thinking",
							thinking: "[Reasoning redacted]",
							thinkingSignature: event.content_block.data,
							redacted: true,
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "thinking_start", contentIndex: output.content.length - 1, partial: output });
					} else if (event.content_block.type === "tool_use") {
						const block: Block = {
							type: "toolCall",
							id: event.content_block.id,
							name: isOAuth
								? fromClaudeCodeName(event.content_block.name, context.tools)
								: event.content_block.name,
							arguments: (event.content_block.input as Record<string, any>) ?? {},
							partialJson: "",
							index: event.index,
						};
						output.content.push(block);
						stream.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
					}
				} else if (event.type === "content_block_delta") {
					if (event.delta.type === "text_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "text") {
							block.text += event.delta.text;
							stream.push({
								type: "text_delta",
								contentIndex: index,
								delta: event.delta.text,
								partial: output,
							});
						}
					} else if (event.delta.type === "thinking_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "thinking") {
							block.thinking += event.delta.thinking;
							stream.push({
								type: "thinking_delta",
								contentIndex: index,
								delta: event.delta.thinking,
								partial: output,
							});
						}
					} else if (event.delta.type === "input_json_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "toolCall") {
							block.partialJson += event.delta.partial_json;
							block.arguments = parseStreamingJson(block.partialJson);
							stream.push({
								type: "toolcall_delta",
								contentIndex: index,
								delta: event.delta.partial_json,
								partial: output,
							});
						}
					} else if (event.delta.type === "signature_delta") {
						const index = blocks.findIndex((b) => b.index === event.index);
						const block = blocks[index];
						if (block && block.type === "thinking") {
							block.thinkingSignature = block.thinkingSignature || "";
							block.thinkingSignature += event.delta.signature;
						}
					}
				} else if (event.type === "content_block_stop") {
					const index = blocks.findIndex((b) => b.index === event.index);
					const block = blocks[index];
					if (block) {
						delete (block as any).index;
						if (block.type === "text") {
							stream.push({
								type: "text_end",
								contentIndex: index,
								content: block.text,
								partial: output,
							});
						} else if (block.type === "thinking") {
							stream.push({
								type: "thinking_end",
								contentIndex: index,
								content: block.thinking,
								partial: output,
							});
						} else if (block.type === "toolCall") {
							block.arguments = parseStreamingJson(block.partialJson);
							// Finalize in-place and strip the scratch buffer so replay only
							// carries parsed arguments.
							delete (block as { partialJson?: string }).partialJson;
							stream.push({
								type: "toolcall_end",
								contentIndex: index,
								toolCall: block,
								partial: output,
							});
						}
					}
				} else if (event.type === "message_delta") {
					if (event.delta.stop_reason) {
						const stopReasonResult = mapStopReason(event.delta.stop_reason, event.delta.stop_details);
						output.stopReason = stopReasonResult.stopReason;
						if (stopReasonResult.errorMessage) {
							output.errorMessage = stopReasonResult.errorMessage;
						}
					}
					// Only update usage fields if present (not null).
					// Preserves input_tokens from message_start when proxies omit it in message_delta.
					if (event.usage) {
						if (event.usage.input_tokens != null) {
							output.usage.input = event.usage.input_tokens;
						}
						if (event.usage.output_tokens != null) {
							output.usage.output = event.usage.output_tokens;
						}
						if (event.usage.cache_read_input_tokens != null) {
							output.usage.cacheReported = true;
							output.usage.cacheRead = event.usage.cache_read_input_tokens;
						}
						if (event.usage.cache_creation_input_tokens != null) {
							output.usage.cacheReported = true;
							output.usage.cacheWrite = event.usage.cache_creation_input_tokens;
						}
						// Anthropic reports reasoning tokens in `output_tokens_details.thinking_tokens` on the
						// final message_delta usage (a subset of output_tokens). SDK 0.91.1 omits the field from
						// its Usage type, so read it through a narrow cast. Verified against the live API.
						const thinkingTokens = (event.usage as { output_tokens_details?: { thinking_tokens?: number } })
							.output_tokens_details?.thinking_tokens;
						if (thinkingTokens != null) {
							output.usage.reasoning = thinkingTokens;
						}
					}
					// Anthropic doesn't provide total_tokens, compute from components
					output.usage.totalTokens =
						output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
					calculateCost(model, output.usage);
				}
			}

			if (options?.signal?.aborted) {
				throw new Error("Request was aborted");
			}

			if (output.stopReason === "aborted" || output.stopReason === "error") {
				throw new Error(output.errorMessage || "An unknown error occurred");
			}

			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				delete (block as { index?: number }).index;
				// partialJson is only a streaming scratch buffer; never persist it.
				delete (block as { partialJson?: string }).partialJson;
			}
			output.stopReason = options?.signal?.aborted ? "aborted" : "error";
			output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

/**
 * Map ThinkingLevel to Anthropic effort levels for adaptive thinking.
 * Note: effort "max" is available on all adaptive-thinking Claude models, while native
 * "xhigh" is only available on Opus 4.7/4.8, Sonnet 5, and Fable 5.
 */
function mapThinkingLevelToEffort(
	model: Model<"anthropic-messages">,
	level: SimpleStreamOptions["reasoning"],
): AnthropicEffort {
	const mapped = level ? model.thinkingLevelMap?.[level] : undefined;
	if (typeof mapped === "string") return mapped as AnthropicEffort;

	switch (level) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "high":
			return "high";
		default:
			return "high";
	}
}

export const streamSimple: StreamFunction<"anthropic-messages", SimpleStreamOptions> = (
	model: Model<"anthropic-messages">,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream => {
	assertRequestAuth(model.provider, options?.apiKey, options?.headers);

	const base = buildBaseOptions(model, context, options, options?.apiKey);
	const toolChoice = mapSimpleToolChoice(options?.toolChoice, "any");
	if (!options?.reasoning) {
		return stream(model, context, { ...base, thinkingEnabled: false, toolChoice } satisfies AnthropicOptions);
	}

	// For models with adaptive thinking: use an effort level.
	// For older models: use budget-based thinking.
	if (model.compat?.forceAdaptiveThinking === true) {
		const effort = mapThinkingLevelToEffort(model, options.reasoning);
		return stream(model, context, {
			...base,
			thinkingEnabled: true,
			effort,
			toolChoice,
		} satisfies AnthropicOptions);
	}

	// Undefined means the caller did not request an output cap; let the helper use the model cap.
	// Do not coerce to 0 here, or the thinking budget would become the entire max_tokens value.
	const adjusted = adjustMaxTokensForThinking(
		base.maxTokens,
		model.maxTokens,
		options.reasoning,
		options.thinkingBudgets,
	);

	const maxTokens = clampMaxTokensToContext(model, context, adjusted.maxTokens);

	return stream(model, context, {
		...base,
		maxTokens,
		thinkingEnabled: true,
		thinkingBudgetTokens: Math.min(adjusted.thinkingBudget, Math.max(0, maxTokens - 1024)),
		toolChoice,
	} satisfies AnthropicOptions);
};

function isOAuthToken(apiKey: string): boolean {
	return apiKey.includes("sk-ant-oat");
}

function createClient(
	model: Model<"anthropic-messages">,
	apiKey: string | undefined,
	interleavedThinking: boolean,
	useFineGrainedToolStreamingBeta: boolean,
	optionsHeaders?: ProviderHeaders,
	dynamicHeaders?: Record<string, string>,
	sessionId?: string,
): { client: Anthropic; isOAuthToken: boolean } {
	// Adaptive thinking models have interleaved thinking built in, so skip the beta header.
	const needsInterleavedBeta = interleavedThinking && model.compat?.forceAdaptiveThinking !== true;
	const betaFeatures: string[] = [];
	if (useFineGrainedToolStreamingBeta) {
		betaFeatures.push(FINE_GRAINED_TOOL_STREAMING_BETA);
	}
	if (needsInterleavedBeta) {
		betaFeatures.push(INTERLEAVED_THINKING_BETA);
	}

	// Copilot: Bearer auth, selective betas.
	if (model.provider === "github-copilot") {
		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey ?? null,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
				},
				model.headers,
				dynamicHeaders,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: false };
	}

	// OAuth: Bearer auth, Claude Code identity headers
	if (apiKey && isOAuthToken(apiKey)) {
		const client = new Anthropic({
			apiKey: null,
			authToken: apiKey,
			baseURL: model.baseUrl,
			dangerouslyAllowBrowser: true,
			defaultHeaders: mergeHeaders(
				{
					accept: "application/json",
					"anthropic-dangerous-direct-browser-access": "true",
					"anthropic-beta": ["claude-code-20250219", "oauth-2025-04-20", ...betaFeatures].join(","),
					"user-agent": `claude-cli/${claudeCodeVersion}`,
					"x-app": "cli",
				},
				model.headers,
				optionsHeaders,
			),
		});

		return { client, isOAuthToken: true };
	}

	// API key or header-owned auth.
	const anthropicCompat = getAnthropicCompat(model);
	const sessionAffinityHeaders: ProviderHeaders =
		sessionId && anthropicCompat.sendSessionAffinityHeaders
			? {
					[anthropicCompat.sessionAffinityFormat === "openrouter" ? "x-session-id" : "x-session-affinity"]:
						sessionId,
				}
			: {};
	const defaultHeaders = mergeHeaders(
		{
			accept: "application/json",
			"anthropic-dangerous-direct-browser-access": "true",
			...(betaFeatures.length > 0 ? { "anthropic-beta": betaFeatures.join(",") } : {}),
		},
		sessionAffinityHeaders,
		model.headers,
		optionsHeaders,
	);
	const client = new Anthropic({
		apiKey: apiKey ?? null,
		authToken: null,
		baseURL: model.baseUrl,
		dangerouslyAllowBrowser: true,
		defaultHeaders,
	});

	return { client, isOAuthToken: false };
}

interface AnthropicCacheLayoutInput {
	cacheControl: CacheControlEphemeral;
	hints: PromptCacheHints;
	transformedToSource: (number | null)[];
	paramSpans: AnthropicParamSpan[];
	isOAuthToken: boolean;
	supportsToolMarkers: boolean;
	immediateToolCount: number;
}

function buildParams(
	model: Model<"anthropic-messages">,
	context: Context,
	isOAuthToken: boolean,
	options?: AnthropicOptions,
): { params: MessageCreateParamsStreaming; layout?: AnthropicCacheLayoutInput } {
	const { cacheControl } = getCacheControl(model, options?.cacheRetention, options?.env);
	const compat = getAnthropicCompat(model);
	const hints = context.cacheHints;
	const hintsEligible =
		cacheControl !== undefined && hints !== undefined && hints.origins.length === context.messages.length;
	const transformedToSource: (number | null)[] = [];
	const transformedMessages = transformMessages(
		context.messages,
		model,
		normalizeToolCallId,
		hintsEligible
			? {
					onOutput: (outputIndex, sourceIndex) => {
						transformedToSource[outputIndex] = sourceIndex;
					},
				}
			: undefined,
	);
	const normalizeToolName = isOAuthToken ? toClaudeCodeName : (name: string) => name;
	const toolPlacement = splitDeferredTools(
		{ ...context, messages: transformedMessages },
		compat.supportsToolReferences,
		normalizeToolName,
	);
	let immediateTools = toolPlacement.immediate;
	let deferredTools = [...toolPlacement.deferred.values()];
	if (immediateTools.length === 0 && deferredTools.length > 0) {
		immediateTools = deferredTools;
		deferredTools = [];
	}
	const deferredToolNames = new Set(deferredTools.map((tool) => normalizeToolName(tool.name)));
	const paramSpans: AnthropicParamSpan[] = [];
	const params: MessageCreateParamsStreaming = {
		model: model.id,
		messages: convertMessages(
			transformedMessages,
			isOAuthToken,
			hintsEligible ? undefined : cacheControl,
			compat.allowEmptySignature,
			deferredToolNames,
			normalizeToolName,
			hintsEligible
				? (paramIndex, span) => {
						paramSpans[paramIndex] = span;
					}
				: undefined,
		),
		max_tokens: options?.maxTokens ?? model.maxTokens,
		stream: true,
	};

	// For OAuth tokens, we MUST include Claude Code identity
	const staticCacheControl = hintsEligible ? undefined : cacheControl;
	if (isOAuthToken) {
		params.system = [
			{
				type: "text",
				text: "You are Claude Code, Anthropic's official CLI for Claude.",
				...(staticCacheControl ? { cache_control: staticCacheControl } : {}),
			},
		];
		if (context.systemPrompt) {
			params.system.push({
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(staticCacheControl ? { cache_control: staticCacheControl } : {}),
			});
		}
	} else if (context.systemPrompt) {
		// Add cache control to system prompt for non-OAuth tokens
		params.system = [
			{
				type: "text",
				text: sanitizeSurrogates(context.systemPrompt),
				...(staticCacheControl ? { cache_control: staticCacheControl } : {}),
			},
		];
	}

	// Temperature is incompatible with extended thinking and unsupported on Claude Opus 4.7+.
	if (options?.temperature !== undefined && !options?.thinkingEnabled && compat.supportsTemperature) {
		params.temperature = options.temperature;
	}

	if (immediateTools.length > 0 || deferredTools.length > 0) {
		params.tools = [
			...convertTools(
				immediateTools,
				isOAuthToken,
				compat.supportsEagerToolInputStreaming,
				compat.supportsCacheControlOnTools ? staticCacheControl : undefined,
			),
			...convertTools(deferredTools, isOAuthToken, compat.supportsEagerToolInputStreaming, undefined, true),
		];
	}

	// Configure thinking mode: adaptive, budget-based, or explicitly disabled.
	if (model.reasoning) {
		if (options?.thinkingEnabled) {
			// Default to "summarized" so Opus 4.7 and Mythos Preview behave like
			// older Claude 4 models (whose API default is also "summarized").
			const display: AnthropicThinkingDisplay = options.thinkingDisplay ?? "summarized";
			if (model.compat?.forceAdaptiveThinking === true) {
				// Adaptive thinking: Claude decides when and how much to think.
				params.thinking = { type: "adaptive", display };
				if (options.effort) {
					// The Anthropic SDK types can lag newly supported effort values such as "xhigh".
					params.output_config =
						options.effort === "xhigh"
							? ({ effort: options.effort } as unknown as NonNullable<
									MessageCreateParamsStreaming["output_config"]
								>)
							: { effort: options.effort };
				}
			} else {
				// Budget-based thinking for older models
				params.thinking = {
					type: "enabled",
					budget_tokens: options.thinkingBudgetTokens || 1024,
					display,
				};
			}
		} else if (options?.thinkingEnabled === false && model.thinkingLevelMap?.off !== null) {
			params.thinking = { type: "disabled" };
		}
	}

	if (options?.metadata) {
		const userId = options.metadata.user_id;
		if (typeof userId === "string") {
			params.metadata = { user_id: userId };
		}
	}

	if (options?.toolChoice) {
		if (typeof options.toolChoice === "string") {
			params.tool_choice = { type: options.toolChoice };
		} else {
			params.tool_choice = options.toolChoice;
		}
	}

	return {
		params,
		layout:
			hintsEligible && cacheControl && hints
				? {
						cacheControl,
						hints,
						transformedToSource,
						paramSpans,
						isOAuthToken,
						supportsToolMarkers: compat.supportsCacheControlOnTools === true,
						immediateToolCount: immediateTools.length,
					}
				: undefined,
	};
}

// Anthropic allows at most four cache_control markers per request, shared
// between system, tools, and message breakpoints.
const ANTHROPIC_CACHE_MARKER_BUDGET = 4;

interface AnthropicMarkedCandidate extends CacheCandidate {
	paramIndex: number;
	blockIndex: number;
	bytes: number;
}

/**
 * A breakpoint this layout added, with enough data to re-verify it after an
 * `onPayload` hook may have rewritten the request.
 */
interface AnthropicCacheMark {
	paramIndex: number;
	blockIndex: number;
	role: string;
	prefixDigest: string;
	/** Serialized markable content before the marker was applied. */
	blockJson: string;
	/** True when the marker wrapped a raw string body into a text block. */
	stringContent: boolean;
}

export interface AnthropicCacheLayoutResult {
	payload: MessageCreateParamsStreaming;
	observation: PromptCacheObservation;
	settingsDigest: string;
	marks: AnthropicCacheMark[];
}

// Sentinel paramIndex values for markers outside the message list.
const SYSTEM_MARK_PARAM = -1;
const TOOLS_MARK_PARAM = -2;

const MARKABLE_BLOCK_TYPES = new Set(["text", "image", "tool_result", "tool_use"]);

function markAnthropicBlock(
	param: MessageParam,
	blockIndex: number,
	stringContent: boolean,
	cacheControl: CacheControlEphemeral,
): boolean {
	if (stringContent && typeof param.content === "string") {
		param.content = [{ type: "text", text: param.content, cache_control: cacheControl }] as never;
		return true;
	}
	if (!Array.isArray(param.content)) return false;
	const block = param.content[blockIndex];
	if (!block || !MARKABLE_BLOCK_TYPES.has(block.type)) return false;
	(block as { cache_control?: CacheControlEphemeral }).cache_control = cacheControl;
	return true;
}

/**
 * Place cache breakpoints on stable history endpoints instead of the volatile
 * request tail. Returns undefined when no stable candidate exists so the
 * caller can rebuild with the legacy marker placement.
 */
async function applyAnthropicCacheLayout(
	params: MessageCreateParamsStreaming,
	layout: AnthropicCacheLayoutInput,
	model: Model<"anthropic-messages">,
): Promise<AnthropicCacheLayoutResult | undefined> {
	const { cacheControl, hints, transformedToSource, paramSpans, isOAuthToken, supportsToolMarkers } = layout;
	const { messages: _messages, tools: _tools, system: _system, ...settingsFrame } = params;
	const settingsDigest = await digestCacheValue(settingsFrame);

	// Mark prefix digests chain from the prompt-relevant frame only. Request
	// settings that don't shape the prompt (metadata, sampling) may be
	// changed by a payload hook without invalidating breakpoints.
	let chain = await digestCacheValue(anthropicPromptFrame(params));
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
	if (params.tools) {
		const pending = extend(params.tools);
		if (pending) await pending;
	}
	if (params.system) {
		const pending = extend(params.system);
		if (pending) await pending;
	}

	// Last payload block attributed to each transformed source index.
	const lastPosition = new Map<number, { paramIndex: number; blockIndex: number }>();
	let firstVolatile: { paramIndex: number; blockIndex: number } | undefined;
	params.messages.forEach((param, paramIndex) => {
		const span = paramSpans[paramIndex];
		const blockCount =
			span?.stringContent === true && typeof param.content === "string"
				? 1
				: Array.isArray(param.content)
					? param.content.length
					: 0;
		for (let blockIndex = 0; blockIndex < blockCount; blockIndex++) {
			const transformedIndex = span?.blockSources[blockIndex];
			const sourceIndex =
				transformedIndex === null || transformedIndex === undefined ? null : transformedToSource[transformedIndex];
			const origin = sourceIndex === null || sourceIndex === undefined ? undefined : hints.origins[sourceIndex];
			if (origin?.kind !== "stable") {
				firstVolatile ??= { paramIndex, blockIndex };
				continue;
			}
			if (transformedIndex !== null && transformedIndex !== undefined) {
				lastPosition.set(transformedIndex, { paramIndex, blockIndex });
			}
		}
	});

	const candidates: AnthropicMarkedCandidate[] = [];
	const ordinals = new Map<string, number>();
	let stableBytes = 0;
	let candidateIndex = 0;

	for (let paramIndex = 0; paramIndex < params.messages.length; paramIndex++) {
		const param = params.messages[paramIndex];
		const span = paramSpans[paramIndex];
		{
			const pending = extend({ role: param.role });
			if (pending) await pending;
		}
		const blocks =
			span?.stringContent === true && typeof param.content === "string"
				? [param.content]
				: Array.isArray(param.content)
					? param.content
					: [];
		for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
			{
				const pending = extend(blocks[blockIndex]);
				if (pending) await pending;
			}
			if (
				firstVolatile &&
				(paramIndex > firstVolatile.paramIndex ||
					(paramIndex === firstVolatile.paramIndex && blockIndex >= firstVolatile.blockIndex))
			) {
				continue;
			}
			const transformedIndex = span?.blockSources[blockIndex];
			if (transformedIndex === null || transformedIndex === undefined) continue;
			const last = lastPosition.get(transformedIndex);
			if (!last || last.paramIndex !== paramIndex || last.blockIndex !== blockIndex) continue;
			const sourceIndex = transformedToSource[transformedIndex];
			const origin = sourceIndex === null || sourceIndex === undefined ? undefined : hints.origins[sourceIndex];
			if (origin?.kind !== "stable") continue;
			const ordinal = ordinals.get(origin.id) ?? 0;
			ordinals.set(origin.id, ordinal + 1);
			candidates.push({
				originId: origin.id,
				ordinal,
				prefixDigest: chain,
				index: candidateIndex++,
				paramIndex,
				blockIndex,
				bytes,
			});
			stableBytes = bytes;
		}
	}

	if (candidates.length === 0) return undefined;

	const { chosen, observation } = selectCacheLayout(candidates, hints.previous, model, settingsDigest, stableBytes);

	const marks: AnthropicCacheMark[] = [];
	let markers = 0;
	for (const candidate of chosen) {
		const param = params.messages[candidate.paramIndex];
		const span = paramSpans[candidate.paramIndex];
		if (!param || !span) continue;
		const originalBlock =
			span.stringContent && typeof param.content === "string"
				? param.content
				: Array.isArray(param.content)
					? param.content[candidate.blockIndex]
					: undefined;
		if (originalBlock === undefined) continue;
		if (markAnthropicBlock(param, candidate.blockIndex, span.stringContent, cacheControl)) {
			markers++;
			marks.push({
				paramIndex: candidate.paramIndex,
				blockIndex: candidate.blockIndex,
				role: param.role,
				prefixDigest: candidate.prefixDigest,
				blockJson: JSON.stringify(originalBlock),
				stringContent: span.stringContent === true,
			});
		}
	}

	if (params.system && params.system.length > 0 && markers < ANTHROPIC_CACHE_MARKER_BUDGET) {
		const index = params.system.length - 1;
		const last = params.system[index];
		if (
			last &&
			typeof last === "object" &&
			(last as { cache_control?: CacheControlEphemeral }).cache_control === undefined
		) {
			(last as { cache_control?: CacheControlEphemeral }).cache_control = cacheControl;
			markers++;
			marks.push(systemMark(index, last));
		}
	}
	if (
		supportsToolMarkers &&
		params.tools &&
		layout.immediateToolCount > 0 &&
		markers < ANTHROPIC_CACHE_MARKER_BUDGET
	) {
		const index = layout.immediateToolCount - 1;
		const last = params.tools[index];
		if (last && (last as { cache_control?: CacheControlEphemeral }).cache_control === undefined) {
			(last as { cache_control?: CacheControlEphemeral }).cache_control = cacheControl;
			markers++;
			marks.push(toolsMark(index, last));
		}
	}
	// The OAuth identity block keeps a marker only when the budget still has
	// room after history, system, and tools; its text content is never changed.
	if (isOAuthToken && params.system && params.system.length > 0 && markers < ANTHROPIC_CACHE_MARKER_BUDGET) {
		const identity = params.system[0];
		if (
			identity &&
			typeof identity === "object" &&
			(identity as { cache_control?: CacheControlEphemeral }).cache_control === undefined
		) {
			(identity as { cache_control?: CacheControlEphemeral }).cache_control = cacheControl;
			markers++;
			marks.push(systemMark(0, identity));
		}
	}

	return { payload: params, observation, settingsDigest, marks };
}

/**
 * The request params that shape the prompt prefix for cache purposes —
 * everything else (metadata, sampling, limits) may be changed by a payload
 * hook without invalidating breakpoint placement.
 */
function anthropicPromptFrame(params: MessageCreateParamsStreaming): unknown {
	return { model: params.model ?? null, tool_choice: params.tool_choice ?? null };
}

/**
 * Strip the marker fields this layout owns from a block-like value so its
 * digest matches the pre-marking request prefix.
 */
function withoutAnthropicMarkers(value: unknown): unknown {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
	const { cache_control: _cacheControl, ...rest } = value as Record<string, unknown>;
	return rest;
}

function systemMark(index: number, block: unknown): AnthropicCacheMark {
	return {
		paramIndex: SYSTEM_MARK_PARAM,
		blockIndex: index,
		role: "system",
		prefixDigest: "",
		blockJson: JSON.stringify(withoutAnthropicMarkers(block)),
		stringContent: false,
	};
}

function toolsMark(index: number, tool: unknown): AnthropicCacheMark {
	return {
		paramIndex: TOOLS_MARK_PARAM,
		blockIndex: index,
		role: "tools",
		prefixDigest: "",
		blockJson: JSON.stringify(withoutAnthropicMarkers(tool)),
		stringContent: false,
	};
}

function anthropicMarkMatchesBlock(block: unknown, mark: AnthropicCacheMark): boolean {
	if (block === null || typeof block !== "object") return false;
	const { cache_control: _cacheControl, ...rest } = block as Record<string, unknown>;
	if (JSON.stringify(rest) === mark.blockJson) return true;
	// A mark that wrapped a raw string body is identified by the block's text.
	if (mark.stringContent && (block as { type?: string }).type === "text") {
		return JSON.stringify((block as { text?: string }).text) === mark.blockJson;
	}
	return false;
}

function anthropicMarkTarget(params: MessageCreateParamsStreaming, mark: AnthropicCacheMark): unknown {
	if (mark.paramIndex === SYSTEM_MARK_PARAM) return params.system?.[mark.blockIndex];
	if (mark.paramIndex === TOOLS_MARK_PARAM) return params.tools?.[mark.blockIndex];
	const param = params.messages?.[mark.paramIndex];
	if (!param || typeof param.content === "string" || !Array.isArray(param.content)) return undefined;
	return param.content[mark.blockIndex];
}

/**
 * Remove one recorded marker wherever it can still be identified — at its
 * recorded position, or on any block whose pre-marker serialization matches
 * (covers hook reordering). Extension-written cache fields are left
 * untouched. Returns true when a marker was removed.
 */
function dropAnthropicMark(params: MessageCreateParamsStreaming, mark: AnthropicCacheMark): boolean {
	const target = anthropicMarkTarget(params, mark);
	if (
		target !== null &&
		typeof target === "object" &&
		(target as { cache_control?: unknown }).cache_control !== undefined &&
		anthropicMarkMatchesBlock(target, mark)
	) {
		delete (target as { cache_control?: unknown }).cache_control;
		return true;
	}
	const containers: unknown[][] = [];
	if (params.messages) {
		for (const param of params.messages) {
			if (Array.isArray(param.content)) containers.push(param.content);
		}
	}
	if (Array.isArray(params.system)) containers.push([...params.system]);
	if (params.tools) containers.push([...params.tools]);
	for (const container of containers) {
		for (const block of container) {
			if (
				block !== null &&
				typeof block === "object" &&
				(block as { cache_control?: unknown }).cache_control !== undefined &&
				anthropicMarkMatchesBlock(block, mark)
			) {
				delete (block as { cache_control?: unknown }).cache_control;
				return true;
			}
		}
	}
	return false;
}

/** Remove every marker this layout added that can still be identified. */
function revokeAnthropicMarks(params: MessageCreateParamsStreaming, marks: AnthropicCacheMark[]): void {
	for (const mark of marks) dropAnthropicMark(params, mark);
}

function countAnthropicMarkers(params: MessageCreateParamsStreaming): number {
	const marked = (block: unknown) =>
		block !== null && typeof block === "object" && (block as { cache_control?: unknown }).cache_control !== undefined;
	const systemBlocks = Array.isArray(params.system) ? params.system : [];
	let total = systemBlocks.filter(marked).length + (params.tools ?? []).filter(marked).length;
	for (const param of params.messages ?? []) {
		if (typeof param.content !== "string" && Array.isArray(param.content)) {
			total += param.content.filter(marked).length;
		}
	}
	return total;
}

/**
 * Keep the total marker count inside Anthropic's budget after a payload hook
 * ran. Markers written by the hook itself are respected and count against the
 * budget; only this layout's own markers are revoked, oldest first so the
 * newest history endpoint survives.
 */
function enforceAnthropicMarkerBudget(params: MessageCreateParamsStreaming, marks: AnthropicCacheMark[]): void {
	let total = countAnthropicMarkers(params);
	for (const mark of marks) {
		if (total <= ANTHROPIC_CACHE_MARKER_BUDGET) return;
		if (dropAnthropicMark(params, mark)) total--;
	}
}

/**
 * Re-verify recorded breakpoints against the post-`onPayload` payload. A
 * breakpoint stays valid only while its target keeps the same role and prefix
 * digest; volatile suffix changes are ignored. Returns the markers that were
 * revoked because history was rewritten or no longer maps.
 */
async function validateAnthropicCacheLayout(
	params: MessageCreateParamsStreaming,
	marks: AnthropicCacheMark[],
): Promise<boolean> {
	// System/tool marks are not prefix-digested; they stay valid only while
	// their exact pre-marker content still carries the marker.
	for (const mark of marks) {
		if (mark.paramIndex >= 0) continue;
		const target = anthropicMarkTarget(params, mark);
		if (
			target === null ||
			typeof target !== "object" ||
			(target as { cache_control?: unknown }).cache_control === undefined ||
			!anthropicMarkMatchesBlock(target, mark)
		) {
			return false;
		}
	}
	let chain = await digestCacheValue(anthropicPromptFrame(params));
	const extend = (frame: unknown): void | Promise<void> => {
		const result = digestCacheFrame(chain, JSON.stringify(frame));
		if (typeof result === "string") {
			chain = result;
			return;
		}
		return result.then((digest) => {
			chain = digest;
		});
	};
	if (params.tools) {
		const pending = extend(params.tools.map(withoutAnthropicMarkers));
		if (pending) await pending;
	}
	if (params.system) {
		{
			const pending = extend(
				typeof params.system === "string" ? params.system : params.system.map(withoutAnthropicMarkers),
			);
			if (pending) await pending;
		}
	}
	const marksByPosition = new Map(marks.map((mark) => [`${mark.paramIndex}:${mark.blockIndex}`, mark]));
	const lastMarkIndex = marks.reduce((max, mark) => Math.max(max, mark.paramIndex), -1);
	const messages = params.messages ?? [];
	for (let paramIndex = 0; paramIndex < messages.length && paramIndex <= lastMarkIndex; paramIndex++) {
		const param = messages[paramIndex]!;
		{
			const pending = extend({ role: param.role });
			if (pending) await pending;
		}
		const blocks =
			typeof param.content === "string" ? [param.content] : Array.isArray(param.content) ? param.content : [];
		for (let blockIndex = 0; blockIndex < blocks.length; blockIndex++) {
			const mark = marksByPosition.get(`${paramIndex}:${blockIndex}`);
			const block = blocks[blockIndex]!;
			// A mark that wrapped a raw string body digests as that string; other
			// blocks digest without their marker field.
			const digestForm =
				mark?.stringContent === true && typeof block === "object" && block !== null && block.type === "text"
					? block.text
					: withoutAnthropicMarkers(block);
			{
				const pending = extend(digestForm);
				if (pending) await pending;
			}
			const hasMarker =
				typeof block === "object" &&
				block !== null &&
				(block as { cache_control?: unknown }).cache_control !== undefined;
			if (mark && (!hasMarker || param.role !== mark.role || chain !== mark.prefixDigest)) return false;
		}
	}
	return true;
}

// Normalize tool call IDs to match Anthropic's required pattern and length
function normalizeToolCallId(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

function convertToolResult(
	msg: ToolResultMessage,
	isOAuthToken: boolean,
	deferredToolNames: ReadonlySet<string>,
	loadedToolNames: Set<string>,
	normalizeToolName: (name: string) => string,
): { toolResult: ContentBlockParam; siblingContent: ContentBlockParam[] } {
	const references: Array<{ type: "tool_reference"; tool_name: string }> = [];
	for (const name of msg.addedToolNames ?? []) {
		const normalizedName = normalizeToolName(name);
		if (!deferredToolNames.has(normalizedName) || loadedToolNames.has(normalizedName)) continue;
		loadedToolNames.add(normalizedName);
		references.push({
			type: "tool_reference",
			tool_name: isOAuthToken ? toClaudeCodeName(name) : name,
		});
	}
	const convertedContent = convertContentBlocks(msg.content);
	// Anthropic rejects tool references mixed with ordinary tool-result content.
	return {
		toolResult: {
			type: "tool_result",
			tool_use_id: msg.toolCallId,
			content: references.length > 0 ? references : convertedContent,
			is_error: msg.isError,
		},
		siblingContent:
			references.length === 0
				? []
				: typeof convertedContent === "string"
					? [{ type: "text", text: convertedContent }]
					: convertedContent,
	};
}

/**
 * Per-param source map for prompt-cache layout. `blockSources` has one entry
 * per serialized content block (a raw string body counts as a single block),
 * holding the index of the transformed message that produced it, or null for
 * synthesized content.
 */
interface AnthropicParamSpan {
	blockSources: (number | null)[];
	stringContent: boolean;
}

type ParamTrace = (paramIndex: number, span: AnthropicParamSpan) => void;

function convertMessages(
	transformedMessages: Message[],
	isOAuthToken: boolean,
	cacheControl?: CacheControlEphemeral,
	allowEmptySignature = false,
	deferredToolNames: ReadonlySet<string> = new Set(),
	normalizeToolName: (name: string) => string = (name) => name,
	onParam?: ParamTrace,
): MessageParam[] {
	const params: MessageParam[] = [];
	const loadedToolNames = new Set<string>();
	const pushParam = (param: MessageParam, span: AnthropicParamSpan) => {
		params.push(param);
		onParam?.(params.length - 1, span);
	};

	for (let i = 0; i < transformedMessages.length; i++) {
		const msg = transformedMessages[i];

		if (msg.role === "user") {
			if (typeof msg.content === "string") {
				if (msg.content.trim().length > 0) {
					pushParam(
						{
							role: "user",
							content: sanitizeSurrogates(msg.content),
						},
						{ blockSources: [i], stringContent: true },
					);
				}
			} else {
				const blocks: ContentBlockParam[] = msg.content.map((item) => {
					if (item.type === "text") {
						return {
							type: "text",
							text: sanitizeSurrogates(item.text),
						};
					} else {
						return {
							type: "image",
							source: {
								type: "base64",
								media_type: item.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
								data: item.data,
							},
						};
					}
				});
				const filteredBlocks = blocks.filter((b) => {
					if (b.type === "text") {
						return b.text.trim().length > 0;
					}
					return true;
				});
				if (filteredBlocks.length === 0) continue;
				pushParam(
					{
						role: "user",
						content: filteredBlocks,
					},
					{ blockSources: filteredBlocks.map(() => i), stringContent: false },
				);
			}
		} else if (msg.role === "assistant") {
			const blocks: ContentBlockParam[] = [];

			for (const block of msg.content) {
				if (block.type === "text") {
					if (block.text.trim().length === 0) continue;
					blocks.push({
						type: "text",
						text: sanitizeSurrogates(block.text),
					});
				} else if (block.type === "thinking") {
					// Redacted thinking: pass the opaque payload back as redacted_thinking
					if (block.redacted) {
						blocks.push({
							type: "redacted_thinking",
							data: block.thinkingSignature!,
						});
						continue;
					}
					const thinkingSignature = block.thinkingSignature;
					const hasThinkingSignature = !!thinkingSignature && thinkingSignature.trim().length > 0;
					if (block.thinking.trim().length === 0 && !hasThinkingSignature) continue;
					// If thinking signature is missing/empty (e.g., from aborted stream),
					// convert to plain text for Anthropic. Some compatible providers emit
					// and accept empty signatures, so let marked models preserve the block.
					if (!hasThinkingSignature) {
						blocks.push(
							allowEmptySignature
								? {
										type: "thinking",
										thinking: sanitizeSurrogates(block.thinking),
										signature: "",
									}
								: {
										type: "text",
										text: sanitizeSurrogates(block.thinking),
									},
						);
					} else {
						blocks.push({
							type: "thinking",
							thinking: sanitizeSurrogates(block.thinking),
							signature: thinkingSignature,
						});
					}
				} else if (block.type === "toolCall") {
					blocks.push({
						type: "tool_use",
						id: block.id,
						name: isOAuthToken ? toClaudeCodeName(block.name) : block.name,
						input: block.arguments ?? {},
					});
				}
			}
			if (blocks.length === 0) continue;
			pushParam(
				{
					role: "assistant",
					content: blocks,
				},
				{ blockSources: blocks.map(() => i), stringContent: false },
			);
		} else if (msg.role === "toolResult") {
			// Collect all consecutive toolResult messages, needed for z.ai Anthropic endpoint.
			const toolResults: ContentBlockParam[] = [];
			const siblingContent: ContentBlockParam[] = [];
			const toolResultSources: (number | null)[] = [];
			const siblingSources: (number | null)[] = [];
			let j = i;
			while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
				const converted = convertToolResult(
					transformedMessages[j] as ToolResultMessage,
					isOAuthToken,
					deferredToolNames,
					loadedToolNames,
					normalizeToolName,
				);
				toolResults.push(converted.toolResult);
				toolResultSources.push(j);
				siblingContent.push(...converted.siblingContent);
				for (let k = 0; k < converted.siblingContent.length; k++) siblingSources.push(j);
				j++;
			}

			// Skip the messages we've already processed.
			i = j - 1;

			// Displaced reference-bearing results must follow every tool_result block.
			pushParam(
				{
					role: "user",
					content: [...toolResults, ...siblingContent],
				},
				{ blockSources: [...toolResultSources, ...siblingSources], stringContent: false },
			);
		}
	}

	// Add cache_control to the last user message to cache conversation history
	if (cacheControl && params.length > 0) {
		const lastMessage = params[params.length - 1];
		if (lastMessage.role === "user") {
			if (Array.isArray(lastMessage.content)) {
				const lastBlock = lastMessage.content[lastMessage.content.length - 1];
				if (
					lastBlock &&
					(lastBlock.type === "text" || lastBlock.type === "image" || lastBlock.type === "tool_result")
				) {
					(lastBlock as any).cache_control = cacheControl;
				}
			} else if (typeof lastMessage.content === "string") {
				lastMessage.content = [
					{
						type: "text",
						text: lastMessage.content,
						cache_control: cacheControl,
					},
				] as any;
			}
		}
	}

	return params;
}

function shouldUseFineGrainedToolStreamingBeta(model: Model<"anthropic-messages">, context: Context): boolean {
	return !!context.tools?.length && !getAnthropicCompat(model).supportsEagerToolInputStreaming;
}

function convertTools(
	tools: Tool[],
	isOAuthToken: boolean,
	supportsEagerToolInputStreaming: boolean,
	cacheControl?: CacheControlEphemeral,
	deferLoading = false,
): Anthropic.Messages.Tool[] {
	if (!tools) return [];

	return tools.map((tool, index) => {
		const schema = tool.parameters as { properties?: unknown; required?: string[] };

		return {
			name: isOAuthToken ? toClaudeCodeName(tool.name) : tool.name,
			description: tool.description,
			...(supportsEagerToolInputStreaming ? { eager_input_streaming: true } : {}),
			input_schema: {
				type: "object",
				properties: schema.properties ?? {},
				required: schema.required ?? [],
			},
			...(deferLoading ? { defer_loading: true } : {}),
			...(cacheControl && index === tools.length - 1 ? { cache_control: cacheControl } : {}),
		};
	});
}

function mapStopReason(
	reason: Anthropic.Messages.StopReason | string,
	stopDetails?: RefusalStopDetails | null,
): { stopReason: StopReason; errorMessage?: string } {
	switch (reason) {
		case "end_turn":
			return { stopReason: "stop" };
		case "max_tokens":
			return { stopReason: "length" };
		case "tool_use":
			return { stopReason: "toolUse" };
		case "refusal":
			return {
				stopReason: "error",
				errorMessage: stopDetails?.explanation || `The model refused to complete the request`,
			};
		case "pause_turn": // Stop is good enough -> resubmit
			return { stopReason: "stop" };
		case "stop_sequence":
			return { stopReason: "stop" }; // We don't supply stop sequences, so this should never happen
		case "sensitive": // Content flagged by safety filters (not yet in SDK types)
			return { stopReason: "error" };
		default:
			// Handle unknown stop reasons gracefully (API may add new values)
			throw new Error(`Unhandled stop reason: ${reason}`);
	}
}
