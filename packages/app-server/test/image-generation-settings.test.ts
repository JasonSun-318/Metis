import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateResponseFor } from "@metis/app-protocol";
import { AuthStorage, IMAGE_GENERATION_AUTH_KEY, ModelRegistry, SettingsManager } from "@metis/coding-agent/host";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelSettingsService } from "../src/model-settings.ts";

const profile = {
	name: "Image studio",
	api: "openai-images",
	baseUrl: "https://images.example.test/v1",
	modelId: "image-model",
} as const;

describe("image generation model settings", () => {
	let agentDir: string;
	let authStorage: AuthStorage;
	let settingsManager: SettingsManager;
	let service: ModelSettingsService;

	beforeEach(() => {
		agentDir = mkdtempSync(join(tmpdir(), "metis-image-settings-"));
		authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		settingsManager = SettingsManager.create(agentDir, agentDir);
		service = new ModelSettingsService({
			agentDir,
			authStorage,
			settingsManager,
			modelRegistry: ModelRegistry.create(authStorage, join(agentDir, "models.json")),
		});
	});

	afterEach(() => rmSync(agentDir, { recursive: true, force: true }));

	it.each(["openai-images", "google-interactions", "openrouter-images"] as const)(
		"keeps image credentials outside settings and the chat catalog through save, edit and removal (%s)",
		async (api) => {
			const profile = {
				name: "Image studio",
				api,
				baseUrl: "https://images.example.test/v1",
				modelId: "image-model",
			};
			expect(service.view().imageGeneration).toEqual({
				config: null,
				status: "unconfigured",
				authConfigured: false,
			});
			const saved = await service.update({
				type: "set_image_generation",
				config: profile,
				credential: { action: "set", value: "image-secret" },
			});
			expect(saved.imageGeneration).toEqual({ config: profile, status: "configured", authConfigured: true });
			expect(
				saved.providers.flatMap((provider) => provider.models).some((model) => model.modelId === profile.modelId),
			).toBe(false);
			expect(JSON.stringify(saved)).not.toContain("image-secret");
			expect(readFileSync(join(agentDir, "settings.json"), "utf8")).not.toContain("image-secret");
			expect(authStorage.get(IMAGE_GENERATION_AUTH_KEY)).toEqual({ type: "api_key", key: "image-secret" });
			validateResponseFor(
				"client",
				{ jsonrpc: "2.0", id: "image-settings", method: "model/settings/get", params: {} },
				{ jsonrpc: "2.0", id: "image-settings", result: saved },
			);

			await service.update({
				type: "set_image_generation",
				config: { ...profile, name: "Updated" },
				credential: { action: "keep" },
			});
			expect(SettingsManager.create(agentDir, agentDir).getImageGenerationConfig()?.name).toBe("Updated");
			expect(authStorage.get(IMAGE_GENERATION_AUTH_KEY)).toEqual({ type: "api_key", key: "image-secret" });
			await service.update({ type: "set_image_generation", config: null });
			expect(service.view().imageGeneration?.status).toBe("unconfigured");
			expect(authStorage.get(IMAGE_GENERATION_AUTH_KEY)).toBeUndefined();
			expect(SettingsManager.create(agentDir, agentDir).getImageGenerationConfig()).toBeUndefined();
		},
	);

	it("reuses an explicitly selected saved API key without changing shared credentials", async () => {
		authStorage.set("openai", { type: "api_key", key: "shared-key" });
		await service.update({
			type: "set_image_generation",
			config: profile,
			credential: { action: "set", value: "old-dedicated-key" },
		});
		const config = { ...profile, credentialProvider: "openai" };
		const saved = await service.update({ type: "set_image_generation", config, credential: { action: "remove" } });
		expect(saved.imageGeneration).toEqual({ config, status: "configured", authConfigured: true });
		expect(saved.providers.find((provider) => provider.provider === "openai")?.storedApiKey).toBe(true);
		expect(authStorage.get(IMAGE_GENERATION_AUTH_KEY)).toBeUndefined();
		await service.update({ type: "set_image_generation", config: null, credential: { action: "remove" } });
		expect(authStorage.get("openai")).toEqual({ type: "api_key", key: "shared-key" });
	});

	it("rejects missing, OAuth and invalid credentials without persisting the profile", async () => {
		await expect(service.update({ type: "set_image_generation", config: profile })).rejects.toThrow(/API key/);
		await expect(
			service.update({ type: "set_image_generation", config: profile, credential: { action: "set", value: "  " } }),
		).rejects.toThrow(/API key/);
		authStorage.set("openai", {
			type: "oauth",
			access: "oauth-secret",
			refresh: "refresh-secret",
			expires: Date.now() + 600_000,
		});
		expect(service.view().providers.find((provider) => provider.provider === "openai")?.storedApiKey).toBe(false);
		await expect(
			service.update({ type: "set_image_generation", config: { ...profile, credentialProvider: "openai" } }),
		).rejects.toThrow(/saved API key/);
		expect(settingsManager.getImageGenerationConfig()).toBeUndefined();
	});

	it("reports a removed shared API key without falling back to another credential", async () => {
		authStorage.set("openai", { type: "api_key", key: "shared-key" });
		await service.update({ type: "set_image_generation", config: { ...profile, credentialProvider: "openai" } });
		authStorage.remove("openai");
		expect(service.view().imageGeneration).toMatchObject({ status: "invalid", authConfigured: false });
	});

	it.each([
		{ remove: false, legacy: false },
		{ remove: true, legacy: false },
		{ remove: false, legacy: true },
	])("rolls back config and dedicated key after a failed settings write (%j)", async ({ remove, legacy }) => {
		const previousProfile = legacy ? { ...profile, retiredField: true } : profile;
		let contents = JSON.stringify({ imageGeneration: previousProfile, autoSessionTitle: false });
		let failNextWrite = false;
		const settings = SettingsManager.fromStorage({
			withLock(scope, callback) {
				if (scope === "project") return;
				const next = callback(contents);
				if (next !== undefined) {
					if (failNextWrite) {
						failNextWrite = false;
						throw new Error("disk unavailable");
					}
					contents = next;
				}
			},
		});
		authStorage.set(IMAGE_GENERATION_AUTH_KEY, { type: "api_key", key: "old-key" });
		const local = new ModelSettingsService({
			agentDir,
			authStorage,
			settingsManager: settings,
			modelRegistry: ModelRegistry.create(authStorage, join(agentDir, "models.json")),
		});
		failNextWrite = true;
		await expect(
			local.update({
				type: "set_image_generation",
				config: remove ? null : { ...profile, name: "Changed" },
				credential: remove ? { action: "remove" } : { action: "set", value: "new-key" },
			}),
		).rejects.toMatchObject({ code: "OPERATION_FAILED" });
		expect(settings.getGlobalSettings().imageGeneration).toEqual(previousProfile);
		expect(settings.getImageGenerationView().status).toBe(legacy ? "invalid" : "configured");
		expect(JSON.parse(contents)).toEqual({ imageGeneration: previousProfile, autoSessionTitle: false });
		expect(authStorage.get(IMAGE_GENERATION_AUTH_KEY)).toEqual({ type: "api_key", key: "old-key" });
	});

	it("does not change settings when credential persistence fails", async () => {
		const auth = AuthStorage.fromStorage({
			withLock(callback) {
				const result = callback("{}");
				if (result.next !== undefined) throw new Error("credential storage unavailable");
				return result.result;
			},
			async withLockAsync(callback) {
				const result = await callback("{}");
				if (result.next !== undefined) throw new Error("credential storage unavailable");
				return result.result;
			},
		});
		const local = new ModelSettingsService({
			agentDir,
			authStorage: auth,
			settingsManager,
			modelRegistry: ModelRegistry.create(auth, join(agentDir, "models.json")),
		});
		await expect(
			local.update({
				type: "set_image_generation",
				config: profile,
				credential: { action: "set", value: "new-key" },
			}),
		).rejects.toThrow("credential storage unavailable");
		expect(settingsManager.getImageGenerationConfig()).toBeUndefined();
		expect(auth.get(IMAGE_GENERATION_AUTH_KEY)).toBeUndefined();
	});
});
