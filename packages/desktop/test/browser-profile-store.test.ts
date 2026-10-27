import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { BrowserProfileStore, browserRootFingerprint, mergeBrowserHistory } from "../src/main/browser-profile-store.ts";
import { DEFAULT_BROWSER_PROFILE_ID, type DesktopHistoryEntry } from "../src/shared/desktop-api.ts";

function entry(url: string, visitedAt: number): DesktopHistoryEntry {
	return { entryId: crypto.randomUUID(), url, title: url, faviconUrl: null, visitedAt };
}

describe("BrowserProfileStore", () => {
	it("preserves Default and maps a source profile to a stable Metis profile", async () => {
		const userDataPath = await mkdtemp(join(tmpdir(), "metis-browser-profiles-"));
		onTestFinished(() => rm(userDataPath, { recursive: true, force: true }));
		const store = new BrowserProfileStore(userDataPath);
		expect(store.listProfiles()).toEqual([
			{
				profileId: DEFAULT_BROWSER_PROFILE_ID,
				name: "Default",
				sourceId: null,
				sourceProfileId: null,
			},
		]);
		const first = store.ensureImportedProfile({ sourceId: "chrome", sourceProfileId: "Profile 1", name: "Personal" });
		const second = store.ensureImportedProfile({
			sourceId: "chrome",
			sourceProfileId: "Profile 1",
			name: "Personal renamed",
		});
		expect(second.profileId).toBe(first.profileId);
		expect(second.name).toBe("Personal renamed");
		expect(JSON.parse(await readFile(join(userDataPath, "browser-profiles.json"), "utf8")).profiles).toHaveLength(1);
	});

	it("reuses one profile for the same canonical root and isolates a different root", async () => {
		const userDataPath = await mkdtemp(join(tmpdir(), "metis-browser-root-identity-"));
		onTestFinished(() => rm(userDataPath, { recursive: true, force: true }));
		const store = new BrowserProfileStore(userDataPath);
		const identity = { sourceId: "chrome" as const, sourceProfileId: "Default", name: "Personal" };
		const first = store.ensureImportedProfile({ ...identity, rootPath: "/Users/test/Chrome" });
		const again = store.ensureImportedProfile({ ...identity, rootPath: "/Users/test/Chrome" });
		const other = store.ensureImportedProfile({ ...identity, name: "Other", rootPath: "/Users/test/Chrome-Other" });
		const legacy = store.ensureImportedProfile(identity);
		expect(again.profileId).toBe(first.profileId);
		expect(new Set([first.profileId, other.profileId, legacy.profileId]).size).toBe(3);
		expect(JSON.stringify(store.listProfiles())).not.toContain("/Users/test/Chrome");
		const persisted = JSON.parse(await readFile(join(userDataPath, "browser-profiles.json"), "utf8"));
		expect(persisted.profiles).toContainEqual(
			expect.objectContaining({
				profileId: first.profileId,
				rootFingerprint: browserRootFingerprint("/Users/test/Chrome"),
			}),
		);
		expect(new BrowserProfileStore(userDataPath).listProfiles().map((profile) => profile.profileId)).toEqual(
			store.listProfiles().map((profile) => profile.profileId),
		);
	});

	it("remembers a validated import root and ignores corrupt or unsafe metadata", async () => {
		const userDataPath = await mkdtemp(join(tmpdir(), "metis-browser-import-locations-"));
		onTestFinished(() => rm(userDataPath, { recursive: true, force: true }));
		const store = new BrowserProfileStore(userDataPath);
		store.setImportRoot("chrome", "/Users/test/Library/Application Support/Google/Chrome");
		expect(store.getImportRoots()).toEqual({ chrome: "/Users/test/Library/Application Support/Google/Chrome" });
		expect(() => store.setImportRoot("chrome", "relative/Chrome")).toThrow("Invalid browser import location");
		expect(new BrowserProfileStore(userDataPath).getImportRoots().chrome).toContain("Google/Chrome");
		await writeFile(join(userDataPath, "browser-import-locations.json"), "{broken", "utf8");
		expect(new BrowserProfileStore(userDataPath).getImportRoots()).toEqual({});
	});

	it("falls back to Default for corrupt metadata", async () => {
		const userDataPath = await mkdtemp(join(tmpdir(), "metis-browser-profiles-"));
		onTestFinished(() => rm(userDataPath, { recursive: true, force: true }));
		await writeFile(join(userDataPath, "browser-profiles.json"), "{broken", "utf8");
		expect(new BrowserProfileStore(userDataPath).listProfiles()).toHaveLength(1);
	});

	it("isolates history files and caps the merged newest entries at 500", async () => {
		const userDataPath = await mkdtemp(join(tmpdir(), "metis-browser-history-"));
		onTestFinished(() => rm(userDataPath, { recursive: true, force: true }));
		const store = new BrowserProfileStore(userDataPath);
		const imported = store.ensureImportedProfile({ sourceId: "chrome", sourceProfileId: "Profile 1", name: "Work" });
		store.saveHistory(DEFAULT_BROWSER_PROFILE_ID, [entry("https://default.example", 10)]);
		store.saveHistory(imported.profileId, [entry("https://work.example", 20)]);
		expect(store.loadHistory(DEFAULT_BROWSER_PROFILE_ID)[0]!.url).toContain("default");
		expect(store.loadHistory(imported.profileId)[0]!.url).toContain("work");

		const existing = [
			entry("https://same.example", 50),
			...Array.from({ length: 300 }, (_, i) => entry(`https://existing.example/${i}`, i)),
		];
		const incoming = [
			entry("https://same.example", 2_000),
			...Array.from({ length: 400 }, (_, i) => entry(`https://imported.example/${i}`, 1_000 + i)),
		];
		const merged = mergeBrowserHistory(existing, incoming);
		expect(merged).toHaveLength(500);
		expect(merged[0]!.visitedAt).toBe(2_000);
		expect(merged.find((item) => item.url === "https://same.example/")!.visitedAt).toBe(2_000);
	});
});
