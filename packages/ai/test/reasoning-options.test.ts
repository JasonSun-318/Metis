import { describe, expect, it } from "vitest";
import { getEffortThinkingLevelMap } from "../scripts/models-dev-reasoning-options.ts";

describe("getEffortThinkingLevelMap", () => {
	it("exposes only verified effort values and none", () => {
		expect(getEffortThinkingLevelMap([
			{ type: "toggle" },
			{ type: "effort", values: ["none", "low", "high", "max"] },
		])).toEqual({
			off: "none", minimal: null, low: "low", medium: null,
			high: "high", xhigh: null, max: "max",
		});
	});

	it("does not infer off and ignores toggle or budget-only metadata", () => {
		expect(getEffortThinkingLevelMap([{ type: "effort", values: ["low", "high"] }]))
			.toEqual({ off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: null });
		expect(getEffortThinkingLevelMap([{ type: "toggle" }])).toBeUndefined();
		expect(getEffortThinkingLevelMap([{ type: "budget_tokens", min: 1024, max: 32000 }])).toBeUndefined();
	});
});
