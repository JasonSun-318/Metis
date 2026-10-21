import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenAIResponsesOptions } from "../src/api/openai-responses.ts";
import { stream as streamResponses } from "../src/api/openai-responses.ts";
import type { Context, Model } from "../src/types.ts";

interface ResponsesPayload {
	reasoning?: { effort?: string; summary?: string };
}

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

function manualModel(map: Model<"openai-responses">["thinkingLevelMap"]): Model<"openai-responses"> {
	return {
		id: "custom-reasoner",
		name: "Custom Reasoner",
		api: "openai-responses",
		provider: "custom-openai",
		baseUrl: "https://openai.example.test/v1",
		reasoning: true,
		explicitThinkingLevels: true,
		thinkingLevelMap: map,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
	};
}

async function capturePayload(
	model: Model<"openai-responses">,
	options?: OpenAIResponsesOptions,
): Promise<{ payload?: ResponsesPayload; error?: string }> {
	let payload: ResponsesPayload | undefined;
	vi.spyOn(globalThis, "fetch").mockResolvedValue(
		new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } }),
	);
	const stream = streamResponses(model, context, {
		...options,
		apiKey: "test-key",
		onPayload: (value) => {
			payload = value as ResponsesPayload;
		},
	});
	const result = await stream.result();
	return {
		...(payload ? { payload } : {}),
		...(payload ? {} : result.errorMessage ? { error: result.errorMessage } : {}),
	};
}

describe("OpenAI Responses manual thinkingLevelMap", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("sends the exact mapped reasoning effort", async () => {
		const { payload, error } = await capturePayload(
			manualModel({ off: "none", low: "low", high: "xhigh", max: "max" }),
			{ reasoningEffort: "high" },
		);
		expect(error).toBeUndefined();
		expect(payload?.reasoning).toMatchObject({ effort: "xhigh", summary: "auto" });
	});

	it("sends the explicit off mapping", async () => {
		const { payload, error } = await capturePayload(manualModel({ off: "none", high: "high" }));
		expect(error).toBeUndefined();
		expect(payload?.reasoning).toEqual({ effort: "none" });
	});

	it("rejects an unconfigured level instead of falling back to the Metis level name", async () => {
		const { error } = await capturePayload(manualModel({ off: "none", low: "low" }), { reasoningEffort: "high" });
		expect(error).toMatch(/Thinking level "high" is not configured/);
	});

	it("rejects a missing off mapping instead of silently omitting reasoning", async () => {
		const { error } = await capturePayload(manualModel({ off: null, high: "high" }));
		expect(error).toMatch(/The "off" thinking level is not configured/);
	});
});
