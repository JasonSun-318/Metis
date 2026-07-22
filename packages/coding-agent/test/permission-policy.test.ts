import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PermissionSettings } from "../src/core/permission-mode.ts";
import {
	type ClassifiedAction,
	classifyAction,
	createSandboxGrant,
	getSensitiveFilesystemPaths,
	PermissionPolicy,
	routeAction,
	type ToolProvenance,
	tokenizePermissionCommand,
} from "../src/core/permission-policy.ts";

describe("permission policy", () => {
	let root: string;
	let cwd: string;
	let outside: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "arcmind-policy-"));
		cwd = join(root, "workspace");
		outside = join(root, "outside");
		mkdirSync(join(cwd, "src"), { recursive: true });
		mkdirSync(outside);
		writeFileSync(join(cwd, "src", "file.ts"), "export {};");
		writeFileSync(join(outside, "outside.txt"), "outside");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	function action(toolName: string, args: unknown, provenance: ToolProvenance = "builtin"): ClassifiedAction {
		return classifyAction({ actionId: "action-1", toolName, provenance, args, cwd });
	}

	const settings = (mode: PermissionSettings["mode"], reviewerEnabled = true): PermissionSettings => ({
		mode,
		reviewerEnabled,
	});

	it("allows ordinary reads inside and outside the workspace", () => {
		for (const target of [join(cwd, "src", "file.ts"), join(outside, "outside.txt")]) {
			const read = action("read", { path: target });
			expect(read.risks).toEqual(["ordinary-read"]);
			expect(read.sandbox).toBe("read-only");
			expect(routeAction(settings("ask"), read, "assistant")).toBe("allow");
			expect(routeAction(settings("auto"), read, "assistant")).toBe("allow");
		}
	});

	it("keeps workspace traversal ordinary until it would cross an existing sensitive path", () => {
		expect(action("grep", { pattern: "export", path: cwd }).risks).toEqual(["ordinary-read"]);
		writeFileSync(join(cwd, ".env.local"), "TOKEN=x");
		expect(action("grep", { pattern: "TOKEN", path: cwd }).risks).toContain("sensitive-read");
	});

	it("routes sensitive direct and traversal reads to approval", () => {
		const env = join(cwd, ".env");
		writeFileSync(env, "TOKEN=x");
		for (const sensitive of [action("read", { path: env }), action("grep", { pattern: "TOKEN", path: cwd })]) {
			expect(sensitive.risks).toContain("sensitive-read");
			expect(routeAction(settings("ask"), sensitive, "assistant")).toBe("user");
			expect(routeAction(settings("auto"), sensitive, "assistant")).toBe("reviewer");
			expect(routeAction(settings("full"), sensitive, "assistant")).toBe("allow");
		}
		for (const sample of [".env.example", ".env.sample", ".env.production.example", ".env.test.sample"]) {
			expect(action("read", { path: join(cwd, sample) }).risks, sample).toEqual(["ordinary-read"]);
		}
	});

	it("covers fixed credential, browser profile, and OS credential roots", () => {
		const appData = join(root, "AppData", "Roaming");
		const localAppData = join(root, "AppData", "Local");
		const roots = getSensitiveFilesystemPaths(cwd, { APPDATA: appData, LOCALAPPDATA: localAppData });
		for (const target of [
			join(homedir(), ".git-credentials"),
			join(homedir(), ".config", "google-chrome"),
			join(appData, "Microsoft", "Credentials"),
			join(localAppData, "Google", "Chrome", "User Data"),
		]) {
			expect(roots).toContain(action("read", { path: target }).paths[0]);
		}
		for (const target of [join(homedir(), ".git-credentials"), join(homedir(), ".config", "google-chrome")]) {
			expect(action("read", { path: target }).risks).toContain("sensitive-read");
		}
	});

	it("distinguishes workspace writes from canonical outside writes", () => {
		const inside = action("write", { path: "src/new.ts", content: "x" });
		const external = action("edit", { path: join(outside, "outside.txt"), edits: [] });
		expect(inside.risks).toEqual(["workspace-write"]);
		expect(external.risks).toEqual(["outside-write"]);
		expect(routeAction(settings("ask"), inside, "assistant")).toBe("user");
		expect(routeAction(settings("auto"), inside, "assistant")).toBe("allow");
		expect(routeAction(settings("auto"), external, "assistant")).toBe("reviewer");
	});

	it.skipIf(process.platform === "win32")("canonicalizes symlink aliases and missing write targets", () => {
		const alias = join(cwd, "outside-link");
		symlinkSync(outside, alias, "dir");
		const write = action("write", { path: join(alias, "new.txt"), content: "x" });
		expect(write.risks).toEqual(["outside-write"]);
		expect(write.paths[0]).toBe(join(action("read", { path: outside }).paths[0]!, "new.txt"));
	});

	it("recognizes only a narrow read-only shell set", () => {
		for (const command of [
			"pwd",
			`ls "${join(cwd, "src")}"`,
			`cat "${join(outside, "outside.txt")}"`,
			"git status",
			"git diff --stat",
			"git log -1",
			"git show HEAD",
			"git rev-parse HEAD",
			"git branch --list",
		]) {
			const shell = action("bash", { command });
			expect(shell.risks, command).toEqual(["ordinary-read"]);
			expect(shell.sandbox, command).toBe("read-only");
		}
	});

	it("marks destructive shell actions and redirects for approval", () => {
		for (const command of [
			"rm -rf build",
			"find . -delete",
			"git reset --hard HEAD",
			"git clean -fd",
			"echo x > file",
		]) {
			const shell = action("bash", { command });
			expect(shell.risks, command).toContain("destructive");
			expect(routeAction(settings("ask"), shell, "assistant"), command).toBe("user");
			expect(routeAction(settings("auto"), shell, "assistant"), command).toBe("reviewer");
		}
		const removal = action("bash", { command: "rm -rf build" });
		expect(createSandboxGrant(removal, { cwd }).writePaths).toEqual(removal.paths);
	});

	it("marks network, publish, and elevation commands", () => {
		const webFetch = action("web_fetch", { url: "https://example.com:8443/page" });
		expect(webFetch.risks).toEqual(["network"]);
		expect(webFetch.networkTargets).toEqual([{ host: "example.com", port: 8443 }]);

		const curl = action("bash", { command: "curl https://example.com:8443/data" });
		expect(curl.risks).toEqual(["network"]);
		expect(curl.networkTargets).toEqual([{ host: "example.com", port: 8443 }]);

		const push = action("bash", { command: "git push origin main" });
		expect(push.risks).toEqual(["network", "external-side-effect"]);
		expect(action("bash", { command: "npm publish" }).risks).toEqual(["network", "external-side-effect"]);
		expect(action("bash", { command: "sudo make install" }).risks).toEqual(["elevation"]);
	});

	it("classifies web_search only against the host-selected provider target", () => {
		const classified = classifyAction({
			actionId: "search-1",
			toolName: "web_search",
			provenance: "builtin",
			args: { query: "test" },
			cwd,
			builtinNetworkTargets: [{ host: "api.tavily.com", port: 443 }],
		});
		expect(classified.risks).toEqual(["network"]);
		expect(classified.networkTargets).toEqual([{ host: "api.tavily.com", port: 443 }]);

		const missingTarget = action("web_search", { query: "test" });
		expect(missingTarget.risks).toEqual(["unknown"]);
		expect(missingTarget.networkTargets).toEqual([]);
	});

	it("treats dynamic, compound, and unrecognized shell expressions as unknown", () => {
		for (const command of ["cat $(find . -name x)", "cat file | wc -l", "echo $SECRET", "some-script --flag"]) {
			const shell = action("bash", { command });
			expect(shell.risks, command).toContain("unknown");
			expect(shell.sandbox, command).toBe("workspace-write");
			expect(routeAction(settings("auto"), shell, "assistant"), command).toBe("reviewer");
		}
	});

	it("allows known build and test commands only in a workspace-write sandbox", () => {
		for (const command of ["npm test", "pnpm run build", "cargo check", "go test ./...", "pytest"]) {
			const shell = action("bash", { command });
			expect(shell.risks, command).toEqual(["workspace-write"]);
			expect(shell.sandbox, command).toBe("workspace-write");
			expect(routeAction(settings("auto"), shell, "assistant"), command).toBe("allow");
		}
	});

	it("always routes extension, SDK, and MCP tools through the custom path", () => {
		for (const provenance of ["extension", "sdk", "mcp"] as const) {
			const custom = action("web_search", { query: "x" }, provenance);
			expect(custom.risks).toEqual(["custom"]);
			expect(routeAction(settings("ask"), custom, "assistant")).toBe("user");
			expect(routeAction(settings("auto"), custom, "assistant")).toBe("reviewer");
			expect(routeAction(settings("full"), custom, "assistant")).toBe("allow");
		}
	});

	it("uses the user rather than the reviewer for manual shell and disabled review", () => {
		const network = action("bash", { command: "ssh example.com" });
		expect(routeAction(settings("auto"), network, "user-bash")).toBe("user");
		expect(routeAction(settings("auto", false), network, "assistant")).toBe("user");
	});

	it("issues exact one-action grants without changing persistent settings", () => {
		const ordinaryRead = action("read", { path: join(cwd, "src", "file.ts") });
		expect(createSandboxGrant(ordinaryRead, { cwd }).readPaths).toEqual([]);
		const sensitiveRead = action("read", { path: join(cwd, ".env.local") });
		expect(createSandboxGrant(sensitiveRead, { cwd }).readPaths).toEqual(sensitiveRead.paths);

		const outsideWrite = action("write", { path: join(outside, "new.txt"), content: "x" });
		expect(createSandboxGrant(outsideWrite, { cwd })).toMatchObject({
			actionId: "action-1",
			sandbox: "exact",
			writePaths: outsideWrite.paths,
			fullOnce: false,
		});
		expect(createSandboxGrant(outsideWrite, { cwd, fullOnce: true })).toMatchObject({
			sandbox: "none",
			fullOnce: true,
		});
	});

	it("does not accept Full-once from an approval adapter when exact sandbox targets are sufficient", async () => {
		const outsideWrite = action("write", { path: join(outside, "new.txt"), content: "x" });
		const result = await new PermissionPolicy(undefined, async () => ({
			decision: "allow",
			fullOnce: true,
		})).authorize({
			settings: settings("auto", false),
			action: outsideWrite,
			actionSource: "assistant",
			args: { path: join(outside, "new.txt"), content: "x" },
			userMessages: ["write the file"],
			cwd,
		});
		expect(result).toMatchObject({ decision: "allow", grant: { fullOnce: false, writePaths: outsideWrite.paths } });
	});

	it("tokenizes quoted paths but rejects unterminated or shell-expanded values", () => {
		expect(tokenizePermissionCommand('cat "a b.txt"').tokens).toEqual(["cat", "a b.txt"]);
		expect(tokenizePermissionCommand('cat "unterminated').ambiguous).toBe(true);
		expect(tokenizePermissionCommand(`cat "${join(homedir(), ".ssh", "config")}"`).ambiguous).toBe(false);
	});
});
