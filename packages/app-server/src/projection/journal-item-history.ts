import type { ItemView } from "@metis/app-protocol";
import { opaqueId } from "../item-projection.ts";

export interface SessionItemHistory {
	readonly itemIds: readonly string[];
	readItem(itemId: string): ItemView | undefined;
	toolCallItemIds(actionId: string): readonly string[];
}

interface CachedItem {
	readonly owner: object;
	readonly itemId: string;
	readonly item: ItemView | undefined;
	readonly bytes: number;
}

/** Host-wide LRU for reconstructible display rows, independent of runtime services. */
export class ProjectedItemCache {
	private readonly owners = new Map<object, Map<string, CachedItem>>();
	private readonly recent = new Set<CachedItem>();
	private readonly maxBytes: number;
	private readonly maxEntries: number;
	private bytes = 0;

	constructor(options: { maxBytes?: number; maxEntries?: number } = {}) {
		this.maxBytes = options.maxBytes ?? 16 * 1024 * 1024;
		this.maxEntries = options.maxEntries ?? 2_048;
		if (
			!Number.isSafeInteger(this.maxBytes) ||
			this.maxBytes < 1 ||
			!Number.isSafeInteger(this.maxEntries) ||
			this.maxEntries < 1
		) {
			throw new TypeError("History cache limits must be positive safe integers");
		}
	}

	read(owner: object, itemId: string, project: () => ItemView | undefined): ItemView | undefined {
		const cached = this.owners.get(owner)?.get(itemId);
		if (cached) {
			this.recent.delete(cached);
			this.recent.add(cached);
			return cached.item;
		}
		const item = project();
		const bytes = Buffer.byteLength(JSON.stringify(item ?? null), "utf8") + Buffer.byteLength(itemId, "utf8") + 128;
		if (bytes > this.maxBytes) return item;
		const entry: CachedItem = { owner, itemId, item, bytes };
		let bucket = this.owners.get(owner);
		if (!bucket) {
			bucket = new Map();
			this.owners.set(owner, bucket);
		}
		bucket.set(itemId, entry);
		this.recent.add(entry);
		this.bytes += bytes;
		while (this.bytes > this.maxBytes || this.recent.size > this.maxEntries) {
			const oldest = this.recent.values().next().value!;
			this.recent.delete(oldest);
			const oldestBucket = this.owners.get(oldest.owner)!;
			oldestBucket.delete(oldest.itemId);
			if (oldestBucket.size === 0) this.owners.delete(oldest.owner);
			this.bytes -= oldest.bytes;
		}
		return item;
	}
}

/** Index identities eagerly; project content only when a history page needs it. */
export class JournalItemHistory implements SessionItemHistory {
	readonly itemIds: readonly string[];
	private readonly records = new Map<string, Record<string, unknown> | number>();
	private readonly readRecord?: (index: number) => Record<string, unknown>;
	private readonly toolItems = new Map<string, Set<string>>();
	private readonly owner = {};
	private readonly project: (entry: Record<string, unknown>) => ItemView | undefined;
	private readonly cache: ProjectedItemCache;

	constructor(
		journal: readonly unknown[],
		project: (entry: Record<string, unknown>) => ItemView | undefined,
		cache: ProjectedItemCache,
		readRecord?: (index: number) => Record<string, unknown>,
	) {
		this.project = project;
		this.cache = cache;
		this.readRecord = readRecord;
		for (let index = 0; index < journal.length; index++) {
			const entry = journal[index];
			if (typeof entry !== "object" || entry === null) continue;
			const record = entry as Record<string, unknown>;
			if (record.type === "session" || typeof record.id !== "string") continue;
			// Mailbox rows share the event identity used by live receipt updates.
			const itemId =
				record.type === "agent_mailbox_event"
					? opaqueId((record.event as { eventId: string }).eventId, "agent-event")
					: opaqueId(record.id, "item");
			this.records.set(itemId, readRecord ? index : record);
			if (record.type !== "message" || typeof record.message !== "object" || record.message === null) continue;
			const message = record.message as Record<string, unknown>;
			if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
				const actionId = opaqueId(block.id, "tool");
				let items = this.toolItems.get(actionId);
				if (!items) {
					items = new Set();
					this.toolItems.set(actionId, items);
				}
				items.add(itemId);
			}
		}
		this.itemIds = [...this.records.keys()];
	}

	readItem(itemId: string): ItemView | undefined {
		const record = this.records.get(itemId);
		return record === undefined
			? undefined
			: this.cache.read(this.owner, itemId, () =>
					this.project(typeof record === "number" ? this.readRecord!(record) : record),
				);
	}

	toolCallItemIds(actionId: string): readonly string[] {
		return [...(this.toolItems.get(actionId) ?? [])];
	}
}
