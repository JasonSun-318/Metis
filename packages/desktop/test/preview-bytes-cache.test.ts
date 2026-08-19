import { describe, expect, it } from "vitest";
import { PreviewBytesCache, previewCacheKey } from "../src/renderer/components/preview/preview-bytes-cache.ts";

describe("PreviewBytesCache", () => {
	it("returns the same buffer for a cache hit", () => {
		const cache = new PreviewBytesCache(32);
		const key = previewCacheKey({ source: "delivered", sessionId: "s", fileId: "aaaaaaaaaaaaaaaa" });
		const bytes = new Uint8Array([1, 2, 3]);
		cache.set(key, bytes);
		expect(cache.get(key)).toBe(bytes);
	});

	it("evicts oldest entries when over the byte budget", () => {
		const cache = new PreviewBytesCache(8);
		cache.set("a", new Uint8Array(6));
		cache.set("b", new Uint8Array(4));
		expect(cache.get("a")).toBeUndefined();
		expect(cache.get("b")?.byteLength).toBe(4);
	});

	it("can drop one session without touching others", () => {
		const cache = new PreviewBytesCache(64);
		cache.set(previewCacheKey({ source: "workspace", sessionId: "one", relativePath: "a.pdf" }), new Uint8Array(2));
		cache.set(previewCacheKey({ source: "workspace", sessionId: "two", relativePath: "b.pdf" }), new Uint8Array(2));
		cache.deleteSession("one");
		expect(
			cache.get(previewCacheKey({ source: "workspace", sessionId: "one", relativePath: "a.pdf" })),
		).toBeUndefined();
		expect(
			cache.get(previewCacheKey({ source: "workspace", sessionId: "two", relativePath: "b.pdf" }))?.byteLength,
		).toBe(2);
	});
});
