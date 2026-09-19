import type { PromptCacheBoundary } from "../types.ts";

/**
 * A markable position in a provider payload, identified by its originating
 * history entry, markable-block ordinal, and the digest of the request prefix
 * that precedes it. `index` is the candidate's position in the adapter's
 * private list of markable blocks.
 */
export interface CacheCandidate extends PromptCacheBoundary {
	index: number;
}

export function reusableCandidate(
	candidates: readonly CacheCandidate[],
	previous: PromptCacheBoundary | undefined,
): CacheCandidate | undefined {
	if (!previous) return undefined;
	return candidates.find(
		(c) =>
			c.originId === previous.originId && c.ordinal === previous.ordinal && c.prefixDigest === previous.prefixDigest,
	);
}

export function chooseCacheCandidates(
	candidates: readonly CacheCandidate[],
	previous: PromptCacheBoundary | undefined,
	slots: number,
): CacheCandidate[] {
	if (!Number.isInteger(slots) || slots < 1 || candidates.length === 0) return [];
	const end = candidates[candidates.length - 1]!;
	const old = reusableCandidate(candidates, previous);
	if (!old || old.index === end.index) return [end];
	return slots === 1 ? [old] : [old, end];
}

export async function digestCacheValue(value: unknown): Promise<string> {
	const json = JSON.stringify(value);
	if (json === undefined) throw new TypeError("Cache digest requires a JSON value");
	const bytes = new TextEncoder().encode(json);
	const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
