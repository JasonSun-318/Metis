import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DesktopUpdateState } from "../shared/desktop-api.ts";

interface UpdateManifest {
	readonly version: string;
	readonly dmg: {
		readonly url: string;
		readonly size: number;
		readonly sha256: string;
	};
}

export interface DesktopUpdaterOptions {
	readonly baseUrl?: string | null;
	readonly currentVersion: string;
	readonly arch: string;
	readonly downloadsDirectory: string;
	readonly isPackaged: boolean;
	readonly platform: NodeJS.Platform;
	readonly fetch: (input: string, init?: RequestInit) => Promise<Response>;
	readonly openPath: (path: string) => Promise<string>;
	readonly onState?: (state: DesktopUpdateState) => void;
	readonly onDiagnostic?: (message: string) => void;
}

const MAX_DMG_BYTES = 4 * 1024 * 1024 * 1024;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

function trustedBaseUrl(value: string | null | undefined): URL | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return undefined;
		url.pathname = `${url.pathname.replace(/\/+$/u, "")}/`;
		return url;
	} catch {
		return undefined;
	}
}

function versionParts(value: string): readonly [number, number, number] | undefined {
	const match = STABLE_VERSION.exec(value);
	if (!match) return undefined;
	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareStableVersions(left: string, right: string): number {
	const leftParts = versionParts(left);
	const rightParts = versionParts(right);
	if (!leftParts || !rightParts) throw new Error("Invalid stable desktop version");
	for (let index = 0; index < leftParts.length; index++) {
		const difference = leftParts[index]! - rightParts[index]!;
		if (difference !== 0) return difference;
	}
	return 0;
}

function parseManifest(value: unknown, baseUrl: URL): UpdateManifest {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid update manifest");
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 1 || typeof record.version !== "string" || !STABLE_VERSION.test(record.version)) {
		throw new Error("Invalid update manifest");
	}
	if (typeof record.dmg !== "object" || record.dmg === null || Array.isArray(record.dmg)) {
		throw new Error("Invalid update manifest");
	}
	const dmg = record.dmg as Record<string, unknown>;
	if (
		typeof dmg.url !== "string" ||
		!Number.isSafeInteger(dmg.size) ||
		Number(dmg.size) < 1 ||
		Number(dmg.size) > MAX_DMG_BYTES ||
		typeof dmg.sha256 !== "string" ||
		!SHA256.test(dmg.sha256)
	) {
		throw new Error("Invalid update manifest");
	}
	const url = new URL(dmg.url);
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		url.origin !== baseUrl.origin ||
		!url.pathname.startsWith(baseUrl.pathname) ||
		!url.pathname.endsWith(".dmg") ||
		url.search ||
		url.hash
	) {
		throw new Error("Invalid update manifest");
	}
	return {
		version: record.version,
		dmg: { url: url.href, size: Number(dmg.size), sha256: dmg.sha256 },
	};
}

async function fileSha256(path: string): Promise<string> {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

async function verifiedFile(path: string, manifest: UpdateManifest): Promise<boolean> {
	try {
		const file = await stat(path);
		return file.isFile() && file.size === manifest.dmg.size && (await fileSha256(path)) === manifest.dmg.sha256;
	} catch {
		return false;
	}
}

/** Checks a static release manifest and opens only a verified macOS DMG. */
export class DesktopUpdater {
	private readonly options: DesktopUpdaterOptions;
	private readonly baseUrl?: URL;
	private state: DesktopUpdateState = { status: "unavailable" };
	private manifest?: UpdateManifest;
	private downloadedPath?: string;
	private downloadTask?: Promise<void>;
	private started = false;

	constructor(options: DesktopUpdaterOptions) {
		this.options = options;
		this.baseUrl = trustedBaseUrl(options.baseUrl);
	}

	start(): boolean {
		if (this.started) return true;
		if (
			!this.options.isPackaged ||
			this.options.platform !== "darwin" ||
			!["arm64", "x64"].includes(this.options.arch) ||
			!this.baseUrl ||
			!versionParts(this.options.currentVersion)
		) {
			return false;
		}
		this.started = true;
		this.setState({ status: "checking" });
		void this.checkForUpdates();
		return true;
	}

	view(): DesktopUpdateState {
		return this.state;
	}

	async downloadAndOpen(): Promise<void> {
		if (this.downloadTask) return await this.downloadTask;
		if (this.state.status === "ready" && this.downloadedPath && this.manifest) {
			if (await verifiedFile(this.downloadedPath, this.manifest)) {
				await this.openDownloadedPath(this.downloadedPath);
				return;
			}
			this.downloadedPath = undefined;
			this.setState({ status: "available", version: this.manifest.version });
		}
		if (this.state.status !== "available" || !this.manifest) throw new Error("No desktop update is available");
		const task = this.downloadAndOpenAvailable(this.manifest);
		this.downloadTask = task;
		try {
			await task;
		} finally {
			if (this.downloadTask === task) this.downloadTask = undefined;
		}
	}

	private async checkForUpdates(): Promise<void> {
		try {
			const manifestUrl = new URL(`darwin/${this.options.arch}/latest.json`, this.baseUrl!).href;
			const response = await this.options.fetch(manifestUrl, { cache: "no-store" });
			if (!response.ok) throw new Error(`Update manifest request failed with ${response.status}`);
			const manifest = parseManifest(await response.json(), this.baseUrl!);
			if (compareStableVersions(manifest.version, this.options.currentVersion) <= 0) {
				this.setState({ status: "unavailable" });
				return;
			}
			this.manifest = manifest;
			this.setState({ status: "available", version: manifest.version });
		} catch {
			this.manifest = undefined;
			this.setState({ status: "unavailable" });
			this.options.onDiagnostic?.("Update check failed");
		}
	}

	private async downloadAndOpenAvailable(manifest: UpdateManifest): Promise<void> {
		const destination = join(
			this.options.downloadsDirectory,
			`Metis-${manifest.version}-darwin-${this.options.arch}.dmg`,
		);
		const partial = `${destination}.part`;
		try {
			await mkdir(this.options.downloadsDirectory, { recursive: true });
			if (!(await verifiedFile(destination, manifest))) {
				await rm(destination, { force: true });
				await rm(partial, { force: true });
				await this.download(manifest, partial);
				await rename(partial, destination);
			}
			if (!(await verifiedFile(destination, manifest))) {
				throw new Error("Downloaded update failed verification");
			}
			this.downloadedPath = destination;
			this.setState({ status: "ready", version: manifest.version });
			await this.openDownloadedPath(destination);
		} catch (error) {
			await rm(partial, { force: true }).catch(() => undefined);
			this.downloadedPath = undefined;
			this.setState({ status: "available", version: manifest.version });
			this.options.onDiagnostic?.("Update download failed");
			throw error;
		}
	}

	private async download(manifest: UpdateManifest, partial: string): Promise<void> {
		this.setState({ status: "downloading", version: manifest.version, progress: 0 });
		const response = await this.options.fetch(manifest.dmg.url, { cache: "no-store" });
		if (!response.ok || !response.body) throw new Error(`Update download failed with ${response.status}`);
		const contentLength = response.headers.get("content-length");
		if (contentLength !== null && Number(contentLength) !== manifest.dmg.size) {
			throw new Error("Downloaded update size does not match the release manifest");
		}

		const hash = createHash("sha256");
		const file = await open(partial, "w", 0o600);
		let received = 0;
		let lastProgress = 0;
		try {
			for await (const sourceChunk of response.body as unknown as AsyncIterable<Uint8Array>) {
				const chunk = Buffer.from(sourceChunk);
				received += chunk.byteLength;
				if (received > manifest.dmg.size) throw new Error("Downloaded update exceeds the release manifest size");
				hash.update(chunk);
				let offset = 0;
				while (offset < chunk.byteLength) {
					const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset, null);
					offset += bytesWritten;
				}
				const progress = Math.floor((received / manifest.dmg.size) * 100);
				if (progress !== lastProgress) {
					lastProgress = progress;
					this.setState({ status: "downloading", version: manifest.version, progress });
				}
			}
		} finally {
			await file.close();
		}
		if (received !== manifest.dmg.size || hash.digest("hex") !== manifest.dmg.sha256) {
			throw new Error("Downloaded update failed verification");
		}
	}

	private async openDownloadedPath(path: string): Promise<void> {
		const error = await this.options.openPath(path);
		if (error) throw new Error(error);
	}

	private setState(state: DesktopUpdateState): void {
		this.state = state;
		this.options.onState?.(state);
	}
}
