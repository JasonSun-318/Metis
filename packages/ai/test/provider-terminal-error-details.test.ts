import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const googleGenAiMock = vi.hoisted(() => ({
	chunks: [] as unknown[],
}));

vi.mock("@google/genai", () => {
	class GoogleGenAI {
		models = {
			generateContentStream: async function* () {
				for (const chunk of googleGenAiMock.chunks) yield chunk;
			},
		};
	}

	return {
		GoogleGenAI,
		FinishReason: {
			FINISH_REASON_UNSPECIFIED: "FINISH_REASON_UNSPECIFIED",
			STOP: "STOP",
			MAX_TOKENS: "MAX_TOKENS",
			SAFETY: "SAFETY",
			RECITATION: "RECITATION",
			LANGUAGE: "LANGUAGE",
			OTHER: "OTHER",
			BLOCKLIST: "BLOCKLIST",
			PROHIBITED_CONTENT: "PROHIBITED_CONTENT",
			SPII: "SPII",
			MALFORMED_FUNCTION_CALL: "MALFORMED_FUNCTION_CALL",
			UNEXPECTED_TOOL_CALL: "UNEXPECTED_TOOL_CALL",
			IMAGE_SAFETY: "IMAGE_SAFETY",
			IMAGE_PROHIBITED_CONTENT: "IMAGE_PROHIBITED_CONTENT",
			IMAGE_RECITATION: "IMAGE_RECITATION",
			IMAGE_OTHER: "IMAGE_OTHER",
			NO_IMAGE: "NO_IMAGE",
		},
		FunctionCallingConfigMode: {
			AUTO: "AUTO",
			NONE: "NONE",
			ANY: "ANY",
		},
		ResourceScope: {
			COLLECTION: "COLLECTION",
		},
		ThinkingLevel: {
			THINKING_LEVEL_UNSPECIFIED: "THINKING_LEVEL_UNSPECIFIED",
			MINIMAL: "MINIMAL",
			LOW: "LOW",
			MEDIUM: "MEDIUM",
			HIGH: "HIGH",
		},
	};
});

import { stream as streamGoogle } from "../src/api/google-generative-ai.ts";
import { stream as streamGoogleVertex } from "../src/api/google-vertex.ts";
import { stream as streamMistral } from "../src/api/mistral-conversations.ts";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "../src/types.ts";

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 1 }],
};

function createGoogleModel<TApi extends "google-generative-ai" | "google-vertex">(api: TApi): Model<TApi> {
	return {
		id: "gemini-test",
		name: "Gemini Test",
		api,
		provider: api,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
	};
}

function createMistralModel(): Model<"mistral-conversations"> {
	return {
		id: "mistral-small-2603",
		name: "Mistral Small",
		api: "mistral-conversations",
		provider: "mistral",
		baseUrl: "https://mistral.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

async function runGoogle(
	api: "google-generative-ai" | "google-vertex",
	chunks: unknown[],
): Promise<{ result: AssistantMessage; events: AssistantMessageEvent[] }> {
	googleGenAiMock.chunks = chunks;
	const model = createGoogleModel(api);
	const stream =
		api === "google-generative-ai"
			? streamGoogle(model as Model<"google-generative-ai">, context, { apiKey: "test-key" })
			: streamGoogleVertex(model as Model<"google-vertex">, context, { apiKey: "test-key" });
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { result: await stream.result(), events };
}

function mistralChunk(finishReason: string | null, content?: string): unknown {
	return {
		id: "mistral-test",
		object: "chat.completion.chunk",
		created: 1,
		model: "mistral-small-2603",
		choices: [
			{
				index: 0,
				delta: content ? { role: "assistant", content } : {},
				finish_reason: finishReason,
			},
		],
	};
}

function mistralSse(chunks: unknown[]): Response {
	const body = `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(body, {
		status: 200,
		headers: { "Content-Type": "text/event-stream" },
	});
}

async function runMistral(chunks: unknown[]): Promise<{
	result: AssistantMessage;
	events: AssistantMessageEvent[];
}> {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => mistralSse(chunks)),
	);
	const stream = streamMistral(createMistralModel(), context, { apiKey: "test-key" });
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return { result: await stream.result(), events };
}

beforeEach(() => {
	googleGenAiMock.chunks = [];
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe.each(["google-generative-ai", "google-vertex"] as const)("%s terminal finish reasons", (api) => {
	it.each(["SAFETY", "PROHIBITED_CONTENT"])("preserves %s as the terminal error detail", async (finishReason) => {
		const { result, events } = await runGoogle(api, [
			{ candidates: [{ content: { parts: [{ text: "partial" }] } }] },
			{ candidates: [{ finishReason }] },
		]);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe(`Provider finish_reason: ${finishReason}`);
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
		expect(events.at(-1)?.type).toBe("error");
	});

	it("keeps MAX_TOKENS classified as length without error details", async () => {
		const { result, events } = await runGoogle(api, [
			{ candidates: [{ content: { parts: [{ text: "partial" }] } }] },
			{ candidates: [{ finishReason: "MAX_TOKENS" }] },
		]);

		expect(result.stopReason).toBe("length");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
		expect(events.at(-1)?.type).toBe("done");
	});
});

describe("Mistral terminal finish reasons", () => {
	it("preserves an error finish reason as the terminal error detail", async () => {
		const { result, events } = await runMistral([mistralChunk(null, "partial"), mistralChunk("error")]);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toBe("Provider finish_reason: error");
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
		expect(events.at(-1)?.type).toBe("error");
	});

	it("keeps an unmapped content_filter finish reason as stop for compatibility", async () => {
		const { result, events } = await runMistral([mistralChunk(null, "partial"), mistralChunk("content_filter")]);

		expect(result.stopReason).toBe("stop");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
		expect(events.at(-1)?.type).toBe("done");
	});

	it("keeps length classified as length without error details", async () => {
		const { result, events } = await runMistral([mistralChunk(null, "partial"), mistralChunk("length")]);

		expect(result.stopReason).toBe("length");
		expect(result.errorMessage).toBeUndefined();
		expect(result.content).toEqual([{ type: "text", text: "partial" }]);
		expect(events.at(-1)?.type).toBe("done");
	});
});
