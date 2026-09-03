import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PermissionPolicy } from "../src/core/permissions/policy.ts";
import {
	assertToolPermissionDescriptor,
	createToolIdentity,
	describeToolAction,
	permissionClaim,
	permissionDescriptor,
} from "../src/core/tool-permission-adapter.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import {
	definitionWithoutPermission,
	identityInput,
	invoke,
	permissionProject,
	toolWithThrowingDescriptor,
	toolWithUnknownDynamicTarget,
	toolWithWildcardNetwork,
} from "./tool-permission-fixtures.ts";

const bashDefinition = createBashToolDefinition(permissionProject);

function describeBash(command: string) {
	return describeToolAction(
		bashDefinition,
		{ command },
		{
			actionId: `bash-${command}`,
			cwd: permissionProject,
			workspaceRoots: [permissionProject],
			provenance: "builtin",
			toolIdentity: createToolIdentity(identityInput({ toolName: "bash" })),
		},
	);
}

describe("tool permission adapter", () => {
	it("rejects an executable tool without a permission descriptor", () => {
		expect(() => assertToolPermissionDescriptor(definitionWithoutPermission())).toThrow("permission descriptor");
	});

	it("fails closed before execution for throwing, wildcard, and incomplete descriptors", async () => {
		const execution = vi.fn();
		for (const [tool, error] of [
			[toolWithThrowingDescriptor(), "Permission action could not be described"],
			[toolWithWildcardNetwork(), "exact"],
			[toolWithUnknownDynamicTarget(), "scope is incomplete"],
		] as const) {
			tool.execute = execution;
			await expect(invoke(tool)).rejects.toThrow(error);
		}
		expect(execution).not.toHaveBeenCalled();
	});

	it("binds identity to source, implementation, and descriptor versions", () => {
		const baseline = createToolIdentity(identityInput());
		for (const input of [
			identityInput({ sourceIdentity: "other-package" }),
			identityInput({ implementationVersion: "2" }),
			identityInput({ descriptorVersion: 2 }),
		]) {
			expect(createToolIdentity(input)).not.toBe(baseline);
		}
	});

	it("normalizes parsed parameters and owns immutable canonical scope copies", () => {
		const readPaths = ["./data", "./data"];
		const definition = {
			name: "canonical_tool",
			label: "Canonical tool",
			description: "Canonical fixture",
			parameters: { type: "object" } as any,
			permission: permissionDescriptor<{ target: string }>(() => permissionClaim({ readPaths })),
			execute: vi.fn(),
		};
		const action = describeToolAction(
			definition,
			{ target: "parsed" },
			{
				actionId: "canonical-action",
				cwd: permissionProject,
				workspaceRoots: [permissionProject, permissionProject],
				provenance: "sdk",
				toolIdentity: createToolIdentity(identityInput({ toolName: definition.name })),
			},
		);
		readPaths.push("./forged");
		expect(action.readPaths).toEqual([join(permissionProject, "data")]);
		expect(action.workspaceRoots).toEqual([permissionProject]);
		expect(action.argsDigest).toMatch(/^[a-f0-9]{64}$/u);
		expect(Object.isFrozen(action.readPaths)).toBe(true);
	});

	it("redacts descriptor exceptions", async () => {
		await expect(invoke(toolWithThrowingDescriptor())).rejects.not.toThrow("secret descriptor detail");
	});

	it("classifies exact read-only HTTP fetch as network scope without an external mutation", () => {
		const action = describeBash("curl https://example.com/data");
		expect(action.networkEndpoints).toEqual([{ hostname: "example.com", port: 443 }]);
		expect(action.effects).not.toContain("external-side-effect");
		expect(action.effects).not.toContain("unknown");
	});

	it.each([
		"curl -X DELETE https://example.com/item",
		"curl --data value https://example.com/item",
		"curl -dvalue https://example.com/item",
		"curl -Ffile=@payload.txt https://example.com/item",
		"curl -Tpayload.txt https://example.com/item",
		`curl --json '{"enabled":true}' https://example.com/item`,
		"curl -Krequest.cfg https://example.com/item",
		"curl --config=request.cfg https://example.com/item",
		"curl -X GET -X DELETE https://example.com/item",
		"wget --post-data=value https://example.com/item",
		"wget --config=request.cfg https://example.com/item",
		"git push origin main",
		"npm publish",
	])("keeps known network mutations high risk: %s", (command) => {
		expect(
			bashDefinition.permission.describe(
				{ command },
				{ actionId: `bash-${command}`, cwd: permissionProject, workspaceRoots: [permissionProject] },
			).effects,
		).toContain("external-side-effect");
	});

	it.each([
		"curl -dvalue https://example.com/item",
		"curl -Ffile=@payload.txt https://example.com/item",
		"curl -Tpayload.txt https://example.com/item",
		`curl --json '{"enabled":true}' https://example.com/item`,
		"curl -Krequest.cfg https://example.com/item",
		"curl --config=request.cfg https://example.com/item",
	])("does not let an Auto curl rule bypass a known mutation: %s", (command) => {
		const decision = new PermissionPolicy().evaluate({
			settings: { sandboxPolicy: "workspace-write", approvalPolicy: "auto-review" },
			action: describeBash(command),
			autoCommandRules: [{ command: "curl", allowNetwork: true }],
		});
		expect(decision.kind).not.toBe("allow");
	});

	it("keeps an env-wrapped network mutation out of the Auto fast path", () => {
		const command = "env curl -dvalue https://example.com/item";
		const action = describeBash(command);
		expect(action.effects).toContain("external-side-effect");
		expect(
			new PermissionPolicy().evaluate({
				settings: { sandboxPolicy: "workspace-write", approvalPolicy: "auto-review" },
				action,
				autoCommandRules: [{ command: "env", allowNetwork: true }],
			}).kind,
		).not.toBe("allow");
	});

	it.each([
		`bash -c 'curl --json "{}" https://example.com/item'`,
		"find /tmp -exec curl -Tpayload.txt https://example.com/item \\;",
	])("fails closed when a wrapper makes network mutation scope incomplete: %s", (command) => {
		expect(() => describeBash(command)).toThrow("scope is incomplete");
	});

	it("fails closed for an unresolved network endpoint", () => {
		expect(() => describeBash('curl "$URL"')).toThrow("scope is incomplete");
	});
});
