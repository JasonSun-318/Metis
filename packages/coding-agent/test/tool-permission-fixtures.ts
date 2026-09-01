import { join } from "node:path";
import { Type } from "typebox";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import {
	createToolIdentity,
	describeToolAction,
	permissionClaim,
	permissionDescriptor,
	type ToolIdentityInput,
} from "../src/core/tool-permission-adapter.ts";

const Params = Type.Object({ target: Type.String() }, { additionalProperties: false });
export const permissionProject = join(process.cwd(), "permission-fixture-project");

function definition(
	permission: ToolDefinition<typeof Params>["permission"],
	execute = async () => ({ content: [{ type: "text" as const, text: "not executed" }], details: undefined }),
): ToolDefinition<typeof Params> {
	return {
		name: "fixture_tool",
		label: "Fixture tool",
		description: "Permission adapter fixture",
		parameters: Params,
		permission,
		execute,
	};
}

export function definitionWithoutPermission(): ToolDefinition<typeof Params> {
	return {
		name: "missing_permission",
		label: "Missing permission",
		description: "Negative fixture",
		parameters: Params,
		execute: async () => ({ content: [], details: undefined }),
	} as unknown as ToolDefinition<typeof Params>;
}

export function toolWithThrowingDescriptor(): ToolDefinition<typeof Params> {
	return definition(
		permissionDescriptor(() => {
			throw new Error("secret descriptor detail");
		}),
	);
}

export function toolWithWildcardNetwork(): ToolDefinition<typeof Params> {
	return definition(
		permissionDescriptor(() => permissionClaim({ networkEndpoints: [{ hostname: "*.example.com", port: 443 }] })),
	);
}

export function toolWithUnknownDynamicTarget(): ToolDefinition<typeof Params> {
	return definition(permissionDescriptor(() => permissionClaim({ effects: ["unknown"] })));
}

export function identityInput(overrides: Partial<ToolIdentityInput> = {}): ToolIdentityInput {
	return {
		provenance: "sdk",
		sourceIdentity: "fixture-package",
		toolName: "fixture_tool",
		implementationVersion: "1",
		descriptorVersion: 1,
		...overrides,
	};
}

export function invoke(definition: ToolDefinition<typeof Params>, params = { target: "./data" }) {
	return Promise.resolve().then(() =>
		describeToolAction(definition, params, {
			actionId: "action-1",
			cwd: permissionProject,
			workspaceRoots: [permissionProject],
			provenance: "sdk",
			toolIdentity: createToolIdentity(identityInput()),
		}),
	);
}
