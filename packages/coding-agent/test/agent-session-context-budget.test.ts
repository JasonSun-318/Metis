import { describe, expect, it } from "vitest";
import { compactionHighWatermark, microcompactionPressureTarget } from "../src/core/agent-session-context-budget.ts";

describe("agent session context budget", () => {
	it("derives the high watermark from the context window and reserve", () => {
		expect(compactionHighWatermark(100_000, 20_000)).toBe(80_000);
		expect(compactionHighWatermark(undefined, 20_000)).toBe(-20_000);
	});

	it("only produces a pressure target above the high watermark", () => {
		expect(
			microcompactionPressureTarget({
				used: 70_000,
				contextWindow: 100_000,
				reserveTokens: 20_000,
				growthP95: 1_000,
			}),
		).toBeUndefined();
		const target = microcompactionPressureTarget({
			used: 95_000,
			contextWindow: 100_000,
			reserveTokens: 20_000,
			growthP95: 1_000,
		});
		expect(target).toBeDefined();
		expect(target?.low).toBeLessThan(95_000);
		expect(target?.minimumGain).toBeGreaterThan(0);
	});

	it("has no target without a usable context window", () => {
		expect(
			microcompactionPressureTarget({ used: 10_000, contextWindow: undefined, reserveTokens: 20_000, growthP95: 0 }),
		).toBeUndefined();
	});
});
