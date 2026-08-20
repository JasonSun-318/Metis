import type { ModelRegistry } from "../model-registry.ts";

export const MEMORY_EMBED_DEFAULT_TIMEOUT_MS = 2500;

export class MemoryEmbedTimeout extends Error {
	constructor(message = "Memory embedding request timed out") {
		super(message);
		this.name = "MemoryEmbedTimeout";
	}
}

export interface EmbeddingEndpoint {
	baseUrl: string;
	apiKey?: string;
	headers?: Record<string, string>;
	modelId: string;
}

export function parseProviderModelRef(modelRef: string): { provider: string; modelId: string } {
	const slash = modelRef.indexOf("/");
	if (slash <= 0 || slash === modelRef.length - 1) {
		throw new Error(`memoryEmbeddingModel must be "provider/model", got: ${modelRef}`);
	}
	return { provider: modelRef.slice(0, slash), modelId: modelRef.slice(slash + 1) };
}

export async function resolveEmbeddingEndpoint(
	modelRegistry: ModelRegistry,
	modelRef: string,
): Promise<EmbeddingEndpoint> {
	const { provider, modelId } = parseProviderModelRef(modelRef);
	const exact = modelRegistry.find(provider, modelId);
	const fallback = modelRegistry.getAll().find((model) => model.provider === provider);
	const model = exact ?? fallback;
	if (!model?.baseUrl) {
		throw new Error(`No baseUrl found for embedding provider "${provider}"`);
	}

	const auth = await modelRegistry.getApiKeyAndHeaders(model);
	if (!auth.ok) {
		throw new Error(auth.error);
	}

	return {
		baseUrl: model.baseUrl.replace(/\/+$/, ""),
		apiKey: auth.apiKey,
		headers: auth.headers,
		modelId,
	};
}

export interface EmbedTextsOptions {
	endpoint: EmbeddingEndpoint;
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

export async function embedTexts(texts: string[], options: EmbedTextsOptions): Promise<Float32Array[]> {
	if (texts.length === 0) return [];

	const timeoutMs = options.timeoutMs ?? MEMORY_EMBED_DEFAULT_TIMEOUT_MS;
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const fetchFn = options.fetchFn ?? globalThis.fetch;
	const url = `${options.endpoint.baseUrl}/v1/embeddings`;
	const headers: Record<string, string> = {
		"content-type": "application/json",
		...(options.endpoint.headers ?? {}),
	};
	if (options.endpoint.apiKey && !headers.Authorization && !headers.authorization) {
		headers.Authorization = `Bearer ${options.endpoint.apiKey}`;
	}

	let response: Response;
	try {
		response = await fetchFn(url, {
			method: "POST",
			headers,
			body: JSON.stringify({ model: options.endpoint.modelId, input: texts }),
			signal,
		});
	} catch (error) {
		if (isAbortError(error) || signal.aborted) {
			throw new MemoryEmbedTimeout();
		}
		throw error;
	}

	if (!response.ok) {
		throw new Error(`Embedding request failed with status ${response.status}`);
	}

	const payload = (await response.json()) as {
		data?: Array<{ embedding?: number[]; index?: number }>;
	};
	const rows = Array.isArray(payload.data) ? [...payload.data] : [];
	rows.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
	if (rows.length !== texts.length) {
		throw new Error(`Embedding response size mismatch: expected ${texts.length}, got ${rows.length}`);
	}

	return rows.map((row) => {
		if (!Array.isArray(row.embedding) || row.embedding.length === 0) {
			throw new Error("Embedding response missing vector");
		}
		return Float32Array.from(row.embedding);
	});
}

export async function embedText(text: string, options: EmbedTextsOptions): Promise<Float32Array> {
	const [vector] = await embedTexts([text], options);
	if (!vector) throw new Error("Embedding response missing vector");
	return vector;
}
