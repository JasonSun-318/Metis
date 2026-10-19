import { getEventListeners } from "node:events";
import { afterEach, describe, expect, test, vi } from "vitest";
import { sleep } from "../src/utils/sleep.ts";

function abortListenerCount(signal: AbortSignal): number {
	return getEventListeners(signal, "abort").length;
}

describe("sleep", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	test("resolves after the timeout and removes its abort listener", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const promise = sleep(1_000, controller.signal);

		expect(abortListenerCount(controller.signal)).toBe(1);
		expect(vi.getTimerCount()).toBe(1);

		await vi.advanceTimersByTimeAsync(1_000);
		await expect(promise).resolves.toBeUndefined();

		expect(abortListenerCount(controller.signal)).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("resolves without a signal", async () => {
		vi.useFakeTimers();
		const promise = sleep(250);

		expect(vi.getTimerCount()).toBe(1);

		await vi.advanceTimersByTimeAsync(250);
		await expect(promise).resolves.toBeUndefined();

		expect(vi.getTimerCount()).toBe(0);
	});

	test("rejects immediately when already aborted without scheduling a timer or listener", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		controller.abort();

		await expect(sleep(1_000, controller.signal)).rejects.toThrow("Aborted");

		expect(abortListenerCount(controller.signal)).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("clears the timer and listener when aborted mid-wait", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const promise = sleep(1_000, controller.signal);
		const rejection = expect(promise).rejects.toThrow("Aborted");

		expect(abortListenerCount(controller.signal)).toBe(1);
		expect(vi.getTimerCount()).toBe(1);

		controller.abort();
		await rejection;

		expect(abortListenerCount(controller.signal)).toBe(0);
		expect(vi.getTimerCount()).toBe(0);

		await vi.advanceTimersByTimeAsync(1_000);
		expect(abortListenerCount(controller.signal)).toBe(0);
	});

	test("does not accumulate listeners across concurrent calls on the same signal", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const first = sleep(1_000, controller.signal);
		const second = sleep(2_000, controller.signal);

		expect(abortListenerCount(controller.signal)).toBe(2);
		expect(vi.getTimerCount()).toBe(2);

		await vi.advanceTimersByTimeAsync(1_000);
		await expect(first).resolves.toBeUndefined();
		expect(abortListenerCount(controller.signal)).toBe(1);

		await vi.advanceTimersByTimeAsync(1_000);
		await expect(second).resolves.toBeUndefined();
		expect(abortListenerCount(controller.signal)).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	test("does not accumulate listeners across repeated calls on the same signal", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();

		for (let attempt = 0; attempt < 3; attempt++) {
			const promise = sleep(10, controller.signal);
			await vi.advanceTimersByTimeAsync(10);
			await expect(promise).resolves.toBeUndefined();
		}

		expect(abortListenerCount(controller.signal)).toBe(0);
	});

	test("preserves unrelated abort listeners", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		const unrelated = vi.fn();
		controller.signal.addEventListener("abort", unrelated);

		const promise = sleep(1_000, controller.signal);
		controller.abort();
		await expect(promise).rejects.toThrow("Aborted");

		expect(unrelated).toHaveBeenCalledTimes(1);
		expect(abortListenerCount(controller.signal)).toBe(1);
	});

	test("settles once when the timeout wins before a later abort", async () => {
		vi.useFakeTimers();
		const controller = new AbortController();
		let settlements = 0;
		const promise = sleep(1_000, controller.signal).then(
			() => {
				settlements++;
			},
			() => {
				settlements++;
			},
		);

		await vi.advanceTimersByTimeAsync(1_000);
		await promise;
		controller.abort();
		await vi.runOnlyPendingTimersAsync();

		expect(settlements).toBe(1);
		expect(abortListenerCount(controller.signal)).toBe(0);
	});
});
