import { afterEach, describe, expect, it, vi } from "vitest";
import { streamSimple as openAIResponsesStreamSimple } from "../src/api/openai-responses.ts";
import { convertResponsesMessages } from "../src/api/openai-responses-shared.ts";
import type { AssistantMessage, Context, Model } from "../src/types.ts";

function createModel(): Model<"openai-responses"> {
	return {
		id: "gpt-5-mini",
		name: "GPT-5 Mini",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.test/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function createAssistant(signature: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking: "internal reasoning", thinkingSignature: signature }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5-mini",
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
}

function contextWith(assistant: AssistantMessage): Context {
	return {
		messages: [
			{ role: "user", content: "first", timestamp: Date.now() - 1 },
			assistant,
			{ role: "user", content: "follow-up", timestamp: Date.now() },
		],
	};
}

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

describe("persisted reasoning signature corruption", () => {
	it("replays a valid reasoning item unchanged", () => {
		const model = createModel();
		const signature = JSON.stringify({
			type: "reasoning",
			id: "rs_valid",
			summary: [],
			encrypted_content: "encrypted-valid",
		});

		const input = convertResponsesMessages(model, contextWith(createAssistant(signature)), new Set(["openai"]));

		expect(input.find((item) => item.type === "reasoning")).toMatchObject({
			type: "reasoning",
			id: "rs_valid",
			encrypted_content: "encrypted-valid",
		});
	});

	it("rejects malformed JSON with a contextual error that does not leak the payload", () => {
		const model = createModel();
		let caught: unknown;

		try {
			convertResponsesMessages(
				model,
				contextWith(createAssistant('{"type":"reasoning","id":"rs_secret",')),
				new Set(["openai"]),
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		const message = (caught as Error).message;
		expect(message).toContain("Invalid persisted reasoning signature for openai/gpt-5-mini");
		expect(message).toContain("JSON-encoded reasoning item");
		expect(message).not.toContain("rs_secret");
	});

	it("rejects valid JSON with a non-reasoning shape instead of sending it upstream", () => {
		const model = createModel();
		let caught: unknown;

		try {
			convertResponsesMessages(
				model,
				contextWith(createAssistant(JSON.stringify({ type: "message", id: "msg_secret" }))),
				new Set(["openai"]),
			);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		const message = (caught as Error).message;
		expect(message).toContain("expected a reasoning item with type and id");
		expect(message).not.toContain("msg_secret");
	});

	it("surfaces corruption through the provider error stream without a network request", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("network must not be called for a corrupt replay signature");
		});
		vi.stubGlobal("fetch", fetchMock);

		const model = createModel();
		const result = await openAIResponsesStreamSimple(
			model,
			contextWith(createAssistant('{"type":"reasoning","id":"rs_secret",')),
			{ apiKey: "test-key" },
		).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("Invalid persisted reasoning signature");
		expect(result.errorMessage).not.toContain("rs_secret");
		expect(result.api).toBe(model.api);
		expect(result.provider).toBe(model.provider);
		expect(result.model).toBe(model.id);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
