import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertClientAccepts,
	buildLatestManifest,
	normalizeChangelog,
	objectPrefix,
	ossutilBin,
	releaseKeys,
	trustedBaseUrl,
} from "../scripts/publish-update.mjs";

const BASE = "https://metis-release.oss-cn-shenzhen.aliyuncs.com/metis";
const CHANGELOG = {
	schemaVersion: 1,
	releases: [
		{ version: "0.0.5", notes: "## Highlights\n\n- Added release history." },
		{ version: "0.0.4", notes: "## Fixed\n\n- Safer updater." },
	],
};

describe("publish-update", () => {
	it("uses the platform PATH unless ossutil is explicitly overridden", () => {
		expect(ossutilBin({})).toBe("ossutil");
		expect(ossutilBin({ OSSUTIL: "C:\\Tools\\ossutil.exe" })).toBe("C:\\Tools\\ossutil.exe");
	});

	it("reports a missing PATH executable without relying on a POSIX locator", () => {
		const directory = mkdtempSync(path.join(tmpdir(), "metis-missing-ossutil-test-"));
		try {
			const desktopRoot = process.cwd().endsWith(`${path.sep}packages${path.sep}desktop`)
				? process.cwd()
				: path.join(process.cwd(), "packages", "desktop");
			const result = spawnSync(process.execPath, [path.join(desktopRoot, "scripts", "publish-update.mjs"), "ls"], {
				encoding: "utf8",
				env: { ...process.env, OSSUTIL: "", PATH: directory },
			});
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("ossutil is unavailable");
			expect(result.stderr).not.toContain("sudo");
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});

	it("builds separate updater and changelog objects", () => {
		const baseUrl = trustedBaseUrl(BASE);
		expect(baseUrl?.href).toBe(`${BASE}/`);
		expect(objectPrefix(baseUrl!)).toBe("metis/");
		const keys = releaseKeys(baseUrl!, "darwin", "arm64", "0.0.5");
		expect(keys.changelogKey).toBe("metis/darwin/changelog.json");
		expect(keys.changelogUrl).toBe(`${BASE}/darwin/changelog.json`);
		expect(keys.assetObjectKey).toBe("metis/darwin/arm64/releases/0.0.5/Metis-0.0.5-darwin-arm64.dmg");
		expect(keys.manifestKey).toBe("metis/darwin/arm64/latest.json");
		expect(keys.manifestUrl).toBe(`${BASE}/darwin/arm64/latest.json`);
		const sha256 = createHash("sha256").update("dmg").digest("hex");
		const windowsKeys = releaseKeys(baseUrl!, "win32", "x64", "0.0.5");
		expect(windowsKeys.changelogKey).toBe("metis/win32/changelog.json");
		expect(windowsKeys.changelogUrl).toBe(`${BASE}/win32/changelog.json`);
		expect(windowsKeys.assetObjectKey).toBe("metis/win32/x64/releases/0.0.5/Metis-0.0.5-win32-x64-Setup.exe");
		expect(windowsKeys.manifestKey).toBe("metis/win32/x64/latest.json");
		expect(windowsKeys.manifestUrl).toBe(`${BASE}/win32/x64/latest.json`);
		const windowsManifest = buildLatestManifest({
			platform: "win32",
			version: "0.0.5",
			assetUrl: windowsKeys.assetUrl,
			size: 12,
			sha256,
		});
		expect(windowsManifest).toEqual({
			schemaVersion: 1,
			version: "0.0.5",
			exe: { url: `${BASE}/win32/x64/releases/0.0.5/Metis-0.0.5-win32-x64-Setup.exe`, size: 12, sha256 },
		});
		expect(() => assertClientAccepts(windowsManifest, baseUrl!, "win32")).not.toThrow();
		const manifest = buildLatestManifest({
			platform: "darwin",
			version: "0.0.5",
			assetUrl: keys.assetUrl,
			size: 12,
			sha256,
		});
		expect(manifest).not.toHaveProperty("releaseNotes");
		expect(() => assertClientAccepts(manifest, baseUrl!, "darwin")).not.toThrow();
		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.dmg.url).toBe(`${BASE}/darwin/arm64/releases/0.0.5/Metis-0.0.5-darwin-arm64.dmg`);
		expect(normalizeChangelog(CHANGELOG)).toEqual(CHANGELOG);
	});

	it("keeps valid tracked platform changelogs whose latest entries match the desktop version", () => {
		const desktopRoot = process.cwd().endsWith(`${path.sep}packages${path.sep}desktop`)
			? process.cwd()
			: path.join(process.cwd(), "packages", "desktop");
		const desktopVersion = JSON.parse(readFileSync(path.join(desktopRoot, "package.json"), "utf8")).version;
		for (const platform of ["darwin", "win32"]) {
			const changelog = normalizeChangelog(
				JSON.parse(readFileSync(path.join(desktopRoot, `changelog.${platform}.json`), "utf8")),
			);
			expect(changelog.releases[0]?.version).toBe(desktopVersion);
		}
	});

	it("selects the tracked changelog for the requested platform by default", () => {
		const directory = mkdtempSync(path.join(tmpdir(), "metis-platform-changelog-test-"));
		try {
			const desktopRoot = process.cwd().endsWith(`${path.sep}packages${path.sep}desktop`)
				? process.cwd()
				: path.join(process.cwd(), "packages", "desktop");
			const script = path.join(desktopRoot, "scripts", "publish-update.mjs");
			const version = JSON.parse(readFileSync(path.join(desktopRoot, "package.json"), "utf8")).version;
			const dmg = path.join(directory, "Metis.dmg");
			const installer = path.join(directory, "Metis Setup.exe");
			writeFileSync(dmg, "dmg");
			writeFileSync(installer, "installer");

			const mac = spawnSync(
				process.execPath,
				[
					script,
					"publish",
					"--platform",
					"darwin",
					"--arch",
					"arm64",
					"--version",
					version,
					"--dmg",
					dmg,
					"--dry-run",
				],
				{ encoding: "utf8" },
			);
			expect(mac.status).toBe(0);
			expect(mac.stdout).toContain('"changelogKey": "metis/darwin/changelog.json"');
			expect(mac.stdout).not.toContain("Windows 用户可在应用内完成工作区沙箱的一次性设置");

			const windows = spawnSync(
				process.execPath,
				[
					script,
					"publish",
					"--platform",
					"win32",
					"--arch",
					"x64",
					"--version",
					version,
					"--installer",
					installer,
					"--dry-run",
				],
				{ encoding: "utf8" },
			);
			expect(windows.status).toBe(0);
			expect(windows.stdout).toContain('"changelogKey": "metis/win32/changelog.json"');
			expect(windows.stdout).toContain("Windows 用户可在应用内完成工作区沙箱的一次性设置");
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});

	it("rejects signed or cross-origin DMG URLs", () => {
		const baseUrl = trustedBaseUrl(BASE)!;
		const sha256 = "a".repeat(64);
		expect(() =>
			assertClientAccepts(
				buildLatestManifest({
					platform: "darwin",
					version: "0.0.5",
					assetUrl: `${BASE}/darwin/arm64/releases/0.0.5/Metis-0.0.5-darwin-arm64.dmg?sign=1`,
					size: 12,
					sha256,
				}),
				baseUrl,
				"darwin",
			),
		).toThrow("Invalid update manifest");
		expect(trustedBaseUrl("http://metis-release.oss-cn-shenzhen.aliyuncs.com")).toBeUndefined();
	});

	it.each([
		{ ...CHANGELOG, extra: true },
		{ schemaVersion: 1, releases: [] },
		{ schemaVersion: 1, releases: [{ version: "0.0.5", notes: "   " }] },
		{ schemaVersion: 1, releases: [{ version: "0.0.5", notes: "x".repeat(64 * 1024 + 1) }] },
		{ schemaVersion: 1, releases: [...CHANGELOG.releases].reverse() },
		{ schemaVersion: 1, releases: [CHANGELOG.releases[0], CHANGELOG.releases[0]] },
	])("rejects invalid changelog data", (changelog) => {
		expect(() => normalizeChangelog(changelog)).toThrow();
	});

	it("requires a matching full changelog and includes both documents in dry-run output", () => {
		const directory = mkdtempSync(path.join(tmpdir(), "metis-publish-update-test-"));
		try {
			const desktopRoot = process.cwd().endsWith(`${path.sep}packages${path.sep}desktop`)
				? process.cwd()
				: path.join(process.cwd(), "packages", "desktop");
			const script = path.join(desktopRoot, "scripts", "publish-update.mjs");
			const dmg = path.join(directory, "Metis-0.0.5-darwin-arm64.dmg");
			const changelog = path.join(directory, "changelog.json");
			const mismatched = path.join(directory, "mismatched.json");
			writeFileSync(dmg, "dmg");
			writeFileSync(changelog, JSON.stringify(CHANGELOG));
			writeFileSync(mismatched, JSON.stringify({ ...CHANGELOG, releases: CHANGELOG.releases.slice(1) }));

			const mismatch = spawnSync(
				process.execPath,
				[
					script,
					"publish",
					"--platform",
					"darwin",
					"--arch",
					"arm64",
					"--version",
					"0.0.5",
					"--dmg",
					dmg,
					"--changelog-file",
					mismatched,
					"--dry-run",
				],
				{ encoding: "utf8" },
			);
			expect(mismatch.status).toBe(1);
			expect(mismatch.stderr).toContain("does not match 0.0.5");

			const dryRun = spawnSync(
				process.execPath,
				[
					script,
					"publish",
					"--platform",
					"darwin",
					"--arch",
					"arm64",
					"--version",
					"0.0.5",
					"--dmg",
					dmg,
					"--changelog-file",
					changelog,
					"--dry-run",
				],
				{ encoding: "utf8" },
			);
			expect(dryRun.status).toBe(0);
			expect(dryRun.stdout).toContain('"changelogKey": "metis/darwin/changelog.json"');
			expect(dryRun.stdout).toContain('"latest":');
			expect(dryRun.stdout).toContain('"changelog":');
			expect(dryRun.stdout).toContain('"notes": "## Highlights\\n\\n- Added release history."');
			expect(dryRun.stdout).not.toContain('"releaseNotes"');

			const installer = path.join(directory, "Metis-0.0.5 Setup.exe");
			writeFileSync(installer, "installer");
			const windowsDryRun = spawnSync(
				process.execPath,
				[
					script,
					"publish",
					"--platform",
					"win32",
					"--arch",
					"x64",
					"--version",
					"0.0.5",
					"--installer",
					installer,
					"--changelog-file",
					changelog,
					"--dry-run",
				],
				{ encoding: "utf8" },
			);
			expect(windowsDryRun.status).toBe(0);
			expect(windowsDryRun.stdout).toContain('"changelogKey": "metis/win32/changelog.json"');
			expect(windowsDryRun.stdout).toContain('"manifestKey": "metis/win32/x64/latest.json"');
			expect(windowsDryRun.stdout).toContain('"exe":');
			expect(windowsDryRun.stdout).toContain("Metis-0.0.5-win32-x64-Setup.exe");
			expect(windowsDryRun.stdout).not.toContain('"dmg":');

			const windowsArm64 = spawnSync(
				process.execPath,
				[
					script,
					"publish",
					"--platform",
					"win32",
					"--arch",
					"arm64",
					"--version",
					"0.0.5",
					"--installer",
					installer,
					"--changelog-file",
					changelog,
					"--dry-run",
				],
				{ encoding: "utf8" },
			);
			expect(windowsArm64.status).toBe(1);
			expect(windowsArm64.stderr).toContain("Unsupported Windows arch: arm64");
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});
});
