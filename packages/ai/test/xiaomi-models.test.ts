import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getModel, getModels, getSupportedThinkingLevels } from "../src/compat.ts";

describe("Xiaomi MiMo models", () => {
	it.each(["mimo-v2-flash", "mimo-v2-omni"] as const)("keeps %s on the API billing provider", (modelId) => {
		expect(getModel("xiaomi", modelId)).toBeDefined();
	});

	it.each(["xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"] as const)(
		"omits API-billing-only models from %s",
		(provider) => {
			const modelIds = getModels(provider).map((model) => model.id);
			expect(modelIds).not.toContain("mimo-v2-flash");
			expect(modelIds).not.toContain("mimo-v2-omni");
		},
	);

	it.each(["xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"] as const)(
		"excludes unsupported minimal reasoning from %s",
		(provider) => {
			for (const model of getModels(provider).filter((candidate) => candidate.reasoning)) {
				expect(getSupportedThinkingLevels(model)).toEqual(["off", "low", "medium", "high"]);
				expect(clampThinkingLevel(model, "minimal")).toBe("low");
			}
		},
	);
});
