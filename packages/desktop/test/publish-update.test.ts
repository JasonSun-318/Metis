import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	assertClientAccepts,
	buildLatestManifest,
	objectPrefix,
	releaseKeys,
	trustedBaseUrl,
} from "../scripts/publish-update.mjs";

const BASE = "https://metis-release.oss-cn-shenzhen.aliyuncs.com/metis";
const RELEASE_NOTES = "## Highlights\n\n- Added release notes before download.";

describe("publish-update", () => {
	it("builds a manifest the desktop updater will accept", () => {
		const baseUrl = trustedBaseUrl(BASE);
		expect(baseUrl?.href).toBe(`${BASE}/`);
		expect(objectPrefix(baseUrl!)).toBe("metis/");
		const keys = releaseKeys(baseUrl!, "arm64", "0.0.5");
		expect(keys.dmgKey).toBe("metis/darwin/arm64/releases/0.0.5/Metis-0.0.5-darwin-arm64.dmg");
		expect(keys.manifestKey).toBe("metis/darwin/arm64/latest.json");
		expect(keys.manifestUrl).toBe(`${BASE}/darwin/arm64/latest.json`);
		const sha256 = createHash("sha256").update("dmg").digest("hex");
		const manifest = buildLatestManifest({
			version: "0.0.5",
			dmgUrl: keys.dmgUrl,
			size: 12,
			sha256,
			releaseNotes: RELEASE_NOTES,
		});
		expect(manifest.releaseNotes).toBe(RELEASE_NOTES);
		expect(() => assertClientAccepts(manifest, baseUrl!)).not.toThrow();
		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.dmg.url).toBe(`${BASE}/darwin/arm64/releases/0.0.5/Metis-0.0.5-darwin-arm64.dmg`);
		expect(() => assertClientAccepts({ ...manifest, releaseNotes: "   " }, baseUrl!)).toThrow(
			"Invalid update release notes",
		);
		expect(() => assertClientAccepts({ ...manifest, releaseNotes: "x".repeat(64 * 1024 + 1) }, baseUrl!)).toThrow(
			"Invalid update release notes",
		);
	});

	it("rejects signed or cross-origin DMG URLs", () => {
		const baseUrl = trustedBaseUrl(BASE)!;
		const sha256 = "a".repeat(64);
		expect(() =>
			assertClientAccepts(
				buildLatestManifest({
					version: "0.0.5",
					dmgUrl: `${BASE}/darwin/arm64/releases/0.0.5/Metis-0.0.5-darwin-arm64.dmg?sign=1`,
					size: 12,
					sha256,
					releaseNotes: RELEASE_NOTES,
				}),
				baseUrl,
			),
		).toThrow("Invalid update manifest");
		expect(trustedBaseUrl("http://metis-release.oss-cn-shenzhen.aliyuncs.com")).toBeUndefined();
	});

	it("requires a notes file and includes trimmed notes in dry-run output", () => {
		const directory = mkdtempSync(path.join(tmpdir(), "metis-publish-update-test-"));
		try {
			const script = path.join(process.cwd(), "scripts", "publish-update.mjs");
			const dmg = path.join(directory, "Metis-0.0.5-darwin-arm64.dmg");
			const notes = path.join(directory, "release-notes.md");
			writeFileSync(dmg, "dmg");
			writeFileSync(notes, "  ## Highlights\n- Safer updater\n");

			const missing = spawnSync(process.execPath, [script, "publish", "--arch", "arm64", "--dry-run"], {
				encoding: "utf8",
			});
			expect(missing.status).toBe(1);
			expect(missing.stderr).toContain("Missing --notes-file");

			const dryRun = spawnSync(
				process.execPath,
				[
					script,
					"publish",
					"--arch",
					"arm64",
					"--version",
					"0.0.5",
					"--dmg",
					dmg,
					"--notes-file",
					notes,
					"--dry-run",
				],
				{ encoding: "utf8" },
			);
			expect(dryRun.status).toBe(0);
			expect(dryRun.stdout).toContain('"releaseNotes": "## Highlights\\n- Safer updater"');
		} finally {
			rmSync(directory, { force: true, recursive: true });
		}
	});
});
