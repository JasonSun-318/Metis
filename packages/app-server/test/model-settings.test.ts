import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateResponseFor } from "@metis/app-protocol";
import { AuthStorage, ModelRegistry, SettingsManager } from "@metis/coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelSettingsService } from "../src/model-settings.ts";

describe("ModelSettingsService", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = join(tmpdir(), `metis-model-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		if (existsSync(agentDir)) rmSync(agentDir, { recursive: true, force: true });
	});

	it("returns a protocol-valid view of the built-in model catalog", () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const service = new ModelSettingsService({
			agentDir,
			authStorage,
			modelRegistry: ModelRegistry.create(authStorage, join(agentDir, "models.json")),
			settingsManager: SettingsManager.create(agentDir, agentDir),
		});
		const request = {
			jsonrpc: "2.0" as const,
			id: "model-settings-view",
			method: "model/settings/get" as const,
			params: {},
		};
		expect(() =>
			validateResponseFor("client", request, {
				jsonrpc: "2.0",
				id: request.id,
				result: service.view(),
			}),
		).not.toThrow();
	});

	it("stores provider metadata and credentials separately, then clears removed defaults", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const settingsManager = SettingsManager.create(agentDir, agentDir);
		const service = new ModelSettingsService({ agentDir, authStorage, modelRegistry, settingsManager });

		const saved = await service.update({
			type: "save_provider",
			provider: "local-test",
			name: "Local Test",
			baseUrl: "https://example.test/v1/",
			api: "openai-completions",
			models: [
				{
					modelId: "test-model",
					name: "Test Model",
					contextWindow: 32_000,
					maxOutputTokens: 4_096,
					reasoning: false,
					imageInput: true,
				},
			],
			credential: { action: "set", value: "secret-test-key" },
		});

		expect(saved.providers.find((provider) => provider.provider === "local-test")).toMatchObject({
			name: "Local Test",
			builtin: false,
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
			auth: { configured: true, source: "stored" },
			models: [{ modelId: "test-model", imageInput: true, custom: true }],
		});
		expect(readFileSync(join(agentDir, "models.json"), "utf8")).not.toContain("secret-test-key");
		expect(readFileSync(join(agentDir, "auth.json"), "utf8")).toContain("secret-test-key");

		await service.update({
			type: "set_defaults",
			model: { provider: "local-test", modelId: "test-model" },
			thinkingSelection: "high",
		});
		expect(service.view()).toMatchObject({
			defaultModel: { provider: "local-test", modelId: "test-model" },
			defaultThinkingSelection: "high",
		});

		const removed = await service.update({ type: "remove_provider", provider: "local-test" });
		expect(removed.providers.some((provider) => provider.provider === "local-test")).toBe(false);
		expect(removed.defaultModel).toBeNull();
		expect(authStorage.has("local-test")).toBe(false);
	});

	it("accepts an anthropic-messages custom provider with its own base URL", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const service = new ModelSettingsService({
			agentDir,
			authStorage,
			modelRegistry: ModelRegistry.create(authStorage, join(agentDir, "models.json")),
			settingsManager: SettingsManager.create(agentDir, agentDir),
		});

		const saved = await service.update({
			type: "save_provider",
			provider: "claude-local",
			name: "Claude Local",
			baseUrl: "https://claude.example.test",
			api: "anthropic-messages",
			models: [
				{
					modelId: "claude-model",
					name: "Claude Model",
					contextWindow: 200_000,
					maxOutputTokens: 64_000,
					reasoning: true,
					imageInput: true,
				},
			],
			credential: { action: "set", value: "anthropic-test-key" },
		});

		expect(saved.providers.find((provider) => provider.provider === "claude-local")).toMatchObject({
			name: "Claude Local",
			builtin: false,
			baseUrl: "https://claude.example.test",
			api: "anthropic-messages",
			auth: { configured: true, source: "stored" },
			models: [{ modelId: "claude-model", contextWindow: 200_000, maxOutputTokens: 64_000, custom: true }],
		});
		expect(JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"))).toMatchObject({
			providers: {
				"claude-local": {
					api: "anthropic-messages",
					baseUrl: "https://claude.example.test",
				},
			},
		});
		expect(readFileSync(join(agentDir, "auth.json"), "utf8")).toContain("anthropic-test-key");
	});

	it("stores and clears built-in provider credentials without creating an invalid override", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const service = new ModelSettingsService({
			agentDir,
			authStorage,
			modelRegistry: ModelRegistry.create(authStorage, join(agentDir, "models.json")),
			settingsManager: SettingsManager.create(agentDir, agentDir),
		});

		const configured = await service.update({
			type: "save_provider",
			provider: "openai",
			name: "OpenAI",
			baseUrl: null,
			api: null,
			models: [],
			credential: { action: "set", value: "built-in-test-key" },
		});
		expect(configured.providers.find((provider) => provider.provider === "openai")?.auth).toMatchObject({
			configured: true,
			source: "stored",
		});
		expect(JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"))).toEqual({ providers: {} });
		await service.update({
			type: "set_defaults",
			model: { provider: "openai", modelId: "gpt-5" },
			thinkingSelection: "high",
		});

		const cleared = await service.update({
			type: "save_provider",
			provider: "openai",
			name: "OpenAI",
			baseUrl: null,
			api: null,
			models: [],
			credential: { action: "remove" },
		});
		expect(cleared.providers.find((provider) => provider.provider === "openai")?.auth.configured).toBe(false);
		expect(cleared.defaultModel).toBeNull();
		expect(authStorage.has("openai")).toBe(false);
	});

	it("rejects invalid custom provider URLs without touching disk", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const service = new ModelSettingsService({
			agentDir,
			authStorage,
			modelRegistry: ModelRegistry.create(authStorage, join(agentDir, "models.json")),
			settingsManager: SettingsManager.create(agentDir, agentDir),
		});

		await expect(
			service.update({
				type: "save_provider",
				provider: "local-test",
				name: "Local Test",
				baseUrl: "file:///tmp/provider",
				api: "openai-completions",
				models: [
					{
						modelId: "test-model",
						name: "Test Model",
						contextWindow: 32_000,
						maxOutputTokens: 4_096,
						reasoning: false,
						imageInput: false,
					},
				],
				credential: { action: "keep" },
			}),
		).rejects.toThrow("HTTP or HTTPS");
		expect(existsSync(join(agentDir, "models.json"))).toBe(true);
		expect(JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"))).toEqual({ providers: {} });
	});
});
