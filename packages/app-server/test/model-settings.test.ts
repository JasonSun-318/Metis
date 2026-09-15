import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateResponseFor } from "@metis/app-protocol";
import {
	AuthStorage,
	getLatestMemoryError,
	MEMORY_EMBEDDING_CREDENTIAL_ID,
	MEMORY_RERANK_CREDENTIAL_ID,
	ModelRegistry,
	SettingsManager,
} from "@metis/coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSettingsService } from "../src/model-settings.ts";
import { recordMemoryHealth } from "./fixtures/memory-health.ts";

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

	it("keeps specialized settings and dedicated credentials consistent", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const settingsManager = SettingsManager.create(agentDir, agentDir);
		const service = new ModelSettingsService({
			agentDir,
			authStorage,
			modelRegistry: ModelRegistry.create(authStorage, join(agentDir, "models.json")),
			settingsManager,
		});
		const embedding = {
			name: "Qwen Embedding",
			provider: "Qwen",
			baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1/",
			api: "openai-compatible" as const,
			modelId: "text-embedding-v4",
		};

		await expect(
			service.update({ type: "set_embedding", settings: embedding, credential: { action: "keep" } }),
		).rejects.toThrow(/stored dedicated credential/i);
		const saved = await service.update({
			type: "set_embedding",
			settings: embedding,
			credential: { action: "set", value: "embedding-secret" },
		});
		expect(saved.embedding).toMatchObject({
			...embedding,
			baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
			authConfigured: true,
		});
		expect(authStorage.get(MEMORY_EMBEDDING_CREDENTIAL_ID)).toMatchObject({ type: "api_key" });
		await expect(
			service.update({ type: "set_embedding", settings: embedding, credential: { action: "remove" } }),
		).rejects.toThrow(/credential mutation/i);
		await expect(
			service.update({ type: "set_rerank", settings: null, credential: { action: "keep" } }),
		).rejects.toThrow(/requires removing/i);

		settingsManager.setMemoryEngine("extract");
		await settingsManager.flushOrThrow();
		const removed = await service.update({
			type: "set_embedding",
			settings: null,
			credential: { action: "remove" },
		});
		expect(removed.embedding).toBeNull();
		expect(authStorage.has(MEMORY_EMBEDDING_CREDENTIAL_ID)).toBe(false);
		expect(settingsManager.getMemoryEngine()).toBe("index");
		expect(authStorage.has(MEMORY_RERANK_CREDENTIAL_ID)).toBe(false);
	});

	it("clears only matching memory health after specialized settings change", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const service = new ModelSettingsService({
			agentDir,
			authStorage,
			modelRegistry: ModelRegistry.create(authStorage, join(agentDir, "models.json")),
			settingsManager: SettingsManager.create(agentDir, agentDir),
		});
		expect(getLatestMemoryError(agentDir)).toBeNull();
		recordMemoryHealth(
			agentDir,
			{
				operation: "embedding",
				status: "error",
				updatedAt: "2026-08-24T00:00:00.000Z",
				reason: "Embedding request failed",
			},
			{
				operation: "backfill",
				status: "error",
				updatedAt: "2026-08-24T00:01:00.000Z",
				reason: "Backfill request failed",
			},
			{
				operation: "rerank",
				status: "error",
				updatedAt: "2026-08-24T00:02:00.000Z",
				reason: "Rerank request failed",
			},
		);

		await service.update({
			type: "set_embedding",
			settings: {
				name: "Embedding",
				provider: "Qwen",
				baseUrl: "https://example.test/v1",
				api: "openai-compatible",
				modelId: "embedding-model",
			},
			credential: { action: "set", value: "embedding-secret" },
		});
		expect(getLatestMemoryError(agentDir)).toBe("Rerank request failed");

		await service.update({
			type: "set_rerank",
			settings: {
				name: "Rerank",
				provider: "Cohere",
				endpointUrl: "https://example.test/v2/rerank",
				modelId: "rerank-model",
			},
			credential: { action: "set", value: "rerank-secret" },
		});
		expect(getLatestMemoryError(agentDir)).toBeNull();
	});

	it("tests an unsaved specialized draft without persisting settings or credentials", async () => {
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		const service = new ModelSettingsService({
			agentDir,
			authStorage,
			modelRegistry: ModelRegistry.create(authStorage, join(agentDir, "models.json")),
			settingsManager: SettingsManager.create(agentDir, agentDir),
		});
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			const body = JSON.parse(String(init?.body));
			expect(body.input).toHaveLength(2);
			return new Response(
				JSON.stringify({
					data: [
						{ index: 0, embedding: [1, 0] },
						{ index: 1, embedding: [0, 1] },
					],
				}),
				{ status: 200 },
			);
		});
		vi.stubGlobal("fetch", fetchMock);
		await expect(
			service.testConnection({
				requestId: "11111111-1111-4111-8111-111111111111",
				kind: "embedding",
				settings: {
					name: "Draft",
					provider: "Qwen",
					baseUrl: "https://example.test/v1",
					api: "openai-compatible",
					modelId: "draft-model",
				},
				credential: { action: "set", value: "one-shot" },
			}),
		).resolves.toMatchObject({ ok: true });
		expect(service.view().embedding).toBeNull();
		expect(authStorage.has(MEMORY_EMBEDDING_CREDENTIAL_ID)).toBe(false);
		expect(
			existsSync(join(agentDir, "auth.json")) ? readFileSync(join(agentDir, "auth.json"), "utf8") : "",
		).not.toContain("one-shot");
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
			thinkingLevels: ["off", "low", "high", "max"],
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
