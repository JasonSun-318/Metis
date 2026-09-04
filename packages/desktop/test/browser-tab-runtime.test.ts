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
		observe: vi.fn(async (_input: { readonly browserId: string }, _signal: AbortSignal) => observation),
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
	const placeSurface = vi.fn((foreground: boolean) => surfaces.push(foreground));
	const emitHandoff = vi.fn(
		(event: { readonly status: "requested" | "completed" | "cancelled"; readonly reason?: string }) =>
			handoffs.push(event),
	);
	const runtime = new BrowserTabRuntime({
		browserId: BROWSER_ID,
		controller,
		handoffTimeoutMs: options.handoffTimeoutMs ?? 1_000,
		activityIdleDelayMs: options.activityIdleDelayMs ?? 5,
		placeSurface,
		emitActivity: (active) => activity.push(active),
		clearPendingActivity,
		emitHandoff,
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
		emitHandoff,
		handoffs,
		placeSurface,
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
		let releaseObservation!: () => void;
		harness.controller.observe.mockImplementationOnce(
			() =>
				new Promise<BrowserObservation>((resolve) => {
					releaseObservation = () => resolve(observation);
				}),
		);

		const pending = harness.runtime.handoff("login", new AbortController().signal);
		await vi.waitFor(() =>
			expect(harness.runtime.view()).toEqual({ controlState: "handoff", handoffReason: "login" }),
		);
		expect(harness.handoffs).toEqual([{ status: "requested", reason: "login" }]);
		await expect(harness.runtime.runMutation(new AbortController().signal, async () => completed())).rejects.toThrow(
			"handoff",
		);

		harness.runtime.resolveHandoff("complete");
		await vi.waitFor(() => expect(harness.runtime.view()).toEqual({ controlState: "agent" }));
		expect(harness.surfaces.at(-1)).toBe(true);
		await expect(harness.runtime.runUserMutation(async () => undefined)).rejects.toThrow("controlled by the agent");
		releaseObservation();
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
		expect(harness.surfaces.at(-1)).toBe(true);

		harness.runtime.takeControl();
		await vi.waitFor(() => expect(harness.handoffs).toContainEqual({ status: "requested", reason: "other" }));
		expect(harness.runtime.view()).toEqual({ controlState: "handoff", handoffReason: "other" });
		await new Promise((resolve) => setTimeout(resolve, 15));
		expect(harness.activity).toEqual([true]);
		expect(harness.clearPendingActivity).toHaveBeenCalledOnce();
		expect(harness.surfaces.at(-1)).toBe(true);

		harness.runtime.resolveHandoff("cancel");
		await expect(pending).resolves.toEqual({ status: "cancelled", reason: "user_cancelled" });
		expect(harness.runtime.view()).toEqual({ controlState: "idle" });
		expect(harness.activity).toEqual([true]);
	});

	it("cancels a pending idle activity event when direct handoff starts", async () => {
		const harness = runtimeHarness({ activityIdleDelayMs: 5 });
		await harness.runtime.runMutation(new AbortController().signal, async () => completed());
		expect(harness.activity).toEqual([true]);

		const pending = harness.runtime.handoff("login", new AbortController().signal);
		await vi.waitFor(() => expect(harness.runtime.view().controlState).toBe("handoff"));
		await new Promise((resolve) => setTimeout(resolve, 15));
		expect(harness.activity).toEqual([true]);
		expect(harness.clearPendingActivity).toHaveBeenCalledOnce();

		harness.runtime.resolveHandoff("cancel");
		await expect(pending).resolves.toEqual({ status: "cancelled", reason: "user_cancelled" });
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

	it("aborts the final handoff observation when the controller lease detaches", async () => {
		const harness = runtimeHarness();
		harness.runtime.syncPresentation(true);
		harness.controller.observe.mockImplementationOnce(
			(_input, signal) =>
				new Promise<BrowserObservation>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		);

		const pending = harness.runtime.handoff("login", new AbortController().signal);
		await vi.waitFor(() => expect(harness.runtime.view().controlState).toBe("handoff"));
		harness.runtime.resolveHandoff("complete");
		await vi.waitFor(() => expect(harness.runtime.view().controlState).toBe("agent"));
		harness.detach();

		await expect(pending).rejects.toThrow("Browser debugger detached");
		expect(harness.runtime.view()).toEqual({ controlState: "idle" });
		expect(harness.surfaces.at(-1)).toBe(true);
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

	it("keeps user mutations and agent work under one exclusive ownership queue", async () => {
		const harness = runtimeHarness();
		let releaseUser!: () => void;
		const user = harness.runtime.runUserMutation(
			() =>
				new Promise<void>((resolve) => {
					releaseUser = resolve;
				}),
		);

		await expect(harness.runtime.runMutation(new AbortController().signal, async () => completed())).rejects.toThrow(
			"controlled by the user",
		);
		await expect(
			harness.runtime.runObservation(new AbortController().signal, async () => observation),
		).rejects.toThrow("controlled by the user");
		releaseUser();
		await user;

		await expect(harness.runtime.runMutation(new AbortController().signal, async () => completed())).resolves.toEqual(
			completed(),
		);
	});

	it("holds an agent observation lease until the snapshot is complete", async () => {
		const harness = runtimeHarness();
		harness.runtime.syncPresentation(true);
		let releaseObservation!: () => void;
		const observing = harness.runtime.runObservation(
			new AbortController().signal,
			() =>
				new Promise<BrowserObservation>((resolve) => {
					releaseObservation = () => resolve(observation);
				}),
		);
		await vi.waitFor(() => expect(releaseObservation).toBeTypeOf("function"));

		expect(harness.runtime.view()).toEqual({ controlState: "agent" });
		expect(harness.surfaces.at(-1)).toBe(true);
		await expect(harness.runtime.runUserMutation(async () => undefined)).rejects.toThrow("controlled by the agent");
		releaseObservation();
		await expect(observing).resolves.toEqual(observation);
		expect(harness.runtime.view()).toEqual({ controlState: "idle" });
		expect(harness.surfaces.at(-1)).toBe(true);
	});

	it("keeps a presented native surface in the foreground while the agent acts", async () => {
		const harness = runtimeHarness();
		harness.runtime.syncPresentation(true);
		let release!: () => void;
		const pending = harness.runtime.runMutation(
			new AbortController().signal,
			() =>
				new Promise<BrowserOperationDetails>((resolve) => {
					release = () => resolve(completed());
				}),
		);
		await vi.waitFor(() => expect(harness.runtime.view().controlState).toBe("agent"));
		expect(harness.surfaces.at(-1)).toBe(true);
		expect(harness.activity).toEqual([true]);
		release();
		await expect(pending).resolves.toEqual(completed());
		expect(harness.runtime.view()).toEqual({ controlState: "idle" });
		expect(harness.surfaces.at(-1)).toBe(true);
	});

	it("still hides an unpresented tab while the agent acts so it does not cover chat UI", async () => {
		const harness = runtimeHarness();
		harness.runtime.syncPresentation(false);
		let release!: () => void;
		const pending = harness.runtime.runMutation(
			new AbortController().signal,
			() =>
				new Promise<BrowserOperationDetails>((resolve) => {
					release = () => resolve(completed());
				}),
		);
		await vi.waitFor(() => expect(harness.runtime.view().controlState).toBe("agent"));
		expect(harness.surfaces.at(-1)).toBe(false);
		release();
		await expect(pending).resolves.toEqual(completed());
	});

	it("turns observation takeover into handoff and resumes with its final snapshot", async () => {
		const harness = runtimeHarness();
		harness.runtime.syncPresentation(true);
		const observing = harness.runtime.runObservation(
			new AbortController().signal,
			(signal) =>
				new Promise<BrowserObservation>((_resolve, reject) => {
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		);
		await vi.waitFor(() => expect(harness.runtime.view().controlState).toBe("agent"));

		harness.runtime.takeControl();
		await vi.waitFor(() =>
			expect(harness.runtime.view()).toEqual({ controlState: "handoff", handoffReason: "other" }),
		);
		expect(harness.surfaces.at(-1)).toBe(true);
		harness.runtime.resolveHandoff("complete");

		await expect(observing).resolves.toEqual(observation);
		expect(harness.handoffs).toEqual([{ status: "requested", reason: "other" }, { status: "completed" }]);
		expect(harness.runtime.view()).toEqual({ controlState: "idle" });
	});

	it("keeps renewed observation ownership after cancelling takeover", async () => {
		const harness = runtimeHarness();
		harness.runtime.syncPresentation(true);
		let observationCalls = 0;
		const observing = harness.runtime.runObservation(
			new AbortController().signal,
			(signal) =>
				new Promise<BrowserObservation>((_resolve, reject) => {
					observationCalls++;
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
				}),
		);
		await vi.waitFor(() => expect(harness.runtime.view().controlState).toBe("agent"));

		harness.runtime.takeControl();
		await vi.waitFor(() => expect(harness.runtime.view().controlState).toBe("handoff"));
		harness.runtime.resolveHandoff("cancel");
		await vi.waitFor(() => expect(observationCalls).toBe(2));
		expect(harness.runtime.view()).toEqual({ controlState: "agent" });
		expect(harness.surfaces.at(-1)).toBe(true);
		await expect(harness.runtime.runUserMutation(async () => undefined)).rejects.toThrow("controlled by the agent");

		harness.runtime.takeControl();
		await vi.waitFor(() =>
			expect(harness.runtime.view()).toEqual({ controlState: "handoff", handoffReason: "other" }),
		);
		harness.runtime.resolveHandoff("complete");
		await expect(observing).resolves.toEqual(observation);
		expect(harness.runtime.view()).toEqual({ controlState: "idle" });
	});

	it("honors observation takeover when an uncancellable capture finishes late", async () => {
		const harness = runtimeHarness();
		let finishCapture!: () => void;
		const observing = harness.runtime.runObservation(
			new AbortController().signal,
			() =>
				new Promise<BrowserObservation>((resolve) => {
					finishCapture = () => resolve(observation);
				}),
		);
		await vi.waitFor(() => expect(harness.runtime.view().controlState).toBe("agent"));

		harness.runtime.takeControl();
		finishCapture();
		await vi.waitFor(() => expect(harness.runtime.view().controlState).toBe("handoff"));
		harness.runtime.resolveHandoff("complete");

		await expect(observing).resolves.toEqual(observation);
		expect(harness.handoffs).toEqual([{ status: "requested", reason: "other" }, { status: "completed" }]);
	});

	it("does not re-enter handoff when takeover races with tab close", async () => {
		const harness = runtimeHarness();
		let rejectObservation!: (cause: unknown) => void;
		const observing = harness.runtime.runObservation(
			new AbortController().signal,
			() =>
				new Promise<BrowserObservation>((_resolve, reject) => {
					rejectObservation = reject;
				}),
		);
		await vi.waitFor(() => expect(harness.runtime.view().controlState).toBe("agent"));

		harness.runtime.takeControl();
		const surfaceCount = harness.surfaces.length;
		harness.runtime.close("tab_closed");
		rejectObservation(new Error("capture stopped"));

		await expect(observing).rejects.toThrow("Browser tab closed");
		expect(harness.handoffs).toEqual([]);
		expect(harness.surfaces).toHaveLength(surfaceCount);
		expect(harness.cleanup).toHaveBeenCalledOnce();
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

	it("restores ownership when presentation and handoff callbacks fail", async () => {
		for (const run of [
			(harness: ReturnType<typeof runtimeHarness>) =>
				harness.runtime.runObservation(new AbortController().signal, async () => observation),
			(harness: ReturnType<typeof runtimeHarness>) =>
				harness.runtime.runMutation(new AbortController().signal, async () => completed()),
		]) {
			const harness = runtimeHarness();
			harness.runtime.syncPresentation(true);
			harness.placeSurface.mockImplementationOnce(() => {
				throw new Error("surface unavailable");
			});

			await expect(run(harness)).rejects.toThrow("surface unavailable");
			expect(harness.runtime.view()).toEqual({ controlState: "idle" });
			await expect(harness.runtime.runUserMutation(async () => "available")).resolves.toBe("available");
		}

		const handoff = runtimeHarness();
		handoff.emitHandoff.mockImplementationOnce(() => {
			throw new Error("handoff listener failed");
		});
		await expect(handoff.runtime.handoff("login", new AbortController().signal)).rejects.toThrow(
			"handoff listener failed",
		);
		expect(handoff.runtime.view()).toEqual({ controlState: "idle" });
		expect(() => handoff.runtime.resolveHandoff("complete")).toThrow("not active");
		await expect(handoff.runtime.runUserMutation(async () => "available")).resolves.toBe("available");
	});

	it("runs tab cleanup even when the controller fails to close", () => {
		const harness = runtimeHarness();
		harness.controller.close.mockImplementationOnce(() => {
			throw new Error("controller close failed");
		});

		expect(() => harness.runtime.close("tab_closed")).toThrow("controller close failed");
		expect(harness.cleanup).toHaveBeenCalledOnce();
		harness.runtime.close("tab_closed");
		expect(harness.controller.close).toHaveBeenCalledOnce();
		expect(harness.cleanup).toHaveBeenCalledOnce();
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
