import { createCipheriv, createHash, pbkdf2Sync } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { ChromiumBrowserImporter } from "../src/main/chromium-browser-import.ts";

const CHROMIUM_EPOCH_MICROSECONDS = 11_644_473_600_000_000n;

async function fixture(options: { running?: boolean; platform?: NodeJS.Platform } = {}) {
	const root = await mkdtemp(join(tmpdir(), "metis-chromium-source-"));
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
		applicationSupportPath: join(root, "missing"),
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

describe("ChromiumBrowserImporter", () => {
	it("discovers safe source profile metadata without paths", async () => {
		const { importer, root } = await fixture();
		const sources = await importer.listSources();
		expect(sources).toEqual([
			{
				sourceId: "chrome",
				name: "Google Chrome",
				running: false,
				profiles: [{ sourceProfileId: "Default", name: "Personal", email: "person@example.com" }],
			},
		]);
		expect(JSON.stringify(sources)).not.toContain(root);
	});

	it("rejects unsupported platforms and running browsers", async () => {
		const unsupported = await fixture({ platform: "win32" });
		await expect(unsupported.importer.listSources()).rejects.toThrow("macOS only");
		const running = await fixture({ running: true });
		await expect(
			running.importer.readProfile({
				sourceId: "chrome",
				sourceProfileId: "Default",
				dataTypes: { cookies: false, history: true },
			}),
		).rejects.toThrow("Close Google Chrome");
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
