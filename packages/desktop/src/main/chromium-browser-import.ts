import { execFile } from "node:child_process";
import { createDecipheriv, createHash, pbkdf2Sync, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

const BROWSERS = [
	{
		sourceId: "chrome",
		name: "Google Chrome",
		directory: "Google/Chrome",
		processName: "Google Chrome",
		keychainService: "Chrome Safe Storage",
		keychainAccount: "Chrome",
	},
	{
		sourceId: "edge",
		name: "Microsoft Edge",
		directory: "Microsoft Edge",
		processName: "Microsoft Edge",
		keychainService: "Microsoft Edge Safe Storage",
		keychainAccount: "Microsoft Edge",
	},
	{
		sourceId: "brave",
		name: "Brave",
		directory: "BraveSoftware/Brave-Browser",
		processName: "Brave Browser",
		keychainService: "Brave Safe Storage",
		keychainAccount: "Brave",
	},
	{
		sourceId: "chromium",
		name: "Chromium",
		directory: "Chromium",
		processName: "Chromium",
		keychainService: "Chromium Safe Storage",
		keychainAccount: "Chromium",
	},
] as const;

type BrowserDescriptor = (typeof BROWSERS)[number];

export interface ImportedBrowserData {
	readonly cookies: readonly CookiesSetDetails[];
	readonly cookieSkipped: number;
	readonly history: readonly DesktopHistoryEntry[];
}

interface ChromiumBrowserImporterDependencies {
	readonly platform: NodeJS.Platform;
	readonly applicationSupportPath: string;
	readonly roots?: Partial<Record<DesktopBrowserSourceId, string>>;
	readonly isRunning: (processName: string) => Promise<boolean>;
	readonly readSafeStoragePassword: (browser: BrowserDescriptor) => Promise<string>;
}

async function processIsRunning(processName: string): Promise<boolean> {
	try {
		await execFileAsync("/usr/bin/pgrep", ["-x", processName]);
		return true;
	} catch (cause) {
		if ((cause as { code?: unknown }).code === 1) return false;
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

function parseLocalState(value: unknown, root: string): DesktopBrowserImportSource["profiles"] {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
	const profile = (value as { profile?: unknown }).profile;
	if (typeof profile !== "object" || profile === null || Array.isArray(profile)) return [];
	const cache = (profile as { info_cache?: unknown }).info_cache;
	if (typeof cache !== "object" || cache === null || Array.isArray(cache)) return [];
	const profiles: Array<DesktopBrowserImportSource["profiles"][number]> = [];
	for (const [sourceProfileId, metadata] of Object.entries(cache)) {
		try {
			validateBrowserSourceProfileId(sourceProfileId);
			if (!existsSync(join(root, sourceProfileId)) || typeof metadata !== "object" || metadata === null) continue;
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
	return profiles.sort((left, right) =>
		left.sourceProfileId === "Default"
			? -1
			: right.sourceProfileId === "Default"
				? 1
				: left.name.localeCompare(right.name),
	);
}

async function withDatabaseSnapshot<T>(source: string, run: (snapshot: string) => T): Promise<T> {
	const temporary = await mkdtemp(join(tmpdir(), "metis-browser-import-"));
	try {
		const target = join(temporary, basename(source));
		await copyFile(source, target);
		for (const suffix of ["-wal", "-shm"]) {
			await copyFile(`${source}${suffix}`, `${target}${suffix}`).catch(() => undefined);
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
			applicationSupportPath: join(homedir(), "Library", "Application Support"),
			isRunning: processIsRunning,
			readSafeStoragePassword: safeStoragePassword,
		},
	) {
		this.dependencies = dependencies;
	}

	async listSources(): Promise<readonly DesktopBrowserImportSource[]> {
		if (this.dependencies.platform !== "darwin") throw new Error("Browser import is available on macOS only");
		const sources: DesktopBrowserImportSource[] = [];
		for (const browser of BROWSERS) {
			const root = this.root(browser);
			if (!existsSync(join(root, "Local State"))) continue;
			let profiles: DesktopBrowserImportSource["profiles"];
			try {
				profiles = parseLocalState(JSON.parse(await readFile(join(root, "Local State"), "utf8")), root);
			} catch {
				continue;
			}
			if (profiles.length > 0) {
				sources.push({
					sourceId: browser.sourceId,
					name: browser.name,
					running: await this.dependencies.isRunning(browser.processName),
					profiles,
				});
			}
		}
		return sources;
	}

	async readProfile(input: DesktopBrowserImportInput): Promise<ImportedBrowserData> {
		const source = (await this.listSources()).find((candidate) => candidate.sourceId === input.sourceId);
		const sourceProfile = source?.profiles.find((candidate) => candidate.sourceProfileId === input.sourceProfileId);
		if (!source || !sourceProfile) throw new Error("Browser profile is no longer available");
		if (source.running) throw new Error(`Close ${source.name} before importing`);
		const browser = BROWSERS.find((candidate) => candidate.sourceId === input.sourceId)!;
		const profileRoot = join(this.root(browser), input.sourceProfileId);
		const history = input.dataTypes.history ? await this.readHistory(profileRoot) : [];
		const cookieData = input.dataTypes.cookies
			? await this.readCookies(browser, profileRoot)
			: { cookies: [], skipped: 0 };
		return { cookies: cookieData.cookies, cookieSkipped: cookieData.skipped, history };
	}

	private root(browser: BrowserDescriptor): string {
		return (
			this.dependencies.roots?.[browser.sourceId] ??
			join(this.dependencies.applicationSupportPath, browser.directory)
		);
	}

	private async readHistory(profileRoot: string): Promise<readonly DesktopHistoryEntry[]> {
		const source = join(profileRoot, "History");
		if (!existsSync(source)) return [];
		try {
			return await withDatabaseSnapshot(source, (snapshot) => {
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
		const networkPath = join(profileRoot, "Network", "Cookies");
		const source = existsSync(networkPath) ? networkPath : join(profileRoot, "Cookies");
		if (!existsSync(source)) return { cookies: [], skipped: 0 };
		const password = await this.dependencies.readSafeStoragePassword(browser);
		const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
		try {
			return await withDatabaseSnapshot(source, (snapshot) => {
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
