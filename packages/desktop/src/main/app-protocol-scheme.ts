import { isAbsolute, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { net, protocol } from "electron";

export const APP_SCHEME = "app";
export const APP_ORIGIN = `${APP_SCHEME}://renderer`;

export function registerAppScheme(): void {
	protocol.registerSchemesAsPrivileged([
		{
			scheme: APP_SCHEME,
			privileges: {
				standard: true,
				secure: true,
				supportFetchAPI: true,
				codeCache: true,
			},
		},
	]);
}

function isLoopback(url: URL): boolean {
	return (
		url.protocol === "http:" &&
		(url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]")
	);
}

export function resolveRendererAsset(entryUrl: string, requestUrl: string): URL | undefined {
	let request: URL;
	try {
		request = new URL(requestUrl);
	} catch {
		return undefined;
	}
	if (
		request.protocol !== `${APP_SCHEME}:` ||
		request.hostname !== "renderer" ||
		request.port ||
		request.username ||
		request.password ||
		request.search ||
		request.hash
	)
		return undefined;
	let path: string;
	try {
		path = decodeURIComponent(request.pathname);
	} catch {
		return undefined;
	}
	const segments = path.split("/").filter(Boolean);
	if (
		segments.length === 0 ||
		segments.some(
			(segment) => segment === "." || segment === ".." || segment.includes("\\") || segment.includes("\0"),
		)
	) {
		return undefined;
	}

	const entry = new URL(entryUrl);
	if (entry.protocol !== "file:" && !isLoopback(entry)) return undefined;
	const base = new URL("../", entry);
	const target = path === "/index.html" ? entry : new URL(`.${path}`, base);
	if (target.protocol !== base.protocol) return undefined;
	if (target.protocol === "file:") {
		const basePath = fileURLToPath(base);
		const targetPath = fileURLToPath(target);
		const pathFromBase = relative(basePath, targetPath);
		if (pathFromBase.startsWith("..") || isAbsolute(pathFromBase)) return undefined;
	} else if (target.origin !== base.origin || !target.pathname.startsWith(base.pathname)) {
		return undefined;
	}
	return target;
}

export function installAppProtocol(rendererEntry: string): void {
	protocol.handle(APP_SCHEME, (request) => {
		if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
		const target = resolveRendererAsset(rendererEntry, request.url);
		if (!target) return new Response("Not found", { status: 404 });
		return net.fetch(target.toString());
	});
}
