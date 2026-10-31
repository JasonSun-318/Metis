import { afterEach, describe, expect, it } from "vitest";
import { getModel, streamSimple } from "../src/compat.ts";
import { findEnvKeys, getEnvApiKey } from "../src/env-api-keys.ts";
import { getSupportedThinkingLevels } from "../src/models.ts";
import type { Model } from "../src/types.ts";

const originalBasetenApiKey = process.env.BASETEN_API_KEY;

afterEach(() => {
	if (originalBasetenApiKey === undefined) {
		delete process.env.BASETEN_API_KEY;
	} else {
		process.env.BASETEN_API_KEY = originalBasetenApiKey;
	}
});

describe("Baseten models", () => {
	it("keeps both GLM 5.2 endpoints text-only", () => {
		expect(getModel("baseten", "zai-org/GLM-5.2").input).toEqual(["text"]);
		expect(getModel("baseten", "zai-org/GLM-5.2-Fast").input).toEqual(["text"]);
	});

	it("validates explicit on/off Baseten toggle without reasoning_effort", async () => {
		// The removed catalog entry had an explicit toggle map. Keep that contract
		// on a local sample so the production transport logic stays covered without
		// claiming catalog protection for a model that is no longer shipped.
		const catalogModel = getModel("baseten", "zai-org/GLM-5.2");
		const model: Model<"openai-completions"> = {
			...catalogModel,
			id: "test-baseten-toggle-model",
			name: "Test Baseten toggle model",
			thinkingLevelMap: {
				off: "off",
				minimal: null,
				low: null,
				medium: null,
				high: "high",
				xhigh: null,
				max: null,
			},
			compat: {
				...catalogModel.compat,
				supportsReasoningEffort: false,
				thinkingFormat: "baseten",
				chatTemplateArgs: { enable_thinking: { $var: "thinking.enabled" } },
			},
		};

		expect(getSupportedThinkingLevels(model)).toEqual(["off", "high"]);

		// Omitting reasoning is the off state for this transport.
		const cases = [
			{ reasoning: "high" as const, enabled: true },
			{ reasoning: undefined, enabled: false },
		];
		for (const { reasoning, enabled } of cases) {
			let payload: Record<string, unknown> | undefined;
			await streamSimple(
				model,
				{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
				{
					apiKey: "test-baseten-key",
					reasoning,
					onPayload: (value) => {
						payload = value as Record<string, unknown>;
						throw new Error("payload captured");
					},
				},
			).result();

			expect(payload?.chat_template_args).toEqual({ enable_thinking: enabled });
			expect(payload?.reasoning_effort).toBeUndefined();
		}
	});

	it("sends Baseten chat_template_args with reasoning effort", async () => {
		const model = getModel("baseten", "zai-org/GLM-5.2");
		let payload: Record<string, unknown> | undefined;

		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
			{
				apiKey: "test-baseten-key",
				reasoning: "high",
				onPayload: (value) => {
					payload = value as Record<string, unknown>;
					throw new Error("payload captured");
				},
			},
		).result();

		expect(payload?.chat_template_args).toEqual({ enable_thinking: true });
		expect(payload?.reasoning_effort).toBe("high");
	});

	it("disables Baseten opt-in reasoning when thinking is off", async () => {
		const model = getModel("baseten", "zai-org/GLM-5.2");
		let payload: Record<string, unknown> | undefined;

		await streamSimple(
			model,
			{ messages: [{ role: "user", content: "test", timestamp: 0 }] },
			{
				apiKey: "test-baseten-key",
				onPayload: (value) => {
					payload = value as Record<string, unknown>;
					throw new Error("payload captured");
				},
			},
		).result();

		expect(payload?.chat_template_args).toEqual({ enable_thinking: false });
		expect(payload?.reasoning_effort).toBe("none");
	});

	it("resolves BASETEN_API_KEY from the environment", () => {
		process.env.BASETEN_API_KEY = "test-baseten-key";

		expect(findEnvKeys("baseten")).toEqual(["BASETEN_API_KEY"]);
		expect(getEnvApiKey("baseten")).toBe("test-baseten-key");
	});
});
