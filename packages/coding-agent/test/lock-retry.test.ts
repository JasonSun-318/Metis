import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireLockSyncWithRetry } from "../src/utils/lock-retry.ts";

function elockedError(): Error & { code: string } {
	return Object.assign(new Error("lock is held"), { code: "ELOCKED" });
}

function withClock<T>(fn: () => T): { result: T; calls: number[] } {
	let current = 0;
	const calls: number[] = [];
	const spy = vi.spyOn(Date, "now").mockImplementation(() => {
		current += 1;
		calls.push(current);
		return current;
	});
	try {
		return { result: fn(), calls };
	} finally {
		spy.mockRestore();
	}
}

function captureThrown(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error("Expected the callback to throw");
}

function getWaitDurations(calls: number[], delayMs: number): number[] {
	const callsPerWait = delayMs + 1;
	const durations: number[] = [];
	for (let index = 0; index < calls.length; index += callsPerWait) {
		const waitCalls = calls.slice(index, index + callsPerWait);
		durations.push(waitCalls[waitCalls.length - 1] - waitCalls[0]);
	}
	return durations;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("acquireLockSyncWithRetry", () => {
	it("returns the first release callback without waiting", () => {
		const release = () => {};
		const acquire = vi.fn(() => release);

		const { result, calls } = withClock(() => acquireLockSyncWithRetry(acquire, { maxAttempts: 10, delayMs: 20 }));

		expect(result).toBe(release);
		expect(acquire).toHaveBeenCalledTimes(1);
		expect(calls).toEqual([]);
	});

	it("retries ELOCKED at the configured interval and returns the successful release callback", () => {
		const release = () => {};
		const first = elockedError();
		const second = elockedError();
		const acquire = vi
			.fn<() => () => void>()
			.mockImplementationOnce(() => {
				throw first;
			})
			.mockImplementationOnce(() => {
				throw second;
			})
			.mockReturnValue(release);

		const { result, calls } = withClock(() => acquireLockSyncWithRetry(acquire, { maxAttempts: 10, delayMs: 20 }));

		expect(result).toBe(release);
		expect(acquire).toHaveBeenCalledTimes(3);
		expect(getWaitDurations(calls, 20)).toEqual([20, 20]);
		expect(calls).toHaveLength(2 * 21);
	});

	it.each([
		[10, 20],
		[20, 25],
	])("throws the final ELOCKED error after %i attempts with %ims waits and no final wait", (maxAttempts, delayMs) => {
		const errors = Array.from({ length: maxAttempts }, () => elockedError());
		let attempt = 0;
		const acquire = vi.fn<() => () => void>(() => {
			throw errors[attempt++];
		});

		const { result: thrown, calls } = withClock(() =>
			captureThrown(() => acquireLockSyncWithRetry(acquire, { maxAttempts, delayMs })),
		);

		expect(thrown).toBe(errors[maxAttempts - 1]);
		expect(acquire).toHaveBeenCalledTimes(maxAttempts);
		expect(getWaitDurations(calls, delayMs)).toEqual(Array.from({ length: maxAttempts - 1 }, () => delayMs));
		expect(calls).toHaveLength((maxAttempts - 1) * (delayMs + 1));
	});

	it("throws a non-ELOCKED Error immediately without waiting", () => {
		const failure = Object.assign(new Error("permission denied"), { code: "EACCES" });
		const acquire = vi.fn<() => () => void>(() => {
			throw failure;
		});

		const { result: thrown, calls } = withClock(() =>
			captureThrown(() => acquireLockSyncWithRetry(acquire, { maxAttempts: 10, delayMs: 20 })),
		);

		expect(thrown).toBe(failure);
		expect(acquire).toHaveBeenCalledTimes(1);
		expect(calls).toEqual([]);
	});

	it("throws a non-ELOCKED primitive immediately without waiting", () => {
		const failure = "disk full";
		const acquire = vi.fn<() => () => void>(() => {
			throw failure;
		});

		const { result: thrown, calls } = withClock(() =>
			captureThrown(() => acquireLockSyncWithRetry(acquire, { maxAttempts: 10, delayMs: 20 })),
		);

		expect(thrown).toBe(failure);
		expect(acquire).toHaveBeenCalledTimes(1);
		expect(calls).toEqual([]);
	});

	it("retries when a non-Error code coerces to ELOCKED", () => {
		const release = () => {};
		const failure = { code: { toString: () => "ELOCKED" } };
		const acquire = vi
			.fn<() => () => void>()
			.mockImplementationOnce(() => {
				throw failure;
			})
			.mockReturnValue(release);

		const { result, calls } = withClock(() => acquireLockSyncWithRetry(acquire, { maxAttempts: 10, delayMs: 20 }));

		expect(result).toBe(release);
		expect(acquire).toHaveBeenCalledTimes(2);
		expect(getWaitDurations(calls, 20)).toEqual([20]);
	});
});
