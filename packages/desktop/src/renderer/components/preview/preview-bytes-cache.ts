export const PREVIEW_CACHE_MAX_BYTES = 80 * 1024 * 1024;

export type PreviewCacheKey = string;

export function previewCacheKey(
	target:
		| {
				readonly source: "delivered";
				readonly sessionId: string;
				readonly rootSessionId?: string;
				readonly fileId: string;
		  }
		| { readonly source: "workspace"; readonly sessionId: string; readonly relativePath: string },
): PreviewCacheKey {
	return target.source === "delivered"
		? `delivered:${target.rootSessionId ? `${target.rootSessionId}:` : ""}${target.sessionId}:${target.fileId}`
		: `workspace:${target.sessionId}:${target.relativePath}`;
}

export class PreviewBytesCache {
	private readonly entries = new Map<PreviewCacheKey, Uint8Array>();
	private bytes = 0;
	private readonly maxBytes: number;

	constructor(maxBytes: number = PREVIEW_CACHE_MAX_BYTES) {
		this.maxBytes = maxBytes;
	}

	get(key: PreviewCacheKey): Uint8Array | undefined {
		const value = this.entries.get(key);
		if (!value) return undefined;
		this.entries.delete(key);
		this.entries.set(key, value);
		return value;
	}

	set(key: PreviewCacheKey, value: Uint8Array): void {
		const previous = this.entries.get(key);
		if (previous) {
			this.bytes -= previous.byteLength;
			this.entries.delete(key);
		}
		if (value.byteLength > this.maxBytes) return;
		while (this.bytes + value.byteLength > this.maxBytes && this.entries.size > 0) {
			const oldest = this.entries.keys().next().value as PreviewCacheKey | undefined;
			if (oldest === undefined) break;
			const evicted = this.entries.get(oldest);
			this.entries.delete(oldest);
			if (evicted) this.bytes -= evicted.byteLength;
		}
		this.entries.set(key, value);
		this.bytes += value.byteLength;
	}

	deleteSession(sessionId: string): void {
		for (const key of [...this.entries.keys()]) {
			if (!key.includes(`:${sessionId}:`)) continue;
			const value = this.entries.get(key);
			this.entries.delete(key);
			if (value) this.bytes -= value.byteLength;
		}
	}

	clear(): void {
		this.entries.clear();
		this.bytes = 0;
	}
}

export const previewBytesCache = new PreviewBytesCache();
