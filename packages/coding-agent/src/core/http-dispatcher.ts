import { EventEmitter } from "node:events";
import * as undici from "undici";

export const DEFAULT_HTTP_IDLE_TIMEOUT_MS = 300_000;

export const HTTP_IDLE_TIMEOUT_CHOICES = [
	{ label: "30 sec", timeoutMs: 30_000 },
	{ label: "1 min", timeoutMs: 60_000 },
	{ label: "2 min", timeoutMs: 120_000 },
	{ label: "5 min", timeoutMs: 300_000 },
	{ label: "disabled", timeoutMs: 0 },
] as const;

const originalGlobalFetch = globalThis.fetch;
let installedGlobalFetch: typeof globalThis.fetch | undefined;

export function parseHttpIdleTimeoutMs(value: unknown): number | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.toLowerCase() === "disabled") {
			return 0;
		}
		if (trimmed.length === 0) {
			return undefined;
		}
		return parseHttpIdleTimeoutMs(Number(trimmed));
	}

	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		return undefined;
	}
	return Math.floor(value);
}

export function formatHttpIdleTimeoutMs(timeoutMs: number): string {
	const choice = HTTP_IDLE_TIMEOUT_CHOICES.find((item) => item.timeoutMs === timeoutMs);
	if (choice) {
		return choice.label;
	}
	return `${timeoutMs / 1000} sec`;
}

export function applyHttpProxySettings(httpProxy: string | undefined): void {
	const proxy = httpProxy?.trim();
	if (!proxy) return;
	process.env.HTTP_PROXY ??= proxy;
	process.env.HTTPS_PROXY ??= proxy;
}

const ignoreUndiciDispatcherError = (_error: unknown): void => {};

// Undici can emit an internal Client "error" while terminating a mid-stream
// fetch body. The body stream still rejects through reader.read(); this listener
// only prevents EventEmitter's unhandled "error" special case from crashing metis.
export function withUndiciErrorListener<T extends undici.Dispatcher>(dispatcher: T): T {
	if (dispatcher instanceof EventEmitter) {
		EventEmitter.prototype.on.call(dispatcher, "error", ignoreUndiciDispatcherError);
	}
	return dispatcher;
}

export function createUndiciClient(origin: string | URL, options: object): undici.Dispatcher {
	return withUndiciErrorListener(new undici.Client(origin, options as undici.Client.Options));
}

export function createUndiciOriginDispatcher(origin: string | URL, options: object): undici.Dispatcher {
	const dispatcherOptions = options as undici.Pool.Options;
	if (dispatcherOptions.connections === 1) {
		return createUndiciClient(origin, dispatcherOptions);
	}
	return withUndiciErrorListener(
		new undici.Pool(origin, {
			...dispatcherOptions,
			factory: createUndiciClient,
		}),
	);
}

export function configureHttpDispatcher(timeoutMs: number = DEFAULT_HTTP_IDLE_TIMEOUT_MS): void {
	const normalizedTimeoutMs = parseHttpIdleTimeoutMs(timeoutMs);
	if (normalizedTimeoutMs === undefined) {
		throw new Error(`Invalid HTTP idle timeout: ${String(timeoutMs)}`);
	}
	const dispatcher = withUndiciErrorListener(
		new undici.EnvHttpProxyAgent({
			allowH2: false,
			bodyTimeout: normalizedTimeoutMs,
			headersTimeout: normalizedTimeoutMs,
			clientFactory: createUndiciClient,
			factory: createUndiciOriginDispatcher,
		}),
	);
	undici.setGlobalDispatcher(dispatcher);
	// Keep fetch and the dispatcher on the same undici implementation. Node 26.0's
	// bundled fetch can otherwise consume compressed responses through npm undici's
	// dispatcher without decompressing them, causing response.json() failures.
	// If a caller replaced fetch after module load, preserve that deliberate override.
	const shouldInstallGlobals =
		installedGlobalFetch === undefined
			? globalThis.fetch === originalGlobalFetch
			: globalThis.fetch === installedGlobalFetch;
	if (shouldInstallGlobals) {
		undici.install?.();
		installedGlobalFetch = globalThis.fetch;
	}
}

const PROXY_ENV = {
	http: ["http_proxy", "HTTP_PROXY"],
	https: ["https_proxy", "HTTPS_PROXY"],
} as const;

interface NoProxyEntry {
	readonly hostname: string;
	readonly port: number;
	readonly wildcard: boolean;
}

function proxyEnv(names: readonly string[]): string | undefined {
	for (const name of names) {
		const value = process.env[name];
		if (value) return value;
	}
	return undefined;
}

function noProxyEntries(): readonly NoProxyEntry[] {
	const raw = process.env.no_proxy ?? process.env.NO_PROXY ?? "";
	const entries: NoProxyEntry[] = [];
	for (const entry of raw.split(/[,\s]/)) {
		if (!entry) continue;
		let hostname: string;
		let port = 0;
		const ipv6WithPort = /^\[(.+)\]:(\d+)$/.exec(entry);
		if (ipv6WithPort) {
			hostname = ipv6WithPort[1] ?? "";
			port = Number.parseInt(ipv6WithPort[2] ?? "", 10);
		} else {
			const unbracketed = entry.replace(/^\[(.+)\]$/, "$1");
			const colonCount = unbracketed.match(/:/g)?.length ?? 0;
			const parsed = colonCount === 1 ? /^(.+):(\d+)$/.exec(unbracketed) : null;
			hostname = parsed?.[1] ?? unbracketed;
			port = parsed?.[2] ? Number.parseInt(parsed[2], 10) : 0;
		}
		entries.push({
			hostname: hostname
				.replace(/^\*?\./, "")
				.replace(/^(.+)\.$/, "$1")
				.toLowerCase(),
			port,
			wildcard: entry.charCodeAt(0) === 42,
		});
	}
	return entries;
}

/**
 * Proxy URI for one request, using the same environment rules as undici's
 * EnvHttpProxyAgent. Undefined means connect directly.
 */
export function requestProxyUrl(url: URL): string | undefined {
	const httpProxy = proxyEnv(PROXY_ENV.http);
	const httpsProxy = proxyEnv(PROXY_ENV.https);
	const proxy = url.protocol === "https:" ? (httpsProxy ?? httpProxy) : httpProxy;
	if (!proxy || !shouldUseProxy(url)) return undefined;
	return proxy;
}

function shouldUseProxy(url: URL): boolean {
	const entries = noProxyEntries();
	if (entries.length === 0) return true;
	let hostname = url.hostname.replace(/^\[(.+)\]$/, "$1").toLowerCase();
	if (hostname.length > 1 && hostname.endsWith(".")) hostname = hostname.slice(0, -1);
	const port = Number.parseInt(url.port, 10) || (url.protocol === "https:" ? 443 : 80);
	for (const entry of entries) {
		if (entry.hostname === "*") {
			if (entry.port && entry.port !== port) continue;
			return false;
		}
		if (entry.port && entry.port !== port) continue;
		if (!entry.wildcard && hostname === entry.hostname) return false;
		if (hostname.slice(-(entry.hostname.length + 1)) === `.${entry.hostname}`) return false;
	}
	return true;
}
