import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { chooseCacheCandidates, digestCacheFrame, digestCacheValue } from "../src/utils/prompt-cache-layout.ts";

it("retains a previously written endpoint across long append-only growth", () => {
	const old = { originId: "entry:a", ordinal: 0, prefixDigest: "a", index: 1 };
	const end = { originId: "entry:z", ordinal: 0, prefixDigest: "z", index: 40 };
	expect(chooseCacheCandidates([old, end], old, 2)).toEqual([old, end]);
	expect(chooseCacheCandidates([old, end], old, 1)).toEqual([old]);
	expect(chooseCacheCandidates([old, end], old, 0)).toEqual([]);
	expect(chooseCacheCandidates([old], old, 2)).toEqual([old]);
	expect(chooseCacheCandidates([{ ...old, prefixDigest: "changed" }, end], old, 2)).toEqual([end]);
});

it("digests exact ordered content without ignoring significant whitespace", async () => {
	expect(await digestCacheValue(["a", "b"])).toBe(await digestCacheValue(["a", "b"]));
	expect(await digestCacheValue(["a", "b"])).not.toBe(await digestCacheValue(["b", "a"]));
	expect(await digestCacheValue("a")).not.toBe(await digestCacheValue("a "));
});

it("memoizes exact serialized digests but detects in-place mutations", async () => {
	const spy = vi.spyOn(globalThis.crypto.subtle, "digest");
	try {
		const frame = { text: "cache regression unique content", nested: { value: 1 } };
		const first = await digestCacheValue(frame);
		const count = spy.mock.calls.length;
		expect(await digestCacheValue(structuredClone(frame))).toBe(first);
		expect(spy.mock.calls.length).toBe(count);
		frame.nested.value = 2;
		expect(await digestCacheValue(frame)).toBe(createHash("sha256").update(JSON.stringify(frame)).digest("hex"));
		expect(await digestCacheValue(frame)).not.toBe(first);
	} finally {
		spy.mockRestore();
	}
});

it("preserves persisted chain hashes and never reuses a different frame at the same prefix", async () => {
	const prefix = "a".repeat(64);
	for (const frame of ["first", "changed", "first"]) {
		const json = JSON.stringify({ text: frame });
		expect(await digestCacheFrame(prefix, json)).toBe(
			createHash("sha256")
				.update(JSON.stringify([prefix, json]))
				.digest("hex"),
		);
	}
});
