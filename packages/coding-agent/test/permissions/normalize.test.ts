import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertCompleteAction,
	canonicalJson,
	digestCanonical,
	digestPermissionAction,
	normalizePermissionAction,
} from "../../src/core/permissions/index.ts";
import { digestRememberedPermissionAction } from "../../src/core/permissions/normalize.ts";
import { canonicalizeActionPath } from "../../src/utils/paths.ts";
import { actionInput, projectDir } from "./fixtures.ts";

describe("permission action normalization", () => {
	it("produces stable canonical JSON and digests for object keys in different insertion order", () => {
		expect(canonicalJson({ b: 2, nested: { d: 4, c: 3 }, a: 1 })).toBe(
			canonicalJson({ a: 1, nested: { c: 3, d: 4 }, b: 2 }),
		);
		expect(digestCanonical({ b: 2, a: 1 })).toBe(digestCanonical({ a: 1, b: 2 }));
	});

	it("keeps remembered identities across analyzer metadata enrichment while binding execution facts", () => {
		const input = actionInput({
			toolName: "bash",
			toolIdentity: "builtin:bash:v1",
			command: "ls",
			shellAnalysis: {
				disposition: "safe",
				complete: true,
				commands: [{ argv: ["ls"], complete: true, disposition: "safe", effects: [], networkEndpoints: [] }],
			},
		});
		const before = normalizePermissionAction(input);
		const enriched = normalizePermissionAction({
			...input,
			shellAnalysis: { ...input.shellAnalysis!, readPaths: [projectDir] },
		});
		expect(digestRememberedPermissionAction(enriched)).toBe(digestPermissionAction(before));
		expect(digestPermissionAction(enriched)).not.toBe(digestPermissionAction(before));
		const outside = normalizePermissionAction({
			...input,
			readPaths: [join(projectDir, "..", "outside.txt")],
			shellAnalysis: { ...input.shellAnalysis!, readPaths: [join(projectDir, "..", "outside.txt")] },
		});
		expect(digestRememberedPermissionAction(outside)).not.toBe(digestRememberedPermissionAction(before));
	});

	it.each([
		{ hostname: "*.example.com", port: 443 },
		{ hostname: "", port: 443 },
		{ hostname: "user@example.com", port: 443 },
		{ hostname: "example.com", port: 0 },
		{ hostname: "example.com", port: 65_536 },
	])("rejects incomplete, credentialed, wildcard, or invalid network endpoints", (endpoint) => {
		expect(() => normalizePermissionAction(actionInput({ networkEndpoints: [endpoint] }))).toThrow();
	});

	it("normalizes hostnames and exact endpoint sets", () => {
		const action = normalizePermissionAction(
			actionInput({
				networkEndpoints: [
					{ hostname: "EXAMPLE.COM.", port: 443 },
					{ hostname: "example.com", port: 443 },
				],
			}),
		);
		expect(action.networkEndpoints).toEqual([{ hostname: "example.com", port: 443 }]);
	});

	it("canonicalizes paths, deduplicates set-like fields, and rejects NUL bytes", () => {
		const action = normalizePermissionAction(
			actionInput({
				workspaceRoots: [projectDir, projectDir],
				writePaths: ["./src", "./src"],
				effects: ["destructive", "destructive"],
			}),
		);
		expect(action.workspaceRoots).toEqual([canonicalizeActionPath(projectDir, projectDir)]);
		expect(action.writePaths).toEqual([canonicalizeActionPath("./src", projectDir)]);
		expect(action.effects).toEqual(["destructive"]);
		expect(() => normalizePermissionAction(actionInput({ readPaths: ["bad\0path"] }))).toThrow("NUL");
	});

	it("binds the full normalized action to a stable digest", () => {
		const first = normalizePermissionAction(actionInput());
		const second = normalizePermissionAction(actionInput({ args: { path: join(projectDir, "README.md") } }));
		const laterInvocation = normalizePermissionAction(actionInput({ actionId: "action-2" }));
		expect(digestPermissionAction(first)).toMatch(/^[a-f0-9]{64}$/);
		expect(digestPermissionAction(first)).toBe(digestPermissionAction(second));
		expect(digestPermissionAction(first)).toBe(digestPermissionAction(laterInvocation));
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.readPaths)).toBe(true);
	});

	it("normalizes trusted analyzer read paths and binds them to the action digest", () => {
		const input = actionInput({
			toolName: "bash",
			toolIdentity: "builtin:bash:v1",
			args: { command: "grep -r secret" },
			command: "grep -r secret",
			readPaths: [],
			shellAnalysis: {
				disposition: "safe",
				complete: true,
				commands: [],
				readPaths: [join(projectDir, "."), projectDir, projectDir],
			},
		});
		const action = normalizePermissionAction(input);
		expect(action.shellAnalysis?.readPaths).toEqual([canonicalizeActionPath(projectDir, projectDir)]);
		expect(Object.isFrozen(action.shellAnalysis?.readPaths)).toBe(true);
		const elsewhere = normalizePermissionAction({
			...input,
			shellAnalysis: { ...input.shellAnalysis!, readPaths: [join(projectDir, "src")] },
		});
		expect(digestPermissionAction(action)).not.toBe(digestPermissionAction(elsewhere));
	});

	it("rejects ambiguous canonical inputs instead of hashing partial data", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		const sparse = new Array(2);
		sparse[1] = "value";
		const accessorArray = ["safe"];
		Object.defineProperty(accessorArray, 0, { enumerable: true, get: () => "surprise" });

		for (const value of [
			undefined,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			() => undefined,
			cyclic,
			sparse,
			accessorArray,
			new Date(),
		]) {
			expect(() => canonicalJson(value)).toThrow();
		}
		expect(() => digestCanonical({ payload: "x".repeat(256 * 1024) })).toThrow("256 KiB");
	});

	it("marks unknown effects and empty identities as incomplete", () => {
		const unknown = normalizePermissionAction(actionInput({ effects: ["unknown"] }));
		expect(digestPermissionAction(unknown)).toMatch(/^[a-f0-9]{64}$/);
		expect(() => assertCompleteAction(unknown)).toThrow("Permission action scope is incomplete");
		expect(() => normalizePermissionAction(actionInput({ toolIdentity: " " }))).toThrow("toolIdentity");
	});

	it("bounds scope cardinality and the complete normalized action", () => {
		expect(() =>
			normalizePermissionAction(
				actionInput({ readPaths: Array.from({ length: 4_097 }, (_, index) => `p${index}`) }),
			),
		).toThrow("too many entries");
		expect(() =>
			normalizePermissionAction(
				actionInput({
					readPaths: Array.from({ length: 20 }, (_, index) => `${"x".repeat(16_000)}${index}`),
				}),
			),
		).toThrow("256 KiB");
	});

	it("keeps every action scope immutable and digest-stable", () => {
		const action = normalizePermissionAction(
			actionInput({
				writePaths: [join(projectDir, "out.txt")],
				networkEndpoints: [{ hostname: "api.example.com", port: 443 }],
				effects: ["external-side-effect"],
			}),
		);
		const before = digestPermissionAction(action);
		for (const scope of [
			action.workspaceRoots,
			action.readPaths,
			action.writePaths,
			action.networkEndpoints,
			action.effects,
		]) {
			expect(() => (scope as unknown[]).push("forged")).toThrow();
		}
		expect(() => {
			(action.networkEndpoints[0] as { hostname: string }).hostname = "attacker.example";
		}).toThrow();
		expect(digestPermissionAction(action)).toBe(before);
	});

	it("rejects deeply frozen values that violate normalization invariants", () => {
		const action = normalizePermissionAction(actionInput());
		const unknownEffect = Object.freeze({ ...action, effects: Object.freeze(["made-up-effect"]) });
		const credentialedEndpoint = Object.freeze({
			...action,
			networkEndpoints: Object.freeze([Object.freeze({ hostname: "user@example.com", port: 443 })]),
		});
		expect(() => assertCompleteAction(unknownEffect as typeof action)).toThrow("incomplete");
		expect(() => assertCompleteAction(credentialedEndpoint as typeof action)).toThrow("incomplete");
	});
});
