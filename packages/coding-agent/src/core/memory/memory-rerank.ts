import type { ModelRegistry } from "../model-registry.ts";
import { parseProviderModelRef } from "./memory-embedder.ts";

export const MEMORY_RERANK_DEFAULT_TIMEOUT_MS = 1500;

export interface RerankDocument {
	id: string;
	text: string;
}

export interface RerankOptions {
	modelRegistry: ModelRegistry;
	modelRef: string;
	query: string;
	documents: RerankDocument[];
	timeoutMs?: number;
	fetchFn?: typeof fetch;
	signal?: AbortSignal;
}

function isAbortError(error: unknown): boolean {
	return (
		(error instanceof Error && error.name === "AbortError") ||
		(typeof error === "object" &&
			error !== null &&
			"name" in error &&
			(error as { name: string }).name === "AbortError")
	);
}

/**
 * Optional OpenAI/Cohere-style rerank. On timeout or failure, returns the original document ids.
 */
export async function rerankDocuments(options: RerankOptions): Promise<string[]> {
	const originalIds = options.documents.map((doc) => doc.id);
	if (options.documents.length <= 1) return originalIds;

	try {
		const { provider, modelId } = parseProviderModelRef(options.modelRef);
		const model =
			options.modelRegistry.find(provider, modelId) ??
			options.modelRegistry.getAll().find((entry) => entry.provider === provider);
		if (!model?.baseUrl) return originalIds;

		const auth = await options.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok) return originalIds;

		const timeoutMs = options.timeoutMs ?? MEMORY_RERANK_DEFAULT_TIMEOUT_MS;
		const timeout = AbortSignal.timeout(timeoutMs);
		const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
		const fetchFn = options.fetchFn ?? globalThis.fetch;
		const baseUrl = model.baseUrl.replace(/\/+$/, "");
		const headers: Record<string, string> = {
			"content-type": "application/json",
			...(auth.headers ?? {}),
		};
		if (auth.apiKey && !headers.Authorization && !headers.authorization) {
			headers.Authorization = `Bearer ${auth.apiKey}`;
		}

		const response = await fetchFn(`${baseUrl}/v1/rerank`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				model: modelId,
				query: options.query,
				documents: options.documents.map((doc) => doc.text),
			}),
			signal,
		});
		if (!response.ok) return originalIds;

		const payload = (await response.json()) as {
			results?: Array<{ index?: number; relevance_score?: number }>;
		};
		const results = Array.isArray(payload.results) ? [...payload.results] : [];
		if (results.length === 0) return originalIds;
		results.sort((a, b) => (b.relevance_score ?? 0) - (a.relevance_score ?? 0));
		const ordered: string[] = [];
		const seen = new Set<string>();
		for (const result of results) {
			const index = result.index;
			if (typeof index !== "number" || index < 0 || index >= options.documents.length) continue;
			const id = options.documents[index]!.id;
			if (seen.has(id)) continue;
			seen.add(id);
			ordered.push(id);
		}
		for (const id of originalIds) {
			if (!seen.has(id)) ordered.push(id);
		}
		return ordered;
	} catch (error) {
		if (isAbortError(error)) return originalIds;
		return originalIds;
	}
}
