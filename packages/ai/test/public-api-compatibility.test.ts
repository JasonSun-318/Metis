import { describe, expect, it } from "vitest";
import { mapStopReasonString } from "../src/api/google-shared.ts";
import { getApiProviders, registerFauxProvider } from "../src/compat.ts";
import { getOverflowPatterns } from "../src/index.ts";

it("enumerates registered compatibility providers", () => {
	const provider = registerFauxProvider({ api: "legacy-api-contract" });
	try {
		expect(getApiProviders().some((entry) => entry.api === provider.api)).toBe(true);
	} finally {
		provider.unregister();
	}
	expect(getApiProviders().some((entry) => entry.api === provider.api)).toBe(false);
});

it("returns an independent overflow pattern list", () => {
	const patterns = getOverflowPatterns();
	const length = patterns.length;
	expect(length).toBeGreaterThan(0);
	expect(patterns.every((pattern) => pattern instanceof RegExp)).toBe(true);
	patterns.length = 0;
	expect(getOverflowPatterns()).toHaveLength(length);
});

describe("string stop reason compatibility", () => {
	it.each([
		["STOP", "stop"],
		["MAX_TOKENS", "length"],
		["SAFETY", "error"],
		["unknown", "error"],
	] as const)("maps %s to %s", (reason, expected) => {
		expect(mapStopReasonString(reason)).toBe(expected);
	});
});
