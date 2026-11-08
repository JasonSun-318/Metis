import type { SessionJournal } from "./session-journal.ts";
import type { FileEntry, SessionMessageEntry } from "./session-manager.ts";

function freezeRecord<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value)) freezeRecord(child);
	return Object.freeze(value);
}

/** Image-bearing records stay eager to preserve the chronological, session-wide hydration budget. */
export function hasSessionImages(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (record.type === "image" || record.type === "image_ref") return true;
	return Object.values(record).some(hasSessionImages);
}

const identityFields = new Set(["type", "id", "parentId", "timestamp", "turnId", "agentMessageId"]);
const messageIdentityFields = new Set([
	"role",
	"toolCallId",
	"isError",
	"toolName",
	"provider",
	"model",
	"timestamp",
	"stopReason",
	"usage",
]);
const readMessage = Symbol("readSessionMessage");
const toolCallCount = Symbol("sessionToolCallCount");

export function sessionToolCallCount(entry: SessionMessageEntry): number {
	const cached = Reflect.get(entry, toolCallCount) as number | undefined;
	if (cached !== undefined) return cached;
	if (entry.message.role !== "assistant") return 0;
	const content = entry.message.content;
	return Array.isArray(content) ? content.filter((part) => part.type === "toolCall").length : 0;
}

export function resolveSessionMessage(entry: SessionMessageEntry): SessionMessageEntry["message"] {
	const resolve = Reflect.get(entry, readMessage) as (() => SessionMessageEntry["message"]) | undefined;
	return resolve ? resolve() : entry.message;
}

/** Owns disk-backed message bodies; tree identities and small control records stay resident. */
export class IndexedSessionRecords {
	private seed?: readonly FileEntry[];
	private readonly journal: SessionJournal<FileEntry>;
	private readonly messageIds: WeakMap<object, string>;
	private readonly weak = new Map<number, WeakRef<FileEntry>>();
	private readonly recent = new Map<number, { entry: FileEntry; bytes: number }>();
	private bytes = 0;

	constructor(records: readonly FileEntry[], journal: SessionJournal<FileEntry>, messageIds: WeakMap<object, string>) {
		this.seed = records;
		this.journal = journal;
		this.messageIds = messageIds;
	}

	releaseReadCache(): void {
		const seed = this.seed;
		this.seed = undefined;
		this.recent.clear();
		this.bytes = 0;
		// Keep the first visible history page warm without retaining the strict scan.
		if (seed)
			for (let index = Math.max(0, seed.length - 256); index < seed.length; index++) {
				this.remember(index, freezeRecord(seed[index]));
			}
	}

	read(index: number): FileEntry {
		// Initialization already holds the strict scan. Avoid serializing every body
		// again merely to populate a cache that is released when opening completes.
		if (this.seed?.[index]) {
			const entry = freezeRecord(this.seed[index]);
			if (entry.type === "message") this.messageIds.set(entry.message, entry.id);
			return entry;
		}
		const strong = this.recent.get(index);
		if (strong) {
			this.recent.delete(index);
			this.recent.set(index, strong);
			return strong.entry;
		}
		const entry = this.weak.get(index)?.deref() ?? freezeRecord(this.journal.readRecord(index));
		this.remember(index, entry);
		return entry;
	}

	private remember(index: number, entry: FileEntry): void {
		this.weak.set(index, new WeakRef(entry));
		if (entry.type === "message") this.messageIds.set(entry.message, entry.id);
		const bytes = Buffer.byteLength(JSON.stringify(entry), "utf8");
		if (bytes <= 2 * 1024 * 1024) {
			this.recent.set(index, { entry, bytes });
			this.bytes += bytes;
			while (this.bytes > 2 * 1024 * 1024 || this.recent.size > 256) {
				const [oldest, cached] = this.recent.entries().next().value!;
				this.recent.delete(oldest);
				this.bytes -= cached.bytes;
			}
		}
	}

	/** Descriptors retain no historical body. Metadata can filter by role without reading it. */
	describe(entry: FileEntry, index: number, transcript = false): FileEntry {
		if (entry.type !== "message" || hasSessionImages(entry)) return entry;
		const descriptor: Record<string, unknown> = {};
		const read = () => this.read(index) as SessionMessageEntry;
		for (const [key, value] of Object.entries(entry)) {
			if (identityFields.has(key)) descriptor[key] = value;
			else if (key === "message") {
				const message: Record<string, unknown> = {};
				for (const field of Object.keys(entry.message)) {
					if (messageIdentityFields.has(field)) message[field] = freezeRecord(Reflect.get(entry.message, field));
					else
						Object.defineProperty(message, field, {
							enumerable: true,
							get: () => Reflect.get(read().message, field),
						});
				}
				descriptor.message = Object.freeze(message);
				if (transcript) this.messageIds.set(message, entry.id);
			} else Object.defineProperty(descriptor, key, { enumerable: true, get: () => Reflect.get(read(), key) });
		}
		if (transcript) Object.defineProperty(descriptor, readMessage, { value: () => read().message });
		if (entry.message.role === "assistant")
			Object.defineProperty(descriptor, toolCallCount, {
				value: sessionToolCallCount(entry),
			});
		return Object.freeze(descriptor) as unknown as FileEntry;
	}
}
