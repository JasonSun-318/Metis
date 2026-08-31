import { platform } from "os";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { copyToClipboard, readClipboardText } from "../src/utils/clipboard.ts";
import { runClipboardCommand } from "../src/utils/clipboard-process.ts";

const mocks = vi.hoisted(() => {
	return {
		runClipboardCommand: vi.fn(),
		platform: vi.fn<() => NodeJS.Platform>(),
		isWaylandSession: vi.fn<() => boolean>(),
	};
});

vi.mock("../src/utils/clipboard-process.js", () => ({ runClipboardCommand: mocks.runClipboardCommand }));

vi.mock("os", () => {
	return {
		platform: mocks.platform,
	};
});

vi.mock("../src/utils/clipboard-image.js", () => {
	return {
		isWaylandSession: mocks.isWaylandSession,
	};
});

const mockedRunClipboardCommand = vi.mocked(runClipboardCommand);
const mockedPlatform = vi.mocked(platform);

let originalWrite: typeof process.stdout.write;
let stdoutWrites: string[];

function osc52Writes(): string[] {
	return stdoutWrites.filter((write) => write.startsWith("\x1b]52;c;"));
}

beforeEach(() => {
	vi.unstubAllEnvs();
	vi.stubEnv("SSH_CONNECTION", "");
	vi.stubEnv("SSH_CLIENT", "");
	vi.stubEnv("MOSH_CONNECTION", "");
	stdoutWrites = [];
	mocks.runClipboardCommand.mockReset();
	mocks.platform.mockReset();
	mocks.isWaylandSession.mockReset();
	mockedPlatform.mockReturnValue("darwin");
	mocks.isWaylandSession.mockReturnValue(false);
	originalWrite = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((...args: Parameters<typeof process.stdout.write>) => {
		const [chunk] = args;
		if (typeof chunk === "string" && chunk.startsWith("\x1b]52;c;")) {
			stdoutWrites.push(chunk);
			return true;
		}
		return originalWrite(...args);
	}) as typeof process.stdout.write;
});

afterEach(() => {
	process.stdout.write = originalWrite;
	vi.unstubAllEnvs();
});

describe("readClipboardText", () => {
	test("returns platform clipboard text", async () => {
		mockedRunClipboardCommand.mockResolvedValue({ ok: true, stdout: Buffer.from("clipboard text") });

		await expect(readClipboardText()).resolves.toBe("clipboard text");
		expect(mockedRunClipboardCommand).toHaveBeenCalledWith("pbpaste", [], { timeoutMs: 5_000 });
	});

	test("returns null for unavailable clipboard text", async () => {
		mockedRunClipboardCommand.mockResolvedValue({ ok: false, stdout: Buffer.alloc(0) });
		await expect(readClipboardText()).resolves.toBeNull();
	});
});

describe("copyToClipboard", () => {
	test("local platform success skips OSC 52", async () => {
		mockedRunClipboardCommand.mockResolvedValue({ ok: true, stdout: Buffer.alloc(0) });
		await copyToClipboard("hello");

		expect(osc52Writes()).toHaveLength(0);
		expect(mockedRunClipboardCommand).toHaveBeenCalledOnce();
	});

	test("remote platform success emits OSC 52", async () => {
		vi.stubEnv("SSH_CONNECTION", "client server");
		mockedRunClipboardCommand.mockResolvedValue({ ok: true, stdout: Buffer.alloc(0) });

		await copyToClipboard("hello");

		expect(osc52Writes()).toHaveLength(1);
	});

	test("local shell fallback success skips OSC 52", async () => {
		mockedRunClipboardCommand.mockResolvedValue({ ok: true, stdout: Buffer.alloc(0) });

		await copyToClipboard("hello");

		expect(mockedRunClipboardCommand).toHaveBeenCalledWith("pbcopy", [], {
			input: "hello",
			maxBufferBytes: 0,
			timeoutMs: 5_000,
		});
		expect(osc52Writes()).toHaveLength(0);
	});

	test("uses OSC 52 fallback when native and shell tools fail", async () => {
		mockedRunClipboardCommand.mockResolvedValue({ ok: false, stdout: Buffer.alloc(0) });

		await copyToClipboard("hello");

		expect(osc52Writes()).toHaveLength(1);
	});

	test("does not emit oversized OSC 52 payloads", async () => {
		mockedRunClipboardCommand.mockResolvedValue({ ok: false, stdout: Buffer.alloc(0) });

		await expect(copyToClipboard("x".repeat(80_000))).rejects.toThrow("Failed to copy to clipboard");
		expect(osc52Writes()).toHaveLength(0);
	});
});
