import type { BrowserObservation, BrowserOperationDetails } from "@metis/app-protocol";
import { describe, expect, it, vi } from "vitest";
import { BrowserTabRuntime } from "../src/main/browser-tab-runtime.ts";

const BROWSER_ID = "10000000-0000-4000-8000-000000000001";
const PROFILE_ID = "00000000-0000-4000-8000-000000000001";

const observation: BrowserObservation = {
	browserId: BROWSER_ID,
	profileId: PROFILE_ID,
	documentId: "30000000-0000-4000-8000-000000000001",
	revision: 1,
	change: "full",
	url: "https://example.test/",
	title: "Fixture",
	loading: false,
	state: "e1 button Continue",
};

function runtimeHarness(options: { readonly handoffTimeoutMs?: number; readonly activityIdleDelayMs?: number } = {}) {
	let leaseAbort = new AbortController();
	const controller = {
		leaseSignal: vi.fn(() => leaseAbort.signal),
		invalidate: vi.fn(),
		observe: vi.fn(async () => observation),
		close: vi.fn(() => {
			leaseAbort.abort(new Error("Browser closed"));
			leaseAbort = new AbortController();
		}),
	};
	const surfaces: boolean[] = [];
	const activity: boolean[] = [];
	const handoffs: Array<{ readonly status: "requested" | "completed" | "cancelled"; readonly reason?: string }> = [];
	const cleanup = vi.fn();
	const clearPendingActivity = vi.fn();
	const runtime = new BrowserTabRuntime({
		browserId: BROWSER_ID,
		controller,
		handoffTimeoutMs: options.handoffTimeoutMs ?? 1_000,
		activityIdleDelayMs: options.activityIdleDelayMs ?? 5,
		placeSurface: (foreground) => surfaces.push(foreground),
		emitActivity: (active) => activity.push(active),
		clearPendingActivity,
		emitHandoff: (event) => handoffs.push(event),
		cleanup,
	});
	return {
		activity,
		clearPendingActivity,
		cleanup,
		controller,
		detach: () => {
			leaseAbort.abort(new Error("Browser debugger detached"));
			leaseAbort = new AbortController();
		},
		handoffs,
		runtime,
		surfaces,
	};
}

function completed(): BrowserOperationDetails {
	return { status: "completed", observation };
}

describe("BrowserTabRuntime", () => {
	it("owns direct handoff state, presentation, and completion", async () => {
		const harness = runtimeHarness();
		harness.runtime.syncPresentation(true);

		const pending = harness.runtime.handoff("login", new AbortController().signal);
		await vi.waitFor(() =>
			expect(harness.runtime.view()).toEqual({ controlState: "handoff", handoffReason: "login" }),
		);
		expect(harness.handoffs).toEqual([{ status: "requested", reason: "login" }]);
		await expect(harness.runtime.runMutation(new AbortController().signal, async () => completed())).rejects.toThrow(
			"handoff",
		);

		harness.runtime.resolveHandoff("complete");
		await expect(pending).resolves.toEqual({ status: "completed", observation });
		expect(harness.runtime.view()).toEqual({ controlState: "idle" });
		expect(harness.controller.invalidate).toHaveBeenCalledTimes(2);
		expect(harness.surfaces.at(-1)).toBe(true);
		expect(harness.handoffs.at(-1)).toEqual({ status: "completed" });
	});

	it("turns takeover into the same pending mutation result without an idle activity pulse", async () => {
		const harness = runtimeHarness();
		harness.runtime.syncPresentation(true);
		const pending = harness.runtime.runMutation(
			new AbortController().signal,
			(_signal) =>
				new Promise<BrowserOperationDetails>((_resolve, reject) => {
					_signal.addEventListener(
						"abort",
						() => reject(_signal.reason ?? new DOMException("Aborted", "AbortError")),
						{ once: true },
					);
				}),
		);
		await vi.waitFor(() => expect(harness.activity).toEqual([true]));
		expect(harness.surfaces.at(-1)).toBe(false);

		harness.runtime.takeControl();
		await vi.waitFor(() => expect(harness.handoffs).toContainEqual({ status: "requested", reason: "other" }));
		await new Promise((resolve) => setTimeout(resolve, 15));
		expect(harness.activity).toEqual([true]);
		expect(harness.clearPendingActivity).toHaveBeenCalledOnce();
		expect(harness.surfaces.at(-1)).toBe(true);

		harness.runtime.resolveHandoff("cancel");
		await expect(pending).resolves.toEqual({ status: "cancelled", reason: "user_cancelled" });
		expect(harness.runtime.view()).toEqual({ controlState: "idle" });
		expect(harness.activity).toEqual([true]);
	});

	it("settles interruption, timeout, and close with bounded reasons", async () => {
		const interrupted = runtimeHarness();
		const abort = new AbortController();
		const interruptedResult = interrupted.runtime.handoff("otp", abort.signal);
		await vi.waitFor(() => expect(interrupted.runtime.view().controlState).toBe("handoff"));
		abort.abort();
		await expect(interruptedResult).resolves.toEqual({ status: "cancelled", reason: "turn_interrupted" });

		const timedOut = runtimeHarness({ handoffTimeoutMs: 5 });
		await expect(timedOut.runtime.handoff("captcha", new AbortController().signal)).resolves.toEqual({
			status: "cancelled",
			reason: "timed_out",
		});

		const closed = runtimeHarness();
		const closedResult = closed.runtime.handoff("passkey", new AbortController().signal);
		await vi.waitFor(() => expect(closed.runtime.view().controlState).toBe("handoff"));
		closed.runtime.close("tab_closed");
		closed.runtime.close("tab_closed");
		await expect(closedResult).resolves.toEqual({ status: "cancelled", reason: "tab_closed" });
		expect(closed.controller.close).toHaveBeenCalledOnce();
		expect(closed.cleanup).toHaveBeenCalledOnce();
		expect(closed.handoffs).toEqual([{ status: "requested", reason: "passkey" }]);
	});

	it("serializes mutations and restores ordinary activity after the queue drains", async () => {
		const harness = runtimeHarness();
		harness.runtime.syncPresentation(true);
		let releaseFirst!: () => void;
		const order: string[] = [];
		const first = harness.runtime.runMutation(new AbortController().signal, async () => {
			order.push("first:start");
			await new Promise<void>((resolve) => {
				releaseFirst = resolve;
			});
			order.push("first:end");
			return completed();
		});
		const second = harness.runtime.runMutation(new AbortController().signal, async () => {
			order.push("second");
			return completed();
		});
		await vi.waitFor(() => expect(order).toEqual(["first:start"]));
		releaseFirst();
		await expect(Promise.all([first, second])).resolves.toHaveLength(2);
		expect(order).toEqual(["first:start", "first:end", "second"]);
		await vi.waitFor(() => expect(harness.activity).toEqual([true, false]));
		expect(harness.surfaces.at(-1)).toBe(true);
	});

	it("releases the control lease when its controller detaches", async () => {
		const harness = runtimeHarness();
		const pending = harness.runtime.runMutation(
			new AbortController().signal,
			(signal) =>
				new Promise<BrowserOperationDetails>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		);
		await vi.waitFor(() => expect(harness.runtime.view().controlState).toBe("agent"));
		harness.detach();
		await expect(pending).rejects.toThrow("Browser debugger detached");
		await expect(harness.runtime.runMutation(new AbortController().signal, async () => completed())).resolves.toEqual(
			completed(),
		);
	});

	it("aborts active and queued work when closed", async () => {
		const harness = runtimeHarness();
		const active = harness.runtime.runMutation(
			new AbortController().signal,
			(signal) =>
				new Promise<BrowserOperationDetails>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		);
		const queued = harness.runtime.runMutation(new AbortController().signal, async () => completed());
		await vi.waitFor(() => expect(harness.runtime.view().controlState).toBe("agent"));
		harness.runtime.close("server_restarted");
		await expect(active).rejects.toBeDefined();
		await expect(queued).rejects.toThrow("Browser is not running");
	});
});
