import type { Transport } from "@metis/ai";
import { randomUUID } from "crypto";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import lockfile from "proper-lockfile";
import { isDeepStrictEqual } from "util";
import { getAgentDir, getMetisEnv, getProjectConfigDir } from "../config.ts";
import { normalizePath, resolvePath } from "../utils/paths.ts";
import { replaceFileAtomicallySync } from "./durable-file.ts";
import { DEFAULT_HTTP_IDLE_TIMEOUT_MS, parseHttpIdleTimeoutMs } from "./http-dispatcher.ts";
import {
	type EmbeddingSettings,
	type RerankSettings,
	validateEmbeddingSettings,
	validateRerankSettings,
} from "./memory/memory-service-settings.ts";
import type { ThinkingSelection } from "./thinking-selection.ts";
import { isWebSearchProvider, type WebSearchProvider } from "./web-search-config.ts";

export interface CompactionSettings {
	enabled?: boolean; // default: true
	reserveTokens?: number; // default: 16384
	keepRecentTokens?: number; // default: 20000
}

export interface BranchSummarySettings {
	reserveTokens?: number; // default: 16384 (tokens reserved for prompt + LLM response)
	skipPrompt?: boolean; // default: false - when true, skips "Summarize branch?" prompt and defaults to no summary
}

export interface ProviderRetrySettings {
	timeoutMs?: number; // SDK/provider request timeout in milliseconds
	maxRetries?: number; // SDK/provider retry attempts
	maxRetryDelayMs?: number; // default: 60000 (max server-requested delay before failing)
}

export interface RetrySettings {
	enabled?: boolean; // default: true
	maxRetries?: number; // default: 3
	baseDelayMs?: number; // default: 2000 (exponential backoff: 2s, 4s, 8s)
	provider?: ProviderRetrySettings;
}

export interface TerminalSettings {
	clearOnShrink?: boolean; // default: false (clear empty rows when content shrinks)
	showTerminalProgress?: boolean; // default: false (OSC 9;4 terminal progress indicators)
}

export interface ThinkingBudgetsSettings {
	minimal?: number;
	low?: number;
	medium?: number;
	high?: number;
}

export interface MarkdownSettings {
	codeBlockIndent?: string; // default: "  "
}

export interface WebSearchSettings {
	enabled?: boolean;
	provider?: WebSearchProvider;
}

/** Chat API protocol the configured vision-describer service speaks. */
export type VisionApi = "openai-responses" | "openai-completions" | "anthropic-messages";

/** AuthStorage provider id under which the vision-describer API key is stored. */
export const VISION_PROVIDER_ID = "vision";

/** User-configured vision-describer service (single). API key lives in AuthStorage under VISION_PROVIDER_ID. */
export interface VisionSettings {
	/** Display name shown in settings. */
	name: string;
	baseUrl: string;
	api: VisionApi;
	modelId: string;
}

export type DefaultProjectTrust = "ask" | "always" | "never";

export type TransportSetting = Transport;

export interface McpCommonServerSettings {
	description?: string;
	enabled?: boolean;
	required?: boolean;
	startupTimeoutSec?: number;
	toolTimeoutSec?: number;
	enabledTools?: string[];
	disabledTools?: string[];
	/** Internal, non-secret pointer to the active versioned credential. */
	credentialVersion?: string;
}

export interface McpStdioServerSettings extends McpCommonServerSettings {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	envVars?: string[];
	cwd?: string;
	url?: never;
}

export interface McpHttpServerSettings extends McpCommonServerSettings {
	url: string;
	bearerTokenEnvVar?: string;
	envHttpHeaders?: Record<string, string>;
	command?: never;
}

export type McpServerSettings = McpStdioServerSettings | McpHttpServerSettings;

/**
 * Package source for npm/git packages.
 * - String form: load all resources from the package
 * - Object form: filter which resources to load
 * - autoload=false: start empty and only apply explicit resource patterns
 */
export type PackageSource =
	| string
	| {
			source: string;
			autoload?: boolean;
			extensions?: string[];
			skills?: string[];
			prompts?: string[];
			themes?: string[];
	  };

export interface Settings {
	defaultProvider?: string;
	defaultModel?: string;
	/** @deprecated Replaced by `vision`; kept so old settings.json can be cleared on save. */
	visionProvider?: string;
	/** @deprecated Replaced by `vision`; kept so old settings.json can be cleared on save. */
	visionModel?: string;
	/** User-configured vision-describer service for the describe_image tool. */
	vision?: VisionSettings;
	defaultThinkingLevel?: ThinkingSelection;
	transport?: TransportSetting; // default: "auto"
	steeringMode?: "all" | "one-at-a-time";
	followUpMode?: "all" | "one-at-a-time";
	theme?: string;
	compaction?: CompactionSettings;
	branchSummary?: BranchSummarySettings;
	retry?: RetrySettings;
	hideThinkingBlock?: boolean;
	showCacheMissNotices?: boolean; // default: false - show transcript notices for significant prompt-cache misses
	externalEditor?: string; // Command for Ctrl+G external editor; takes precedence over VISUAL/EDITOR
	shellPath?: string; // Custom shell path (e.g., for Cygwin users on Windows); supports leading ~ expansion
	quietStartup?: boolean;
	defaultProjectTrust?: DefaultProjectTrust; // default: "ask"; global setting only
	shellCommandPrefix?: string; // Prefix prepended to every bash command (e.g., "shopt -s expand_aliases" for alias support)
	npmCommand?: string[]; // Command used for npm package lookup/install operations, argv-style (e.g., ["mise", "exec", "node@20", "--", "npm"])
	enableProviderAttribution?: boolean; // default: false
	enableAnalytics?: boolean; // default: false - opt-in analytics data sharing
	trackingId?: string; // analytics tracking identifier, generated when analytics is enabled
	packages?: PackageSource[]; // Array of npm/git package sources (string or object with filtering)
	extensions?: string[]; // Array of local extension file paths or directories
	skills?: string[]; // Array of local skill file paths or directories
	prompts?: string[]; // Array of local prompt template paths or directories
	themes?: string[]; // Array of local theme file paths or directories
	enableSkillCommands?: boolean; // default: true - register skills as /skill:name commands
	autoMemoryEnabled?: boolean; // default: true; global setting only
	memoryEngine?: "index" | "extract"; // default: "index"; global setting only
	embedding?: EmbeddingSettings;
	rerank?: RerankSettings;
	memoryMigrationNotice?: string;
	/** @deprecated Removed by one-time memory settings migration. */
	memoryEmbeddingModel?: string; // global setting only; required before enabling extract engine
	/** @deprecated Removed by one-time memory settings migration. */
	memoryRerankModel?: string; // global setting only
	terminal?: TerminalSettings;
	enabledModels?: string[]; // Model patterns for cycling (same format as --models CLI flag)
	doubleEscapeAction?: "fork" | "tree" | "none"; // Action for double-escape with empty editor (default: "tree")
	treeFilterMode?: "default" | "no-tools" | "user-only" | "labeled-only" | "all"; // Default filter when opening /tree
	thinkingBudgets?: ThinkingBudgetsSettings; // Custom token budgets for thinking levels
	editorPaddingX?: number; // Horizontal padding for input editor (default: 0)
	outputPad?: 0 | 1; // Horizontal padding for chat message output (default: 1)
	autocompleteMaxVisible?: number; // Max visible items in autocomplete dropdown (default: 5)
	showHardwareCursor?: boolean; // Show terminal cursor while still positioning it for IME
	markdown?: MarkdownSettings;
	sessionDir?: string; // Custom session storage directory (same format as --session-dir CLI flag)
	httpProxy?: string; // Proxy URL applied as HTTP_PROXY and HTTPS_PROXY for Metis-managed HTTP clients
	httpIdleTimeoutMs?: number; // HTTP header/body idle timeout in milliseconds; 0 disables it
	websocketConnectTimeoutMs?: number; // WebSocket connect/open handshake timeout in milliseconds; 0 disables it
	mcpServers?: Record<string, McpServerSettings>;
	webSearch?: WebSearchSettings; // global-only opt-in external search
}

/** Deep merge settings: project/overrides take precedence, nested objects merge recursively */
function deepMergeSettings(base: Settings, overrides: Settings): Settings {
	const result: Settings = { ...base };

	for (const key of Object.keys(overrides) as (keyof Settings)[]) {
		const overrideValue = overrides[key];
		const baseValue = base[key];

		if (overrideValue === undefined) {
			continue;
		}

		// For nested objects, merge recursively
		if (
			typeof overrideValue === "object" &&
			overrideValue !== null &&
			!Array.isArray(overrideValue) &&
			typeof baseValue === "object" &&
			baseValue !== null &&
			!Array.isArray(baseValue)
		) {
			(result as Record<string, unknown>)[key] = { ...baseValue, ...overrideValue };
		} else {
			// For primitives and arrays, override value wins
			(result as Record<string, unknown>)[key] = overrideValue;
		}
	}

	return result;
}

function parseTimeoutSetting(value: unknown, settingName: string): number | undefined {
	const timeoutMs = parseHttpIdleTimeoutMs(value);
	if (timeoutMs !== undefined) {
		return timeoutMs;
	}
	if (value !== undefined) {
		throw new Error(`Invalid ${settingName} setting: ${String(value)}`);
	}
	return undefined;
}

export type SettingsScope = "global" | "project";

export interface SettingsManagerCreateOptions {
	projectTrusted?: boolean;
}

export interface SettingsStorage {
	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
	/** Lock before reading, including when the settings file does not exist yet. */
	withWriteLock?(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void;
}

export interface SettingsError {
	scope: SettingsScope;
	error: Error;
}

function replaceSettingsFileUnderLock(path: string, next: string): void {
	try {
		replaceFileAtomicallySync(path, next);
	} catch (error) {
		try {
			if (existsSync(path) && readFileSync(path, "utf-8") === next) return;
		} catch (reconciliationError) {
			throw new AggregateError(
				[error, reconciliationError],
				"Settings write failed and its published state could not be reconciled",
			);
		}
		throw error;
	}
}

export class FileSettingsStorage implements SettingsStorage {
	private globalSettingsPath: string;
	private projectSettingsPath: string;

	constructor(cwd: string, agentDir: string) {
		const resolvedCwd = resolvePath(cwd);
		const resolvedAgentDir = resolvePath(agentDir);
		this.globalSettingsPath = join(resolvedAgentDir, "settings.json");
		this.projectSettingsPath = join(getProjectConfigDir(resolvedCwd), "settings.json");
	}

	private acquireLockSyncWithRetry(path: string): () => void {
		const maxAttempts = 10;
		const delayMs = 20;
		let lastError: unknown;

		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return lockfile.lockSync(path, { realpath: false });
			} catch (error) {
				const code =
					typeof error === "object" && error !== null && "code" in error
						? String((error as { code?: unknown }).code)
						: undefined;
				if (code !== "ELOCKED" || attempt === maxAttempts) {
					throw error;
				}
				lastError = error;
				const start = Date.now();
				while (Date.now() - start < delayMs) {
					// Sleep synchronously to avoid changing callers to async.
				}
			}
		}

		throw (lastError as Error) ?? new Error("Failed to acquire settings lock");
	}

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const dir = dirname(path);

		let release: (() => void) | undefined;
		try {
			// Only create directory and lock if file exists or we need to write
			const fileExists = existsSync(path);
			if (fileExists) {
				release = this.acquireLockSyncWithRetry(path);
			}
			const current = fileExists ? readFileSync(path, "utf-8") : undefined;
			const next = fn(current);
			if (next !== undefined) {
				// Only create directory when we actually need to write
				if (!existsSync(dir)) {
					mkdirSync(dir, { recursive: true });
				}
				if (!release) {
					release = this.acquireLockSyncWithRetry(path);
				}
				replaceSettingsFileUnderLock(path, next);
			}
		} finally {
			if (release) {
				release();
			}
		}
	}

	withWriteLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const path = scope === "global" ? this.globalSettingsPath : this.projectSettingsPath;
		const dir = dirname(path);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

		const release = this.acquireLockSyncWithRetry(path);
		try {
			const current = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
			const next = fn(current);
			if (next !== undefined) replaceSettingsFileUnderLock(path, next);
		} finally {
			release();
		}
	}
}

export class InMemorySettingsStorage implements SettingsStorage {
	private global: string | undefined;
	private project: string | undefined;

	withLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		const current = scope === "global" ? this.global : this.project;
		const next = fn(current);
		if (next !== undefined) {
			if (scope === "global") {
				this.global = next;
			} else {
				this.project = next;
			}
		}
	}

	withWriteLock(scope: SettingsScope, fn: (current: string | undefined) => string | undefined): void {
		this.withLock(scope, fn);
	}
}

export class SettingsManager {
	private storage: SettingsStorage;
	private globalSettings: Settings;
	private projectSettings: Settings;
	private settings: Settings;
	private projectTrusted: boolean;
	private modifiedFields = new Set<keyof Settings>(); // Track global fields modified during session
	private modifiedNestedFields = new Map<keyof Settings, Set<string>>(); // Track global nested field modifications
	private modifiedProjectFields = new Set<keyof Settings>(); // Track project fields modified during session
	private modifiedProjectNestedFields = new Map<keyof Settings, Set<string>>(); // Track project nested field modifications
	private globalSettingsLoadError: Error | null = null; // Track if global settings file had parse errors
	private projectSettingsLoadError: Error | null = null; // Track if project settings file had parse errors
	private writeQueue: Promise<void> = Promise.resolve();
	private errors: SettingsError[];

	private constructor(
		storage: SettingsStorage,
		initialGlobal: Settings,
		initialProject: Settings,
		globalLoadError: Error | null = null,
		projectLoadError: Error | null = null,
		initialErrors: SettingsError[] = [],
		projectTrusted = true,
	) {
		this.storage = storage;
		this.globalSettings = initialGlobal;
		this.projectSettings = initialProject;
		this.projectTrusted = projectTrusted;
		this.globalSettingsLoadError = globalLoadError;
		this.projectSettingsLoadError = projectLoadError;
		this.errors = [...initialErrors];
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/** Create a SettingsManager that loads from files */
	static create(
		cwd: string,
		agentDir: string = getAgentDir(),
		options: SettingsManagerCreateOptions = {},
	): SettingsManager {
		const storage = new FileSettingsStorage(cwd, agentDir);
		return SettingsManager.fromStorage(storage, options);
	}

	/** Create a SettingsManager from an arbitrary storage backend */
	static fromStorage(storage: SettingsStorage, options: SettingsManagerCreateOptions = {}): SettingsManager {
		const projectTrusted = options.projectTrusted ?? true;
		const globalLoad = SettingsManager.tryLoadFromStorage(storage, "global");
		const projectLoad = SettingsManager.tryLoadFromStorage(storage, "project", projectTrusted);
		const initialErrors: SettingsError[] = [];
		if (globalLoad.error) {
			initialErrors.push({ scope: "global", error: globalLoad.error });
		}
		if (projectLoad.error) {
			initialErrors.push({ scope: "project", error: projectLoad.error });
		}

		return new SettingsManager(
			storage,
			globalLoad.settings,
			projectLoad.settings,
			globalLoad.error,
			projectLoad.error,
			initialErrors,
			projectTrusted,
		);
	}

	/** Create an in-memory SettingsManager (no file I/O) */
	static inMemory(settings: Partial<Settings> = {}, options: SettingsManagerCreateOptions = {}): SettingsManager {
		const storage = new InMemorySettingsStorage();
		const initialSettings = SettingsManager.migrateSettings(structuredClone(settings) as Record<string, unknown>);
		storage.withLock("global", () => JSON.stringify(initialSettings, null, 2));
		return SettingsManager.fromStorage(storage, options);
	}

	private static loadFromStorage(storage: SettingsStorage, scope: SettingsScope, projectTrusted = true): Settings {
		if (scope === "project" && !projectTrusted) {
			return {};
		}

		let loaded: Settings = {};
		storage.withLock(scope, (current) => {
			if (!current) return undefined;
			const parsed = JSON.parse(current) as Record<string, unknown>;
			loaded = SettingsManager.migrateSettings(parsed);
			const migrated = JSON.stringify(loaded, null, 2);
			return migrated === current ? undefined : migrated;
		});
		return loaded;
	}

	private static tryLoadFromStorage(
		storage: SettingsStorage,
		scope: SettingsScope,
		projectTrusted = true,
	): { settings: Settings; error: Error | null } {
		try {
			return { settings: SettingsManager.loadFromStorage(storage, scope, projectTrusted), error: null };
		} catch (error) {
			return { settings: {}, error: error as Error };
		}
	}

	/** Migrate old settings format to new format */
	private static migrateSettings(settings: Record<string, unknown>): Settings {
		// Migrate queueMode -> steeringMode
		if ("queueMode" in settings && !("steeringMode" in settings)) {
			settings.steeringMode = settings.queueMode;
			delete settings.queueMode;
		}

		// Migrate legacy websockets boolean -> transport enum
		if (!("transport" in settings) && typeof settings.websockets === "boolean") {
			settings.transport = settings.websockets ? "websocket" : "sse";
			delete settings.websockets;
		}

		// Migrate old skills object format to new array format
		if (
			"skills" in settings &&
			typeof settings.skills === "object" &&
			settings.skills !== null &&
			!Array.isArray(settings.skills)
		) {
			const skillsSettings = settings.skills as {
				enableSkillCommands?: boolean;
				customDirectories?: unknown;
			};
			if (skillsSettings.enableSkillCommands !== undefined && settings.enableSkillCommands === undefined) {
				settings.enableSkillCommands = skillsSettings.enableSkillCommands;
			}
			if (Array.isArray(skillsSettings.customDirectories) && skillsSettings.customDirectories.length > 0) {
				settings.skills = skillsSettings.customDirectories;
			} else {
				delete settings.skills;
			}
		}

		let embedding: EmbeddingSettings | undefined;
		if (settings.embedding !== undefined) {
			try {
				embedding = validateEmbeddingSettings(settings.embedding);
				settings.embedding = embedding;
			} catch {
				delete settings.embedding;
			}
		}
		if (settings.rerank !== undefined) {
			try {
				settings.rerank = validateRerankSettings(settings.rerank);
			} catch {
				delete settings.rerank;
			}
		}
		const hadLegacyMemoryModels = "memoryEmbeddingModel" in settings || "memoryRerankModel" in settings;
		if (hadLegacyMemoryModels) {
			delete settings.memoryEmbeddingModel;
			delete settings.memoryRerankModel;
		}
		if (!embedding && (settings.memoryEngine === "extract" || hadLegacyMemoryModels)) {
			if (settings.memoryEngine === "extract") settings.memoryEngine = "index";
			settings.memoryMigrationNotice =
				"Memory model settings changed; reconfigure Embedding and optional Rerank in Settings → Model.";
		}

		// Migrate retry.maxDelayMs -> retry.provider.maxRetryDelayMs
		if (
			"retry" in settings &&
			typeof settings.retry === "object" &&
			settings.retry !== null &&
			!Array.isArray(settings.retry)
		) {
			const retrySettings = settings.retry as Record<string, unknown>;
			const providerSettings =
				typeof retrySettings.provider === "object" && retrySettings.provider !== null
					? (retrySettings.provider as Record<string, unknown>)
					: undefined;
			if (
				typeof retrySettings.maxDelayMs === "number" &&
				(providerSettings?.maxRetryDelayMs === undefined || providerSettings?.maxRetryDelayMs === null)
			) {
				retrySettings.provider = {
					...(providerSettings ?? {}),
					maxRetryDelayMs: retrySettings.maxDelayMs,
				};
			}
			delete retrySettings.maxDelayMs;
		}

		return settings as Settings;
	}

	getGlobalSettings(): Settings {
		return structuredClone(this.globalSettings);
	}

	getProjectSettings(): Settings {
		return structuredClone(this.projectSettings);
	}

	getWebSearchSettings(): { enabled: boolean; provider: WebSearchProvider } {
		const value = this.globalSettings.webSearch;
		return {
			enabled: value?.enabled === true,
			provider: isWebSearchProvider(value?.provider) ? value.provider : "brave",
		};
	}

	setWebSearchEnabled(enabled: boolean): void {
		this.globalSettings.webSearch = { ...this.globalSettings.webSearch, enabled };
		this.markModified("webSearch", "enabled");
		this.save();
	}

	setWebSearchProvider(provider: WebSearchProvider): void {
		this.globalSettings.webSearch = { ...this.globalSettings.webSearch, provider };
		this.markModified("webSearch", "provider");
		this.save();
	}

	getMcpServers(): Record<string, McpServerSettings> {
		return structuredClone(this.settings.mcpServers ?? {});
	}

	applyMcpServerChanges(scope: SettingsScope, changes: ReadonlyMap<string, McpServerSettings | undefined>): void {
		if (changes.size === 0) return;
		for (const name of changes.keys()) {
			if (!name.trim()) throw new Error("MCP server name must not be empty");
		}
		const apply = (settings: Settings) => {
			const next = { ...(settings.mcpServers ?? {}) };
			for (const [name, server] of changes) {
				if (server) next[name] = structuredClone(server);
				else delete next[name];
			}
			settings.mcpServers = next;
		};
		if (scope === "global") {
			apply(this.globalSettings);
			for (const name of changes.keys()) this.markModified("mcpServers", name);
			this.save();
			return;
		}
		this.assertProjectTrustedForWrite();
		const projectSettings = structuredClone(this.projectSettings);
		apply(projectSettings);
		for (const name of changes.keys()) this.markProjectModified("mcpServers", name);
		this.saveProjectSettings(projectSettings);
	}

	/**
	 * Atomically compare and replace a set of MCP definitions.
	 *
	 * The comparison and write happen under the same storage lock, so another
	 * process cannot commit a stale MCP edit between validation and persistence.
	 */
	async commitMcpServerChanges(
		scope: SettingsScope,
		expected: ReadonlyMap<string, McpServerSettings | undefined>,
		changes: ReadonlyMap<string, McpServerSettings | undefined>,
	): Promise<boolean> {
		if (changes.size === 0) return true;
		if (scope === "project") this.assertProjectTrustedForWrite();
		for (const name of new Set([...expected.keys(), ...changes.keys()])) {
			if (!name.trim()) throw new Error("MCP server name must not be empty");
		}

		await this.flushOrThrow();
		let committed = false;
		const withWriteLock = this.storage.withWriteLock?.bind(this.storage) ?? this.storage.withLock.bind(this.storage);
		try {
			withWriteLock(scope, (current) => {
				const fileSettings = current
					? SettingsManager.migrateSettings(JSON.parse(current) as Record<string, unknown>)
					: {};
				const servers = fileSettings.mcpServers ?? {};
				for (const [name, definition] of expected) {
					if (!isDeepStrictEqual(servers[name], definition)) return undefined;
				}

				const nextServers = { ...servers };
				for (const [name, definition] of changes) {
					if (definition) nextServers[name] = structuredClone(definition);
					else delete nextServers[name];
				}
				fileSettings.mcpServers = nextServers;
				const serialized = JSON.stringify(fileSettings, null, 2);
				committed = true;
				return serialized;
			});
		} catch (error) {
			if (!committed) throw error;
			let published = false;
			try {
				withWriteLock(scope, (current) => {
					const fileSettings = current
						? SettingsManager.migrateSettings(JSON.parse(current) as Record<string, unknown>)
						: {};
					const servers = fileSettings.mcpServers ?? {};
					published = [...changes].every(([name, definition]) => isDeepStrictEqual(servers[name], definition));
					return undefined;
				});
			} catch (reconciliationError) {
				throw new AggregateError(
					[error, reconciliationError],
					"MCP settings commit failed and its published state could not be reconciled",
				);
			}
			if (!published) throw error;
		}

		await this.reload();
		const loadError = this.getLoadError(scope);
		if (loadError) throw loadError;
		return committed;
	}

	getLoadError(scope: SettingsScope): Error | null {
		return scope === "global" ? this.globalSettingsLoadError : this.projectSettingsLoadError;
	}

	setMcpServer(scope: SettingsScope, name: string, server: McpServerSettings): void {
		this.applyMcpServerChanges(scope, new Map([[name, server]]));
	}

	removeMcpServer(scope: SettingsScope, name: string): boolean {
		const source = scope === "global" ? this.globalSettings.mcpServers : this.projectSettings.mcpServers;
		if (!source || !(name in source)) return false;
		this.applyMcpServerChanges(scope, new Map([[name, undefined]]));
		return true;
	}

	isProjectTrusted(): boolean {
		return this.projectTrusted;
	}

	setProjectTrusted(trusted: boolean): void {
		if (this.projectTrusted === trusted) {
			return;
		}

		this.projectTrusted = trusted;
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		if (!trusted) {
			this.projectSettings = {};
			this.projectSettingsLoadError = null;
			this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
			return;
		}

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", trusted);
		this.projectSettings = projectLoad.settings;
		this.projectSettingsLoadError = projectLoad.error;
		if (projectLoad.error) {
			this.recordError("project", projectLoad.error);
		}
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	async reload(): Promise<void> {
		await this.writeQueue;
		const globalLoad = SettingsManager.tryLoadFromStorage(this.storage, "global");
		if (!globalLoad.error) {
			this.globalSettings = globalLoad.settings;
			this.globalSettingsLoadError = null;
		} else {
			this.globalSettingsLoadError = globalLoad.error;
			this.recordError("global", globalLoad.error);
		}

		this.modifiedFields.clear();
		this.modifiedNestedFields.clear();
		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();

		const projectLoad = SettingsManager.tryLoadFromStorage(this.storage, "project", this.projectTrusted);
		if (!projectLoad.error) {
			this.projectSettings = projectLoad.settings;
			this.projectSettingsLoadError = null;
		} else {
			this.projectSettingsLoadError = projectLoad.error;
			this.recordError("project", projectLoad.error);
		}

		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);
	}

	/** Apply additional overrides on top of current settings */
	applyOverrides(overrides: Partial<Settings>): void {
		this.settings = deepMergeSettings(this.settings, overrides);
	}

	/** Mark a global field as modified during this session */
	private markModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedFields.add(field);
		if (nestedKey) {
			if (!this.modifiedNestedFields.has(field)) {
				this.modifiedNestedFields.set(field, new Set());
			}
			this.modifiedNestedFields.get(field)!.add(nestedKey);
		}
	}

	/** Mark a project field as modified during this session */
	private markProjectModified(field: keyof Settings, nestedKey?: string): void {
		this.modifiedProjectFields.add(field);
		if (nestedKey) {
			if (!this.modifiedProjectNestedFields.has(field)) {
				this.modifiedProjectNestedFields.set(field, new Set());
			}
			this.modifiedProjectNestedFields.get(field)!.add(nestedKey);
		}
	}

	private assertProjectTrustedForWrite(): void {
		if (!this.projectTrusted) {
			throw new Error("Project is not trusted; refusing to write project settings");
		}
	}

	private recordError(scope: SettingsScope, error: unknown): void {
		const normalizedError = error instanceof Error ? error : new Error(String(error));
		this.errors.push({ scope, error: normalizedError });
	}

	private clearModifiedScope(scope: SettingsScope): void {
		if (scope === "global") {
			this.modifiedFields.clear();
			this.modifiedNestedFields.clear();
			return;
		}

		this.modifiedProjectFields.clear();
		this.modifiedProjectNestedFields.clear();
	}

	private enqueueWrite(scope: SettingsScope, task: () => void): void {
		this.writeQueue = this.writeQueue
			.then(() => {
				if (scope === "project") {
					this.assertProjectTrustedForWrite();
				}
				task();
				this.clearModifiedScope(scope);
			})
			.catch((error) => {
				this.recordError(scope, error);
			});
	}

	private cloneModifiedNestedFields(source: Map<keyof Settings, Set<string>>): Map<keyof Settings, Set<string>> {
		const snapshot = new Map<keyof Settings, Set<string>>();
		for (const [key, value] of source.entries()) {
			snapshot.set(key, new Set(value));
		}
		return snapshot;
	}

	private persistScopedSettings(
		scope: SettingsScope,
		snapshotSettings: Settings,
		modifiedFields: Set<keyof Settings>,
		modifiedNestedFields: Map<keyof Settings, Set<string>>,
	): void {
		this.storage.withLock(scope, (current) => {
			const currentFileSettings = current
				? SettingsManager.migrateSettings(JSON.parse(current) as Record<string, unknown>)
				: {};
			const mergedSettings: Settings = { ...currentFileSettings };
			for (const field of modifiedFields) {
				const value = snapshotSettings[field];
				if (modifiedNestedFields.has(field) && typeof value === "object" && value !== null) {
					const nestedModified = modifiedNestedFields.get(field)!;
					const baseNested = (currentFileSettings[field] as Record<string, unknown>) ?? {};
					const inMemoryNested = value as Record<string, unknown>;
					const mergedNested = { ...baseNested };
					for (const nestedKey of nestedModified) {
						mergedNested[nestedKey] = inMemoryNested[nestedKey];
					}
					(mergedSettings as Record<string, unknown>)[field] = mergedNested;
				} else {
					(mergedSettings as Record<string, unknown>)[field] = value;
				}
			}

			return JSON.stringify(mergedSettings, null, 2);
		});
	}

	private save(): void {
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

		if (this.globalSettingsLoadError) {
			return;
		}

		const snapshotGlobalSettings = structuredClone(this.globalSettings);
		const modifiedFields = new Set(this.modifiedFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedNestedFields);

		this.enqueueWrite("global", () => {
			this.persistScopedSettings("global", snapshotGlobalSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private saveProjectSettings(settings: Settings): void {
		this.assertProjectTrustedForWrite();
		this.projectSettings = structuredClone(settings);
		this.settings = deepMergeSettings(this.globalSettings, this.projectSettings);

		if (this.projectSettingsLoadError) {
			return;
		}

		const snapshotProjectSettings = structuredClone(this.projectSettings);
		const modifiedFields = new Set(this.modifiedProjectFields);
		const modifiedNestedFields = this.cloneModifiedNestedFields(this.modifiedProjectNestedFields);
		this.enqueueWrite("project", () => {
			this.persistScopedSettings("project", snapshotProjectSettings, modifiedFields, modifiedNestedFields);
		});
	}

	private updateProjectSettings(
		field: keyof Settings,
		update: (settings: Settings) => void,
		nestedKey?: string,
	): void {
		this.assertProjectTrustedForWrite();
		const projectSettings = structuredClone(this.projectSettings);
		update(projectSettings);
		this.markProjectModified(field, nestedKey);
		this.saveProjectSettings(projectSettings);
	}

	async flush(): Promise<void> {
		await this.writeQueue;
	}

	async throwPendingWriteError(): Promise<void> {
		await this.writeQueue;
		const [failure] = this.drainErrors();
		if (!failure) return;
		const original = failure.error;
		try {
			await this.reload();
			this.drainErrors();
		} catch (recoveryError) {
			(original as Error & { cause?: unknown }).cause ??= recoveryError;
		}
		throw original;
	}

	async flushOrThrow(): Promise<void> {
		await this.flush();
		await this.throwPendingWriteError();
	}

	drainErrors(): SettingsError[] {
		const drained = [...this.errors];
		this.errors = [];
		return drained;
	}

	getSessionDir(): string | undefined {
		const sessionDir = this.settings.sessionDir;
		return sessionDir ? normalizePath(sessionDir) : sessionDir;
	}

	getDefaultProvider(): string | undefined {
		return this.settings.defaultProvider;
	}

	getDefaultModel(): string | undefined {
		return this.settings.defaultModel;
	}

	setDefaultProvider(provider: string): void {
		this.globalSettings.defaultProvider = provider;
		this.markModified("defaultProvider");
		this.save();
	}

	setDefaultModel(modelId: string): void {
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultModel");
		this.save();
	}

	setDefaultModelAndProvider(provider: string, modelId: string): void {
		this.globalSettings.defaultProvider = provider;
		this.globalSettings.defaultModel = modelId;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.save();
	}

	setDefaultModelSettings(
		model: { provider: string; modelId: string } | null,
		thinkingSelection: ThinkingSelection,
	): void {
		if (model) {
			this.globalSettings.defaultProvider = model.provider;
			this.globalSettings.defaultModel = model.modelId;
		} else {
			delete this.globalSettings.defaultProvider;
			delete this.globalSettings.defaultModel;
		}
		this.globalSettings.defaultThinkingLevel = thinkingSelection;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.markModified("defaultThinkingLevel");
		this.save();
	}

	clearDefaultModelAndProvider(): void {
		delete this.globalSettings.defaultProvider;
		delete this.globalSettings.defaultModel;
		this.markModified("defaultProvider");
		this.markModified("defaultModel");
		this.save();
	}

	getVisionSettings(): VisionSettings | undefined {
		const settings = this.settings.vision;
		if (!settings || typeof settings !== "object") return undefined;
		const api =
			settings.api === "openai-completions" || settings.api === "anthropic-messages"
				? settings.api
				: "openai-responses";
		if (typeof settings.baseUrl !== "string" || typeof settings.modelId !== "string") return undefined;
		return {
			name: typeof settings.name === "string" && settings.name.trim() !== "" ? settings.name : settings.modelId,
			baseUrl: settings.baseUrl,
			api,
			modelId: settings.modelId,
		};
	}

	setVisionSettings(settings: VisionSettings): void {
		this.globalSettings.vision = { ...settings };
		delete this.globalSettings.visionProvider;
		delete this.globalSettings.visionModel;
		this.markModified("vision");
		this.markModified("visionProvider");
		this.markModified("visionModel");
		this.save();
	}

	clearVisionSettings(): void {
		delete this.globalSettings.vision;
		delete this.globalSettings.visionProvider;
		delete this.globalSettings.visionModel;
		this.markModified("vision");
		this.markModified("visionProvider");
		this.markModified("visionModel");
		this.save();
	}

	getSteeringMode(): "all" | "one-at-a-time" {
		return this.settings.steeringMode || "one-at-a-time";
	}

	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.steeringMode = mode;
		this.markModified("steeringMode");
		this.save();
	}

	getFollowUpMode(): "all" | "one-at-a-time" {
		return this.settings.followUpMode || "one-at-a-time";
	}

	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.globalSettings.followUpMode = mode;
		this.markModified("followUpMode");
		this.save();
	}

	getThemeSetting(): string | undefined {
		const value = this.settings.theme;
		if (typeof value === "string") return value;
		return undefined;
	}

	getTheme(): string | undefined {
		const theme = this.getThemeSetting();
		return theme?.includes("/") ? undefined : theme;
	}

	setTheme(theme: string): void {
		this.globalSettings.theme = theme;
		this.markModified("theme");
		this.save();
	}

	getDefaultThinkingLevel(): ThinkingSelection | undefined {
		return this.settings.defaultThinkingLevel;
	}

	setDefaultThinkingLevel(level: ThinkingSelection): void {
		this.globalSettings.defaultThinkingLevel = level;
		this.markModified("defaultThinkingLevel");
		this.save();
	}

	getTransport(): TransportSetting {
		return this.settings.transport ?? "auto";
	}

	setTransport(transport: TransportSetting): void {
		this.globalSettings.transport = transport;
		this.markModified("transport");
		this.save();
	}

	getCompactionEnabled(): boolean {
		return this.settings.compaction?.enabled ?? true;
	}

	setCompactionEnabled(enabled: boolean): void {
		if (!this.globalSettings.compaction) {
			this.globalSettings.compaction = {};
		}
		this.globalSettings.compaction.enabled = enabled;
		this.markModified("compaction", "enabled");
		this.save();
	}

	getCompactionReserveTokens(): number {
		return this.settings.compaction?.reserveTokens ?? 16384;
	}

	getCompactionKeepRecentTokens(): number {
		return this.settings.compaction?.keepRecentTokens ?? 20000;
	}

	getCompactionSettings(): { enabled: boolean; reserveTokens: number; keepRecentTokens: number } {
		return {
			enabled: this.getCompactionEnabled(),
			reserveTokens: this.getCompactionReserveTokens(),
			keepRecentTokens: this.getCompactionKeepRecentTokens(),
		};
	}

	getBranchSummarySettings(): { reserveTokens: number; skipPrompt: boolean } {
		return {
			reserveTokens: this.settings.branchSummary?.reserveTokens ?? 16384,
			skipPrompt: this.settings.branchSummary?.skipPrompt ?? false,
		};
	}

	getBranchSummarySkipPrompt(): boolean {
		return this.settings.branchSummary?.skipPrompt ?? false;
	}

	getRetryEnabled(): boolean {
		return this.settings.retry?.enabled ?? true;
	}

	setRetryEnabled(enabled: boolean): void {
		if (!this.globalSettings.retry) {
			this.globalSettings.retry = {};
		}
		this.globalSettings.retry.enabled = enabled;
		this.markModified("retry", "enabled");
		this.save();
	}

	getRetrySettings(): { enabled: boolean; maxRetries: number; baseDelayMs: number } {
		return {
			enabled: this.getRetryEnabled(),
			maxRetries: this.settings.retry?.maxRetries ?? 3,
			baseDelayMs: this.settings.retry?.baseDelayMs ?? 2000,
		};
	}

	getHttpIdleTimeoutMs(): number {
		return parseTimeoutSetting(this.settings.httpIdleTimeoutMs, "httpIdleTimeoutMs") ?? DEFAULT_HTTP_IDLE_TIMEOUT_MS;
	}

	setHttpIdleTimeoutMs(timeoutMs: number): void {
		if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
			throw new Error(`Invalid httpIdleTimeoutMs setting: ${String(timeoutMs)}`);
		}
		this.globalSettings.httpIdleTimeoutMs = Math.floor(timeoutMs);
		this.markModified("httpIdleTimeoutMs");
		this.save();
	}

	getProviderRetrySettings(): { timeoutMs?: number; maxRetries?: number; maxRetryDelayMs: number } {
		return {
			timeoutMs: this.settings.retry?.provider?.timeoutMs,
			maxRetries: this.settings.retry?.provider?.maxRetries,
			maxRetryDelayMs: this.settings.retry?.provider?.maxRetryDelayMs ?? 60000,
		};
	}

	getWebSocketConnectTimeoutMs(): number | undefined {
		return parseTimeoutSetting(this.settings.websocketConnectTimeoutMs, "websocketConnectTimeoutMs");
	}

	getHideThinkingBlock(): boolean {
		return this.settings.hideThinkingBlock ?? false;
	}

	getShowCacheMissNotices(): boolean {
		return this.settings.showCacheMissNotices ?? false;
	}

	getExternalEditorCommand(): string | undefined {
		const configuredEditor = this.settings.externalEditor;
		if (typeof configuredEditor === "string" && configuredEditor.trim() !== "") {
			return configuredEditor;
		}
		const environmentEditor = process.env.VISUAL || process.env.EDITOR;
		if (environmentEditor) {
			return environmentEditor;
		}
		return process.platform === "win32" ? "notepad" : "nano";
	}

	setHideThinkingBlock(hide: boolean): void {
		this.globalSettings.hideThinkingBlock = hide;
		this.markModified("hideThinkingBlock");
		this.save();
	}

	setShowCacheMissNotices(show: boolean): void {
		this.globalSettings.showCacheMissNotices = show;
		this.markModified("showCacheMissNotices");
		this.save();
	}

	getShellPath(): string | undefined {
		const shellPath = this.settings.shellPath;
		return shellPath ? normalizePath(shellPath) : shellPath;
	}

	setShellPath(path: string | undefined): void {
		this.globalSettings.shellPath = path;
		this.markModified("shellPath");
		this.save();
	}

	getQuietStartup(): boolean {
		return this.settings.quietStartup ?? false;
	}

	setQuietStartup(quiet: boolean): void {
		this.globalSettings.quietStartup = quiet;
		this.markModified("quietStartup");
		this.save();
	}

	getDefaultProjectTrust(): DefaultProjectTrust {
		const value = this.globalSettings.defaultProjectTrust;
		return value === "always" || value === "never" ? value : "ask";
	}

	setDefaultProjectTrust(defaultProjectTrust: DefaultProjectTrust): void {
		this.globalSettings.defaultProjectTrust = defaultProjectTrust;
		this.markModified("defaultProjectTrust");
		this.save();
	}

	getShellCommandPrefix(): string | undefined {
		return this.settings.shellCommandPrefix;
	}

	setShellCommandPrefix(prefix: string | undefined): void {
		this.globalSettings.shellCommandPrefix = prefix;
		this.markModified("shellCommandPrefix");
		this.save();
	}

	getNpmCommand(): string[] | undefined {
		return this.settings.npmCommand ? [...this.settings.npmCommand] : undefined;
	}

	setNpmCommand(command: string[] | undefined): void {
		this.globalSettings.npmCommand = command ? [...command] : undefined;
		this.markModified("npmCommand");
		this.save();
	}

	getEnableProviderAttribution(): boolean {
		return this.settings.enableProviderAttribution ?? false;
	}

	setEnableProviderAttribution(enabled: boolean): void {
		this.globalSettings.enableProviderAttribution = enabled;
		this.markModified("enableProviderAttribution");
		this.save();
	}

	getEnableAnalytics(): boolean {
		return this.settings.enableAnalytics ?? false;
	}

	getTrackingId(): string | undefined {
		return this.settings.trackingId;
	}

	/** Set the analytics opt-in preference; generates a tracking identifier on first opt-in */
	setEnableAnalytics(enabled: boolean): void {
		this.globalSettings.enableAnalytics = enabled;
		this.markModified("enableAnalytics");
		if (enabled && !this.globalSettings.trackingId) {
			this.globalSettings.trackingId = randomUUID();
			this.markModified("trackingId");
		}
		this.save();
	}

	getPackages(): PackageSource[] {
		return [...(this.settings.packages ?? [])];
	}

	setPackages(packages: PackageSource[]): void {
		this.globalSettings.packages = packages;
		this.markModified("packages");
		this.save();
	}

	setProjectPackages(packages: PackageSource[]): void {
		this.updateProjectSettings("packages", (settings) => {
			settings.packages = packages;
		});
	}

	getExtensionPaths(): string[] {
		return [...(this.settings.extensions ?? [])];
	}

	setExtensionPaths(paths: string[]): void {
		this.globalSettings.extensions = paths;
		this.markModified("extensions");
		this.save();
	}

	setProjectExtensionPaths(paths: string[]): void {
		this.updateProjectSettings("extensions", (settings) => {
			settings.extensions = paths;
		});
	}

	getSkillPaths(): string[] {
		return [...(this.settings.skills ?? [])];
	}

	setSkillPaths(paths: string[]): void {
		this.globalSettings.skills = paths;
		this.markModified("skills");
		this.save();
	}

	setProjectSkillPaths(paths: string[]): void {
		this.updateProjectSettings("skills", (settings) => {
			settings.skills = paths;
		});
	}

	getPromptTemplatePaths(): string[] {
		return [...(this.settings.prompts ?? [])];
	}

	setPromptTemplatePaths(paths: string[]): void {
		this.globalSettings.prompts = paths;
		this.markModified("prompts");
		this.save();
	}

	setProjectPromptTemplatePaths(paths: string[]): void {
		this.updateProjectSettings("prompts", (settings) => {
			settings.prompts = paths;
		});
	}

	getThemePaths(): string[] {
		return [...(this.settings.themes ?? [])];
	}

	setThemePaths(paths: string[]): void {
		this.globalSettings.themes = paths;
		this.markModified("themes");
		this.save();
	}

	setProjectThemePaths(paths: string[]): void {
		this.updateProjectSettings("themes", (settings) => {
			settings.themes = paths;
		});
	}

	getEnableSkillCommands(): boolean {
		return this.settings.enableSkillCommands ?? true;
	}

	setEnableSkillCommands(enabled: boolean): void {
		this.globalSettings.enableSkillCommands = enabled;
		this.markModified("enableSkillCommands");
		this.save();
	}

	getAutoMemoryEnabled(): boolean {
		return this.globalSettings.autoMemoryEnabled ?? true;
	}

	setAutoMemoryEnabled(enabled: boolean): void {
		this.globalSettings.autoMemoryEnabled = enabled;
		this.markModified("autoMemoryEnabled");
		this.save();
	}

	getMemoryEngine(): "index" | "extract" {
		const engine = this.globalSettings.memoryEngine;
		return engine === "extract" || engine === "index" ? engine : "index";
	}

	setMemoryEngine(engine: "index" | "extract" | string): void {
		if (engine !== "index" && engine !== "extract") {
			return;
		}
		if (engine === "extract") {
			if (!this.globalSettings.embedding) {
				throw new Error('Cannot enable memory engine "extract" without configured Embedding settings.');
			}
		}
		this.globalSettings.memoryEngine = engine;
		this.markModified("memoryEngine");
		this.save();
	}

	setMemorySettings(autoMemoryEnabled: boolean, memoryEngine: "index" | "extract"): void {
		if (memoryEngine === "extract" && !this.globalSettings.embedding) {
			throw new Error('Cannot enable memory engine "extract" without configured Embedding settings.');
		}
		this.globalSettings.autoMemoryEnabled = autoMemoryEnabled;
		this.globalSettings.memoryEngine = memoryEngine;
		this.markModified("autoMemoryEnabled");
		this.markModified("memoryEngine");
		this.save();
	}

	getEmbeddingSettings(): EmbeddingSettings | undefined {
		return this.globalSettings.embedding ? structuredClone(this.globalSettings.embedding) : undefined;
	}

	setEmbeddingSettings(settings: EmbeddingSettings): void {
		this.globalSettings.embedding = validateEmbeddingSettings(settings);
		delete this.globalSettings.memoryMigrationNotice;
		this.markModified("embedding");
		this.markModified("memoryMigrationNotice");
		this.save();
	}

	clearEmbeddingSettings(): void {
		delete this.globalSettings.embedding;
		if (this.globalSettings.memoryEngine === "extract") this.globalSettings.memoryEngine = "index";
		this.markModified("embedding");
		this.markModified("memoryEngine");
		this.save();
	}

	getRerankSettings(): RerankSettings | undefined {
		return this.globalSettings.rerank ? structuredClone(this.globalSettings.rerank) : undefined;
	}

	setRerankSettings(settings: RerankSettings): void {
		this.globalSettings.rerank = validateRerankSettings(settings);
		this.markModified("rerank");
		this.save();
	}

	clearRerankSettings(): void {
		delete this.globalSettings.rerank;
		this.markModified("rerank");
		this.save();
	}

	getMemoryMigrationNotice(): string | undefined {
		return this.globalSettings.memoryMigrationNotice;
	}

	clearMemoryMigrationNotice(): void {
		delete this.globalSettings.memoryMigrationNotice;
		this.markModified("memoryMigrationNotice");
		this.save();
	}

	getThinkingBudgets(): ThinkingBudgetsSettings | undefined {
		return this.settings.thinkingBudgets;
	}

	getClearOnShrink(): boolean {
		// Settings takes precedence, then env var, then default false
		if (this.settings.terminal?.clearOnShrink !== undefined) {
			return this.settings.terminal.clearOnShrink;
		}
		return getMetisEnv("CLEAR_ON_SHRINK") === "1";
	}

	setClearOnShrink(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.clearOnShrink = enabled;
		this.markModified("terminal", "clearOnShrink");
		this.save();
	}

	getShowTerminalProgress(): boolean {
		return this.settings.terminal?.showTerminalProgress ?? false;
	}

	setShowTerminalProgress(enabled: boolean): void {
		if (!this.globalSettings.terminal) {
			this.globalSettings.terminal = {};
		}
		this.globalSettings.terminal.showTerminalProgress = enabled;
		this.markModified("terminal", "showTerminalProgress");
		this.save();
	}

	getEnabledModels(): string[] | undefined {
		return this.settings.enabledModels;
	}

	setEnabledModels(patterns: string[] | undefined): void {
		this.globalSettings.enabledModels = patterns;
		this.markModified("enabledModels");
		this.save();
	}

	getDoubleEscapeAction(): "fork" | "tree" | "none" {
		return this.settings.doubleEscapeAction ?? "tree";
	}

	setDoubleEscapeAction(action: "fork" | "tree" | "none"): void {
		this.globalSettings.doubleEscapeAction = action;
		this.markModified("doubleEscapeAction");
		this.save();
	}

	getTreeFilterMode(): "default" | "no-tools" | "user-only" | "labeled-only" | "all" {
		const mode = this.settings.treeFilterMode;
		const valid = ["default", "no-tools", "user-only", "labeled-only", "all"];
		return mode && valid.includes(mode) ? mode : "default";
	}

	setTreeFilterMode(mode: "default" | "no-tools" | "user-only" | "labeled-only" | "all"): void {
		this.globalSettings.treeFilterMode = mode;
		this.markModified("treeFilterMode");
		this.save();
	}

	getShowHardwareCursor(): boolean {
		return this.settings.showHardwareCursor ?? getMetisEnv("HARDWARE_CURSOR") === "1";
	}

	setShowHardwareCursor(enabled: boolean): void {
		this.globalSettings.showHardwareCursor = enabled;
		this.markModified("showHardwareCursor");
		this.save();
	}

	getEditorPaddingX(): number {
		return this.settings.editorPaddingX ?? 0;
	}

	setEditorPaddingX(padding: number): void {
		this.globalSettings.editorPaddingX = Math.max(0, Math.min(3, Math.floor(padding)));
		this.markModified("editorPaddingX");
		this.save();
	}

	getOutputPad(): 0 | 1 {
		return this.settings.outputPad === 0 ? 0 : 1;
	}

	setOutputPad(padding: 0 | 1): void {
		this.globalSettings.outputPad = padding;
		this.markModified("outputPad");
		this.save();
	}

	getAutocompleteMaxVisible(): number {
		return this.settings.autocompleteMaxVisible ?? 5;
	}

	setAutocompleteMaxVisible(maxVisible: number): void {
		this.globalSettings.autocompleteMaxVisible = Math.max(3, Math.min(20, Math.floor(maxVisible)));
		this.markModified("autocompleteMaxVisible");
		this.save();
	}

	getCodeBlockIndent(): string {
		return this.settings.markdown?.codeBlockIndent ?? "  ";
	}
}
