import { embeddingConfigKey, embedText, embedTexts, MEMORY_EMBED_DEFAULT_TIMEOUT_MS } from "./memory-embedder.ts";
import { MEMORY_RERANK_DEFAULT_TIMEOUT_MS, rerankDocuments } from "./memory-rerank.ts";
import type { EmbeddingSettings, RerankSettings } from "./memory-service-settings.ts";
import type { MemoryStore } from "./memory-store.ts";
import type { MemoryFact, MemoryScope, MemorySearchHit } from "./memory-types.ts";

export const MEMORY_RETRIEVE_TIMEOUT_MS = 2500;
export const MEMORY_RERANK_TIMEOUT_MS = MEMORY_RERANK_DEFAULT_TIMEOUT_MS;
export const MEMORY_RETRIEVE_CANDIDATE_LIMIT = 50;
export const MEMORY_RETRIEVE_TOP_K = 8;
export const MEMORY_RETRIEVE_MAX_CHARS = 2048;
export const MEMORY_COSINE_WEIGHT = 0.7;
export const MEMORY_KEYWORD_WEIGHT = 0.3;

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
	embedQuery?: (query: string) => Promise<Float32Array>;
	/** Test seam: reorder candidate ids after fusion. */
	rerank?: (query: string, docs: Array<{ id: string; text: string }>) => Promise<string[]>;
}

function tokenize(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(Boolean);
}

export function keywordScore(query: string, text: string): number {
	const queryTokens = new Set(tokenize(query));
	if (queryTokens.size === 0) return 0;
	const textTokens = new Set(tokenize(text));
	let overlap = 0;
	for (const token of queryTokens) {
		if (textTokens.has(token)) overlap++;
	}
	return overlap / queryTokens.size;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number | null {
	if (a.length !== b.length) return null;
	let dot = 0;
	let normA = 0;
	let normB = 0;
	for (let i = 0; i < a.length; i++) {
		const av = a[i] ?? 0;
		const bv = b[i] ?? 0;
		dot += av * bv;
		normA += av * av;
		normB += bv * bv;
	}
	if (normA === 0 || normB === 0) return null;
	return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function capByChars(hits: RetrievedMemoryFact[], maxChars: number): RetrievedMemoryFact[] {
	const kept: RetrievedMemoryFact[] = [];
	let used = 0;
	for (const hit of hits) {
		const size = hit.text.length + hit.scope.length + 8;
		if (kept.length > 0 && used + size > maxChars) break;
		kept.push(hit);
		used += size;
	}
	return kept;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
	const timeout = AbortSignal.timeout(timeoutMs);
	const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
	if (combined.aborted) {
		throw Object.assign(new Error("aborted"), { name: "AbortError" });
	}
	return await new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
		};
		combined.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				combined.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				combined.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
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
	const retrieveTimeoutMs = options.retrieveTimeoutMs ?? MEMORY_RETRIEVE_TIMEOUT_MS;
	return await withTimeout(searchMemoriesInner(options), retrieveTimeoutMs, options.signal);
}

async function searchMemoriesInner(options: SearchMemoriesOptions): Promise<RetrievedMemoryFact[]> {
	const facts: MemoryFact[] = [
		...options.store.listActiveFacts("global", null, null),
		...options.store.listActiveFacts("project", options.cwdKey, options.mode),
	];
	if (facts.length === 0) return [];

	let queryEmbedding: Float32Array | null = null;
	if (options.embedQuery) {
		queryEmbedding = await options.embedQuery(options.query);
	} else {
		queryEmbedding = await embedText(options.query, {
			settings: options.embeddingSettings,
			apiKey: options.embeddingApiKey,
			timeoutMs: options.retrieveTimeoutMs ?? MEMORY_EMBED_DEFAULT_TIMEOUT_MS,
			fetchFn: options.fetchFn,
			signal: options.signal,
		});
	}
	const embeddingKey = embeddingConfigKey(options.embeddingSettings);

	const scored: RetrievedMemoryFact[] = [];
	for (const fact of facts) {
		const keyword = keywordScore(options.query, fact.text);
		let cosine = 0;
		if (fact.embedding && fact.embeddingModel === embeddingKey && queryEmbedding) {
			cosine = cosineSimilarity(queryEmbedding, fact.embedding) ?? 0;
		}
		scored.push({
			id: fact.id,
			scope: fact.scope,
			text: fact.text,
			score: MEMORY_COSINE_WEIGHT * cosine + MEMORY_KEYWORD_WEIGHT * keyword,
		});
	}

	scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
	let candidates = scored.slice(0, MEMORY_RETRIEVE_CANDIDATE_LIMIT);

	if (options.rerankSettings && options.rerankApiKey && candidates.length > 1) {
		const docs = candidates.map((hit) => ({ id: hit.id, text: hit.text }));
		try {
			let orderedIds: string[];
			if (options.rerank) {
				orderedIds = await options.rerank(options.query, docs);
			} else {
				orderedIds = (
					await rerankDocuments({
						settings: options.rerankSettings,
						apiKey: options.rerankApiKey,
						query: options.query,
						documents: docs,
						timeoutMs: options.rerankTimeoutMs ?? MEMORY_RERANK_TIMEOUT_MS,
						fetchFn: options.fetchFn,
						signal: options.signal,
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
		} catch (error) {
			if (options.signal?.aborted) throw error;
		}
	}

	const top = candidates.slice(0, MEMORY_RETRIEVE_TOP_K).map(toRetrieved);
	return capByChars(top, MEMORY_RETRIEVE_MAX_CHARS);
}

export interface BackfillEmbeddingsOptions {
	store: MemoryStore;
	embeddingSettings: EmbeddingSettings;
	embeddingApiKey: string;
	limit?: number;
	fetchFn?: typeof fetch;
	signal?: AbortSignal;
}

/** Embed active facts with null or mismatched embeddings. Best-effort; never throws to callers that void it. */
export async function backfillMemoryEmbeddings(options: BackfillEmbeddingsOptions): Promise<number> {
	const limit = options.limit ?? 32;
	const embeddingKey = embeddingConfigKey(options.embeddingSettings);
	const needing = options.store.listFactsNeedingEmbedding(embeddingKey, limit);
	if (needing.length === 0) return 0;

	const vectors = await embedTexts(
		needing.map((fact) => fact.text),
		{
			settings: options.embeddingSettings,
			apiKey: options.embeddingApiKey,
			fetchFn: options.fetchFn,
			signal: options.signal,
			timeoutMs: MEMORY_EMBED_DEFAULT_TIMEOUT_MS * Math.min(4, needing.length),
		},
	);

	let updated = 0;
	for (let i = 0; i < needing.length; i++) {
		const fact = needing[i]!;
		const vector = vectors[i];
		if (!vector) continue;
		options.store.updateFactEmbedding(fact.id, vector, embeddingKey);
		updated++;
	}
	return updated;
}
