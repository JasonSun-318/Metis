import { FinishReason, GenerateContentResponse } from "@google/genai";
import { describe, expect, it } from "vitest";
import { processGenerateContentStream } from "../src/api/google-shared.ts";
import type { AssistantMessage, Model } from "../src/types.ts";
import { AssistantMessageEventStream } from "../src/utils/event-stream.ts";

describe.each(["google-generative-ai", "google-vertex"] as const)("%s terminal reasons", (api) => {
	it.each([
		[FinishReason.STOP, "toolUse"],
		[FinishReason.MAX_TOKENS, "length"],
		[FinishReason.SAFETY, "error"],
		[FinishReason.MALFORMED_FUNCTION_CALL, "error"],
	] as const)("preserves %s when a previous chunk contained a tool call", async (finishReason, expectedReason) => {
		const model: Model<typeof api> = {
			id: "test-model",
			name: "Test model",
			api,
			provider: api,
			baseUrl: "https://example.invalid",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		};
		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api,
			provider: model.provider,
			model: model.id,
			stopReason: "stop",
			timestamp: 0,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		async function* chunks(): AsyncIterable<GenerateContentResponse> {
			yield Object.assign(new GenerateContentResponse(), {
				candidates: [{ content: { parts: [{ functionCall: { name: "write", args: { path: "file" } } }] } }],
			});
			yield Object.assign(new GenerateContentResponse(), { candidates: [{ finishReason }] });
		}
		await processGenerateContentStream(chunks(), output, new AssistantMessageEventStream(), model);
		expect(output.content).toEqual([expect.objectContaining({ type: "toolCall", name: "write" })]);
		expect(output.stopReason).toBe(expectedReason);
	});
});
