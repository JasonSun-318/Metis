import type { ClientParams, ClientResult } from "@metis/app-protocol";
import { assertValidSessionId } from "@metis/coding-agent";
import {
	AppServerError,
	type OpenedSessionRuntime,
	type SessionRef,
	type SessionRuntimeHost,
} from "./session-runtime-host.ts";

interface RuntimeSlot {
	readonly ref: SessionRef;
	readonly runtime: Promise<OpenedSessionRuntime>;
	tail: Promise<void>;
	pending: number;
	accepting: boolean;
}

export interface SessionRegistryOptions {
	maxQueuedOperationsPerSession?: number;
}

/** Owns lazy runtimes and the bounded, per-session operation queues. */
export class SessionRegistry {
	private readonly host: SessionRuntimeHost;
	private readonly slots = new Map<string, RuntimeSlot>();
	private readonly blockedSessionIds = new Set<string>();
	private readonly maxQueuedOperationsPerSession: number;
	private accepting = true;
	private shutdownPromise?: Promise<void>;

	constructor(host: SessionRuntimeHost, options: SessionRegistryOptions = {}) {
		this.host = host;
		const maximum = options.maxQueuedOperationsPerSession ?? 128;
		if (!Number.isSafeInteger(maximum) || maximum < 1) {
			throw new TypeError("maxQueuedOperationsPerSession must be a positive safe integer");
		}
		this.maxQueuedOperationsPerSession = maximum;
	}

	has(sessionId: string): boolean {
		return this.slots.has(sessionId);
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
		};
		this.slots.set(ref.summary.sessionId, slot);
		return slot;
	}

	private async enqueue<T>(
		slot: RuntimeSlot,
		operation: (runtime: OpenedSessionRuntime) => Promise<T> | T,
	): Promise<T> {
		if (!slot.accepting) throw new AppServerError("BUSY", { sessionId: slot.ref.summary.sessionId });
		if (slot.pending >= this.maxQueuedOperationsPerSession) {
			throw new AppServerError("OVERLOADED", { sessionId: slot.ref.summary.sessionId });
		}

		slot.pending += 1;
		const result = slot.tail.then(async () => operation(await slot.runtime));
		slot.tail = result.then(
			() => undefined,
			() => undefined,
		);
		try {
			return await result;
		} finally {
			slot.pending -= 1;
			if (slot.pending === 0) {
				try {
					await slot.runtime;
				} catch {
					if (this.slots.get(slot.ref.summary.sessionId) === slot) this.slots.delete(slot.ref.summary.sessionId);
				}
			}
		}
	}

	async open(ref: SessionRef): Promise<OpenedSessionRuntime> {
		const slot = this.slotFor(ref);
		return await this.enqueue(slot, (runtime) => runtime);
	}

	async run<T>(ref: SessionRef, operation: (runtime: OpenedSessionRuntime) => Promise<T> | T): Promise<T> {
		return await this.enqueue(this.slotFor(ref), operation);
	}

	async refreshOpenWebSearchSettings(): Promise<void> {
		const slots = [...this.slots.values()].filter((slot) => slot.accepting);
		await Promise.all(
			slots.map((slot) => this.enqueue(slot, async (runtime) => runtime.refreshWebSearchSettings?.())),
		);
	}

	async close(
		sessionId: string,
		prepareClose?: (runtime: OpenedSessionRuntime) => Promise<boolean> | boolean,
	): Promise<void> {
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
