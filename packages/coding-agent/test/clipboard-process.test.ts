import { describe, expect, it } from "vitest";
import { runClipboardCommand } from "../src/utils/clipboard-process.ts";

describe("runClipboardCommand", () => {
	it("writes stdin and captures binary stdout asynchronously", async () => {
		const result = await runClipboardCommand(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], {
			input: new Uint8Array([0, 1, 2, 255]),
			timeoutMs: 1_000,
		});

		expect(result).toEqual({ ok: true, stdout: Buffer.from([0, 1, 2, 255]) });
	});

	it("kills a command that exceeds its timeout", async () => {
		const startedAt = Date.now();
		const result = await runClipboardCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			timeoutMs: 20,
		});

		expect(result).toEqual({ ok: false, stdout: Buffer.alloc(0) });
		expect(Date.now() - startedAt).toBeLessThan(1_000);
	});

	it("rejects output beyond the configured buffer without retaining it", async () => {
		const result = await runClipboardCommand(process.execPath, ["-e", "process.stdout.write('too large')"], {
			maxBufferBytes: 3,
			timeoutMs: 1_000,
		});

		expect(result).toEqual({ ok: false, stdout: Buffer.alloc(0) });
	});
});
