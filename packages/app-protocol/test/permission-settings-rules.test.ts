import { describe, expect, it } from "vitest";
import { validateClientRequest, validateResponseFor } from "../src/index.ts";

const requestId = "11111111-1111-4111-8111-111111111111";
const rule = {
	id: "C03",
	kind: "command",
	origin: "default",
	name: "ls",
	enabled: true,
	modes: ["auto"],
	scope: "workspace",
	directories: [],
	command: "ls",
	allowNetwork: false,
};
const update = (permissionRules: unknown[]) => ({
	jsonrpc: "2.0",
	id: "rules-update",
	method: "permission/auto/update",
	params: { requestId, permissionRules },
});

describe("managed permission rules protocol", () => {
	it("accepts an explicit empty list and independent reviewer switch patches", () => {
		expect(validateClientRequest(update([]))).toEqual(update([]));
		const request = { ...update([]), params: { requestId, reviewerEnabled: false } };
		expect(validateClientRequest(request)).toEqual(request);
	});

	it("accepts scoped rules and rejects view metadata, unsupported modes, and competing rule patches", () => {
		expect(validateClientRequest(update([rule]))).toEqual(update([rule]));
		for (const invalid of [
			{ ...rule, support: "supported" },
			{ ...rule, modes: ["full"] },
			{ ...rule, modes: [] },
			{ ...rule, scope: "host-anything" },
			{ ...rule, enabled: "true" },
		])
			expect(() => validateClientRequest(update([invalid]))).toThrow();
		expect(() =>
			validateClientRequest({ ...update([rule]), params: { ...update([rule]).params, rules: [] } }),
		).toThrow();
	});

	it("bounds the total list while allowing the complete default and custom allocation", () => {
		expect(() =>
			validateClientRequest(
				update(Array.from({ length: 115 }, (_, index) => ({ ...structuredClone(rule), id: `user-${index}` }))),
			),
		).not.toThrow();
		expect(() =>
			validateClientRequest(
				update(Array.from({ length: 116 }, (_, index) => ({ ...structuredClone(rule), id: `user-${index}` }))),
			),
		).toThrow();
	});

	it("exposes support information and default templates separately from editable rule data", () => {
		const request = { jsonrpc: "2.0", id: "rules-get", method: "permission/auto/get", params: {} };
		const result = {
			rules: [],
			suggestions: ["ls"],
			reviewerEnabled: false,
			permissionRules: [{ ...structuredClone(rule), support: "supported" }],
			permissionRuleDefaults: [{ ...structuredClone(rule), support: "supported" }],
		};
		expect(validateResponseFor("client", request, { jsonrpc: "2.0", id: "rules-get", result })).toMatchObject({
			result,
		});
		expect(() =>
			validateResponseFor("client", request, {
				jsonrpc: "2.0",
				id: "rules-get",
				result: { ...result, permissionRules: [{ ...rule, support: "claimed-safe" }] },
			}),
		).toThrow();
	});
});
