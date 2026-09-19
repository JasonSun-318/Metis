export { type CapturedWire, captureWire, type PromptCacheWireApi } from "../test-support/prompt-cache-wire.ts";

import type { PromptCacheWireApi } from "../test-support/prompt-cache-wire.ts";

/**
 * Test-only normalization for golden payload comparisons. Only touches the
 * protocol-defined cache marker positions; `cache_control` or
 * `prompt_cache_breakpoint` keys nested inside tool schemas, arguments, or
 * message text are preserved so equivalent content still compares equal.
 */
export function normalizeCachePayload(
	api: PromptCacheWireApi,
	original: Record<string, unknown>,
): Record<string, unknown> {
	const body = structuredClone(original);
	for (const key of ["prompt_cache_key", "prompt_cache_retention", "prompt_cache_options", "cache_control"] as const) {
		delete body[key];
	}
	const clear = (value: unknown): Record<string, unknown> => {
		const block = { ...(value as Record<string, unknown>) };
		delete block.cache_control;
		delete block.prompt_cache_breakpoint;
		return block;
	};
	if (Array.isArray(body.tools)) body.tools = body.tools.map(clear);
	if (Array.isArray(body.system)) body.system = body.system.map(clear);
	if (api === "anthropic-messages" && Array.isArray(body.messages)) {
		body.messages = body.messages.map((value) => {
			const message = { ...(value as Record<string, unknown>) };
			message.content =
				typeof message.content === "string"
					? [{ type: "text", text: message.content }]
					: Array.isArray(message.content)
						? message.content.map(clear)
						: message.content;
			return message;
		});
	}
	if (api === "openai-responses" && Array.isArray(body.input)) {
		body.input = body.input.map((value) => {
			const item = { ...(value as Record<string, unknown>) };
			if (item.type === "function_call_output") {
				item.output =
					typeof item.output === "string"
						? [{ type: "input_text", text: item.output }]
						: Array.isArray(item.output)
							? item.output.map(clear)
							: item.output;
			} else if (["user", "developer", "system", "assistant"].includes(String(item.role))) {
				if (Array.isArray(item.content)) item.content = item.content.map(clear);
			}
			return item;
		});
	}
	return body;
}
