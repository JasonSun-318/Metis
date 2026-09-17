import { EventEmitter } from "node:events";
import type { ChangelogEntry } from "./vault-history.ts";

export interface MemoryChangedEvent {
	entry: ChangelogEntry;
}

/** Emitted when a background dream run finishes consolidating the vault. */
export interface MemoryDreamCompletedEvent {
	runId: string;
	added: number;
	updated: number;
	deleted: number;
}

interface MemoryEventPayloads {
	changed: MemoryChangedEvent;
	dreamCompleted: MemoryDreamCompletedEvent;
}

/** Vault-level typed emitter; sessions and the memory service subscribe to "changed". */
export class MemoryEvents {
	private readonly emitter = new EventEmitter();

	on<K extends keyof MemoryEventPayloads>(event: K, fn: (payload: MemoryEventPayloads[K]) => void): () => void {
		this.emitter.on(event, fn);
		return () => {
			this.emitter.off(event, fn);
		};
	}

	emit<K extends keyof MemoryEventPayloads>(event: K, payload: MemoryEventPayloads[K]): void {
		this.emitter.emit(event, payload);
	}
}
