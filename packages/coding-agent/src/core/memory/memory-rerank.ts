import { readBoundedResponseBytes } from "../bounded-response.ts";
import { type RerankSettings, validateRerankSettings, validateServiceCredential } from "./memory-service-settings.ts";

export const MEMORY_RERANK_DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface RerankDocument {
	id: string;
	text: string;
}

export interface RerankScore {
	id: string;
	score: number;
}

export interface RerankOptions {
	settings: RerankSettings;
	apiKey: string;
	query: string;
	documents: RerankDocument[];
	timeoutMs?: number;
	fetchFn?: typeof fetch;
	signal?: AbortSignal;
}

export async function rerankDocuments(options: RerankOptions): Promise<RerankScore[]> {
	if (options.query.length > 8_000) throw new Error("Rerank query must contain at most 8000 characters");
	if (options.documents.length < 1 || options.documents.length > 50) {
		throw new Error("Rerank requires 1 through 50 documents");
	}
	if (options.documents.some((document) => document.text.length > 4_000)) {
		throw new Error("Each rerank document must contain at most 4000 characters");
	}
	const settings = validateRerankSettings(options.settings);
	const apiKey = validateServiceCredential(options.apiKey);
	const timeout = AbortSignal.timeout(options.timeoutMs ?? MEMORY_RERANK_DEFAULT_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const response = await (options.fetchFn ?? fetch)(settings.endpointUrl, {
		method: "POST",
		headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
		body: JSON.stringify({
			model: settings.modelId,
			query: options.query,
			documents: options.documents.map((document) => document.text),
			top_n: options.documents.length,
		}),
		redirect: "error",
		signal,
	});
	if (!response.ok) throw new Error(`Rerank request failed with HTTP ${response.status}`);
	const { data } = await readBoundedResponseBytes(response, MAX_RESPONSE_BYTES);
	let payload: unknown;
	try {
		payload = JSON.parse(new TextDecoder().decode(data));
	} catch {
		throw new Error("Rerank response is not valid JSON");
	}
	if (!isRecord(payload) || !Array.isArray(payload.results)) throw new Error("Rerank response is missing results");
	const seen = new Set<number>();
	const scores: RerankScore[] = [];
	for (const raw of payload.results) {
		const index = isRecord(raw) && typeof raw.index === "number" ? raw.index : Number.NaN;
		if (!isRecord(raw) || !Number.isInteger(index) || index < 0 || index >= options.documents.length) {
			throw new Error("Rerank response contains an out-of-range index");
		}
		if (seen.has(index)) throw new Error("Rerank response contains a duplicate index");
		if (typeof raw.relevance_score !== "number" || !Number.isFinite(raw.relevance_score)) {
			throw new Error("Rerank score must be finite");
		}
		seen.add(index);
		scores.push({ id: options.documents[index]!.id, score: raw.relevance_score });
	}
	return scores.sort((left, right) => right.score - left.score);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
