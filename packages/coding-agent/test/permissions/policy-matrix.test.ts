import { describe, expect, it } from "vitest";
import {
	normalizePermissionAction,
	PermissionPolicy,
	type PermissionPreset,
	type RiskLevel,
	settingsForPreset,
} from "../../src/core/permissions/index.ts";
import {
	actionInput,
	externalWrite,
	ordinaryRead,
	outsideRead,
	protectedWrite,
	rootRecursiveDelete,
	sensitiveRead,
	workspaceWrite,
} from "./fixtures.ts";

type ExpectedKind = "allow" | "review" | "deny";

describe("permission policy matrix", () => {
	const cases: readonly [string, PermissionPreset, ReturnType<typeof ordinaryRead>, ExpectedKind, RiskLevel][] = [
		["ordinary read in Ask", "ask", ordinaryRead(), "allow", "low"],
		["ordinary read in Auto", "auto", ordinaryRead(), "allow", "low"],
		["ordinary read in Full", "full", ordinaryRead(), "allow", "low"],
		["workspace write in Ask", "ask", workspaceWrite(), "review", "low"],
		["workspace write in Auto", "auto", workspaceWrite(), "allow", "low"],
		["workspace write in Full", "full", workspaceWrite(), "allow", "low"],
		["outside read in Ask", "ask", outsideRead(), "review", "medium"],
		["outside read in Auto", "auto", outsideRead(), "review", "medium"],
		["outside read in Full", "full", outsideRead(), "allow", "medium"],
		["sensitive read in Ask", "ask", sensitiveRead(), "review", "critical"],
		["sensitive read in Auto", "auto", sensitiveRead(), "review", "critical"],
		["sensitive read in Full", "full", sensitiveRead(), "review", "critical"],
		["external side effect in Ask", "ask", externalWrite(), "review", "high"],
		["external side effect in Auto", "auto", externalWrite(), "review", "high"],
		["external side effect in Full", "full", externalWrite(), "review", "high"],
		["root recursive delete in Ask", "ask", rootRecursiveDelete(), "deny", "critical"],
		["root recursive delete in Auto", "auto", rootRecursiveDelete(), "deny", "critical"],
		["root recursive delete in Full", "full", rootRecursiveDelete(), "deny", "critical"],
		["protected metadata write in Ask", "ask", protectedWrite(), "deny", "critical"],
		["protected metadata write in Auto", "auto", protectedWrite(), "deny", "critical"],
		["protected metadata write in Full", "full", protectedWrite(), "deny", "critical"],
	];

	it.each(cases)("routes %s", (_name, preset, action, kind, riskLevel) => {
		const result = new PermissionPolicy().evaluate({ settings: settingsForPreset(preset), action });
		expect(result).toMatchObject({ kind, riskLevel });
	});

	it.each(["ask", "auto", "full"] as const)("allows an explicitly scoped read-only MCP action in %s", (preset) => {
		const action = normalizePermissionAction(
			actionInput({ provenance: "mcp", toolIdentity: "mcp:docs:read:v1", effects: [] }),
		);
		expect(new PermissionPolicy().evaluate({ settings: settingsForPreset(preset), action })).toMatchObject({
			kind: "allow",
			grant: { executionTarget: "external" },
		});
	});

	it.each([
		["ask", "review", "sandbox"],
		["auto", "allow", "sandbox"],
		["full", "allow", "host"],
	] as const)("routes a non-destructive shell in %s", (preset, kind, executionTarget) => {
		const action = normalizePermissionAction(
			actionInput({
				toolName: "bash",
				toolIdentity: "builtin:bash:v1",
				args: { command: "pwd" },
				command: "pwd",
				readPaths: [],
			}),
		);
		expect(new PermissionPolicy().evaluate({ settings: settingsForPreset(preset), action })).toMatchObject({
			kind,
			riskLevel: "low",
			grant: { executionTarget },
		});
	});

	it.each([
		["ask", "review", "user", "sandbox"],
		["auto", "review", "user", "sandbox"],
		["full", "allow", undefined, "host"],
	] as const)("routes exact non-mutating network access in %s", (preset, kind, minimumReviewer, executionTarget) => {
		const action = normalizePermissionAction(
			actionInput({ networkEndpoints: [{ hostname: "api.example.com", port: 443 }] }),
		);
		expect(new PermissionPolicy().evaluate({ settings: settingsForPreset(preset), action })).toMatchObject({
			kind,
			riskLevel: "medium",
			...(minimumReviewer ? { minimumReviewer } : {}),
			grant: { executionTarget },
		});
	});

	it.each([
		["ask", "review", "user"],
		["auto", "review", "user"],
		["full", "review", "user"],
	] as const)("routes bounded destructive operations in %s", (preset, kind, minimumReviewer) => {
		const action = normalizePermissionAction(
			actionInput({ writePaths: [`${actionInput().cwd}/build`], effects: ["destructive"] }),
		);
		expect(new PermissionPolicy().evaluate({ settings: settingsForPreset(preset), action })).toMatchObject({
			kind,
			riskLevel: "high",
			minimumReviewer,
		});
	});

	it.each([
		["outside write", { writePaths: ["/outside/output.txt"] }],
		["external side effect", { effects: ["external-side-effect"] as const }],
	])("sends review-required %s directly to the user in Auto", (_name, scope) => {
		const action = normalizePermissionAction(actionInput(scope));
		expect(new PermissionPolicy().evaluate({ settings: settingsForPreset("auto"), action })).toMatchObject({
			kind: "review",
			minimumReviewer: "user",
		});
	});

	it("keeps model review for ordinary outside reads in Auto", () => {
		expect(
			new PermissionPolicy().evaluate({ settings: settingsForPreset("auto"), action: outsideRead() }),
		).toMatchObject({ kind: "review", minimumReviewer: "model" });
	});

	it.each(["sensitive-read", "elevation", "security-weakening", "payment", "production-mutation"] as const)(
		"always sends %s to a user reviewer",
		(effect) => {
			const action = normalizePermissionAction(
				actionInput({
					readPaths: effect === "sensitive-read" ? actionInput().readPaths : [],
					writePaths: effect === "production-mutation" ? actionInput().workspaceRoots : [],
					effects: [effect],
				}),
			);
			for (const preset of ["ask", "auto", "full"] as const) {
				expect(new PermissionPolicy().evaluate({ settings: settingsForPreset(preset), action })).toMatchObject({
					kind: "review",
					riskLevel: "critical",
					minimumReviewer: "user",
				});
			}
		},
	);
});
