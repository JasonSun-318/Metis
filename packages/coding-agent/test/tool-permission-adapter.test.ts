import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PermissionPolicy } from "../src/core/permissions/policy.ts";
import { settingsForPreset } from "../src/core/permissions/settings.ts";
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

	it("fails closed before execution for throwing and wildcard descriptors", async () => {
		const execution = vi.fn();
		for (const [tool, error] of [
			[toolWithThrowingDescriptor(), "Permission action could not be described"],
			[toolWithWildcardNetwork(), "exact"],
		] as const) {
			tool.execute = execution;
			await expect(invoke(tool)).rejects.toThrow(error);
		}
		expect(execution).not.toHaveBeenCalled();
		await expect(invoke(toolWithUnknownDynamicTarget())).resolves.toMatchObject({ effects: ["unknown"] });
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
	])("reviews a wrapper instead of hard-denying network mutation scope: %s", (command) => {
		const action = describeBash(command);
		expect(action.effects).toContain("unknown");
		expect(new PermissionPolicy().evaluate({ settings: settingsForPreset("auto"), action })).toMatchObject({
			kind: "review",
			minimumReviewer: "model",
		});
	});

	it("reviews an unresolved network endpoint in Auto instead of hard-denying it", () => {
		const action = describeBash('curl "$URL"');
		expect(action.effects).toContain("unknown");
		expect(new PermissionPolicy().evaluate({ settings: settingsForPreset("auto"), action })).toMatchObject({
			kind: "review",
			minimumReviewer: "model",
		});
	});

	it("keeps an exact Desktop rm complete and expands ~ reads", () => {
		const file = join(homedir(), "Desktop", "note.md");
		const rm = describeBash(`rm -f "${file}"`);
		expect(rm.effects).toContain("destructive");
		expect(rm.effects).not.toContain("unknown");
		expect(rm.writePaths).toEqual(expect.arrayContaining([permissionProject, file]));

		const listed = describeBash("ls ~/Desktop");
		expect(listed.effects).not.toContain("unknown");
		expect(listed.readPaths).toContain(join(homedir(), "Desktop"));
		const globList = describeBash("ls ~/Desktop/*.md");
		expect(globList.effects).not.toContain("unknown");
		expect(globList.readPaths).toContain(join(homedir(), "Desktop"));
		const rmGlob = describeBash(`rm -f ${join(homedir(), "Desktop")}/*.md`);
		expect(rmGlob.effects).toContain("unknown");
		expect(new PermissionPolicy().evaluate({ settings: settingsForPreset("auto"), action: rmGlob })).toMatchObject({
			kind: "review",
			minimumReviewer: "model",
		});
	});

	it("lets Auto classify stderr-suppressed reads instead of hard-denying them", () => {
		const policy = new PermissionPolicy();
		const listed = describeBash(`ls -la ${join(homedir(), ".metis", "agent")} 2>&1 | head -30`);
		expect(listed.effects).not.toContain("unknown");
		expect(listed.writePaths).toEqual([]);
		expect(policy.evaluate({ settings: settingsForPreset("auto"), action: listed }).kind).not.toBe("deny");

		const cat = describeBash('cat ~/.metis/agent/settings.json 2>/dev/null | head -50; echo "---project---"');
		expect(cat.effects).not.toContain("unknown");
		expect(cat.writePaths).toEqual([]);
		expect(policy.evaluate({ settings: settingsForPreset("auto"), action: cat }).kind).not.toBe("deny");

		const glob = describeBash(
			'ls ~/.metis/ 2>/dev/null && echo "---" && cat ~/.metis/mcp*.json 2>/dev/null; cat .mcp.json',
		);
		expect(glob.effects).not.toContain("unknown");
		expect(glob.readPaths).toContain(join(homedir(), ".metis"));
		expect(glob.writePaths).toEqual([]);
		expect(() => describeBash("rm ~/.metis/mcp*.json")).not.toThrow();
		expect(describeBash("rm ~/.metis/mcp*.json").effects).toContain("unknown");
	});

	it("reviews workspace rm and allows python scripts instead of hard-denying both", () => {
		const policy = new PermissionPolicy();
		const rm = describeBash("rm file.txt");
		expect(rm.effects).toContain("destructive");
		expect(rm.writePaths).toContain(join(permissionProject, "file.txt"));
		expect(policy.evaluate({ settings: settingsForPreset("auto"), action: rm })).toMatchObject({
			kind: "review",
			minimumReviewer: "model",
		});
		expect(policy.evaluate({ settings: settingsForPreset("full"), action: rm })).toMatchObject({
			kind: "review",
			minimumReviewer: "user",
		});

		const python = describeBash("python ./script.py");
		expect(python.effects).not.toContain("unknown");
		expect(policy.evaluate({ settings: settingsForPreset("auto"), action: python })).toMatchObject({ kind: "allow" });
		expect(policy.evaluate({ settings: settingsForPreset("full"), action: python })).toMatchObject({ kind: "allow" });

		expect(policy.evaluate({ settings: settingsForPreset("full"), action: describeBash("rm -rf .") })).toMatchObject({
			kind: "review",
			minimumReviewer: "user",
		});
		expect(policy.evaluate({ settings: settingsForPreset("auto"), action: describeBash("rm -rf .") })).toMatchObject({
			kind: "deny",
		});
		const dynamic = describeBash("python ./script.py $OUTPUT");
		expect(dynamic.effects).toContain("unknown");
		expect(policy.evaluate({ settings: settingsForPreset("auto"), action: dynamic })).toMatchObject({
			kind: "review",
			minimumReviewer: "model",
		});
		expect(
			new PermissionPolicy().evaluate({
				settings: settingsForPreset("auto"),
				action: describeBash('echo "rm -rf ./build"'),
			}).kind,
		).not.toBe("deny");
		expect(
			policy.evaluate({ settings: settingsForPreset("auto"), action: describeBash("ls && rm -rf ./build") }),
		).toMatchObject({ kind: "deny", riskLevel: "high" });
		expect(
			policy.evaluate({ settings: settingsForPreset("auto"), action: describeBash("Remove-Item -Recurse ./build") }),
		).toMatchObject({ kind: "deny", riskLevel: "high" });
		expect(
			policy.evaluate({ settings: settingsForPreset("auto"), action: describeBash("rmdir /s ./build") }),
		).toMatchObject({
			kind: "deny",
			riskLevel: "high",
		});
		const homeDelete = describeBash("rm -rf ~");
		expect(homeDelete.writePaths).toContain(homedir());
		for (const preset of ["ask", "auto", "full"] as const) {
			expect(policy.evaluate({ settings: settingsForPreset(preset), action: homeDelete })).toMatchObject({
				kind: "deny",
				riskLevel: "critical",
			});
		}
	});
});
