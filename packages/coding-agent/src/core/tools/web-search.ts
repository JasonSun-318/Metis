import type { AgentTool } from "@metis/agent-core";
import { Text } from "@metis/tui";
import { type Static, Type } from "typebox";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { WEB_SEARCH_PROVIDER_INFO, type WebSearchProvider } from "../web-search-config.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";
import { readBoundedResponseBytes } from "./web-fetch.ts";

const REQUEST_TIMEOUT_MS = 15_000;

const webSearchSchema = Type.Object({
	query: Type.String({ description: "Search query", minLength: 1, maxLength: 400 }),
	type: Type.Optional(Type.Union([Type.Literal("web"), Type.Literal("images")], { default: "web" })),
	limit: Type.Optional(Type.Integer({ description: "Maximum results", minimum: 1, maximum: 20, default: 10 })),
});

export type WebSearchToolInput = Static<typeof webSearchSchema>;

export interface WebResult {
	title: string;
	url: string;
	snippet?: string;
}

export interface ImageResult {
	url: string;
	title?: string;
	sourceUrl?: string;
}

export type WebSearchResponse = { type: "web"; results: WebResult[] } | { type: "images"; results: ImageResult[] };

export interface WebSearchToolDetails {
	provider: WebSearchProvider;
	type: "web" | "images";
	count: number;
}

export interface WebSearchToolOptions {
	getSettings(): { enabled: boolean; provider: WebSearchProvider };
	getApiKey(provider: WebSearchProvider): Promise<string | undefined>;
	fetch?: typeof globalThis.fetch;
}

function object(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function string(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function httpUrl(value: unknown): string | undefined {
	const text = string(value);
	if (!text) return undefined;
	try {
		const url = new URL(text);
		return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password
			? url.href
			: undefined;
	} catch {
		return undefined;
	}
}

async function requestJson(
	provider: WebSearchProvider,
	request: typeof globalThis.fetch,
	url: URL,
	init: RequestInit,
	signal: AbortSignal,
): Promise<Record<string, unknown>> {
	let response: Response;
	try {
		response = await request(url, { ...init, redirect: "error", signal });
	} catch {
		throw new Error(`${WEB_SEARCH_PROVIDER_INFO[provider].label} request failed`);
	}
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(`${WEB_SEARCH_PROVIDER_INFO[provider].label} request failed with HTTP ${response.status}`);
	}
	const { data } = await readBoundedResponseBytes(response);
	try {
		const parsed = object(JSON.parse(new TextDecoder().decode(data)));
		if (!parsed) throw new Error("not an object");
		return parsed;
	} catch {
		throw new Error(`${WEB_SEARCH_PROVIDER_INFO[provider].label} returned invalid JSON`);
	}
}

function webResult(value: unknown, fields: { title: string; url: string; snippet: string }): WebResult | undefined {
	const item = object(value);
	const title = string(item?.[fields.title]);
	const url = httpUrl(item?.[fields.url]);
	if (!title || !url) return undefined;
	const snippet = string(item?.[fields.snippet]);
	return { title, url, ...(snippet ? { snippet } : {}) };
}

function compact<T>(values: unknown, map: (value: unknown) => T | undefined, limit: number): T[] {
	return (Array.isArray(values) ? values : [])
		.map(map)
		.filter((value): value is T => value !== undefined)
		.slice(0, limit);
}

async function searchBrave(
	type: "web" | "images",
	query: string,
	limit: number,
	apiKey: string,
	request: typeof globalThis.fetch,
	signal: AbortSignal,
): Promise<WebSearchResponse> {
	const endpoint = type === "web" ? "/res/v1/web/search" : "/res/v1/images/search";
	const url = new URL(endpoint, "https://api.search.brave.com");
	url.searchParams.set("q", query);
	url.searchParams.set("count", String(limit));
	const payload = await requestJson(
		"brave",
		request,
		url,
		{ headers: { accept: "application/json", "x-subscription-token": apiKey } },
		signal,
	);
	if (type === "web") {
		return {
			type,
			results: compact(
				object(payload.web)?.results,
				(value) => webResult(value, { title: "title", url: "url", snippet: "description" }),
				limit,
			),
		};
	}
	return {
		type,
		results: compact(
			payload.results,
			(value) => {
				const item = object(value);
				const url = httpUrl(object(item?.properties)?.url);
				if (!url) return undefined;
				const title = string(item?.title);
				const sourceUrl = httpUrl(item?.url);
				return { url, ...(title ? { title } : {}), ...(sourceUrl ? { sourceUrl } : {}) };
			},
			limit,
		),
	};
}

async function searchTavily(
	type: "web" | "images",
	query: string,
	limit: number,
	apiKey: string,
	request: typeof globalThis.fetch,
	signal: AbortSignal,
): Promise<WebSearchResponse> {
	const payload = await requestJson(
		"tavily",
		request,
		new URL("https://api.tavily.com/search"),
		{
			method: "POST",
			headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
			body: JSON.stringify({
				query,
				max_results: limit,
				search_depth: "basic",
				include_answer: false,
				include_raw_content: false,
				include_images: type === "images",
				include_image_descriptions: type === "images",
			}),
		},
		signal,
	);
	if (type === "web") {
		return {
			type,
			results: compact(
				payload.results,
				(value) => webResult(value, { title: "title", url: "url", snippet: "content" }),
				limit,
			),
		};
	}
	return {
		type,
		results: compact(
			payload.images,
			(value) => {
				const item = object(value);
				const url = httpUrl(item?.url);
				if (!url) return undefined;
				const title = string(item?.description);
				return { url, ...(title ? { title } : {}) };
			},
			limit,
		),
	};
}

async function searchSerpApi(
	type: "web" | "images",
	query: string,
	limit: number,
	apiKey: string,
	request: typeof globalThis.fetch,
	signal: AbortSignal,
): Promise<WebSearchResponse> {
	const url = new URL("https://serpapi.com/search.json");
	url.searchParams.set("engine", type === "web" ? "google_light" : "google_images");
	url.searchParams.set("q", query);
	if (type === "web") url.searchParams.set("num", String(limit));
	url.searchParams.set("api_key", apiKey);
	const payload = await requestJson("serpapi", request, url, {}, signal);
	if (type === "web") {
		return {
			type,
			results: compact(
				payload.organic_results,
				(value) => webResult(value, { title: "title", url: "link", snippet: "snippet" }),
				limit,
			),
		};
	}
	return {
		type,
		results: compact(
			payload.images_results,
			(value) => {
				const item = object(value);
				const imageUrl = httpUrl(item?.original);
				if (!imageUrl) return undefined;
				const title = string(item?.title);
				const sourceUrl = httpUrl(item?.link);
				return { url: imageUrl, ...(title ? { title } : {}), ...(sourceUrl ? { sourceUrl } : {}) };
			},
			limit,
		),
	};
}

export function createWebSearchToolDefinition(
	options?: WebSearchToolOptions,
): ToolDefinition<typeof webSearchSchema, WebSearchToolDetails> {
	return {
		name: "web_search",
		label: "Web search",
		description: "Search the web or find image URLs using the provider selected by the user",
		promptSnippet: "Search the web or find image URLs with the user-configured provider",
		parameters: webSearchSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal) {
			if (!options) throw new Error("web_search runtime is not configured");
			const settings = options.getSettings();
			if (!settings.enabled) throw new Error("web_search is disabled by the user");
			const apiKey = await options.getApiKey(settings.provider);
			if (!apiKey) {
				throw new Error(`${WEB_SEARCH_PROVIDER_INFO[settings.provider].label} API key is not configured`);
			}
			const type = params.type ?? "web";
			const limit = params.limit ?? 10;
			const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
			const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
			const request = options.fetch ?? globalThis.fetch;
			const response =
				settings.provider === "brave"
					? await searchBrave(type, params.query, limit, apiKey, request, requestSignal)
					: settings.provider === "tavily"
						? await searchTavily(type, params.query, limit, apiKey, request, requestSignal)
						: await searchSerpApi(type, params.query, limit, apiKey, request, requestSignal);
			return {
				content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
				details: { provider: settings.provider, type, count: response.results.length },
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const query = str(args?.query);
			const displayQuery = query === null ? invalidArgText(theme) : theme.fg("accent", query || "...");
			const searchType = args?.type === "images" ? theme.fg("muted", " images") : "";
			const expandHint =
				!context.expanded && !context.isPartial && !context.isError
					? theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`)
					: "";
			text.setText(`${theme.fg("toolTitle", theme.bold("web_search"))}${searchType} ${displayQuery}${expandHint}`);
			return text;
		},
		renderResult(result, options, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const output = getTextOutput(result, context.showImages);
			text.setText(output && (options.expanded || context.isError) ? `\n${theme.fg("toolOutput", output)}` : "");
			return text;
		},
	};
}

export function createWebSearchTool(
	options?: WebSearchToolOptions,
): AgentTool<typeof webSearchSchema, WebSearchToolDetails> {
	return wrapToolDefinition(createWebSearchToolDefinition(options));
}
