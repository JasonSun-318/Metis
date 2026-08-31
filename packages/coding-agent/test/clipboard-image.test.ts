import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeEach, describe, expect, test, vi } from "vitest";
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
		convertedPng: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
	};
});

vi.mock("../src/utils/clipboard-process.js", () => ({ runClipboardCommand: mocks.runClipboardCommand }));

vi.mock("../src/utils/photon.js", () => ({
	loadPhoton: async () => ({
		PhotonImage: {
			new_from_byteslice: () => ({
				get_bytes: () => mocks.convertedPng,
				free: () => {},
			}),
		},
	}),
}));

function commandOk(stdout: Buffer) {
	return { ok: true, stdout };
}

function commandError() {
	return { ok: false, stdout: Buffer.alloc(0) };
}

describe("readClipboardImage", () => {
	beforeEach(() => {
		vi.resetModules();
		mocks.runClipboardCommand.mockReset();
	});

	test("Wayland: uses wl-paste", async () => {
		mocks.runClipboardCommand.mockImplementation(async (command, args, _options) => {
			if (command === "wl-paste" && args[0] === "--list-types") {
				return commandOk(Buffer.from("text/plain\nimage/png\n", "utf-8"));
			}
			if (command === "wl-paste" && args[0] === "--type") {
				return commandOk(Buffer.from([1, 2, 3]));
			}
			throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "linux", env: { WAYLAND_DISPLAY: "1" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([1, 2, 3]);
	});

	test("Wayland: falls back to xclip when wl-paste is missing", async () => {
		mocks.runClipboardCommand.mockImplementation(async (command, args, _options) => {
			if (command === "wl-paste") {
				return commandError();
			}

			if (command === "xclip" && args.includes("TARGETS")) {
				return commandOk(Buffer.from("image/png\n", "utf-8"));
			}

			if (command === "xclip" && args.includes("image/png")) {
				return commandOk(Buffer.from([9, 8]));
			}

			return commandOk(Buffer.alloc(0));
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "linux", env: { XDG_SESSION_TYPE: "wayland" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([9, 8]);
	});

	test("WSL: passes PowerShell path directly instead of through a custom env var", async () => {
		let tmpFile: string | undefined;
		mocks.runClipboardCommand.mockImplementation(async (command, args, options) => {
			if (command === "wl-paste" || command === "xclip") {
				return commandOk(Buffer.alloc(0));
			}

			if (command === "wslpath") {
				tmpFile = args[1];
				return commandOk(Buffer.from("C:\\Users\\O'Hare\\clip.png\n", "utf-8"));
			}

			if (command === "powershell.exe") {
				const spawnOptions = options as { env?: NodeJS.ProcessEnv };
				expect(spawnOptions.env?.METIS_WSL_CLIPBOARD_IMAGE_PATH).toBeUndefined();
				expect(args[2]).toContain("$path = 'C:\\Users\\O''Hare\\clip.png'");
				if (!tmpFile) {
					throw new Error("wslpath should be called before powershell.exe");
				}
				writeFileSync(tmpFile, Buffer.from([4, 5, 6]));
				return commandOk(Buffer.from("ok\n", "utf-8"));
			}

			throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([4, 5, 6]);
	});

	test("macOS: reads a PNG through osascript", async () => {
		mocks.runClipboardCommand.mockImplementation(async (command, args) => {
			expect(command).toBe("osascript");
			if (args.some((arg) => arg.includes("POSIX path"))) return commandOk(Buffer.from("\n"));
			const tmpFile = args.at(-1);
			expect(tmpFile).toBeTruthy();
			writeFileSync(tmpFile!, Buffer.from([7]));
			return commandOk(Buffer.from("ok\n", "utf-8"));
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "darwin", env: {} });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([7]);
	});

	test("macOS: falls back to TIFF and converts it to PNG", async () => {
		mocks.runClipboardCommand.mockImplementation(async (command, args) => {
			expect(command).toBe("osascript");
			if (args.some((arg) => arg.includes("POSIX path"))) return commandOk(Buffer.from("\n"));
			if (args.some((arg) => arg.includes("PNGf"))) return commandOk(Buffer.from("empty\n", "utf-8"));
			expect(args.some((arg) => arg.includes("TIFF"))).toBe(true);
			const tmpFile = args.at(-1);
			expect(tmpFile).toBeTruthy();
			writeFileSync(tmpFile!, Buffer.from([1, 2, 3]));
			return commandOk(Buffer.from("ok\n", "utf-8"));
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "darwin", env: {} });
		expect(result?.mimeType).toBe("image/png");
		expect(result?.bytes).toEqual(mocks.convertedPng);
	});

	test("macOS: reads the original image when Finder copied a file", async () => {
		const dir = mkdtempSync(join(tmpdir(), "metis-clipboard-"));
		const filePath = join(dir, "copied.png");
		const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
		writeFileSync(filePath, png);
		mocks.runClipboardCommand.mockImplementation(async (command, args) => {
			expect(command).toBe("osascript");
			expect(args.some((arg) => arg.includes("POSIX path"))).toBe(true);
			return commandOk(Buffer.from(`${filePath}\n`));
		});

		try {
			const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
			const result = await readClipboardImage({ platform: "darwin", env: {} });
			expect(result?.mimeType).toBe("image/png");
			expect(result?.bytes).toEqual(new Uint8Array(png));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("Windows: reads a PNG through PowerShell", async () => {
		mocks.runClipboardCommand.mockImplementation(async (command, args) => {
			expect(command).toBe("powershell.exe");
			const pathMatch = args[2]?.match(/\$path = '([^']+)'/);
			expect(pathMatch?.[1]).toBeTruthy();
			writeFileSync(pathMatch![1], Buffer.from([8, 9]));
			return commandOk(Buffer.from("ok\n", "utf-8"));
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "win32", env: {} });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([8, 9]);
	});
});
