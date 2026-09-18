import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { BrowserProfileStore, mergeBrowserHistory } from "../src/main/browser-profile-store.ts";
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
