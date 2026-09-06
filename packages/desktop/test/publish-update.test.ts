import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	assertClientAccepts,
	buildLatestManifest,
	objectPrefix,
	releaseKeys,
	trustedBaseUrl,
} from "../scripts/publish-update.mjs";

const BASE = "https://metis-release.oss-cn-shenzhen.aliyuncs.com/metis";

describe("publish-update", () => {
	it("builds a manifest the desktop updater will accept", () => {
		const baseUrl = trustedBaseUrl(BASE);
		expect(baseUrl?.href).toBe(`${BASE}/`);
		expect(objectPrefix(baseUrl!)).toBe("metis/");
		const keys = releaseKeys(baseUrl!, "arm64", "0.0.5");
		expect(keys.dmgKey).toBe("metis/darwin/arm64/releases/0.0.5/Metis-0.0.5-darwin-arm64.dmg");
		expect(keys.manifestKey).toBe("metis/darwin/arm64/latest.json");
		const sha256 = createHash("sha256").update("dmg").digest("hex");
		const manifest = buildLatestManifest({
			version: "0.0.5",
			dmgUrl: keys.dmgUrl,
			size: 12,
			sha256,
		});
		expect(() => assertClientAccepts(manifest, baseUrl!)).not.toThrow();
		expect(manifest.schemaVersion).toBe(1);
		expect(manifest.dmg.url).toBe(`${BASE}/darwin/arm64/releases/0.0.5/Metis-0.0.5-darwin-arm64.dmg`);
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
				}),
				baseUrl,
			),
		).toThrow("Invalid update manifest");
		expect(trustedBaseUrl("http://metis-release.oss-cn-shenzhen.aliyuncs.com")).toBeUndefined();
	});
});
