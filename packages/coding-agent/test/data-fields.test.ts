import { describe, expect, it } from "vitest";
import { dataFields } from "../src/core/data-fields.ts";
import { parseRuntimeControlEntry } from "../src/core/runtime-recovery.ts";
import { parseSessionControlEntry } from "../src/core/session-control.ts";

describe("dataFields", () => {
	it("collects own enumerable data properties in reflection order", () => {
		const value = { second: 2, first: 1, explicitUndefined: undefined };
		const fields = dataFields(value);

		expect(fields).toBeInstanceOf(Map);
		expect([...fields.entries()]).toEqual([
			["second", 2],
			["first", 1],
			["explicitUndefined", undefined],
		]);
	});

	it("accepts objects with a null prototype", () => {
		const value = Object.assign(Object.create(null), { code: "ENOENT" });
		expect([...dataFields(value).entries()]).toEqual([["code", "ENOENT"]]);
	});

	it("uses the session control label by default and includes custom labels in errors", () => {
		expect(() => dataFields(null)).toThrow("Session control entry must be an object");
		expect(() => dataFields([], "runtime entry")).toThrow("runtime entry must be an object");
		expect(() => dataFields(new Date(), "runtime entry")).toThrow("runtime entry must be a plain object");
	});

	it("rejects symbol fields", () => {
		expect(() => dataFields({ [Symbol("extra")]: true }, "runtime entry")).toThrow(
			"runtime entry must not contain symbol fields",
		);
	});

	it("rejects non-enumerable and accessor properties without invoking getters", () => {
		const hidden = {};
		Object.defineProperty(hidden, "hidden", { value: 1, enumerable: false });
		expect(() => dataFields(hidden, "runtime entry")).toThrow(
			"runtime entry must contain only enumerable data properties",
		);

		let getterCalls = 0;
		const accessor = {
			get value() {
				getterCalls += 1;
				return "not allowed";
			},
		};
		expect(() => dataFields(accessor, "runtime entry")).toThrow(
			"runtime entry must contain only enumerable data properties",
		);
		expect(getterCalls).toBe(0);
	});

	it("preserves each public parser's validation label", () => {
		expect(() => parseSessionControlEntry(null)).toThrow(new TypeError("Session control entry must be an object"));
		expect(() => parseRuntimeControlEntry(null)).toThrow(new TypeError("runtime control entry must be an object"));
	});

	it("preserves the parsers' different handling of empty unknown field names", () => {
		const control = {
			type: "session_permission_preset",
			id: "control-1",
			parentId: null,
			timestamp: "2026-01-01T00:00:00.000Z",
			permissionPreset: "ask",
		};
		expect(parseSessionControlEntry({ ...control, "": true })).toEqual(control);
		expect(() => parseRuntimeControlEntry({ type: "runtime_tool", "": true })).toThrow(
			/runtime tool entry.*unknown field/,
		);
	});
});
