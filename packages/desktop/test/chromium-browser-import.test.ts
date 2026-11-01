import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromiumBrowserImporter } from "../src/main/chromium-browser-import.ts";

const CHROMIUM_EPOCH_MICROSECONDS = 11_644_473_600_000_000n;

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

const WINDOWS_BROWSERS = [
	{ sourceId: "chrome", directory: "Google/Chrome/User Data", processName: "chrome.exe" },
	{ sourceId: "edge", directory: "Microsoft/Edge/User Data", processName: "msedge.exe" },
	{ sourceId: "brave", directory: "BraveSoftware/Brave-Browser/User Data", processName: "brave.exe" },
	{ sourceId: "chromium", directory: "Chromium/User Data", processName: "chromium.exe" },
] as const;

async function writeProfileRoot(root: string): Promise<void> {
	await mkdir(join(root, "Default"), { recursive: true });
	await writeFile(
		join(root, "Local State"),
		JSON.stringify({ profile: { info_cache: { Default: { name: "Personal", user_name: "person@example.com" } } } }),
	);
}

async function fixture(options: { running?: boolean; platform?: NodeJS.Platform } = {}) {
	const root = await mkdtemp(join(tmpdir(), "metis-chromium-source-"));
	temporaryDirectories.push(root);
	const profile = join(root, "Default");
	await mkdir(join(profile, "Network"), { recursive: true });
	await writeFile(
		join(root, "Local State"),
		JSON.stringify({
			profile: { info_cache: { Default: { name: "Personal", user_name: "person@example.com" } } },
		}),
	);
	const readSafeStoragePassword = vi.fn(async () => "fixture-password");
	const importer = new ChromiumBrowserImporter({
		platform: options.platform ?? "darwin",
		dataDirectory: join(root, "missing"),
		roots: { chrome: root },
		isRunning: vi.fn(async () => options.running ?? false),
		readSafeStoragePassword,
	});
	return { importer, profile, readSafeStoragePassword, root };
}

function encryptedCookie(host: string, value: string, password = "fixture-password"): Buffer {
	const key = pbkdf2Sync(password, "saltysalt", 1003, 16, "sha1");
	const cipher = createCipheriv("aes-128-cbc", key, Buffer.alloc(16, 0x20));
	const payload = Buffer.concat([createHash("sha256").update(host).digest(), Buffer.from(value)]);
	return Buffer.concat([Buffer.from("v10"), cipher.update(payload), cipher.final()]);
}

function writeHistoryDatabase(path: string) {
	const database = new DatabaseSync(path);
	try {
		database.exec("CREATE TABLE urls (url TEXT, title TEXT, last_visit_time INTEGER, hidden INTEGER DEFAULT 0)");
		database
			.prepare("INSERT INTO urls VALUES (?, ?, ?, 0)")
			.run("https://fixture.example/", "Fixture", 13_380_163_200_000_000n);
	} finally {
		database.close();
	}
}

function writeCookieDatabase(path: string) {
	const database = new DatabaseSync(path);
	try {
		database.exec(`
			CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
			INSERT INTO meta VALUES ('version', '24');
			CREATE TABLE cookies (
				host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT,
				expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, has_expires INTEGER, samesite INTEGER
			);
		`);
	} finally {
		database.close();
	}
}

describe("ChromiumBrowserImporter", () => {
	it("reports every supported browser with diagnostics instead of swallowing discovery errors", async () => {
		const dataDirectory = await mkdtemp(join(tmpdir(), "metis-browser-discovery-"));
		temporaryDirectories.push(dataDirectory);
		const chrome = join(dataDirectory, "Google/Chrome");
		const edge = join(dataDirectory, "Microsoft Edge");
		const brave = join(dataDirectory, "BraveSoftware/Brave-Browser");
		const chromium = join(dataDirectory, "Chromium");
		await mkdir(chrome, { recursive: true });
		await writeFile(join(chrome, "Local State"), "{not-json", "utf8");
		await mkdir(edge, { recursive: true });
		await writeFile(join(edge, "Local State"), JSON.stringify({ profile: { info_cache: {} } }), "utf8");
		await mkdir(brave, { recursive: true });
		await writeFile(join(brave, "Local State"), JSON.stringify({ profile: { info_cache: {} } }), "utf8");
		await writeProfileRoot(chromium);
		const isRunning = vi.fn(async () => false);
		const importer = new ChromiumBrowserImporter({
			platform: "darwin",
			dataDirectory,
			isRunning,
			readSafeStoragePassword: vi.fn(async () => "unused"),
		});

		const sources = await importer.listSources();
		expect(sources.map((source) => source.sourceId)).toEqual(["chromium", "chrome", "edge", "brave"]);
		expect(sources.find((source) => source.sourceId === "chromium")).toMatchObject({ status: "ready" });
		expect(sources.find((source) => source.sourceId === "chrome")).toMatchObject({
			status: "invalid-metadata",
			diagnostic: { stage: "local-state", code: "invalid-json" },
		});
		expect(sources.find((source) => source.sourceId === "edge")).toMatchObject({
			status: "no-profiles",
			diagnostic: { stage: "profiles", code: "ENOENT" },
		});
		expect(sources.find((source) => source.sourceId === "brave")).toMatchObject({
			status: "no-profiles",
			diagnostic: { stage: "profiles", code: "ENOENT" },
		});
		expect(JSON.stringify(sources)).not.toMatch(/cookie|password|secret/iu);
		expect(isRunning).toHaveBeenCalledOnce();
	});

	it("reports a permission-denied Local State with diagnostics instead of swallowing discovery errors", async () => {
		const dataDirectory = await mkdtemp(join(tmpdir(), "metis-browser-denied-"));
		temporaryDirectories.push(dataDirectory);
		const brave = join(dataDirectory, "BraveSoftware/Brave-Browser");
		await mkdir(brave, { recursive: true });
		const lockedPath = join(brave, "Local State");
		await writeFile(lockedPath, "{}", "utf8");
		// probeRoot canonicalizes the root before opening, so match both spellings.
		const lockedReal = await realpath(lockedPath);
		// chmod-based fixtures are not portable (Windows ignores the mode); inject
		// the exact EACCES fault on the one path under test instead.
		vi.doMock("node:fs/promises", async (importOriginal) => {
			const actual = await importOriginal<typeof import("node:fs/promises")>();
			return {
				...actual,
				open: async (path: unknown, flags?: unknown, mode?: unknown) => {
					if (path === lockedPath || path === lockedReal) {
						throw Object.assign(new Error("EACCES: permission denied, open"), { code: "EACCES" });
					}
					return actual.open(path as Parameters<typeof actual.open>[0], flags as never, mode as never);
				},
			};
		});
		try {
			// The class is statically imported above; reset the registry so the
			// dynamic import re-evaluates it against the mocked fs module.
			vi.resetModules();
			const { ChromiumBrowserImporter: FaultedImporter } = await import("../src/main/chromium-browser-import.ts");
			const importer = new FaultedImporter({
				platform: "darwin",
				dataDirectory,
				roots: { brave },
				isRunning: vi.fn(async () => false),
				readSafeStoragePassword: vi.fn(async () => "unused"),
			});
			const sources = await importer.listSources();
			expect(sources.find((source) => source.sourceId === "brave")).toMatchObject({
				status: "permission-denied",
				diagnostic: { stage: "local-state", code: "EACCES" },
			});
			expect(JSON.stringify(sources)).not.toMatch(/cookie|password|secret/iu);
		} finally {
			vi.doUnmock("node:fs/promises");
			vi.resetModules();
		}
	});

	it("distinguishes a missing default root from a metadata failure", async () => {
		const dataDirectory = await mkdtemp(join(tmpdir(), "metis-browser-missing-"));
		temporaryDirectories.push(dataDirectory);
		const importer = new ChromiumBrowserImporter({
			platform: "darwin",
			dataDirectory,
			isRunning: vi.fn(async () => false),
			readSafeStoragePassword: vi.fn(async () => "unused"),
		});
		const sources = await importer.listSources();
		expect(sources).toHaveLength(4);
		expect(sources.every((source) => source.status === "not-found" && source.diagnostic?.stage === "root")).toBe(
			true,
		);
	});

	it("recovers profile directories when metadata is incompatible but readable", async () => {
		const dataDirectory = await mkdtemp(join(tmpdir(), "metis-browser-fallback-"));
		temporaryDirectories.push(dataDirectory);
		const root = join(dataDirectory, "Google/Chrome");
		await mkdir(join(root, "Profile 2"), { recursive: true });
		await writeFile(join(root, "Local State"), JSON.stringify({ profile: {} }), "utf8");
		const importer = new ChromiumBrowserImporter({
			platform: "darwin",
			dataDirectory,
			isRunning: vi.fn(async () => false),
			readSafeStoragePassword: vi.fn(async () => "unused"),
		});
		const [chrome] = await importer.listSources();
		expect(chrome).toMatchObject({
			sourceId: "chrome",
			status: "ready",
			diagnostic: { stage: "local-state", code: "invalid-schema" },
			profiles: [{ sourceProfileId: "Profile 2", name: "Profile 2", email: null }],
		});
	});

	it("keeps discovered profiles when the process probe fails or times out", async () => {
		const { importer } = await fixture();
		const failing = new ChromiumBrowserImporter({
			platform: "darwin",
			dataDirectory: join(tmpdir(), "unused"),
			roots: { chrome: (await fixture()).root },
			isRunning: vi.fn(async () => {
				throw new Error("probe failed");
			}),
			readSafeStoragePassword: vi.fn(async () => "unused"),
		});
		const timedOut = new ChromiumBrowserImporter({
			platform: "darwin",
			dataDirectory: join(tmpdir(), "unused"),
			roots: { chrome: (await fixture()).root },
			processProbeTimeoutMs: 20,
			isRunning: vi.fn(() => new Promise<boolean>(() => undefined)),
			readSafeStoragePassword: vi.fn(async () => "unused"),
		});
		await expect(failing.listSources()).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					sourceId: "chrome",
					status: "process-check-failed",
					diagnostic: { stage: "process", code: "EAGAIN" },
					profiles: [expect.objectContaining({ sourceProfileId: "Default" })],
				}),
			]),
		);
		await expect(timedOut.listSources()).resolves.toEqual(
			expect.arrayContaining([expect.objectContaining({ sourceId: "chrome", status: "process-check-failed" })]),
		);
		await expect(
			failing.readProfile({
				sourceId: "chrome",
				sourceProfileId: "Default",
				dataTypes: { cookies: false, history: true },
			}),
		).rejects.toThrow("Close Google Chrome before importing");
		expect(importer).toBeDefined();
	});

	it("ignores unsafe profile entries before applying the profile cap", async () => {
		const dataDirectory = await mkdtemp(join(tmpdir(), "metis-browser-cap-"));
		temporaryDirectories.push(dataDirectory);
		const root = join(dataDirectory, "Google/Chrome");
		await mkdir(root, { recursive: true });
		const cache: Record<string, unknown> = { "Not A Profile": { name: "Ignored" } };
		for (let index = 1; index <= 40; index += 1) cache[`Profile ${index}`] = { name: `Profile ${index}` };
		await mkdir(join(root, "Profile 40"), { recursive: true });
		await writeFile(join(root, "Local State"), JSON.stringify({ profile: { info_cache: cache } }), "utf8");
		const importer = new ChromiumBrowserImporter({
			platform: "darwin",
			dataDirectory,
			isRunning: vi.fn(async () => false),
			readSafeStoragePassword: vi.fn(async () => "unused"),
		});
		const [chrome] = await importer.listSources();
		expect(chrome).toMatchObject({ status: "ready", profiles: [{ sourceProfileId: "Profile 40" }] });
		await expect(importer.resolveImportDirectory("chrome", "relative/Chrome")).rejects.toThrow("User Data folder");
	});

	it("rejects a picked profile folder instead of widening it to the parent root", async () => {
		const { importer, root } = await fixture();
		await expect(importer.resolveImportDirectory("chrome", join(root, "Default"))).rejects.toThrow(
			"not a single profile",
		);
		await expect(importer.resolveImportDirectory("chrome", root)).resolves.toBe(await realpath(root));
	});

	it("stores the real path and rejects a symlinked root or profile that escapes it", async () => {
		const { root } = await fixture();
		const outside = await mkdtemp(join(tmpdir(), "metis-browser-outside-"));
		temporaryDirectories.push(outside);
		await writeProfileRoot(outside);
		const alias = await mkdtemp(join(tmpdir(), "metis-browser-alias-"));
		temporaryDirectories.push(alias);
		const linkedRoot = join(alias, "Chrome");
		await symlink(root, linkedRoot);
		const importer = new ChromiumBrowserImporter({
			platform: "darwin",
			dataDirectory: join(root, "missing"),
			isRunning: vi.fn(async () => false),
			readSafeStoragePassword: vi.fn(async () => "unused"),
		});
		await expect(importer.resolveImportDirectory("chrome", linkedRoot)).resolves.toBe(await realpath(root));
		const linkedProfile = join(root, "Profile 7");
		await symlink(join(outside, "Default"), linkedProfile);
		const selectedRoot = await realpath(root);
		const selected = new ChromiumBrowserImporter({
			platform: "darwin",
			dataDirectory: join(root, "missing"),
			selectedRoots: () => ({ chrome: selectedRoot }),
			isRunning: vi.fn(async () => false),
			readSafeStoragePassword: vi.fn(async () => "unused"),
		});
		await expect(
			selected.readProfile({
				sourceId: "chrome",
				sourceProfileId: "Profile 7",
				dataTypes: { cookies: false, history: true },
			}),
		).rejects.toThrow("outside the selected data folder");
	});

	it("rejects a database or Local State symlink that leaves the selected root", async () => {
		const { importer, profile, root } = await fixture();
		const outside = await mkdtemp(join(tmpdir(), "metis-browser-history-outside-"));
		temporaryDirectories.push(outside);
		const escaped = join(outside, "History");
		await writeFile(escaped, "not-a-database");
		await symlink(escaped, join(profile, "History"));
		await expect(
			importer.readProfile({
				sourceId: "chrome",
				sourceProfileId: "Default",
				dataTypes: { cookies: false, history: true },
			}),
		).rejects.toThrow("outside the selected folder");
		const linkedState = join(root, "Local State");
		await rm(linkedState);
		await symlink(escaped, linkedState);
		await expect(importer.resolveImportDirectory("chrome", root)).rejects.toThrow("could not be checked");
	});

	it("rejects a remembered canonical root when an ancestor now links to another browser folder", async () => {
		const base = await mkdtemp(join(tmpdir(), "metis-browser-root-drift-"));
		temporaryDirectories.push(base);
		const parent = join(base, "authorized");
		const replacement = join(base, "replacement");
		await writeProfileRoot(join(parent, "Chrome"));
		await writeProfileRoot(join(replacement, "Chrome"));
		const selectedRoot = await realpath(join(parent, "Chrome"));
		await rename(parent, join(base, "previous"));
		await symlink(replacement, parent, "dir");
		const readSafeStoragePassword = vi.fn(async () => "unused");
		const importer = new ChromiumBrowserImporter({
			platform: "darwin",
			dataDirectory: join(base, "missing"),
			selectedRoots: () => ({ chrome: selectedRoot }),
			isRunning: vi.fn(async () => false),
			readSafeStoragePassword,
		});
		const chrome = (await importer.listSources()).find((source) => source.sourceId === "chrome");
		expect(chrome).toMatchObject({
			status: "unreadable",
			diagnostic: { stage: "root", code: "EINVAL" },
			profiles: [],
		});
		await expect(
			importer.readProfile({
				sourceId: "chrome",
				sourceProfileId: "Default",
				dataTypes: { cookies: true, history: true },
			}),
		).rejects.toThrow("Browser profile is no longer available");
		expect(readSafeStoragePassword).not.toHaveBeenCalled();
	});

	it.each(["process check", "cookie access"] as const)(
		"rejects a selected-root change during %s instead of returning data with a different identity",
		async (stage) => {
			const first = await fixture();
			const second = await fixture();
			const firstRoot = await realpath(first.root);
			const secondRoot = await realpath(second.root);
			let selectedRoot = firstRoot;
			writeHistoryDatabase(join(first.profile, "History"));
			writeCookieDatabase(join(first.profile, "Network", "Cookies"));
			const readSafeStoragePassword = vi.fn(async () => {
				if (stage === "cookie access") selectedRoot = secondRoot;
				return "fixture-password";
			});
			const importer = new ChromiumBrowserImporter({
				platform: "darwin",
				dataDirectory: join(first.root, "missing"),
				selectedRoots: () => ({ chrome: selectedRoot }),
				isRunning: vi.fn(async () => {
					if (stage === "process check") selectedRoot = secondRoot;
					return false;
				}),
				readSafeStoragePassword,
			});
			await expect(
				importer.readProfile({
					sourceId: "chrome",
					sourceProfileId: "Default",
					dataTypes: { cookies: true, history: true },
				}),
			).rejects.toThrow("Browser data folder changed during import. Check again before retrying.");
			expect(selectedRoot).toBe(secondRoot);
			if (stage === "process check") expect(readSafeStoragePassword).not.toHaveBeenCalled();
			else expect(readSafeStoragePassword).toHaveBeenCalledOnce();
		},
	);

	it("rejects a profile redirected to a sibling while its cookies are being read", async () => {
		const source = await fixture();
		const sibling = join(source.root, "Profile 2");
		await mkdir(join(sibling, "Network"), { recursive: true });
		writeCookieDatabase(join(source.profile, "Network", "Cookies"));
		writeCookieDatabase(join(sibling, "Network", "Cookies"));
		const canonicalRoot = await realpath(source.root);
		const readSafeStoragePassword = vi.fn(async () => {
			await rename(source.profile, join(source.root, "Original"));
			await symlink(sibling, source.profile, "dir");
			return "fixture-password";
		});
		const importer = new ChromiumBrowserImporter({
			platform: "darwin",
			dataDirectory: join(source.root, "missing"),
			selectedRoots: () => ({ chrome: canonicalRoot }),
			isRunning: vi.fn(async () => false),
			readSafeStoragePassword,
		});
		await expect(
			importer.readProfile({
				sourceId: "chrome",
				sourceProfileId: "Default",
				dataTypes: { cookies: true, history: false },
			}),
		).rejects.toThrow("Browser cookies could not be read");
		expect(readSafeStoragePassword).toHaveBeenCalledOnce();
	});

	it.each(["Network", "History-wal", "History-shm", "Network/Cookies-wal", "Network/Cookies-shm"])(
		"rejects an escaped %s before asking for Keychain access",
		async (entry) => {
			const { importer, profile, readSafeStoragePassword } = await fixture();
			writeHistoryDatabase(join(profile, "History"));
			writeCookieDatabase(join(profile, "Network", "Cookies"));
			const outside = await mkdtemp(join(tmpdir(), "metis-browser-sidecar-outside-"));
			temporaryDirectories.push(outside);
			if (entry === "Network") {
				await rm(join(profile, "Network"), { recursive: true });
				writeCookieDatabase(join(outside, "Cookies"));
				await symlink(outside, join(profile, "Network"), "dir");
			} else {
				const target = join(outside, "sidecar");
				await writeFile(target, "");
				await symlink(target, join(profile, entry));
			}
			await expect(
				importer.readProfile({
					sourceId: "chrome",
					sourceProfileId: "Default",
					dataTypes: { cookies: true, history: true },
				}),
			).rejects.toThrow(
				entry.startsWith("History-") ? "Browser history could not be read" : "outside the selected folder",
			);
			expect(readSafeStoragePassword).not.toHaveBeenCalled();
		},
	);

	it("rejects directories in place of Local State, History, or Cookies", async () => {
		const metadata = await fixture();
		await rm(join(metadata.root, "Local State"));
		await mkdir(join(metadata.root, "Local State"));
		const chrome = (await metadata.importer.listSources()).find((source) => source.sourceId === "chrome");
		expect(chrome).toMatchObject({ status: "unreadable", diagnostic: { stage: "local-state", code: "EINVAL" } });
		await expect(metadata.importer.resolveImportDirectory("chrome", metadata.root)).rejects.toThrow();
		for (const entry of ["History", "Network/Cookies"]) {
			const source = await fixture();
			await mkdir(join(source.profile, entry));
			await expect(
				source.importer.readProfile({
					sourceId: "chrome",
					sourceProfileId: "Default",
					dataTypes: { cookies: true, history: true },
				}),
			).rejects.toThrow();
			expect(source.readSafeStoragePassword).not.toHaveBeenCalled();
		}
		expect(metadata.readSafeStoragePassword).not.toHaveBeenCalled();
	});

	it("binds custom imports to their canonical root while keeping explicit default-root imports compatible", async () => {
		const dataDirectory = await mkdtemp(join(tmpdir(), "metis-browser-default-identity-"));
		temporaryDirectories.push(dataDirectory);
		const defaultRoot = join(dataDirectory, "Google", "Chrome");
		await writeProfileRoot(defaultRoot);
		writeHistoryDatabase(join(defaultRoot, "Default", "History"));
		const custom = await fixture();
		writeHistoryDatabase(join(custom.profile, "History"));
		let selectedRoot: string | undefined;
		const readSafeStoragePassword = vi.fn(async () => "unused");
		const importer = new ChromiumBrowserImporter({
			platform: "darwin",
			dataDirectory,
			selectedRoots: () => (selectedRoot ? { chrome: selectedRoot } : {}),
			isRunning: vi.fn(async () => false),
			readSafeStoragePassword,
		});
		const input = {
			sourceId: "chrome" as const,
			sourceProfileId: "Default",
			dataTypes: { cookies: false, history: true },
		};
		expect((await importer.readProfile(input)).rootPath).toBeUndefined();
		selectedRoot = await realpath(defaultRoot);
		expect((await importer.readProfile(input)).rootPath).toBeUndefined();
		selectedRoot = await realpath(custom.root);
		const imported = await importer.readProfile(input);
		expect(imported.rootPath).toBe(selectedRoot);
		expect(imported.history).toHaveLength(1);
		expect(readSafeStoragePassword).not.toHaveBeenCalled();
	});

	it("discovers safe source profile metadata without paths", async () => {
		const { importer, root } = await fixture();
		const sources = await importer.listSources();
		expect(sources).toEqual(
			expect.arrayContaining([
				{
					sourceId: "chrome",
					name: "Google Chrome",
					running: false,
					status: "ready",
					location: "default",
					profiles: [{ sourceProfileId: "Default", name: "Personal", email: "person@example.com" }],
				},
			]),
		);
		expect(JSON.stringify(sources)).not.toContain(root);
	});

	it("rejects imports while the source browser is running", async () => {
		const running = await fixture({ running: true });
		await expect(
			running.importer.readProfile({
				sourceId: "chrome",
				sourceProfileId: "Default",
				dataTypes: { cookies: false, history: true },
			}),
		).rejects.toThrow("Close Google Chrome");
	});

	it("discovers standard Windows Chromium roots and executable names", async () => {
		const dataDirectory = await mkdtemp(join(tmpdir(), "metis-windows-browser-data-"));
		temporaryDirectories.push(dataDirectory);
		const isRunning = vi.fn(async (_processName: string) => false);
		for (const browser of WINDOWS_BROWSERS) await writeProfileRoot(join(dataDirectory, browser.directory));
		const importer = new ChromiumBrowserImporter({
			platform: "win32",
			dataDirectory,
			isRunning,
			readSafeStoragePassword: vi.fn(async () => "unused"),
		});

		await expect(importer.listSources()).resolves.toEqual(
			WINDOWS_BROWSERS.map((browser) => expect.objectContaining({ sourceId: browser.sourceId, running: false })),
		);
		expect(isRunning.mock.calls.map(([name]) => name)).toEqual(
			WINDOWS_BROWSERS.map(({ processName }) => processName),
		);
	});

	it("rejects Cookie requests on Windows before reading protected browser data", async () => {
		const { importer, readSafeStoragePassword } = await fixture({ platform: "win32" });
		await expect(
			importer.readProfile({
				sourceId: "chrome",
				sourceProfileId: "Default",
				dataTypes: { cookies: true, history: true },
			}),
		).rejects.toThrow("Cookie import is not available on Windows");
		expect(readSafeStoragePassword).not.toHaveBeenCalled();
	});

	it("still rejects platforms outside macOS and Windows", async () => {
		const unsupported = await fixture({ platform: "linux" });
		await expect(unsupported.importer.listSources()).rejects.toThrow("macOS and Windows only");
	});

	it("copies History, converts Chromium time, and leaves the source unchanged", async () => {
		const { importer, profile } = await fixture();
		const historyPath = join(profile, "History");
		const database = new DatabaseSync(historyPath);
		database.exec(
			"CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, last_visit_time INTEGER, hidden INTEGER DEFAULT 0)",
		);
		database
			.prepare("INSERT INTO urls (url, title, last_visit_time) VALUES (?, ?, ?)")
			.run("https://example.com/", "Example", 13_380_163_200_000_000n);
		database.close();
		const before = await readFile(historyPath);
		const data = await importer.readProfile({
			sourceId: "chrome",
			sourceProfileId: "Default",
			dataTypes: { cookies: false, history: true },
		});
		expect(data.history).toEqual([
			expect.objectContaining({
				url: "https://example.com/",
				title: "Example",
				visitedAt: 1_735_689_600_000,
			}),
		]);
		expect(await readFile(historyPath)).toEqual(before);
		expect(data.cookies).toEqual([]);
	});

	it("imports Windows history without requesting a Safe Storage password", async () => {
		const { importer, profile, readSafeStoragePassword } = await fixture({ platform: "win32" });
		const database = new DatabaseSync(join(profile, "History"));
		database.exec(
			"CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, last_visit_time INTEGER, hidden INTEGER DEFAULT 0)",
		);
		database
			.prepare("INSERT INTO urls (url, title, last_visit_time) VALUES (?, ?, ?)")
			.run("https://example.com/", "Example", 13_380_163_200_000_000n);
		database.close();

		const data = await importer.readProfile({
			sourceId: "chrome",
			sourceProfileId: "Default",
			dataTypes: { cookies: false, history: true },
		});
		expect(data.history).toEqual([
			expect.objectContaining({ url: "https://example.com/", visitedAt: 1_735_689_600_000 }),
		]);
		expect(data.cookies).toEqual([]);
		expect(data.cookieSkipped).toBe(0);
		expect(readSafeStoragePassword).not.toHaveBeenCalled();
	});

	it("decrypts valid v10 cookies and skips expired, partitioned, and mismatched rows", async () => {
		const { importer, profile, readSafeStoragePassword } = await fixture();
		const database = new DatabaseSync(join(profile, "Network", "Cookies"));
		database.exec(`
			CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
			INSERT INTO meta VALUES ('version', '24');
			CREATE TABLE cookies (
				host_key TEXT, top_frame_site_key TEXT, name TEXT, value TEXT, encrypted_value BLOB,
				path TEXT, expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER,
				has_expires INTEGER, samesite INTEGER
			);
		`);
		const insert = database.prepare("INSERT INTO cookies VALUES (?, ?, ?, '', ?, '/', ?, 1, 1, 1, 1)");
		const future = CHROMIUM_EPOCH_MICROSECONDS + BigInt(Date.now() + 3_600_000) * 1_000n;
		insert.run(".example.com", "", "session", encryptedCookie(".example.com", "secret"), future);
		insert.run(".expired.example", "", "old", encryptedCookie(".expired.example", "old"), 1n);
		insert.run(
			".partitioned.example",
			"https://top.example",
			"chip",
			encryptedCookie(".partitioned.example", "chip"),
			future,
		);
		insert.run(".wrong.example", "", "bad", encryptedCookie("different.example", "bad"), future);
		database.close();

		const data = await importer.readProfile({
			sourceId: "chrome",
			sourceProfileId: "Default",
			dataTypes: { cookies: true, history: false },
		});
		expect(data.cookies).toEqual([
			expect.objectContaining({
				name: "session",
				value: "secret",
				domain: ".example.com",
				secure: true,
			}),
		]);
		expect(data.cookieSkipped).toBe(3);
		expect(readSafeStoragePassword).toHaveBeenCalledOnce();
	});

	it("imports history without reading Keychain", async () => {
		const { importer, profile, readSafeStoragePassword } = await fixture();
		const database = new DatabaseSync(join(profile, "History"));
		database.exec(
			"CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, last_visit_time INTEGER, hidden INTEGER DEFAULT 0)",
		);
		database.close();
		await importer.readProfile({
			sourceId: "chrome",
			sourceProfileId: "Default",
			dataTypes: { cookies: false, history: true },
		});
		expect(readSafeStoragePassword).not.toHaveBeenCalled();
	});
});
