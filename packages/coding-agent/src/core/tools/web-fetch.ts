import { lookup } from "node:dns/promises";
import type { AgentTool } from "@metis/agent-core";
import { Text } from "@metis/tui";
import { NodeHtmlMarkdown } from "node-html-markdown";
import { type Static, Type } from "typebox";
import {
	Agent,
	type Dispatcher,
	ProxyAgent,
	type RequestInit as UndiciRequestInit,
	fetch as undiciFetch,
} from "undici";
import { keyText } from "../../presentation/keybinding-hints.ts";
import { readBoundedResponseBytes } from "../bounded-response.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	createUndiciClient,
	createUndiciOriginDispatcher,
	requestProxyUrl,
	withUndiciErrorListener,
} from "../http-dispatcher.ts";
import { exactNetworkEndpoint, permissionClaim, permissionDescriptor } from "../tool-permission-adapter.ts";
import {
	createUnattendedPinnedLookup,
	isBlockedUnattendedHost,
	normalizeUnattendedHost,
	type ResolvedAddress,
	UNATTENDED_BLOCKED_FETCH_REASON,
	unattendedLiteralAddress,
} from "../unattended-fetch-guard.ts";
import { getTextOutput, invalidArgText, str } from "./render-utils.ts";
import { wrapToolDefinition } from "./tool-definition-wrapper.ts";

export const MAX_WEB_RESPONSE_BYTES = 2_000_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 10;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const REQUEST_HEADERS = { accept: "text/html, text/markdown;q=0.9, text/plain;q=0.8" };
const UNATTENDED_UNRESOLVED_HOST_REASON = "Unattended web_fetch could not resolve the host";

export interface WebFetchToolOptions {
	/** Reject loopback, unspecified, and link-local targets, including DNS results and redirects. */
	unattended?: boolean;
	/** Request implementation for unattended fetches. Defaults to undici so the pinned dispatcher matches the client. */
	fetch?: (url: URL, init: RequestInit & { dispatcher?: object }) => Promise<Response>;
}

type WebFetchRequest = (url: URL, init: UndiciRequestInit) => Promise<Response>;

interface PinnedConnection {
	readonly dispatcher: Dispatcher;
	close(): Promise<void>;
}

/**
 * undici fetch removes Host before dispatch. Put the original host back and
 * point the proxy at an address we already accepted, so the proxy is not asked
 * to resolve the name again.
 */
function pinProxyDispatch(proxy: ProxyAgent, pinnedOrigin: string, hostHeader: string): ProxyAgent {
	const dispatch = proxy.dispatch.bind(proxy);
	proxy.dispatch = ((options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler) =>
		dispatch(
			{ ...options, origin: pinnedOrigin, headers: headersWithHost(options.headers, hostHeader) },
			handler,
		)) as typeof proxy.dispatch;
	return proxy;
}

function headersWithHost(headers: Dispatcher.DispatchOptions["headers"], host: string): Record<string, string> {
	const next: Record<string, string> = {};
	if (headers && typeof headers === "object" && !Array.isArray(headers)) {
		for (const [key, value] of Object.entries(headers)) {
			if (key.toLowerCase() === "host" || value == null) continue;
			next[key] = Array.isArray(value) ? value.join(", ") : String(value);
		}
	}
	next.host = host;
	return next;
}

function pinnedOrigin(url: URL, address: ResolvedAddress): string {
	const host = address.family === 6 ? `[${address.address}]` : address.address;
	return `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`;
}

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

async function resolveUnattendedRecords(hostname: string): Promise<readonly ResolvedAddress[]> {
	if (isBlockedUnattendedHost(hostname)) throw new Error(UNATTENDED_BLOCKED_FETCH_REASON);
	const literal = unattendedLiteralAddress(hostname);
	if (literal) return [literal];
	const name = normalizeUnattendedHost(hostname);
	if (!name) throw new Error(UNATTENDED_UNRESOLVED_HOST_REASON);
	let records: readonly { address: string; family: number }[];
	try {
		records = await lookup(name, { all: true, verbatim: true });
	} catch {
		throw new Error(UNATTENDED_UNRESOLVED_HOST_REASON);
	}
	const resolved: ResolvedAddress[] = [];
	for (const record of records) {
		if (isBlockedUnattendedHost(record.address)) throw new Error(UNATTENDED_BLOCKED_FETCH_REASON);
		const address = unattendedLiteralAddress(record.address);
		if (!address) throw new Error(UNATTENDED_UNRESOLVED_HOST_REASON);
		resolved.push(address);
	}
	if (resolved.length === 0) throw new Error(UNATTENDED_UNRESOLVED_HOST_REASON);
	return resolved;
}

function openDispatcher(dispatcher: Dispatcher): PinnedConnection {
	return {
		dispatcher: withUndiciErrorListener(dispatcher),
		async close() {
			try {
				await dispatcher.close();
			} catch {
				// Shutdown follows the fetch outcome and must not replace it.
			}
		},
	};
}

async function openPinnedConnection(url: URL): Promise<PinnedConnection> {
	const records = await resolveUnattendedRecords(url.hostname);
	const proxy = requestProxyUrl(url);
	const address = records[0];
	if (proxy && address) {
		const servername = normalizeUnattendedHost(url.hostname);
		const proxyAgent = withUndiciErrorListener(
			new ProxyAgent({
				uri: proxy,
				allowH2: false,
				clientFactory: createUndiciClient,
				factory: createUndiciOriginDispatcher,
				// Certificate checks stay on. servername is the name the caller asked for.
				...(url.protocol === "https:" ? { requestTls: { servername } } : {}),
			}),
		);
		return openDispatcher(pinProxyDispatch(proxyAgent, pinnedOrigin(url, address), url.host));
	}
	return openDispatcher(
		new Agent({
			allowH2: false,
			connect: { lookup: createUnattendedPinnedLookup(url.hostname, records) },
			factory: createUndiciOriginDispatcher,
		}),
	);
}

async function fetchWithRedirects(
	url: URL,
	signal: AbortSignal,
	request: WebFetchRequest | undefined,
): Promise<{ response: Response; url: URL; release: () => Promise<void> }> {
	const unattended = request !== undefined;
	let currentUrl = url;
	for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
		const connection = unattended ? await openPinnedConnection(currentUrl) : undefined;
		let released = false;
		const release = async () => {
			if (released) return;
			released = true;
			await connection?.close();
		};
		try {
			const response = request
				? await request(currentUrl, {
						headers: REQUEST_HEADERS,
						redirect: "manual",
						signal,
						dispatcher: connection?.dispatcher,
					})
				: await fetch(currentUrl, {
						headers: REQUEST_HEADERS,
						redirect: "manual",
						signal,
					});
			if (!REDIRECT_STATUSES.has(response.status)) return { response, url: currentUrl, release };

			const location = response.headers.get("location");
			await response.body?.cancel();
			await release();
			if (!location) throw new Error(`Redirect response from ${currentUrl.href} is missing Location`);
			if (redirects === MAX_REDIRECTS) throw new Error(`Request exceeded ${MAX_REDIRECTS} redirects`);

			const nextUrl = parseUrl(location, currentUrl);
			// A blocked redirect must not be handed back as the next web_fetch URL.
			if (unattended) await resolveUnattendedRecords(nextUrl.hostname);
			if (networkTarget(nextUrl) !== networkTarget(url)) {
				throw new Error(
					`Redirect target requires separate network permission; call web_fetch with: ${nextUrl.href}`,
				);
			}
			currentUrl = nextUrl;
		} catch (error) {
			await release();
			throw error;
		}
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

export function createWebFetchToolDefinition(
	options?: WebFetchToolOptions,
): ToolDefinition<typeof webFetchSchema, WebFetchToolDetails> {
	const unattendedRequest: WebFetchRequest | undefined = options?.unattended
		? ((options.fetch ?? undiciFetch) as WebFetchRequest)
		: undefined;
	return {
		name: "web_fetch",
		label: "Web fetch",
		description: "Fetch an HTTP(S) page and return its content as Markdown",
		promptSnippet: "Fetch an HTTP(S) page and return its content as Markdown",
		parameters: webFetchSchema,
		executionMode: "parallel",
		permission: permissionDescriptor(({ url }) => permissionClaim({ networkEndpoints: [exactNetworkEndpoint(url)] })),

		async execute(_toolCallId, params, signal) {
			const url = parseUrl(params.url);
			const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
			const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
			const fetched = await fetchWithRedirects(url, requestSignal, unattendedRequest);
			try {
				if (!fetched.response.ok) throw new Error(`Request failed with HTTP ${fetched.response.status}`);

				const { mediaType, charset } = parseContentType(fetched.response.headers.get("content-type"));
				const { data, bytes } = await readBoundedResponseBytes(fetched.response, MAX_WEB_RESPONSE_BYTES);
				const text = decodeResponse(data, mediaType, charset);
				return {
					content: [{ type: "text", text: convertToMarkdown(text, mediaType, fetched.url) }],
					details: {
						url: fetched.url.href,
						status: fetched.response.status,
						contentType: mediaType,
						bytes,
					},
				};
			} finally {
				await fetched.release();
			}
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

export function createWebFetchTool(
	options?: WebFetchToolOptions,
): AgentTool<typeof webFetchSchema, WebFetchToolDetails> {
	return wrapToolDefinition(createWebFetchToolDefinition(options));
}
