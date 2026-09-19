import type { PromptCacheBoundary, PromptCacheCheckpoint, PromptCacheObservation } from "../types.ts";

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

// Exact serialized keys detect in-place hook changes too. Both bounds are
// process-local; no prompt data is persisted or exposed in diagnostics.
const digestMemo = new Map<string, { serialized: string; digest: string | Promise<string> }>();
const MAX_DIGEST_CHARS = 4 * 1024 * 1024;
const MAX_DIGEST_ENTRIES = 2048;
let digestChars = 0;
const encoder = new TextEncoder();

function memoizedDigest(key: string, serialized: string, serialize: () => string): string | Promise<string> {
	const cached = digestMemo.get(key);
	if (cached?.serialized === serialized) {
		digestMemo.delete(key);
		digestMemo.set(key, cached);
		return cached.digest;
	}
	if (cached) {
		digestChars -= key.length + cached.serialized.length;
		digestMemo.delete(key);
	}
	const retainedChars = key.length + serialized.length;
	const entry: { serialized: string; digest: string | Promise<string> } = { serialized, digest: "" };
	const result = globalThis.crypto.subtle.digest("SHA-256", encoder.encode(serialize())).then((digest) => {
		const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
		entry.digest = hex;
		return hex;
	});
	entry.digest = result;
	if (retainedChars <= MAX_DIGEST_CHARS) {
		while (digestMemo.size >= MAX_DIGEST_ENTRIES || digestChars + retainedChars > MAX_DIGEST_CHARS) {
			const oldest = digestMemo.keys().next().value!;
			digestChars -= oldest.length + digestMemo.get(oldest)!.serialized.length;
			digestMemo.delete(oldest);
		}
		digestMemo.set(key, entry);
		digestChars += retainedChars;
		void result.catch(() => {
			if (digestMemo.get(key)?.digest === result) {
				digestMemo.delete(key);
				digestChars -= retainedChars;
			}
		});
	}
	return result;
}

export function digestCacheValue(value: unknown): Promise<string> {
	const json = JSON.stringify(value);
	if (json === undefined) return Promise.reject(new TypeError("Cache digest requires a JSON value"));
	return Promise.resolve(memoizedDigest(`value:${json}`, json, () => json));
}

/** Preserve the persisted chain algorithm without re-escaping long unchanged frames. */
export function digestCacheFrame(previous: string, frameJson: string): string | Promise<string> {
	return memoizedDigest(`frame:${previous}`, frameJson, () => JSON.stringify([previous, frameJson]));
}

/** Shared checkpoint selection; adapters retain ownership of protocol markers. */
export function selectCacheLayout<T extends CacheCandidate & { bytes: number }>(
	candidates: readonly T[],
	previous: PromptCacheCheckpoint | undefined,
	model: { provider: string; id: string },
	settingsDigest: string,
	stableBytes: number,
): { chosen: T[]; observation: PromptCacheObservation } {
	const changed =
		previous !== undefined &&
		(previous.provider !== model.provider ||
			previous.model !== model.id ||
			previous.settingsDigest !== settingsDigest);
	const boundary = changed ? undefined : previous?.historyBoundary;
	const chosen = chooseCacheCandidates(candidates, boundary, 2) as T[];
	const reused = reusableCandidate(candidates, boundary) as T | undefined;
	const newest = chosen.at(-1);
	return {
		chosen,
		observation: {
			checkpoint: newest
				? {
						version: 1,
						provider: model.provider,
						model: model.id,
						settingsDigest,
						historyBoundary: {
							originId: newest.originId,
							ordinal: newest.ordinal,
							prefixDigest: newest.prefixDigest,
						},
					}
				: undefined,
			reason: !previous
				? "append"
				: changed
					? "settings-change"
					: reused
						? newest !== reused
							? "append"
							: "suffix"
						: "history-change",
			reusableInputBytes: reused?.bytes ?? 0,
			stableInputBytes: stableBytes,
		},
	};
}
