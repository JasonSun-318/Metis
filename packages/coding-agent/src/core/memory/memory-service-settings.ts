export type EmbeddingApi = "openai-compatible";

export const MEMORY_EMBEDDING_CREDENTIAL_ID = "memory:embedding:v1";
export const MEMORY_RERANK_CREDENTIAL_ID = "memory:rerank:v1";

export interface EmbeddingSettings {
	name: string;
	provider: string;
	baseUrl: string;
	api: EmbeddingApi;
	modelId: string;
	dimensions?: number;
}

export interface RerankSettings {
	name: string;
	provider: string;
	endpointUrl: string;
	modelId: string;
}

export function validateEmbeddingSettings(value: unknown): EmbeddingSettings {
	if (!isRecord(value) || value.api !== "openai-compatible") throw new Error("Invalid Embedding API format");
	const settings: EmbeddingSettings = {
		name: boundedString(value.name, "Embedding name", 120),
		provider: boundedString(value.provider, "Embedding supplier", 120),
		baseUrl: normalizeEmbeddingBaseUrl(boundedString(value.baseUrl, "Embedding base URL", 2_048)),
		api: "openai-compatible",
		modelId: boundedString(value.modelId, "Embedding model ID", 200),
	};
	if (value.dimensions !== undefined) {
		const dimensions = value.dimensions;
		if (typeof dimensions !== "number" || !Number.isInteger(dimensions) || dimensions < 1 || dimensions > 8_192) {
			throw new Error("Embedding dimensions must be an integer from 1 through 8192");
		}
		settings.dimensions = dimensions;
	}
	return settings;
}

export function validateRerankSettings(value: unknown): RerankSettings {
	if (!isRecord(value)) throw new Error("Invalid Rerank settings");
	const endpointUrl = boundedString(value.endpointUrl, "Rerank endpoint URL", 2_048);
	validateServiceUrl(endpointUrl);
	return {
		name: boundedString(value.name, "Rerank name", 120),
		provider: boundedString(value.provider, "Rerank supplier", 120),
		endpointUrl,
		modelId: boundedString(value.modelId, "Rerank model ID", 200),
	};
}

export function normalizeEmbeddingBaseUrl(value: string): string {
	return validateServiceUrl(value).replace(/\/+$/u, "");
}

export function validateServiceCredential(value: unknown): string {
	if (typeof value !== "string" || value.length < 1 || value.length > 16_384 || /[\u0000-\u001f\u007f]/u.test(value)) {
		throw new Error("Service credential must contain 1 through 16384 characters without ASCII controls");
	}
	return value;
}

export function validateServiceUrl(value: string): string {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new Error("Service URL must be a valid absolute URL");
	}
	if (
		(url.protocol !== "https:" && url.protocol !== "http:") ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new Error("Service URL must use HTTP(S) without credentials, query, or fragment");
	}
	return url.toString().replace(/\/$/u, value.endsWith("/") ? "/" : "");
}

function boundedString(value: unknown, label: string, maxLength: number): string {
	if (typeof value !== "string") throw new Error(`${label} is required`);
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > maxLength)
		throw new Error(`${label} must contain 1 through ${maxLength} characters`);
	return trimmed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
