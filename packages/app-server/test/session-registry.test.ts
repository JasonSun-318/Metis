import type { ClientParams, ClientResult, SessionSnapshot, SessionSummary } from "@metis/app-protocol";
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
		unread: false,
		useMemory: true,
		contributeMemory: true,
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

	async markRead(): Promise<SessionSummary> {
		return this.getSummary();
	}

	async renameSession(name: string): Promise<SessionSummary> {
		return { ...this.getSummary(), name };
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

	async readItems(_input: ClientParams<"session/readItems">): Promise<ClientResult<"session/readItems">> {
		return { items: [], nextBeforeItemId: null };
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
		throw new Error("No goal support in registry fixture");
	}

	async clearGoal(input: ClientParams<"session/goal/clear">): Promise<ClientResult<"session/goal/clear">> {
		return { sessionId: input.sessionId, cleared: false };
	}

	async listAgents(): Promise<ClientResult<"agent/list">> {
		return { agents: [], nextAfterAgentId: null };
	}

	async readAgentItems(_input: ClientParams<"agent/readItems">): Promise<ClientResult<"agent/readItems">> {
		return { items: [], nextBeforeItemId: null };
	}

	async interruptAgent(): Promise<ClientResult<"agent/interrupt">> {
		throw new Error("No child runtime in registry fixture");
	}

	async archiveAgent(): Promise<ClientResult<"agent/archive">> {
		throw new Error("No agent archive in registry fixture");
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

	async prepareModelServiceSettingsRefresh(): Promise<void> {
		this.calls.push("refresh:prepare");
	}

	async applyModelServiceSettingsRefresh(): Promise<void> {
		this.calls.push("refresh:apply");
	}

	async refreshPermissionAutoSettings(): Promise<void> {
		this.calls.push("permission-auto:refresh");
	}

	notifyPermissionRulesChanged(): void {
		this.calls.push("permission-rules:changed");
	}

	async snapshot(serverEpoch: string, currentCursor: () => number): Promise<SessionSnapshot> {
		return {
			session: this.getSummary(),
			collaborationMode: "default",
			turns: [],
			recentItems: [],
			nextBeforeItemId: null,
			activeTurnId: null,
			pendingInteractions: [],
			queuedTurns: [],
			tasks: [],
			deliveredFiles: [],
			goal: null,
			thinkingSelection: "high",
			actualThinkingLevel: "high",
			availableThinkingSelections: ["off", "high", "max"],
			permissionPreset: "ask",
			effectiveSettings: { sandboxPolicy: "workspace-write", approvalPolicy: "user" },
			constrainedByParent: false,
			sandboxHealth: "healthy",
			agents: [],
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
	it("forwards draft Skill operations without opening a session runtime", async () => {
		const base = new FakeHost();
		const detail: ClientResult<"skill/get"> = {
			name: "writing-plans",
			description: "Write plans",
			source: "user",
			revision: "a".repeat(64),
			directoryPath: "/tmp/agent/skills/writing-plans",
			entryFile: "SKILL.md",
			files: ["SKILL.md"],
			content: "---\nname: writing-plans\ndescription: Write plans\n---\n\nWrite plans.",
			instructions: "Write plans.",
			updatedAt: "2026-08-11T00:00:00.000Z",
			editable: true,
		};
		const host: SessionRuntimeHost = {
			open: base.open,
			getSkill: vi.fn(async () => detail),
			upsertSkill: vi.fn(async () => detail),
			removeSkill: vi.fn(async () => ({ skills: [] })),
		};
		const registry = new SessionRegistry(host);
		const target = { cwd: null, source: "user" as const, name: "writing-plans" };

		await expect(registry.getDraftSkill(target)).resolves.toEqual(detail);
		await expect(
			registry.upsertDraftSkill({
				...target,
				requestId: "30000000-0000-4000-8000-000000000001",
				expectedRevision: null,
				content: detail.content,
			}),
		).resolves.toEqual(detail);
		await expect(
			registry.removeDraftSkill({
				...target,
				requestId: "30000000-0000-4000-8000-000000000002",
				expectedRevision: detail.revision,
			}),
		).resolves.toEqual({ skills: [] });
		expect(base.open).not.toHaveBeenCalled();
	});

	it("returns public errors when the host cannot manage draft Skills", async () => {
		const registry = new SessionRegistry(new FakeHost());
		await expect(registry.getDraftSkill({ cwd: null, source: "user", name: "writing-plans" })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(
			registry.upsertDraftSkill({
				cwd: null,
				source: "user",
				name: "writing-plans",
				requestId: "30000000-0000-4000-8000-000000000001",
				expectedRevision: null,
				content: "---\nname: writing-plans\ndescription: Write plans\n---\n\nWrite plans.",
			}),
		).rejects.toMatchObject({ code: "OPERATION_FAILED" });
	});

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

	it("invalidates permission authority in every opened runtime after a project-rule mutation", async () => {
		const host = new FakeHost();
		const registry = new SessionRegistry(host);
		const first = (await registry.open(ref("session-a"))) as FakeRuntime;
		const second = (await registry.open(ref("session-b"))) as FakeRuntime;

		await registry.notifyOpenPermissionRulesChanged();

		expect(first.calls).toEqual(["permission-rules:changed"]);
		expect(second.calls).toEqual(["permission-rules:changed"]);
	});

	it("gates public session work across two-phase model-service refresh", async () => {
		const host = new FakeHost();
		const registry = new SessionRegistry(host);
		const first = (await registry.open(ref("session-a"))) as FakeRuntime;
		const second = (await registry.open(ref("session-b"))) as FakeRuntime;
		const release = await registry.beginModelServiceSettingsRefresh();

		expect(await registry.prepareOpenModelServiceSettingsRefresh()).toEqual([]);
		expect(first.calls).toEqual(["refresh:prepare"]);
		expect(second.calls).toEqual(["refresh:prepare"]);
		await expect(registry.open(ref("session-c"))).rejects.toMatchObject({ code: "BUSY" });
		await expect(registry.run(ref("session-a"), () => undefined)).rejects.toMatchObject({ code: "BUSY" });
		await expect(registry.close("session-a")).rejects.toMatchObject({ code: "BUSY" });
		await expect(registry.withSessionsQuiesced(["session-a"], async () => undefined)).rejects.toMatchObject({
			code: "BUSY",
		});

		expect(await registry.applyOpenModelServiceSettingsRefresh()).toEqual([]);
		expect(first.calls).toEqual(["refresh:prepare", "refresh:apply"]);
		release();
		await expect(registry.run(ref("session-a"), () => "ready")).resolves.toBe("ready");
	});

	it("serializes concurrent refresh gates and removes a runtime that fails refresh", async () => {
		const host = new FakeHost();
		const registry = new SessionRegistry(host);
		const runtime = (await registry.open(ref("session-a"))) as FakeRuntime;
		const firstRelease = await registry.beginModelServiceSettingsRefresh();
		let secondEntered = false;
		const second = registry.beginModelServiceSettingsRefresh().then((release) => {
			secondEntered = true;
			return release;
		});
		await Promise.resolve();
		expect(secondEntered).toBe(false);
		firstRelease();
		const secondRelease = await second;

		runtime.prepareModelServiceSettingsRefresh = vi.fn(async () => {
			throw new Error("refresh failed");
		});
		expect(await registry.prepareOpenModelServiceSettingsRefresh()).toEqual(["session-a"]);
		expect(registry.has("session-a")).toBe(false);
		expect(runtime.closed).toBe(true);
		secondRelease();
	});

	it("removes a runtime that fails an Auto permission settings refresh", async () => {
		const host = new FakeHost();
		const registry = new SessionRegistry(host);
		const runtime = (await registry.open(ref("session-a"))) as FakeRuntime;
		const release = await registry.beginModelServiceSettingsRefresh();
		runtime.refreshPermissionAutoSettings = vi.fn(async () => {
			throw new Error("refresh failed");
		});

		expect(await registry.refreshOpenPermissionAutoSettings()).toEqual(["session-a"]);
		expect(registry.has("session-a")).toBe(false);
		expect(runtime.closed).toBe(true);
		release();
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
