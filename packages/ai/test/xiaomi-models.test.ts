import { describe, expect, it } from "vitest";
import { clampThinkingLevel, getModel, getModels, getSupportedThinkingLevels } from "../src/compat.ts";

describe("Xiaomi MiMo models", () => {
	it("keeps mimo-v2.5-pro-ultraspeed on the API billing provider", () => {
		expect(getModel("xiaomi", "mimo-v2.5-pro-ultraspeed")).toBeDefined();
	});

	it.each(["xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"] as const)(
		"omits API-billing-only models from %s",
		(provider) => {
			const modelIds = getModels(provider).map((model) => model.id);
			expect(modelIds).not.toContain("mimo-v2.5-pro-ultraspeed");
		},
	);

	it.each(["xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"] as const)(
		"exposes thinking levels for %s",
		(provider) => {
			for (const model of getModels(provider).filter((candidate) => candidate.reasoning)) {
				expect(getSupportedThinkingLevels(model)).toEqual(["off", "minimal", "low", "medium", "high"]);
				expect(clampThinkingLevel(model, "minimal")).toBe("minimal");
			}
		},
	);
});
