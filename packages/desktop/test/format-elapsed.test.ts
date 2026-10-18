import { describe, expect, it } from "vitest";
import { formatElapsed } from "../src/renderer/format-elapsed.ts";

describe("formatElapsed", () => {
	it.each([
		[0, "0s"],
		[999, "0s"],
		[1_000, "1s"],
		[59_999, "59s"],
		[60_000, "1m 0s"],
		[61_000, "1m 1s"],
		[90_000, "1m 30s"],
		[3_599_999, "59m 59s"],
		[3_600_000, "1h 0m"],
		[3_661_000, "1h 1m"],
		[86_400_000, "24h 0m"],
	])("formats %i milliseconds as %s", (milliseconds, expected) => {
		expect(formatElapsed(milliseconds)).toBe(expected);
	});

	it.each([-1, -1_000, -60_000, Number.NEGATIVE_INFINITY])(
		"clamps a negative elapsed time of %s to zero",
		(milliseconds) => {
			expect(formatElapsed(milliseconds)).toBe("0s");
		},
	);

	it("preserves the existing non-finite elapsed formatting", () => {
		expect(formatElapsed(Number.NaN)).toBe("NaNh NaNm");
		expect(formatElapsed(Number.POSITIVE_INFINITY)).toBe("Infinityh NaNm");
	});
});
