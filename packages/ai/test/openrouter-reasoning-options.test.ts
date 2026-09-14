import { describe, expect, it } from "vitest";
import { getOpenRouterThinkingLevelMap } from "../scripts/openrouter-reasoning-options.ts";

describe("getOpenRouterThinkingLevelMap", () => {
	it("hides off and unsupported efforts for mandatory reasoning", () => {
		expect(getOpenRouterThinkingLevelMap({ mandatory: true, supported_efforts: ["low", "high", "max"] }))
			.toEqual({ off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" });
	});

	it("keeps off for optional reasoning and does not invent effort metadata", () => {
		expect(getOpenRouterThinkingLevelMap({ mandatory: false, supported_efforts: ["low", "high"] }))
			.toEqual({ off: "none", minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null });
		expect(getOpenRouterThinkingLevelMap({ mandatory: false })).toBeUndefined();
	});
});
