import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	defaultPermissionSettings,
	isPermissionMode,
	isPersistedPermissionMode,
	narrowPermissionMode,
	normalizePermissionMode,
	type PermissionSettings,
} from "../src/core/permission-mode.ts";
import {
	type ClassifyActionInput,
	classifyAction,
	executionTargetFor,
	formatPermissionApproval,
	getSensitiveFilesystemPaths,
	type PermissionAction,
	PermissionPolicy,
	revalidateStructuredActionBinding,
	routeAction,
	unclassifiedAction,
} from "../src/core/permission-policy.ts";
import { ProjectPermissionRuleStore } from "../src/core/project-permission-rules.ts";

describe("Ask/Auto/Full permission policy", () => {
	let root: string;
	let cwd: string;
	let outside: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "metis-permission-policy-"));
		cwd = join(root, "project");
		outside = join(root, "outside");
		mkdirSync(join(cwd, "src"), { recursive: true });
		mkdirSync(outside);
		writeFileSync(join(cwd, "src", "file.ts"), "export const value = 1;\n");
		writeFileSync(join(outside, "outside.txt"), "outside\n");
	});

	afterEach(() => {
		chmodSync(cwd, 0o700);
		rmSync(root, { recursive: true, force: true });
	});

	const settings = (mode: PermissionSettings["mode"]): PermissionSettings => ({ mode });
	const input = (
		toolName: string,
		args: unknown,
		provenance: ClassifyActionInput["provenance"] = "builtin",
	): ClassifyActionInput => ({
		actionId: `${toolName}-1`,
		toolName,
		provenance,
		args,
		cwd,
		workspaceRoots: [cwd],
	});
	const action = (
		toolName: string,
		args: unknown,
		provenance: ClassifyActionInput["provenance"] = "builtin",
	): PermissionAction => classifyAction(input(toolName, args, provenance));

	it("uses Auto as the default and narrows modes by Ask < Auto < Full", () => {
		expect(defaultPermissionSettings()).toEqual({ mode: "auto" });
		expect(isPermissionMode("auto")).toBe(true);
		expect(isPersistedPermissionMode("auto")).toBe(true);
		expect(normalizePermissionMode("auto")).toBe("auto");
		expect(narrowPermissionMode("full", "auto")).toBe("auto");
		expect(narrowPermissionMode("auto", "ask")).toBe("ask");
		expect(narrowPermissionMode("auto", "full")).toBe("auto");
	});

	it("routes the three permission modes and selects Bash execution targets", () => {
		const cases = [
			["ask", "read", "builtin", ["ordinary-read"], "allow"],
			["ask", "write", "builtin", ["workspace-write"], "user"],
			["ask", "bash", "builtin", ["shell"], "user"],
			["ask", "web_fetch", "builtin", ["network"], "user"],
			["ask", "mcp_tool", "mcp", ["custom"], "user"],
			["auto", "read", "builtin", ["ordinary-read"], "allow"],
			["auto", "write", "builtin", ["workspace-write"], "allow"],
			["auto", "bash", "builtin", ["shell"], "allow"],
			["auto", "bash", "builtin", ["shell", "destructive"], "user"],
			["auto", "bash", "builtin", ["shell", "network"], "user"],
			["auto", "web_fetch", "builtin", ["network"], "allow"],
			["auto", "mcp_tool", "mcp", ["custom", "external-side-effect"], "allow"],
			["auto", "extension_tool", "extension", ["custom"], "allow"],
			["auto", "sdk_tool", "sdk", ["custom"], "allow"],
			["auto", "read", "builtin", ["sensitive-read"], "user"],
			["auto", "write", "builtin", ["outside-write"], "user"],
			["full", "bash", "builtin", ["shell", "destructive"], "allow"],
		] as const;
		for (const [mode, toolName, provenance, risks, expected] of cases) {
			expect(
				routeAction(settings(mode), {
					actionId: "table",
					toolName,
					provenance,
					risks,
					paths: [],
					networkTargets: [],
				}),
				`${mode}:${toolName}:${risks.join(",")}`,
			).toBe(expected);
		}
		const bash = (risks: PermissionAction["risks"]): PermissionAction => ({
			actionId: "bash-target",
			toolName: "bash",
			provenance: "builtin",
			risks,
			paths: [],
			networkTargets: [],
		});
		expect(executionTargetFor(settings("ask"), bash(["shell"]))).toBe("sandbox");
		expect(executionTargetFor(settings("auto"), bash(["shell", "destructive"]))).toBe("sandbox");
		expect(executionTargetFor(settings("auto"), bash(["shell", "network"]))).toBe("host");
		expect(executionTargetFor(settings("auto"), bash(["shell", "elevation"]))).toBe("host");
		expect(executionTargetFor(settings("auto"), bash(["shell", "external-side-effect"]))).toBe("host");
		expect(executionTargetFor(settings("full"), bash(["shell"]))).toBe("host");
	});

	it("automatically allows only a proven built-in structured read", async () => {
		const requestApproval = vi.fn(async () => ({ decision: "deny" as const }));
		const value = action("read", { path: join(cwd, "src", "file.ts") });
		const result = await new PermissionPolicy(requestApproval).authorize({
			settings: settings("ask"),
			action: value,
			args: { path: join(cwd, "src", "file.ts") },
		});

		expect(result).toMatchObject({ decision: "allow", source: "automatic" });
		expect(value.risks).toEqual(["ordinary-read"]);
		expect(requestApproval).not.toHaveBeenCalled();
	});

	it("asks for every model-proposed Bash command in Ask", async () => {
		for (const command of ["pwd", "cat README.md", "git status", "npm test", "curl https://example.test"]) {
			const requestApproval = vi.fn(async () => ({ decision: "allow" as const }));
			const result = await new PermissionPolicy(requestApproval).authorize({
				settings: settings("ask"),
				action: action("bash", { command }),
				args: { command },
			});
			expect(result, command).toMatchObject({ decision: "allow", source: "user" });
			expect(requestApproval, command).toHaveBeenCalledOnce();
		}
	});

	it("uses shell parsing only to improve warning metadata", () => {
		for (const command of ["pwd", "npm test"]) {
			expect(action("bash", { command }).risks, command).toEqual(["shell"]);
		}
		for (const command of [
			`node -e "require('node:fs').rmSync('src',{recursive:true})"`,
			`python3 -c "import shutil; shutil.rmtree('src')"`,
			`perl -e "use File::Path qw(remove_tree); remove_tree('src')"`,
			"./scripts/cleanup.sh",
			"cat $'\\x2eenv'",
			"cat \\x2eenv",
		]) {
			const value = action("bash", { command });
			expect(value.risks, command).toContain("unknown");
			expect(routeAction(settings("auto"), value), command).toBe("user");
		}
		for (const command of ["cat .env", "grep TOKEN config/.env.production", "cat ~/.ssh/id_ed25519"]) {
			const value = action("bash", { command });
			expect(value.risks, command).toContain("sensitive-read");
			expect(routeAction(settings("auto"), value), command).toBe("user");
		}
		for (const command of ["rm -rf build", "git clean -fd", "git reset --hard", "dd if=x of=y", "kill 42"]) {
			expect(action("bash", { command }).risks, command).toContain("destructive");
		}
		for (const command of ["curl https://example.test", "npm install", "git fetch origin"]) {
			expect(action("bash", { command }).risks, command).toContain("network");
		}
		for (const command of ["git push origin main", "npm publish", "deploy production"]) {
			expect(action("bash", { command }).risks, command).toContain("external-side-effect");
		}
		expect(action("bash", { command: "sudo true" }).risks).toContain("elevation");
		expect(action("bash", { command: "git push origin main" }).risks).toEqual([
			"shell",
			"network",
			"external-side-effect",
		]);
		expect(action("bash", { command: "rm -rf build" }).risks).toEqual(["shell", "destructive"]);
		expect(action("bash", { command: "sudo curl https://example.test" }).risks).toEqual([
			"shell",
			"network",
			"elevation",
		]);
	});

	it("never trusts MCP readOnlyHint for automatic execution", async () => {
		const requestApproval = vi.fn(async () => ({ decision: "allow" as const }));
		const value = classifyAction({
			...input("mcp_read", { id: "1" }, "mcp"),
			mcpAnnotations: { readOnlyHint: true },
		});
		await new PermissionPolicy(requestApproval).authorize({
			settings: settings("ask"),
			action: value,
			args: { id: "1" },
		});

		expect(value.risks).toEqual(["custom"]);
		expect(requestApproval).toHaveBeenCalledOnce();
	});

	it("skips classification and approval in Full", async () => {
		const requestApproval = vi.fn(async () => ({ decision: "deny" as const }));
		const raw = input("bash", { command: "rm -rf /path-that-does-not-exist" });
		const result = await new PermissionPolicy(requestApproval).authorize({
			settings: settings("full"),
			action: unclassifiedAction({ ...raw, cwd: "\0invalid-for-classification" }),
			args: raw.args,
		});

		expect(result).toMatchObject({ decision: "allow", source: "automatic" });
		expect(requestApproval).not.toHaveBeenCalled();
	});

	it("routes sensitive, missing, special, and unprovable reads to the user", () => {
		const env = join(cwd, ".env");
		writeFileSync(env, "TOKEN=x");
		const values = [
			action("read", { path: env }),
			action("grep", { pattern: "TOKEN", path: cwd }),
			action("read", { path: join(cwd, "missing.txt") }),
			...(process.platform === "win32" ? [] : [action("read", { path: "/dev/null" })]),
		];
		for (const value of values) expect(routeAction(settings("ask"), value)).toBe("user");
		for (const sample of [".env.example", ".env.sample", ".env.production.example", ".env.test.sample"]) {
			const path = join(cwd, sample);
			writeFileSync(path, "safe\n");
			expect(action("read", { path }).risks, sample).toEqual(["ordinary-read"]);
		}
	});

	it("classifies describe_image as a single-file read, not a traversal", () => {
		const inside = join(cwd, "shot.png");
		writeFileSync(inside, "png");
		// 工作区内普通图片：普通读取，自动放行
		expect(action("describe_image", { path: inside }).risks).toEqual(["ordinary-read"]);
		// 敏感目录下的图片：敏感读取（与 read 一致，而不是 grep/find 的 traversal 语义）
		const sensitive = join(cwd, ".ssh", "key.png");
		mkdirSync(join(cwd, ".ssh"), { recursive: true });
		writeFileSync(sensitive, "png");
		expect(action("describe_image", { path: sensitive }).risks).toEqual(["sensitive-read"]);
		// 缺失路径按 unknown 处理
		expect(action("describe_image", { path: join(cwd, "missing.png") }).risks).toEqual(["unknown"]);
	});

	it("classifies symlinks by canonical target and revalidates before execution", () => {
		if (process.platform === "win32") return;
		const env = join(cwd, ".env");
		const alias = join(cwd, "alias.txt");
		writeFileSync(env, "TOKEN=x");
		symlinkSync(env, alias);
		expect(action("read", { path: alias }).risks).toEqual(["sensitive-read"]);

		const ordinary = join(cwd, "ordinary.txt");
		writeFileSync(ordinary, "safe\n");
		const approved = action("read", { path: ordinary });
		rmSync(ordinary);
		symlinkSync(env, ordinary);
		expect(revalidateStructuredActionBinding(approved, { path: ordinary }, cwd, [cwd])).toBe(false);
	});

	it("asks for an ordinary read outside roots and allows it after the directory is added", () => {
		const outsideFile = join(outside, "outside.txt");
		const outsideAction = classifyAction({ ...input("read", { path: outsideFile }), workspaceRoots: [cwd] });
		const addedAction = classifyAction({
			...input("read", { path: outsideFile }),
			workspaceRoots: [cwd, outside],
		});

		expect(outsideAction.risks).toEqual(["outside-read"]);
		expect(routeAction(settings("ask"), outsideAction)).toBe("user");
		expect(routeAction(settings("auto"), outsideAction)).toBe("allow");
		expect(routeAction(settings("full"), outsideAction)).toBe("allow");
		expect(addedAction.risks).toEqual(["ordinary-read"]);
		expect(routeAction(settings("ask"), addedAction)).toBe("allow");
	});

	it("allows structured reads from a read-only resource root without allowing writes", () => {
		const outsideFile = join(outside, "outside.txt");
		const read = classifyAction({
			...input("read", { path: outsideFile }),
			readOnlyRoots: [outside],
		});
		const write = classifyAction({
			...input("write", { path: outsideFile }),
			readOnlyRoots: [outside],
		});

		expect(read.risks).toEqual(["ordinary-read"]);
		expect(write.risks).toEqual(["outside-write"]);
	});

	it("keeps sensitive reads protected inside an added root", () => {
		const env = join(outside, ".env.local");
		writeFileSync(env, "TOKEN=x\n");
		const direct = classifyAction({ ...input("read", { path: env }), workspaceRoots: [cwd, outside] });
		const traversal = classifyAction({
			...input("grep", { path: outside, pattern: "TOKEN" }),
			workspaceRoots: [cwd, outside],
		});
		expect(direct.risks).toEqual(["sensitive-read"]);
		expect(traversal.risks).toEqual(["sensitive-read"]);
		expect(routeAction(settings("ask"), direct)).toBe("user");
		expect(routeAction(settings("ask"), traversal)).toBe("user");
	});

	it("classifies a symlink by its canonical target root", () => {
		if (process.platform === "win32") return;
		const alias = join(cwd, "outside-link.txt");
		symlinkSync(join(outside, "outside.txt"), alias);
		const value = classifyAction({ ...input("read", { path: alias }), workspaceRoots: [cwd] });
		expect(value.risks).toEqual(["outside-read"]);
	});

	it("classifies writes against all effective roots", () => {
		const addedWrite = classifyAction({
			...input("write", { path: join(outside, "new.txt"), content: "x" }),
			workspaceRoots: [cwd, outside],
		});
		const unrelated = join(root, "unrelated", "new.txt");
		const outsideWrite = classifyAction({
			...input("write", { path: unrelated, content: "x" }),
			workspaceRoots: [cwd, outside],
		});
		expect(addedWrite.risks).toEqual(["workspace-write"]);
		expect(outsideWrite.risks).toEqual(["outside-write"]);
	});

	it("covers fixed credential, browser, and OS credential roots", () => {
		const appData = join(root, "AppData", "Roaming");
		const localAppData = join(root, "AppData", "Local");
		const roots = getSensitiveFilesystemPaths(cwd, { APPDATA: appData, LOCALAPPDATA: localAppData });
		for (const target of [
			join(homedir(), ".git-credentials"),
			join(homedir(), ".config", "google-chrome"),
			join(appData, "Microsoft", "Credentials"),
			join(localAppData, "Google", "Chrome", "User Data"),
		]) {
			expect(roots).toContain(classifyAction(input("write", { path: target })).paths[0]);
		}
	});

	it("asks for structured writes both inside and outside cwd", () => {
		const inside = action("write", { path: "src/new.ts", content: "x" });
		const external = action("edit", { path: join(outside, "outside.txt"), edits: [] });
		expect(inside.risks).toEqual(["workspace-write"]);
		expect(external.risks).toEqual(["outside-write"]);
		expect(routeAction(settings("ask"), inside)).toBe("user");
		expect(routeAction(settings("ask"), external)).toBe("user");
	});

	it("asks for Extension, SDK, MCP, and unknown tools in Ask", () => {
		for (const provenance of ["extension", "sdk", "mcp"] as const) {
			const value = action("custom_action", { value: "x" }, provenance);
			expect(value.risks).toContain("custom");
			expect(routeAction(settings("ask"), value)).toBe("user");
			expect(routeAction(settings("full"), value)).toBe("allow");
		}
		expect(routeAction(settings("ask"), action("unknown_builtin", {}))).toBe("user");
	});

	it("does not retain the removed wait_agents read exemption", () => {
		expect(action("inspect_agents", {}).risks).toEqual(["ordinary-read"]);
		expect(action("wait_agents", {}).risks).toEqual(["unknown"]);
	});

	it("fails closed when UI is missing, throws, or is aborted", async () => {
		const value = action("write", { path: "new.txt", content: "x" });
		await expect(
			new PermissionPolicy().authorize({ settings: settings("ask"), action: value, args: {} }),
		).resolves.toMatchObject({ decision: "deny", source: "fallback" });
		await expect(
			new PermissionPolicy(async () => {
				throw new Error("closed");
			}).authorize({ settings: settings("ask"), action: value, args: {} }),
		).resolves.toMatchObject({ decision: "deny", source: "fallback" });

		const controller = new AbortController();
		controller.abort();
		await expect(
			new PermissionPolicy(async () => ({ decision: "allow" })).authorize({
				settings: settings("ask"),
				action: value,
				args: {},
				signal: controller.signal,
			}),
		).resolves.toMatchObject({ decision: "deny", source: "fallback" });
	});

	it("remembers only an exact current-project action and honors revocation", async () => {
		const agentDir = join(root, "agent-rules");
		mkdirSync(agentDir);
		const store = new ProjectPermissionRuleStore(agentDir);
		const requestApproval = vi.fn(async () => ({ decision: "allow" as const, remember: "project" as const }));
		const policy = new PermissionPolicy(requestApproval, store);
		const args = { command: "rm -rf ./build" };
		const value = action("bash", args);
		const authorization = {
			settings: settings("ask"),
			action: value,
			args,
			projectPath: cwd,
			cwd,
			workspaceRoots: [cwd],
			allowProjectRules: true,
			executionTarget: executionTargetFor(settings("ask"), value),
		} as const;

		await expect(policy.authorize(authorization)).resolves.toMatchObject({ decision: "allow", source: "user" });
		await expect(policy.authorize(authorization)).resolves.toMatchObject({
			decision: "allow",
			source: "project-rule",
		});
		expect(requestApproval).toHaveBeenCalledOnce();

		const changedArgs = { command: "rm -rf ./cache" };
		const changedAction = action("bash", changedArgs);
		await policy.authorize({ ...authorization, action: changedAction, args: changedArgs });
		expect(requestApproval).toHaveBeenCalledTimes(2);

		const remembered = store.list(cwd).find((rule) => rule.command === args.command)!;
		expect(store.delete(cwd, remembered.id)).toBe(true);
		await policy.authorize(authorization);
		expect(requestApproval).toHaveBeenCalledTimes(3);
	});

	it("does not apply parent project rules to subagents and denies a failed remember", async () => {
		const agentDir = join(root, "agent-subagent-rules");
		mkdirSync(agentDir);
		const store = new ProjectPermissionRuleStore(agentDir);
		const args = { command: "rm -rf ./build" };
		const value = action("bash", args);
		const base = {
			settings: settings("ask"),
			action: value,
			args,
			projectPath: cwd,
			cwd,
			workspaceRoots: [cwd],
			executionTarget: executionTargetFor(settings("ask"), value),
		} as const;
		store.remember(base);
		const subagentApproval = vi.fn(async () => ({ decision: "deny" as const }));
		await new PermissionPolicy(subagentApproval, store).authorize({ ...base, allowProjectRules: false });
		expect(subagentApproval).toHaveBeenCalledOnce();

		const failingAgentDir = join(root, "agent-failing-rules");
		mkdirSync(failingAgentDir);
		const failingStore = new ProjectPermissionRuleStore(failingAgentDir);
		const result = await new PermissionPolicy(async () => {
			writeFileSync(join(failingAgentDir, "permission-rules.json"), "broken");
			return { decision: "allow", remember: "project" };
		}, failingStore).authorize({ ...base, allowProjectRules: true });
		expect(result).toMatchObject({ decision: "deny", source: "fallback" });
		expect(result.reason).toContain("could not be saved safely");
	});

	it("isolates mutable approval arguments and actions from enforcement", async () => {
		const value = action("write", { path: "new.txt", content: "x" });
		const originalPaths = [...value.paths];
		const result = await new PermissionPolicy(async (request) => {
			(request.args as { path: string }).path = "changed.txt";
			(request.action.paths as string[])[0] = "changed.txt";
			return { decision: "allow" };
		}).authorize({
			settings: settings("ask"),
			action: value,
			args: { path: "new.txt", content: "x" },
		});

		expect(result.action).toBe(value);
		expect(result.action.paths).toEqual(originalPaths);
	});

	it("formats the complete truthful two-button approval content", () => {
		const command = "git push origin release";
		const view = formatPermissionApproval({
			action: action("bash", { command }),
			args: { command },
			reason: "This action affects the host",
			actor: { type: "agent", id: "child-1", name: "researcher" },
		});
		expect(view.title).toBe("Approve bash?");
		expect(view.details).toContain(`Command: ${command}`);
		expect(view.details).toContain("Metis does not sandbox this action");
		expect(view.details).toContain("may be irreversible");
		expect(view.details).toContain("Agent: researcher (child-1)");

		const writeArgs = { path: "new.txt", content: "complete file contents" };
		const writeView = formatPermissionApproval({
			action: action("write", writeArgs),
			args: writeArgs,
			reason: "This action affects the host",
		});
		expect(writeView.details).toContain(JSON.stringify(writeArgs, null, 2));
	});

	it("rejects approval content that cannot be shown completely", () => {
		const command = "x".repeat(60 * 1024);
		expect(() =>
			formatPermissionApproval({
				action: action("bash", { command }),
				args: { command },
				reason: "large",
			}),
		).toThrow("Permission action is too large to display completely");
	});
});
