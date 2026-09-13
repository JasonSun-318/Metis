import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { DESKTOP_RELEASE_NOTES_MAX_CHARACTERS, type DesktopUpdateState } from "../shared/desktop-api.ts";

interface UpdateManifest {
	readonly version: string;
	readonly releaseNotes: string;
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
	readonly checkIntervalMs?: number;
}

const MAX_DMG_BYTES = 4 * 1024 * 1024 * 1024;
const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

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
	let releaseNotes = "";
	if (record.releaseNotes !== undefined) {
		if (typeof record.releaseNotes !== "string") throw new Error("Invalid update manifest");
		releaseNotes = record.releaseNotes.trim();
		if (!releaseNotes || releaseNotes.length > DESKTOP_RELEASE_NOTES_MAX_CHARACTERS) {
			throw new Error("Invalid update manifest");
		}
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
		releaseNotes,
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
	private checkTask?: Promise<void>;
	private started = false;
	private checkTimer?: ReturnType<typeof setInterval>;

	constructor(options: DesktopUpdaterOptions) {
		this.options = options;
		this.baseUrl = trustedBaseUrl(options.baseUrl);
	}

	isSupported(): boolean {
		return Boolean(
			this.options.isPackaged &&
				this.options.platform === "darwin" &&
				["arm64", "x64"].includes(this.options.arch) &&
				this.baseUrl &&
				versionParts(this.options.currentVersion),
		);
	}

	start(): boolean {
		if (this.started) return true;
		if (!this.isSupported()) return false;
		this.started = true;
		this.setState({ status: "checking" });
		void this.checkForUpdates().catch(() => undefined);
		const interval = this.options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
		if (interval > 0) {
			this.checkTimer = setInterval(() => void this.checkForUpdates().catch(() => undefined), interval);
			this.checkTimer.unref?.();
		}
		return true;
	}

	stop(): void {
		if (!this.checkTimer) return;
		clearInterval(this.checkTimer);
		this.checkTimer = undefined;
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
			this.setState({
				status: "available",
				version: this.manifest.version,
				releaseNotes: this.manifest.releaseNotes,
			});
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

	async checkForUpdate(): Promise<DesktopUpdateState> {
		if (!this.isSupported()) throw new Error("Update checks are unavailable in this build");
		await this.checkForUpdates();
		return this.view();
	}

	private async checkForUpdates(): Promise<void> {
		if (this.downloadTask || this.state.status === "downloading") return;
		if (this.checkTask) return await this.checkTask;
		const task = this.performCheck();
		this.checkTask = task;
		try {
			await task;
		} finally {
			if (this.checkTask === task) this.checkTask = undefined;
		}
	}

	private async performCheck(): Promise<void> {
		try {
			const manifestUrl = new URL(`darwin/${this.options.arch}/latest.json`, this.baseUrl!).href;
			const response = await this.options.fetch(manifestUrl, {
				cache: "no-store",
				signal: AbortSignal.timeout(15_000),
			});
			if (!response.ok) throw new Error(`Update manifest request failed with ${response.status}`);
			const manifest = parseManifest(await response.json(), this.baseUrl!);
			if (this.downloadTask || this.state.status === "downloading") {
				return;
			}
			if (compareStableVersions(manifest.version, this.options.currentVersion) <= 0) {
				if (this.state.status !== "ready") {
					this.manifest = undefined;
					this.setState({ status: "unavailable" });
				}
				return;
			}
			if (this.state.status === "ready" && this.manifest) {
				const comparison = compareStableVersions(manifest.version, this.manifest.version);
				if (comparison <= 0) return;
			}
			this.manifest = manifest;
			this.downloadedPath = undefined;
			this.setState({
				status: "available",
				version: manifest.version,
				releaseNotes: manifest.releaseNotes,
			});
		} catch (error) {
			this.options.onDiagnostic?.("Update check failed");
			if (this.state.status === "checking") {
				this.manifest = undefined;
				this.setState({ status: "unavailable" });
			}
			throw error;
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
			this.manifest = manifest;
			this.downloadedPath = destination;
			this.setState({
				status: "ready",
				version: manifest.version,
				releaseNotes: manifest.releaseNotes,
			});
			await this.openDownloadedPath(destination);
		} catch (error) {
			await rm(partial, { force: true }).catch(() => undefined);
			this.downloadedPath = undefined;
			this.manifest = manifest;
			this.setState({
				status: "available",
				version: manifest.version,
				releaseNotes: manifest.releaseNotes,
			});
			this.options.onDiagnostic?.("Update download failed");
			throw error;
		}
	}

	private async download(manifest: UpdateManifest, partial: string): Promise<void> {
		this.setState({
			status: "downloading",
			version: manifest.version,
			releaseNotes: manifest.releaseNotes,
			progress: 0,
		});
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
					this.setState({
						status: "downloading",
						version: manifest.version,
						releaseNotes: manifest.releaseNotes,
						progress,
					});
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
