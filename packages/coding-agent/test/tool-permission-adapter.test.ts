import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	assertToolPermissionDescriptor,
	createToolIdentity,
	describeToolAction,
	permissionClaim,
	permissionDescriptor,
} from "../src/core/tool-permission-adapter.ts";
import {
	definitionWithoutPermission,
	identityInput,
	invoke,
	permissionProject,
	toolWithThrowingDescriptor,
	toolWithUnknownDynamicTarget,
	toolWithWildcardNetwork,
} from "./tool-permission-fixtures.ts";

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
});
