import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ClientParams, ClientResult } from "@metis/app-protocol";
import {
	type AuthStorage,
	FileAuthStorageBackend,
	type ModelRegistry,
	type SettingsManager,
} from "@metis/coding-agent";

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
	private readonly authStorage: AuthStorage;
	private readonly modelRegistry: ModelRegistry;
	private readonly settingsManager: SettingsManager;
	private readonly modelsPath: string;
	private readonly modelsStorage: FileAuthStorageBackend;

	constructor(options: ModelSettingsServiceOptions) {
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
			const api: "openai-responses" | "openai-completions" | null =
				raw.api === "openai-responses" || raw.api === "openai-completions" ? raw.api : null;
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
					.map((model) => ({
						provider,
						modelId: model.id,
						name: model.name,
						contextWindow: Math.max(1, Math.trunc(model.contextWindow)),
						maxOutputTokens: Math.max(1, Math.trunc(model.maxTokens)),
						reasoning: model.reasoning,
						imageInput: model.input.includes("image"),
						custom: configuredIds.has(model.id),
					}))
					.sort((left, right) => left.name.localeCompare(right.name) || left.modelId.localeCompare(right.modelId)),
			};
		});
		providers.sort(
			(left, right) => left.name.localeCompare(right.name) || left.provider.localeCompare(right.provider),
		);
		const defaultProvider = this.settingsManager.getDefaultProvider();
		const defaultModelId = this.settingsManager.getDefaultModel();
		return {
			defaultModel:
				defaultProvider && defaultModelId ? { provider: defaultProvider, modelId: defaultModelId } : null,
			defaultThinkingSelection: this.settingsManager.getDefaultThinkingLevel() ?? "medium",
			providers,
			loadError: readError ?? this.modelRegistry.getError() ?? null,
		};
	}

	async update(
		mutation: ClientParams<"model/settings/update">["mutation"],
	): Promise<ClientResult<"model/settings/get">> {
		if (mutation.type === "set_defaults") {
			if (mutation.model) {
				this.modelRegistry.refresh();
				const model = this.modelRegistry.find(mutation.model.provider, mutation.model.modelId);
				if (!model || !this.modelRegistry.hasConfiguredAuth(model))
					throw new Error("The default model is unavailable");
				this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
			} else {
				this.settingsManager.clearDefaultModelAndProvider();
			}
			this.settingsManager.setDefaultThinkingLevel(mutation.thinkingSelection);
			await this.settingsManager.flush();
			return this.view();
		}

		let previous = '{\n  "providers": {}\n}\n';
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
						provider.models = mutation.models.map((model) => ({
							id: model.modelId,
							name: model.name,
							reasoning: model.reasoning,
							input: model.imageInput ? ["text", "image"] : ["text"],
							contextWindow: model.contextWindow,
							maxTokens: model.maxOutputTokens,
						}));
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
				this.authStorage.remove(mutation.provider);
				if (this.settingsManager.getDefaultProvider() === mutation.provider) {
					this.settingsManager.clearDefaultModelAndProvider();
					await this.settingsManager.flush();
				}
			} else if (mutation.credential.action === "set") {
				this.authStorage.set(mutation.provider, { type: "api_key", key: mutation.credential.value });
			} else if (mutation.credential.action === "remove") {
				this.authStorage.remove(mutation.provider);
			}
			this.modelRegistry.refresh();
			const defaultProvider = this.settingsManager.getDefaultProvider();
			const defaultModelId = this.settingsManager.getDefaultModel();
			if (defaultProvider && defaultModelId) {
				const defaultModel = this.modelRegistry.find(defaultProvider, defaultModelId);
				if (!defaultModel || !this.modelRegistry.hasConfiguredAuth(defaultModel)) {
					this.settingsManager.clearDefaultModelAndProvider();
					await this.settingsManager.flush();
				}
			}
			return this.view();
		} catch (error) {
			this.modelsStorage.withLock(() => ({ result: undefined, next: previous }));
			this.modelRegistry.refresh();
			throw error;
		}
	}

	async testConnection(provider: string, modelId: string): Promise<ClientResult<"model/testConnection">> {
		this.modelRegistry.refresh();
		const model = this.modelRegistry.find(provider, modelId);
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
}
