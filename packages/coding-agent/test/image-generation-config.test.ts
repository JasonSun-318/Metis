import { describe, expect, it } from "vitest";
import { normalizeImageGenerationConfig } from "../src/core/image-generation/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const profile = {
	name: "Images",
	api: "google-interactions",
	baseUrl: "https://images.example.test/v1beta",
	modelId: "image-model",
} as const;

describe("image generation configuration", () => {
	it("persists an OpenRouter image profile without changing its model slug", async () => {
		const manager = SettingsManager.inMemory();
		const config = {
			...profile,
			api: "openrouter-images" as const,
			baseUrl: "https://openrouter.ai/api/v1",
			modelId: "google/gemini-3.1-flash-image",
		};
		manager.setImageGenerationConfig(config);
		await manager.flushOrThrow();
		await manager.reload();
		expect(manager.getImageGenerationConfig()).toEqual(config);
	});
	it("normalizes fields and persists the independent global setting", async () => {
		const manager = SettingsManager.inMemory({ defaultModel: "chat-model", autoSessionTitle: false });
		manager.setImageGenerationConfig({ ...profile, name: " Images ", baseUrl: `${profile.baseUrl}/` });
		await manager.flushOrThrow();
		await manager.reload();
		expect(manager.getImageGenerationConfig()).toEqual(profile);
		expect(manager.getDefaultModel()).toBe("chat-model");
		expect(manager.getAutoSessionTitleEnabled()).toBe(false);
		manager.setImageGenerationConfig(undefined);
		await manager.flushOrThrow();
		await manager.reload();
		expect(manager.getImageGenerationView()).toEqual({ config: null, status: "unconfigured" });
	});

	it("does not inherit a project's model or credential selection", () => {
		const manager = SettingsManager.fromStorage({
			withLock(scope, callback) {
				callback(JSON.stringify(scope === "project" ? { imageGeneration: profile } : {}));
			},
		});
		expect(manager.getImageGenerationConfig()).toBeUndefined();
	});

	it.each([
		{ ...profile, api: "openai-responses" },
		{ ...profile, name: " " },
		{ ...profile, modelId: "" },
		{ ...profile, baseUrl: "file:///tmp/image" },
		{ ...profile, baseUrl: "https://key:secret@example.test/v1" },
		{ ...profile, baseUrl: "https://example.test/v1?key=secret" },
		{ ...profile, credentialProvider: "" },
		{ ...profile, apiKey: "secret" },
	])("rejects malformed or secret-bearing configuration %#", (invalid) => {
		expect(() => normalizeImageGenerationConfig(invalid)).toThrow();
	});

	it("reports invalid stored configuration without exposing its secret fields", () => {
		const manager = SettingsManager.fromStorage({
			withLock(scope, callback) {
				callback(scope === "global" ? JSON.stringify({ imageGeneration: { ...profile, apiKey: "secret" } }) : "{}");
			},
		});
		expect(manager.getImageGenerationView()).toEqual({ config: null, status: "invalid" });
	});
});
