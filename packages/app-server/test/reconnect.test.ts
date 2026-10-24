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
} from "@metis/app-protocol";
import { PROTOCOL_VERSION } from "@metis/app-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppServer } from "../src/app-server.ts";
import type { ConnectionOutboundEnvelope } from "../src/connection.ts";
import type { DurableSessionMutation, PreparedSessionMutation } from "../src/durable-mutation.ts";
import { projectLatestTasks, projectTasksFromToolResult } from "../src/item-projection.ts";
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
		unread: false,
		useMemory: true,
		contributeMemory: true,
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

	async markRead(): Promise<SessionSummary> {
		return this.getSummary();
	}

	async renameSession(name: string): Promise<SessionSummary> {
		const session = { ...this.getSummary(), name };
		this.emit({ type: "session/updated", session });
		return session;
	}

	async fork(): Promise<string> {
		return `fork-${this.sessionId}`;
	}

	async listSkills(): Promise<ClientResult<"skill/list">> {
		return { skills: [] };
	}

	async listMcpServers(): Promise<ClientResult<"mcp/list">> {
		return { servers: [] };
	}

	async inspectMcpImport(): Promise<ClientResult<"mcp/import/inspect">> {
		return { sourceRevision: "a".repeat(64), candidates: [] };
	}

	async importMcpServers(): Promise<ClientResult<"mcp/import">> {
		return { servers: [] };
	}

	async getMcpServer(): Promise<ClientResult<"mcp/get">> {
		throw new Error("No MCP server in fixture");
	}

	async getMcpCatalogItem(): Promise<ClientResult<"mcp/catalog/get">> {
		throw new Error("No MCP catalog item in fixture");
	}

	async upsertMcpServer(): Promise<ClientResult<"mcp/upsert">> {
		return { servers: [] };
	}

	async removeMcpServer(): Promise<ClientResult<"mcp/remove">> {
		return { servers: [] };
	}

	async restartMcpServer(): Promise<ClientResult<"mcp/restart">> {
		throw new Error("No MCP server in fixture");
	}

	async setMcpCredential(): Promise<ClientResult<"mcp/credential/set">> {
		throw new Error("No MCP server in fixture");
	}

	async clearMcpCredential(): Promise<ClientResult<"mcp/credential/clear">> {
		throw new Error("No MCP server in fixture");
	}

	async readItems(input: ClientParams<"session/readItems">): Promise<ClientResult<"session/readItems">> {
		return this.projection.readItems(input);
	}

	async readImage(): Promise<ClientResult<"session/readImage">> {
		throw new Error("No image in fixture");
	}

	async openDeliveredFile(): Promise<ClientResult<"session/openDeliveredFile">> {
		throw new Error("No delivered file in fixture");
	}

	async readDeliveredFile(
		input: ClientParams<"session/readDeliveredFile">,
	): Promise<ClientResult<"session/readDeliveredFile">> {
		return {
			fileId: input.fileId,
			name: "sample.pdf",
			byteLength: 1024,
			data: "JVBERi0xLjQK...",
			mediaType: "application/pdf",
		};
	}

	async getStatus(input: ClientParams<"session/status">): Promise<ClientResult<"session/status">> {
		return {
			sessionId: input.sessionId,
			mode: "code",
			contextTokens: 64_000,
			contextWindow: 128_000,
			contextBasis: "reported_total",
			contextBreakdown: [{ category: "conversation", tokens: 64_000 }],
			remainingPercent: 50,
			cacheHitPercent: 25,
		};
	}

	async compact(input: ClientParams<"session/compact">): Promise<ClientResult<"session/compact">> {
		return { sessionId: input.sessionId, tokensBefore: 64_000, estimatedTokensAfter: 8_000 };
	}

	async getGoal(input: ClientParams<"session/goal/get">): Promise<ClientResult<"session/goal/get">> {
		return { sessionId: input.sessionId, goal: null };
	}

	async setGoal(): Promise<ClientResult<"session/goal/set">> {
		throw new Error("No goal support in reconnect fixture");
	}

	async clearGoal(input: ClientParams<"session/goal/clear">): Promise<ClientResult<"session/goal/clear">> {
		return { sessionId: input.sessionId, cleared: false };
	}

	async listAgents(): Promise<ClientResult<"agent/list">> {
		return { agents: [], nextAfterAgentId: null };
	}

	async sendAgentMessage(): Promise<ClientResult<"agent/send">> {
		throw new Error("No child conversation in fixture");
	}

	async controlAgent(): Promise<ClientResult<"agent/control">> {
		throw new Error("No child control in fixture");
	}

	async readAgentItems(_input: ClientParams<"agent/readItems">): Promise<ClientResult<"agent/readItems">> {
		return { items: [], nextBeforeItemId: null };
	}

	async interruptAgent(): Promise<ClientResult<"agent/interrupt">> {
		throw new Error("No child runtime in reconnect fixture");
	}

	async archiveAgent(): Promise<ClientResult<"agent/archive">> {
		throw new Error("No agent archive in reconnect fixture");
	}

	async deleteAgent(input: ClientParams<"agent/delete">): Promise<ClientResult<"agent/delete">> {
		return { agentId: input.agentId, status: "deleted" };
	}

	async setThinkingSelection(
		input: ClientParams<"session/setThinkingSelection">,
	): Promise<ClientResult<"session/setThinkingSelection">> {
		return {
			thinkingSelection: input.selection,
			actualThinkingLevel: input.selection,
			availableThinkingSelections: ["off", "high", "max"],
		};
	}

	async setPermissionPreset(
		input: ClientParams<"session/setPermissionPreset">,
	): Promise<ClientResult<"session/setPermissionPreset">> {
		return {
			permissionPreset: input.permissionPreset,
			effectiveSettings:
				input.permissionPreset === "full"
					? { sandboxPolicy: "danger-full-access", approvalPolicy: "user" }
					: input.permissionPreset === "ask"
						? { sandboxPolicy: "workspace-write", approvalPolicy: "user" }
						: { sandboxPolicy: "workspace-write", approvalPolicy: "auto-review" },
			constrainedByParent: false,
			sandboxHealth: "healthy",
		};
	}

	async setMemoryFlags(
		input: ClientParams<"session/setMemoryFlags">,
	): Promise<ClientResult<"session/setMemoryFlags">> {
		return {
			useMemory: input.useMemory ?? true,
			contributeMemory: input.contributeMemory ?? true,
		};
	}

	async setCollaborationMode(
		input: ClientParams<"session/setCollaborationMode">,
	): Promise<ClientResult<"session/setCollaborationMode">> {
		return { collaborationMode: input.collaborationMode };
	}

	async startPlanExecution(input: ClientParams<"plan/startExecution">): Promise<ClientResult<"plan/startExecution">> {
		return { operationId: input.requestId, status: "accepted" };
	}

	async cancelPlan(input: ClientParams<"plan/cancel">): Promise<ClientResult<"plan/cancel">> {
		return {
			plan: {
				planId: input.planId,
				revision: input.revision,
				title: "Plan",
				markdown: "# Plan",
				status: "cancelled",
				createdAt: this.getSummary().createdAt,
			},
			collaborationMode: "default",
		};
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

	async queueTurn(input: ClientParams<"turn/queue">): Promise<ClientResult<"turn/queue">> {
		return {
			queuedTurn: {
				queueItemId: input.requestId,
				revision: input.requestId,
				state: "paused",
				text: input.text,
				attachments: [],
			},
		};
	}

	async updateQueuedTurn(input: ClientParams<"turn/queue/update">): Promise<ClientResult<"turn/queue/update">> {
		return {
			queuedTurn: {
				queueItemId: input.queueItemId,
				revision: input.requestId,
				state: "paused",
				text: input.text,
				attachments: [],
			},
		};
	}

	async deleteQueuedTurn(input: ClientParams<"turn/queue/delete">): Promise<ClientResult<"turn/queue/delete">> {
		return { queueItemId: input.queueItemId, deleted: true };
	}

	async sendQueuedTurn(input: ClientParams<"turn/queue/send">): Promise<ClientResult<"turn/queue/send">> {
		return { operationId: input.requestId, queueItemId: input.queueItemId, status: "accepted" };
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
		params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, capabilities: [] },
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

function notificationItems(messages: readonly ConnectionOutboundEnvelope[]): ItemView[] {
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

	it("keeps sidebar summary events global after transcript unsubscribe", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "app-server-summary-events-"));
		const agentDir = join(tempDir, "agent");
		const sessionsRoot = join(agentDir, "sessions");
		writeSession(sessionsRoot);
		const host = new PausableHost();
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: host });
		const first = server.connect();
		const second = server.connect();
		const messages: ConnectionOutboundEnvelope[][] = [[], []];
		first.onMessage((message) => {
			messages[0]!.push(message);
		});
		second.onMessage((message) => {
			messages[1]!.push(message);
		});
		await Promise.all([first.handle(initialize("first")), second.handle(initialize("second"))]);
		await first.handle({
			jsonrpc: "2.0",
			id: "subscribe",
			method: "session/subscribe",
			params: { sessionId: SESSION_ID },
		});
		await first.handle({
			jsonrpc: "2.0",
			id: "unsubscribe",
			method: "session/unsubscribe",
			params: { sessionId: SESSION_ID },
		});

		host.runtime.emit({ type: "session/updated", session: { ...summary(), unread: true } });
		// The default 1s wait is too tight when the whole suite runs in parallel.
		await vi.waitFor(
			() => {
				for (const connectionMessages of messages) {
					expect(JSON.stringify(connectionMessages)).toContain('"unread":true');
				}
			},
			{ timeout: 5_000 },
		);
		expect(server.catalog.get(SESSION_ID).summary.unread).toBe(true);
	});

	it("delivers an event emitted after snapshot materialization exactly once", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "app-server-reconnect-"));
		const agentDir = join(tempDir, "agent");
		const sessionsRoot = join(agentDir, "sessions");
		writeSession(sessionsRoot);
		const host = new PausableHost();
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: host });
		const first = server.connect();
		const firstMessages: ConnectionOutboundEnvelope[] = [];
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
		const reconnectMessages: ConnectionOutboundEnvelope[] = [];
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

		const older = projection.readItems({
			sessionId: SESSION_ID,
			beforeItemId: initial.nextBeforeItemId!,
			limit: 200,
		});
		expect(older.items).toHaveLength(50);
		expect(older.items[0]?.itemId).toBe("item-0");
		expect(older.nextBeforeItemId).toBeNull();
		expect([...older.items, ...initial.recentItems].map((candidate) => candidate.itemId)).toEqual(
			items.map((candidate) => candidate.itemId),
		);

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

	it("forwards model changes through the session projection", () => {
		const projection = new SessionProjection({ session: summary() });
		const event = {
			type: "session/modelChanged",
			sessionId: SESSION_ID,
			model: { provider: "test", modelId: "model-b" },
			thinkingSelection: "high",
			actualThinkingLevel: "high",
			availableThinkingSelections: ["off", "high", "max"],
		} as const satisfies DomainEvent;

		expect(projection.apply(event)).toEqual(event);
	});

	it("keeps task snapshots independent of transcript pagination", () => {
		const tasks = [
			{ task: "Inspect implementation", completed: true },
			{ task: "Build task panel", completed: false },
		];
		const projection = new SessionProjection({ session: summary(), tasks });

		expect(projection.snapshot("00000000-0000-4000-8000-000000000001", 1).tasks).toEqual(tasks);
		const event = {
			type: "session/tasksChanged",
			sessionId: SESSION_ID,
			tasks: [...tasks, { task: "Run validation", completed: false }],
		} as const satisfies DomainEvent;
		expect(projection.apply(event)).toEqual(event);
		expect(projection.snapshot("00000000-0000-4000-8000-000000000001", 2).tasks).toEqual(event.tasks);
	});

	it("projects only successful bounded task results from the selected branch", () => {
		const first = {
			role: "toolResult",
			toolName: "set_tasks",
			isError: false,
			details: { tasks: [{ task: "  Inspect implementation  ", completed: false }] },
		};
		const latest = {
			role: "toolResult",
			toolName: "set_tasks",
			isError: false,
			details: { tasks: [{ task: "Build task panel", completed: true }] },
		};

		expect(projectTasksFromToolResult(first)).toEqual([{ task: "Inspect implementation", completed: false }]);
		expect(
			projectLatestTasks([
				{ type: "message", message: first },
				{ type: "message", message: latest },
			]),
		).toEqual([{ task: "Build task panel", completed: true }]);
		expect(projectTasksFromToolResult({ ...latest, isError: true })).toBeUndefined();
		expect(
			projectTasksFromToolResult({ ...latest, details: { tasks: [{ task: "", completed: false }] } }),
		).toBeUndefined();
		expect(
			projectTasksFromToolResult({
				...latest,
				details: { tasks: Array.from({ length: 257 }, () => ({ task: "x", completed: false })) },
			}),
		).toBeUndefined();
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
		const slowMessages: ConnectionOutboundEnvelope[] = [];
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
		await vi.waitFor(() => expect(notificationItems(port.sent as ConnectionOutboundEnvelope[])).toHaveLength(1));
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
