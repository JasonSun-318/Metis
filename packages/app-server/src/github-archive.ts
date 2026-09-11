import type { Entry, ZipFile } from "yauzl";
import yauzl from "yauzl";
import { AppServerError } from "./session-runtime-host.ts";

export const MAX_GITHUB_JSON_BYTES = 4 * 1024 * 1024;
export const MAX_GITHUB_ROUTE_PARTS = 16;
export const RETRYABLE_HTTP_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
export const MISSING_GITHUB_COMMIT_STATUS = new Set([404, 422]);

export const DEFAULT_MAX_IMPORT_SOURCE_BYTES = 32 * 1024 * 1024;
export const DEFAULT_MAX_IMPORT_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
export const DEFAULT_MAX_IMPORT_FILE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_MAX_IMPORT_ENTRIES = 2048;

export const MAX_PLUGIN_METADATA_BYTES = 4 * 1024 * 1024;
export const MAX_PLUGIN_DOWNLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_PLUGIN_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
export const MAX_PLUGIN_FILE_BYTES = 32 * 1024 * 1024;
export const MAX_PLUGIN_ARCHIVE_ENTRIES = 10000;
export const MAX_PLUGIN_PROBE_DEPTH = 6;

export type FetchImplementation = typeof globalThis.fetch;

export interface GitHubSource {
	readonly owner: string;
	readonly repo: string;
	readonly route?: { readonly kind: "tree" | "blob"; readonly parts: readonly string[] };
}

export interface ImportedArchiveEntry {
	readonly path: string;
	readonly bytes: Buffer;
	readonly mode: 0o600 | 0o700;
}

export interface ArchiveOptions {
	readonly stripRoot?: boolean;
	readonly skipNonRegular?: boolean;
	readonly maxFileBytes?: number;
	readonly maxUncompressedBytes?: number;
	readonly maxEntries?: number;
}

export function validArchivePath(path: string): boolean {
	if (!path || path.length > 4096 || path.includes("\0") || path.includes("\\") || path.startsWith("/")) return false;
	const parts = path.replace(/\/$/u, "").split("/");
	return parts.length > 0 && parts.every((part) => part !== "" && part !== "." && part !== "..");
}

export function regularZipEntry(entry: Entry): boolean {
	const directory = entry.fileName.endsWith("/");
	const madeBy = entry.versionMadeBy >>> 8;
	if (madeBy !== 3) return true;
	const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
	const kind = mode & 0o170000;
	return kind === 0 || kind === (directory ? 0o040000 : 0o100000);
}

export function importedFileMode(entry: Entry): 0o600 | 0o700 {
	return entry.versionMadeBy >>> 8 === 3 && ((entry.externalFileAttributes >>> 16) & 0o111) !== 0 ? 0o700 : 0o600;
}

export function openZip(bytes: Buffer): Promise<ZipFile> {
	return new Promise((resolveZip, reject) => {
		yauzl.fromBuffer(
			bytes,
			{ autoClose: false, decodeStrings: true, lazyEntries: true, strictFileNames: true, validateEntrySizes: true },
			(error, zip) => (error ? reject(error) : resolveZip(zip)),
		);
	});
}

export function readZipEntry(
	zip: ZipFile,
	entry: Entry,
	maxBytes: number = DEFAULT_MAX_IMPORT_FILE_BYTES,
): Promise<Buffer> {
	return new Promise((resolveEntry, reject) => {
		zip.openReadStream(entry, (error, stream) => {
			if (error) {
				reject(error);
				return;
			}
			const chunks: Buffer[] = [];
			let bytes = 0;
			stream.on("data", (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > maxBytes) stream.destroy(new Error("Archive entry is too large"));
				else chunks.push(chunk);
			});
			stream.once("error", reject);
			stream.once("end", () => resolveEntry(Buffer.concat(chunks, bytes)));
		});
	});
}

export async function archiveEntries(
	bytes: Buffer,
	options: ArchiveOptions | boolean = false,
	skipNonRegularArg = false,
): Promise<ImportedArchiveEntry[]> {
	const stripRoot = typeof options === "boolean" ? options : (options.stripRoot ?? false);
	const skipNonRegular = typeof options === "boolean" ? skipNonRegularArg : (options.skipNonRegular ?? false);
	const maxFileBytes =
		typeof options === "object"
			? (options.maxFileBytes ?? DEFAULT_MAX_IMPORT_FILE_BYTES)
			: DEFAULT_MAX_IMPORT_FILE_BYTES;
	const maxUncompressedBytes =
		typeof options === "object"
			? (options.maxUncompressedBytes ?? DEFAULT_MAX_IMPORT_UNCOMPRESSED_BYTES)
			: DEFAULT_MAX_IMPORT_UNCOMPRESSED_BYTES;
	const maxEntries =
		typeof options === "object" ? (options.maxEntries ?? DEFAULT_MAX_IMPORT_ENTRIES) : DEFAULT_MAX_IMPORT_ENTRIES;

	let zip: ZipFile | undefined;
	try {
		zip = await openZip(bytes);
		if (zip.entryCount < 1 || zip.entryCount > maxEntries) {
			throw new AppServerError("INVALID_REQUEST");
		}
		const entries: ImportedArchiveEntry[] = [];
		let totalBytes = 0;
		await new Promise<void>((resolveEntries, reject) => {
			zip!.on("error", reject);
			zip!.on("end", resolveEntries);
			zip!.on("entry", (entry: Entry) => {
				void (async () => {
					if (!validArchivePath(entry.fileName) || entry.isEncrypted()) {
						throw new Error("Unsafe archive entry");
					}
					if (!regularZipEntry(entry)) {
						if (!skipNonRegular) throw new Error("Unsafe archive entry");
						zip!.readEntry();
						return;
					}
					if (entry.uncompressedSize > maxFileBytes) throw new Error("Archive entry is too large");
					if (!entry.fileName.endsWith("/")) {
						totalBytes += entry.uncompressedSize;
						if (totalBytes > maxUncompressedBytes) throw new Error("Archive is too large");
						entries.push({
							path: entry.fileName,
							bytes: await readZipEntry(zip!, entry, maxFileBytes),
							mode: importedFileMode(entry),
						});
					}
					zip!.readEntry();
				})().catch(reject);
			});
			zip!.readEntry();
		});
		if (!stripRoot) return entries;
		const roots = new Set(entries.map((entry) => entry.path.split("/")[0]));
		if (roots.size !== 1) throw new AppServerError("INVALID_REQUEST");
		return entries
			.map((entry) => ({ ...entry, path: entry.path.slice(entry.path.indexOf("/") + 1) }))
			.filter((entry) => entry.path);
	} catch (error) {
		if (error instanceof AppServerError) throw error;
		throw new AppServerError("INVALID_REQUEST");
	} finally {
		zip?.close();
	}
}

export function githubSource(value: string): GitHubSource {
	let url: URL;
	const trimmed = value.trim();
	// Support shorthand "owner/repo" or "owner/repo/tree/..."
	if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
		const parts = trimmed.split("/").filter(Boolean);
		if (parts.length >= 2) {
			url = new URL(`https://github.com/${trimmed}`);
		} else {
			throw new AppServerError("INVALID_REQUEST");
		}
	} else {
		try {
			url = new URL(trimmed);
		} catch {
			throw new AppServerError("INVALID_REQUEST");
		}
	}
	if (
		url.protocol !== "https:" ||
		url.hostname !== "github.com" ||
		url.username ||
		url.password ||
		url.search ||
		url.hash
	) {
		throw new AppServerError("INVALID_REQUEST");
	}
	const parts = url.pathname.split("/").filter(Boolean);
	const owner = parts[0];
	const repo = parts[1]?.replace(/\.git$/u, "");
	if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/u.test(owner) || !/^[A-Za-z0-9_.-]+$/u.test(repo)) {
		throw new AppServerError("INVALID_REQUEST");
	}
	if (parts.length === 2) return { owner, repo };
	const kind = parts[2];
	const route = parts.slice(3);
	if ((kind !== "tree" && kind !== "blob") || route.length < 1 || !validArchivePath(route.join("/"))) {
		throw new AppServerError("INVALID_REQUEST");
	}
	return { owner, repo, route: { kind, parts: route } };
}

export async function fetchBytes(
	fetchImpl: FetchImplementation,
	url: string,
	maximum: number,
	accept: string,
	missingStatuses?: ReadonlySet<number>,
): Promise<Buffer | undefined> {
	let response: Response | undefined;
	for (let attempt = 0; attempt < 2; attempt += 1) {
		try {
			response = await fetchImpl(url, {
				redirect: "error",
				headers: { Accept: accept, "User-Agent": "Metis-Desktop" },
				signal: AbortSignal.timeout(60_000),
			});
		} catch {
			if (attempt === 1) throw new AppServerError("GITHUB_DOWNLOAD_FAILED");
			await new Promise((resolveRetry) => setTimeout(resolveRetry, 250));
			continue;
		}
		if (
			response.status === 429 ||
			(response.status === 403 &&
				(response.headers.get("x-ratelimit-remaining") === "0" || response.headers.has("retry-after")))
		) {
			await response.body?.cancel().catch(() => undefined);
			throw new AppServerError("GITHUB_RATE_LIMITED");
		}
		if (attempt === 0 && RETRYABLE_HTTP_STATUS.has(response.status)) {
			await response.body?.cancel().catch(() => undefined);
			await new Promise((resolveRetry) => setTimeout(resolveRetry, 250));
			continue;
		}
		break;
	}
	if (response && missingStatuses?.has(response.status)) {
		await response.body?.cancel().catch(() => undefined);
		return undefined;
	}
	if (!response?.ok || !response.body) {
		await response?.body?.cancel().catch(() => undefined);
		throw new AppServerError(
			response && [401, 403, 404].includes(response.status) ? "GITHUB_ACCESS_DENIED" : "GITHUB_DOWNLOAD_FAILED",
		);
	}
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > maximum) throw new AppServerError("INVALID_REQUEST");
	const reader = response.body.getReader();
	const chunks: Buffer[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > maximum) {
				await reader.cancel();
				throw new AppServerError("INVALID_REQUEST");
			}
			chunks.push(Buffer.from(value));
		}
	} catch (error) {
		if (error instanceof AppServerError) throw error;
		throw new AppServerError("GITHUB_DOWNLOAD_FAILED");
	} finally {
		reader.releaseLock();
	}
	return Buffer.concat(chunks, length);
}

export async function fetchJson(
	fetchImpl: FetchImplementation,
	url: string,
	maximum = MAX_GITHUB_JSON_BYTES,
): Promise<unknown> {
	const bytes = await fetchBytes(fetchImpl, url, maximum, "application/vnd.github+json");
	if (!bytes) throw new AppServerError("OPERATION_FAILED");
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new AppServerError("OPERATION_FAILED");
	}
}

export async function fetchOptionalJson(
	fetchImpl: FetchImplementation,
	url: string,
	maximum = MAX_GITHUB_JSON_BYTES,
): Promise<unknown | undefined> {
	const bytes = await fetchBytes(fetchImpl, url, maximum, "application/vnd.github+json", MISSING_GITHUB_COMMIT_STATUS);
	if (!bytes) return undefined;
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	} catch {
		throw new AppServerError("OPERATION_FAILED");
	}
}
