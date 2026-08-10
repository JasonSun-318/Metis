import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppServerSupervisor, ServerRestartedError, type UtilityChild } from "../src/main/app-server-supervisor.ts";

const EPOCHS = [
	"11111111-1111-4111-8111-111111111111",
	"22222222-2222-4222-8222-222222222222",
	"33333333-3333-4333-8333-333333333333",
	"44444444-4444-4444-8444-444444444444",
];

class FakeChild implements UtilityChild {
	pid: number | undefined = 42;
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly sent: unknown[] = [];
	killCount = 0;
	private readonly listeners = new Map<string, Set<(...args: never[]) => void>>();

	on(event: string, listener: (...args: never[]) => void): this {
		const listeners = this.listeners.get(event) ?? new Set();
		listeners.add(listener);
		this.listeners.set(event, listeners);
		return this;
	}

	off(event: string, listener: (...args: never[]) => void): this {
		this.listeners.get(event)?.delete(listener);
		return this;
	}

	postMessage(message: unknown): void {
		this.sent.push(message);
	}

	kill(): boolean {
		this.killCount += 1;
		return true;
	}

	emit(event: "spawn"): void;
	emit(event: "message", message: unknown): void;
	emit(event: "exit", code: number): void;
	emit(event: string, ...args: unknown[]): void {
		if (event === "exit") this.pid = undefined;
		for (const listener of this.listeners.get(event) ?? []) listener(...(args as never[]));
	}

	replyReady(epoch: string): void {
		const request = this.sent.at(-1) as { id: string };
		this.emit("message", {
			jsonrpc: "2.0",
			id: request.id,
			result: {
				protocolVersion: 11,
				server: { name: "metis-app-server", version: "0.80.6" },
				serverEpoch: epoch,
				capabilities: [],
			},
		});
	}
}

function harness(options: ConstructorParameters<typeof AppServerSupervisor>[0] = {}) {
	const children: FakeChild[] = [];
	const supervisor = new AppServerSupervisor({
		spawn: () => {
			const child = new FakeChild();
			children.push(child);
			return child;
		},
		...options,
	});
	return { children, supervisor };
}

async function reachReady(supervisor: AppServerSupervisor, children: FakeChild[], epoch = EPOCHS[0]) {
	const started = supervisor.start();
	const child = children.at(-1)!;
	child.emit("spawn");
	expect(child.sent).toHaveLength(1);
	expect(child.sent[0]).toMatchObject({ jsonrpc: "2.0", method: "initialize" });
	child.replyReady(epoch);
	await expect(started).resolves.toMatchObject({ state: "ready", serverEpoch: epoch });
	return child;
}

describe("AppServerSupervisor", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => vi.useRealTimers());

	it("waits for the validated initialize handshake before becoming ready", async () => {
		const { children, supervisor } = harness();
		const started = supervisor.start();
		expect(supervisor.view()).toMatchObject({ state: "starting", serverEpoch: null });

		children[0].emit("spawn");
		expect(supervisor.view().state).toBe("starting");
		children[0].replyReady(EPOCHS[0]);

		await expect(started).resolves.toMatchObject({ state: "ready", serverEpoch: EPOCHS[0] });
	});

	it("times out a stalled handshake and schedules a restart", async () => {
		const { children, supervisor } = harness({ handshakeTimeoutMs: 10_000 });
		void supervisor.start();
		children[0].emit("spawn");

		await vi.advanceTimersByTimeAsync(10_000);
		expect(children[0].killCount).toBe(1);
		expect(supervisor.view()).toMatchObject({ state: "restarting", restartAttempt: 1 });
		await vi.advanceTimersByTimeAsync(249);
		expect(children).toHaveLength(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(children).toHaveLength(2);
	});

	it("restarts after an unexpected exit with 250 ms, 1 s, then 4 s backoff", async () => {
		const { children, supervisor } = harness({ maxUnexpectedExits: 4 });
		let child = await reachReady(supervisor, children, EPOCHS[0]);

		for (const [index, delay] of [250, 1_000, 4_000].entries()) {
			child.emit("exit", 1);
			expect(supervisor.view()).toMatchObject({ state: "restarting", restartAttempt: index + 1 });
			await vi.advanceTimersByTimeAsync(delay - 1);
			expect(children).toHaveLength(index + 1);
			await vi.advanceTimersByTimeAsync(1);
			child = children.at(-1)!;
			child.emit("spawn");
			child.replyReady(EPOCHS[index + 1]);
			await vi.runAllTicks();
			expect(supervisor.view()).toMatchObject({ state: "ready", serverEpoch: EPOCHS[index + 1] });
		}
	});

	it("enters failed after three unexpected exits in the crash window", async () => {
		const { children, supervisor } = harness();
		let child = await reachReady(supervisor, children);

		for (let index = 0; index < 2; index += 1) {
			child.emit("exit", 1);
			await vi.advanceTimersByTimeAsync(index === 0 ? 250 : 1_000);
			child = children.at(-1)!;
			child.emit("spawn");
			child.replyReady(EPOCHS[index + 1]);
			await vi.runAllTicks();
		}

		child.emit("exit", 1);
		expect(supervisor.view()).toMatchObject({ state: "failed", serverEpoch: null, restartAttempt: 3 });
		await vi.advanceTimersByTimeAsync(60_000);
		expect(children).toHaveLength(3);
	});

	it("manual retry is the only way out of failed", async () => {
		const { children, supervisor } = harness({ maxUnexpectedExits: 1 });
		const first = await reachReady(supervisor, children);
		first.emit("exit", 1);
		expect(supervisor.view().state).toBe("failed");

		const retried = supervisor.retry();
		expect(children).toHaveLength(2);
		children[1].emit("spawn");
		children[1].replyReady(EPOCHS[1]);
		await expect(retried).resolves.toMatchObject({ state: "ready", serverEpoch: EPOCHS[1] });
	});

	it("rejects pending client requests with SERVER_RESTARTED when the epoch is lost", async () => {
		const { children, supervisor } = harness();
		const child = await reachReady(supervisor, children);
		const pending = supervisor.request({
			jsonrpc: "2.0",
			id: "list-1",
			method: "session/list",
			params: {},
		});

		child.emit("exit", 1);
		await expect(pending).rejects.toBeInstanceOf(ServerRestartedError);
		await expect(pending).rejects.toMatchObject({ code: "SERVER_RESTARTED", previousEpoch: EPOCHS[0] });
	});

	it("does not spawn a second child when the renderer reloads or the window is recreated", async () => {
		const { children, supervisor } = harness();
		await reachReady(supervisor, children);

		await expect(supervisor.start()).resolves.toMatchObject({ state: "ready" });
		await expect(supervisor.start()).resolves.toMatchObject({ state: "ready" });
		expect(children).toHaveLength(1);
	});

	it("reinitializes an overloaded connection without restarting the utility process", async () => {
		const { children, supervisor } = harness();
		const child = await reachReady(supervisor, children);
		const pending = supervisor.request({
			jsonrpc: "2.0",
			id: "pending-before-overload",
			method: "session/list",
			params: {},
		});

		child.emit("message", {
			jsonrpc: "2.0",
			id: null,
			error: {
				code: -32007,
				message: "Connection is overloaded",
				data: { name: "OVERLOADED", retryable: true },
			},
		});

		await expect(pending).rejects.toMatchObject({ code: "SERVER_RESTARTED", previousEpoch: EPOCHS[0] });
		expect(supervisor.view()).toMatchObject({ state: "restarting", serverEpoch: null });
		expect(children).toHaveLength(1);
		expect(child.killCount).toBe(0);
		expect(child.sent.at(-1)).toMatchObject({ method: "initialize" });
		child.emit("message", {
			jsonrpc: "2.0",
			id: "pending-before-overload",
			error: {
				code: -32004,
				message: "Resource is busy",
				data: { name: "BUSY", retryable: true },
			},
		});
		expect(child.killCount).toBe(0);
		child.replyReady(EPOCHS[0]);
		expect(supervisor.view()).toMatchObject({ state: "ready", serverEpoch: EPOCHS[0] });
	});

	it("isolates a failing message listener without restarting the utility process", async () => {
		const diagnostics = { append: vi.fn().mockResolvedValue(undefined) };
		const { children, supervisor } = harness({ diagnostics });
		const child = await reachReady(supervisor, children);
		supervisor.onMessage(() => {
			throw new Error("renderer listener failed");
		});

		child.emit("message", {
			jsonrpc: "2.0",
			method: "connection/events",
			params: {
				serverEpoch: EPOCHS[0],
				fromCursor: 1,
				toCursor: 1,
				events: [{ type: "server/state", state: "ready" }],
			},
		});

		expect(child.killCount).toBe(0);
		expect(supervisor.view()).toMatchObject({ state: "ready", serverEpoch: EPOCHS[0] });
		await vi.waitFor(() =>
			expect(diagnostics.append).toHaveBeenCalledWith(
				"supervisor",
				expect.stringContaining("renderer listener failed"),
			),
		);
	});

	it("keeps server requests separate from pending client response ids", async () => {
		const { children, supervisor } = harness();
		const child = await reachReady(supervisor, children);
		const messages: unknown[] = [];
		supervisor.onMessage((message) => messages.push(message));
		const pending = supervisor.request({
			jsonrpc: "2.0",
			id: "shared-rpc-id",
			method: "session/list",
			params: {},
		});
		const interaction = {
			jsonrpc: "2.0" as const,
			id: "shared-rpc-id",
			method: "interaction/request" as const,
			params: {
				serverEpoch: EPOCHS[0],
				interaction: {
					interactionId: "55555555-5555-4555-8555-555555555555",
					sessionId: "session-1",
					title: "Confirm",
					message: "Continue?",
					createdAt: "2026-07-16T00:00:00.000Z",
					kind: "confirm" as const,
				},
			},
		};

		child.emit("message", interaction);
		expect(messages).toEqual([interaction]);
		expect(supervisor.view().state).toBe("ready");

		child.emit("message", {
			jsonrpc: "2.0",
			id: "shared-rpc-id",
			result: { sessions: [], nextAfterSessionId: null },
		});
		await expect(pending).resolves.toMatchObject({ result: { sessions: [] } });
	});

	it("validates and sends a correlated renderer response to the active child", async () => {
		const { children, supervisor } = harness();
		const child = await reachReady(supervisor, children);
		const request = {
			jsonrpc: "2.0" as const,
			id: "interaction-rpc-1",
			method: "interaction/request" as const,
			params: {
				serverEpoch: EPOCHS[0],
				interaction: {
					interactionId: "66666666-6666-4666-8666-666666666666",
					sessionId: "session-1",
					title: "Confirm",
					message: "Continue?",
					createdAt: "2026-07-16T00:00:00.000Z",
					kind: "confirm" as const,
				},
			},
		};
		const response = {
			jsonrpc: "2.0" as const,
			id: request.id,
			result: {
				interactionId: request.params.interaction.interactionId,
				kind: "confirm" as const,
				confirmed: true,
			},
		};

		supervisor.respondToServerRequest(request, response);
		expect(child.sent.at(-1)).toEqual(response);
		expect(() =>
			supervisor.respondToServerRequest(request, {
				...response,
				result: { ...response.result, interactionId: "77777777-7777-4777-8777-777777777777" },
			}),
		).toThrow("does not match");
	});

	it("shuts down gracefully after the host acknowledgement and child exit", async () => {
		const { children, supervisor } = harness();
		const child = await reachReady(supervisor, children);
		const stopped = supervisor.shutdown();
		const request = child.sent.at(-1) as { id: string; method: string };
		expect(request.method).toBe("server/shutdown");

		child.emit("message", { jsonrpc: "2.0", id: request.id, result: { accepted: true } });
		child.emit("exit", 0);
		await expect(stopped).resolves.toBeUndefined();
		expect(child.killCount).toBe(0);
		expect(supervisor.view()).toMatchObject({ state: "stopped", serverEpoch: null });
	});

	it("forces termination after the graceful app-quit deadline", async () => {
		const { children, supervisor } = harness({ shutdownTimeoutMs: 5_000 });
		const child = await reachReady(supervisor, children);
		const stopped = supervisor.shutdown();

		await vi.advanceTimersByTimeAsync(5_000);
		await expect(stopped).resolves.toBeUndefined();
		expect(child.killCount).toBe(1);
		expect(supervisor.view().state).toBe("stopped");
	});
});
