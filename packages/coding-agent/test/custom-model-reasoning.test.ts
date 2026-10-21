import { describe, expect, it } from "vitest";
import { resolveCustomModelReasoning } from "../src/core/custom-model-reasoning.ts";

describe("resolveCustomModelReasoning", () => {
	it("inherits one exact ID and API capability", () => {
		const result = resolveCustomModelReasoning({
			mode: "auto",
			modelId: "gpt-5.5",
			api: "openai-responses",
			catalog: [
				{
					id: "gpt-5.5",
					api: "openai-responses",
					reasoning: true,
					thinkingLevelMap: { off: "none", max: null },
				},
			],
		});
		expect(result).toEqual({
			reasoning: true,
			thinkingLevelMap: { off: "none", max: null },
			source: "catalog",
		});
	});

	it("rejects protocol mismatches and conflicting exact matches", () => {
		expect(
			resolveCustomModelReasoning({
				mode: "auto",
				modelId: "same",
				api: "openai-responses",
				catalog: [{ id: "same", api: "openai-completions", reasoning: true }],
			}),
		).toEqual({ reasoning: false, source: "unrecognized" });
		expect(
			resolveCustomModelReasoning({
				mode: "auto",
				modelId: "same",
				api: "openai-responses",
				catalog: [
					{ id: "same", api: "openai-responses", reasoning: true, thinkingLevelMap: { high: "high" } },
					{ id: "same", api: "openai-responses", reasoning: false },
				],
			}),
		).toEqual({ reasoning: false, source: "unrecognized" });
	});

	it("accepts multiple exact matches with identical capabilities", () => {
		const result = resolveCustomModelReasoning({
			mode: "auto",
			modelId: "dup",
			api: "openai-responses",
			catalog: [
				{ id: "dup", api: "openai-responses", reasoning: true, thinkingLevelMap: { high: "high" } },
				{ id: "dup", api: "openai-responses", reasoning: true, thinkingLevelMap: { high: "high" } },
			],
		});
		expect(result.source).toBe("catalog");
		expect(result.reasoning).toBe(true);
	});

	it("maps explicit modes conservatively", () => {
		expect(resolveCustomModelReasoning({ mode: "off", modelId: "x", api: "openai-responses", catalog: [] })).toEqual({
			reasoning: false,
			source: "off",
		});
		expect(
			resolveCustomModelReasoning({ mode: "generic", modelId: "x", api: "openai-responses", catalog: [] }),
		).toEqual({ reasoning: true, thinkingLevelMap: { minimal: null }, source: "generic" });
	});

	it("does not share the catalog thinkingLevelMap object", () => {
		const thinkingLevelMap = { off: "none" };
		const result = resolveCustomModelReasoning({
			mode: "auto",
			modelId: "m",
			api: "openai-responses",
			catalog: [{ id: "m", api: "openai-responses", reasoning: true, thinkingLevelMap }],
		});
		expect(result.thinkingLevelMap).toEqual(thinkingLevelMap);
		expect(result.thinkingLevelMap).not.toBe(thinkingLevelMap);
	});

	it("manual normalizes every unconfigured level to explicit null", () => {
		const result = resolveCustomModelReasoning({
			mode: "manual",
			modelId: "custom",
			api: "openai-responses",
			catalog: [{ id: "custom", api: "openai-responses", reasoning: true }],
			thinkingLevelMap: { low: "low", high: " high ", max: null },
		});
		expect(result).toEqual({
			reasoning: true,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: null,
				high: " high ",
				xhigh: null,
				max: null,
			},
			source: "manual",
		});
	});

	it("manual rejects a map without any configured value", () => {
		expect(() =>
			resolveCustomModelReasoning({
				mode: "manual",
				modelId: "custom",
				api: "anthropic-messages",
				catalog: [],
				thinkingLevelMap: { off: null, low: "   " },
			}),
		).toThrow(/does not configure any thinking level value/);
	});
});
