import type { AgentTool } from "@metis/agent-core";
import { Text } from "@metis/tui";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { type Static, Type } from "typebox";
import { keyText } from "../../modes/interactive/components/keybinding-hints.ts";
import { readBoundedResponseBytes } from "../bounded-response.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const MAX_WEB_RESPONSE_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REQUEST_HEADERS = { accept: "text/html, text/markdown;q=0.9, text/plain;q=0.8" };

const webFetchSchema = Type.Object({
	url: Type.String({ description: "HTTP(S) URL to fetch", minLength: 1, maxLength: 8192 }),
});

export type WebFetchToolInput = Static<typeof webFetchSchema>;

export interface WebFetchToolDetails {
	url: string;
	status: number;
	contentType: string;
	bytes: number;
}

function parseUrl(value: string, base?: URL): URL {
	let url: URL;
	try {
		url = new URL(value, base);
	} catch {
		throw new Error("URL must be a valid HTTP or HTTPS URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error("URL must use HTTP or HTTPS");
	}
	if (url.username || url.password) throw new Error("URL must not include credentials");
	return url;
}

function networkTarget(url: URL): string {
	return `${url.hostname}:${url.port || (url.protocol === "https:" ? "443" : "80")}`;
}

async function fetchWithRedirects(url: URL, signal: AbortSignal): Promise<{ response: Response; url: URL }> {
	let currentUrl = url;
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
		const response = await fetch(currentUrl, {
			headers: REQUEST_HEADERS,
			redirect: "manual",
			signal,
		});
		if (!REDIRECT_STATUSES.has(response.status)) return { response, url: currentUrl };

		const location = response.headers.get("location");
		await response.body?.cancel();
		if (!location) throw new Error(`Redirect response from ${currentUrl.href} is missing Location`);
		if (redirects === MAX_REDIRECTS) throw new Error(`Request exceeded ${MAX_REDIRECTS} redirects`);

		const nextUrl = parseUrl(location, currentUrl);
		if (networkTarget(nextUrl) !== networkTarget(url)) {
			throw new Error(`Redirect target requires separate network permission; call web_fetch with: ${nextUrl.href}`);
		}
		currentUrl = nextUrl;
	}
	throw new Error(`Request exceeded ${MAX_REDIRECTS} redirects`);
}

function parseContentType(value: string | null): { mediaType: string; charset?: string } {
	const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";
	const match = /(?:^|;)\s*charset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^;\s]+))/i.exec(value ?? "");
	const charset = match
		?.slice(1)
		.find((candidate) => candidate !== undefined)
		?.trim();
	return { mediaType, ...(charset ? { charset } : {}) };
}

function isHtml(mediaType: string): boolean {
	return !mediaType || mediaType === "text/html" || mediaType === "application/xhtml+xml";
}

function sniffHtmlCharset(data: Uint8Array): string | undefined {
	const prefix = new TextDecoder("windows-1252").decode(data.subarray(0, 1024));
	for (const tag of prefix.match(/<meta\b[^>]*>/gi) ?? []) {
		const match = /\bcharset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'=<>`]+))/i.exec(tag);
		const charset = match
			?.slice(1)
			.find((candidate) => candidate !== undefined)
			?.trim();
		if (charset) return charset;
	}
	return undefined;
}

function decodeResponse(data: Uint8Array, mediaType: string, declaredCharset?: string): string {
	const charset = declaredCharset ?? (isHtml(mediaType) ? sniffHtmlCharset(data) : undefined) ?? "utf-8";
	try {
		return new TextDecoder(charset).decode(data);
	} catch {
		throw new Error(`Unsupported response charset: ${charset}`);
	}
}

function resolveUrl(value: string, baseUrl: URL): string {
	try {
		return new URL(value, baseUrl).href;
	} catch {
		return value;
	}
}

function convertHtmlToMarkdown(text: string, baseUrl: URL): string {
	const converter = new NodeHtmlMarkdown({ bulletMarker: "-" });
	for (const [tag, attribute] of [
		["a", "href"],
		["img", "src"],
	] as const) {
		const translator = converter.translators.get(tag);
		converter.translators.set(tag, (context) => {
			const value = context.node.getAttribute(attribute);
			if (value) context.node.setAttribute(attribute, resolveUrl(value, baseUrl));
			return typeof translator === "function" ? translator(context) : translator;
		});
	}
	return converter.translate(text) as string;
}

function convertToMarkdown(text: string, mediaType: string, baseUrl: URL): string {
	if (isHtml(mediaType)) {
		return convertHtmlToMarkdown(text, baseUrl);
	}
	if (["text/markdown", "text/x-markdown", "text/plain"].includes(mediaType)) return text;
	throw new Error(`Unsupported content type: ${mediaType}`);
}

export function createWebFetchToolDefinition(): ToolDefinition<typeof webFetchSchema, WebFetchToolDetails> {
	return {
		name: "web_fetch",
		label: "Web fetch",
		description: "Fetch an HTTP(S) page and return its content as Markdown",
		promptSnippet: "Fetch an HTTP(S) page and return its content as Markdown",
		parameters: webFetchSchema,
		executionMode: "parallel",

		async execute(_toolCallId, params, signal) {
			const url = parseUrl(params.url);
			const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
			const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
			const { response, url: finalUrl } = await fetchWithRedirects(url, requestSignal);
			if (!response.ok) throw new Error(`Request failed with HTTP ${response.status}`);

			const { mediaType, charset } = parseContentType(response.headers.get("content-type"));
			const { data, bytes } = await readBoundedResponseBytes(response, MAX_WEB_RESPONSE_BYTES);
			const text = decodeResponse(data, mediaType, charset);
			return {
				content: [{ type: "text", text: convertToMarkdown(text, mediaType, finalUrl) }],
				details: {
					url: finalUrl.href,
					status: response.status,
					contentType: mediaType,
					bytes,
				},
			};
		},
		renderCall(args, theme, context) {
			const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
			const url = str(args?.url);
			const displayUrl = url === null ? invalidArgText(theme) : theme.fg("accent", url || "...");
			const expandHint =
				!context.expanded && !context.isPartial && !context.isError
					? theme.fg("dim", ` (${keyText("app.tools.expand")} to expand)`)
					: "";
			text.setText(`${theme.fg("toolTitle", theme.bold("web_fetch"))} ${displayUrl}${expandHint}`);
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

export function createWebFetchTool(): AgentTool<typeof webFetchSchema, WebFetchToolDetails> {
	return wrapToolDefinition(createWebFetchToolDefinition());
}
