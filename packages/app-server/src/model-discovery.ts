import type { ClientParams, ClientResult } from "@metis/app-protocol";

type DiscoverParams = ClientParams<"model/discover">;
type DiscoverResult = ClientResult<"model/discover">;
type DiscoveredModel = DiscoverResult["models"][number];

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_MODELS = 500;
const DEFAULT_MAX_PAGES = 10;
const PAGE_SIZE = 100;
const MAX_REDIRECTS = 3;
const MAX_WARNING_LENGTH = 500;
const MAX_WARNINGS = 20;
const MAX_MODEL_ID_UTF16 = 256;

export interface ModelDiscoveryOptions {
	/** Draft key or resolved saved key. Never written to disk by discovery. */
	readonly apiKey?: string;
	readonly fetch?: typeof fetch;
	readonly timeoutMs?: number;
	readonly maxBodyBytes?: number;
	readonly maxModels?: number;
	readonly maxPages?: number;
}

class ModelDiscoveryBodyTooLargeError extends Error {
	readonly limit: number;

	constructor(limit: number) {
		super(`Model list response exceeded the ${limit} byte limit`);
		this.name = "ModelDiscoveryBodyTooLargeError";
		this.limit = limit;
	}
}

class ModelDiscoveryTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Model discovery timed out after ${timeoutMs} ms`);
		this.name = "ModelDiscoveryTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(...values: unknown[]): string | undefined {
	for (const value of values) {
		if (typeof value === "string" && value.trim().length > 0) return value;
	}
	return undefined;
}

function positiveInteger(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 1) return undefined;
	const integer = Math.trunc(value);
	return integer <= 10_000_000 ? integer : undefined;
}

function nestedValue(entry: Record<string, unknown>, path: readonly string[]): unknown {
	let current: unknown = entry;
	for (const key of path) {
		if (!isRecord(current)) return undefined;
		current = current[key];
	}
	return current;
}

function firstPositiveInteger(
	entry: Record<string, unknown>,
	paths: readonly (readonly string[])[],
): number | undefined {
	for (const path of paths) {
		const value = positiveInteger(nestedValue(entry, path));
		if (value !== undefined) return value;
	}
	return undefined;
}

function modalitiesIncludeImage(value: unknown): boolean | undefined {
	if (!Array.isArray(value)) return undefined;
	return value.some((modality) => typeof modality === "string" && modality.toLowerCase() === "image");
}

function explicitImageInput(entry: Record<string, unknown>): boolean | undefined {
	for (const key of ["input_modalities", "inputModalities"]) {
		const included = modalitiesIncludeImage(entry[key]);
		if (included !== undefined) return included;
	}
	for (const path of [
		["architecture", "input_modalities"],
		["modalities", "input"],
	] as const) {
		const included = modalitiesIncludeImage(nestedValue(entry, path));
		if (included !== undefined) return included;
	}
	const architectureModality = nestedValue(entry, ["architecture", "modality"]);
	if (typeof architectureModality === "string") return architectureModality.toLowerCase().includes("image");
	const capabilities = nestedValue(entry, ["capabilities"]);
	if (isRecord(capabilities) && typeof capabilities.vision === "boolean") return capabilities.vision;
	if (typeof entry.supports_vision === "boolean") return entry.supports_vision;
	return undefined;
}

function toDiscoveredModel(entry: unknown): DiscoveredModel | undefined {
	if (!isRecord(entry)) return undefined;
	const modelId = firstString(entry.id, entry.model, entry.name);
	if (!modelId || modelId.length > MAX_MODEL_ID_UTF16) return undefined;
	const rawName = firstString(entry.name, entry.display_name, entry.displayName, modelId) ?? modelId;
	const name = rawName.length <= MAX_MODEL_ID_UTF16 ? rawName : modelId;
	const contextWindow = firstPositiveInteger(entry, [
		["context_length"],
		["context_window"],
		["max_context_length"],
		["max_input_tokens"],
		["input_token_limit"],
		["limits", "context_window"],
		["top_provider", "context_length"],
	]);
	const maxOutputTokens = firstPositiveInteger(entry, [
		["max_output_tokens"],
		["max_completion_tokens"],
		["output_token_limit"],
		["limits", "max_output_tokens"],
		["top_provider", "max_completion_tokens"],
	]);
	const imageInput = explicitImageInput(entry);
	return {
		modelId,
		name,
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
		...(imageInput !== undefined ? { imageInput } : {}),
	};
}

function sanitizePublicText(value: string, secret: string | undefined): string {
	let safe = value;
	if (secret) safe = safe.split(secret).join("[redacted]");
	safe = safe
		.replace(/Bearer\s+[^\s,;]+/giu, "Bearer [redacted]")
		.replace(/(x-api-key["']?\s*[:=]\s*)[^\s,;]+/giu, "$1[redacted]")
		.replace(/\s+/gu, " ")
		.trim();
	return safe.slice(0, MAX_WARNING_LENGTH) || "Model discovery failed";
}

function warningCollector(secret: string | undefined): {
	add(message: string): void;
	list(): string[];
} {
	const warnings: string[] = [];
	return {
		add(message: string) {
			if (warnings.length >= MAX_WARNINGS) return;
			const safe = sanitizePublicText(message, secret);
			if (!warnings.includes(safe)) warnings.push(safe);
		},
		list: () => warnings,
	};
}

/** Build the list-models endpoint from a user-entered base URL, preserving its path. */
export function buildModelListUrl(baseUrl: string, api: DiscoverParams["api"], cursor?: string): URL {
	const url = new URL(baseUrl);
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("Base URL must use HTTP or HTTPS");
	}
	if (url.username || url.password) throw new Error("Base URL must not contain embedded credentials");
	if (url.hash) url.hash = "";
	let path = url.pathname.replace(/\/+$/u, "");
	if (api === "anthropic-messages" && url.hostname.toLowerCase() === "api.anthropic.com" && path === "") {
		path = "/v1";
	}
	if (!path.endsWith("/models")) path = `${path}/models`;
	url.pathname = path;
	if (api === "anthropic-messages") {
		if (!url.searchParams.has("limit")) url.searchParams.set("limit", String(PAGE_SIZE));
		if (cursor) url.searchParams.set("after_id", cursor);
	} else if (cursor) {
		url.searchParams.set("after", cursor);
	}
	return url;
}

async function readBoundedBody(response: Response, limit: number): Promise<string> {
	const declaredLength = Number(response.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > limit) {
		await response.body?.cancel().catch(() => undefined);
		throw new ModelDiscoveryBodyTooLargeError(limit);
	}
	if (!response.body) {
		const text = await response.text();
		if (new TextEncoder().encode(text).byteLength > limit) throw new ModelDiscoveryBodyTooLargeError(limit);
		return text;
	}
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			length += value.byteLength;
			if (length > limit) {
				await reader.cancel().catch(() => undefined);
				throw new ModelDiscoveryBodyTooLargeError(limit);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const merged = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(merged);
}

interface RequestPageOptions {
	readonly api: DiscoverParams["api"];
	readonly apiKey?: string;
	readonly fetchImpl: typeof fetch;
	readonly timeoutMs: number;
	readonly maxBodyBytes: number;
}

async function requestPage(url: URL, options: RequestPageOptions): Promise<{ status: number; text: string }> {
	let current = url;
	const headers: Record<string, string> = { Accept: "application/json" };
	if (options.apiKey) {
		if (options.api === "anthropic-messages") {
			headers["x-api-key"] = options.apiKey;
			headers["anthropic-version"] = "2023-06-01";
		} else {
			headers.Authorization = `Bearer ${options.apiKey}`;
		}
	}
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
		const controller = new AbortController();
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, options.timeoutMs);
		try {
			const response = await options.fetchImpl(current, {
				method: "GET",
				headers,
				redirect: "manual",
				signal: controller.signal,
			});
			if (response.status >= 300 && response.status < 400) {
				await response.body?.cancel().catch(() => undefined);
				if (redirects === MAX_REDIRECTS) throw new Error("Model discovery followed too many redirects");
				const location = response.headers.get("location");
				if (!location)
					throw new Error(`Model discovery received HTTP ${response.status} without a redirect location`);
				const next = new URL(location, current);
				if (next.protocol !== "http:" && next.protocol !== "https:") {
					throw new Error("Refusing to follow a model discovery redirect to a non-HTTP URL");
				}
				if (next.username || next.password) {
					throw new Error("Refusing to follow a model discovery redirect with embedded credentials");
				}
				if (next.origin !== current.origin) {
					throw new Error("Refusing to follow a model discovery redirect to another origin");
				}
				current = next;
				continue;
			}
			return { status: response.status, text: await readBoundedBody(response, options.maxBodyBytes) };
		} catch (error) {
			if (timedOut || controller.signal.aborted) throw new ModelDiscoveryTimeoutError(options.timeoutMs);
			throw error;
		} finally {
			clearTimeout(timer);
		}
	}
	throw new Error("Model discovery followed too many redirects");
}

function pageEntries(value: unknown): unknown[] | undefined {
	if (Array.isArray(value)) return value;
	if (!isRecord(value)) return undefined;
	if (Array.isArray(value.data)) return value.data;
	if (Array.isArray(value.models)) return value.models;
	return undefined;
}

function pageContinuation(value: unknown): { hasMore: boolean; cursor?: string } {
	if (!isRecord(value)) return { hasMore: false };
	const hasMore = value.has_more === true || value.hasMore === true;
	if (!hasMore) return { hasMore: false };
	for (const key of ["last_id", "next", "next_page_token", "after"] as const) {
		const cursor = value[key];
		if (typeof cursor === "string" && cursor.length > 0) return { hasMore: true, cursor };
	}
	return { hasMore: true };
}

export async function discoverModels(
	params: DiscoverParams,
	options: ModelDiscoveryOptions = {},
): Promise<DiscoverResult> {
	const apiKey = options.apiKey;
	const warnings = warningCollector(apiKey);
	const fetchImpl = options.fetch ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
	const maxModels = options.maxModels ?? DEFAULT_MAX_MODELS;
	const maxPages = options.maxPages ?? DEFAULT_MAX_PAGES;

	let firstUrl: URL;
	try {
		firstUrl = buildModelListUrl(params.baseUrl, params.api);
	} catch (error) {
		warnings.add(error instanceof Error ? error.message : String(error));
		return { models: [], warnings: warnings.list() };
	}

	const models = new Map<string, DiscoveredModel>();
	let skipped = 0;
	let cursor: string | undefined;
	let pages = 0;
	let truncated = false;
	const deadline = Date.now() + timeoutMs;
	while (pages < maxPages) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) {
			warnings.add(`Model discovery timed out after ${timeoutMs} ms`);
			break;
		}
		pages += 1;
		let page: { status: number; text: string };
		try {
			const url = cursor === undefined ? firstUrl : buildModelListUrl(params.baseUrl, params.api, cursor);
			page = await requestPage(url, {
				api: params.api,
				apiKey,
				fetchImpl,
				timeoutMs: Math.min(timeoutMs, remaining),
				maxBodyBytes,
			});
		} catch (error) {
			warnings.add(
				error instanceof ModelDiscoveryTimeoutError
					? `Model discovery timed out after ${timeoutMs} ms`
					: `Model discovery request failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			break;
		}
		if (page.status === 401 || page.status === 403) {
			warnings.add(`Model discovery authentication failed (HTTP ${page.status})`);
			break;
		}
		if (page.status < 200 || page.status >= 300) {
			warnings.add(`Model discovery failed with HTTP ${page.status}`);
			break;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(page.text) as unknown;
		} catch {
			warnings.add("Model discovery returned an invalid JSON response");
			break;
		}
		const entries = pageEntries(parsed);
		if (!entries) {
			warnings.add("Model discovery returned an unsupported model list format");
			break;
		}
		for (let index = 0; index < entries.length; index += 1) {
			const model = toDiscoveredModel(entries[index]);
			if (!model) {
				skipped += 1;
				continue;
			}
			if (!models.has(model.modelId)) models.set(model.modelId, model);
			if (models.size >= maxModels) {
				const hasMoreEntries = index < entries.length - 1;
				if (hasMoreEntries || pageContinuation(parsed).hasMore) {
					truncated = true;
					warnings.add(`Model list was truncated at ${maxModels} entries`);
				}
				break;
			}
		}
		if (truncated) break;
		const continuation = pageContinuation(parsed);
		if (!continuation.hasMore) break;
		if (!continuation.cursor) {
			warnings.add("Model discovery reported more models without a pagination cursor");
			break;
		}
		if (continuation.cursor === cursor) {
			warnings.add("Model discovery pagination repeated the same cursor");
			break;
		}
		cursor = continuation.cursor;
		if (pages >= maxPages) {
			warnings.add(`Model discovery stopped after ${maxPages} pages`);
		}
	}
	if (skipped > 0) warnings.add(`Skipped ${skipped} model list entries without a usable identifier`);
	return {
		models: [...models.values()],
		...(warnings.list().length > 0 ? { warnings: warnings.list() } : {}),
	};
}
