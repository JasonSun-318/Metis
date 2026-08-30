import { createHash } from "node:crypto";
import type {
	CallToolResult,
	GetPromptResult,
	ReadResourceResult,
	Tool,
	ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import {
	type AuthCredential,
	type AuthStorage,
	legacyMcpCredentialKey,
	type McpSecretCredential,
	mcpCredentialKey,
} from "../auth-storage.ts";
import type { McpServerSettings, SettingsManager } from "../settings-manager.ts";
import { type McpConnectionState, McpServerClient } from "./client.ts";
import {
	mcpServerFingerprint,
	type ResolvedMcpServerConfig,
	type ResolvedMcpSettings,
	resolveMcpServerDefinitions,
	resolveMcpSettings,
} from "./config.ts";
import {
	type McpConfigurationChange,
	type McpConfigurationCoordinator,
	type McpConfigurationResult,
	type McpConfigurationScope,
	mcpConfigurationRevision,
	mcpCredentialState,
} from "./configuration.ts";

const MAX_TOOL_NAME = 64;

export interface McpToolRecord {
	serverName: string;
	rawName: string;
	modelName: string;
	tool: Tool;
	sourceName: string;
	sourceDescription?: string;
	searchText: string;
}

export interface McpManagerCreateOptions {
	settingsManager: SettingsManager;
	authStorage: AuthStorage;
	cwd: string;
	environment?: NodeJS.ProcessEnv;
	backgroundOptionalStartup?: boolean;
	configurationCoordinator?: McpConfigurationCoordinator;
}

export interface McpPreparedConfiguration {
	readonly revision: string;
}

export type McpCredentialOverlay = ReadonlyMap<string, AuthCredential | undefined>;

interface ClientGeneration {
	readonly clients: Map<string, McpServerClient>;
	inFlight: number;
	retired: boolean;
	closePromise?: Promise<void>;
}

export interface McpServerStatus {
	name: string;
	transport: "stdio" | "http";
	state: McpConnectionState;
	required: boolean;
	serverInfo?: { name: string; version: string };
	toolCount: number;
	resourceCount: number;
	resourceTemplateCount: number;
	promptCount: number;
	capabilities: string[];
	lastError?: string;
}

export interface McpCatalogEntry {
	id: string;
	name: string;
	description?: string;
}

export type McpCatalogItemKind = "tool" | "prompt" | "resource" | "resourceTemplate";

export type McpCatalogItemDetail =
	| (McpCatalogEntry & {
			kind: "tool";
			inputSchema: string;
			outputSchema?: string;
			annotations?: string;
	  })
	| (McpCatalogEntry & {
			kind: "prompt";
			arguments: Array<{ name: string; description?: string; required: boolean }>;
	  })
	| (McpCatalogEntry & { kind: "resource"; uri: string; mimeType?: string; size?: number })
	| (McpCatalogEntry & { kind: "resourceTemplate"; uriTemplate: string; mimeType?: string });

export interface McpCatalogSummary {
	tools: McpCatalogEntry[];
	resources: McpCatalogEntry[];
	resourceTemplates: McpCatalogEntry[];
	prompts: McpCatalogEntry[];
}

function sanitizeSegment(value: string): string {
	return value.replace(/[^A-Za-z0-9_-]/g, "_") || "unnamed";
}

function suffix(rawIdentity: string): string {
	return createHash("sha256").update(rawIdentity).digest("hex").slice(0, 8);
}

function boundedName(base: string, rawIdentity: string, forceHash: boolean): string {
	const hash = `__${suffix(rawIdentity)}`;
	if (!forceHash && base.length <= MAX_TOOL_NAME) return base;
	return `${base.slice(0, MAX_TOOL_NAME - hash.length)}${hash}`;
}

export function normalizeMcpToolNames(entries: Array<{ serverName: string; rawName: string }>): Map<string, string> {
	const groups = new Map<string, string[]>();
	for (const entry of entries) {
		const rawIdentity = `${entry.serverName}\0${entry.rawName}`;
		const base = `mcp__${sanitizeSegment(entry.serverName)}__${sanitizeSegment(entry.rawName)}`;
		groups.set(base, [...(groups.get(base) ?? []), rawIdentity]);
	}

	const result = new Map<string, string>();
	for (const [base, identities] of groups) {
		for (const identity of [...new Set(identities)].sort()) {
			result.set(identity, boundedName(base, identity, identities.length > 1));
		}
	}
	return result;
}

function tokens(value: string): string[] {
	return (
		value
			.toLocaleLowerCase()
			.replace(/[_-]+/g, " ")
			.match(/[\p{L}\p{N}]+/gu) ?? []
	);
}

class ToolSearchIndex {
	private readonly documents: Array<{
		record: McpToolRecord;
		terms: Map<string, number>;
		length: number;
	}>;
	private readonly documentFrequency = new Map<string, number>();
	private readonly averageLength: number;

	constructor(records: readonly McpToolRecord[]) {
		this.documents = records.map((record) => {
			const values = tokens(record.searchText);
			const terms = new Map<string, number>();
			for (const value of values) terms.set(value, (terms.get(value) ?? 0) + 1);
			for (const value of terms.keys()) {
				this.documentFrequency.set(value, (this.documentFrequency.get(value) ?? 0) + 1);
			}
			return { record, terms, length: values.length };
		});
		this.averageLength =
			this.documents.reduce((sum, document) => sum + document.length, 0) / Math.max(1, this.documents.length);
	}

	search(query: string, limit = 8): McpToolRecord[] {
		const queryTerms = [...new Set(tokens(query.trim()))];
		if (queryTerms.length === 0 || !Number.isFinite(limit) || limit < 1) return [];
		const documentCount = this.documents.length;
		return this.documents
			.map((document) => {
				let score = 0;
				for (const term of queryTerms) {
					const frequency = document.terms.get(term) ?? 0;
					if (frequency === 0) continue;
					const documentFrequency = this.documentFrequency.get(term) ?? 0;
					const inverseDocumentFrequency = Math.log(
						1 + (documentCount - documentFrequency + 0.5) / (documentFrequency + 0.5),
					);
					const denominator =
						frequency + 1.2 * (1 - 0.75 + (0.75 * document.length) / Math.max(1, this.averageLength));
					score += (inverseDocumentFrequency * frequency * 2.2) / denominator;
				}
				return { record: document.record, score };
			})
			.filter((item) => item.score > 0)
			.sort((left, right) => right.score - left.score || left.record.modelName.localeCompare(right.record.modelName))
			.slice(0, Math.min(Math.floor(limit), 50))
			.map((item) => item.record);
	}
}

function propertyNames(tool: Tool): string[] {
	const properties = tool.inputSchema.properties;
	return properties && typeof properties === "object" ? Object.keys(properties).sort() : [];
}

function buildSearchText(modelName: string, serverName: string, tool: Tool, instructions?: string): string {
	return [
		modelName,
		modelName,
		tool.name,
		tool.name,
		serverName,
		tool.title,
		tool.description,
		instructions,
		...propertyNames(tool),
	]
		.filter((value): value is string => Boolean(value))
		.join("\n");
}

function isEnabledTool(config: ResolvedMcpServerConfig, tool: Tool): boolean {
	if (config.enabledTools && !config.enabledTools.includes(tool.name)) return false;
	if (config.disabledTools.includes(tool.name)) return false;
	return tool.execution?.taskSupport !== "required";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function catalogIdentity(value: string, maximumCharacters: number): string {
	return value.length <= maximumCharacters ? value : `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function catalogEntry(
	id: string,
	name: string,
	description: string | undefined,
	maximumCharacters: number,
): McpCatalogEntry {
	return {
		id: catalogIdentity(id, maximumCharacters),
		name: (name || id).slice(0, maximumCharacters),
		...(description ? { description: description.slice(0, 16_000) } : {}),
	};
}

function catalogEntries(items: McpCatalogEntry[]): McpCatalogEntry[] {
	return [...new Map(items.filter((item) => item.id).map((item) => [item.id, item])).values()].sort(
		(left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
	);
}

function boundedJson(value: unknown, label: string): string {
	const json = JSON.stringify(value);
	if (Buffer.byteLength(json, "utf8") > 256 * 1024) throw new Error(`MCP ${label} is too large to display`);
	return json;
}

export class McpManager {
	private readonly settingsManager: SettingsManager;
	private readonly authStorage: AuthStorage;
	private readonly cwd: string;
	private readonly environment: NodeJS.ProcessEnv;
	private readonly configurationCoordinator?: McpConfigurationCoordinator;
	private activeGeneration: ClientGeneration = {
		clients: new Map<string, McpServerClient>(),
		inFlight: 0,
		retired: false,
	};
	private readonly retiredGenerations = new Set<ClientGeneration>();
	private readonly preparedGenerations = new Map<McpPreparedConfiguration, ClientGeneration>();
	private readonly cleanupErrors: Error[] = [];
	private activeRevision = "";
	private refreshTail: Promise<void> = Promise.resolve();
	private clientUnsubscribers: Array<() => void> = [];
	private records: McpToolRecord[] = [];
	private recordByModelName = new Map<string, McpToolRecord>();
	private searchIndex = new ToolSearchIndex([]);
	private readonly catalogListeners = new Set<() => void>();
	private closed = false;
	private unregisterCoordinator?: () => void;

	private get clients(): Map<string, McpServerClient> {
		return this.activeGeneration.clients;
	}

	private constructor(options: McpManagerCreateOptions) {
		this.settingsManager = options.settingsManager;
		this.authStorage = options.authStorage;
		this.cwd = options.cwd;
		this.environment = options.environment ?? process.env;
		this.configurationCoordinator = options.configurationCoordinator;
	}

	static async create(options: McpManagerCreateOptions): Promise<McpManager> {
		const manager = new McpManager(options);
		await manager.initialize(
			resolveMcpSettings(options.settingsManager, options.cwd, options.environment),
			options.backgroundOptionalStartup ?? false,
		);
		manager.unregisterCoordinator = options.configurationCoordinator?.register(manager);
		return manager;
	}

	private createClients(
		settings: ResolvedMcpSettings,
		credentialOverlay?: McpCredentialOverlay,
	): Map<string, McpServerClient> {
		return new Map(
			settings.servers.map((config) => {
				const resolved = this.applyStoredCredential(config, credentialOverlay);
				return [resolved.name, new McpServerClient(resolved, this.authStorage)] as const;
			}),
		);
	}

	private storedSecret(config: ResolvedMcpServerConfig, credentialOverlay?: McpCredentialOverlay) {
		const fingerprint = mcpServerFingerprint(config);
		const keys = [
			config.credentialKey,
			mcpCredentialKey(config.credentialIdentity),
			legacyMcpCredentialKey(config.name),
		];
		for (const key of new Set(keys)) {
			const credential = credentialOverlay?.has(key) ? credentialOverlay.get(key) : this.authStorage.get(key);
			if (credential?.type === "mcp_revoked" && credential.serverFingerprint === fingerprint) return undefined;
			if (credential?.type === "mcp_secret" && credential.serverFingerprint === fingerprint) return credential;
		}
		return undefined;
	}

	private applyStoredCredential(
		config: ResolvedMcpServerConfig,
		credentialOverlay?: McpCredentialOverlay,
	): ResolvedMcpServerConfig {
		const credential = this.storedSecret(config, credentialOverlay);
		if (!credential) return config;
		const storedHeaders = Object.fromEntries(
			Object.entries(config.httpHeaderEnv ?? {}).flatMap(([header, environmentName]) =>
				credential.env?.[environmentName] === undefined
					? []
					: ([[header, credential.env[environmentName]]] as const),
			),
		);
		return {
			...config,
			bearerToken:
				credential.bearerToken ??
				(config.bearerTokenEnvVar ? credential.env?.[config.bearerTokenEnvVar] : undefined) ??
				config.bearerToken,
			env: { ...(config.env ?? {}), ...(credential.env ?? {}) },
			httpHeaders: { ...(config.httpHeaders ?? {}), ...storedHeaders },
		};
	}

	private async startClients(clients: Map<string, McpServerClient>, backgroundOptionalStartup = false): Promise<void> {
		const enabled = [...clients.values()].filter((client) => client.resolvedConfig.enabled);
		const required = enabled.filter((client) => client.resolvedConfig.required);
		const optional = enabled.filter((client) => !client.resolvedConfig.required);
		const optionalStartup = Promise.allSettled(optional.map((client) => client.start()));
		const requiredStartup = Promise.allSettled(required.map((client) => client.start()));
		if (backgroundOptionalStartup) void optionalStartup;
		else await optionalStartup;
		const results = await requiredStartup;
		const requiredFailure = results.findIndex((result) => result.status === "rejected");
		if (requiredFailure === -1) return;

		const failedClient = required[requiredFailure];
		const failure = results[requiredFailure] as PromiseRejectedResult;
		await Promise.all([...clients.values()].map((client) => client.close()));
		throw new Error(
			`Failed to initialize required MCP server "${failedClient.name}": ${errorMessage(failure.reason)}`,
		);
	}

	private attachClientSubscriptions(): void {
		for (const unsubscribe of this.clientUnsubscribers) unsubscribe();
		this.clientUnsubscribers = [...this.clients.values()].map((client) =>
			client.subscribeCatalog(() => {
				if (this.clients.get(client.name) !== client) return;
				this.rebuildRecords();
				this.notifyCatalogListeners();
			}),
		);
	}

	private notifyCatalogListeners(): void {
		for (const listener of [...this.catalogListeners]) {
			try {
				listener();
			} catch (cause) {
				this.catalogListeners.delete(listener);
				this.cleanupErrors.push(new Error("MCP catalog listener failed", { cause }));
			}
		}
	}

	private async initialize(settings: ResolvedMcpSettings, backgroundOptionalStartup: boolean): Promise<void> {
		const clients = this.createClients(settings);
		await this.startClients(clients, backgroundOptionalStartup);
		this.activeGeneration = { clients, inFlight: 0, retired: false };
		this.activeRevision = this.runtimeConfigurationRevision(settings);
		this.attachClientSubscriptions();
		this.rebuildRecords();
	}

	private runtimeConfigurationRevision(
		settings: ResolvedMcpSettings,
		credentialOverlay?: McpCredentialOverlay,
	): string {
		return createHash("sha256")
			.update(
				JSON.stringify(settings.servers.map((server) => [server, this.storedSecret(server, credentialOverlay)])),
			)
			.digest("hex");
	}

	private error(error: unknown): Error {
		return error instanceof Error ? error : new Error(String(error));
	}

	private closeRetiredGeneration(generation: ClientGeneration): Promise<void> {
		if (generation.closePromise) return generation.closePromise;
		generation.closePromise = Promise.all([...generation.clients.values()].map((client) => client.close()))
			.then(() => undefined)
			.catch((error) => {
				this.cleanupErrors.push(this.error(error));
			})
			.finally(() => {
				this.retiredGenerations.delete(generation);
			});
		return generation.closePromise;
	}

	private retire(generation: ClientGeneration): void {
		generation.retired = true;
		this.retiredGenerations.add(generation);
		if (generation.inFlight === 0) void this.closeRetiredGeneration(generation);
	}

	private async withActiveGeneration<T>(
		operation: (clients: ReadonlyMap<string, McpServerClient>) => Promise<T>,
	): Promise<T> {
		if (this.closed) throw new Error("MCP manager is closed");
		const generation = this.activeGeneration;
		generation.inFlight += 1;
		try {
			return await operation(generation.clients);
		} finally {
			generation.inFlight -= 1;
			if (generation.retired && generation.inFlight === 0) void this.closeRetiredGeneration(generation);
		}
	}

	private rebuildRecords(): void {
		const candidates = [...this.clients.values()].flatMap((client) => {
			const config = client.resolvedConfig;
			const snapshot = client.snapshot();
			return snapshot.tools
				.filter((tool) => isEnabledTool(config, tool))
				.map((tool) => ({ config, snapshot, tool }));
		});
		const normalized = normalizeMcpToolNames(
			candidates.map(({ config, tool }) => ({ serverName: config.name, rawName: tool.name })),
		);
		this.records = candidates.map(({ config, snapshot, tool }) => {
			const modelName = normalized.get(`${config.name}\0${tool.name}`)!;
			const sourceDescription =
				[config.description, snapshot.instructions].filter(Boolean).join("\n\n") || undefined;
			return {
				serverName: config.name,
				rawName: tool.name,
				modelName,
				tool,
				sourceName: config.name,
				sourceDescription,
				searchText: buildSearchText(modelName, config.name, tool, sourceDescription),
			};
		});
		this.recordByModelName = new Map(this.records.map((record) => [record.modelName, record]));
		this.searchIndex = new ToolSearchIndex(this.records);
	}

	getToolRecords(): readonly McpToolRecord[] {
		return this.records;
	}

	getDirectToolNames(): string[] {
		const names: string[] = [];
		if (this.records.length > 0) names.push("tool_search");
		const statuses = this.getStatus().filter((status) => status.state === "connected");
		if (statuses.some((status) => status.capabilities.includes("resources"))) {
			names.push("list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource");
		}
		if (statuses.some((status) => status.capabilities.includes("prompts"))) {
			names.push("list_mcp_prompts", "get_mcp_prompt");
		}
		return names;
	}

	searchTools(query: string, limit = 8): McpToolRecord[] {
		return this.searchIndex.search(query, limit);
	}

	private recordFor(modelName: string): McpToolRecord {
		const record = this.recordByModelName.get(modelName);
		if (!record) throw new Error(`Unknown MCP tool "${modelName}"`);
		return record;
	}

	private clientFor(serverName: string): McpServerClient {
		const client = this.clients.get(serverName);
		if (!client) throw new Error(`Unknown MCP server "${serverName}"`);
		return client;
	}

	async callTool(modelName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
		await this.ensureCurrent();
		const record = this.recordFor(modelName);
		return this.withActiveGeneration((clients) => {
			const client = clients.get(record.serverName);
			if (!client) throw new Error(`Unknown MCP server "${record.serverName}"`);
			return client.callTool(record.rawName, args, signal);
		});
	}

	getToolAnnotations(modelName: string): ToolAnnotations | undefined {
		return this.recordFor(modelName).tool.annotations;
	}

	private async aggregate(
		capability: "resources" | "prompts",
		operation: (client: McpServerClient) => Promise<object>,
	): Promise<{ servers: object[] }> {
		return this.withActiveGeneration(async (generationClients) => {
			const clients = [...generationClients.values()].filter((client) => {
				const status = client.status();
				return status.state === "connected" && Boolean(client.snapshot().capabilities[capability]);
			});
			return {
				servers: await Promise.all(
					clients.map(async (client) => {
						try {
							return { server: client.name, ...(await operation(client)) };
						} catch (error) {
							return { server: client.name, error: errorMessage(error) };
						}
					}),
				),
			};
		});
	}

	async listResources(server?: string, cursor?: string): Promise<unknown> {
		if (cursor && !server) throw new Error("cursor can only be used when a server is specified");
		await this.ensureCurrent();
		if (server)
			return this.withActiveGeneration((clients) => {
				const client = clients.get(server);
				if (!client) throw new Error(`Unknown MCP server "${server}"`);
				return client.listResources(cursor);
			});
		return this.aggregate("resources", (client) => client.listResources());
	}

	async listResourceTemplates(server?: string, cursor?: string): Promise<unknown> {
		if (cursor && !server) throw new Error("cursor can only be used when a server is specified");
		await this.ensureCurrent();
		if (server)
			return this.withActiveGeneration((clients) => {
				const client = clients.get(server);
				if (!client) throw new Error(`Unknown MCP server "${server}"`);
				return client.listResourceTemplates(cursor);
			});
		return this.aggregate("resources", (client) => client.listResourceTemplates());
	}

	async readResource(server: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
		await this.ensureCurrent();
		return this.withActiveGeneration((clients) => {
			const client = clients.get(server);
			if (!client) throw new Error(`Unknown MCP server "${server}"`);
			return client.readResource(uri, signal);
		});
	}

	async listPrompts(server?: string, cursor?: string): Promise<unknown> {
		if (cursor && !server) throw new Error("cursor can only be used when a server is specified");
		await this.ensureCurrent();
		if (server)
			return this.withActiveGeneration((clients) => {
				const client = clients.get(server);
				if (!client) throw new Error(`Unknown MCP server "${server}"`);
				return client.listPrompts(cursor);
			});
		return this.aggregate("prompts", (client) => client.listPrompts());
	}

	async getPrompt(server: string, name: string, args?: Record<string, string>): Promise<GetPromptResult> {
		await this.ensureCurrent();
		return this.withActiveGeneration((clients) => {
			const client = clients.get(server);
			if (!client) throw new Error(`Unknown MCP server "${server}"`);
			return client.getPrompt(name, args);
		});
	}

	getStatus(): McpServerStatus[] {
		return [...this.clients.values()].map((client) => {
			const config = client.resolvedConfig;
			const snapshot = client.snapshot();
			const status = client.status();
			return {
				name: config.name,
				transport: config.transport,
				state: status.state,
				required: config.required,
				serverInfo: snapshot.serverInfo,
				toolCount: snapshot.tools.length,
				resourceCount: snapshot.resources.length,
				resourceTemplateCount: snapshot.resourceTemplates.length,
				promptCount: snapshot.prompts.length,
				capabilities: Object.keys(snapshot.capabilities).sort(),
				lastError: status.lastError,
			};
		});
	}

	getCatalog(server: string): McpCatalogSummary {
		const snapshot = this.clientFor(server).snapshot();
		return {
			tools: catalogEntries(
				snapshot.tools.map((item) =>
					catalogEntry(item.name, item.title ?? item.annotations?.title ?? item.name, item.description, 256),
				),
			),
			resources: catalogEntries(
				snapshot.resources.map((item) => catalogEntry(item.uri, item.title ?? item.name, item.description, 16_000)),
			),
			resourceTemplates: catalogEntries(
				snapshot.resourceTemplates.map((item) =>
					catalogEntry(item.uriTemplate, item.title ?? item.name, item.description, 16_000),
				),
			),
			prompts: catalogEntries(
				snapshot.prompts.map((item) => catalogEntry(item.name, item.title ?? item.name, item.description, 256)),
			),
		};
	}

	getCatalogItem(server: string, kind: McpCatalogItemKind, id: string): McpCatalogItemDetail {
		const snapshot = this.clientFor(server).snapshot();
		if (kind === "tool") {
			const item = snapshot.tools.find((tool) => catalogIdentity(tool.name, 256) === id);
			if (!item) throw new Error(`Unknown MCP tool: ${id}`);
			return {
				kind,
				...catalogEntry(item.name, item.title ?? item.annotations?.title ?? item.name, item.description, 256),
				inputSchema: boundedJson(item.inputSchema, "tool input schema"),
				...(item.outputSchema ? { outputSchema: boundedJson(item.outputSchema, "tool output schema") } : {}),
				...(item.annotations ? { annotations: boundedJson(item.annotations, "tool annotations") } : {}),
			};
		}
		if (kind === "prompt") {
			const item = snapshot.prompts.find((prompt) => catalogIdentity(prompt.name, 256) === id);
			if (!item) throw new Error(`Unknown MCP prompt: ${id}`);
			return {
				kind,
				...catalogEntry(item.name, item.title ?? item.name, item.description, 256),
				arguments: (item.arguments ?? []).map((argument) => ({
					name: argument.name.slice(0, 256),
					...(argument.description ? { description: argument.description.slice(0, 16_000) } : {}),
					required: argument.required ?? false,
				})),
			};
		}
		if (kind === "resource") {
			const item = snapshot.resources.find((resource) => catalogIdentity(resource.uri, 16_000) === id);
			if (!item) throw new Error(`Unknown MCP resource: ${id}`);
			return {
				kind,
				...catalogEntry(item.uri, item.title ?? item.name, item.description, 16_000),
				uri: item.uri.slice(0, 16_000),
				...(item.mimeType ? { mimeType: item.mimeType.slice(0, 256) } : {}),
				...(Number.isSafeInteger(item.size) && (item.size ?? -1) >= 0 ? { size: item.size } : {}),
			};
		}
		const item = snapshot.resourceTemplates.find((template) => catalogIdentity(template.uriTemplate, 16_000) === id);
		if (!item) throw new Error(`Unknown MCP resource template: ${id}`);
		return {
			kind,
			...catalogEntry(item.uriTemplate, item.title ?? item.name, item.description, 16_000),
			uriTemplate: item.uriTemplate.slice(0, 16_000),
			...(item.mimeType ? { mimeType: item.mimeType.slice(0, 256) } : {}),
		};
	}

	hasCredential(server: string): boolean {
		return this.storedSecret(this.clientFor(server).resolvedConfig) !== undefined;
	}

	getSecretEnvironment(server: string): Record<string, string> {
		const config = this.clientFor(server).resolvedConfig;
		const credential = this.storedSecret(config);
		if (!credential) return {};
		return { ...(credential.env ?? {}) };
	}

	subscribeCatalog(listener: () => void): () => void {
		this.catalogListeners.add(listener);
		return () => this.catalogListeners.delete(listener);
	}

	async prepareConfiguration(
		settings: ResolvedMcpSettings = resolveMcpSettings(this.settingsManager, this.cwd, this.environment),
		credentialOverlay?: McpCredentialOverlay,
	): Promise<McpPreparedConfiguration> {
		this.authStorage.reload();
		const nextClients = this.createClients(settings, credentialOverlay);
		await this.startClients(nextClients);
		const prepared = { revision: this.runtimeConfigurationRevision(settings, credentialOverlay) };
		this.preparedGenerations.set(prepared, { clients: nextClients, inFlight: 0, retired: false });
		return prepared;
	}

	activateConfiguration(prepared: McpPreparedConfiguration): void {
		const next = this.preparedGenerations.get(prepared);
		if (!next) throw new Error("Unknown or already consumed MCP configuration");
		if (this.closed) throw new Error("MCP manager is closed");
		this.preparedGenerations.delete(prepared);
		const previous = this.activeGeneration;
		this.activeGeneration = next;
		this.activeRevision = prepared.revision;
		try {
			this.attachClientSubscriptions();
			this.rebuildRecords();
			this.notifyCatalogListeners();
		} finally {
			this.retire(previous);
		}
	}

	async discardConfiguration(prepared: McpPreparedConfiguration): Promise<void> {
		const generation = this.preparedGenerations.get(prepared);
		if (!generation) return;
		this.preparedGenerations.delete(prepared);
		await Promise.all([...generation.clients.values()].map((client) => client.close()));
	}

	async reload(): Promise<void> {
		const prepared = await this.prepareConfiguration();
		this.activateConfiguration(prepared);
	}

	get configurationCwd(): string {
		return this.cwd;
	}

	get configuration(): McpConfigurationCoordinator | undefined {
		return this.configurationCoordinator;
	}

	currentDefinitionRevision(scope: McpConfigurationScope, name: string, server: McpServerSettings): string {
		this.authStorage.reload();
		return mcpConfigurationRevision(
			scope,
			name,
			server,
			mcpCredentialState(this.authStorage, this.cwd, scope, name, server, this.environment),
		);
	}

	mutateConfiguration(
		scope: McpConfigurationScope,
		changes: readonly McpConfigurationChange[],
	): Promise<McpConfigurationResult> {
		if (!this.configurationCoordinator) {
			return Promise.reject(new Error("MCP configuration is not available in this process"));
		}
		return this.configurationCoordinator.mutate({
			settingsManager: this.settingsManager,
			cwd: this.cwd,
			scope,
			changes,
		});
	}

	async prepareConfigurationChanges(
		scope: "global" | "project",
		changes: ReadonlyMap<string, McpServerSettings | undefined>,
		credentialOverlay?: McpCredentialOverlay,
	): Promise<McpPreparedConfiguration> {
		await this.settingsManager.reload();
		const globalServers = { ...(this.settingsManager.getGlobalSettings().mcpServers ?? {}) };
		const projectServers = { ...(this.settingsManager.getProjectSettings().mcpServers ?? {}) };
		const target = scope === "global" ? globalServers : projectServers;
		for (const [name, definition] of changes) {
			if (definition) target[name] = structuredClone(definition);
			else delete target[name];
		}
		return this.prepareConfiguration(
			resolveMcpServerDefinitions(globalServers, projectServers, this.cwd, this.environment),
			credentialOverlay,
		);
	}

	async ensureCurrent(): Promise<void> {
		const refresh = this.refreshTail.then(async () => {
			await this.settingsManager.reload();
			this.authStorage.reload();
			const settings = resolveMcpSettings(this.settingsManager, this.cwd, this.environment);
			if (this.runtimeConfigurationRevision(settings) === this.activeRevision) return;
			const prepared = await this.prepareConfiguration(settings);
			this.activateConfiguration(prepared);
		});
		this.refreshTail = refresh.catch(() => undefined);
		await refresh;
	}

	drainCleanupErrors(): Error[] {
		return this.cleanupErrors.splice(0);
	}

	private async mutateCredential(
		name: string,
		credential: Extract<McpConfigurationChange["credential"], { action: "replace" | "remove" }>,
	): Promise<void> {
		await this.settingsManager.reload();
		const project = this.settingsManager.getProjectSettings().mcpServers?.[name];
		const user = this.settingsManager.getGlobalSettings().mcpServers?.[name];
		const scope = project ? "project" : "user";
		const current = project ?? user;
		if (!current) throw new Error(`Unknown MCP server "${name}"`);
		await this.mutateConfiguration(scope, [
			{
				name,
				expectedRevision: this.currentDefinitionRevision(scope, name, current),
				next: current,
				credential,
			},
		]);
	}

	setSecret(server: string, credential: Omit<McpSecretCredential, "type">): Promise<void> {
		return this.mutateCredential(server, {
			action: "replace",
			...(credential.bearerToken === undefined ? {} : { bearerToken: credential.bearerToken }),
			...(credential.env === undefined ? {} : { environment: credential.env }),
		});
	}

	logout(server: string): Promise<void> {
		return this.mutateCredential(server, { action: "remove" });
	}

	async restart(server?: string): Promise<void> {
		const clients = server ? [this.clientFor(server)] : [...this.clients.values()];
		await Promise.all(
			clients.map(async (client) => {
				await client.close();
				await client.start();
			}),
		);
		this.rebuildRecords();
		this.notifyCatalogListeners();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.unregisterCoordinator?.();
		this.unregisterCoordinator = undefined;
		for (const unsubscribe of this.clientUnsubscribers) unsubscribe();
		this.clientUnsubscribers = [];
		await Promise.all([
			...[...this.clients.values()].map((client) => client.close()),
			...[...this.retiredGenerations].map((generation) => this.closeRetiredGeneration(generation)),
			...[...this.preparedGenerations.values()].flatMap((generation) =>
				[...generation.clients.values()].map((client) => client.close()),
			),
		]);
		this.preparedGenerations.clear();
		this.catalogListeners.clear();
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		this.unregisterCoordinator?.();
		this.unregisterCoordinator = undefined;
		for (const unsubscribe of this.clientUnsubscribers) unsubscribe();
		this.clientUnsubscribers = [];
		for (const client of this.clients.values()) client.dispose();
		for (const generation of this.retiredGenerations) {
			for (const client of generation.clients.values()) client.dispose();
		}
		this.retiredGenerations.clear();
		for (const generation of this.preparedGenerations.values()) {
			for (const client of generation.clients.values()) client.dispose();
		}
		this.preparedGenerations.clear();
		this.catalogListeners.clear();
	}
}
