import type { ClientResult } from "@arcmind/app-protocol";
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

	private slotFor(ref: SessionRef): RuntimeSlot {
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

	async close(
		sessionId: string,
		prepareClose?: (runtime: OpenedSessionRuntime) => Promise<boolean> | boolean,
	): Promise<void> {
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
