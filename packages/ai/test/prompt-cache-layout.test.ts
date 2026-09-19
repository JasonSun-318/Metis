import { expect, it } from "vitest";
import { chooseCacheCandidates, digestCacheValue } from "../src/utils/prompt-cache-layout.ts";

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
