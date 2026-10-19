import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { acquireLockSyncWithRetry } from "../src/utils/lock-retry.ts";

function elockedError(): Error & { code: string } {
	return Object.assign(new Error("lock is held"), { code: "ELOCKED" });
}

function captureThrown(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error("Expected the callback to throw");
}

describe("acquireLockSyncWithRetry raw error handling", () => {
	it("reads the raw code getter once per attempt and rethrows the final raw error", () => {
		const reads = vi.fn(() => "ELOCKED");
		const errors = [elockedError(), elockedError(), elockedError()];
		for (const error of errors) {
			Object.defineProperty(error, "code", { configurable: true, get: reads });
		}
		let attempt = 0;
		const acquire = vi.fn<() => () => void>(() => {
			throw errors[attempt++];
		});

		const thrown = captureThrown(() => acquireLockSyncWithRetry(acquire, { maxAttempts: errors.length, delayMs: 1 }));

		expect(thrown).toBe(errors[2]);
		expect(acquire).toHaveBeenCalledTimes(3);
		// Re-reading a getter after a wait would observe a different value and
		// silently change how a raw lock failure is classified.
		expect(reads).toHaveBeenCalledTimes(3);
	});

	it("propagates a throwing raw code getter immediately without retrying", () => {
		const getterError = new Error("unreadable error code");
		const failure = new Error("opaque lock failure");
		Object.defineProperty(failure, "code", {
			configurable: true,
			get() {
				throw getterError;
			},
		});
		const acquire = vi.fn<() => () => void>(() => {
			throw failure;
		});

		const thrown = captureThrown(() => acquireLockSyncWithRetry(acquire, { maxAttempts: 3, delayMs: 1 }));

		expect(thrown).toBe(getterError);
		expect(acquire).toHaveBeenCalledTimes(1);
	});

	it("keeps the synchronous retry contract when Atomics and SharedArrayBuffer are unavailable", () => {
		const moduleUrl = pathToFileURL(fileURLToPath(new URL("../src/utils/lock-retry.ts", import.meta.url))).href;
		const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
		const source = `
delete globalThis.Atomics;
delete globalThis.SharedArrayBuffer;
const { acquireLockSyncWithRetry } = await import(${JSON.stringify(moduleUrl)});
const errors = Array.from({ length: 3 }, () => Object.assign(new Error("lock is held"), { code: "ELOCKED" }));
let attempts = 0;
let thrown;
try {
  acquireLockSyncWithRetry(() => { throw errors[attempts++]; }, { maxAttempts: 3, delayMs: 1 });
} catch (error) {
  thrown = error;
}
console.log(JSON.stringify({ attempts, sameRawError: thrown === errors[2], code: thrown && thrown.code }));
`;
		const raw = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], {
			cwd: repoRoot,
			encoding: "utf8",
			timeout: 20_000,
		});
		const output = JSON.parse(raw.trim().split("\n").at(-1)!) as {
			attempts: number;
			sameRawError: boolean;
			code?: string;
		};

		expect(output).toEqual({ attempts: 3, sameRawError: true, code: "ELOCKED" });
	});
});
