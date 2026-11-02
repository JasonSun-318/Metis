import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as config from "../src/config.ts";
import {
	createSandboxRuntimeConfig,
	exactNetworkGrantAllows,
	prepareWindowsCommand,
} from "../src/core/workspace-sandbox-broker.ts";
import { pathsIntersect } from "../src/utils/paths.ts";
import { getShellConfig } from "../src/utils/shell.ts";

// Verify the configuration without requiring a host-specific executable on disk.
vi.mock("../src/core/workspace-sandbox-health.ts", () => ({
	bundledSandboxHelperPath: (kind: "seccomp" | "srt-win") => `/mocked/sandbox-helper/${kind}`,
}));

describe("workspace sandbox broker policy", () => {
	const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

	afterEach(() => {
		Object.defineProperty(process, "platform", originalPlatform!);
		vi.restoreAllMocks();
	});

	it("allows only an exact canonical host and port", () => {
		const endpoints = [{ hostname: "api.example.com", port: 443 }];
		expect(exactNetworkGrantAllows(endpoints, { host: "API.EXAMPLE.COM.", port: 443 })).toBe(true);
		for (const target of [
			{ host: "api.example.com", port: 80 },
			{ host: "sub.api.example.com", port: 443 },
			{ host: "evil-example.com", port: 443 },
			{ host: "*.example.com", port: 443 },
			{ host: "user@api.example.com", port: 443 },
			{ host: "127.0.0.1", port: 443 },
			{ host: "localhost", port: 443 },
		]) {
			expect(exactNetworkGrantAllows(endpoints, target), JSON.stringify(target)).toBe(false);
		}
	});

	it("builds deny-first filesystem policy and delegates every network decision to the exact endpoint gate", () => {
		const protectedPaths = ["/work/.git", "/work/.metis", "/work/.codex", "/work/.agents"];
		const config = createSandboxRuntimeConfig({
			workspaceRoots: ["/work"],
			readOnlyRoots: ["/read"],
			writeRoots: ["/work/out"],
			protectedRoots: ["/secret"],
			writeProtectedRoots: protectedPaths,
			temporaryDir: "/private/tmp/sandbox",
			runtimeReads: ["/bin"],
		});

		expect(config.filesystem.allowWrite).toEqual(expect.arrayContaining(["/work", "/work/out"]));
		expect(config.filesystem.denyWrite).toEqual(expect.arrayContaining(protectedPaths));
		for (const allowed of config.filesystem.allowWrite) {
			for (const denied of config.filesystem.denyWrite.filter((path) => !protectedPaths.includes(path))) {
				expect(pathsIntersect(allowed, denied), `${allowed} conflicts with ${denied}`).toBe(false);
			}
		}
		expect(config.network).toMatchObject({ allowedDomains: [], deniedDomains: [], strictAllowlist: false });
	});

	it.each(["darwin", "linux", "win32"])("configures the executable helpers for %s", (platform) => {
		Object.defineProperty(process, "platform", { value: platform, configurable: true });
		const config = createSandboxRuntimeConfig({
			workspaceRoots: ["/work"],
			readOnlyRoots: [],
			writeRoots: ["/work/out"],
			protectedRoots: [],
			writeProtectedRoots: [],
			temporaryDir: "/tmp/metis-sandbox",
			runtimeReads: ["/bin"],
		});

		expect(config.seccomp).toEqual(
			platform === "linux" ? { applyPath: "/mocked/sandbox-helper/seccomp" } : undefined,
		);
		if (platform === "linux") expect(config.filesystem.allowRead).toContain("/mocked/sandbox-helper/seccomp");
		else expect(config.filesystem.allowRead).not.toContain("/mocked/sandbox-helper/seccomp");
		expect(config.windows).toEqual(
			platform === "win32" ? { srtWin: { path: "/mocked/sandbox-helper/srt-win" } } : undefined,
		);
	});

	it("relies on the isolated Windows account for system reads and grants only user-owned runtime paths", () => {
		const config = createSandboxRuntimeConfig(
			{
				workspaceRoots: ["C:\\Users\\jason\\project"],
				readOnlyRoots: [],
				writeRoots: [],
				protectedRoots: [],
				writeProtectedRoots: [],
				temporaryDir: "C:\\Users\\jason\\AppData\\Local\\Temp\\metis-sandbox",
				runtimeReads: ["C:\\Windows", "C:\\Program Files", "C:\\Users\\jason\\AppData\\Local\\Metis\\native-tools"],
			},
			"win32",
			"C:\\Users\\jason",
		);

		expect(config.filesystem.denyRead).toEqual([]);
		expect(config.filesystem.allowRead).toContain("C:\\Users\\jason\\AppData\\Local\\Metis\\native-tools");
		expect(config.filesystem.allowRead).not.toContain("C:\\Windows");
		expect(config.filesystem.allowRead).not.toContain("C:\\Program Files");
	});

	it("grants bundled tools outside the user profile without stamping system directories", () => {
		const bundledTools = "D:\\build\\Metis\\native-tools";
		vi.spyOn(config, "getBundledToolsDir").mockReturnValue(bundledTools);
		const runtime = createSandboxRuntimeConfig(
			{
				workspaceRoots: ["C:\\Users\\jason\\project"],
				readOnlyRoots: [],
				writeRoots: [],
				protectedRoots: [],
				writeProtectedRoots: [],
				temporaryDir: "C:\\Users\\jason\\AppData\\Local\\Temp\\sandbox",
				runtimeReads: [bundledTools, "C:\\Windows", "C:\\Program Files"],
			},
			"win32",
			"C:\\Users\\jason",
		);
		expect(runtime.filesystem.allowRead).toContain(bundledTools);
		expect(runtime.filesystem.allowRead).not.toContain("C:\\Windows");
		expect(runtime.filesystem.allowRead).not.toContain("C:\\Program Files");
	});

	it("grants the Windows command directory read access and carves it out of writes", () => {
		const temporaryDir = "C:\\Users\\jason\\AppData\\Local\\Temp\\metis-sandbox";
		const windowsCommandDir = `${temporaryDir}\\commands`;
		const input = {
			workspaceRoots: ["C:\\Users\\jason\\project"],
			readOnlyRoots: [],
			writeRoots: [],
			protectedRoots: [],
			writeProtectedRoots: [],
			temporaryDir,
			runtimeReads: [],
			windowsCommandDir,
		};
		const config = createSandboxRuntimeConfig(input, "win32", "C:\\Users\\jason");
		expect(config.filesystem.allowWrite).toContain(temporaryDir);
		expect(config.filesystem.allowRead).toContain(windowsCommandDir);
		expect(config.filesystem.denyWrite).toContain(windowsCommandDir);

		// POSIX platforms never receive the Windows-only transport directory.
		const posixDir = "/tmp/metis-sandbox/commands";
		const posixConfig = createSandboxRuntimeConfig(
			{ ...input, temporaryDir: "/tmp/metis-sandbox", windowsCommandDir: posixDir },
			"darwin",
		);
		expect(posixConfig.filesystem.allowRead).not.toContain(posixDir);
		expect(posixConfig.filesystem.denyWrite).not.toContain(posixDir);
	});
});

describe("Windows command file transport", () => {
	it("keeps the whole command out of argv and runs it from a quoted path", () => {
		// The directory name deliberately carries a single quote and a would-be
		// command substitution: the bootstrap must quote both as literal text.
		const root = mkdtempSync(join(tmpdir(), "metis-command-'$(touch injected)-"));
		try {
			const commandDir = join(root, "commands");
			mkdirSync(commandDir);
			const payload = "x".repeat(32 * 1024 - 14);
			const command = `printf '%s' '${payload}'`;
			expect(Buffer.byteLength(command, "utf8")).toBe(32 * 1024);

			const shell = getShellConfig();
			const prepared = prepareWindowsCommand(commandDir, command, shell.shell);
			const [fileName] = readdirSync(commandDir);
			expect(fileName).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.sh$/);
			expect(readFileSync(join(commandDir, fileName!), "utf8")).toBe(command);
			expect(prepared.bootstrap.length).toBeLessThan(200);
			expect(prepared.bootstrap).not.toContain("x".repeat(64));

			const output = execFileSync(shell.shell, [...shell.args, prepared.bootstrap], {
				cwd: root,
				encoding: "utf8",
				windowsHide: true,
			});
			expect(output).toBe(payload);
			expect(existsSync(join(root, "injected"))).toBe(false);

			prepared.cleanup();
			prepared.cleanup();
			expect(readdirSync(commandDir)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("uses a cat bootstrap for sh and cleans up after a failing command", () => {
		const root = mkdtempSync(join(tmpdir(), "metis-command-sh-"));
		try {
			const prepared = prepareWindowsCommand(root, "exit 3", "C:\\Program Files\\Git\\bin\\sh.exe");
			expect(prepared.bootstrap).toMatch(/^eval "\$\(cat '[^']*'\)"$/);
			expect(prepared.bootstrap).not.toContain("exit 3");
			expect(readdirSync(root)).toHaveLength(1);

			const shell = getShellConfig();
			const result = spawnSync(shell.shell, [...shell.args, prepared.bootstrap], {
				cwd: root,
				encoding: "utf8",
				windowsHide: true,
			});
			expect(result.status).toBe(3);

			prepared.cleanup();
			expect(readdirSync(root)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
