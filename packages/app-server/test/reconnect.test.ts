import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ClientParams,
	ClientResult,
	DomainEvent,
	ItemView,
	SessionSnapshot,
	SessionSummary,
} from "@arcmind/app-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppServer } from "../src/app-server.ts";
import type { DurableSessionMutation, PreparedSessionMutation } from "../src/durable-mutation.ts";
import type { OutboundEnvelope } from "../src/outbound-queue.ts";
import { MAX_PROJECTED_THINKING_BYTES, SessionProjection } from "../src/projection/session-projection.ts";
import type {
	OpenedSessionRuntime,
	SessionEventListener,
	SessionRef,
	SessionRuntimeHost,
} from "../src/session-runtime-host.ts";
import { bindAppServerTransport } from "../src/transport/transport.ts";
import { type UtilityParentPort, UtilityProcessTransport } from "../src/transport/utility-process-transport.ts";

const SESSION_ID = "session-reconnect";
const CREATED_AT = "2026-07-16T00:00:00.000Z";

function summary(): SessionSummary {
	return {
		sessionId: SESSION_ID,
		mode: "code",
		cwdOrigin: "user-selected",
		cwd: "/tmp/project",
		createdAt: CREATED_AT,
		updatedAt: CREATED_AT,
		state: "idle",
		archived: false,
	};
}

function item(itemId: string, state: ItemView["state"] = "completed", text = itemId): ItemView {
	return {
		itemId,
		sessionId: SESSION_ID,
		role: "assistant",
		state,
		content: [{ type: "text", text }],
		createdAt: CREATED_AT,
		...(state === "streaming" ? {} : { completedAt: CREATED_AT }),
	};
}

class PausableRuntime implements OpenedSessionRuntime {
	readonly sessionId = SESSION_ID;
	readonly projection = new SessionProjection({ session: summary() });
	private readonly listeners = new Set<SessionEventListener>();
	private snapshotMaterialized?: () => void;
	private snapshotGate?: Promise<void>;
	private releaseSnapshotGate?: () => void;

	pauseNextSnapshot(): Promise<void> {
		let materialized!: () => void;
		const reached = new Promise<void>((resolve) => {
			materialized = resolve;
		});
		this.snapshotMaterialized = materialized;
		this.snapshotGate = new Promise<void>((resolve) => {
			this.releaseSnapshotGate = resolve;
		});
		return reached;
	}

	releaseSnapshot(): void {
		this.releaseSnapshotGate?.();
		this.releaseSnapshotGate = undefined;
	}

	emit(event: DomainEvent): void {
		const projected = this.projection.apply(event);
		if (!projected) return;
		for (const listener of this.listeners) listener(projected);
	}

	isActive(): boolean {
		return false;
	}

	hasPendingInteractions(): boolean {
		return false;
	}

	getSummary(): SessionSummary {
		return this.projection.getSummary();
	}

	async readItems(input: ClientParams<"session/readItems">): Promise<ClientResult<"session/readItems">> {
		return this.projection.readItems(input);
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

	async snapshot(serverEpoch: string, currentCursor: () => number): Promise<SessionSnapshot> {
		const result = this.projection.snapshot(serverEpoch, currentCursor());
		this.snapshotMaterialized?.();
		this.snapshotMaterialized = undefined;
		if (this.snapshotGate) await this.snapshotGate;
		this.snapshotGate = undefined;
		return result;
	}

	async startTurn(input: ClientParams<"turn/start">): Promise<ClientResult<"turn/start">> {
		return { operationId: input.requestId, status: "accepted" };
	}

	async steer(input: ClientParams<"turn/steer">): Promise<ClientResult<"turn/steer">> {
		return { operationId: input.requestId, status: "accepted" };
	}

	async interrupt(input: ClientParams<"turn/interrupt">): Promise<ClientResult<"turn/interrupt">> {
		return { operationId: input.requestId, status: "accepted" };
	}

	async prepareMutation(_input: DurableSessionMutation): Promise<PreparedSessionMutation> {
		return { state: "accepted" };
	}

	subscribe(listener: SessionEventListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	async close(): Promise<void> {}
}

class PausableHost implements SessionRuntimeHost {
	readonly runtime = new PausableRuntime();
	async open(_ref: SessionRef): Promise<OpenedSessionRuntime> {
		return this.runtime;
	}
}

function initialize(id: string) {
	return {
		jsonrpc: "2.0" as const,
		id,
		method: "initialize" as const,
		params: { protocolVersion: 4, client: { name: "test", version: "1" }, capabilities: [] },
	};
}

function writeSession(sessionsRoot: string): void {
	const directory = join(sessionsRoot, "project");
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, `${SESSION_ID}.jsonl`),
		`${JSON.stringify({
			type: "session",
			version: 5,
			id: SESSION_ID,
			timestamp: CREATED_AT,
			cwd: "/tmp/project",
		})}\n`,
	);
}

function notificationItems(messages: readonly OutboundEnvelope[]): ItemView[] {
	return messages.flatMap((message) =>
		"method" in message && message.method === "connection/events"
			? message.params.events.flatMap((event) => (event.type === "item/completed" ? [event.item] : []))
			: [],
	);
}

class FakeParentPort extends EventEmitter implements UtilityParentPort {
	readonly sent: unknown[] = [];
	postMessage(message: unknown): void {
		this.sent.push(structuredClone(message));
	}
	close(): void {}
}

describe("gap-free reconnect", () => {
	let tempDir: string | undefined;

	afterEach(() => {
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		tempDir = undefined;
	});

	it("delivers an event emitted after snapshot materialization exactly once", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "app-server-reconnect-"));
		const agentDir = join(tempDir, "agent");
		const sessionsRoot = join(agentDir, "sessions");
		writeSession(sessionsRoot);
		const host = new PausableHost();
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: host });
		const first = server.connect();
		const firstMessages: OutboundEnvelope[] = [];
		first.onMessage((message) => {
			if ("method" in message && message.method === "interaction/request") return;
			firstMessages.push(message);
		});
		await first.handle(initialize("initialize-first"));
		await first.handle({
			jsonrpc: "2.0",
			id: "open",
			method: "session/open",
			params: { sessionId: SESSION_ID },
		});

		const materialized = host.runtime.pauseNextSnapshot();
		const subscribing = first.handle({
			jsonrpc: "2.0",
			id: "subscribe-first",
			method: "session/subscribe",
			params: { sessionId: SESSION_ID },
		});
		await materialized;
		host.runtime.emit({ type: "item/completed", item: item("item-race") });
		host.runtime.releaseSnapshot();
		const response = await subscribing;
		const snapshot = (response as { result: { snapshot: SessionSnapshot } }).result.snapshot;

		await vi.waitFor(() => expect(notificationItems(firstMessages)).toHaveLength(1));
		const occurrences = [
			...snapshot.recentItems.filter((candidate) => candidate.itemId === "item-race"),
			...notificationItems(firstMessages).filter((candidate) => candidate.itemId === "item-race"),
		];
		expect(occurrences).toHaveLength(1);
		expect(snapshot.cursor).toBe(0);
		expect(firstMessages[0]).toMatchObject({
			method: "connection/events",
			params: { fromCursor: 1, toCursor: 1 },
		});

		await first.handle({
			jsonrpc: "2.0",
			id: "ack",
			method: "connection/ack",
			params: { serverEpoch: server.serverEpoch, cursor: 1 },
		});
		expect(first.getOutboundStats()).toMatchObject({ unacknowledgedBytes: 0, unacknowledgedEvents: 0 });

		first.close();
		const reconnected = server.connect();
		const reconnectMessages: OutboundEnvelope[] = [];
		reconnected.onMessage((message) => {
			if ("method" in message && message.method === "interaction/request") return;
			reconnectMessages.push(message);
		});
		await reconnected.handle(initialize("initialize-reconnect"));
		const reconnectResponse = await reconnected.handle({
			jsonrpc: "2.0",
			id: "subscribe-reconnect",
			method: "session/subscribe",
			params: { sessionId: SESSION_ID },
		});
		const reconnectSnapshot = (reconnectResponse as { result: { snapshot: SessionSnapshot } }).result.snapshot;
		expect(reconnectSnapshot.recentItems.filter((candidate) => candidate.itemId === "item-race")).toHaveLength(1);
		await Promise.resolve();
		expect(reconnectMessages).toEqual([]);
	});

	it("maintains incremental items and stable backward pages", () => {
		const items = Array.from({ length: 250 }, (_, index) => item(`item-${index}`));
		const projection = new SessionProjection({ session: summary(), items });
		const initial = projection.snapshot("00000000-0000-4000-8000-000000000001", 4);
		expect(initial.recentItems).toHaveLength(200);
		expect(initial.recentItems[0]?.itemId).toBe("item-50");
		expect(initial.nextBeforeItemId).toBe("item-50");

		const older = projection.readItems({ sessionId: SESSION_ID, beforeItemId: "item-50", limit: 200 });
		expect(older.items).toHaveLength(50);
		expect(older.items[0]?.itemId).toBe("item-0");
		expect(older.nextBeforeItemId).toBeNull();

		projection.apply({ type: "item/started", item: item("item-stream", "streaming", "") });
		projection.apply({
			type: "item/delta",
			sessionId: SESSION_ID,
			itemId: "item-stream",
			delta: { type: "text", text: "hello" },
		});
		projection.apply({
			type: "item/delta",
			sessionId: SESSION_ID,
			itemId: "item-stream",
			delta: { type: "text", text: " world" },
		});
		const streaming = projection.snapshot("00000000-0000-4000-8000-000000000001", 6);
		expect(streaming.recentItems.at(-1)).toMatchObject({
			itemId: "item-stream",
			content: [{ type: "text", text: "hello world" }],
		});
	});

	it("reserves visible-answer capacity after a long thinking stream", () => {
		const projection = new SessionProjection({ session: summary() });
		projection.apply({ type: "item/started", item: { ...item("item-thinking", "streaming", ""), content: [] } });
		projection.apply({
			type: "item/delta",
			sessionId: SESSION_ID,
			itemId: "item-thinking",
			delta: { type: "thinking", text: "t".repeat(MAX_PROJECTED_THINKING_BYTES + 1024) },
		});
		projection.apply({
			type: "item/delta",
			sessionId: SESSION_ID,
			itemId: "item-thinking",
			delta: { type: "text", text: "final answer" },
		});

		const projected = projection.snapshot("00000000-0000-4000-8000-000000000001", 2).recentItems.at(-1);
		expect(projected?.content).toEqual([
			{ type: "thinking", text: "t".repeat(MAX_PROJECTED_THINKING_BYTES) },
			{ type: "text", text: "final answer" },
		]);
	});

	it("disconnects only the overloaded client while a reconnect snapshots the continuing session", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "app-server-overload-reconnect-"));
		const agentDir = join(tempDir, "agent");
		const sessionsRoot = join(agentDir, "sessions");
		writeSession(sessionsRoot);
		const host = new PausableHost();
		const server = await AppServer.create({
			agentDir,
			sessionsRoot,
			runtimeHost: host,
			maxUnacknowledgedEvents: 1,
			maxUnacknowledgedBytes: 1024 * 1024,
		});
		const slow = server.connect();
		let release!: () => void;
		let started!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		const deliveryStarted = new Promise<void>((resolve) => {
			started = resolve;
		});
		const slowMessages: OutboundEnvelope[] = [];
		slow.onMessage(async (message) => {
			if ("method" in message && message.method === "interaction/request") return;
			slowMessages.push(message);
			if ("method" in message) {
				started();
				await blocked;
			}
		});
		await slow.handle(initialize("initialize-slow"));
		await slow.handle({
			jsonrpc: "2.0",
			id: "subscribe-slow",
			method: "session/subscribe",
			params: { sessionId: SESSION_ID },
		});

		host.runtime.emit({ type: "item/completed", item: item("item-before-overload") });
		await deliveryStarted;
		host.runtime.emit({ type: "item/completed", item: item("item-causing-overload") });
		expect(slow.getOutboundStats()).toMatchObject({ unacknowledgedEvents: 1, overloaded: true });
		release();
		await vi.waitFor(() => expect(slowMessages.at(-1)).toMatchObject({ error: { data: { name: "OVERLOADED" } } }));

		const reconnected = server.connect();
		await reconnected.handle(initialize("initialize-after-overload"));
		const response = await reconnected.handle({
			jsonrpc: "2.0",
			id: "subscribe-after-overload",
			method: "session/subscribe",
			params: { sessionId: SESSION_ID },
		});
		const snapshot = (response as { result: { snapshot: SessionSnapshot } }).result.snapshot;
		expect(snapshot.recentItems.map((candidate) => candidate.itemId)).toEqual([
			"item-before-overload",
			"item-causing-overload",
		]);
	});

	it("reinitializes an overloaded utility connection without restarting the server", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "app-server-overload-transport-"));
		const agentDir = join(tempDir, "agent");
		const sessionsRoot = join(agentDir, "sessions");
		writeSession(sessionsRoot);
		const host = new PausableHost();
		const server = await AppServer.create({
			agentDir,
			sessionsRoot,
			runtimeHost: host,
			maxUnacknowledgedEvents: 1,
		});
		const port = new FakeParentPort();
		const binding = bindAppServerTransport(server, new UtilityProcessTransport(port));
		const send = (data: unknown) => port.emit("message", { data });
		const response = async (id: string) => {
			await vi.waitFor(() => expect(port.sent).toContainEqual(expect.objectContaining({ id })));
			return port.sent.find(
				(candidate) =>
					typeof candidate === "object" && candidate !== null && "id" in candidate && candidate.id === id,
			) as { result?: unknown };
		};

		send(initialize("initialize-first"));
		await response("initialize-first");
		send({ jsonrpc: "2.0", id: "open-first", method: "session/open", params: { sessionId: SESSION_ID } });
		await response("open-first");
		send({
			jsonrpc: "2.0",
			id: "subscribe-first",
			method: "session/subscribe",
			params: { sessionId: SESSION_ID },
		});
		await response("subscribe-first");

		host.runtime.emit({ type: "item/completed", item: item("item-before-overload") });
		await vi.waitFor(() => expect(notificationItems(port.sent as OutboundEnvelope[])).toHaveLength(1));
		host.runtime.emit({ type: "item/completed", item: item("item-causing-overload") });
		await vi.waitFor(() =>
			expect(port.sent).toContainEqual(
				expect.objectContaining({ error: expect.objectContaining({ code: -32007 }) }),
			),
		);

		const originalEpoch = server.serverEpoch;
		send(initialize("initialize-reconnected"));
		await expect(response("initialize-reconnected")).resolves.toMatchObject({
			result: { serverEpoch: originalEpoch },
		});
		send({
			jsonrpc: "2.0",
			id: "subscribe-reconnected",
			method: "session/subscribe",
			params: { sessionId: SESSION_ID },
		});
		const reconnected = (await response("subscribe-reconnected")) as {
			result: { snapshot: SessionSnapshot };
		};
		expect(reconnected.result.snapshot.recentItems.map((candidate) => candidate.itemId)).toEqual([
			"item-before-overload",
			"item-causing-overload",
		]);

		await binding.close();
	});
});
