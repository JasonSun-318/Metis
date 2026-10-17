import { expect, test } from "vitest";
import { getMetisEnv } from "../src/config.ts";

test("Metis environment values ignore retired ArcMind names", () => {
	expect(getMetisEnv("OFFLINE", { METIS_OFFLINE: "0", ARCMIND_OFFLINE: "1" })).toBe("0");
	expect(getMetisEnv("OFFLINE", { ARCMIND_OFFLINE: "1" })).toBeUndefined();
});
