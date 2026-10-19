import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { showDeprecationWarnings } from "../src/migrations.ts";

class FakeStdin extends EventEmitter {
	isTTY = false;
	isRaw = false;
	paused = true;
	destroyed = false;
	readableEnded = false;
	rawCalls: boolean[] = [];
	resumeCalls = 0;
	pauseCalls = 0;
	get readableFlowing(): boolean {
		return !this.paused;
	}

	setRawMode(raw: boolean): this {
		this.rawCalls.push(raw);
		this.isRaw = raw;
		return this;
	}

	resume(): this {
		this.resumeCalls++;
		this.paused = false;
		return this;
	}

	pause(): this {
		this.pauseCalls++;
		this.paused = true;
		return this;
	}

	isPaused(): boolean {
		return this.paused;
	}
}

const originalStdinDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
const warnings = ["Global hooks/ directory found. Hooks have been renamed to extensions."];

function useStdin(fake: FakeStdin): FakeStdin {
	Object.defineProperty(process, "stdin", { configurable: true, get: () => fake });
	return fake;
}

function captureLogs(): string[] {
	const logs: string[] = [];
	vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
		logs.push(args.map(String).join(" "));
	});
	return logs;
}

async function expectToSettle(promise: Promise<void>): Promise<void> {
	vi.useFakeTimers();
	try {
		let settled = false;
		void promise.then(() => {
			settled = true;
		});
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(25);
		await Promise.resolve();
		expect(settled).toBe(true);
	} finally {
		vi.useRealTimers();
	}
}

function expectNoStdinListeners(fake: FakeStdin): void {
	for (const event of ["data", "end", "close", "error"]) {
		expect(fake.listenerCount(event), event).toBe(0);
	}
}

afterEach(() => {
	vi.useRealTimers();
	if (originalStdinDescriptor) {
		Object.defineProperty(process, "stdin", originalStdinDescriptor);
	} else {
		Reflect.deleteProperty(process, "stdin");
	}
	vi.restoreAllMocks();
});

describe("showDeprecationWarnings lifecycle", () => {
	it("returns without touching stdin when there are no warnings", async () => {
		const fake = useStdin(new FakeStdin());
		const logs = captureLogs();

		await expect(showDeprecationWarnings([])).resolves.toBeUndefined();

		expect(logs).toEqual([]);
		expect(fake.rawCalls).toEqual([]);
		expect(fake.resumeCalls).toBe(0);
	});

	it("prints warnings and returns without a key prompt when stdin is not a TTY", async () => {
		const fake = useStdin(new FakeStdin());
		fake.isTTY = false;
		const logs = captureLogs();

		await expectToSettle(showDeprecationWarnings(warnings));

		const output = logs.join("\n");
		expect(output).toContain(`Warning: ${warnings[0]}`);
		expect(output).toContain("Move your extensions to the extensions/ directory.");
		expect(output).toContain("Migration guide:");
		expect(output).not.toContain("Press any key");
		expect(fake.rawCalls).toEqual([]);
		expect(fake.resumeCalls).toBe(0);
	});

	it.each([
		["ended", { readableEnded: true }],
		["destroyed", { destroyed: true }],
	])("prints warnings and returns when stdin is %s", async (_name, state) => {
		const fake = useStdin(new FakeStdin());
		fake.isTTY = true;
		Object.assign(fake, state);
		const logs = captureLogs();

		await expectToSettle(showDeprecationWarnings(warnings));

		expect(logs.join("\n")).not.toContain("Press any key");
		expect(fake.rawCalls).toEqual([]);
		expect(fake.resumeCalls).toBe(0);
	});

	it("settles on a keypress exactly once and restores prior raw and pause state", async () => {
		const fake = useStdin(new FakeStdin());
		fake.isTTY = true;
		fake.isRaw = true;
		fake.paused = false;
		const logs = captureLogs();

		const pending = showDeprecationWarnings(warnings);
		expect(fake.listenerCount("data")).toBe(1);
		expect(fake.listenerCount("end")).toBe(1);
		expect(fake.listenerCount("close")).toBe(1);
		expect(fake.listenerCount("error")).toBe(1);

		fake.emit("data", Buffer.from("x"));
		fake.emit("data", Buffer.from("y"));

		await expect(pending).resolves.toBeUndefined();
		expect(fake.isRaw).toBe(true);
		expect(fake.paused).toBe(false);
		expect(fake.rawCalls).toEqual([true, true]);
		expect(fake.resumeCalls).toBe(1);
		expect(fake.pauseCalls).toBe(0);
		expectNoStdinListeners(fake);
		expect(logs.join("\n")).toContain("Press any key");
	});

	it("pauses stdin again when it owned a paused stdin before the prompt", async () => {
		const fake = useStdin(new FakeStdin());
		fake.isTTY = true;
		fake.isRaw = false;
		fake.paused = true;
		captureLogs();

		const pending = showDeprecationWarnings(warnings);
		fake.emit("data", Buffer.from("x"));
		await expect(pending).resolves.toBeUndefined();

		expect(fake.isRaw).toBe(false);
		expect(fake.paused).toBe(true);
		expect(fake.rawCalls).toEqual([true, false]);
		expect(fake.resumeCalls).toBe(1);
		expect(fake.pauseCalls).toBe(1);
		expectNoStdinListeners(fake);
	});

	it.each(["end", "close"] as const)("settles exactly once when stdin emits %s", async (event) => {
		const fake = useStdin(new FakeStdin());
		fake.isTTY = true;
		fake.isRaw = true;
		fake.paused = true;
		captureLogs();

		const pending = showDeprecationWarnings(warnings);
		fake.emit(event);

		await expectToSettle(pending);
		expect(fake.isRaw).toBe(true);
		expect(fake.paused).toBe(true);
		expectNoStdinListeners(fake);
	});

	it("settles on a stdin error and removes every temporary listener", async () => {
		const fake = useStdin(new FakeStdin());
		fake.isTTY = true;
		fake.isRaw = true;
		fake.paused = false;
		captureLogs();

		const pending = showDeprecationWarnings(warnings);
		try {
			fake.emit("error", new Error("stdin failed"));
		} catch {
			// Baseline has no error listener; the assertion below still fails on timeout.
		}

		await expectToSettle(pending);
		expect(fake.isRaw).toBe(true);
		expect(fake.paused).toBe(false);
		expectNoStdinListeners(fake);
	});
});
