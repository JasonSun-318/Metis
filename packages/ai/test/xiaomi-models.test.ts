import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getSupportedThinkingLevels } from "../src/compat.ts";
import { getFixtureModel, getFixtureModels } from "./model-catalog-fixtures.ts";

describe("Xiaomi MiMo models", () => {
	it("keeps mimo-v2.5-pro-ultraspeed on the API billing provider", () => {
		expect(getFixtureModel("xiaomi", "mimo-v2.5-pro-ultraspeed", "openai-completions")).toBeDefined();
	});

	it.each(["xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"] as const)(
		"omits API-billing-only models from %s",
		(provider) => {
			const modelIds = getFixtureModels(provider).map((model) => model.id);
			expect(modelIds).not.toContain("mimo-v2.5-pro-ultraspeed");
		},
	);

	it.each(["xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"] as const)(
		"exposes thinking levels for %s",
		(provider) => {
			const models = getFixtureModels(provider).filter((candidate) => candidate.reasoning);
			expect(models.length).toBeGreaterThan(0);
			for (const model of models) {
				expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high"]);
				expect(clampThinkingLevel(model, "minimal")).toBe("minimal");
			}
		},
	);
});
