import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import type { ClientParams, ClientResult } from "@metis/app-protocol";
import {
	AgentModelReviewTransport,
	type AuthStorage,
	DEDICATED_REVIEWER_AUTH_KEY,
	FileAuthStorageBackend,
	getSupportedThinkingLevels,
	hasConfiguredManualThinkingLevel,
	isDedicatedReviewerConfig,
	ModelPermissionReviewer,
	type ModelRegistry,
	normalizeManualThinkingLevelMap,
	normalizePermissionAction,
	normalizePermissionReviewerConfig,
	type PermissionReviewerConfig,
	type ReviewerRequestAuth,
	resolveReviewerAuthentication,
	resolveReviewerModel,
	type SettingsManager,
} from "@metis/coding-agent/host";
import { discoverModels } from "./model-discovery.ts";
import { AppServerError } from "./session-runtime-host.ts";

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
type RegisteredModel = NonNullable<ReturnType<ModelRegistry["find"]>>;
type ModelSettingsMutation = ClientParams<"model/settings/update">["mutation"];
type ReviewerCredentialMutation = Extract<ModelSettingsMutation, { type: "set_permission_reviewer" }>["credential"];

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

type SavedReasoningMode = "auto" | "off" | "generic" | "manual";

function configuredModelReasoningModes(config: ModelsConfigDocument): Map<string, Map<string, SavedReasoningMode>> {
	const result = new Map<string, Map<string, SavedReasoningMode>>();
	for (const [provider, raw] of Object.entries(config.providers)) {
		const models = Array.isArray(raw.models) ? raw.models : [];
		const modes = new Map<string, SavedReasoningMode>();
		for (const model of models) {
			if (!isRecord(model) || typeof model.id !== "string") continue;
			const mode = model.reasoningMode;
			if (mode === "auto" || mode === "off" || mode === "generic" || mode === "manual") modes.set(model.id, mode);
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

function publicThinkingLevelMap(
	map: Parameters<typeof normalizeManualThinkingLevelMap>[0],
): Partial<Record<(typeof THINKING_LEVELS)[number], string | null>> | undefined {
	if (!map) return undefined;
	const result: Partial<Record<(typeof THINKING_LEVELS)[number], string | null>> = {};
	let hasValue = false;
	for (const level of THINKING_LEVELS) {
		const value = map[level];
		if (typeof value === "string" && value.trim().length > 0) {
			result[level] = value;
			hasValue = true;
		} else if (value === null) {
			result[level] = null;
			hasValue = true;
		}
	}
	return hasValue ? result : undefined;
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
						const thinkingLevelMap = isCustom ? publicThinkingLevelMap(model.thinkingLevelMap) : undefined;
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
							...(thinkingLevelMap ? { thinkingLevelMap } : {}),
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
		const reviewer = this.settingsManager.getPermissionReviewerView();
		const reviewerConfig = reviewer.config;
		const reviewerResolution = reviewerConfig
			? resolveReviewerModel(reviewerConfig, {
					find: (provider, modelId) => this.modelRegistry.find(provider, modelId),
				})
			: undefined;
		const reviewerStatus = reviewerConfig && !reviewerResolution?.ok ? "invalid" : reviewer.status;

		return {
			defaultModel:
				defaultProvider && defaultModelId ? { provider: defaultProvider, modelId: defaultModelId } : null,
			vision: vision ? { ...vision, authConfigured: this.authStorage.has("vision") } : null,
			permissionReviewer: {
				config: reviewerConfig ?? null,
				status: reviewerStatus,
				// Credential presence is view metadata, never part of the saved profile.
				...(reviewerConfig && isDedicatedReviewerConfig(reviewerConfig)
					? { authConfigured: this.authStorage.has(DEDICATED_REVIEWER_AUTH_KEY) }
					: {}),
			},
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
		if (mutation.type === "set_defaults") {
			if (mutation.model) {
				this.modelRegistry.refresh();
				const model = this.modelRegistry.find(mutation.model.provider, mutation.model.modelId);
				if (!model || !this.modelRegistry.hasConfiguredAuth(model))
					throw new Error("The default model is unavailable");
				if (
					this.modelRegistry.getCustomModelReasoningSource(model.provider, model.id) === "manual" &&
					!getSupportedThinkingLevels(model).includes(mutation.thinkingSelection)
				) {
					throw new Error(`Thinking level "${mutation.thinkingSelection}" is not configured for this model`);
				}
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
		if (mutation.type === "set_permission_reviewer") {
			return await this.setPermissionReviewer(mutation.config, mutation.credential);
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
							if (model.reasoningMode === "manual") {
								const source =
									model.thinkingLevelMap ??
									(isRecord(previousModel) && isRecord(previousModel.thinkingLevelMap)
										? previousModel.thinkingLevelMap
										: undefined);
								const normalized = normalizeManualThinkingLevelMap(
									source as Parameters<typeof normalizeManualThinkingLevelMap>[0],
								);
								if (!hasConfiguredManualThinkingLevel(normalized)) {
									throw new Error(`Model "${model.modelId}" needs at least one manual thinking level value`);
								}
								next.reasoningMode = "manual";
								next.thinkingLevelMap = normalized;
								delete next.reasoning;
							} else if (preserveExplicitReasoning) {
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

	async discover(params: ClientParams<"model/discover">): Promise<ClientResult<"model/discover">> {
		let apiKey = params.apiKey;
		if (apiKey === undefined && params.provider) {
			const credential = this.authStorage.get(params.provider);
			if (credential?.type === "api_key") {
				apiKey = credential.key;
			} else if (!credential) {
				// models.json provider keys are read through the registry; OAuth tokens are
				// deliberately not refreshed by a read-only discovery call.
				apiKey = await this.modelRegistry.getApiKeyForProvider(params.provider);
			}
		}
		return discoverModels(params, { apiKey });
	}

	async testConnection(params: ClientParams<"model/testConnection">): Promise<ClientResult<"model/testConnection">> {
		this.modelRegistry.refresh();
		if (params.kind === "permission-review") return this.testPermissionReviewer();
		const model = this.modelRegistry.find(params.provider, params.modelId);
		if (!model) return { ok: false, message: "Model not found", latencyMs: 0 };
		const level = getSupportedThinkingLevels(model)[0];
		const reasoning = level && level !== "off" ? level : undefined;
		const startedAt = Date.now();
		let apiKey: string | undefined;
		try {
			const auth = await this.modelRegistry.getApiKeyAndHeaders(model);
			if (!auth.ok) throw new Error(auth.error);
			apiKey = auth.apiKey;
			const message = await this.modelRegistry
				.streamSimple(
					model,
					{ messages: [{ role: "user", content: "Reply with OK.", timestamp: Date.now() }] },
					{
						apiKey: auth.apiKey,
						env: auth.env,
						headers: auth.headers,
						maxTokens: 8,
						maxRetries: 0,
						...(reasoning ? { reasoning } : {}),
						timeoutMs: 15_000,
						signal: AbortSignal.timeout(15_000),
					},
				)
				.result();
			if (message.stopReason === "error" || message.stopReason === "aborted" || message.errorMessage) {
				const failure =
					message.errorMessage?.trim() ||
					(message.stopReason === "aborted" ? "Request aborted" : "Connection failed");
				return { ok: false, message: publicError(failure, [apiKey]), latencyMs: Date.now() - startedAt };
			}
			return { ok: true, message: "Connection succeeded", latencyMs: Date.now() - startedAt };
		} catch (error) {
			return {
				ok: false,
				message: publicError(error, [apiKey]),
				latencyMs: Date.now() - startedAt,
			};
		}
	}

	/** Exercise the production approval contract with fixed samples, without executing either command. */
	private async testPermissionReviewer(): Promise<ClientResult<"model/testConnection">> {
		const config = this.settingsManager.getPermissionReviewerConfig();
		if (!config) return { ok: false, message: "Configure a valid permission reviewer first", latencyMs: 0 };
		const resolution = resolveReviewerModel(config, {
			find: (provider, modelId) => this.modelRegistry.find(provider, modelId),
		});
		if (!resolution.ok) return { ok: false, message: resolution.error, latencyMs: 0 };
		const startedAt = Date.now();
		// Both samples use one connection snapshot. Resolve auth inside the first
		// review's deadline and reuse that promise without reading credentials again.
		let authentication: Promise<ReviewerRequestAuth> | undefined;
		const reviewer = new ModelPermissionReviewer({
			getConfiguration: () => config,
			resolveModel: () => resolution.model,
			resolveAuthentication: () => {
				authentication ??= this.permissionReviewerRequestAuth(config, resolution.model);
				return authentication;
			},
			transport: new AgentModelReviewTransport((model, context, options) =>
				this.modelRegistry.streamSimple(model, context, options),
			),
		});
		// These are normalized evidence fixtures. No shell, tool execution callback,
		// grant store, or user-controlled test command is involved.
		const cwd = join(tmpdir(), "metis-reviewer-contract-test");
		const samples = [
			{ command: "pwd", expected: "allow", effects: [], readPaths: [cwd], writePaths: [] },
			{
				command: "rm -rf /",
				expected: "deny",
				effects: ["destructive"],
				readPaths: [],
				writePaths: [parse(cwd).root],
			},
		] as const;
		try {
			for (const sample of samples) {
				const action = normalizePermissionAction({
					actionId: `reviewer-test-${sample.expected}`,
					toolName: "bash",
					provenance: "builtin",
					toolIdentity: "builtin:bash:v1",
					args: { command: sample.command },
					command: sample.command,
					cwd,
					workspaceRoots: [cwd],
					readPaths: sample.readPaths,
					writePaths: sample.writePaths,
					networkEndpoints: [],
					effects: sample.effects,
				});
				const result = await reviewer.review({
					action,
					decision: {
						kind: "review",
						minimumReviewer: "model",
						riskLevel: sample.expected === "allow" ? "low" : "high",
						reason: "Connection test; no command will be executed",
						grant: {
							executionTarget: "sandbox",
							readRoots: action.readPaths,
							writeRoots: action.writePaths,
							protectedRoots: [],
							networkEndpoints: [],
						},
					},
					trustedUserMessages: [
						{ messageId: "reviewer-test", text: "Assess the proposed tool request. Do not execute it." },
					],
					redactedArguments: { command: sample.command },
					interactive: false,
					signal: new AbortController().signal,
				});
				if (result.kind !== sample.expected) {
					return {
						ok: false,
						message: `Permission reviewer contract test failed (${sample.expected} sample: ${result.kind})`,
						latencyMs: Math.max(0, Date.now() - startedAt),
						thinkingLevel: config.thinkingLevel,
					};
				}
			}
			return {
				ok: true,
				message: "Permission reviewer allowed the read sample and denied the destructive sample",
				latencyMs: Math.max(0, Date.now() - startedAt),
				thinkingLevel: config.thinkingLevel,
			};
		} catch {
			return {
				ok: false,
				message: "Permission reviewer contract test is unavailable",
				latencyMs: Math.max(0, Date.now() - startedAt),
				thinkingLevel: config.thinkingLevel,
			};
		}
	}

	/**
	 * Dedicated connections read only their isolated AuthStorage key; shared
	 * provider profiles keep using that provider's own auth configuration. The
	 * saved profile source decides, not the synthesized model provider.
	 */
	private permissionReviewerRequestAuth(
		config: PermissionReviewerConfig,
		model: RegisteredModel,
	): Promise<ReviewerRequestAuth> {
		return resolveReviewerAuthentication(config, model, {
			authStorage: this.authStorage,
			getSharedAuth: async (sharedModel) => {
				const result = await this.modelRegistry.getApiKeyAndHeaders(sharedModel);
				if (!result.ok) throw new Error("Permission reviewer authentication is unavailable");
				return result;
			},
		});
	}

	private async setPermissionReviewer(
		config: unknown,
		credential: ReviewerCredentialMutation,
	): Promise<ClientResult<"model/settings/get">> {
		const normalized: PermissionReviewerConfig | null =
			config === null ? null : (normalizePermissionReviewerConfig(config) ?? null);
		if (config !== null && normalized === null) throw new Error("A permission reviewer config or null is required");
		if (normalized) {
			this.modelRegistry.refresh();
			const resolution = resolveReviewerModel(normalized, this.modelRegistry);
			if (!resolution.ok) throw new Error(resolution.error);
		}
		const dedicated = normalized !== null && isDedicatedReviewerConfig(normalized);
		const action = credential?.action ?? "keep";
		// Shared providers keep their own credentials; only a dedicated connection
		// may create or replace the isolated reviewer key.
		if (action === "set" && !dedicated) {
			throw new Error("Reviewer credentials are only supported for dedicated connections");
		}
		if (dedicated && action === "remove") {
			throw new Error("A dedicated approval model requires an API key");
		}
		if (dedicated && action === "keep" && !this.authStorage.has(DEDICATED_REVIEWER_AUTH_KEY)) {
			throw new Error("Enter an API key to save the dedicated approval model");
		}
		const previousCredential = this.authStorage.get(DEDICATED_REVIEWER_AUTH_KEY);
		let credentialTouched = false;
		try {
			if (credential?.action === "set") {
				credentialTouched = true;
				this.authStorage.set(DEDICATED_REVIEWER_AUTH_KEY, { type: "api_key", key: credential.value });
			} else if (credential?.action === "remove") {
				credentialTouched = true;
				this.authStorage.remove(DEDICATED_REVIEWER_AUTH_KEY);
			}
			// Snapshot the raw stored value so a legacy invalid object survives a
			// failed save verbatim; the normalized getter would report it undefined
			// and the rollback would wipe the previous on-disk data.
			const rollback = this.settingsManager.beginPermissionReviewerConfigUpdate(normalized);
			try {
				await this.settingsManager.flushOrThrow();
			} catch {
				try {
					rollback();
					await this.settingsManager.flushOrThrow();
				} catch {
					// The original failure is authoritative; the settings writer remains fail-closed in memory.
				}
				throw new AppServerError("OPERATION_FAILED");
			}
		} catch (error) {
			if (credentialTouched) this.restoreCredential(DEDICATED_REVIEWER_AUTH_KEY, previousCredential, error);
			throw error;
		}
		return this.view();
	}

	private restoreCredential(id: string, previous: ReturnType<AuthStorage["get"]>, original: unknown): void {
		try {
			if (previous) this.authStorage.set(id, previous);
			else this.authStorage.remove(id);
		} catch (recoveryError) {
			if (original instanceof Error) (original as Error & { cause?: unknown }).cause ??= recoveryError;
		}
	}
}
