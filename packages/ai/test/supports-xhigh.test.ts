import { describe, expect, it } from "vitest";
import { getSupportedThinkingLevels } from "../src/compat.ts";
import { getFixtureModel } from "./model-catalog-fixtures.ts";

describe("getSupportedThinkingLevels", () => {
	it("includes max but not xhigh for Anthropic Opus 4.6 on anthropic-messages API", () => {
		const model = getFixtureModel("anthropic", "claude-opus-4-6", "anthropic-messages");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("max");
		expect(getSupportedThinkingLevels(model!)).not.toContain("xhigh");
	});

	it("includes xhigh and max for Anthropic Opus 4.8 on anthropic-messages API", () => {
		const model = getFixtureModel("anthropic", "claude-opus-4-8", "anthropic-messages");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).toContain("max");
	});

	it("includes max but not xhigh for Anthropic Sonnet 4.6 on anthropic-messages API", () => {
		const model = getFixtureModel("anthropic", "claude-sonnet-4-6", "anthropic-messages");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("max");
		expect(getSupportedThinkingLevels(model!)).not.toContain("xhigh");
	});

	it("includes xhigh and max for Anthropic Sonnet 5 on anthropic-messages API", () => {
		const model = getFixtureModel("anthropic", "claude-sonnet-5", "anthropic-messages");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).toContain("max");
	});

	it("includes xhigh and max but not off for Anthropic Claude Fable 5 on anthropic-messages API", () => {
		const model = getFixtureModel("anthropic", "claude-fable-5", "anthropic-messages");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).toContain("max");
		expect(getSupportedThinkingLevels(model!)).not.toContain("off");
	});

	it("does not include xhigh or max for Claude Sonnet 4.5", () => {
		const model = getFixtureModel("anthropic", "claude-sonnet-4-5", "anthropic-messages");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).not.toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).not.toContain("max");
	});

	it.each(["gpt-5.3-codex-spark", "gpt-5.5", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-6-astra"] as const)(
		"includes xhigh for openai-codex %s models",
		(modelId) => {
			const model = getFixtureModel("openai-codex", modelId, "openai-codex-responses");
			expect(model).toBeDefined();
			expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		},
	);

	it.each(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const)(
		"includes xhigh and max for OpenAI %s models",
		(modelId) => {
			const model = getFixtureModel("openai", modelId, "openai-responses");
			expect(model).toBeDefined();
			expect(getSupportedThinkingLevels(model!)).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
		},
	);

	it("includes only medium/high/xhigh for OpenAI GPT-5.5 Pro", () => {
		const model = getFixtureModel("openai", "gpt-5.5-pro", "openai-responses");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["medium", "high", "xhigh"]);
	});

	it("includes only medium/high/xhigh for OpenRouter GPT-5.5 Pro", () => {
		const model = getFixtureModel("openrouter", "openai/gpt-5.5-pro", "openai-completions");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["medium", "high", "xhigh"]);
	});

	it("includes only low/high/max plus off for DeepSeek V4.1 Flash on the DeepSeek provider", () => {
		const model = getFixtureModel("deepseek", "deepseek-flash", "openai-completions");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "low", "high", "max"]);
	});

	it("includes only low/high/max plus off for DeepSeek V4 Flash on opencode-go", () => {
		const model = getFixtureModel("opencode-go", "deepseek-v4-flash", "openai-completions");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "low", "high", "max"]);
	});

	it("includes only high plus off for OpenCode Go Kimi K2.6", () => {
		const model = getFixtureModel("opencode-go", "kimi-k2.6", "openai-completions");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "high"]);
	});

	it("excludes thinking off for Moonshot Kimi K2.7 Code models", () => {
		const cases = [
			getFixtureModel("moonshotai", "kimi-k2.7-code", "openai-completions"),
			getFixtureModel("moonshotai-cn", "kimi-k2.7-code", "openai-completions"),
		];

		for (const model of cases) {
			expect(model).toBeDefined();
			expect(getSupportedThinkingLevels(model!)).toEqual(["minimal", "low", "medium", "high"]);
		}
	});

	it("includes only high for OpenCode Grok Build", () => {
		const model = getFixtureModel("opencode", "grok-build-0.1", "openai-responses");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["high"]);
	});

	it("includes only high/xhigh plus off for DeepSeek V4 Flash on OpenRouter", () => {
		const model = getFixtureModel("openrouter", "deepseek/deepseek-v4-flash", "openai-completions");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toEqual(["off", "high", "xhigh"]);
	});

	it("includes max but not xhigh for OpenRouter Opus 4.6 (anthropic-messages API)", () => {
		const model = getFixtureModel("openrouter", "anthropic/claude-opus-4.6", "anthropic-messages");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("max");
		expect(getSupportedThinkingLevels(model!)).not.toContain("xhigh");
	});

	it("includes xhigh and max but not off for Bedrock Claude Fable 5", () => {
		const model = getFixtureModel("amazon-bedrock", "global.anthropic.claude-fable-5", "bedrock-converse-stream");
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!)).toContain("xhigh");
		expect(getSupportedThinkingLevels(model!)).toContain("max");
		expect(getSupportedThinkingLevels(model!)).not.toContain("off");
	});
});
