import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWindowsSandboxSetup, repairWindowsSandboxAccess } from "../src/main/windows-sandbox-setup.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })),
	);
});

async function packagedFixture(): Promise<{ readonly appPath: string; readonly helperPath: string }> {
	const root = await mkdtemp(join(tmpdir(), "metis-windows-sandbox-"));
	temporaryDirectories.push(root);
	const appPath = join(root, "resources", "app.asar");
	const runtimeRoot = join(
		root,
		"resources",
		"app.asar.unpacked",
		".webpack",
		"app-server",
		"node_modules",
		"@metis",
		"coding-agent",
		"dist",
		"vendor",
		"sandbox-runtime",
	);
	const helperPath = join(runtimeRoot, "srt-win", "x64", "srt-win.exe");
	const bytes = Buffer.from("verified srt-win fixture");
	await mkdir(join(runtimeRoot, "srt-win", "x64"), { recursive: true });
	await writeFile(helperPath, bytes);
	await writeFile(
		join(runtimeRoot, "manifest.json"),
		JSON.stringify({
			schemaVersion: 1,
			package: "@anthropic-ai/sandbox-runtime",
			version: "0.0.67",
			helpers: [
				{
					kind: "srt-win",
					architecture: "x64",
					file: "srt-win/x64/srt-win.exe",
					sha256: createHash("sha256").update(bytes).digest("hex"),
					executable: false,
				},
			],
		}),
	);
	return { appPath, helperPath };
}

describe("Windows sandbox setup", () => {
	it("runs only the verified packaged helper and maps UAC cancellation", async () => {
		const fixture = await packagedFixture();
		const runInstaller = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(10);
		const grantHelperRead = vi.fn().mockResolvedValue(undefined);
		const verifyRuntime = vi.fn().mockResolvedValue(undefined);
		const setup = createWindowsSandboxSetup({
			appPath: fixture.appPath,
			architecture: "x64",
			isPackaged: true,
			platform: "win32",
			runInstaller,
			grantHelperRead,
			verifyRuntime,
		});

		await expect(setup()).resolves.toBe("installed");
		await expect(setup()).resolves.toBe("cancelled");
		expect(runInstaller).toHaveBeenNthCalledWith(1, fixture.helperPath);
		expect(grantHelperRead).toHaveBeenCalledOnce();
		expect(verifyRuntime).toHaveBeenCalledOnce();
	});

	it("does not report installed until the packaged helper can launch the sandbox user", async () => {
		const fixture = await packagedFixture();
		const setup = createWindowsSandboxSetup({
			appPath: fixture.appPath,
			architecture: "x64",
			isPackaged: true,
			platform: "win32",
			runInstaller: vi.fn().mockResolvedValue(0),
			grantHelperRead: vi.fn().mockResolvedValue(undefined),
			verifyRuntime: vi.fn().mockRejectedValue(new Error("CreateProcessWithLogonW access denied")),
		});

		await expect(setup()).rejects.toThrow("CreateProcessWithLogonW access denied");
	});

	it("verifies the Windows network fence with a local egress probe target", async () => {
		const fixture = await packagedFixture();
		const runCommand = vi.fn(async (_executable: string, args: readonly string[]) => {
			expect(args.slice(0, 3)).toEqual(["wfp", "verify", "--target"]);
			expect(args[3]).toMatch(/^127\.0\.0\.1:\d+$/u);
			return {
				exitCode: 0,
				stdout: JSON.stringify({ egress_probe: "blocked", target: args[3] }),
				stderr: "",
			};
		});
		const setup = createWindowsSandboxSetup({
			appPath: fixture.appPath,
			architecture: "x64",
			isPackaged: true,
			platform: "win32",
			runInstaller: vi.fn().mockResolvedValue(0),
			grantHelperRead: vi.fn().mockResolvedValue(undefined),
			runCommand,
		});

		await expect(setup()).resolves.toBe("installed");
		expect(runCommand).toHaveBeenCalledOnce();
	});

	it("repairs read and execute access on the verified helper after an app update", async () => {
		const fixture = await packagedFixture();
		const sid = "S-1-5-21-111-222-333-1001";
		const runCommand = vi
			.fn()
			.mockResolvedValueOnce({
				exitCode: 0,
				stdout: JSON.stringify({ user: { sid } }),
				stderr: "",
			})
			.mockResolvedValueOnce({ exitCode: 0, stdout: "", stderr: "" });

		await expect(
			repairWindowsSandboxAccess({
				appPath: fixture.appPath,
				architecture: "x64",
				isPackaged: true,
				platform: "win32",
				runCommand,
			}),
		).resolves.toBe(true);
		expect(runCommand).toHaveBeenNthCalledWith(1, fixture.helperPath, ["user", "status"]);
		expect(runCommand).toHaveBeenNthCalledWith(2, "icacls.exe", [fixture.helperPath, "/grant", `*${sid}:(RX)`]);
	});

	it("refuses a helper whose bytes do not match the bundled manifest", async () => {
		const fixture = await packagedFixture();
		await writeFile(fixture.helperPath, "tampered");
		const runInstaller = vi.fn();
		const setup = createWindowsSandboxSetup({
			appPath: fixture.appPath,
			architecture: "x64",
			isPackaged: true,
			platform: "win32",
			runInstaller,
		});

		await expect(setup()).rejects.toThrow("failed verification");
		expect(runInstaller).not.toHaveBeenCalled();
	});

	it("does not offer setup outside supported Windows architectures", async () => {
		const setup = createWindowsSandboxSetup({
			appPath: "/unused",
			architecture: "ia32",
			isPackaged: true,
			platform: "win32",
			runInstaller: vi.fn(),
		});
		await expect(setup()).resolves.toBe("unsupported");
	});
});
