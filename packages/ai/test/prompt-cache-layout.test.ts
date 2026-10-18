import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { chooseCacheCandidates, digestCacheFrame, digestCacheValue } from "../src/utils/prompt-cache-layout.ts";
import { createCachePrefix } from "../src/utils/prompt-cache-prefix.ts";

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

it("chains cache prefixes with the persisted framing and UTF-8 byte accounting", async () => {
	const seed = "b".repeat(64);
	const frame = { text: "多字节 😀", nested: ["value", 1] };
	const frameJson = JSON.stringify(frame);
	const bytes = Buffer.byteLength(frameJson, "utf8");
	const prefix = createCachePrefix(seed, 7);
	expect(prefix.digest).toBe(seed);
	expect(prefix.bytes).toBe(7);

	const pending = prefix.extend(frame);
	expect(pending).toBeInstanceOf(Promise);
	// Byte accounting happens before the digest promise resolves.
	expect(prefix.digest).toBe(seed);
	expect(prefix.bytes).toBe(7 + bytes);
	await pending;
	expect(prefix.digest).toBe(
		createHash("sha256")
			.update(JSON.stringify([seed, frameJson]))
			.digest("hex"),
	);
	expect(prefix.bytes).toBe(7 + bytes);
	expect(bytes).toBeGreaterThan(frameJson.length);
});

it("advances synchronously once the frame digest is memoized", async () => {
	const seed = "c".repeat(64);
	const frame = { text: "warm 😀 cache prefix" };
	const cold = createCachePrefix(seed, 11);
	await cold.extend(frame);

	const warm = createCachePrefix(seed, 11);
	expect(warm.extend(frame)).toBeUndefined();
	expect(warm.digest).toBe(cold.digest);
	expect(warm.bytes).toBe(11 + Buffer.byteLength(JSON.stringify(frame), "utf8"));
});

it("supports validation-only prefixes without byte accounting", async () => {
	const seed = "d".repeat(64);
	const frame = { text: "validation only 😀" };
	const prefix = createCachePrefix(seed);
	expect(prefix.bytes).toBeUndefined();
	await prefix.extend(frame);
	expect(prefix.bytes).toBeUndefined();
	const frameJson = JSON.stringify(frame);
	expect(prefix.digest).toBe(
		createHash("sha256")
			.update(JSON.stringify([seed, frameJson]))
			.digest("hex"),
	);
});

it("propagates digest rejection without advancing the digest", async () => {
	const seed = "e".repeat(64);
	const frame = { text: "rejected 😀 frame" };
	const prefix = createCachePrefix(seed, 3);
	const spy = vi.spyOn(globalThis.crypto.subtle, "digest").mockRejectedValueOnce(new Error("digest unavailable"));
	try {
		const pending = prefix.extend(frame);
		expect(pending).toBeInstanceOf(Promise);
		expect(prefix.digest).toBe(seed);
		expect(prefix.bytes).toBe(3 + Buffer.byteLength(JSON.stringify(frame), "utf8"));
		await expect(pending).rejects.toThrow("digest unavailable");
		expect(prefix.digest).toBe(seed);
	} finally {
		spy.mockRestore();
	}
});
