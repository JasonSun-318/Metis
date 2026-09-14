import { describe, expect, it } from "vitest";
import { getModel, getSupportedThinkingLevels } from "../src/compat.ts";

describe("generated native reasoning capabilities", () => {
	it.each([
		["openai-codex", "gpt-6-astra", "max"],
		["openai-codex", "gpt-5.5", "xhigh"],
		["google", "gemini-3.1-pro-preview", "high"],
	] as const)("ends %s/%s at %s", (provider, modelId, highest) => {
		const model = getModel(provider, modelId);
		expect(model).toBeDefined();
		expect(getSupportedThinkingLevels(model!).at(-1)).toBe(highest);
	});

	it("keeps Gemini 3.1 Pro on its two documented selectable efforts", () => {
		const model = getModel("google", "gemini-3.1-pro-preview")!;
		expect(getSupportedThinkingLevels(model)).toEqual(["low", "high"]);
	});
});
