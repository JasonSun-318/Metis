import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { normalizePermissionReviewerConfig } from "../../src/core/permissions/reviewer-config.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";

const reviewer = {
	provider: "review-provider",
	modelId: "review-model",
	thinkingLevel: "off",
	timeoutMs: 8000,
	maxOutputTokens: 512,
} as const;

const dedicated = {
	source: "dedicated",
	name: "Local reviewer",
	api: "openai-completions",
	baseUrl: "http://127.0.0.1:1234/v1",
	modelId: "review-model",
	thinkingLevel: "off",
	timeoutMs: 8000,
	maxOutputTokens: 512,
	reasoningMode: "off",
} as const;

describe("independent reviewer configuration", () => {
	it("keeps an independent exact configuration", () => {
		expect(normalizePermissionReviewerConfig(reviewer)).toEqual(reviewer);
		expect(normalizePermissionReviewerConfig(undefined)).toBeUndefined();
		expect(normalizePermissionReviewerConfig(null)).toBeUndefined();
		expect(Object.isFrozen(normalizePermissionReviewerConfig(reviewer))).toBe(true);
	});

	it("does not revive the abandoned reviewer schema", () => {
		expect(() =>
			normalizePermissionReviewerConfig({
				provider: "review-provider",
				modelId: "review-model",
				assessmentId: "old",
			}),
		).toThrow(TypeError);
		expect(() => normalizePermissionReviewerConfig({ ...reviewer, apiKey: "not-allowed" })).toThrow(TypeError);
		expect(() => normalizePermissionReviewerConfig({ ...reviewer, timeoutMs: 15001 })).toThrow(TypeError);
	});

	it("rejects invalid values, accessors, and prototype injection", () => {
		expect(() => normalizePermissionReviewerConfig({ ...reviewer, provider: "  " })).toThrow(TypeError);
		expect(() => normalizePermissionReviewerConfig({ ...reviewer, modelId: "" })).toThrow(TypeError);
		expect(() => normalizePermissionReviewerConfig({ ...reviewer, thinkingLevel: "ultra" })).toThrow(TypeError);
		expect(() => normalizePermissionReviewerConfig({ ...reviewer, timeoutMs: 999 })).toThrow(TypeError);
		expect(() => normalizePermissionReviewerConfig({ ...reviewer, timeoutMs: 8000.5 })).toThrow(TypeError);
		expect(() => normalizePermissionReviewerConfig({ ...reviewer, maxOutputTokens: 127 })).toThrow(TypeError);
		expect(() => normalizePermissionReviewerConfig({ ...reviewer, maxOutputTokens: 8193 })).toThrow(TypeError);
		const accessor = { ...reviewer } as Record<string, unknown>;
		Object.defineProperty(accessor, "provider", { enumerable: true, get: () => "review-provider" });
		expect(() => normalizePermissionReviewerConfig(accessor)).toThrow(TypeError);
		const hiddenLegacyField = { ...reviewer };
		Object.defineProperty(hiddenLegacyField, "version", { value: 2, enumerable: false });
		expect(() => normalizePermissionReviewerConfig(hiddenLegacyField)).toThrow(TypeError);
		const withSymbol = { ...reviewer, [Symbol("legacy")]: true };
		expect(() => normalizePermissionReviewerConfig(withSymbol)).toThrow(TypeError);
	});

	it("keeps the five-field provider profile without requiring a source", () => {
		expect(normalizePermissionReviewerConfig(reviewer)).toEqual(reviewer);
		expect(() => normalizePermissionReviewerConfig({ ...reviewer, source: "provider" })).toThrow(TypeError);
	});

	it("normalizes a dedicated connection with independent capabilities", () => {
		expect(normalizePermissionReviewerConfig(dedicated)).toEqual(dedicated);
		const manual = {
			...dedicated,
			thinkingLevel: "low",
			reasoningMode: "manual",
			thinkingLevelMap: { low: "low" },
		} as const;
		expect(normalizePermissionReviewerConfig(manual)).toEqual({
			...manual,
			thinkingLevelMap: {
				off: null,
				minimal: null,
				low: "low",
				medium: null,
				high: null,
				xhigh: null,
				max: null,
			},
		});
		expect(Object.isFrozen(normalizePermissionReviewerConfig(manual))).toBe(true);
	});

	it("keeps credential presence out of the saved profile and validates the source exactly", () => {
		expect(() => normalizePermissionReviewerConfig({ ...dedicated, authConfigured: true })).toThrow(TypeError);
		expect(() => normalizePermissionReviewerConfig({ ...dedicated, source: "unexpected-source" })).toThrow(TypeError);
		expect(() => normalizePermissionReviewerConfig({ ...dedicated, source: null })).toThrow(TypeError);
		expect(() => normalizePermissionReviewerConfig({ ...dedicated, source: undefined })).toThrow(TypeError);
	});

	it("rejects inconsistent or unsafe dedicated connections", () => {
		const manual = {
			...dedicated,
			thinkingLevel: "low",
			reasoningMode: "manual",
			thinkingLevelMap: { low: "low" },
		} as const;
		for (const value of [
			{ ...dedicated, api: "unsupported-api" },
			{ ...dedicated, baseUrl: "ftp://review.example.test/v1" },
			{ ...dedicated, baseUrl: "https://user:secret@review.example.test/v1" },
			{ ...dedicated, baseUrl: "not a url" },
			{ ...dedicated, name: " " },
			{ ...dedicated, modelId: "" },
			{ ...dedicated, reasoningMode: "auto" },
			{ ...dedicated, reasoningMode: "generic" },
			{ ...dedicated, thinkingLevel: "low" },
			{ ...dedicated, thinkingLevelMap: { low: "low" } },
			{ ...manual, thinkingLevelMap: undefined },
			{ ...manual, thinkingLevelMap: { low: null } },
			{ ...manual, thinkingLevelMap: { high: "high" } },
			{ ...manual, thinkingLevelMap: { low: 1 } },
			{ ...manual, thinkingLevelMap: { unknown: "value" } },
			{ ...dedicated, apiKey: "not-allowed" },
			{ ...dedicated, provider: "legacy-provider" },
			{ ...dedicated, timeoutMs: 15_001 },
			{ ...dedicated, maxOutputTokens: 8_193 },
		]) {
			expect(() => normalizePermissionReviewerConfig(value)).toThrow(TypeError);
		}
	});
});

describe("SettingsManager reviewer ownership", () => {
	let root: string;
	let cwd: string;
	let agentDir: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "metis-reviewer-settings-"));
		cwd = join(root, "project");
		agentDir = join(root, "agent");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("defaults the global switch off and restores both values after a rebuild", async () => {
		const manager = SettingsManager.create(cwd, agentDir);
		expect(manager.getAutoReviewerEnabled()).toBe(false);
		expect(manager.getPermissionReviewerConfig()).toBeUndefined();
		expect(manager.getPermissionReviewerStatus()).toBe("unconfigured");

		manager.setAutoReviewerEnabled(true);
		manager.setPermissionReviewerConfig(reviewer);
		await manager.flushOrThrow();
		expect(manager.getPermissionReviewerStatus()).toBe("configured");

		const reloaded = SettingsManager.create(cwd, agentDir);
		expect(reloaded.getAutoReviewerEnabled()).toBe(true);
		expect(reloaded.getPermissionReviewerConfig()).toEqual(reviewer);
		expect(reloaded.getPermissionReviewerStatus()).toBe("configured");
	});

	it("does not trust project settings for the reviewer or its switch", () => {
		mkdirSync(join(cwd, ".metis"), { recursive: true });
		writeFileSync(
			join(cwd, ".metis", "settings.json"),
			JSON.stringify({ autoReviewerEnabled: true, permissionReviewer: reviewer }),
		);
		const manager = SettingsManager.create(cwd, agentDir);
		expect(manager.getAutoReviewerEnabled()).toBe(false);
		expect(manager.getPermissionReviewerConfig()).toBeUndefined();
		expect(manager.getPermissionReviewerStatus()).toBe("unconfigured");
	});

	it("reports an abandoned object as invalid without enabling or migrating it", () => {
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				permissionReviewer: {
					provider: "review-provider",
					modelId: "review-model",
					version: 2,
					assessmentId: "old",
					promptVersion: "v2",
				},
			}),
		);
		const manager = SettingsManager.create(cwd, agentDir);
		expect(manager.getPermissionReviewerStatus()).toBe("invalid");
		expect(manager.getPermissionReviewerConfig()).toBeUndefined();
		expect(manager.getAutoReviewerEnabled()).toBe(false);
		expect(manager.getGlobalSettings().permissionReviewer).toMatchObject({ assessmentId: "old", version: 2 });
	});
});
