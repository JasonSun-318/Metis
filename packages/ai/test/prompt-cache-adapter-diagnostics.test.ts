import { afterEach, describe, expect, it, vi } from "vitest";
import type {
	Context,
	KnownApi,
	Model,
	PromptCacheObservation,
	PromptCacheRequestSnapshot,
	SimpleStreamOptions,
} from "../src/types.ts";
import { observePromptCacheRequest } from "../src/utils/prompt-cache-diagnostics.ts";

const capture = vi.hoisted(() => ({ payload: undefined as unknown }));
vi.mock("openai", async (original) => {
	const actual = await original<typeof import("openai")>();
	const create = (payload: unknown) => {
		capture.payload = payload;
		throw new Error("SDK boundary captured");
	};
	return {
		...actual,
		default: class extends actual.default {
			chat = { completions: { create } } as never;
			responses = { create } as never;
		},
		AzureOpenAI: class extends actual.AzureOpenAI {
			responses = { create } as never;
		},
	};
});
vi.mock("@anthropic-ai/sdk", async (original) => {
	const actual = await original<typeof import("@anthropic-ai/sdk")>();
	return {
		...actual,
		default: class extends actual.default {
			messages = {
				create: (payload: unknown) => {
					capture.payload = payload;
					throw new Error("SDK boundary captured");
				},
			} as never;
		},
	};
});
vi.mock("@google/genai", async (original) => {
	const actual = await original<typeof import("@google/genai")>();
	return {
		...actual,
		GoogleGenAI: class {
			models = {
				generateContentStream: (payload: unknown) => {
					capture.payload = payload;
					throw new Error("SDK boundary captured");
				},
			};
		},
	};
});
vi.mock("@mistralai/mistralai", async (original) => {
	const actual = await original<typeof import("@mistralai/mistralai")>();
	return {
		...actual,
		Mistral: class {
			chat = {
				stream: (payload: unknown) => {
					capture.payload = payload;
					throw new Error("SDK boundary captured");
				},
			};
		},
	};
});
vi.mock("@aws-sdk/client-bedrock-runtime", async (original) => {
	const actual = await original<typeof import("@aws-sdk/client-bedrock-runtime")>();
	return {
		...actual,
		BedrockRuntimeClient: class {
			send(command: { input: unknown }) {
				capture.payload = command.input;
				throw new Error("SDK boundary captured");
			}
		},
	};
});

const apis: KnownApi[] = [
	"openai-completions",
	"openai-responses",
	"azure-openai-responses",
	"anthropic-messages",
	"google-generative-ai",
	"google-vertex",
	"bedrock-converse-stream",
	"mistral-conversations",
	"openai-codex-responses",
];
const context: Context = {
	systemPrompt: "private-system",
	messages: [{ role: "user", content: "private-user", timestamp: 1 }],
	cacheHints: { origins: [{ id: "entry:1", kind: "stable" }] },
};
const model = (api: KnownApi): Model<KnownApi> => ({
	api,
	id: "test-model",
	provider: "test",
	name: "test",
	baseUrl: "http://127.0.0.1:9",
	reasoning: false,
	input: ["text"],
	contextWindow: 100000,
	maxTokens: 1000,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
afterEach(() => {
	vi.unstubAllGlobals();
	capture.payload = undefined;
});

describe("all built-in adapter diagnostics at final dispatch", () => {
	it.each(apis)("observes %s after in-place and replacement payload hooks through streamSimple", async (api) => {
		// Codex sends its own HTTP request; all other SDK dispatches are mocked above.
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_url: unknown, init: RequestInit) => {
				let body = init.body;
				if (body instanceof Uint8Array) {
					const { zstdDecompressSync } = await import("node:zlib");
					body = zstdDecompressSync(body).toString();
				}
				capture.payload = JSON.parse(String(body));
				return new Response(
					'data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n',
					{ headers: { "content-type": "text/event-stream" } },
				);
			}),
		);
		const adapter = (await import(`../src/api/${api}.ts`)) as {
			streamSimple: (
				model: Model<KnownApi>,
				context: Context,
				options: SimpleStreamOptions,
			) => { result: () => Promise<unknown> };
		};
		const requestModel = model(api);
		const token = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`;
		for (const replace of [false, true]) {
			const snapshots: PromptCacheRequestSnapshot[] = [];
			const layouts: PromptCacheObservation[] = [];
			await adapter
				.streamSimple(requestModel, context, {
					apiKey: api === "openai-codex-responses" ? token : "fake-key",
					transport: "sse",
					maxRetries: 0,
					timeoutMs: 500,
					onPayload: (value) => {
						const payload = value as Record<string, unknown>;
						payload.temperature = 0.125;
						return replace ? { ...payload, temperature: 0.25 } : undefined;
					},
					onPromptCachePrepared: (value) => layouts.push(value),
					promptCacheDiagnostics: {
						enabled: () => true,
						onRequest: (value) => {
							snapshots.push(value);
						},
					},
				})
				.result();
			expect(snapshots, api).toHaveLength(1);
			expect(capture.payload, api).toBeDefined();
			const expected: PromptCacheRequestSnapshot[] = [];
			await observePromptCacheRequest(requestModel, capture.payload, {
				promptCacheDiagnostics: {
					enabled: () => true,
					onRequest: (value) => {
						expected.push(value);
					},
				},
			});
			expect(snapshots[0]).toEqual({ ...expected[0], capturedAt: snapshots[0]!.capturedAt });
			if (api === "anthropic-messages") expect(layouts).toHaveLength(1);
		}
	});
});
