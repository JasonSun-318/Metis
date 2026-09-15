import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClientParams, ClientResult } from "@metis/app-protocol";
import {
	type AuthStorage,
	clearMemoryHealth,
	embedTexts,
	FileAuthStorageBackend,
	getSupportedThinkingLevels,
	MEMORY_EMBEDDING_CREDENTIAL_ID,
	MEMORY_RERANK_CREDENTIAL_ID,
	type ModelRegistry,
	rerankDocuments,
	type SettingsManager,
	validateEmbeddingSettings,
	validateRerankSettings,
	validateServiceCredential,
} from "@metis/coding-agent/host";

interface ModelsConfigDocument {
	providers: Record<string, Record<string, unknown>>;
	[key: string]: unknown;
}

interface ModelSettingsServiceOptions {
	readonly agentDir: string;
	readonly authStorage: AuthStorage;
	readonly modelRegistry: ModelRegistry;
	readonly settingsManager: SettingsManager;
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function clampThinkingSelection(
	model: Parameters<typeof getSupportedThinkingLevels>[0],
	selection: (typeof THINKING_LEVELS)[number],
): (typeof THINKING_LEVELS)[number] {
	const available = getSupportedThinkingLevels(model);
	if (available.includes(selection)) return selection;
	const requested = THINKING_LEVELS.indexOf(selection);
	return (
		THINKING_LEVELS.slice(requested + 1).find((level) => available.includes(level)) ??
		THINKING_LEVELS.slice(0, requested)
			.reverse()
			.find((level) => available.includes(level)) ??
		"off"
	);
}

function stripJsonComments(input: string): string {
	return input
		.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, (match) => (match[0] === '"' ? match : ""))
		.replace(/"(?:\\.|[^"\\])*"|,(\s*[}\]])/g, (match, tail) => tail ?? (match[0] === '"' ? match : ""));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseModelsConfig(source: string | undefined): ModelsConfigDocument {
	if (!source?.trim() || source.trim() === "{}") return { providers: {} };
	const parsed = JSON.parse(stripJsonComments(source)) as unknown;
	if (!isRecord(parsed) || !isRecord(parsed.providers)) throw new Error("models.json must contain a providers object");
	for (const value of Object.values(parsed.providers)) {
		if (!isRecord(value)) throw new Error("Every models.json provider must be an object");
	}
	return structuredClone(parsed) as ModelsConfigDocument;
}

function configuredModelIds(config: ModelsConfigDocument): Map<string, Set<string>> {
	const result = new Map<string, Set<string>>();
	for (const [provider, raw] of Object.entries(config.providers)) {
		const models = Array.isArray(raw.models) ? raw.models : [];
		result.set(
			provider,
			new Set(models.flatMap((model) => (isRecord(model) && typeof model.id === "string" ? [model.id] : []))),
		);
	}
	return result;
}

type SavedReasoningMode = "auto" | "off" | "generic";

function configuredModelReasoningModes(config: ModelsConfigDocument): Map<string, Map<string, SavedReasoningMode>> {
	const result = new Map<string, Map<string, SavedReasoningMode>>();
	for (const [provider, raw] of Object.entries(config.providers)) {
		const models = Array.isArray(raw.models) ? raw.models : [];
		const modes = new Map<string, SavedReasoningMode>();
		for (const model of models) {
			if (!isRecord(model) || typeof model.id !== "string") continue;
			const mode = model.reasoningMode;
			if (mode === "auto" || mode === "off" || mode === "generic") modes.set(model.id, mode);
		}
		result.set(provider, modes);
	}
	return result;
}

function normalizeBaseUrl(value: string | null): string | undefined {
	if (value === null) return undefined;
	const url = new URL(value);
	if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Base URL must use HTTP or HTTPS");
	return url.toString().replace(/\/$/u, "");
}

function publicError(error: unknown, secrets: readonly (string | undefined)[]): string {
	let message = error instanceof Error ? error.message : String(error);
	for (const secret of secrets) {
		if (secret) message = message.split(secret).join("[redacted]");
	}
	return message.replace(/Bearer\s+\S+/giu, "Bearer [redacted]").slice(0, 500) || "Connection failed";
}

/** Owns the small settings-specific mutation surface for models.json, auth.json, and global defaults. */
export class ModelSettingsService {
	private readonly agentDir: string;
	private readonly authStorage: AuthStorage;
	private readonly modelRegistry: ModelRegistry;
	private readonly settingsManager: SettingsManager;
	private readonly modelsPath: string;
	private readonly modelsStorage: FileAuthStorageBackend;

	constructor(options: ModelSettingsServiceOptions) {
		this.agentDir = options.agentDir;
		this.authStorage = options.authStorage;
		this.modelRegistry = options.modelRegistry;
		this.settingsManager = options.settingsManager;
		this.modelsPath = join(options.agentDir, "models.json");
		// FileAuthStorageBackend is a generic locked/atomic text backend despite its historical name.
		this.modelsStorage = new FileAuthStorageBackend(this.modelsPath);
	}

	private readConfig(): ModelsConfigDocument {
		return parseModelsConfig(existsSync(this.modelsPath) ? readFileSync(this.modelsPath, "utf8") : undefined);
	}

	view(): ClientResult<"model/settings/get"> {
		this.modelRegistry.refresh();
		let config: ModelsConfigDocument = { providers: {} };
		let readError: string | undefined;
		try {
			config = this.readConfig();
		} catch (error) {
			readError = error instanceof Error ? error.message : String(error);
		}
		const customIds = configuredModelIds(config);
		const customReasoningModes = configuredModelReasoningModes(config);
		const grouped = new Map<string, ReturnType<ModelRegistry["getAll"]>>();
		for (const model of this.modelRegistry.getAll()) {
			const models = grouped.get(model.provider) ?? [];
			models.push(model);
			grouped.set(model.provider, models);
		}
		const providers: ClientResult<"model/settings/get">["providers"] = [...grouped].map(([provider, models]) => {
			const configuredIds = customIds.get(provider) ?? new Set<string>();
			const raw = config.providers[provider] ?? {};
			const status = this.modelRegistry.getProviderAuthStatus(provider);
			const credential = this.authStorage.get(provider);
			const configured = models.some((model) => this.modelRegistry.hasConfiguredAuth(model));
			const source: "stored" | "environment" | "oauth" | undefined =
				credential?.type === "oauth"
					? "oauth"
					: credential?.type === "api_key" || status.source === "models_json_key"
						? "stored"
						: status.source === "environment"
							? "environment"
							: undefined;
			const api: "openai-responses" | "openai-completions" | "anthropic-messages" | null =
				raw.api === "openai-responses" || raw.api === "openai-completions" || raw.api === "anthropic-messages"
					? raw.api
					: null;
			return {
				provider,
				name: typeof raw.name === "string" ? raw.name : this.modelRegistry.getProviderDisplayName(provider),
				builtin: models.some((model) => !configuredIds.has(model.id)),
				baseUrl: typeof raw.baseUrl === "string" ? raw.baseUrl : null,
				api,
				auth: {
					configured,
					...(source ? { source } : {}),
					...(status.label ? { label: status.label } : {}),
				},
				models: models
					.map((model) => {
						const isCustom = configuredIds.has(model.id);
						return {
							provider,
							modelId: model.id,
							name: model.name,
							contextWindow: Math.max(1, Math.trunc(model.contextWindow)),
							maxOutputTokens: Math.max(1, Math.trunc(model.maxTokens)),
							reasoning: model.reasoning,
							thinkingLevels: getSupportedThinkingLevels(model),
							reasoningMode: isCustom ? (customReasoningModes.get(provider)?.get(model.id) ?? null) : null,
							reasoningSource: isCustom
								? (this.modelRegistry.getCustomModelReasoningSource(provider, model.id) ?? null)
								: null,
							imageInput: model.input.includes("image"),
							custom: isCustom,
						};
					})
					.sort((left, right) => left.name.localeCompare(right.name) || left.modelId.localeCompare(right.modelId)),
			};
		});
		providers.sort(
			(left, right) => left.name.localeCompare(right.name) || left.provider.localeCompare(right.provider),
		);
		const defaultProvider = this.settingsManager.getDefaultProvider();
		const defaultModelId = this.settingsManager.getDefaultModel();
		const defaultModel =
			defaultProvider && defaultModelId ? this.modelRegistry.find(defaultProvider, defaultModelId) : undefined;
		const savedThinkingSelection = this.settingsManager.getDefaultThinkingLevel() ?? "medium";
		const vision = this.settingsManager.getVisionSettings();
		const embedding = this.settingsManager.getEmbeddingSettings();
		const rerank = this.settingsManager.getRerankSettings();
		return {
			defaultModel:
				defaultProvider && defaultModelId ? { provider: defaultProvider, modelId: defaultModelId } : null,
			vision: vision ? { ...vision, authConfigured: this.authStorage.has("vision") } : null,
			embedding: embedding
				? {
						...embedding,
						authConfigured: this.authStorage.get(MEMORY_EMBEDDING_CREDENTIAL_ID)?.type === "api_key",
					}
				: null,
			rerank: rerank
				? { ...rerank, authConfigured: this.authStorage.get(MEMORY_RERANK_CREDENTIAL_ID)?.type === "api_key" }
				: null,
			defaultThinkingSelection: defaultModel
				? clampThinkingSelection(defaultModel, savedThinkingSelection)
				: savedThinkingSelection,
			providers,
			loadError: readError ?? this.modelRegistry.getError() ?? null,
		};
	}

	async update(
		mutation: ClientParams<"model/settings/update">["mutation"],
	): Promise<ClientResult<"model/settings/get">> {
		await this.settingsManager.throwPendingWriteError();
		if (mutation.type === "set_embedding" || mutation.type === "set_rerank") {
			const embedding = mutation.type === "set_embedding";
			const credentialId = embedding ? MEMORY_EMBEDDING_CREDENTIAL_ID : MEMORY_RERANK_CREDENTIAL_ID;
			if (mutation.settings === null) {
				if (mutation.credential.action !== "remove") {
					throw new Error("Removing specialized model settings requires removing its credential");
				}
				if (embedding) this.settingsManager.clearEmbeddingSettings();
				else this.settingsManager.clearRerankSettings();
				await this.settingsManager.flushOrThrow();
				this.authStorage.remove(credentialId);
				this.clearMemoryHealth(embedding ? ["embedding", "backfill"] : ["rerank"]);
				return this.view();
			}
			if (mutation.credential.action === "remove") {
				throw new Error("Credential mutation must be set or keep while retaining specialized model settings");
			}
			const settings = embedding
				? validateEmbeddingSettings(mutation.settings)
				: validateRerankSettings(mutation.settings);
			if (mutation.credential.action === "keep" && this.authStorage.get(credentialId)?.type !== "api_key") {
				throw new Error("A stored dedicated credential is required for keep");
			}
			const previous = this.authStorage.get(credentialId);
			try {
				if (mutation.credential.action === "set") {
					this.authStorage.set(credentialId, {
						type: "api_key",
						key: validateServiceCredential(mutation.credential.value),
					});
				}
				if (embedding) {
					this.settingsManager.setEmbeddingSettings(validateEmbeddingSettings(settings));
				} else this.settingsManager.setRerankSettings(validateRerankSettings(settings));
				await this.settingsManager.flushOrThrow();
			} catch (error) {
				if (mutation.credential.action === "set") this.restoreCredential(credentialId, previous, error);
				throw error;
			}
			this.clearMemoryHealth(embedding ? ["embedding", "backfill"] : ["rerank"]);
			return this.view();
		}
		if (mutation.type === "set_defaults") {
			if (mutation.model) {
				this.modelRegistry.refresh();
				const model = this.modelRegistry.find(mutation.model.provider, mutation.model.modelId);
				if (!model || !this.modelRegistry.hasConfiguredAuth(model))
					throw new Error("The default model is unavailable");
				this.settingsManager.setDefaultModelSettings(
					{ provider: model.provider, modelId: model.id },
					clampThinkingSelection(model, mutation.thinkingSelection),
				);
			} else {
				this.settingsManager.setDefaultModelSettings(null, mutation.thinkingSelection);
			}
			await this.settingsManager.flushOrThrow();
			return this.view();
		}
		if (mutation.type === "set_vision") {
			if (mutation.settings === null) {
				this.settingsManager.clearVisionSettings();
				await this.settingsManager.flushOrThrow();
				this.authStorage.remove("vision");
				return this.view();
			}
			const parsedUrl = new URL(mutation.settings.baseUrl);
			if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
				throw new Error("Base URL must use HTTP or HTTPS");
			}
			const hasStoredKey = this.authStorage.has("vision");
			if (!hasStoredKey && mutation.credential.action !== "set") {
				throw new Error("Enter an API key to save the vision service");
			}
			const previous = this.authStorage.get("vision");
			try {
				if (mutation.credential.action === "set") {
					this.authStorage.set("vision", { type: "api_key", key: mutation.credential.value });
				} else if (mutation.credential.action === "remove") {
					this.authStorage.remove("vision");
				}
				this.settingsManager.setVisionSettings(mutation.settings);
				await this.settingsManager.flushOrThrow();
			} catch (error) {
				this.restoreCredential("vision", previous, error);
				throw error;
			}
			return this.view();
		}
		let previous = '{\n  "providers": {}\n}\n';
		const previousCredential = this.authStorage.get(mutation.provider);
		let credentialTouched = false;
		try {
			this.modelsStorage.withLock((source) => {
				const config = parseModelsConfig(source);
				previous = source?.trim() && source.trim() !== "{}" ? source : `${JSON.stringify(config, null, 2)}\n`;
				if (mutation.type === "remove_provider") {
					delete config.providers[mutation.provider];
				} else {
					const credentialOnly =
						mutation.baseUrl === null && mutation.api === null && mutation.models.length === 0;
					const knownProvider = this.modelRegistry.getAll().some((model) => model.provider === mutation.provider);
					if (credentialOnly && knownProvider) {
						const existing = config.providers[mutation.provider];
						if (isRecord(existing) && Object.keys(existing).every((key) => key === "name")) {
							delete config.providers[mutation.provider];
						}
						return { result: undefined, next: `${JSON.stringify(config, null, 2)}\n` };
					}
					const existing = config.providers[mutation.provider];
					const provider = isRecord(existing) ? structuredClone(existing) : {};
					provider.name = mutation.name;
					const baseUrl = normalizeBaseUrl(mutation.baseUrl);
					if (baseUrl) provider.baseUrl = baseUrl;
					else delete provider.baseUrl;
					if (mutation.api) provider.api = mutation.api;
					else delete provider.api;
					if (mutation.models.length > 0) {
						const previousModels = new Map(
							(Array.isArray(provider.models) ? provider.models : []).flatMap((model) =>
								isRecord(model) && typeof model.id === "string" ? [[model.id, model] as const] : [],
							),
						);
						provider.models = mutation.models.map((model) => {
							const previousModel = previousModels.get(model.modelId);
							const next = previousModel ? structuredClone(previousModel) : {};
							const preserveExplicitReasoning =
								model.reasoningMode === "auto" &&
								previousModel !== undefined &&
								previousModel.reasoningMode === undefined &&
								("reasoning" in previousModel || "thinkingLevelMap" in previousModel);
							next.id = model.modelId;
							next.name = model.name;
							if (preserveExplicitReasoning) {
								delete next.reasoningMode;
							} else {
								next.reasoningMode = model.reasoningMode;
								delete next.reasoning;
								delete next.thinkingLevelMap;
							}
							next.input = model.imageInput ? ["text", "image"] : ["text"];
							next.contextWindow = model.contextWindow;
							next.maxTokens = model.maxOutputTokens;
							return next;
						});
					} else {
						delete provider.models;
					}
					if (mutation.credential.action !== "keep") delete provider.apiKey;
					if (Object.keys(provider).length === 0) delete config.providers[mutation.provider];
					else config.providers[mutation.provider] = provider;
				}
				return { result: undefined, next: `${JSON.stringify(config, null, 2)}\n` };
			});
			this.modelRegistry.refresh();
			const configError = this.modelRegistry.getError();
			if (configError) throw new Error(configError);
			if (mutation.type === "remove_provider") {
				credentialTouched = true;
				this.authStorage.remove(mutation.provider);
				if (this.settingsManager.getDefaultProvider() === mutation.provider) {
					this.settingsManager.clearDefaultModelAndProvider();
					await this.settingsManager.flushOrThrow();
				}
			} else if (mutation.credential.action === "set") {
				credentialTouched = true;
				this.authStorage.set(mutation.provider, { type: "api_key", key: mutation.credential.value });
			} else if (mutation.credential.action === "remove") {
				credentialTouched = true;
				this.authStorage.remove(mutation.provider);
			}
			this.modelRegistry.refresh();
			const defaultProvider = this.settingsManager.getDefaultProvider();
			const defaultModelId = this.settingsManager.getDefaultModel();
			if (defaultProvider && defaultModelId) {
				const defaultModel = this.modelRegistry.find(defaultProvider, defaultModelId);
				if (!defaultModel || !this.modelRegistry.hasConfiguredAuth(defaultModel)) {
					this.settingsManager.clearDefaultModelAndProvider();
					await this.settingsManager.flushOrThrow();
				}
			}
			return this.view();
		} catch (error) {
			this.modelsStorage.withLock(() => ({ result: undefined, next: previous }));
			if (credentialTouched) this.restoreCredential(mutation.provider, previousCredential, error);
			this.modelRegistry.refresh();
			throw error;
		}
	}

	async testConnection(params: ClientParams<"model/testConnection">): Promise<ClientResult<"model/testConnection">> {
		if (params.kind === "embedding" || params.kind === "rerank") {
			const embedding = params.kind === "embedding";
			const credentialId = embedding ? MEMORY_EMBEDDING_CREDENTIAL_ID : MEMORY_RERANK_CREDENTIAL_ID;
			const startedAt = Date.now();
			let apiKey: string | undefined;
			try {
				apiKey =
					params.credential.action === "set"
						? validateServiceCredential(params.credential.value)
						: await this.authStorage.getApiKey(credentialId, { includeFallback: false });
				if (!apiKey) throw new Error("A stored dedicated credential is required for keep");
				if (embedding) {
					await embedTexts(["Metis connection test A", "Metis connection test B"], {
						settings: validateEmbeddingSettings(params.settings),
						apiKey,
					});
				} else {
					await rerankDocuments({
						settings: validateRerankSettings(params.settings),
						apiKey,
						query: "Metis connection test",
						documents: [
							{ id: "a", text: "Metis connection test A" },
							{ id: "b", text: "Metis connection test B" },
						],
					});
				}
				return { ok: true, message: "Connection succeeded", latencyMs: Date.now() - startedAt };
			} catch (error) {
				return { ok: false, message: publicError(error, [apiKey]), latencyMs: Date.now() - startedAt };
			}
		}
		this.modelRegistry.refresh();
		const model = this.modelRegistry.find(params.provider, params.modelId);
		if (!model) return { ok: false, message: "Model not found", latencyMs: 0 };
		const startedAt = Date.now();
		let apiKey: string | undefined;
		try {
			const auth = await this.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(auth.error);
			apiKey = auth.apiKey;
			await this.modelRegistry
				.streamSimple(
					model,
					{ messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }] },
					{
						apiKey: auth.apiKey,
						env: auth.env,
						headers: auth.headers,
						maxTokens: 8,
						maxRetries: 0,
						timeoutMs: 15_000,
						signal: AbortSignal.timeout(15_000),
					},
				)
				.result();
			return { ok: true, message: "Connection succeeded", latencyMs: Date.now() - startedAt };
		} catch (error) {
			return {
				ok: false,
				message: publicError(error, [apiKey]),
				latencyMs: Date.now() - startedAt,
			};
		}
	}

	private restoreCredential(id: string, previous: ReturnType<AuthStorage["get"]>, original: unknown): void {
		try {
			if (previous) this.authStorage.set(id, previous);
			else this.authStorage.remove(id);
		} catch (recoveryError) {
			if (original instanceof Error) (original as Error & { cause?: unknown }).cause ??= recoveryError;
		}
	}

	private clearMemoryHealth(operations: Array<"embedding" | "rerank" | "backfill">): void {
		try {
			clearMemoryHealth(this.agentDir, ...operations);
		} catch {
			// Health is derived state; settings and credentials are already durable.
		}
	}
}
