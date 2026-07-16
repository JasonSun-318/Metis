import type {
	AgentMessage,
	AgentQueueIdentity,
	AgentQueueKind,
	AgentQueueReservation,
	BeforeQueueClearContext,
	BeforeQueueCommitContext,
	QueueMode,
	ReservedAgentQueueItem,
} from "./types.ts";

type PendingQueueItem = ReservedAgentQueueItem;

type ActiveReservation = {
	readonly token: symbol;
	readonly value: AgentQueueReservation;
	readonly entries: readonly PendingQueueItem[];
	clearOnRelease: boolean;
};

export class PendingMessageQueue {
	private items: PendingQueueItem[] = [];
	private activeReservation?: ActiveReservation;
	private nextLocalId = 0;
	public mode: QueueMode;
	readonly kind: AgentQueueKind;

	constructor(mode: QueueMode, kind: AgentQueueKind) {
		this.mode = mode;
		this.kind = kind;
	}

	enqueue(message: AgentMessage, identity?: AgentQueueIdentity): void {
		const queueItemId = identity?.queueItemId ?? `agent-queue:${this.kind}:${++this.nextLocalId}`;
		if (this.items.some((item) => item.queueItemId === queueItemId)) {
			throw new Error(`Queue item is already pending: ${queueItemId}`);
		}
		this.items.push({ queueItemId, operationId: identity?.operationId, message });
	}

	hasItems(): boolean {
		return this.items.length > 0;
	}

	reserve(): AgentQueueReservation | undefined {
		if (this.activeReservation) return this.activeReservation.value;
		const entries = this.mode === "all" ? this.items.slice() : this.items.slice(0, 1);
		if (entries.length === 0) return undefined;

		const token = Symbol("queue-reservation");
		const publicItems = Object.freeze(
			entries.map((entry) =>
				Object.freeze({
					queueItemId: entry.queueItemId,
					operationId: entry.operationId,
					message: entry.message,
				}),
			),
		);
		const value = Object.freeze({
			items: publicItems,
			commit: () => this.commit(token, entries),
			release: () => this.release(token),
		});
		this.activeReservation = { token, value, entries, clearOnRelease: false };
		return value;
	}

	assertCanClear(beforeClear?: (context: BeforeQueueClearContext) => void): void {
		beforeClear?.({
			queue: this.kind,
			items: Object.freeze(this.items.map((item) => Object.freeze({ ...item }))),
		});
	}

	clear(): void {
		if (!this.activeReservation) {
			this.items = [];
			return;
		}
		this.items.splice(this.activeReservation.entries.length);
		this.activeReservation.clearOnRelease = true;
	}

	private commit(token: symbol, entries: readonly PendingQueueItem[]): void {
		if (this.activeReservation?.token !== token) {
			throw new Error("Queue reservation is no longer active");
		}
		if (entries.some((entry, index) => this.items[index] !== entry)) {
			this.activeReservation = undefined;
			throw new Error("Queue changed before its reservation could be committed");
		}
		this.items.splice(0, entries.length);
		this.activeReservation = undefined;
	}

	private release(token: symbol): void {
		if (this.activeReservation?.token !== token) return;
		if (this.activeReservation.clearOnRelease) {
			this.items.splice(0, this.activeReservation.entries.length);
		}
		this.activeReservation = undefined;
	}
}

export async function consumeQueueReservation(
	queue: AgentQueueKind,
	reservation: AgentQueueReservation | undefined,
	beforeCommit: ((context: BeforeQueueCommitContext, signal?: AbortSignal) => Promise<void>) | undefined,
	signal?: AbortSignal,
): Promise<AgentMessage[]> {
	if (!reservation || reservation.items.length === 0) {
		reservation?.release();
		return [];
	}

	try {
		if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted");
		const context = Object.freeze({ queue, items: reservation.items });
		if (beforeCommit) await beforeCommit(context, signal);
		if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted");
		reservation.commit();
		return reservation.items.map((item) => item.message);
	} catch (error) {
		reservation.release();
		throw error;
	}
}
