import {
	createRpcError,
	type DomainEvent,
	MAX_ENVELOPE_UTF8_BYTES,
	MAX_EVENT_BATCH,
	type RpcErrorResponse,
	type ServerRpcNotification,
	validateServerNotification,
} from "@metis/app-protocol";
import { AppServerError } from "./session-runtime-host.ts";

export const DEFAULT_MAX_UNACKNOWLEDGED_BYTES = 4 * 1024 * 1024;
export const DEFAULT_MAX_UNACKNOWLEDGED_EVENTS = 1024;

export type OutboundEnvelope = ServerRpcNotification | RpcErrorResponse;
export type OutboundSender = (envelope: OutboundEnvelope) => Promise<void> | void;

export interface OutboundQueueLimits {
	readonly maxUnacknowledgedBytes?: number;
	readonly maxUnacknowledgedEvents?: number;
	readonly maxEnvelopeBytes?: number;
}

export interface OutboundQueueOptions extends OutboundQueueLimits {
	readonly serverEpoch: string;
	readonly onTerminal?: (reason: "overloaded" | "delivery_failed") => void;
}

interface QueuedEvent {
	cursor: number;
	event: DomainEvent;
	bytes: number;
	sent: boolean;
	hold?: symbol;
	deltaParts?: Array<{ readonly cursor: number; readonly text: string }>;
}

type DeltaEvent = Extract<DomainEvent, { type: "item/delta" | "agent/item/delta" }>;

export interface OutboundStage {
	enqueue(cursor: number, event: DomainEvent): boolean;
	commit(snapshotCursor: number): void;
	abort(): void;
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < 1) throw new TypeError(`${name} must be a positive safe integer`);
	return resolved;
}

function eventBytes(event: DomainEvent): number {
	return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function notification(serverEpoch: string, records: readonly QueuedEvent[]): ServerRpcNotification {
	return validateServerNotification({
		jsonrpc: "2.0",
		method: "connection/events",
		params: {
			serverEpoch,
			fromCursor: records[0]!.cursor,
			toCursor: records.at(-1)!.cursor,
			events: records.map((record) => structuredClone(record.event)),
		},
	});
}

function envelopeBytes(value: OutboundEnvelope): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function canCoalesce(previous: QueuedEvent, next: QueuedEvent): boolean {
	if (previous.sent || previous.hold !== next.hold || previous.event.type !== next.event.type) {
		return false;
	}
	if (previous.event.type === "agent/itemsChanged" && next.event.type === "agent/itemsChanged") {
		return (
			previous.event.sessionId === next.event.sessionId &&
			previous.event.agentId === next.event.agentId &&
			previous.event.taskId === next.event.taskId
		);
	}
	if (previous.event.type !== "item/delta" && previous.event.type !== "agent/item/delta") return false;
	const prior = previous.event as DeltaEvent;
	const incoming = next.event as DeltaEvent;
	return (
		prior.sessionId === incoming.sessionId &&
		prior.itemId === incoming.itemId &&
		prior.delta.type === incoming.delta.type &&
		(prior.type !== "agent/item/delta" ||
			(incoming.type === "agent/item/delta" && prior.agentId === incoming.agentId))
	);
}

/** Bounded connection-local delivery and acknowledgement state. */
export class OutboundQueue {
	private readonly serverEpoch: string;
	private readonly maxUnacknowledgedBytes: number;
	private readonly maxUnacknowledgedEvents: number;
	private readonly maxEnvelopeBytes: number;
	private readonly onTerminal?: OutboundQueueOptions["onTerminal"];
	private readonly records: QueuedEvent[] = [];
	private sender?: OutboundSender;
	private unacknowledgedBytes = 0;
	private acknowledgedCursor = 0;
	private lastObservedCursor = 0;
	private lastSentCursor = 0;
	private pumping = false;
	private pumpScheduled = false;
	private closed = false;
	private terminal?: RpcErrorResponse;
	private terminalNotified = false;

	constructor(options: OutboundQueueOptions) {
		this.serverEpoch = options.serverEpoch;
		this.maxUnacknowledgedBytes = positiveLimit(
			options.maxUnacknowledgedBytes,
			DEFAULT_MAX_UNACKNOWLEDGED_BYTES,
			"maxUnacknowledgedBytes",
		);
		this.maxUnacknowledgedEvents = positiveLimit(
			options.maxUnacknowledgedEvents,
			DEFAULT_MAX_UNACKNOWLEDGED_EVENTS,
			"maxUnacknowledgedEvents",
		);
		this.maxEnvelopeBytes = positiveLimit(options.maxEnvelopeBytes, MAX_ENVELOPE_UTF8_BYTES, "maxEnvelopeBytes");
		this.onTerminal = options.onTerminal;
	}

	setSender(sender: OutboundSender): () => void {
		if (this.sender && this.sender !== sender) throw new TypeError("An outbound sender is already attached");
		if (this.closed) throw new AppServerError("BUSY");
		this.sender = sender;
		this.schedulePump();
		return () => {
			if (this.sender === sender) this.sender = undefined;
		};
	}

	enqueue(cursor: number, event: DomainEvent): boolean {
		return this.enqueueWithHold(cursor, event);
	}

	createStage(): OutboundStage {
		const hold = Symbol("snapshot");
		let active = true;
		return {
			enqueue: (cursor, event) => active && this.enqueueWithHold(cursor, event, hold),
			commit: (snapshotCursor) => {
				if (!active) return;
				active = false;
				this.commitStage(hold, snapshotCursor);
			},
			abort: () => {
				if (!active) return;
				active = false;
				this.removeHeld(hold);
			},
		};
	}

	private enqueueWithHold(cursor: number, event: DomainEvent, hold?: symbol): boolean {
		if (this.closed || this.terminal) return false;
		if (!Number.isSafeInteger(cursor) || cursor < 1 || cursor <= this.lastObservedCursor) {
			throw new TypeError("Outbound cursors must be positive and strictly increasing");
		}

		const incoming: QueuedEvent = {
			cursor,
			event: structuredClone(event),
			bytes: eventBytes(event),
			sent: false,
			...(hold === undefined ? {} : { hold }),
			...(event.type === "item/delta" || event.type === "agent/item/delta"
				? { deltaParts: [{ cursor, text: event.delta.text }] }
				: {}),
		};
		const single = notification(this.serverEpoch, [incoming]);
		if (envelopeBytes(single) > this.maxEnvelopeBytes) {
			this.overload();
			return false;
		}

		let previous: QueuedEvent | undefined;
		let merged: QueuedEvent | undefined;
		const last = this.records.at(-1);
		if (last && canCoalesce(last, incoming)) {
			previous = {
				...last,
				event: structuredClone(last.event),
				...(last.deltaParts === undefined ? {} : { deltaParts: [...last.deltaParts] }),
			};
			if (last.event.type === "agent/itemsChanged") {
				merged = { ...last, cursor, event: incoming.event, bytes: incoming.bytes };
			} else {
				const prior = last.event as DeltaEvent;
				const next = incoming.event as DeltaEvent;
				const mergedEvent: DomainEvent = {
					...prior,
					delta: { ...next.delta, text: prior.delta.text + next.delta.text },
				};
				merged = {
					...last,
					cursor,
					event: mergedEvent,
					bytes: eventBytes(mergedEvent),
					deltaParts: [
						...(last.deltaParts ?? [{ cursor: previous.cursor, text: prior.delta.text }]),
						{ cursor, text: next.delta.text },
					],
				};
			}
			if (envelopeBytes(notification(this.serverEpoch, [merged])) > this.maxEnvelopeBytes) {
				previous = undefined;
				merged = undefined;
			}
		}

		this.lastObservedCursor = cursor;
		if (previous && merged && last) {
			last.cursor = merged.cursor;
			last.event = merged.event;
			last.bytes = merged.bytes;
			last.deltaParts = merged.deltaParts;
			this.unacknowledgedBytes += merged.bytes - previous.bytes;
		} else {
			this.records.push(incoming);
			this.unacknowledgedBytes += incoming.bytes;
		}

		if (
			this.records.length > this.maxUnacknowledgedEvents ||
			this.unacknowledgedBytes > this.maxUnacknowledgedBytes
		) {
			if (previous) {
				const lastRecord = this.records.at(-1)!;
				this.unacknowledgedBytes += previous.bytes - lastRecord.bytes;
				lastRecord.cursor = previous.cursor;
				lastRecord.event = previous.event;
				lastRecord.bytes = previous.bytes;
				lastRecord.deltaParts = previous.deltaParts;
			} else {
				const removed = this.records.pop()!;
				this.unacknowledgedBytes -= removed.bytes;
			}
			this.overload();
			return false;
		}

		this.schedulePump();
		return true;
	}

	private removeHeld(hold: symbol): void {
		for (let index = this.records.length - 1; index >= 0; index -= 1) {
			const record = this.records[index]!;
			if (record.hold !== hold) continue;
			this.unacknowledgedBytes -= record.bytes;
			this.records.splice(index, 1);
		}
		this.schedulePump();
	}

	private commitStage(hold: symbol, snapshotCursor: number): void {
		for (let index = this.records.length - 1; index >= 0; index -= 1) {
			const record = this.records[index]!;
			if (record.hold !== hold) continue;
			if (record.deltaParts) {
				const remaining = record.deltaParts.filter((part) => part.cursor > snapshotCursor);
				if (remaining.length > 0) {
					const delta = record.event as DeltaEvent;
					const previousBytes = record.bytes;
					record.cursor = remaining.at(-1)!.cursor;
					record.event = {
						...delta,
						delta: { type: delta.delta.type, text: remaining.map((part) => part.text).join("") },
					};
					record.deltaParts = remaining;
					record.bytes = eventBytes(record.event);
					record.hold = undefined;
					this.unacknowledgedBytes += record.bytes - previousBytes;
					continue;
				}
			}
			if (record.cursor <= snapshotCursor) {
				this.unacknowledgedBytes -= record.bytes;
				this.records.splice(index, 1);
			} else {
				record.hold = undefined;
			}
		}
		this.schedulePump();
	}

	acknowledge(serverEpoch: string, cursor: number): number {
		if (serverEpoch !== this.serverEpoch) throw new AppServerError("SERVER_RESTARTED");
		if (cursor > this.lastSentCursor) throw new AppServerError("INVALID_PARAMS");
		this.acknowledgedCursor = Math.max(this.acknowledgedCursor, cursor);
		while (this.records[0]?.sent && this.records[0].cursor <= this.acknowledgedCursor) {
			this.unacknowledgedBytes -= this.records.shift()!.bytes;
		}
		return this.acknowledgedCursor;
	}

	getStats(): {
		readonly unacknowledgedBytes: number;
		readonly unacknowledgedEvents: number;
		readonly acknowledgedCursor: number;
		readonly lastSentCursor: number;
		readonly overloaded: boolean;
	} {
		return {
			unacknowledgedBytes: this.unacknowledgedBytes,
			unacknowledgedEvents: this.records.length,
			acknowledgedCursor: this.acknowledgedCursor,
			lastSentCursor: this.lastSentCursor,
			overloaded: this.terminal !== undefined,
		};
	}

	getTerminalError(): RpcErrorResponse | undefined {
		return this.terminal && structuredClone(this.terminal);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.records.length = 0;
		this.unacknowledgedBytes = 0;
		this.sender = undefined;
	}

	private overload(): void {
		if (this.terminal || this.closed) return;
		this.terminal = { jsonrpc: "2.0", id: null, error: createRpcError("OVERLOADED") };
		this.schedulePump();
	}

	private schedulePump(): void {
		if (this.pumpScheduled || this.pumping || this.closed) return;
		this.pumpScheduled = true;
		queueMicrotask(() => {
			this.pumpScheduled = false;
			void this.pump();
		});
	}

	private notifyTerminal(reason: "overloaded" | "delivery_failed"): void {
		if (this.terminalNotified) return;
		this.terminalNotified = true;
		this.onTerminal?.(reason);
	}

	private async pump(): Promise<void> {
		if (this.pumping || this.closed) return;
		const sender = this.sender;
		if (!sender) {
			if (this.terminal) this.notifyTerminal("overloaded");
			return;
		}
		this.pumping = true;
		try {
			if (this.terminal) {
				await sender(structuredClone(this.terminal));
				this.notifyTerminal("overloaded");
				return;
			}

			while (!this.closed && !this.terminal) {
				const start = this.records.findIndex((record) => !record.sent);
				if (start < 0) break;
				if (this.records[start]!.hold !== undefined) break;
				const batch = [this.records[start]!];
				for (let index = start + 1; index < this.records.length && batch.length < MAX_EVENT_BATCH; index += 1) {
					const candidate = this.records[index]!;
					if (candidate.sent || candidate.hold !== undefined || candidate.cursor !== batch.at(-1)!.cursor + 1)
						break;
					const proposed = [...batch, candidate];
					if (envelopeBytes(notification(this.serverEpoch, proposed)) > this.maxEnvelopeBytes) break;
					batch.push(candidate);
				}
				const envelope = notification(this.serverEpoch, batch);
				for (const record of batch) record.sent = true;
				this.lastSentCursor = batch.at(-1)!.cursor;
				await sender(envelope);
			}
			if (this.terminal) {
				await sender(structuredClone(this.terminal));
				this.notifyTerminal("overloaded");
			}
		} catch {
			this.notifyTerminal("delivery_failed");
		} finally {
			this.pumping = false;
			if (!this.closed && !this.terminalNotified && (this.terminal || this.records.some((record) => !record.sent))) {
				this.schedulePump();
			}
		}
	}
}
