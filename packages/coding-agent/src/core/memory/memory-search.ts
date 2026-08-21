import { randomUUID } from "node:crypto";
import { embeddingConfigKey, embedText, embedTexts, MEMORY_EMBED_DEFAULT_TIMEOUT_MS } from "./memory-embedder.ts";
import { MEMORY_RERANK_DEFAULT_TIMEOUT_MS, rerankDocuments } from "./memory-rerank.ts";
import type { EmbeddingSettings, RerankSettings } from "./memory-service-settings.ts";
import type { MemoryStore } from "./memory-store.ts";
import { type MemoryScope, type MemorySearchHit, memoryHealth, memoryHealthError } from "./memory-types.ts";

export const MEMORY_RETRIEVE_TIMEOUT_MS = 2500;
export const MEMORY_RERANK_TIMEOUT_MS = MEMORY_RERANK_DEFAULT_TIMEOUT_MS;
export const MEMORY_RETRIEVE_CANDIDATE_LIMIT = 50;
export const MEMORY_RETRIEVE_TOP_K = 8;
export const MEMORY_RETRIEVE_MAX_CHARS = 2048;
export const MEMORY_COSINE_WEIGHT = 0.7;
export const MEMORY_KEYWORD_WEIGHT = 0.3;
const MEMORY_BACKFILL_LEASE_MS = 90_000;

export interface RetrievedMemoryFact {
	id: string;
	scope: MemoryScope;
	text: string;
	score: number;
}

export interface SearchMemoriesOptions {
	store: MemoryStore;
	query: string;
	cwdKey: string;
	mode: string | null;
	embeddingSettings: EmbeddingSettings;
	embeddingApiKey: string;
	rerankSettings?: RerankSettings;
	rerankApiKey?: string;
	retrieveTimeoutMs?: number;
	rerankTimeoutMs?: number;
	fetchFn?: typeof fetch;
	signal?: AbortSignal;
	/** Test seam: supply query embedding without HTTP. */
	embedQuery?: (query: string, signal: AbortSignal) => Promise<Float32Array>;
	/** Test seam: reorder candidate ids after fusion. */
	rerank?: (query: string, docs: Array<{ id: string; text: string }>, signal: AbortSignal) => Promise<string[]>;
}

export { keywordScore } from "./memory-store.ts";

export function capRetrievedFacts(
	hits: RetrievedMemoryFact[],
	maxHits = MEMORY_RETRIEVE_TOP_K,
	maxChars = MEMORY_RETRIEVE_MAX_CHARS,
): RetrievedMemoryFact[] {
	const kept: RetrievedMemoryFact[] = [];
	let used = 0;
	for (const hit of hits) {
		if (kept.length >= maxHits || used >= maxChars) break;
		const remaining = maxChars - used;
		const chars = Array.from(hit.text);
		const text =
			chars.length <= remaining ? hit.text : remaining === 1 ? "…" : `${chars.slice(0, remaining - 1).join("")}…`;
		kept.push(text === hit.text ? hit : { ...hit, text });
		used += Array.from(text).length;
	}
	return kept;
}

function toRetrieved(hit: MemorySearchHit | RetrievedMemoryFact): RetrievedMemoryFact {
	return {
		id: hit.id,
		scope: hit.scope,
		text: hit.text,
		score: hit.score,
	};
}

export async function searchMemories(options: SearchMemoriesOptions): Promise<RetrievedMemoryFact[]> {
	const query = takeLastUnicodeCharacters(options.query, 8_000);
	const timeout = AbortSignal.timeout(options.retrieveTimeoutMs ?? MEMORY_RETRIEVE_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const embeddingKey = embeddingConfigKey(options.embeddingSettings);
	let queryEmbedding: Float32Array | null = null;
	try {
		queryEmbedding = options.embedQuery
			? await options.embedQuery(query, signal)
			: await embedText(query, {
					settings: options.embeddingSettings,
					apiKey: options.embeddingApiKey,
					timeoutMs: MEMORY_EMBED_DEFAULT_TIMEOUT_MS,
					fetchFn: options.fetchFn,
					signal,
				});
		options.store.recordHealth(memoryHealth("embedding", "ok"));
	} catch (error) {
		throwIfCallerAborted(options.signal);
		options.store.recordHealth(memoryHealthError("embedding", error, [options.embeddingApiKey]));
	}
	let candidates = options.store
		.searchRelevantFacts(queryEmbedding, {
			queryText: query,
			embeddingKey,
			projectKey: options.cwdKey,
			limit: MEMORY_RETRIEVE_CANDIDATE_LIMIT,
		})
		.hits.map(toRetrieved);

	if (options.rerankSettings && options.rerankApiKey && candidates.length > 1 && !signal.aborted) {
		const docs = candidates.map((hit) => ({ id: hit.id, text: hit.text }));
		try {
			let orderedIds: string[];
			if (options.rerank) {
				orderedIds = await options.rerank(query, docs, signal);
			} else {
				orderedIds = (
					await rerankDocuments({
						settings: options.rerankSettings,
						apiKey: options.rerankApiKey,
						query,
						documents: docs,
						timeoutMs: options.rerankTimeoutMs ?? MEMORY_RERANK_TIMEOUT_MS,
						fetchFn: options.fetchFn,
						signal,
					})
				).map((score) => score.id);
			}
			const byId = new Map(candidates.map((hit) => [hit.id, hit]));
			const reranked: RetrievedMemoryFact[] = [];
			for (const id of orderedIds) {
				const hit = byId.get(id);
				if (hit) {
					reranked.push(hit);
					byId.delete(id);
				}
			}
			for (const hit of byId.values()) reranked.push(hit);
			candidates = reranked;
			options.store.recordHealth(memoryHealth("rerank", "ok"));
		} catch (error) {
			throwIfCallerAborted(options.signal);
			options.store.recordHealth(memoryHealthError("rerank", error, [options.rerankApiKey]));
		}
	}

	return capRetrievedFacts(candidates);
}

export interface BackfillEmbeddingsOptions {
	store: MemoryStore;
	embeddingSettings: EmbeddingSettings;
	embeddingApiKey: string;
	limit?: number;
	fetchFn?: typeof fetch;
	signal?: AbortSignal;
	/** Test seam: supply vectors without HTTP. */
	embedTexts?: (texts: string[], signal: AbortSignal) => Promise<Float32Array[]>;
}

export async function backfillMemoryEmbeddings(options: BackfillEmbeddingsOptions): Promise<number> {
	const embeddingKey = embeddingConfigKey(options.embeddingSettings);
	const ownerId = randomUUID();
	if (!options.store.tryAcquireBackfillLease(ownerId, embeddingKey, Date.now(), MEMORY_BACKFILL_LEASE_MS)) return 0;
	const signal = options.signal ?? new AbortController().signal;
	const batchSize = Math.min(32, Math.max(1, options.limit ?? 32));
	let total = 0;
	options.store.recordHealth(memoryHealth("backfill", "running"));
	try {
		while (true) {
			signal.throwIfAborted();
			const facts = options.store.listFactsNeedingEmbedding(embeddingKey, batchSize);
			if (facts.length === 0) break;
			const texts = facts.map((fact) => Array.from(fact.text).slice(0, 8_000).join(""));
			const vectors = options.embedTexts
				? await options.embedTexts(texts, signal)
				: await embedTexts(texts, {
						settings: options.embeddingSettings,
						apiKey: options.embeddingApiKey,
						fetchFn: options.fetchFn,
						signal,
						timeoutMs: MEMORY_EMBED_DEFAULT_TIMEOUT_MS,
					});
			if (vectors.length !== facts.length) throw new Error("Embedding batch size mismatch");
			const committed = options.store.commitBackfillBatch({
				ownerId,
				embeddingKey,
				facts: facts.map((fact, index) => ({ id: fact.id, vector: vectors[index]! })),
				nowMs: Date.now(),
				leaseMs: MEMORY_BACKFILL_LEASE_MS,
			});
			if (committed < 0) throw new Error("Memory backfill lease was lost");
			total += committed;
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
		options.store.recordHealth(memoryHealth("backfill", "ok"));
		return total;
	} catch (error) {
		if (signal.aborted) {
			if (signal.reason !== "settings-refresh") {
				options.store.recordHealth(
					memoryHealthError("backfill", new Error("Backfill interrupted; it will retry on next memory use"), []),
				);
			}
			return total;
		}
		options.store.recordHealth(memoryHealthError("backfill", error, [options.embeddingApiKey]));
		throw error;
	} finally {
		options.store.releaseBackfillLease(ownerId);
	}
}

function throwIfCallerAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
}

function takeLastUnicodeCharacters(text: string, limit: number): string {
	let start = text.length;
	let count = 0;
	while (start > 0 && count < limit) {
		start--;
		const unit = text.charCodeAt(start);
		if (unit >= 0xdc00 && unit <= 0xdfff && start > 0) {
			const previous = text.charCodeAt(start - 1);
			if (previous >= 0xd800 && previous <= 0xdbff) start--;
		}
		count++;
	}
	return text.slice(start);
}
