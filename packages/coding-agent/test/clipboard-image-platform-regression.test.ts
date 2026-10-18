import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readClipboardImage } from "../src/utils/clipboard-image.ts";
import type { ClipboardCommandOptions, ClipboardCommandResult } from "../src/utils/clipboard-process.ts";

const mocks = vi.hoisted(() => {
	return {
		runClipboardCommand:
			vi.fn<
				(
					command: string,
					args: readonly string[],
					options?: ClipboardCommandOptions,
				) => Promise<ClipboardCommandResult>
			>(),
	};
});

vi.mock("../src/utils/clipboard-process.js", () => ({ runClipboardCommand: mocks.runClipboardCommand }));
vi.mock("../src/utils/photon.js", () => ({ loadPhoton: async () => null }));

const POWERSHELL_TIMEOUT_MS = 5000;
const temporaryDirectories: string[] = [];
const temporaryFiles: string[] = [];

function commandOk(stdout: Buffer): ClipboardCommandResult {
	return { ok: true, stdout };
}

function commandError(): ClipboardCommandResult {
	return { ok: false, stdout: Buffer.alloc(0) };
}

function buildPowerShellScript(pathForScript: string): string {
	return [
		"Add-Type -AssemblyName System.Windows.Forms",
		"Add-Type -AssemblyName System.Drawing",
		`$path = '${pathForScript.replaceAll("'", "''")}'`,
		"$img = [System.Windows.Forms.Clipboard]::GetImage()",
		"if ($img) { $img.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); Write-Output 'ok' } else { Write-Output 'empty' }",
	].join("; ");
}

function outputPathFromScript(script: string): string {
	const quotedPath = script.match(/\$path = '(.*)';\s*\$img =/)?.[1];
	if (!quotedPath) throw new Error(`Could not find the output path in: ${script}`);
	return quotedPath.replaceAll("''", "'");
}

beforeEach(() => {
	mocks.runClipboardCommand.mockReset();
});

afterEach(() => {
	vi.unstubAllEnvs();
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
	for (const file of temporaryFiles.splice(0)) {
		rmSync(file, { force: true });
	}
});

describe("WSL clipboard image", () => {
	test("converts the temp path and escapes apostrophes in the exact PowerShell script", async () => {
		let linuxPath: string | undefined;
		let script: string | undefined;
		let powershellOptions: ClipboardCommandOptions | undefined;

		mocks.runClipboardCommand.mockImplementation(async (command, args, options) => {
			if (command === "wl-paste" || command === "xclip") return commandError();

			if (command === "wslpath") {
				expect(args).toEqual(["-w", expect.any(String)]);
				linuxPath = args[1];
				return commandOk(Buffer.from("C:\\Users\\O'Hare\\shot.png\n", "utf-8"));
			}

			if (command === "powershell.exe") {
				expect(args.slice(0, 2)).toEqual(["-NoProfile", "-Command"]);
				script = args[2];
				powershellOptions = options;
				writeFileSync(linuxPath!, Buffer.from([1, 2, 3]));
				return commandOk(Buffer.from("ok\n", "utf-8"));
			}

			throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
		});

		const image = await readClipboardImage({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } });

		expect(image?.mimeType).toBe("image/png");
		expect(Array.from(image?.bytes ?? [])).toEqual([1, 2, 3]);
		expect(script).toBe(buildPowerShellScript("C:\\Users\\O'Hare\\shot.png"));
		expect(powershellOptions?.timeoutMs).toBe(POWERSHELL_TIMEOUT_MS);
		expect(linuxPath).toBeTruthy();
		expect(existsSync(linuxPath!)).toBe(false);
	});

	test("returns null when wslpath conversion fails and still removes the temp path", async () => {
		let linuxPath: string | undefined;

		mocks.runClipboardCommand.mockImplementation(async (command, args) => {
			if (command === "wl-paste" || command === "xclip") return commandError();
			if (command === "wslpath") {
				linuxPath = args[1];
				writeFileSync(linuxPath, "stale");
				return commandError();
			}
			throw new Error(`powershell.exe must not run after a failed conversion: ${args.join(" ")}`);
		});

		const image = await readClipboardImage({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } });

		expect(image).toBeNull();
		expect(linuxPath).toBeTruthy();
		expect(existsSync(linuxPath!)).toBe(false);
	});

	test("returns null for an empty clipboard and removes the temp path", async () => {
		let linuxPath: string | undefined;

		mocks.runClipboardCommand.mockImplementation(async (command, args) => {
			if (command === "wl-paste" || command === "xclip") return commandError();
			if (command === "wslpath") {
				linuxPath = args[1];
				return commandOk(Buffer.from("C:\\Temp\\clip.png\n", "utf-8"));
			}
			if (command === "powershell.exe") {
				expect(args[2]).toBe(buildPowerShellScript("C:\\Temp\\clip.png"));
				writeFileSync(linuxPath!, "stale");
				return commandOk(Buffer.from("empty\n", "utf-8"));
			}
			throw new Error(`Unexpected command: ${command}`);
		});

		const image = await readClipboardImage({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } });

		expect(image).toBeNull();
		expect(existsSync(linuxPath!)).toBe(false);
	});

	test("catches a rejected PowerShell command, cleans up, and falls back to xclip", async () => {
		let linuxPath: string | undefined;
		let powershellRejected = false;
		let xclipCalledAfterRejection = false;

		mocks.runClipboardCommand.mockImplementation(async (command, args) => {
			if (command === "wl-paste") return commandError();

			if (command === "xclip") {
				if (powershellRejected) xclipCalledAfterRejection = true;
				return commandError();
			}

			if (command === "wslpath") {
				linuxPath = args[1];
				writeFileSync(linuxPath, "partial");
				return commandOk(Buffer.from("C:\\Temp\\clip.png\n", "utf-8"));
			}

			if (command === "powershell.exe") {
				powershellRejected = true;
				throw new Error("powershell rejected");
			}

			throw new Error(`Unexpected command: ${command}`);
		});

		const image = await readClipboardImage({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } });

		expect(image).toBeNull();
		expect(powershellRejected).toBe(true);
		expect(xclipCalledAfterRejection).toBe(true);
		expect(existsSync(linuxPath!)).toBe(false);
	});
});

describe("Windows clipboard image", () => {
	test("uses the native temp path and escapes apostrophes in the exact PowerShell script", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-clipboard-windows-"));
		temporaryDirectories.push(root);
		const tempDirectory = join(root, "O'Hare");
		mkdirSync(tempDirectory);
		vi.stubEnv("TMPDIR", tempDirectory);
		vi.stubEnv("TEMP", tempDirectory);
		vi.stubEnv("TMP", tempDirectory);

		let outputPath: string | undefined;
		let script: string | undefined;
		let powershellOptions: ClipboardCommandOptions | undefined;

		mocks.runClipboardCommand.mockImplementation(async (command, args, options) => {
			expect(command).toBe("powershell.exe");
			expect(args.slice(0, 2)).toEqual(["-NoProfile", "-Command"]);
			script = args[2];
			powershellOptions = options;
			outputPath = outputPathFromScript(script);
			expect(outputPath).toContain(join(tempDirectory, "metis-clip-"));
			writeFileSync(outputPath, Buffer.from([8, 9]));
			return commandOk(Buffer.from("ok\n", "utf-8"));
		});

		const image = await readClipboardImage({ platform: "win32", env: {} });

		expect(image?.mimeType).toBe("image/png");
		expect(Array.from(image?.bytes ?? [])).toEqual([8, 9]);
		expect(script).toBe(buildPowerShellScript(outputPath!));
		expect(powershellOptions?.timeoutMs).toBe(POWERSHELL_TIMEOUT_MS);
		expect(existsSync(outputPath!)).toBe(false);
	});

	test("returns null for an empty clipboard and removes the temp file", async () => {
		let outputPath: string | undefined;

		mocks.runClipboardCommand.mockImplementation(async (command, args) => {
			expect(command).toBe("powershell.exe");
			outputPath = outputPathFromScript(args[2]);
			writeFileSync(outputPath, "partial");
			return commandOk(Buffer.from("empty\n", "utf-8"));
		});

		const image = await readClipboardImage({ platform: "win32", env: {} });

		expect(image).toBeNull();
		expect(existsSync(outputPath!)).toBe(false);
	});

	test("returns null when the PowerShell command fails and removes the temp file", async () => {
		let outputPath: string | undefined;

		mocks.runClipboardCommand.mockImplementation(async (_command, args) => {
			outputPath = outputPathFromScript(args[2]);
			writeFileSync(outputPath, "partial");
			return commandError();
		});

		const image = await readClipboardImage({ platform: "win32", env: {} });

		expect(image).toBeNull();
		expect(existsSync(outputPath!)).toBe(false);
	});

	test("returns null when PowerShell succeeds but the image file cannot be read", async () => {
		let outputPath: string | undefined;

		mocks.runClipboardCommand.mockImplementation(async (_command, args) => {
			outputPath = outputPathFromScript(args[2]);
			return commandOk(Buffer.from("ok\n", "utf-8"));
		});

		const image = await readClipboardImage({ platform: "win32", env: {} });

		expect(image).toBeNull();
		expect(existsSync(outputPath!)).toBe(false);
	});

	test("propagates a rejected PowerShell command without running failure cleanup", async () => {
		const rejection = new Error("powershell rejected");
		let outputPath: string | undefined;

		mocks.runClipboardCommand.mockImplementation(async (_command, args) => {
			outputPath = outputPathFromScript(args[2]);
			writeFileSync(outputPath, "partial");
			temporaryFiles.push(outputPath);
			throw rejection;
		});

		await expect(readClipboardImage({ platform: "win32", env: {} })).rejects.toBe(rejection);

		expect(outputPath).toBeTruthy();
		// The original Windows path has no try/catch/finally around the command, so a
		// rejection bypasses both the failure-branch unlink and readTemporaryImage cleanup.
		expect(existsSync(outputPath!)).toBe(true);
	});
});
