import { describe, expect, it, vi } from "vitest";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createHeadlessCommandContextActions } from "../src/modes/headless-command-context.ts";

type TestSession = AgentSessionRuntime["session"];
type TestRuntimeHost = Pick<AgentSessionRuntime, "newSession" | "fork" | "switchSession">;

function createRuntimeHostHarness() {
	const newSession = vi.fn(async (): Promise<Record<string, unknown>> => ({ cancelled: false }));
	const fork = vi.fn(async (): Promise<Record<string, unknown>> => ({ cancelled: false }));
	const switchSession = vi.fn(async (): Promise<Record<string, unknown>> => ({ cancelled: false }));
	const host = { newSession, fork, switchSession } as unknown as TestRuntimeHost;
	return { host, newSession, fork, switchSession };
}

function createSessionHarness() {
	const waitForIdle = vi.fn(async (): Promise<void> => {});
	const navigateTree = vi.fn(async (): Promise<Record<string, unknown>> => ({ cancelled: false }));
	const reload = vi.fn(async (): Promise<unknown> => undefined);
	const session = { waitForIdle, navigateTree, reload } as unknown as TestSession;
	return { session, waitForIdle, navigateTree, reload };
}

function createHarness() {
	const runtime = createRuntimeHostHarness();
	const currentSession = createSessionHarness();
	return { ...runtime, ...currentSession };
}

describe("createHeadlessCommandContextActions", () => {
	it("forwards arguments for all six operations and keeps the receiver binding", async () => {
		const hostCalls: Array<{ name: string; self: unknown; args: unknown[] }> = [];
		const sessionCalls: Array<{ name: string; self: unknown; args: unknown[] }> = [];

		const host = {
			newSession(...args: unknown[]) {
				hostCalls.push({ name: "newSession", self: this, args });
				return Promise.resolve({ cancelled: false, extra: "new" });
			},
			fork(...args: unknown[]) {
				hostCalls.push({ name: "fork", self: this, args });
				return Promise.resolve({ cancelled: false, selectedText: "selected" });
			},
			switchSession(...args: unknown[]) {
				hostCalls.push({ name: "switchSession", self: this, args });
				return Promise.resolve({ cancelled: false, extra: "switch" });
			},
		};
		const session = {
			waitForIdle(...args: unknown[]) {
				sessionCalls.push({ name: "waitForIdle", self: this, args });
				return Promise.resolve();
			},
			navigateTree(...args: unknown[]) {
				sessionCalls.push({ name: "navigateTree", self: this, args });
				return Promise.resolve({ cancelled: true, editorText: "editor" });
			},
			reload(...args: unknown[]) {
				sessionCalls.push({ name: "reload", self: this, args });
				return Promise.resolve("ignored");
			},
		};

		const actions = createHeadlessCommandContextActions(
			host as unknown as TestRuntimeHost,
			() => session as unknown as TestSession,
		);
		const { waitForIdle, newSession, fork, navigateTree, switchSession, reload } = actions;
		const newSessionOptions = { parentSession: "parent", withSession: async () => {} };
		const forkOptions = { position: "at" as const, withSession: async () => {} };
		const navigateOptions = {
			summarize: true,
			customInstructions: "custom",
			replaceInstructions: false,
			label: "label",
			unexpected: "dropped",
		};
		const switchOptions = { withSession: async () => {} };

		await waitForIdle();
		const newResult = await newSession(newSessionOptions);
		const forkResult = await fork("entry-1", forkOptions);
		const navigateResult = await navigateTree("target-1", navigateOptions);
		const switchResult = await switchSession("/tmp/session.jsonl", switchOptions);
		const reloadResult = await reload();

		expect(hostCalls).toEqual([
			{ name: "newSession", self: host, args: [newSessionOptions] },
			{ name: "fork", self: host, args: ["entry-1", forkOptions] },
			{ name: "switchSession", self: host, args: ["/tmp/session.jsonl", switchOptions] },
		]);
		expect(sessionCalls).toEqual([
			{ name: "waitForIdle", self: session, args: [] },
			{
				name: "navigateTree",
				self: session,
				args: [
					"target-1",
					{
						summarize: true,
						customInstructions: "custom",
						replaceInstructions: false,
						label: "label",
					},
				],
			},
			{ name: "reload", self: session, args: [] },
		]);
		expect(newResult).toEqual({ cancelled: false, extra: "new" });
		expect(forkResult).toEqual({ cancelled: false });
		expect(navigateResult).toEqual({ cancelled: true });
		expect(switchResult).toEqual({ cancelled: false, extra: "switch" });
		expect(reloadResult).toBeUndefined();
	});

	it("keeps omitted options and filters navigateTree options", async () => {
		const harness = createHarness();
		const actions = createHeadlessCommandContextActions(harness.host, () => harness.session);

		await actions.newSession();
		await actions.fork("entry-1");
		await actions.navigateTree("target-1");
		await actions.switchSession("/tmp/session.jsonl");

		expect(harness.newSession).toHaveBeenCalledWith(undefined);
		expect(harness.fork).toHaveBeenCalledWith("entry-1", undefined);
		expect(harness.navigateTree).toHaveBeenCalledWith("target-1", {
			summarize: undefined,
			customInstructions: undefined,
			replaceInstructions: undefined,
			label: undefined,
		});
		expect(harness.switchSession).toHaveBeenCalledWith("/tmp/session.jsonl", undefined);
	});

	it("uses the session returned by the getter at invocation time", async () => {
		const first = createSessionHarness();
		const second = createSessionHarness();
		let current = first.session;
		const runtime = createRuntimeHostHarness();
		const actions = createHeadlessCommandContextActions(runtime.host, () => current);

		await actions.waitForIdle();
		await actions.navigateTree("first-target");
		await actions.reload();

		current = second.session;

		await actions.waitForIdle();
		await actions.navigateTree("second-target");
		await actions.reload();

		expect(first.waitForIdle).toHaveBeenCalledTimes(1);
		expect(first.navigateTree).toHaveBeenCalledTimes(1);
		expect(first.navigateTree).toHaveBeenCalledWith("first-target", expect.any(Object));
		expect(first.reload).toHaveBeenCalledTimes(1);
		expect(second.waitForIdle).toHaveBeenCalledTimes(1);
		expect(second.navigateTree).toHaveBeenCalledTimes(1);
		expect(second.navigateTree).toHaveBeenCalledWith("second-target", expect.any(Object));
		expect(second.reload).toHaveBeenCalledTimes(1);
	});

	it("projects fork/navigateTree cancellation and preserves new/switch results", async () => {
		const harness = createHarness();
		harness.fork.mockResolvedValue({ cancelled: true, selectedText: "selected", extra: "dropped" });
		harness.navigateTree.mockResolvedValue({ cancelled: false, editorText: "editor", aborted: true });
		harness.newSession.mockResolvedValue({ cancelled: false, extra: "kept" });
		harness.switchSession.mockResolvedValue({ cancelled: true, extra: "kept" });
		const actions = createHeadlessCommandContextActions(harness.host, () => harness.session);

		await expect(actions.fork("entry-1", { position: "at" })).resolves.toEqual({ cancelled: true });
		await expect(actions.navigateTree("target-1", { summarize: true })).resolves.toEqual({ cancelled: false });
		await expect(actions.newSession({ parentSession: "parent" })).resolves.toEqual({
			cancelled: false,
			extra: "kept",
		});
		await expect(actions.switchSession("/tmp/session.jsonl")).resolves.toEqual({
			cancelled: true,
			extra: "kept",
		});
	});

	it("turns synchronous throws from async callbacks into rejections", async () => {
		const failure = new Error("synchronous failure");
		const host = {
			newSession: () => {
				throw failure;
			},
			fork: () => {
				throw failure;
			},
			switchSession: () => {
				throw failure;
			},
		} as unknown as TestRuntimeHost;
		const session = {
			waitForIdle: () => {
				throw failure;
			},
			navigateTree: () => {
				throw failure;
			},
			reload: () => {
				throw failure;
			},
		} as unknown as TestSession;
		const actions = createHeadlessCommandContextActions(host, () => session);

		const asyncCalls = [
			() => actions.newSession(),
			() => actions.fork("entry-1"),
			() => actions.navigateTree("target-1"),
			() => actions.switchSession("/tmp/session.jsonl"),
			() => actions.reload(),
		];
		for (const call of asyncCalls) {
			let promise: Promise<unknown> | undefined;
			expect(() => {
				promise = call();
			}).not.toThrow();
			expect(promise).toBeDefined();
			await expect(promise).rejects.toBe(failure);
		}

		// waitForIdle was not async in the original modes, so synchronous throws stay synchronous.
		expect(() => actions.waitForIdle()).toThrow(failure);
	});

	it("propagates asynchronous rejections unchanged", async () => {
		const failure = new Error("asynchronous failure");
		const harness = createHarness();
		harness.newSession.mockRejectedValue(failure);
		harness.fork.mockRejectedValue(failure);
		harness.switchSession.mockRejectedValue(failure);
		harness.waitForIdle.mockRejectedValue(failure);
		harness.navigateTree.mockRejectedValue(failure);
		harness.reload.mockRejectedValue(failure);
		const actions = createHeadlessCommandContextActions(harness.host, () => harness.session);

		await expect(actions.newSession()).rejects.toBe(failure);
		await expect(actions.fork("entry-1")).rejects.toBe(failure);
		await expect(actions.navigateTree("target-1")).rejects.toBe(failure);
		await expect(actions.switchSession("/tmp/session.jsonl")).rejects.toBe(failure);
		await expect(actions.reload()).rejects.toBe(failure);
		await expect(actions.waitForIdle()).rejects.toBe(failure);
	});
});
