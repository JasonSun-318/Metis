import { createHash } from "node:crypto";
import { readBoundedResponseBytes } from "../bounded-response.ts";
import {
	type EmbeddingSettings,
	normalizeEmbeddingBaseUrl,
	validateEmbeddingSettings,
	validateServiceCredential,
} from "./memory-service-settings.ts";

export const MEMORY_EMBED_DEFAULT_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export interface EmbedTextsOptions {
	settings: EmbeddingSettings;
	apiKey: string;
	timeoutMs?: number;
	fetchFn?: typeof fetch;
	signal?: AbortSignal;
}

export function embeddingConfigKey(settings: EmbeddingSettings): string {
	const valid = validateEmbeddingSettings(settings);
	return createHash("sha256")
		.update(valid.api)
		.update("\0")
		.update(valid.baseUrl)
		.update("\0")
		.update(valid.modelId)
		.update("\0")
		.update(String(valid.dimensions ?? ""))
		.digest("hex");
}

export async function embedTexts(texts: string[], options: EmbedTextsOptions): Promise<Float32Array[]> {
	if (texts.length < 1 || texts.length > 32) throw new Error("Embedding requires 1 through 32 inputs");
	if (texts.some((text) => typeof text !== "string" || text.length > 8_000)) {
		throw new Error("Each embedding input must contain at most 8000 characters");
	}
	const settings = validateEmbeddingSettings(options.settings);
	const apiKey = validateServiceCredential(options.apiKey);
	const timeout = AbortSignal.timeout(options.timeoutMs ?? MEMORY_EMBED_DEFAULT_TIMEOUT_MS);
	const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
	const response = await (options.fetchFn ?? fetch)(`${normalizeEmbeddingBaseUrl(settings.baseUrl)}/embeddings`, {
		method: "POST",
		headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
		body: JSON.stringify({
			model: settings.modelId,
			input: texts,
			...(settings.dimensions === undefined ? {} : { dimensions: settings.dimensions }),
		}),
		redirect: "error",
		signal,
	});
	if (!response.ok) throw new Error(`Embedding request failed with HTTP ${response.status}`);
	const { data } = await readBoundedResponseBytes(response, MAX_RESPONSE_BYTES);
	let payload: unknown;
	try {
		payload = JSON.parse(new TextDecoder().decode(data));
	} catch {
		throw new Error("Embedding response is not valid JSON");
	}
	if (!isRecord(payload) || !Array.isArray(payload.data) || payload.data.length !== texts.length) {
		throw new Error("Embedding response size mismatch");
	}
	const vectors: Array<Float32Array | undefined> = new Array(texts.length);
	let expectedLength = settings.dimensions;
	for (const raw of payload.data) {
		const index = isRecord(raw) && typeof raw.index === "number" ? raw.index : Number.NaN;
		if (!isRecord(raw) || !Number.isInteger(index) || index < 0 || index >= texts.length) {
			throw new Error("Embedding response contains an out-of-range index");
		}
		if (vectors[index]) throw new Error("Embedding response contains a duplicate index");
		if (!Array.isArray(raw.embedding) || raw.embedding.length < 1 || raw.embedding.length > 8_192) {
			throw new Error("Embedding vector length is invalid");
		}
		if (expectedLength === undefined) expectedLength = raw.embedding.length;
		if (raw.embedding.length !== expectedLength) throw new Error("Embedding vector length mismatch");
		let norm = 0;
		const vector = new Float32Array(raw.embedding.length);
		for (let offset = 0; offset < raw.embedding.length; offset++) {
			const source = raw.embedding[offset];
			if (typeof source !== "number" || !Number.isFinite(source)) throw new Error("Embedding values must be finite");
			const converted = Math.fround(source);
			if (!Number.isFinite(converted)) throw new Error("Embedding value is outside finite float32 range");
			vector[offset] = converted;
			norm += converted * converted;
		}
		if (!Number.isFinite(norm) || norm === 0) throw new Error("Embedding vector norm must be non-zero");
		vectors[index] = vector;
	}
	if (vectors.some((vector) => vector === undefined)) throw new Error("Embedding response index set is incomplete");
	return vectors as Float32Array[];
}

export async function embedText(text: string, options: EmbedTextsOptions): Promise<Float32Array> {
	return (await embedTexts([text], options))[0]!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
