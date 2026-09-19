import { describe, expect, it } from "vitest";
import { getMicrocompactionTarget } from "../src/core/tool-result-microcompaction.ts";

describe("getMicrocompactionTarget", () => {
	it("prunes only at pressure and creates a lower rearm watermark", () => {
		expect(getMicrocompactionTarget({ used: 179_999, high: 180_000, growthP95: 5000 })).toBeUndefined();
		expect(getMicrocompactionTarget({ used: 180_000, high: 180_000, growthP95: 5000 })).toEqual({
			low: 160_000,
			minimumGain: 18_000,
		});
		expect(getMicrocompactionTarget({ used: 160_001, high: 180_000, growthP95: 5000 })).toBeUndefined();
		expect(getMicrocompactionTarget({ used: NaN, high: 180_000, growthP95: 0 })).toBeUndefined();
	});

	it("scales the runway with growth but caps it at a quarter of the window", () => {
		expect(getMicrocompactionTarget({ used: 400_000, high: 400_000, growthP95: 80_000 })).toEqual({
			low: 300_000,
			minimumGain: 20_000,
		});
		expect(getMicrocompactionTarget({ used: 400_000, high: 400_000, growthP95: 0 })).toEqual({
			low: 380_000,
			minimumGain: 20_000,
		});
	});
});
