import type { ClientParams, ClientResult, SessionSnapshot, SessionSummary } from "@arcmind/app-protocol";
import { describe, expect, it, vi } from "vitest";
import type { DurableSessionMutation, PreparedSessionMutation } from "../src/durable-mutation.ts";
import { SessionRegistry } from "../src/session-registry.ts";
import type {
	OpenedSessionRuntime,
	SessionEventListener,
	SessionRef,
	SessionRuntimeHost,
} from "../src/session-runtime-host.ts";

function summary(sessionId: string): SessionSummary {
	return {
		sessionId,
		mode: "code",
		cwdOrigin: "user-selected",
		cwd: "/tmp/project",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		state: "idle",
		archived: false,
	};
}

function ref(sessionId: string): SessionRef {
	return { path: `/tmp/${sessionId}.jsonl`, relativePath: `${sessionId}.jsonl`, summary: summary(sessionId) };
}

class FakeRuntime implements OpenedSessionRuntime {
	readonly sessionId: string;
	active = false;
	pendingInteractions = false;
	closed = false;
	readonly calls: string[] = [];

	constructor(sessionId: string) {
		this.sessionId = sessionId;
	}

	isActive(): boolean {
		return this.active;
	}

	hasPendingInteractions(): boolean {
		return this.pendingInteractions;
	}

	getSummary(): SessionSummary {
		return { ...summary(this.sessionId), state: this.active ? "running" : "idle" };
	}

	async renameSession(name: string): Promise<SessionSummary> {
		return { ...this.getSummary(), name };
	}

	async listSkills(): Promise<ClientResult<"skill/list">> {
		return { skills: [] };
	}

	async readItems(_input: ClientParams<"session/readItems">): Promise<ClientResult<"session/readItems">> {
		return { items: [], nextBeforeItemId: null };
	}

	async readSubagentItems(_input: ClientParams<"subagent/readItems">): Promise<ClientResult<"subagent/readItems">> {
		return { items: [], nextBeforeItemId: null };
	}

	async setThinkingSelection(
		input: ClientParams<"session/setThinkingSelection">,
	): Promise<ClientResult<"session/setThinkingSelection">> {
		return {
			thinkingSelection: input.selection,
			actualThinkingLevel: input.selection === "ultra" ? "max" : input.selection,
			availableThinkingSelections: ["off", "high", "ultra"],
		};
	}

	async setPermissionMode(
		input: ClientParams<"session/setPermissionMode">,
	): Promise<ClientResult<"session/setPermissionMode">> {
		return { permissionMode: input.permissionMode };
	}

	async setModel(input: ClientParams<"session/setModel">): Promise<ClientResult<"session/setModel">> {
		return {
			model: { provider: input.provider, modelId: input.modelId },
			thinkingSelection: "high",
			actualThinkingLevel: "high",
			availableThinkingSelections: ["off", "high", "max"],
		};
	}

	async snapshot(serverEpoch: string, currentCursor: () => number): Promise<SessionSnapshot> {
		return {
			session: this.getSummary(),
			turns: [],
			recentItems: [],
			nextBeforeItemId: null,
			activeTurnId: null,
			pendingInteractions: [],
			thinkingSelection: "high",
			actualThinkingLevel: "high",
			availableThinkingSelections: ["off", "high", "ultra"],
			permissionMode: "ask",
			subagents: [],
			serverEpoch,
			cursor: currentCursor(),
		};
	}

	async startTurn(input: ClientParams<"turn/start">): Promise<ClientResult<"turn/start">> {
		this.calls.push(input.text);
		return { operationId: input.requestId, status: "accepted" };
	}

	async steer(input: ClientParams<"turn/steer">): Promise<ClientResult<"turn/steer">> {
		this.calls.push(input.text);
		return { operationId: input.requestId, status: "accepted" };
	}

	async interrupt(input: ClientParams<"turn/interrupt">): Promise<ClientResult<"turn/interrupt">> {
		this.active = false;
		return { operationId: input.requestId, status: "accepted" };
	}

	async prepareMutation(_input: DurableSessionMutation): Promise<PreparedSessionMutation> {
		return { state: "accepted" };
	}

	subscribe(_listener: SessionEventListener): () => void {
		return () => undefined;
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

class FakeHost implements SessionRuntimeHost {
	readonly runtimes = new Map<string, FakeRuntime>();
	readonly open = vi.fn(async (sessionRef: SessionRef): Promise<FakeRuntime> => {
		const runtime = new FakeRuntime(sessionRef.summary.sessionId);
		this.runtimes.set(runtime.sessionId, runtime);
		return runtime;
	});
}

describe("SessionRegistry", () => {
	it("blocks the whole selected set, closes idle runtimes concurrently, then runs the operation", async () => {
		const host = new FakeHost();
		const registry = new SessionRegistry(host);
		const first = (await registry.open(ref("session-a"))) as FakeRuntime;
		const second = (await registry.open(ref("session-b"))) as FakeRuntime;
		await registry.open(ref("session-other"));
		let releaseFirst!: () => void;
		let releaseSecond!: () => void;
		let firstClosing!: () => void;
		let secondClosing!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		const secondGate = new Promise<void>((resolve) => {
			releaseSecond = resolve;
		});
		const firstStarted = new Promise<void>((resolve) => {
			firstClosing = resolve;
		});
		const secondStarted = new Promise<void>((resolve) => {
			secondClosing = resolve;
		});
		first.close = vi.fn(async () => {
			firstClosing();
			await firstGate;
			first.closed = true;
		});
		second.close = vi.fn(async () => {
			secondClosing();
			await secondGate;
			second.closed = true;
		});
		const operation = vi.fn(async () => "deleted");
		const result = registry.withSessionsQuiesced(
			["session-a", "session-b", "session-unopened", "session-a"],
			operation,
		);

		await expect(registry.open(ref("session-unopened"))).rejects.toMatchObject({ code: "BUSY" });
		await expect(registry.run(ref("session-a"), () => undefined)).rejects.toMatchObject({ code: "BUSY" });
		await registry.run(ref("session-other"), () => undefined);
		await Promise.all([firstStarted, secondStarted]);
		expect(operation).not.toHaveBeenCalled();
		releaseFirst();
		await Promise.resolve();
		expect(operation).not.toHaveBeenCalled();
		releaseSecond();
		await expect(result).resolves.toBe("deleted");
		expect(operation).toHaveBeenCalledOnce();
		expect(first.close).toHaveBeenCalledOnce();
		expect(second.close).toHaveBeenCalledOnce();
		await expect(registry.open(ref("session-unopened"))).resolves.toBeDefined();
	});

	it.each(["queued", "active", "interaction"] as const)(
		"preflights a %s selected runtime before closing any runtime",
		async (state) => {
			const host = new FakeHost();
			const registry = new SessionRegistry(host);
			const first = (await registry.open(ref("session-a"))) as FakeRuntime;
			const second = (await registry.open(ref("session-b"))) as FakeRuntime;
			let release!: () => void;
			let queued: Promise<void> | undefined;
			if (state === "queued") {
				const gate = new Promise<void>((resolve) => {
					release = resolve;
				});
				queued = registry.run(ref("session-a"), () => gate);
			} else if (state === "active") first.active = true;
			else first.pendingInteractions = true;

			await expect(
				registry.withSessionsQuiesced(["session-a", "session-b"], async () => undefined),
			).rejects.toMatchObject({ code: "SESSION_IN_USE" });
			expect(first.closed).toBe(false);
			expect(second.closed).toBe(false);
			if (queued) {
				release();
				await queued;
			}
			first.active = false;
			first.pendingInteractions = false;
			await expect(registry.run(ref("session-a"), () => "available")).resolves.toBe("available");
		},
	);

	it("does not run the operation after a close failure and re-enables every selected id", async () => {
		const host = new FakeHost();
		const registry = new SessionRegistry(host);
		const first = (await registry.open(ref("session-a"))) as FakeRuntime;
		const second = (await registry.open(ref("session-b"))) as FakeRuntime;
		second.close = vi.fn(async () => {
			throw new Error("close failed");
		});
		const operation = vi.fn(async () => undefined);

		await expect(
			registry.withSessionsQuiesced(["session-a", "session-b", "session-unopened"], operation),
		).rejects.toMatchObject({ code: "OPERATION_FAILED" });
		expect(operation).not.toHaveBeenCalled();
		expect(first.closed).toBe(true);
		await expect(registry.open(ref("session-a"))).resolves.toBeDefined();
		await expect(registry.run(ref("session-b"), () => "available")).resolves.toBe("available");
		await expect(registry.open(ref("session-unopened"))).resolves.toBeDefined();

		await expect(
			registry.withSessionsQuiesced(["session-a"], async () => {
				throw new Error("operation failed");
			}),
		).rejects.toThrow("operation failed");
		await expect(registry.open(ref("session-a"))).resolves.toBeDefined();
	});

	it("opens each session lazily and only once", async () => {
		const host = new FakeHost();
		const registry = new SessionRegistry(host);

		expect(host.open).not.toHaveBeenCalled();
		const first = await registry.open(ref("session-a"));
		const second = await registry.open(ref("session-a"));

		expect(first).toBe(second);
		expect(host.open).toHaveBeenCalledTimes(1);
	});

	it("serializes operations for one session", async () => {
		const registry = new SessionRegistry(new FakeHost());
		const order: string[] = [];
		let release!: () => void;
		let started!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const firstStarted = new Promise<void>((resolve) => {
			started = resolve;
		});

		const first = registry.run(ref("session-a"), async () => {
			order.push("first:start");
			started();
			await blocked;
			order.push("first:end");
		});
		const second = registry.run(ref("session-a"), async () => {
			order.push("second");
		});
		await firstStarted;
		expect(order).toEqual(["first:start"]);
		release();
		await Promise.all([first, second]);
		expect(order).toEqual(["first:start", "first:end", "second"]);
	});

	it("allows different sessions to progress concurrently", async () => {
		const registry = new SessionRegistry(new FakeHost());
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		let secondRan = false;

		const first = registry.run(ref("session-a"), () => blocked);
		await registry.run(ref("session-b"), () => {
			secondRan = true;
		});

		expect(secondRan).toBe(true);
		release();
		await first;
	});

	it("rejects queue overflow without disturbing admitted work", async () => {
		const registry = new SessionRegistry(new FakeHost(), { maxQueuedOperationsPerSession: 1 });
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const first = registry.run(ref("session-a"), () => blocked);

		await expect(registry.run(ref("session-a"), () => undefined)).rejects.toMatchObject({ code: "OVERLOADED" });
		release();
		await first;
	});

	it("refuses to close an active runtime, then unloads it after interrupt", async () => {
		const host = new FakeHost();
		const registry = new SessionRegistry(host);
		const runtime = (await registry.open(ref("session-a"))) as FakeRuntime;
		runtime.active = true;

		await expect(registry.close("session-a")).rejects.toMatchObject({ code: "SESSION_IN_USE" });
		expect(registry.has("session-a")).toBe(true);
		await registry.run(ref("session-a"), (opened) =>
			opened.interrupt({
				sessionId: "session-a",
				requestId: "00000000-0000-4000-8000-000000000002",
			}),
		);
		await registry.close("session-a");

		expect(runtime.closed).toBe(true);
		expect(registry.has("session-a")).toBe(false);
	});

	it("closes every opened runtime during graceful shutdown", async () => {
		const host = new FakeHost();
		const registry = new SessionRegistry(host);
		await Promise.all([registry.open(ref("session-a")), registry.open(ref("session-b"))]);

		await registry.shutdown();

		expect([...host.runtimes.values()].every((runtime) => runtime.closed)).toBe(true);
		await expect(registry.open(ref("session-c"))).rejects.toMatchObject({ code: "BUSY" });
	});

	it("removes a slot whose lazy open fails while close is queued", async () => {
		let rejectOpen!: (error: Error) => void;
		const blockedOpen = new Promise<OpenedSessionRuntime>((_resolve, reject) => {
			rejectOpen = reject;
		});
		const host: SessionRuntimeHost = { open: vi.fn(() => blockedOpen) };
		const registry = new SessionRegistry(host);
		const opening = registry.open(ref("session-a"));
		const closing = registry.close("session-a");

		rejectOpen(new Error("open failed"));
		await expect(opening).rejects.toThrow("open failed");
		await expect(closing).rejects.toThrow("open failed");
		expect(registry.has("session-a")).toBe(false);
	});

	it("attempts every runtime shutdown and reports the collected failures", async () => {
		const host = new FakeHost();
		const registry = new SessionRegistry(host);
		const first = (await registry.open(ref("session-a"))) as FakeRuntime;
		const second = (await registry.open(ref("session-b"))) as FakeRuntime;
		first.close = vi.fn(async () => {
			throw new Error("close failed");
		});

		await expect(registry.shutdown()).rejects.toBeInstanceOf(AggregateError);
		expect(second.closed).toBe(true);
		expect(registry.has("session-a")).toBe(false);
		expect(registry.has("session-b")).toBe(false);
		await expect(registry.shutdown()).rejects.toBeInstanceOf(AggregateError);
	});
});
