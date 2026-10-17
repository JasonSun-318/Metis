import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Model } from "../src/types.ts";

const googleMock = vi.hoisted(() => ({
	constructor: vi.fn(),
	generateContentStream: vi.fn(),
}));

vi.mock("@google/genai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@google/genai")>();
	return {
		...actual,
		GoogleGenAI: class {
			models = { generateContentStream: googleMock.generateContentStream };

			constructor(options: unknown) {
				googleMock.constructor(options);
			}
		},
	};
});

import { opencodeGoProvider } from "../src/providers/opencode-go.ts";

const model: Model<"google-generative-ai"> = {
	id: "gemini-go-regression",
	name: "Go Gemini regression",
	api: "google-generative-ai",
	provider: "opencode-go",
	baseUrl: "https://opencode.ai/zen/go/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 1024,
};

beforeEach(() => {
	googleMock.constructor.mockClear();
	googleMock.generateContentStream.mockReset();
	googleMock.generateContentStream.mockImplementation(async function* () {
		yield {
			candidates: [{ content: { parts: [{ text: "hello from Go" }] }, finishReason: "STOP" }],
		};
	});
});

describe("OpenCode Go provider", () => {
	it.each(["stream", "streamSimple"] as const)("streams Google models through %s", async (method) => {
		const provider = opencodeGoProvider();
		const result = await provider[method](
			model,
			{ messages: [{ role: "user", content: "hello", timestamp: 0 }] },
			{ apiKey: "go-test-key", headers: { "x-opencode-session": "test-session" } },
		).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content).toEqual([{ type: "text", text: "hello from Go" }]);
		expect(googleMock.constructor).toHaveBeenCalledWith({
			apiKey: "go-test-key",
			httpOptions: {
				baseUrl: model.baseUrl,
				apiVersion: "",
				headers: { "x-opencode-session": "test-session" },
			},
		});
		expect(googleMock.generateContentStream).toHaveBeenCalledWith(expect.objectContaining({ model: model.id }));
	});
});
