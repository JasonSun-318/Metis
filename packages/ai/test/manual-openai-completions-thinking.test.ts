import { beforeEach, describe, expect, it, vi } from "vitest";
import { stream as streamCompletions } from "../src/api/openai-completions.ts";
import type { Context, Model } from "../src/types.ts";

const mockState = vi.hoisted(() => ({
	payloads: [] as unknown[],
}));

vi.mock("openai", () => {
	class FakeOpenAI {
		chat = {
			completions: {
				create: (payload: unknown) => {
					mockState.payloads.push(payload);
					const stream = {
						async *[Symbol.asyncIterator]() {
							yield {
								id: "chatcmpl-test",
								model: "custom-reasoner",
								choices: [{ index: 0, delta: { content: "ok" }, finish_reason: "stop" }],
							};
						},
					};
					const result = Promise.resolve(stream) as Promise<typeof stream> & {
						withResponse: () => Promise<{ data: typeof stream; response: { status: number; headers: Headers } }>;
					};
					result.withResponse = async () => ({
						data: stream,
						response: { status: 200, headers: new Headers() },
					});
					return result;
				},
			},
		};
	}
	return { default: FakeOpenAI };
});

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

function manualModel(
	map: Model<"openai-completions">["thinkingLevelMap"],
	compat?: Model<"openai-completions">["compat"],
): Model<"openai-completions"> {
	return {
		id: "custom-reasoner",
		name: "Custom Reasoner",
		api: "openai-completions",
		provider: "custom-openai",
		// Deliberately a domain that normally triggers format detection. Manual maps
		// must not depend on it.
		baseUrl: "https://api.deepseek.com/v1",
		reasoning: true,
		explicitThinkingLevels: true,
		thinkingLevelMap: map,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 8_192,
		...(compat ? { compat } : {}),
	};
}

async function run(
	model: Model<"openai-completions">,
	reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
): Promise<{ payload?: Record<string, unknown>; error?: string }> {
	const stream = streamCompletions(model, context, {
		apiKey: "test-key",
		...(reasoningEffort ? { reasoningEffort } : {}),
	});
	const result = await stream.result();
	return {
		...(mockState.payloads[0] ? { payload: mockState.payloads[0] as Record<string, unknown> } : {}),
		...(result.errorMessage ? { error: result.errorMessage } : {}),
	};
}

describe("OpenAI Completions manual thinkingLevelMap", () => {
	beforeEach(() => {
		mockState.payloads = [];
	});

	it("sends the exact mapping as top-level reasoning_effort, bypassing URL inference", async () => {
		const { payload, error } = await run(manualModel({ off: "none", low: "low", high: "xhigh" }), "high");
		expect(error).toBeUndefined();
		expect(payload?.reasoning_effort).toBe("xhigh");
		expect(payload).not.toHaveProperty("thinking");
	});

	it("sends an explicit off mapping", async () => {
		const { payload, error } = await run(manualModel({ off: "none", high: "high" }));
		expect(error).toBeUndefined();
		expect(payload?.reasoning_effort).toBe("none");
	});

	it("rejects an unconfigured level rather than falling back to the Metis name", async () => {
		const { error } = await run(manualModel({ off: "none", low: "low" }), "high");
		expect(error).toMatch(/Thinking level "high" is not configured/);
	});

	it("rejects an explicitly unsupported reasoning_effort capability", async () => {
		const { error } = await run(
			manualModel({ off: "none", high: "high" }, { supportsReasoningEffort: false }),
			"high",
		);
		expect(error).toMatch(/without reasoning_effort support/);
	});
});
