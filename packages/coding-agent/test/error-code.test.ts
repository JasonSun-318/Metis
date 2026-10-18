import { describe, expect, it } from "vitest";
import { errorCode } from "../src/core/error-code.ts";

describe("errorCode", () => {
	it("returns string codes from plain objects and Error subclasses", () => {
		expect(errorCode({ code: "ENOENT" })).toBe("ENOENT");
		expect(errorCode(Object.assign(new Error("permission denied"), { code: "EACCES" }))).toBe("EACCES");
		expect(errorCode(Object.assign(Object.create(null), { code: "ELOCKED" }))).toBe("ELOCKED");
	});

	it("reads inherited codes and keeps the original string conversion", () => {
		expect(errorCode(Object.create({ code: "EINHERITED" }))).toBe("EINHERITED");
		expect(errorCode({ code: 42 })).toBe("42");
		expect(errorCode({ code: undefined })).toBe("undefined");
		expect(errorCode({ code: null })).toBe("null");
		expect(
			errorCode({
				get code() {
					return "EGETTER";
				},
			}),
		).toBe("EGETTER");
	});

	it("returns undefined for values without an own or inherited code property", () => {
		expect(errorCode(undefined)).toBeUndefined();
		expect(errorCode(null)).toBeUndefined();
		expect(errorCode("ENOENT")).toBeUndefined();
		expect(errorCode(42)).toBeUndefined();
		expect(errorCode({})).toBeUndefined();
		expect(errorCode(Object.assign(() => {}, { code: "EFUNCTION" }))).toBeUndefined();
	});
});
