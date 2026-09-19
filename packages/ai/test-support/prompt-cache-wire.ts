import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { stream as anthropic } from "../src/api/anthropic-messages.ts";
import { stream as responses } from "../src/api/openai-responses.ts";
import type { Context, Model, PromptCacheObservation, StreamOptions } from "../src/types.ts";

export type PromptCacheWireApi = "anthropic-messages" | "openai-responses";

export interface CapturedWire {
	body: Record<string, unknown>;
	observations: PromptCacheObservation[];
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
	const observations: PromptCacheObservation[] = [];
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
		input: ["text" as const, "image" as const],
		contextWindow: 200_000,
		maxTokens: 1024,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
	try {
		const userCallback = options.onPromptCachePrepared;
		const opts = {
			apiKey: "test-key",
			maxRetries: 0,
			timeoutMs: 2000,
			...options,
			onPromptCachePrepared: (observation: PromptCacheObservation) => {
				observations.push(observation);
				userCallback?.(observation);
			},
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
	return { body, observations };
}
