import { execFile } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync, randomUUID, timingSafeEqual } from "node:crypto";
import { createWriteStream, constants as fsConstants, lstatSync } from "node:fs";
import { mkdtemp, open, readdir, realpath, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join, relative as relativePath } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { CookiesSetDetails } from "electron";
import {
	type DesktopBrowserImportInput,
	type DesktopBrowserImportSource,
	type DesktopBrowserSourceId,
	type DesktopHistoryEntry,
	validateBrowserSourceProfileId,
} from "../shared/desktop-api.ts";

const execFileAsync = promisify(execFile);
const CHROMIUM_EPOCH_MICROSECONDS = 11_644_473_600_000_000n;

type BrowserImportPlatform = "darwin" | "win32";

const BROWSERS = [
	{
		sourceId: "chrome",
		name: "Google Chrome",
		directories: { darwin: "Google/Chrome", win32: "Google/Chrome/User Data" },
		processNames: { darwin: "Google Chrome", win32: "chrome.exe" },
		keychainService: "Chrome Safe Storage",
		keychainAccount: "Chrome",
	},
	{
		sourceId: "edge",
		name: "Microsoft Edge",
		directories: { darwin: "Microsoft Edge", win32: "Microsoft/Edge/User Data" },
		processNames: { darwin: "Microsoft Edge", win32: "msedge.exe" },
		keychainService: "Microsoft Edge Safe Storage",
		keychainAccount: "Microsoft Edge",
	},
	{
		sourceId: "brave",
		name: "Brave",
		directories: { darwin: "BraveSoftware/Brave-Browser", win32: "BraveSoftware/Brave-Browser/User Data" },
		processNames: { darwin: "Brave Browser", win32: "brave.exe" },
		keychainService: "Brave Safe Storage",
		keychainAccount: "Brave",
	},
	{
		sourceId: "chromium",
		name: "Chromium",
		directories: { darwin: "Chromium", win32: "Chromium/User Data" },
		processNames: { darwin: "Chromium", win32: "chromium.exe" },
		keychainService: "Chromium Safe Storage",
		keychainAccount: "Chromium",
	},
] as const;

type BrowserDescriptor = (typeof BROWSERS)[number];

type ImportStage = "root" | "local-state" | "profiles" | "process";

interface ImportFailure {
	readonly status: Exclude<ImportStatus, "ready">;
	readonly stage: ImportStage;
	readonly code: string;
}

type ImportStatus = NonNullable<DesktopBrowserImportSource["status"]>;
type ImportDiagnostic = NonNullable<DesktopBrowserImportSource["diagnostic"]>;

const DEFAULT_PROCESS_PROBE_TIMEOUT_MS = 2_000;

function isPermissionError(cause: unknown): boolean {
	const code = (cause as { code?: unknown } | null)?.code;
	return code === "EACCES" || code === "EPERM";
}

function isNotFoundError(cause: unknown): boolean {
	const code = (cause as { code?: unknown } | null)?.code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function errnoCode(cause: unknown): string {
	const code = (cause as { code?: unknown } | null)?.code;
	return typeof code === "string" && code !== "" ? code : "EIO";
}

export interface ImportedBrowserData {
	readonly cookies: readonly CookiesSetDetails[];
	readonly cookieSkipped: number;
	readonly history: readonly DesktopHistoryEntry[];
	/** Main-process-only identity, captured with the data rather than queried after the read. */
	readonly rootPath?: string;
}

interface ChromiumBrowserImporterDependencies {
	readonly platform: NodeJS.Platform;
	readonly dataDirectory: string;
	readonly roots?: Partial<Record<DesktopBrowserSourceId, string>>;
	readonly selectedRoots?: () => Partial<Record<DesktopBrowserSourceId, string>>;
	readonly isRunning: (processName: string) => Promise<boolean>;
	readonly readSafeStoragePassword: (browser: BrowserDescriptor) => Promise<string>;
	readonly processProbeTimeoutMs?: number;
}

function defaultBrowserDataDirectory(platform: NodeJS.Platform): string {
	if (platform === "darwin") return join(homedir(), "Library", "Application Support");
	if (platform === "win32") return process.env.LOCALAPPDATA ?? "";
	return "";
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
		timer.unref?.();
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(cause) => {
				clearTimeout(timer);
				reject(cause);
			},
		);
	});
}

async function processIsRunning(
	platform: BrowserImportPlatform,
	processName: string,
	timeoutMs: number,
): Promise<boolean> {
	try {
		if (platform === "win32") {
			const executable = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tasklist.exe");
			const { stdout } = await withTimeout(
				execFileAsync(executable, ["/FI", `IMAGENAME eq ${processName}`, "/FO", "CSV", "/NH"], {
					encoding: "utf8",
					windowsHide: true,
					timeout: timeoutMs,
				}),
				timeoutMs,
			);
			return stdout.toLowerCase().includes(`"${processName.toLowerCase()}"`);
		}
		await withTimeout(execFileAsync("/usr/bin/pgrep", ["-x", processName], { timeout: timeoutMs }), timeoutMs);
		return true;
	} catch (cause) {
		if (platform === "darwin" && (cause as { code?: unknown }).code === 1) return false;
		throw new Error("Browser process state could not be checked");
	}
}

async function safeStoragePassword(browser: BrowserDescriptor): Promise<string> {
	try {
		const { stdout } = await execFileAsync(
			"/usr/bin/security",
			["find-generic-password", "-w", "-a", browser.keychainAccount, "-s", browser.keychainService],
			{ encoding: "utf8" },
		);
		return stdout.trim();
	} catch {
		throw new Error("Browser cookie access was denied");
	}
}

function localStateSchema(value: unknown): value is { profile: { info_cache: Record<string, unknown> } } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const profile = (value as { profile?: unknown }).profile;
	if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return false;
	const cache = (profile as { info_cache?: unknown }).info_cache;
	return typeof cache === "object" && cache !== null && !Array.isArray(cache);
}

function parseLocalState(value: unknown, root: string): DesktopBrowserImportSource["profiles"] {
	if (!localStateSchema(value)) return [];
	const profiles: Array<DesktopBrowserImportSource["profiles"][number]> = [];
	for (const [sourceProfileId, metadata] of Object.entries(value.profile.info_cache)) {
		try {
			validateBrowserSourceProfileId(sourceProfileId);
			if (!existingProfileDirectory(root, sourceProfileId)) continue;
			if (typeof metadata !== "object" || metadata === null) continue;
			const record = metadata as Record<string, unknown>;
			const name = typeof record.name === "string" ? record.name.trim().slice(0, 128) : "";
			const email =
				typeof record.user_name === "string" && record.user_name.trim() !== ""
					? record.user_name.trim().slice(0, 320)
					: null;
			profiles.push({ sourceProfileId, name: name || sourceProfileId, email });
		} catch {
			// Ignore unsafe Local State entries.
		}
	}
	return sortProfiles(profiles).slice(0, 128);
}

function sortProfiles(profiles: Array<DesktopBrowserImportSource["profiles"][number]>) {
	return profiles.sort((left, right) =>
		left.sourceProfileId === "Default"
			? -1
			: right.sourceProfileId === "Default"
				? 1
				: left.name.localeCompare(right.name),
	);
}

const PROFILE_ID_PATTERN = /^(Default|Profile \d+)$/u;
const MAX_FALLBACK_PROFILES = 32;

function existingProfileDirectory(root: string, sourceProfileId: string): boolean {
	try {
		const candidate = join(root, sourceProfileId);
		// A linked profile can escape the selected root, so it is not eligible.
		return !lstatSync(candidate).isSymbolicLink() && lstatSync(candidate).isDirectory();
	} catch {
		return false;
	}
}

async function fallbackProfiles(root: string): Promise<DesktopBrowserImportSource["profiles"]> {
	const entries = await readdir(root, { withFileTypes: true });
	const profiles: Array<DesktopBrowserImportSource["profiles"][number]> = [];
	for (const entry of entries) {
		if (profiles.length === MAX_FALLBACK_PROFILES) break;
		// Never follow symlinks while recovering profile metadata.
		if (!entry.isDirectory() || entry.isSymbolicLink() || !PROFILE_ID_PATTERN.test(entry.name)) continue;
		profiles.push({ sourceProfileId: entry.name, name: entry.name, email: null });
	}
	return sortProfiles(profiles);
}

export interface TrustedBrowserRoot {
	readonly sourceId: DesktopBrowserSourceId;
	readonly path: string;
	readonly location: "selected";
}

export interface TrustedRootFailure {
	readonly reason:
		| "invalid-directory"
		| "not-a-chromium-root"
		| "profile-directory"
		| "permission-denied"
		| "unreadable";
	readonly code: string;
}

export type TrustedRootResult = TrustedBrowserRoot | TrustedRootFailure;

export function assertSourceReady(source: Pick<DesktopBrowserImportSource, "status">): void {
	if (source.status !== undefined && source.status !== "ready") {
		throw new Error("Browser import source is not available");
	}
}

export function isTrustedBrowserRoot(result: TrustedRootResult): result is TrustedBrowserRoot {
	return (result as TrustedRootFailure).reason === undefined;
}

/**
 * Accepts only a native-chooser-provided absolute directory. The stored path is
 * the directory's realpath, which must itself contain "Local State". A picked
 * profile folder is rejected rather than widened to its parent, and a renderer
 * path is never accepted because this only runs on the dialog result.
 */
export async function validateSelectedBrowserRoot(
	sourceId: DesktopBrowserSourceId,
	directory: string,
): Promise<TrustedRootResult> {
	if (typeof directory !== "string" || directory === "" || !isAbsolute(directory)) {
		return { reason: "invalid-directory", code: "ENOTDIR" };
	}
	let root: string;
	try {
		const stats = await stat(directory);
		if (!stats.isDirectory()) return { reason: "invalid-directory", code: "ENOTDIR" };
		root = await realpath(directory);
		if (!(await stat(root)).isDirectory()) return { reason: "invalid-directory", code: "ENOTDIR" };
	} catch (cause) {
		if (isNotFoundError(cause)) return { reason: "invalid-directory", code: errnoCode(cause) };
		if (isPermissionError(cause)) return { reason: "permission-denied", code: errnoCode(cause) };
		return { reason: "unreadable", code: errnoCode(cause) };
	}
	if (PROFILE_ID_PATTERN.test(basename(root))) return { reason: "profile-directory", code: "ENOTDIR" };
	try {
		await readLocalState(root);
	} catch (cause) {
		if (isNotFoundError(cause)) return { reason: "not-a-chromium-root", code: "ENOENT" };
		if (isPermissionError(cause)) return { reason: "permission-denied", code: errnoCode(cause) };
		return { reason: "unreadable", code: errnoCode(cause) };
	}
	return { sourceId, path: root, location: "selected" };
}

async function containedFile(profileRoot: string, name: string): Promise<string | null> {
	const candidate = join(profileRoot, name);
	let realRoot: string;
	let realFile: string;
	try {
		if (!lstatSync(candidate).isFile()) throw new Error("not a regular file");
		realRoot = await realpath(profileRoot);
		if (realRoot !== profileRoot) throw new Error("root changed");
		realFile = await realpath(candidate);
	} catch (cause) {
		if (isNotFoundError(cause)) return null;
		if (isPermissionError(cause)) throw cause;
		throw new Error("Browser profile data is outside the selected folder");
	}
	const relative = relativePath(realRoot, realFile);
	if (relative === "" || relative.startsWith("..") || isAbsolute(relative)) {
		throw new Error("Browser profile data is outside the selected folder");
	}
	return realFile;
}

async function openImportFile(root: string, name: string) {
	const path = await containedFile(root, name);
	if (path === null) return null;
	const expected = await stat(path);
	if (!expected.isFile() || (await containedFile(root, name)) !== path) {
		throw new Error("Browser profile data is outside the selected folder");
	}
	const handle = await open(
		path,
		fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
	);
	try {
		const actual = await handle.stat();
		if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) {
			throw new Error("Browser profile data changed while opening");
		}
		return { handle, path };
	} catch (cause) {
		await handle.close();
		throw cause;
	}
}

async function readLocalState(root: string): Promise<string> {
	const source = await openImportFile(root, "Local State");
	if (!source) throw Object.assign(new Error("Browser profile metadata is unavailable"), { code: "ENOENT" });
	try {
		return await source.handle.readFile({ encoding: "utf8" });
	} finally {
		await source.handle.close();
	}
}

async function copyImportFile(root: string, name: string, target: string): Promise<boolean> {
	const source = await openImportFile(root, name);
	if (!source) return false;
	try {
		await pipeline(
			source.handle.createReadStream({ autoClose: false }),
			createWriteStream(target, { flags: "wx", mode: 0o600 }),
		);
		if ((await containedFile(root, name)) !== source.path)
			throw new Error("Browser profile data changed while reading");
		return true;
	} finally {
		await source.handle.close();
	}
}

async function withDatabaseSnapshot<T>(profileRoot: string, name: string, run: (snapshot: string) => T): Promise<T> {
	const temporary = await mkdtemp(join(tmpdir(), "metis-browser-import-"));
	try {
		const target = join(temporary, basename(name));
		if (!(await copyImportFile(profileRoot, name, target))) throw new Error("Browser profile data is unavailable");
		for (const suffix of ["-wal", "-shm"]) {
			await copyImportFile(profileRoot, `${name}${suffix}`, `${target}${suffix}`);
		}
		return run(target);
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}

function chromiumMilliseconds(value: bigint): number {
	return Math.max(0, Number((value - CHROMIUM_EPOCH_MICROSECONDS) / 1_000n));
}

function chromiumSeconds(value: bigint): number {
	return Number((value - CHROMIUM_EPOCH_MICROSECONDS) / 1_000_000n);
}

function decryptCookie(encrypted: Buffer, key: Buffer, host: string, databaseVersion: number): string {
	if (encrypted.subarray(0, 3).toString() !== "v10") throw new Error("Unsupported Cookie encryption");
	const decipher = createDecipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
	const plaintext = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
	let value = plaintext;
	if (databaseVersion >= 24) {
		if (plaintext.length < 32) throw new Error("Invalid Cookie host hash");
		const expected = createHash("sha256").update(host).digest();
		if (!timingSafeEqual(plaintext.subarray(0, 32), expected)) throw new Error("Invalid Cookie host hash");
		value = plaintext.subarray(32);
	}
	return new TextDecoder("utf-8", { fatal: true }).decode(value);
}

export class ChromiumBrowserImporter {
	private readonly dependencies: ChromiumBrowserImporterDependencies;

	constructor(
		dependencies: ChromiumBrowserImporterDependencies = {
			platform: process.platform,
			dataDirectory: defaultBrowserDataDirectory(process.platform),
			isRunning: (processName) =>
				processIsRunning(process.platform as BrowserImportPlatform, processName, DEFAULT_PROCESS_PROBE_TIMEOUT_MS),
			readSafeStoragePassword: safeStoragePassword,
		},
	) {
		this.dependencies = dependencies;
	}

	async listSources(): Promise<readonly DesktopBrowserImportSource[]> {
		if (this.dependencies.platform !== "darwin" && this.dependencies.platform !== "win32") {
			throw new Error("Browser import is available on macOS and Windows only");
		}
		if (!this.dependencies.dataDirectory && !this.dependencies.roots && !this.dependencies.selectedRoots) {
			throw new Error("Browser data location is unavailable");
		}
		const sources = [];
		for (const browser of BROWSERS) sources.push(await this.listSource(browser));
		return sources.sort((left, right) => Number(right.status === "ready") - Number(left.status === "ready"));
	}

	async readProfile(input: DesktopBrowserImportInput): Promise<ImportedBrowserData> {
		if (this.dependencies.platform === "win32" && input.dataTypes.cookies) {
			throw new Error("Cookie import is not available on Windows");
		}
		validateBrowserSourceProfileId(input.sourceProfileId);
		const browser = BROWSERS.find((candidate) => candidate.sourceId === input.sourceId)!;
		const selection = this.rootSelection(browser);
		const expectedRoot = selection.location === "selected" ? selection.path : undefined;
		const probed = await this.probeRoot(selection.path, expectedRoot);
		if ("failure" in probed) throw new Error("Browser profile is no longer available");
		await this.containedProfileRoot(probed.root, input.sourceProfileId);
		const source = (await this.listSources()).find((candidate) => candidate.sourceId === input.sourceId);
		if (!source) throw new Error("Browser profile is no longer available");
		if (source.status === "process-check-failed") throw new Error(`Close ${source.name} before importing`);
		assertSourceReady(source);
		const sourceProfile = source.profiles.find((candidate) => candidate.sourceProfileId === input.sourceProfileId);
		if (!sourceProfile) throw new Error("Browser profile is no longer available");
		if (source.running) throw new Error(`Close ${source.name} before importing`);
		this.assertSelectionCurrent(browser, selection);
		const profileRoot = await this.containedProfileRoot(probed.root, input.sourceProfileId);
		const history = input.dataTypes.history ? await this.readHistory(profileRoot) : [];
		const cookieData = input.dataTypes.cookies
			? await this.readCookies(browser, profileRoot)
			: { cookies: [], skipped: 0 };
		const after = await this.probeRoot(selection.path, expectedRoot);
		this.assertSelectionCurrent(browser, selection);
		if (
			"failure" in after ||
			after.root !== probed.root ||
			(await this.containedProfileRoot(probed.root, input.sourceProfileId)) !== profileRoot
		) {
			throw new Error("Browser data folder changed during import. Check again before retrying.");
		}
		// Explicitly choosing the ordinary default folder keeps its legacy profile identity.
		const defaultRoot = await realpath(this.defaultRoot(browser)).catch(() => null);
		const rootPath = selection.location === "selected" && defaultRoot !== probed.root ? probed.root : undefined;
		return {
			cookies: cookieData.cookies,
			cookieSkipped: cookieData.skipped,
			history,
			...(rootPath ? { rootPath } : {}),
		};
	}

	async resolveImportDirectory(sourceId: DesktopBrowserSourceId, directory: string): Promise<string> {
		const result = await validateSelectedBrowserRoot(sourceId, directory);
		if (isTrustedBrowserRoot(result)) return result.path;
		switch (result.reason) {
			case "invalid-directory":
				throw new Error("Choose the browser's User Data folder");
			case "not-a-chromium-root":
				throw new Error("Choose the folder that contains Local State, not a profile folder");
			case "profile-directory":
				throw new Error("Choose the browser data folder that contains Local State, not a single profile");
			case "permission-denied":
				throw new Error("The selected browser data folder cannot be read");
			case "unreadable":
				throw new Error("The selected browser data folder could not be checked");
		}
	}

	private async listSource(browser: BrowserDescriptor): Promise<DesktopBrowserImportSource> {
		const { path: root, location } = this.rootSelection(browser);
		const probed = await this.probeRoot(root, location === "selected" ? root : undefined);
		if ("failure" in probed) return this.failedSource(browser, probed.failure, location, []);
		return { ...(await this.probeProfiles(browser, probed.root)), location };
	}

	private failedSource(
		browser: BrowserDescriptor,
		failure: ImportFailure,
		location: "default" | "selected",
		profiles: DesktopBrowserImportSource["profiles"],
	): DesktopBrowserImportSource {
		return {
			sourceId: browser.sourceId,
			name: browser.name,
			running: false,
			profiles,
			status: failure.status,
			diagnostic: { stage: failure.stage, code: failure.code },
			location,
		};
	}

	private async probeRoot(
		root: string,
		expectedRoot?: string,
	): Promise<{ root: string } | { failure: ImportFailure }> {
		try {
			const stats = await stat(root);
			if (!stats.isDirectory()) return { failure: { status: "not-found", stage: "root", code: "ENOTDIR" } };
			// A symlinked root can escape the folder the user chose; realpath only
			// canonicalizes a real directory (for example /var to /private/var).
			if (lstatSync(root).isSymbolicLink())
				return { failure: { status: "unreadable", stage: "root", code: "EINVAL" } };
			const real = await realpath(root);
			if (expectedRoot !== undefined && real !== expectedRoot)
				return { failure: { status: "unreadable", stage: "root", code: "EINVAL" } };
			if (!(await stat(real)).isDirectory())
				return { failure: { status: "unreadable", stage: "root", code: "EINVAL" } };
			return { root: real };
		} catch (cause) {
			if (isNotFoundError(cause)) return { failure: { status: "not-found", stage: "root", code: errnoCode(cause) } };
			if (isPermissionError(cause)) {
				return { failure: { status: "permission-denied", stage: "root", code: errnoCode(cause) } };
			}
			return { failure: { status: "unreadable", stage: "root", code: errnoCode(cause) } };
		}
	}

	private async probeProfiles(
		browser: BrowserDescriptor,
		root: string,
	): Promise<
		Pick<DesktopBrowserImportSource, "sourceId" | "name" | "running" | "profiles" | "status" | "diagnostic">
	> {
		let profiles: DesktopBrowserImportSource["profiles"];
		let diagnostic: ImportDiagnostic | undefined;
		try {
			if (!lstatSync(join(root, "Local State")).isFile()) {
				return this.failedSource(
					browser,
					{ status: "unreadable", stage: "local-state", code: "EINVAL" },
					"default",
					[],
				);
			}
			const raw = await readLocalState(root);
			let parsed: unknown;
			try {
				parsed = JSON.parse(raw);
			} catch {
				diagnostic = { stage: "local-state", code: "invalid-json" };
				parsed = undefined;
			}
			if (parsed !== undefined && !localStateSchema(parsed)) {
				diagnostic = { stage: "local-state", code: "invalid-schema" };
			}
			profiles = diagnostic ? [] : parseLocalState(parsed, root);
		} catch (cause) {
			if (isPermissionError(cause)) {
				return this.failedSource(
					browser,
					{ status: "permission-denied", stage: "local-state", code: errnoCode(cause) },
					"default",
					[],
				);
			}
			if (!isNotFoundError(cause)) {
				return this.failedSource(
					browser,
					{ status: "unreadable", stage: "local-state", code: errnoCode(cause) },
					"default",
					[],
				);
			}
			diagnostic = { stage: "local-state", code: "ENOENT" };
			profiles = [];
		}
		if (profiles.length === 0) {
			// Missing or incompatible metadata can still expose real profile
			// directories; discovery never reads cookie or history contents.
			try {
				profiles = await fallbackProfiles(root);
			} catch (cause) {
				return this.failedSource(
					browser,
					{
						status: isPermissionError(cause) ? "permission-denied" : "unreadable",
						stage: "profiles",
						code: errnoCode(cause),
					},
					"default",
					[],
				);
			}
			if (profiles.length === 0) {
				return this.failedSource(
					browser,
					{
						status: diagnostic ? "invalid-metadata" : "no-profiles",
						stage: diagnostic?.stage ?? "profiles",
						code: diagnostic?.code ?? "ENOENT",
					},
					"default",
					[],
				);
			}
		}
		let running: boolean;
		try {
			running = await withTimeout(
				this.dependencies.isRunning(browser.processNames[this.dependencies.platform as BrowserImportPlatform]),
				this.dependencies.processProbeTimeoutMs ?? DEFAULT_PROCESS_PROBE_TIMEOUT_MS,
			);
		} catch {
			return {
				...this.failedSource(
					browser,
					{ status: "process-check-failed", stage: "process", code: "EAGAIN" },
					"default",
					profiles,
				),
				diagnostic: { stage: "process", code: "EAGAIN" },
			};
		}
		return {
			sourceId: browser.sourceId,
			name: browser.name,
			running,
			profiles,
			status: "ready",
			...(diagnostic ? { diagnostic } : {}),
		};
	}

	private rootSelection(browser: BrowserDescriptor): { path: string; location: "default" | "selected" } {
		const selected = this.dependencies.selectedRoots?.()[browser.sourceId];
		// A remembered path is not a permission grant; later reads report the real errno.
		if (selected && isAbsolute(selected) && !selected.includes("\0")) {
			return { path: selected, location: "selected" };
		}
		return {
			path: this.defaultRoot(browser),
			location: "default",
		};
	}

	private defaultRoot(browser: BrowserDescriptor): string {
		return (
			this.dependencies.roots?.[browser.sourceId] ??
			join(this.dependencies.dataDirectory, browser.directories[this.dependencies.platform as BrowserImportPlatform])
		);
	}

	private assertSelectionCurrent(browser: BrowserDescriptor, selection: { path: string; location: string }): void {
		const current = this.rootSelection(browser);
		if (current.path !== selection.path || current.location !== selection.location) {
			throw new Error("Browser data folder changed during import. Check again before retrying.");
		}
	}

	private async containedProfileRoot(root: string, sourceProfileId: string): Promise<string> {
		let realRoot: string;
		let realProfile: string;
		try {
			realRoot = await realpath(root);
			realProfile = await realpath(join(root, sourceProfileId));
		} catch {
			throw new Error("Browser profile is no longer available");
		}
		const relative = relativePath(realRoot, realProfile);
		if (relative === "" || relative.startsWith("..") || isAbsolute(relative)) {
			throw new Error("Browser profile is outside the selected data folder");
		}
		const stats = await stat(realProfile);
		if (!stats.isDirectory()) throw new Error("Browser profile is no longer available");
		return realProfile;
	}

	private async readHistory(profileRoot: string): Promise<readonly DesktopHistoryEntry[]> {
		if (!(await containedFile(profileRoot, "History"))) return [];
		try {
			return await withDatabaseSnapshot(profileRoot, "History", (snapshot) => {
				const database = new DatabaseSync(snapshot, { readOnly: true });
				try {
					const statement = database.prepare(
						"SELECT url, title, last_visit_time FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC",
					);
					statement.setReadBigInts(true);
					const history: DesktopHistoryEntry[] = [];
					const seen = new Set<string>();
					for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
						try {
							const url = new URL(String(row.url)).toString();
							if ((new URL(url).protocol !== "http:" && new URL(url).protocol !== "https:") || seen.has(url))
								continue;
							seen.add(url);
							history.push({
								entryId: randomUUID(),
								url,
								title:
									String(row.title ?? "")
										.trim()
										.slice(0, 512) || url,
								faviconUrl: null,
								visitedAt: chromiumMilliseconds(BigInt(row.last_visit_time as bigint)),
							});
							if (history.length === 500) break;
						} catch {
							// Skip malformed source rows.
						}
					}
					return history;
				} finally {
					database.close();
				}
			});
		} catch {
			throw new Error("Browser history could not be read");
		}
	}

	private async readCookies(
		browser: BrowserDescriptor,
		profileRoot: string,
	): Promise<{ cookies: readonly CookiesSetDetails[]; skipped: number }> {
		const name = (await containedFile(profileRoot, join("Network", "Cookies")))
			? join("Network", "Cookies")
			: "Cookies";
		if (!(await containedFile(profileRoot, name))) return { cookies: [], skipped: 0 };
		// Reject unsafe sidecars before a Keychain prompt; the snapshot rechecks before copying.
		for (const suffix of ["-wal", "-shm"]) await containedFile(profileRoot, `${name}${suffix}`);
		const password = await this.dependencies.readSafeStoragePassword(browser);
		const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
		try {
			return await withDatabaseSnapshot(profileRoot, name, (snapshot) => {
				const database = new DatabaseSync(snapshot, { readOnly: true });
				try {
					const version = Number(
						(
							database.prepare("SELECT value FROM meta WHERE key = 'version'").get() as
								| { value?: unknown }
								| undefined
						)?.value ?? 0,
					);
					const columns = new Set(
						(database.prepare("PRAGMA table_info(cookies)").all() as Array<{ name?: unknown }>).map((column) =>
							String(column.name),
						),
					);
					const topFrame = columns.has("top_frame_site_key") ? "top_frame_site_key" : "'' AS top_frame_site_key";
					const statement = database.prepare(
						`SELECT host_key, ${topFrame}, name, value, encrypted_value, path, expires_utc, is_secure, is_httponly, has_expires, samesite FROM cookies`,
					);
					statement.setReadBigInts(true);
					const cookies: CookiesSetDetails[] = [];
					let skipped = 0;
					for (const row of statement.iterate() as Iterable<Record<string, unknown>>) {
						try {
							if (String(row.top_frame_site_key ?? "") !== "") throw new Error("Partitioned Cookie");
							const hostKey = String(row.host_key ?? "");
							const host = hostKey.replace(/^\./u, "");
							const secure = Boolean(Number(row.is_secure));
							const url = new URL(`${secure ? "https" : "http"}://${host}/`).toString();
							const hasExpires = Boolean(Number(row.has_expires));
							const expirationDate = chromiumSeconds(BigInt(row.expires_utc as bigint));
							if (hasExpires && expirationDate <= Date.now() / 1_000) throw new Error("Expired Cookie");
							const plain = String(row.value ?? "");
							const value =
								plain || decryptCookie(Buffer.from(row.encrypted_value as Uint8Array), key, hostKey, version);
							const sameSite =
								({ 0: "no_restriction", 1: "lax", 2: "strict" } as const)[Number(row.samesite) as 0 | 1 | 2] ??
								"unspecified";
							cookies.push({
								url,
								name: String(row.name ?? "").slice(0, 4_096),
								value,
								...(hostKey.startsWith(".") ? { domain: hostKey } : {}),
								path: String(row.path || "/").startsWith("/") ? String(row.path || "/") : "/",
								secure,
								httpOnly: Boolean(Number(row.is_httponly)),
								...(hasExpires ? { expirationDate } : {}),
								sameSite,
							});
						} catch {
							skipped += 1;
						}
					}
					return { cookies, skipped };
				} finally {
					database.close();
				}
			});
		} catch (cause) {
			if (cause instanceof Error && cause.message === "Browser cookie access was denied") throw cause;
			throw new Error("Browser cookies could not be read");
		}
	}
}

export function createChromiumBrowserImporter(
	selectedRoots?: () => Partial<Record<DesktopBrowserSourceId, string>>,
): ChromiumBrowserImporter {
	return new ChromiumBrowserImporter({
		platform: process.platform,
		dataDirectory: defaultBrowserDataDirectory(process.platform),
		...(selectedRoots ? { selectedRoots } : {}),
		isRunning: (processName) =>
			processIsRunning(process.platform as BrowserImportPlatform, processName, DEFAULT_PROCESS_PROBE_TIMEOUT_MS),
		readSafeStoragePassword: safeStoragePassword,
	});
}
