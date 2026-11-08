import type { ClientParams, ClientResult } from "@metis/app-protocol";
import { assertValidSessionId, type SessionPermissionRule } from "@metis/coding-agent/host";
import {
	AppServerError,
	type OpenedSessionRuntime,
	type PluginRuntimeStatus,
	type SessionRef,
	type SessionRuntimeHost,
} from "./session-runtime-host.ts";

/**
 * Structural seam for open runtimes that expose their in-memory session rule
 * store; production runtimes implement it, test hosts may not.
 */
interface SessionPermissionRuleRuntime {
	listSessionPermissionRules(projectPath: string): readonly SessionPermissionRule[];
	deleteSessionPermissionRule(projectPath: string, ruleId: string): boolean;
	clearSessionPermissionRules(projectPath: string): number;
}

function sessionPermissionRuleRuntime(runtime: OpenedSessionRuntime): SessionPermissionRuleRuntime | undefined {
	const candidate = runtime as Partial<SessionPermissionRuleRuntime>;
	if (
		typeof candidate.listSessionPermissionRules === "function" &&
		typeof candidate.deleteSessionPermissionRule === "function" &&
		typeof candidate.clearSessionPermissionRules === "function"
	) {
		return candidate as SessionPermissionRuleRuntime;
	}
	return undefined;
}

interface RuntimeSlot {
	readonly ref: SessionRef;
	readonly runtime: Promise<OpenedSessionRuntime>;
	tail: Promise<void>;
	pending: number;
	accepting: boolean;
	lastUsed: number;
	order: number;
	eviction?: Promise<void>;
}

export interface SessionRegistryOptions {
	maxQueuedOperationsPerSession?: number;
	/** Eligible, unsubscribed idle runtimes kept warm (default: 8). Stateful runtimes are pinned. */
	maxIdleRuntimes?: number;
	/** Minimum idle time before reclaiming an excess runtime (default: 60 seconds). */
	idleRuntimeGraceMs?: number;
	isSessionSubscribed?: (sessionId: string) => boolean;
	onRuntimeEvicted?: (sessionId: string) => void;
}

/** Owns lazy runtimes and the bounded, per-session operation queues. */
export class SessionRegistry {
	private readonly host: SessionRuntimeHost;
	private readonly slots = new Map<string, RuntimeSlot>();
	private readonly blockedSessionIds = new Set<string>();
	private readonly maxQueuedOperationsPerSession: number;
	private accepting = true;
	private modelServiceRefreshActive = false;
	private modelServiceRefreshTail: Promise<void> = Promise.resolve();
	private shutdownPromise?: Promise<void>;
	private readonly options: SessionRegistryOptions;
	private readonly maxIdleRuntimes: number;
	private readonly idleRuntimeGraceMs: number;
	private retentionTimer?: ReturnType<typeof setTimeout>;
	private retentionTask?: Promise<void>;
	private useOrder = 0;

	constructor(host: SessionRuntimeHost, options: SessionRegistryOptions = {}) {
		this.host = host;
		this.options = options;
		this.maxIdleRuntimes = options.maxIdleRuntimes ?? 8;
		this.idleRuntimeGraceMs = options.idleRuntimeGraceMs ?? 60_000;
		if (
			!Number.isSafeInteger(this.maxIdleRuntimes) ||
			this.maxIdleRuntimes < 0 ||
			!Number.isSafeInteger(this.idleRuntimeGraceMs) ||
			this.idleRuntimeGraceMs < 1
		) {
			throw new TypeError("Idle runtime limits must be safe integers with a positive grace period");
		}
		const maximum = options.maxQueuedOperationsPerSession ?? 128;
		if (!Number.isSafeInteger(maximum) || maximum < 1) {
			throw new TypeError("maxQueuedOperationsPerSession must be a positive safe integer");
		}
		this.maxQueuedOperationsPerSession = maximum;
	}

	has(sessionId: string): boolean {
		return this.slots.has(sessionId);
	}

	private scheduleRetention(): void {
		if (!this.accepting || this.retentionTimer || this.retentionTask || this.slots.size <= this.maxIdleRuntimes)
			return;
		this.retentionTimer = setTimeout(() => {
			this.retentionTimer = undefined;
			void this.pruneIdleRuntimes().catch((error: unknown) => {
				console.error("Failed to reclaim idle session runtime", error);
			});
		}, this.idleRuntimeGraceMs);
		this.retentionTimer.unref();
	}

	/** Serialized with session operations; safe to invoke explicitly in diagnostics/tests. */
	pruneIdleRuntimes(): Promise<void> {
		if (this.retentionTask) return this.retentionTask;
		this.retentionTask = this.pruneIdleRuntimesOnce().finally(() => {
			this.retentionTask = undefined;
			this.scheduleRetention();
		});
		return this.retentionTask;
	}

	private canEvict(slot: RuntimeSlot, runtime: OpenedSessionRuntime): boolean {
		return (
			this.accepting &&
			!this.modelServiceRefreshActive &&
			slot.accepting &&
			slot.pending === 0 &&
			!this.blockedSessionIds.has(slot.ref.summary.sessionId) &&
			!this.options.isSessionSubscribed?.(slot.ref.summary.sessionId) &&
			!runtime.isActive() &&
			!runtime.hasPendingInteractions() &&
			runtime.canEvictWhenIdle?.() === true
		);
	}

	private async pruneIdleRuntimesOnce(): Promise<void> {
		const eligible: { slot: RuntimeSlot; runtime: OpenedSessionRuntime }[] = [];
		for (const slot of this.slots.values()) {
			if (slot.eviction || slot.pending > 0 || !slot.accepting) continue;
			let runtime: OpenedSessionRuntime;
			try {
				runtime = await slot.runtime;
			} catch {
				// Failed opens are removed by their owning operation queue.
				continue;
			}
			if (this.canEvict(slot, runtime)) eligible.push({ slot, runtime });
		}
		eligible.sort((left, right) => left.slot.order - right.slot.order);
		for (const { slot, runtime } of eligible.slice(0, Math.max(0, eligible.length - this.maxIdleRuntimes))) {
			if (Date.now() - slot.lastUsed < this.idleRuntimeGraceMs) continue;
			const eviction = slot.tail.then(async () => {
				if (!this.canEvict(slot, runtime) || Date.now() - slot.lastUsed < this.idleRuntimeGraceMs) return;
				await runtime.close();
				if (this.slots.get(slot.ref.summary.sessionId) === slot) {
					this.slots.delete(slot.ref.summary.sessionId);
					this.options.onRuntimeEvicted?.(slot.ref.summary.sessionId);
				}
			});
			slot.eviction = eviction;
			slot.tail = eviction.catch(() => undefined);
			await eviction;
			slot.eviction = undefined;
		}
	}

	/** Read an already-open runtime without creating one when the session is cold. */
	async withOpenRuntime<T>(
		sessionId: string,
		operation: (runtime: OpenedSessionRuntime) => Promise<T>,
	): Promise<{ open: true; result: T } | { open: false }> {
		const slot = this.slots.get(sessionId);
		if (!slot) return { open: false };
		if (slot.eviction) {
			await slot.eviction;
			return await this.withOpenRuntime(sessionId, operation);
		}
		return { open: true, result: await this.enqueue(slot, operation) };
	}

	async listDraftSkills(cwd: string | null): Promise<ClientResult<"skill/list">> {
		return this.host.listSkills ? await this.host.listSkills(cwd) : { skills: [] };
	}

	async getDraftSkill(input: ClientParams<"skill/get">): Promise<ClientResult<"skill/get">> {
		if (!this.host.getSkill) throw new AppServerError("NOT_FOUND");
		return await this.host.getSkill(input);
	}

	async upsertDraftSkill(input: ClientParams<"skill/upsert">): Promise<ClientResult<"skill/upsert">> {
		if (!this.host.upsertSkill) throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
		return await this.host.upsertSkill(input);
	}

	async removeDraftSkill(input: ClientParams<"skill/remove">): Promise<ClientResult<"skill/remove">> {
		if (!this.host.removeSkill) throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
		return await this.host.removeSkill(input);
	}

	async listAgentTypes(): Promise<ClientResult<"agentType/list">> {
		if (!this.host.listAgentTypes) throw new AppServerError("NOT_FOUND");
		return await this.host.listAgentTypes({});
	}

	async upsertAgentType(input: ClientParams<"agentType/upsert">): Promise<ClientResult<"agentType/upsert">> {
		if (!this.host.upsertAgentType) throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
		return await this.host.upsertAgentType(input);
	}

	async removeAgentType(input: ClientParams<"agentType/remove">): Promise<ClientResult<"agentType/remove">> {
		if (!this.host.removeAgentType) throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
		return await this.host.removeAgentType(input);
	}

	async inspectDraftSkillImport(
		input: ClientParams<"skill/import/inspect">,
	): Promise<ClientResult<"skill/import/inspect">> {
		if (!this.host.inspectSkillImport) throw new AppServerError("OPERATION_FAILED");
		return await this.host.inspectSkillImport(input);
	}

	async importDraftSkills(input: ClientParams<"skill/import">): Promise<ClientResult<"skill/import">> {
		if (!this.host.importSkills) throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
		return await this.host.importSkills(input);
	}

	async listDraftMcpServers(cwd: string | null): Promise<ClientResult<"mcp/list">> {
		return this.host.listMcpServers ? await this.host.listMcpServers(cwd) : { servers: [] };
	}

	async inspectDraftMcpImport(input: ClientParams<"mcp/import/inspect">): Promise<ClientResult<"mcp/import/inspect">> {
		if (!this.host.inspectMcpImport) throw new AppServerError("OPERATION_FAILED");
		return await this.host.inspectMcpImport(input);
	}

	async importDraftMcpServers(input: ClientParams<"mcp/import">): Promise<ClientResult<"mcp/import">> {
		if (!this.host.importMcpServers) throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
		return await this.host.importMcpServers(input);
	}

	async getDraftMcpServer(input: ClientParams<"mcp/get">): Promise<ClientResult<"mcp/get">> {
		if (!this.host.getMcpServer) throw new AppServerError("NOT_FOUND");
		return await this.host.getMcpServer(input);
	}

	async upsertDraftMcpServer(input: ClientParams<"mcp/upsert">): Promise<ClientResult<"mcp/upsert">> {
		if (!this.host.upsertMcpServer) throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
		return await this.host.upsertMcpServer(input);
	}

	async removeDraftMcpServer(input: ClientParams<"mcp/remove">): Promise<ClientResult<"mcp/remove">> {
		if (!this.host.removeMcpServer) throw new AppServerError("OPERATION_FAILED", { requestId: input.requestId });
		return await this.host.removeMcpServer(input);
	}

	private slotFor(ref: SessionRef): RuntimeSlot {
		if (this.modelServiceRefreshActive) throw new AppServerError("BUSY", { sessionId: ref.summary.sessionId });
		if (this.blockedSessionIds.has(ref.summary.sessionId)) {
			throw new AppServerError("BUSY", { sessionId: ref.summary.sessionId });
		}
		const existing = this.slots.get(ref.summary.sessionId);
		if (existing) return existing;
		if (!this.accepting) throw new AppServerError("BUSY", { sessionId: ref.summary.sessionId });

		const slot: RuntimeSlot = {
			ref,
			runtime: this.host.open(ref),
			tail: Promise.resolve(),
			pending: 0,
			accepting: true,
			lastUsed: Date.now(),
			order: ++this.useOrder,
		};
		this.slots.set(ref.summary.sessionId, slot);
		return slot;
	}

	private async enqueue<T>(
		slot: RuntimeSlot,
		operation: (runtime: OpenedSessionRuntime) => Promise<T> | T,
	): Promise<T> {
		if (slot.eviction) await slot.eviction;
		if (this.slots.get(slot.ref.summary.sessionId) !== slot) {
			return await this.enqueue(this.slotFor(slot.ref), operation);
		}
		if (!slot.accepting) throw new AppServerError("BUSY", { sessionId: slot.ref.summary.sessionId });
		if (slot.pending >= this.maxQueuedOperationsPerSession) {
			throw new AppServerError("OVERLOADED", { sessionId: slot.ref.summary.sessionId });
		}

		slot.pending += 1;
		slot.lastUsed = Date.now();
		slot.order = ++this.useOrder;
		const result = slot.tail.then(async () => operation(await slot.runtime));
		slot.tail = result.then(
			() => undefined,
			() => undefined,
		);
		try {
			return await result;
		} finally {
			slot.pending -= 1;
			slot.lastUsed = Date.now();
			slot.order = ++this.useOrder;
			if (slot.pending === 0) {
				try {
					await slot.runtime;
				} catch {
					if (this.slots.get(slot.ref.summary.sessionId) === slot) this.slots.delete(slot.ref.summary.sessionId);
				}
			}
			this.scheduleRetention();
		}
	}

	async open(ref: SessionRef): Promise<OpenedSessionRuntime> {
		const slot = this.slotFor(ref);
		return await this.enqueue(slot, (runtime) => runtime);
	}

	async run<T>(ref: SessionRef, operation: (runtime: OpenedSessionRuntime) => Promise<T> | T): Promise<T> {
		return await this.enqueue(this.slotFor(ref), operation);
	}

	async hasActiveSessions(): Promise<boolean> {
		for (const slot of this.slots.values()) {
			try {
				const runtime = await slot.runtime;
				if (runtime.isActive()) return true;
			} catch {
				// ignore
			}
		}
		return false;
	}

	async pluginRuntimeStatuses(): Promise<PluginRuntimeStatus[]> {
		const statuses: PluginRuntimeStatus[] = [];
		for (const slot of this.slots.values()) {
			try {
				const runtime = await slot.runtime;
				if (runtime.getPluginRuntimeStatus) {
					statuses.push(runtime.getPluginRuntimeStatus());
				}
			} catch {
				// ignore
			}
		}
		return statuses;
	}

	async refreshOpenWebSearchSettings(): Promise<void> {
		if (this.modelServiceRefreshActive) throw new AppServerError("BUSY");
		const slots = [...this.slots.values()].filter((slot) => slot.accepting);
		await Promise.all(
			slots.map((slot) => this.enqueue(slot, async (runtime) => runtime.refreshWebSearchSettings?.())),
		);
	}

	async refreshOpenPermissionAutoSettings(): Promise<string[]> {
		return await this.refreshOpenRuntimeSettings("refreshPermissionAutoSettings");
	}

	/** Refresh memory settings on every open runtime; returns sessionIds that failed and were closed. */
	async refreshOpenMemorySettings(): Promise<string[]> {
		return await this.refreshOpenRuntimeSettings("refreshMemorySettings");
	}

	async notifyOpenPermissionRulesChanged(): Promise<void> {
		if (this.modelServiceRefreshActive) return;
		const slots = [...this.slots.values()].filter((slot) => slot.accepting);
		await Promise.allSettled(
			slots.map((slot) => this.enqueue(slot, async (runtime) => runtime.notifyPermissionRulesChanged?.())),
		);
	}

	listOpenPermissionSessionIds(): readonly string[] {
		return [...this.slots.entries()].filter(([, slot]) => slot.accepting).map(([id]) => id);
	}

	/**
	 * Run an operation against one open session's in-memory permission rule store.
	 * Cold sessions have no live store; the operation is not attempted.
	 */
	async withOpenSessionPermissionRules<T>(
		sessionId: string,
		operation: (access: {
			listSessionPermissionRules(projectPath: string): readonly SessionPermissionRule[];
			deleteSessionPermissionRule(projectPath: string, ruleId: string): boolean;
			clearSessionPermissionRules(projectPath: string): number;
		}) => Promise<T> | T,
	): Promise<{ open: true; result: T } | { open: false }> {
		const slot = this.slots.get(sessionId);
		if (!slot) return { open: false };
		return await this.enqueue(slot, async (runtime) => {
			const access = sessionPermissionRuleRuntime(runtime);
			if (!access) return { open: false };
			return { open: true, result: await operation(access) };
		});
	}

	/** Re-judge permissions on one session after its own session rules changed. */
	async notifySessionPermissionRulesChanged(sessionId: string): Promise<void> {
		const slot = this.slots.get(sessionId);
		if (!slot) return;
		await this.enqueue(slot, async (runtime) => runtime.notifyPermissionRulesChanged?.()).catch(() => {
			// A closing session cannot keep stale grants alive; ignore teardown races.
		});
	}

	async beginModelServiceSettingsRefresh(): Promise<() => void> {
		if (this.retentionTask) await this.retentionTask;
		if (!this.accepting) throw new AppServerError("BUSY");
		let unlock!: () => void;
		const lock = new Promise<void>((resolve) => {
			unlock = resolve;
		});
		const previous = this.modelServiceRefreshTail;
		this.modelServiceRefreshTail = previous.then(() => lock);
		await previous;
		if (!this.accepting) {
			unlock();
			throw new AppServerError("BUSY");
		}
		this.modelServiceRefreshActive = true;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.modelServiceRefreshActive = false;
			unlock();
		};
	}

	async prepareOpenModelServiceSettingsRefresh(): Promise<string[]> {
		return await this.refreshOpenModelServices("prepareModelServiceSettingsRefresh");
	}

	async applyOpenModelServiceSettingsRefresh(): Promise<string[]> {
		return await this.refreshOpenModelServices("applyModelServiceSettingsRefresh");
	}

	private async refreshOpenModelServices(
		method: "prepareModelServiceSettingsRefresh" | "applyModelServiceSettingsRefresh",
	): Promise<string[]> {
		return await this.refreshOpenRuntimeSettings(method);
	}

	private async refreshOpenRuntimeSettings(
		method:
			| "prepareModelServiceSettingsRefresh"
			| "applyModelServiceSettingsRefresh"
			| "refreshPermissionAutoSettings"
			| "refreshMemorySettings",
	): Promise<string[]> {
		const slots = [...this.slots.values()].filter((slot) => slot.accepting);
		const results = await Promise.allSettled(
			slots.map((slot) => this.enqueue(slot, async (runtime) => runtime[method]?.())),
		);
		const failed: string[] = [];
		for (let index = 0; index < results.length; index += 1) {
			if (results[index]?.status === "fulfilled") continue;
			const slot = slots[index]!;
			failed.push(slot.ref.summary.sessionId);
			slot.accepting = false;
			if (this.slots.get(slot.ref.summary.sessionId) === slot) this.slots.delete(slot.ref.summary.sessionId);
			try {
				await (await slot.runtime).close();
			} catch {
				// A failed refresh slot is already detached; close is best-effort.
			}
		}
		return failed;
	}

	async close(
		sessionId: string,
		prepareClose?: (runtime: OpenedSessionRuntime) => Promise<boolean> | boolean,
	): Promise<void> {
		const evicting = this.slots.get(sessionId)?.eviction;
		if (evicting) await evicting;
		if (this.modelServiceRefreshActive) throw new AppServerError("BUSY", { sessionId });
		if (this.blockedSessionIds.has(sessionId)) throw new AppServerError("BUSY", { sessionId });
		const slot = this.slots.get(sessionId);
		if (!slot) return;
		if (!slot.accepting) throw new AppServerError("BUSY", { sessionId });
		if (slot.pending >= this.maxQueuedOperationsPerSession) {
			throw new AppServerError("OVERLOADED", { sessionId });
		}

		slot.accepting = false;
		slot.pending += 1;
		const result = slot.tail.then(async () => {
			const runtime = await slot.runtime;
			if (runtime.isActive() || runtime.hasPendingInteractions()) {
				throw new AppServerError("SESSION_IN_USE", { sessionId });
			}
			if ((await prepareClose?.(runtime)) === false) return false;
			await runtime.close();
			return true;
		});
		slot.tail = result.then(
			() => undefined,
			() => undefined,
		);

		try {
			if (await result) this.slots.delete(sessionId);
			else slot.accepting = true;
		} catch (error) {
			try {
				await slot.runtime;
				slot.accepting = true;
			} catch {
				if (this.slots.get(sessionId) === slot) this.slots.delete(sessionId);
			}
			throw error;
		} finally {
			slot.pending -= 1;
		}
	}

	async withSessionsQuiesced<T>(
		sessionIds: readonly string[],
		operation: () => Promise<T>,
		beforeClose?: () => void,
	): Promise<T> {
		if (this.retentionTask) await this.retentionTask;
		if (this.modelServiceRefreshActive) throw new AppServerError("BUSY");
		const ids = [...new Set(sessionIds)];
		for (const sessionId of ids) assertValidSessionId(sessionId);
		if (ids.some((sessionId) => this.blockedSessionIds.has(sessionId))) throw new AppServerError("BUSY");
		for (const sessionId of ids) this.blockedSessionIds.add(sessionId);
		try {
			const slots = ids.flatMap((sessionId) => {
				const slot = this.slots.get(sessionId);
				return slot ? [slot] : [];
			});
			if (slots.some((slot) => !slot.accepting || slot.pending > 0)) {
				throw new AppServerError("SESSION_IN_USE");
			}
			const runtimes = await Promise.all(slots.map((slot) => slot.runtime));
			if (runtimes.some((runtime) => runtime.isActive() || runtime.hasPendingInteractions())) {
				throw new AppServerError("SESSION_IN_USE");
			}
			beforeClose?.();
			for (const slot of slots) slot.accepting = false;
			const closed = await Promise.allSettled(runtimes.map((runtime) => runtime.close()));
			let failed = false;
			for (let index = 0; index < slots.length; index += 1) {
				const slot = slots[index]!;
				if (closed[index]?.status === "fulfilled") {
					if (this.slots.get(slot.ref.summary.sessionId) === slot) this.slots.delete(slot.ref.summary.sessionId);
				} else {
					failed = true;
					slot.accepting = true;
				}
			}
			if (failed) throw new AppServerError("OPERATION_FAILED");
			return await operation();
		} finally {
			for (const sessionId of ids) this.blockedSessionIds.delete(sessionId);
		}
	}

	assertClosed(sessionId: string): void {
		if (this.slots.has(sessionId)) throw new AppServerError("SESSION_IN_USE", { sessionId });
	}

	shutdown(): Promise<void> {
		if (!this.shutdownPromise) this.shutdownPromise = this.shutdownOnce();
		return this.shutdownPromise;
	}

	private async shutdownOnce(): Promise<void> {
		this.accepting = false;
		if (this.retentionTimer) clearTimeout(this.retentionTimer);
		this.retentionTimer = undefined;
		// A close already in progress owns its runtime until it settles.
		await this.retentionTask?.catch(() => undefined);
		const slots = [...this.slots.values()];
		for (const slot of slots) slot.accepting = false;
		await Promise.allSettled(slots.map((slot) => slot.tail));
		const results = await Promise.allSettled(
			slots.map(async (slot) => {
				const runtime = await slot.runtime;
				await runtime.close();
			}),
		);
		this.slots.clear();
		const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
		if (failures.length > 0)
			throw new AggregateError(
				failures.map((failure) => failure.reason),
				"Runtime shutdown failed",
			);
	}
}
