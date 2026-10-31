import { describe, expect, it } from "vitest";
import {
	createDefaultPermissionRules,
	normalizePermissionAction,
	PermissionPolicy,
} from "../../src/core/permissions/index.ts";
import { actionInput, projectDir } from "./fixtures.ts";

describe("visible external defaults preserve existing routing", () => {
	it.each(["mcp", "sdk", "extension", "host"] as const)(
		"keeps %s external reads with a declared command eligible for the Auto reviewer",
		(provenance) => {
			const action = normalizePermissionAction(
				actionInput({
					toolName: "external_tool",
					toolIdentity: `${provenance}:external_tool:v1`,
					provenance,
					command: "external-tool",
					readPaths: ["/external/ordinary-file"],
				}),
			);
			expect(
				new PermissionPolicy().evaluate({
					action,
					settings: { sandboxPolicy: "workspace-write", approvalPolicy: "auto-review" },
					permissionRules: createDefaultPermissionRules(),
				}),
			).toMatchObject({ kind: "review", minimumReviewer: "model" });
		},
	);

	it.each(["mcp", "sdk"] as const)(
		"keeps %s declared reads under the read-only ceiling controlled by E03",
		(provenance) => {
			const action = normalizePermissionAction(
				actionInput({
					toolName: "external_tool",
					toolIdentity: `${provenance}:external_tool:v1`,
					provenance,
					command: "external-tool",
					readPaths: [`${projectDir}/ordinary-file`],
				}),
			);
			const settings = { sandboxPolicy: "read-only", approvalPolicy: "user" } as const;
			const permissionRules = createDefaultPermissionRules();
			const policy = new PermissionPolicy();
			expect(policy.evaluate({ action, settings, permissionRules })).toMatchObject({
				kind: "allow",
				ruleIds: ["E03"],
			});
			expect(
				policy.evaluate({ action, settings, permissionRules: permissionRules.filter((rule) => rule.id !== "E03") }),
			).not.toMatchObject({ kind: "allow" });
		},
	);
});
