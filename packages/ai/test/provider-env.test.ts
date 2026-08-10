import { describe, expect, it } from "vitest";
import { getMetisProviderEnvValue } from "../src/utils/provider-env.ts";

describe("Metis provider environment", () => {
	it("uses only the Metis name", () => {
		expect(
			getMetisProviderEnvValue("CACHE_RETENTION", {
				METIS_CACHE_RETENTION: "short",
				ARCMIND_CACHE_RETENTION: "long",
			}),
		).toBe("short");
		expect(getMetisProviderEnvValue("CACHE_RETENTION", { ARCMIND_CACHE_RETENTION: "long" })).toBeUndefined();
	});
});
