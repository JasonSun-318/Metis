import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateResponseFor } from "@metis/app-protocol";
import {
	AuthStorage,
	DEDICATED_REVIEWER_AUTH_KEY,
	DEDICATED_REVIEWER_PROVIDER,
	ModelRegistry,
	SettingsManager,
} from "@metis/coding-agent/host";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSettingsService } from "../src/model-settings.ts";

const dedicatedReviewer = {
	source: "dedicated",
	name: "Local reviewer",
	api: "openai-completions",
	baseUrl: "http://127.0.0.1:1234/v1",
	modelId: "review-model",
	thinkingLevel: "off",
	timeoutMs: 8_000,
	maxOutputTokens: 512,
	reasoningMode: "off",
} as const;

describe("ModelSettingsService", () => {
	let agentDir: string;

	beforeEach(() => {
		agentDir = join(tmpdir(), `metis-model-settings-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(agentDir, { recursive: true });
	});

	afterEach(() => {
		vi.unstubAllGlobals();
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
					reasoningMode: "off",
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
			defaultThinkingSelection: "off",
		});

		const removed = await service.update({ type: "remove_provider", provider: "local-test" });
		expect(removed.providers.some((provider) => provider.provider === "local-test")).toBe(false);
		expect(removed.defaultModel).toBeNull();
		expect(authStorage.has("local-test")).toBe(false);
	});

	it("configures, updates, and clears the vision service", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const settingsManager = SettingsManager.create(agentDir, agentDir);
		const service = new ModelSettingsService({ agentDir, authStorage, modelRegistry, settingsManager });

		expect(service.view().vision).toBeNull();

		await expect(
			service.update({
				type: "set_vision",
				settings: {
					name: "My vision",
					baseUrl: "https://api.example.com/v1",
					api: "openai-responses",
					modelId: "gpt-4o",
				},
				credential: { action: "keep" },
			}),
		).rejects.toThrow(/Enter an API key/);

		const saved = await service.update({
			type: "set_vision",
			settings: {
				name: "My vision",
				baseUrl: "https://api.example.com/v1/",
				api: "openai-responses",
				modelId: "gpt-4o",
			},
			credential: { action: "set", value: "sk-vision-key" },
		});
		expect(saved.vision).toEqual({
			name: "My vision",
			baseUrl: "https://api.example.com/v1/",
			api: "openai-responses",
			modelId: "gpt-4o",
			authConfigured: true,
		});
		expect(authStorage.has("vision")).toBe(true);
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"))).toMatchObject({
			vision: {
				name: "My vision",
				baseUrl: "https://api.example.com/v1/",
				api: "openai-responses",
				modelId: "gpt-4o",
			},
		});

		const updated = await service.update({
			type: "set_vision",
			settings: {
				name: "Renamed vision",
				baseUrl: "https://api.example.com/v1",
				api: "openai-completions",
				modelId: "gpt-4o-mini",
			},
			credential: { action: "keep" },
		});
		expect(updated.vision).toMatchObject({
			name: "Renamed vision",
			api: "openai-completions",
			modelId: "gpt-4o-mini",
			authConfigured: true,
		});

		const cleared = await service.update({ type: "set_vision", settings: null, credential: { action: "remove" } });
		expect(cleared.vision).toBeNull();
		expect(authStorage.has("vision")).toBe(false);
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
					reasoningMode: "generic",
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

	it("resolves custom model reasoning modes through the generated catalog", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const service = new ModelSettingsService({
			agentDir,
			authStorage,
			modelRegistry: ModelRegistry.create(authStorage, join(agentDir, "models.json")),
			settingsManager: SettingsManager.create(agentDir, agentDir),
		});

		const saved = await service.update({
			type: "save_provider",
			provider: "codex-proxy",
			name: "Codex Proxy",
			baseUrl: "https://proxy.example.test/v1",
			api: "openai-completions",
			models: [
				{
					modelId: "zai-org/GLM-5.3-Fast",
					name: "GLM 5.3 Fast",
					contextWindow: 128_000,
					maxOutputTokens: 64_000,
					reasoningMode: "auto",
					imageInput: true,
				},
				{
					modelId: "not-in-catalog",
					name: "Mystery",
					contextWindow: 32_000,
					maxOutputTokens: 4_096,
					reasoningMode: "auto",
					imageInput: false,
				},
				{
					modelId: "generic-model",
					name: "Generic",
					contextWindow: 32_000,
					maxOutputTokens: 4_096,
					reasoningMode: "generic",
					imageInput: false,
				},
				{
					modelId: "off-model",
					name: "Off",
					contextWindow: 32_000,
					maxOutputTokens: 4_096,
					reasoningMode: "off",
					imageInput: false,
				},
			],
			credential: { action: "set", value: "proxy-test-key" },
		});

		const provider = saved.providers.find((entry) => entry.provider === "codex-proxy");
		const byId = new Map(provider?.models.map((model) => [model.modelId, model]));
		expect(byId.get("zai-org/GLM-5.3-Fast")).toMatchObject({
			reasoning: true,
			thinkingLevels: ["low", "high", "max"],
			reasoningMode: "auto",
			reasoningSource: "catalog",
		});
		expect(byId.get("not-in-catalog")).toMatchObject({
			reasoning: false,
			thinkingLevels: ["off"],
			reasoningMode: "auto",
			reasoningSource: "unrecognized",
		});
		expect(byId.get("generic-model")).toMatchObject({
			reasoning: true,
			thinkingLevels: ["off", "low", "medium", "high"],
			reasoningMode: "generic",
			reasoningSource: "generic",
		});
		expect(byId.get("off-model")).toMatchObject({
			reasoning: false,
			thinkingLevels: ["off"],
			reasoningMode: "off",
			reasoningSource: "off",
		});

		const defaults = await service.update({
			type: "set_defaults",
			model: { provider: "codex-proxy", modelId: "zai-org/GLM-5.3-Fast" },
			thinkingSelection: "medium",
		});
		expect(defaults.defaultThinkingSelection).toBe("high");

		const persisted = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
		const savedModels = persisted.providers["codex-proxy"].models;
		const savedModel = savedModels.find((model: { id: string }) => model.id === "zai-org/GLM-5.3-Fast");
		expect(savedModel).toMatchObject({ reasoningMode: "auto" });
		expect(savedModel).not.toHaveProperty("reasoning");
		expect(savedModel).not.toHaveProperty("thinkingLevelMap");
	});

	it("saves, reads, preserves, and validates explicit manual thinking maps", async () => {
		const modelsPath = join(agentDir, "models.json");
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, modelsPath);
		const settingsManager = SettingsManager.create(agentDir, agentDir);
		const service = new ModelSettingsService({ agentDir, authStorage, modelRegistry, settingsManager });

		const saved = await service.update({
			type: "save_provider",
			provider: "manual-provider",
			name: "Manual Provider",
			baseUrl: "https://manual.example.test/v1",
			api: "openai-responses",
			models: [
				{
					modelId: "manual-model",
					name: "Manual Model",
					contextWindow: 128_000,
					maxOutputTokens: 16_384,
					reasoningMode: "manual",
					thinkingLevelMap: { low: "low", high: "high", max: null },
					imageInput: false,
				},
			],
			credential: { action: "set", value: "manual-test-key" },
		});

		const expectedMap = {
			off: null,
			minimal: null,
			low: "low",
			medium: null,
			high: "high",
			xhigh: null,
			max: null,
		};
		const provider = saved.providers.find((entry) => entry.provider === "manual-provider");
		expect(provider?.models[0]).toMatchObject({
			reasoning: true,
			thinkingLevels: ["low", "high"],
			reasoningMode: "manual",
			reasoningSource: "manual",
			thinkingLevelMap: expectedMap,
		});

		const persisted = JSON.parse(readFileSync(modelsPath, "utf8"));
		const savedModel = persisted.providers["manual-provider"].models[0];
		expect(savedModel).toMatchObject({ reasoningMode: "manual", thinkingLevelMap: expectedMap });
		expect(savedModel).not.toHaveProperty("reasoning");

		// Updating provider metadata without a map keeps the existing manual map.
		const renamed = await service.update({
			type: "save_provider",
			provider: "manual-provider",
			name: "Manual Provider Renamed",
			baseUrl: "https://manual.example.test/v1",
			api: "openai-responses",
			models: [
				{
					modelId: "manual-model",
					name: "Manual Model",
					contextWindow: 128_000,
					maxOutputTokens: 16_384,
					reasoningMode: "manual",
					imageInput: false,
				},
			],
			credential: { action: "keep" },
		});
		expect(
			renamed.providers.find((entry) => entry.provider === "manual-provider")?.models[0]?.thinkingLevelMap,
		).toEqual(expectedMap);

		await service.update({
			type: "set_defaults",
			model: { provider: "manual-provider", modelId: "manual-model" },
			thinkingSelection: "high",
		});
		expect(service.view().defaultThinkingSelection).toBe("high");
		await expect(
			service.update({
				type: "set_defaults",
				model: { provider: "manual-provider", modelId: "manual-model" },
				thinkingSelection: "off",
			}),
		).rejects.toThrow(/not configured/);
		expect(service.view().defaultThinkingSelection).toBe("high");

		const beforeInvalidSave = readFileSync(modelsPath, "utf8");
		await expect(
			service.update({
				type: "save_provider",
				provider: "manual-provider",
				name: "Manual Provider",
				baseUrl: null,
				api: null,
				models: [
					{
						modelId: "empty-manual",
						name: "Empty Manual",
						contextWindow: 128_000,
						maxOutputTokens: 16_384,
						reasoningMode: "manual",
						imageInput: false,
					},
				],
				credential: { action: "keep" },
			}),
		).rejects.toThrow(/at least one manual thinking level value/);
		expect(readFileSync(modelsPath, "utf8")).toBe(beforeInvalidSave);
	});

	it("tests a manual model with a configured level when off is unavailable", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const settingsManager = SettingsManager.create(agentDir, agentDir);
		const service = new ModelSettingsService({ agentDir, authStorage, modelRegistry, settingsManager });

		await service.update({
			type: "save_provider",
			provider: "manual-test",
			name: "Manual Test",
			baseUrl: "https://example.test/v1",
			api: "openai-responses",
			models: [
				{
					modelId: "manual-test-model",
					name: "Manual Test Model",
					contextWindow: 128_000,
					maxOutputTokens: 8_192,
					reasoningMode: "manual",
					thinkingLevelMap: { high: "high", xhigh: "xhigh" },
					imageInput: false,
				},
			],
			credential: { action: "set", value: "manual-test-key" },
		});

		const fakeStream = { result: async () => ({}) } as unknown as ReturnType<ModelRegistry["streamSimple"]>;
		const streamSimple = vi.spyOn(modelRegistry, "streamSimple").mockReturnValue(fakeStream);

		await service.update({
			type: "set_defaults",
			model: { provider: "manual-test", modelId: "manual-test-model" },
			thinkingSelection: "xhigh",
		});
		const result = await service.testConnection({
			requestId: "00000000-0000-4000-8000-000000000000",
			kind: "chat",
			provider: "manual-test",
			modelId: "manual-test-model",
		});

		expect(result.ok).toBe(true);
		const options = streamSimple.mock.calls[0]?.[2];
		expect(options?.reasoning).toBe("high");
		expect(settingsManager.getDefaultThinkingLevel()).toBe("xhigh");
		expect(options?.apiKey).toBe("manual-test-key");

		const modelsPath = join(agentDir, "models.json");
		const config = JSON.parse(readFileSync(modelsPath, "utf8"));
		config.providers["manual-test"].models[0].thinkingLevelMap.off = "none";
		writeFileSync(modelsPath, JSON.stringify(config));
		await service.update({
			type: "set_defaults",
			model: { provider: "manual-test", modelId: "manual-test-model" },
			thinkingSelection: "off",
		});
		const offResult = await service.testConnection({
			requestId: "00000000-0000-4000-8000-000000000003",
			kind: "chat",
			provider: "manual-test",
			modelId: "manual-test-model",
		});
		expect(offResult.ok).toBe(true);
		expect(streamSimple.mock.calls[1]?.[2]?.reasoning).toBeUndefined();
	});

	it("uses the lowest supported level for a legacy reasoning-only model without a manual flag", async () => {
		const modelsPath = join(agentDir, "models.json");
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					legacy: {
						api: "openai-completions",
						baseUrl: "https://example.test/v1",
						apiKey: "fixture-key",
						models: [
							{
								id: "legacy-reasoning",
								name: "Legacy",
								reasoning: true,
								input: ["text"],
								contextWindow: 128000,
								maxTokens: 8192,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
								thinkingLevelMap: {
									off: null,
									minimal: null,
									low: "low",
									medium: null,
									high: "high",
									xhigh: null,
									max: null,
								},
							},
						],
					},
				},
			}),
		);
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, modelsPath);
		const settingsManager = SettingsManager.create(agentDir, agentDir);
		const service = new ModelSettingsService({ agentDir, authStorage, modelRegistry, settingsManager });
		expect(modelRegistry.find("legacy", "legacy-reasoning")?.explicitThinkingLevels).toBeUndefined();
		const stream = vi
			.spyOn(modelRegistry, "streamSimple")
			.mockReturnValue({ result: async () => ({}) } as unknown as ReturnType<ModelRegistry["streamSimple"]>);
		expect(
			(
				await service.testConnection({
					requestId: "00000000-0000-4000-8000-000000000000",
					kind: "chat",
					provider: "legacy",
					modelId: "legacy-reasoning",
				})
			).ok,
		).toBe(true);
		expect(stream.mock.calls[0]?.[2]?.reasoning).toBe("low");
	});

	it("reports stream error and aborted outcomes instead of successful connections", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const settingsManager = SettingsManager.create(agentDir, agentDir);
		const service = new ModelSettingsService({ agentDir, authStorage, modelRegistry, settingsManager });

		await service.update({
			type: "save_provider",
			provider: "manual-test",
			name: "Manual Test",
			baseUrl: "https://example.test/v1",
			api: "openai-responses",
			models: [
				{
					modelId: "manual-test-model",
					name: "Manual Test Model",
					contextWindow: 128_000,
					maxOutputTokens: 8_192,
					reasoningMode: "manual",
					thinkingLevelMap: { high: "high", xhigh: "xhigh" },
					imageInput: false,
				},
			],
			credential: { action: "set", value: "secret-stream-key" },
		});

		const streamResult = (stopReason: "error" | "aborted", errorMessage?: string) =>
			({
				result: async () => ({ stopReason, ...(errorMessage ? { errorMessage } : {}) }),
			}) as unknown as ReturnType<ModelRegistry["streamSimple"]>;
		const streamSimple = vi
			.spyOn(modelRegistry, "streamSimple")
			.mockReturnValueOnce(streamResult("error", "401 Unauthorized: Bearer secret-stream-key"))
			.mockReturnValueOnce(streamResult("aborted"));

		const request = {
			requestId: "00000000-0000-4000-8000-000000000001",
			kind: "chat" as const,
			provider: "manual-test",
			modelId: "manual-test-model",
		};

		const failed = await service.testConnection(request);
		expect(failed.ok).toBe(false);
		expect(failed.message).not.toContain("secret-stream-key");
		expect(failed.message).toContain("[redacted]");

		const aborted = await service.testConnection({ ...request, requestId: "00000000-0000-4000-8000-000000000002" });
		expect(aborted.ok).toBe(false);
		expect(aborted.message).toMatch(/aborted/i);
		expect(streamSimple).toHaveBeenCalledTimes(2);
	});

	it("preserves hand-edited model capabilities when saving unrelated provider fields", async () => {
		const modelsPath = join(agentDir, "models.json");
		writeFileSync(
			modelsPath,
			`${JSON.stringify(
				{
					providers: {
						custom: {
							name: "Custom",
							baseUrl: "https://example.test/v1",
							api: "openai-completions",
							models: [
								{
									id: "special-model",
									name: "Special",
									reasoning: true,
									thinkingLevelMap: { off: null, low: "low", high: "high" },
									compat: { supportsReasoningEffort: true },
									input: ["text"],
									contextWindow: 32_000,
									maxTokens: 4_096,
								},
							],
						},
					},
				},
				null,
				2,
			)}\n`,
		);
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const service = new ModelSettingsService({
			agentDir,
			authStorage,
			modelRegistry: ModelRegistry.create(authStorage, modelsPath),
			settingsManager: SettingsManager.create(agentDir, agentDir),
		});

		await service.update({
			type: "save_provider",
			provider: "custom",
			name: "Custom renamed",
			baseUrl: "https://example.test/v1",
			api: "openai-completions",
			models: [
				{
					modelId: "special-model",
					name: "Special",
					contextWindow: 32_000,
					maxOutputTokens: 4_096,
					reasoningMode: "auto",
					imageInput: false,
				},
			],
			credential: { action: "keep" },
		});

		const persisted = JSON.parse(readFileSync(modelsPath, "utf8"));
		const savedModel = persisted.providers.custom.models[0];
		expect(savedModel).toMatchObject({
			reasoning: true,
			thinkingLevelMap: { off: null, low: "low", high: "high" },
			compat: { supportsReasoningEffort: true },
		});
		expect(savedModel).not.toHaveProperty("reasoningMode");
	});

	it("reports an unconfigured independent permission reviewer by default", () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const service = new ModelSettingsService({
			agentDir,
			authStorage,
			modelRegistry: ModelRegistry.create(authStorage, join(agentDir, "models.json")),
			settingsManager: SettingsManager.create(agentDir, agentDir),
		});
		expect(service.view().permissionReviewer).toEqual({ config: null, status: "unconfigured" });
	});

	it("marks a structurally valid profile invalid when its model is no longer registered", () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const config = {
			provider: "removed-provider",
			modelId: "removed-model",
			thinkingLevel: "off",
			timeoutMs: 8000,
			maxOutputTokens: 512,
		} as const;
		const service = new ModelSettingsService({
			agentDir,
			authStorage,
			modelRegistry: ModelRegistry.create(authStorage, join(agentDir, "models.json")),
			settingsManager: SettingsManager.inMemory({ permissionReviewer: config }),
		});
		expect(service.view().permissionReviewer).toEqual({ config, status: "invalid" });
	});

	it("saves an independent reviewer profile without changing chat defaults", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const settingsManager = SettingsManager.create(agentDir, agentDir);
		const service = new ModelSettingsService({ agentDir, authStorage, modelRegistry, settingsManager });
		await service.update({
			type: "save_provider",
			provider: "review-provider",
			name: "Review Provider",
			baseUrl: "https://review.example.test/v1",
			api: "openai-responses",
			models: [
				{
					modelId: "review-model",
					name: "Review Model",
					contextWindow: 128_000,
					maxOutputTokens: 16_384,
					reasoningMode: "manual",
					thinkingLevelMap: { low: "low", high: "high", max: null },
					imageInput: false,
				},
			],
			credential: { action: "set", value: "review-test-key" },
		});
		await service.update({
			type: "set_defaults",
			model: { provider: "review-provider", modelId: "review-model" },
			thinkingSelection: "high",
		});

		const saved = await service.update({
			type: "set_permission_reviewer",
			config: {
				provider: "review-provider",
				modelId: "review-model",
				thinkingLevel: "low",
				timeoutMs: 12_000,
				maxOutputTokens: 2_048,
			},
		});
		expect(saved.permissionReviewer).toEqual({
			config: {
				provider: "review-provider",
				modelId: "review-model",
				thinkingLevel: "low",
				timeoutMs: 12_000,
				maxOutputTokens: 2_048,
			},
			status: "configured",
		});
		expect(saved.defaultModel).toEqual({ provider: "review-provider", modelId: "review-model" });
		expect(saved.defaultThinkingSelection).toBe("high");
		expect(settingsManager.getAutoReviewerEnabled()).toBe(false);

		const persisted = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
		expect(persisted).toMatchObject({
			defaultProvider: "review-provider",
			defaultModel: "review-model",
			defaultThinkingLevel: "high",
			permissionReviewer: {
				provider: "review-provider",
				modelId: "review-model",
				thinkingLevel: "low",
				timeoutMs: 12_000,
				maxOutputTokens: 2_048,
			},
		});

		const cleared = await service.update({ type: "set_permission_reviewer", config: null });
		expect(cleared.permissionReviewer).toEqual({ config: null, status: "unconfigured" });
		expect(cleared.defaultModel).toEqual({ provider: "review-provider", modelId: "review-model" });
	});

	it("rejects missing models, unsupported thinking, oversized budgets, and extra fields", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const settingsManager = SettingsManager.create(agentDir, agentDir);
		const service = new ModelSettingsService({ agentDir, authStorage, modelRegistry, settingsManager });
		await service.update({
			type: "save_provider",
			provider: "review-provider",
			name: "Review Provider",
			baseUrl: "https://review.example.test/v1",
			api: "anthropic-messages",
			models: [
				{
					modelId: "review-model",
					name: "Review Model",
					contextWindow: 128_000,
					maxOutputTokens: 16_384,
					reasoningMode: "manual",
					thinkingLevelMap: { low: "low", high: "high", max: null },
					imageInput: false,
				},
				{
					modelId: "small-model",
					name: "Small Model",
					contextWindow: 32_000,
					maxOutputTokens: 4_096,
					reasoningMode: "off",
					imageInput: false,
				},
			],
			credential: { action: "keep" },
		});
		const base = {
			provider: "review-provider",
			modelId: "review-model",
			thinkingLevel: "low",
			timeoutMs: 8_000,
			maxOutputTokens: 2_048,
		} as const;

		for (const config of [
			{ ...base, provider: "missing-provider" },
			{ ...base, modelId: "missing-model" },
			{ ...base, thinkingLevel: "off" },
			{ ...base, modelId: "small-model", maxOutputTokens: 8_192 },
			{ ...base, apiKey: "not-allowed" },
		]) {
			await expect(service.update({ type: "set_permission_reviewer", config: config as never })).rejects.toThrow();
		}
		expect(service.view().permissionReviewer).toEqual({ config: null, status: "unconfigured" });
	});

	it("marks a legacy reviewer object invalid without reviving or enabling it", () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const settingsManager = SettingsManager.inMemory({
			permissionReviewer: {
				provider: "review-provider",
				modelId: "review-model",
				version: 2,
				assessmentId: "old",
			},
		} as never);
		const service = new ModelSettingsService({
			agentDir,
			authStorage,
			modelRegistry: ModelRegistry.create(authStorage, join(agentDir, "models.json")),
			settingsManager,
		});
		expect(service.view().permissionReviewer).toEqual({ config: null, status: "invalid" });
		expect(settingsManager.getAutoReviewerEnabled()).toBe(false);
		expect(settingsManager.getPermissionReviewerConfig()).toBeUndefined();
	});

	it("restores the previous reviewer profile when persistence fails", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const settingsManager = SettingsManager.create(agentDir, agentDir);
		const service = new ModelSettingsService({ agentDir, authStorage, modelRegistry, settingsManager });
		await service.update({
			type: "save_provider",
			provider: "review-provider",
			name: "Review Provider",
			baseUrl: "https://review.example.test/v1",
			api: "openai-completions",
			models: [
				{
					modelId: "review-model",
					name: "Review Model",
					contextWindow: 128_000,
					maxOutputTokens: 16_384,
					reasoningMode: "manual",
					thinkingLevelMap: { low: "low", high: "high" },
					imageInput: false,
				},
			],
			credential: { action: "keep" },
		});
		const previous = {
			provider: "review-provider",
			modelId: "review-model",
			thinkingLevel: "low",
			timeoutMs: 8_000,
			maxOutputTokens: 1_024,
		} as const;
		await service.update({ type: "set_permission_reviewer", config: previous });
		vi.spyOn(settingsManager, "flushOrThrow").mockRejectedValueOnce(new Error("disk unavailable"));

		await expect(
			service.update({
				type: "set_permission_reviewer",
				config: { ...previous, thinkingLevel: "high", timeoutMs: 10_000 },
			}),
		).rejects.toMatchObject({ code: "OPERATION_FAILED" });
		expect(service.view().permissionReviewer).toEqual({ config: previous, status: "configured" });
	});

	it("preserves a legacy invalid reviewer object verbatim when persistence fails", async () => {
		const legacy = {
			provider: "review-provider",
			modelId: "review-model",
			version: 2,
			assessmentId: "old",
		};
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ permissionReviewer: legacy }));
		const settingsManager = SettingsManager.create(agentDir, agentDir);
		const service = new ModelSettingsService({ agentDir, authStorage, modelRegistry, settingsManager });
		await service.update({
			type: "save_provider",
			provider: "review-provider",
			name: "Review Provider",
			baseUrl: "https://review.example.test/v1",
			api: "openai-completions",
			models: [
				{
					modelId: "review-model",
					name: "Review Model",
					contextWindow: 128_000,
					maxOutputTokens: 16_384,
					reasoningMode: "manual",
					thinkingLevelMap: { low: "low", high: "high" },
					imageInput: false,
				},
			],
			credential: { action: "keep" },
		});
		vi.spyOn(settingsManager, "flushOrThrow").mockRejectedValueOnce(new Error("disk unavailable"));

		await expect(
			service.update({
				type: "set_permission_reviewer",
				config: {
					provider: "review-provider",
					modelId: "review-model",
					thinkingLevel: "low",
					timeoutMs: 8_000,
					maxOutputTokens: 1_024,
				},
			}),
		).rejects.toMatchObject({ code: "OPERATION_FAILED" });

		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).permissionReviewer).toEqual(legacy);
		expect(service.view().permissionReviewer).toEqual({ config: null, status: "invalid" });
	});

	it("saves a dedicated reviewer credential in its isolated auth key", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const settingsManager = SettingsManager.create(agentDir, agentDir);
		const service = new ModelSettingsService({ agentDir, authStorage, modelRegistry, settingsManager });
		await service.update({
			type: "save_provider",
			provider: "permission-reviewer",
			name: "Shared fixture provider",
			baseUrl: "https://shared.example.test/v1",
			api: "openai-completions",
			models: [
				{
					modelId: "shared-model",
					name: "Shared Model",
					contextWindow: 32_000,
					maxOutputTokens: 8_192,
					reasoningMode: "off",
					imageInput: false,
				},
			],
			credential: { action: "set", value: "shared-key" },
		});
		const sharedCredential = authStorage.get("permission-reviewer");

		const saved = await service.update({
			type: "set_permission_reviewer",
			config: dedicatedReviewer,
			credential: { action: "set", value: "dedicated-key" },
		});
		expect(saved.permissionReviewer).toEqual({
			config: dedicatedReviewer,
			status: "configured",
			authConfigured: true,
		});
		// The dedicated model is synthesized on demand and never joins the chat catalog.
		expect(modelRegistry.find(DEDICATED_REVIEWER_PROVIDER, "review-model")).toBeUndefined();
		expect(saved.providers.some((provider) => provider.provider === DEDICATED_REVIEWER_PROVIDER)).toBe(false);
		expect(authStorage.get(DEDICATED_REVIEWER_AUTH_KEY)).toMatchObject({
			type: "api_key",
			key: "dedicated-key",
		});
		// Shared provider configuration and auth stay untouched.
		expect(authStorage.get("permission-reviewer")).toEqual(sharedCredential);
		expect(saved.providers.find((provider) => provider.provider === "permission-reviewer")).toMatchObject({
			auth: { configured: true, source: "stored" },
			models: [{ modelId: "shared-model" }],
		});
		const settings = readFileSync(join(agentDir, "settings.json"), "utf8");
		expect(JSON.parse(settings).permissionReviewer).toEqual(dedicatedReviewer);
		expect(settings).not.toContain("dedicated-key");
		expect(JSON.stringify(saved)).not.toContain("dedicated-key");

		const kept = await service.update({
			type: "set_permission_reviewer",
			config: { ...dedicatedReviewer, timeoutMs: 9_000 },
			credential: { action: "keep" },
		});
		expect(kept.permissionReviewer).toMatchObject({ status: "configured", config: { timeoutMs: 9_000 } });
		expect(authStorage.get(DEDICATED_REVIEWER_AUTH_KEY)).toMatchObject({ key: "dedicated-key" });

		const cleared = await service.update({
			type: "set_permission_reviewer",
			config: null,
			credential: { action: "remove" },
		});
		expect(cleared.permissionReviewer).toEqual({ config: null, status: "unconfigured" });
		expect(authStorage.has(DEDICATED_REVIEWER_AUTH_KEY)).toBe(false);
		expect(authStorage.get("permission-reviewer")).toEqual(sharedCredential);
	});

	it("requires a dedicated credential and keeps it away from shared profiles", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const settingsManager = SettingsManager.create(agentDir, agentDir);
		const service = new ModelSettingsService({ agentDir, authStorage, modelRegistry, settingsManager });

		await expect(service.update({ type: "set_permission_reviewer", config: dedicatedReviewer })).rejects.toThrow(
			/Enter an API key/,
		);
		await expect(
			service.update({
				type: "set_permission_reviewer",
				config: dedicatedReviewer,
				credential: { action: "remove" },
			}),
		).rejects.toThrow(/requires an API key/);
		await service.update({
			type: "save_provider",
			provider: "shared-provider",
			name: "Shared Provider",
			baseUrl: "https://shared.example.test/v1",
			api: "openai-completions",
			models: [
				{
					modelId: "shared-model",
					name: "Shared Model",
					contextWindow: 32_000,
					maxOutputTokens: 8_192,
					reasoningMode: "off",
					imageInput: false,
				},
			],
			credential: { action: "set", value: "shared-key" },
		});
		await expect(
			service.update({
				type: "set_permission_reviewer",
				config: {
					provider: "shared-provider",
					modelId: "shared-model",
					thinkingLevel: "off",
					timeoutMs: 8_000,
					maxOutputTokens: 512,
				},
				credential: { action: "set", value: "shared-key" },
			}),
		).rejects.toThrow(/only supported for dedicated/);
		expect(service.view().permissionReviewer).toEqual({ config: null, status: "unconfigured" });
		expect(authStorage.has(DEDICATED_REVIEWER_AUTH_KEY)).toBe(false);

		for (const config of [
			{ ...dedicatedReviewer, api: "unsupported-api" },
			{ ...dedicatedReviewer, baseUrl: "ftp://review.example.test/v1" },
			{ ...dedicatedReviewer, reasoningMode: "manual" },
			{ ...dedicatedReviewer, maxOutputTokens: 8_193 },
			{ ...dedicatedReviewer, apiKey: "leaked" },
		]) {
			await expect(
				service.update({
					type: "set_permission_reviewer",
					config: config as never,
					credential: { action: "set", value: "dedicated-key" },
				}),
			).rejects.toThrow();
		}
		expect(service.view().permissionReviewer).toEqual({ config: null, status: "unconfigured" });
		expect(authStorage.has(DEDICATED_REVIEWER_AUTH_KEY)).toBe(false);
	});

	it("shows the normalized manual map for a dedicated reviewer", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const service = new ModelSettingsService({
			agentDir,
			authStorage,
			modelRegistry,
			settingsManager: SettingsManager.create(agentDir, agentDir),
		});
		const saved = await service.update({
			type: "set_permission_reviewer",
			config: {
				...dedicatedReviewer,
				thinkingLevel: "low",
				reasoningMode: "manual",
				thinkingLevelMap: { low: "low" },
			},
			credential: { action: "set", value: "dedicated-key" },
		});
		expect(saved.permissionReviewer).toMatchObject({
			status: "configured",
			authConfigured: true,
			config: {
				thinkingLevel: "low",
				reasoningMode: "manual",
				thinkingLevelMap: {
					off: null,
					minimal: null,
					low: "low",
					medium: null,
					high: null,
					xhigh: null,
					max: null,
				},
			},
		});
	});

	it("restores the previous dedicated config and credential when persistence fails", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const settingsManager = SettingsManager.create(agentDir, agentDir);
		const service = new ModelSettingsService({ agentDir, authStorage, modelRegistry, settingsManager });
		await service.update({
			type: "set_permission_reviewer",
			config: dedicatedReviewer,
			credential: { action: "set", value: "first-key" },
		});
		vi.spyOn(settingsManager, "flushOrThrow").mockRejectedValueOnce(new Error("disk unavailable"));

		await expect(
			service.update({
				type: "set_permission_reviewer",
				config: { ...dedicatedReviewer, name: "Renamed reviewer" },
				credential: { action: "set", value: "second-key" },
			}),
		).rejects.toMatchObject({ code: "OPERATION_FAILED" });
		expect(service.view().permissionReviewer).toEqual({
			config: dedicatedReviewer,
			status: "configured",
			authConfigured: true,
		});
		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).permissionReviewer).toEqual(
			dedicatedReviewer,
		);
		expect(authStorage.get(DEDICATED_REVIEWER_AUTH_KEY)).toMatchObject({ key: "first-key" });
	});

	it("preserves a legacy invalid reviewer object and drops a failed dedicated credential", async () => {
		const legacy = {
			provider: "review-provider",
			modelId: "review-model",
			version: 2,
			assessmentId: "old",
		};
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ permissionReviewer: legacy }));
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
		const settingsManager = SettingsManager.create(agentDir, agentDir);
		const service = new ModelSettingsService({ agentDir, authStorage, modelRegistry, settingsManager });
		vi.spyOn(settingsManager, "flushOrThrow").mockRejectedValueOnce(new Error("disk unavailable"));

		await expect(
			service.update({
				type: "set_permission_reviewer",
				config: dedicatedReviewer,
				credential: { action: "set", value: "dedicated-key" },
			}),
		).rejects.toMatchObject({ code: "OPERATION_FAILED" });

		expect(JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")).permissionReviewer).toEqual(legacy);
		expect(service.view().permissionReviewer).toEqual({ config: null, status: "invalid" });
		expect(authStorage.has(DEDICATED_REVIEWER_AUTH_KEY)).toBe(false);
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
						reasoningMode: "off",
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
