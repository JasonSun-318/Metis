import { describe, expect, it } from "vitest";
import { streamSimple } from "../src/compat.ts";
import type { Context, Model, SimpleStreamOptions } from "../src/types.ts";

interface AnthropicThinkingPayload {
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
}

class PayloadCaptured extends Error {
	constructor() {
		super("payload captured");
		this.name = "PayloadCaptured";
	}
}

const context: Context = {
	messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
};

function manualModel(map: Model<"anthropic-messages">["thinkingLevelMap"]): Model<"anthropic-messages"> {
	return {
		id: "custom-claude",
		name: "Custom Claude",
		api: "anthropic-messages",
		provider: "custom-anthropic",
		baseUrl: "https://anthropic.example.test",
		reasoning: true,
		explicitThinkingLevels: true,
		thinkingLevelMap: map,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	};
}

async function captureManualPayload(
	model: Model<"anthropic-messages">,
	options?: SimpleStreamOptions,
): Promise<{ payload?: AnthropicThinkingPayload; error?: string }> {
	let payload: AnthropicThinkingPayload | undefined;
	const stream = streamSimple({ ...model, baseUrl: "http://127.0.0.1:9" }, context, {
		...options,
		apiKey: "fake-key",
		onPayload: (value) => {
			payload = value as AnthropicThinkingPayload;
			throw new PayloadCaptured();
		},
	});
	const result = await stream.result();
	return {
		...(payload ? { payload } : {}),
		...(payload ? {} : result.errorMessage ? { error: result.errorMessage } : {}),
	};
}

describe("Anthropic manual thinkingLevelMap", () => {
	it("sends the explicit mapped adaptive effort", async () => {
		const { payload, error } = await captureManualPayload(
			manualModel({ off: "disabled", low: "low", high: "xhigh", max: "max" }),
			{ reasoning: "high" },
		);
		expect(error).toBeUndefined();
		expect(payload?.thinking).toEqual({ type: "adaptive", display: "summarized" });
		expect(payload?.output_config).toEqual({ effort: "xhigh" });
	});

	it("sends an explicit disabled form for the off level", async () => {
		const { payload, error } = await captureManualPayload(manualModel({ off: "disabled", high: "high" }));
		expect(error).toBeUndefined();
		expect(payload?.thinking).toEqual({ type: "disabled" });
		expect(payload?.output_config).toBeUndefined();
	});

	it("rejects an invalid explicit effort instead of guessing", async () => {
		const { error } = await captureManualPayload(manualModel({ off: "disabled", high: "turbo" }), {
			reasoning: "high",
		});
		expect(error).toMatch(/accepts explicit adaptive effort values/);
	});

	it("rejects a missing off mapping instead of omitting the disable rule", async () => {
		const { error } = await captureManualPayload(manualModel({ off: null, high: "high" }));
		expect(error).toMatch(/requires the "off" level to map explicitly to "disabled"/);
	});
});
