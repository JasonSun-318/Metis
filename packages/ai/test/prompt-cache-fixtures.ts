import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { stream as anthropic } from "../src/api/anthropic-messages.ts";
import { stream as responses } from "../src/api/openai-responses.ts";
import type { Context, Model, StreamOptions } from "../src/types.ts";

export type PromptCacheWireApi = "anthropic-messages" | "openai-responses";

export interface CapturedWire {
	body: Record<string, unknown>;
}

type CompatFor<TApi extends PromptCacheWireApi> = TApi extends "anthropic-messages"
	? Model<"anthropic-messages">["compat"]
	: Model<"openai-responses">["compat"];

function assertLoopbackBaseUrl(baseUrl: string): void {
	let url: URL;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new Error(`Invalid capture base URL: ${baseUrl}`);
	}
	if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost" && url.hostname !== "::1") {
		throw new Error(`Refusing to send a capture request to a non-loopback URL: ${baseUrl}`);
	}
}

/**
 * Send `context` through the real provider serializer to a loopback HTTP server
 * and return the exact request body. The provider stream itself is not mocked;
 * the server returns an empty SSE response, so the resulting assistant message
 * may end in an error state — callers must only assert on the captured body.
 */
export async function captureWire(
	api: PromptCacheWireApi,
	context: Context,
	options: StreamOptions = {},
	compat?: CompatFor<PromptCacheWireApi>,
): Promise<CapturedWire> {
	let body: Record<string, unknown> | undefined;
	const server = createServer(async (request, response) => {
		const chunks: Buffer[] = [];
		for await (const chunk of request) chunks.push(Buffer.from(chunk));
		body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	const baseUrl = `http://127.0.0.1:${port}`;
	assertLoopbackBaseUrl(baseUrl);
	const common = {
		id: "cache-test",
		name: "Cache Test",
		provider: "cache-test",
		baseUrl,
		reasoning: false,
		input: ["text" as const],
		contextWindow: 200_000,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	try {
		const opts = {
			apiKey: "test-key",
			maxRetries: 0,
			timeoutMs: 2000,
			...options,
		};
		const events =
			api === "anthropic-messages"
				? anthropic(
						{
							...common,
							api,
							...(compat !== undefined ? { compat: compat as Model<"anthropic-messages">["compat"] } : {}),
						} satisfies Model<"anthropic-messages">,
						context,
						opts,
					)
				: responses(
						{
							...common,
							api,
							...(compat !== undefined ? { compat: compat as Model<"openai-responses">["compat"] } : {}),
						} satisfies Model<"openai-responses">,
						context,
						opts,
					);
		try {
			await events.result();
		} catch {
			// An empty SSE body can produce an error result; this fixture only
			// inspects the serialized request that reached the loopback server.
		}
	} finally {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
	}
	if (!body) throw new Error("Expected loopback provider request");
	return { body };
}

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
