import { afterEach, describe, expect, it } from "vitest";
import { areExperimentalFeaturesEnabled } from "../src/core/experimental.ts";

describe("areExperimentalFeaturesEnabled", () => {
	const originalArcMindExperimental = process.env.ARCMIND_EXPERIMENTAL;

	afterEach(() => {
		if (originalArcMindExperimental === undefined) {
			delete process.env.ARCMIND_EXPERIMENTAL;
		} else {
			process.env.ARCMIND_EXPERIMENTAL = originalArcMindExperimental;
		}
	});

	it("returns false when ARCMIND_EXPERIMENTAL is unset", () => {
		delete process.env.ARCMIND_EXPERIMENTAL;

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when ARCMIND_EXPERIMENTAL is empty", () => {
		process.env.ARCMIND_EXPERIMENTAL = "";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns true when ARCMIND_EXPERIMENTAL is set to 1", () => {
		process.env.ARCMIND_EXPERIMENTAL = "1";

		expect(areExperimentalFeaturesEnabled()).toBe(true);
	});

	it("returns false when ARCMIND_EXPERIMENTAL is set to 0", () => {
		process.env.ARCMIND_EXPERIMENTAL = "0";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});

	it("returns false when ARCMIND_EXPERIMENTAL is set to a non-1 value", () => {
		process.env.ARCMIND_EXPERIMENTAL = "true";

		expect(areExperimentalFeaturesEnabled()).toBe(false);
	});
});
