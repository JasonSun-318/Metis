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

function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
	const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
	if (descriptor === undefined) throw new Error("process.platform is not configurable");
	Object.defineProperty(process, "platform", { ...descriptor, value: platform });
	try {
		return fn();
	} finally {
		Object.defineProperty(process, "platform", descriptor);
	}
}

function withoutAtomicsWait<T>(fn: () => T): T {
	const descriptor = Object.getOwnPropertyDescriptor(Atomics, "wait");
	if (descriptor === undefined) throw new Error("Atomics.wait is not configurable");
	Object.defineProperty(Atomics, "wait", { ...descriptor, value: undefined });
	try {
		return fn();
	} finally {
		Object.defineProperty(Atomics, "wait", descriptor);
	}
}

function withoutSharedArrayBuffer<T>(fn: () => T): T {
	const descriptor = Object.getOwnPropertyDescriptor(globalThis, "SharedArrayBuffer");
	if (descriptor === undefined) throw new Error("SharedArrayBuffer is not configurable");
	Object.defineProperty(globalThis, "SharedArrayBuffer", {
		...descriptor,
		value: function BrokenSharedArrayBuffer() {
			throw new Error("SharedArrayBuffer is unavailable");
		},
	});
	try {
		return fn();
	} finally {
		Object.defineProperty(globalThis, "SharedArrayBuffer", descriptor);
	}
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

	it.each([
		[20, 10],
		[25, 15],
	])(
		"uses a private finite wait for only part of the %ims budget without changing retry counts",
		(delayMs, expectedSleepMs) => {
			const waitSpy = vi.spyOn(Atomics, "wait");
			const release = () => {};
			const acquire = vi
				.fn<() => () => void>()
				.mockImplementationOnce(() => {
					throw elockedError();
				})
				.mockImplementationOnce(() => {
					throw elockedError();
				})
				.mockReturnValue(release);

			const { result, calls } = withPlatform("darwin", () =>
				withClock(() => acquireLockSyncWithRetry(acquire, { maxAttempts: 10, delayMs })),
			);

			expect(result).toBe(release);
			expect(acquire).toHaveBeenCalledTimes(3);
			expect(waitSpy).toHaveBeenCalledTimes(2);
			expect(waitSpy).toHaveBeenNthCalledWith(1, expect.any(Int32Array), 0, 0, expectedSleepMs);
			expect(getWaitDurations(calls, delayMs)).toEqual([delayMs, delayMs]);
			expect(calls).toHaveLength(2 * (delayMs + 1));
		},
	);

	it("keeps the busy wait when the delay does not exceed the wake margin", () => {
		const waitSpy = vi.spyOn(Atomics, "wait");
		const release = () => {};
		const acquire = vi
			.fn<() => () => void>()
			.mockImplementationOnce(() => {
				throw elockedError();
			})
			.mockReturnValue(release);

		const { result, calls } = withPlatform("darwin", () =>
			withClock(() => acquireLockSyncWithRetry(acquire, { maxAttempts: 10, delayMs: 10 })),
		);

		expect(result).toBe(release);
		expect(acquire).toHaveBeenCalledTimes(2);
		expect(waitSpy).not.toHaveBeenCalled();
		expect(getWaitDurations(calls, 10)).toEqual([10]);
		expect(calls).toHaveLength(11);
	});

	it("falls back when the finite wait primitive throws and still rethrows the final lock error", () => {
		const waitError = new Error("Atomics.wait is unavailable");
		const waitSpy = vi.spyOn(Atomics, "wait").mockImplementation(() => {
			throw waitError;
		});
		const errors = Array.from({ length: 10 }, () => elockedError());
		let attempt = 0;
		const acquire = vi.fn<() => () => void>(() => {
			throw errors[attempt++];
		});

		const { result: thrown, calls } = withPlatform("darwin", () =>
			withClock(() => captureThrown(() => acquireLockSyncWithRetry(acquire, { maxAttempts: 10, delayMs: 20 }))),
		);

		expect(thrown).toBe(errors[9]);
		expect(thrown).not.toBe(waitError);
		expect(acquire).toHaveBeenCalledTimes(10);
		expect(waitSpy).toHaveBeenCalledTimes(9);
		expect(getWaitDurations(calls, 20)).toEqual(Array.from({ length: 9 }, () => 20));
		expect(calls).toHaveLength(9 * 21);
	});

	it("falls back when the finite wait primitive is absent", () => {
		const release = () => {};
		const acquire = vi
			.fn<() => () => void>()
			.mockImplementationOnce(() => {
				throw elockedError();
			})
			.mockReturnValue(release);

		const { result, calls } = withoutAtomicsWait(() =>
			withPlatform("darwin", () =>
				withClock(() => acquireLockSyncWithRetry(acquire, { maxAttempts: 10, delayMs: 20 })),
			),
		);

		expect(result).toBe(release);
		expect(acquire).toHaveBeenCalledTimes(2);
		expect(getWaitDurations(calls, 20)).toEqual([20]);
		expect(calls).toHaveLength(21);
	});

	it("falls back when the shared wait cell cannot be allocated", () => {
		const release = () => {};
		const acquire = vi
			.fn<() => () => void>()
			.mockImplementationOnce(() => {
				throw elockedError();
			})
			.mockReturnValue(release);

		const { result, calls } = withoutSharedArrayBuffer(() =>
			withPlatform("darwin", () =>
				withClock(() => acquireLockSyncWithRetry(acquire, { maxAttempts: 10, delayMs: 20 })),
			),
		);

		expect(result).toBe(release);
		expect(acquire).toHaveBeenCalledTimes(2);
		expect(getWaitDurations(calls, 20)).toEqual([20]);
		expect(calls).toHaveLength(21);
	});

	it.each(["linux", "win32"] as const)("keeps the original busy wait on %s", (platform) => {
		const waitSpy = vi.spyOn(Atomics, "wait").mockImplementation(() => {
			throw new Error("finite wait must not run outside darwin");
		});
		const release = () => {};
		const acquire = vi
			.fn<() => () => void>()
			.mockImplementationOnce(() => {
				throw elockedError();
			})
			.mockReturnValue(release);

		const { result, calls } = withPlatform(platform, () =>
			withClock(() => acquireLockSyncWithRetry(acquire, { maxAttempts: 10, delayMs: 20 })),
		);

		expect(result).toBe(release);
		expect(acquire).toHaveBeenCalledTimes(2);
		expect(waitSpy).not.toHaveBeenCalled();
		expect(getWaitDurations(calls, 20)).toEqual([20]);
		expect(calls).toHaveLength(21);
	});
});
