import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { PermissionPolicy } from "../src/core/permissions/policy.ts";
import { settingsForPreset } from "../src/core/permissions/settings.ts";
import { initializeShellAnalysis } from "../src/core/permissions/shell-parser.ts";
import {
	assertToolPermissionDescriptor,
	createToolIdentity,
	describeToolAction,
	permissionClaim,
	permissionDescriptor,
} from "../src/core/tool-permission-adapter.ts";
import { createBashToolDefinition } from "../src/core/tools/bash.ts";
import { getShellConfig } from "../src/utils/shell.ts";
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

beforeAll(async () => {
	await initializeShellAnalysis();
});

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
	it("keeps empty literal arguments valid through the normalized AST claim", () => {
		const action = describeBash(`printf '%s' ''`);
		expect(action.shellAnalysis?.complete).toBe(true);
		expect(action.shellAnalysis?.commands[0]?.argv).toEqual(["printf", "%s", ""]);
		expect(new PermissionPolicy().evaluate({ action, settings: settingsForPreset("auto") }).kind).toBe("allow");
	});

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
		const action = describeBash(command);
		expect(action.effects).toContain("external-side-effect");
		expect(new PermissionPolicy().evaluate({ settings: settingsForPreset("auto"), action })).toMatchObject({
			kind: "review",
			riskLevel: "high",
			minimumReviewer: "model",
		});
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
		expect(action.effects).toContain("unknown");
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
		// Windows intentionally grants the nearest existing directory instead of
		// the exact file; the dedicated Windows scope tests cover that shape.
		if (process.platform !== "win32") expect(rm.writePaths).toEqual([file]);

		const listed = describeBash("ls ~/Desktop");
		expect(listed.effects).not.toContain("unknown");
		expect(listed.readPaths).toContain(join(homedir(), "Desktop"));
		const globList = describeBash("ls ~/Desktop/*.md");
		expect(globList.effects).not.toContain("unknown");
		expect(globList.readPaths).toContain(join(homedir(), "Desktop"));
		const rmGlob = describeBash(`rm -f ${join(homedir(), "Desktop")}/*.md`);
		expect(rmGlob.effects).toContain("destructive");
		expect(new PermissionPolicy().evaluate({ settings: settingsForPreset("auto"), action: rmGlob })).toMatchObject({
			kind: "review",
			minimumReviewer: "user",
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
		const rmGlobMetis = describeBash("rm ~/.metis/mcp*.json");
		expect(rmGlobMetis.effects).toContain("destructive");
		expect(
			new PermissionPolicy().evaluate({ settings: settingsForPreset("auto"), action: rmGlobMetis }),
		).toMatchObject({ kind: "review", minimumReviewer: "user" });
	});

	it("rejects oversized Ask and Auto commands outright instead of routing them to review", () => {
		const policy = new PermissionPolicy();
		const action = describeToolAction(
			bashDefinition,
			{ command: `echo ${"a".repeat(33 * 1024)}` },
			{
				actionId: "bash-oversize",
				cwd: permissionProject,
				workspaceRoots: [permissionProject],
				provenance: "builtin",
				toolIdentity: createToolIdentity(identityInput({ toolName: "bash" })),
			},
		);
		for (const preset of ["ask", "auto"] as const) {
			expect(policy.evaluate({ settings: settingsForPreset(preset), action })).toMatchObject({
				kind: "deny",
				reason: "命令超过32KiB，请拆分后重试",
			});
		}
		expect(policy.evaluate({ settings: settingsForPreset("full"), action })).toMatchObject({ kind: "allow" });
	});

	it("reviews workspace rm and interpreter execution instead of hard-denying both", () => {
		const policy = new PermissionPolicy();
		const rm = describeBash("rm file.txt");
		expect(rm.effects).toContain("destructive");
		expect(rm.effects).not.toContain("unknown");
		expect(rm.writePaths).toEqual([join(permissionProject, "file.txt")]);
		expect(policy.evaluate({ settings: settingsForPreset("auto"), action: rm })).toMatchObject({
			kind: "review",
			minimumReviewer: "user",
		});
		expect(policy.evaluate({ settings: settingsForPreset("full"), action: rm })).toMatchObject({ kind: "allow" });

		// Interpreted scripts cannot be proven read-only, so they never ride the
		// Auto fast path even when their effects look empty.
		const python = describeBash("python ./script.py");
		expect(python.effects).toContain("unknown");
		expect(policy.evaluate({ settings: settingsForPreset("auto"), action: python })).toMatchObject({
			kind: "review",
			minimumReviewer: "model",
		});
		expect(policy.evaluate({ settings: settingsForPreset("full"), action: python })).toMatchObject({ kind: "allow" });

		expect(policy.evaluate({ settings: settingsForPreset("full"), action: describeBash("rm -rf .") })).toMatchObject({
			kind: "allow",
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
		for (const preset of ["ask", "auto"] as const) {
			expect(policy.evaluate({ settings: settingsForPreset(preset), action: homeDelete })).toMatchObject({
				kind: "deny",
				riskLevel: "critical",
			});
		}
		expect(policy.evaluate({ settings: settingsForPreset("full"), action: homeDelete })).toMatchObject({
			kind: "allow",
		});
	});
});

describe("Windows sandbox directory write scope", () => {
	// Capture the host shell before any test replaces process.platform, since
	// shell discovery itself is platform-dependent.
	const shellPath = getShellConfig().shell;
	const roots: string[] = [];
	const workspace = () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "metis-write-scope-")));
		roots.push(root);
		return root;
	};
	const describeIn = (command: string, cwd: string) =>
		describeToolAction(
			bashDefinition,
			{ command },
			{
				actionId: `bash-${command}`,
				cwd,
				workspaceRoots: [cwd],
				shellPath,
				provenance: "builtin",
				toolIdentity: createToolIdentity(identityInput({ toolName: "bash" })),
			},
		);
	const withPlatform = <T>(platform: NodeJS.Platform, run: () => T): T => {
		const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
		if (!descriptor) throw new Error("process.platform is not configurable");
		Object.defineProperty(process, "platform", { ...descriptor, value: platform });
		try {
			return run();
		} finally {
			Object.defineProperty(process, "platform", descriptor);
		}
	};

	afterEach(() => {
		for (const root of roots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
			rmSync(`${dirname(root)}/metis-write-scope-outside`, { recursive: true, force: true });
		}
	});

	it("keeps exact macOS file targets untouched", () => {
		const root = workspace();
		const target = join(root, "src", "new-file.txt");
		const action = withPlatform("darwin", () => describeIn(`printf x > "${target}"`, root));
		expect(action.writePaths).toEqual([target]);
	});

	it("grants the nearest existing directory for new and recreated files", () => {
		const root = workspace();
		const source = join(root, "src");
		mkdirSync(source);
		writeFileSync(join(root, "existing.txt"), "old");

		const cases = [
			{ target: join(source, "new-file.txt"), expected: source },
			// An existing file is still directory-scoped so atomic replace and
			// delete-then-recreate keep the same grant.
			{ target: join(root, "existing.txt"), expected: root },
		];
		for (const { target, expected } of cases) {
			const action = withPlatform("win32", () => describeIn(`printf x > "${target}"`, root));
			expect(action.writePaths).toEqual([expected]);
		}
	});

	it("walks up through deep missing parents but never above the workspace", () => {
		const root = workspace();
		const target = join(root, "a", "b", "c", "new-file.txt");
		const action = withPlatform("win32", () => describeIn(`printf x > "${target}"`, root));
		expect(action.writePaths).toEqual([root]);

		const decision = new PermissionPolicy().evaluate({ settings: settingsForPreset("ask"), action });
		expect(decision).toMatchObject({ kind: "review", grant: { writeRoots: [root] } });
	});

	it("keeps a workspace root target as that root", () => {
		const root = workspace();
		const action = withPlatform("win32", () => describeIn(`mkdir -p "${root}"`, root));
		expect(action.writePaths).toEqual([root]);
	});

	it("widens an outside target only to its own existing directory", () => {
		const root = workspace();
		const outside = `${dirname(root)}/metis-write-scope-outside`;
		mkdirSync(join(outside, "deep"), { recursive: true });
		const target = join(outside, "deep", "new-file.txt");
		const action = withPlatform("win32", () => describeIn(`printf x > "${target}"`, root));
		expect(action.writePaths).toEqual([join(outside, "deep")]);
	});

	it("keeps protected workspace writes denied after directory widening", () => {
		const root = workspace();
		const git = join(root, ".git");
		mkdirSync(git);
		const target = join(git, "config");
		const action = withPlatform("win32", () => describeIn(`printf x > "${target}"`, root));
		expect(action.writePaths).toEqual([git]);
		const decision = new PermissionPolicy().evaluate({ settings: settingsForPreset("auto"), action });
		expect(decision.kind).toBe("deny");
	});
});
