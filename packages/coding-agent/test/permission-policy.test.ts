import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PermissionSettings } from "../src/core/permission-mode.ts";
import {
	type ClassifyActionInput,
	classifyAction,
	formatPermissionApproval,
	getSensitiveFilesystemPaths,
	type PermissionAction,
	PermissionPolicy,
	revalidateStructuredActionBinding,
	routeAction,
	unclassifiedAction,
} from "../src/core/permission-policy.ts";

describe("Ask/Full permission policy", () => {
	let root: string;
	let cwd: string;
	let outside: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "arcmind-permission-policy-"));
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
		expect(routeAction(settings("full"), outsideAction)).toBe("allow");
		expect(addedAction.risks).toEqual(["ordinary-read"]);
		expect(routeAction(settings("ask"), addedAction)).toBe("allow");
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
			actor: { type: "subagent", id: "child-1", name: "researcher" },
		});
		expect(view.title).toBe("Approve bash?");
		expect(view.details).toContain(`Command: ${command}`);
		expect(view.details).toContain("ArcMind does not sandbox this action");
		expect(view.details).toContain("may be irreversible");
		expect(view.details).toContain("Subagent: researcher (child-1)");

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
