import { describe, expect, it } from "vitest";
import { mapSimpleToolChoice } from "../src/api/simple-options.ts";
import type { SimpleStreamOptions } from "../src/types.ts";

describe("simple required tool choice", () => {
	const required: SimpleStreamOptions = { toolChoice: "required" };

	it("maps the common choice to provider tokens", () => {
		expect(mapSimpleToolChoice(required.toolChoice, "required")).toBe("required");
		expect(mapSimpleToolChoice(required.toolChoice, "any")).toBe("any");
		expect(mapSimpleToolChoice("auto", "any")).toBe("auto");
		expect(mapSimpleToolChoice("none", "required")).toBe("none");
		expect(mapSimpleToolChoice(undefined, "required")).toBeUndefined();
	});
});
