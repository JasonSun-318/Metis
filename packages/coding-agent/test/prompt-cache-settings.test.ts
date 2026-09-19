import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";

describe("prompt cache settings", () => {
	it("defaults to legacy scheduling with stable history anchors", () => {
		const root = mkdtempSync(join(tmpdir(), "metis-cache-settings-"));
		try {
			const settings = SettingsManager.create(root, root);
			expect(settings.getPromptCacheSettings()).toEqual({
				historyAnchors: true,
				microcompaction: "legacy",
				diagnostics: false,
			});
			settings.applyOverrides({ promptCache: { microcompaction: "pressure" } });
			expect(settings.getPromptCacheSettings().microcompaction).toBe("pressure");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects malformed prompt cache settings", () => {
		const root = mkdtempSync(join(tmpdir(), "metis-cache-settings-"));
		try {
			const settings = SettingsManager.create(root, root);
			settings.applyOverrides({
				promptCache: { historyAnchors: "yes" } as never,
			});
			expect(() => settings.getPromptCacheSettings()).toThrow(/historyAnchors/);

			settings.applyOverrides({
				promptCache: { historyAnchors: true, microcompaction: "turbo" } as never,
			});
			expect(() => settings.getPromptCacheSettings()).toThrow(/microcompaction/);

			settings.applyOverrides({
				promptCache: { microcompaction: "off", diagnostics: 1 } as never,
			});
			expect(() => settings.getPromptCacheSettings()).toThrow(/diagnostics/);

			settings.applyOverrides({ promptCache: { diagnostics: false } });
			expect(settings.getPromptCacheSettings()).toEqual({
				historyAnchors: true,
				microcompaction: "off",
				diagnostics: false,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
