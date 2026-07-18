import { createHash } from "node:crypto";
import type {
	CallToolResult,
	GetPromptResult,
	ReadResourceResult,
	Tool,
	ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import { type AuthStorage, type McpSecretCredential, mcpCredentialKey } from "../auth-storage.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { type McpConnectionState, McpServerClient } from "./client.ts";
import { type ResolvedMcpServerConfig, type ResolvedMcpSettings, resolveMcpSettings } from "./config.ts";

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

function serverFingerprint(config: ResolvedMcpServerConfig): string {
	const identity =
		config.transport === "http"
			? ["http", config.url?.href]
			: ["stdio", config.command, config.args ?? [], config.cwd];
	return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

export class McpManager {
	private readonly settingsManager: SettingsManager;
	private readonly authStorage: AuthStorage;
	private readonly cwd: string;
	private readonly environment: NodeJS.ProcessEnv;
	private clients = new Map<string, McpServerClient>();
	private clientUnsubscribers: Array<() => void> = [];
	private records: McpToolRecord[] = [];
	private recordByModelName = new Map<string, McpToolRecord>();
	private searchIndex = new ToolSearchIndex([]);
	private readonly catalogListeners = new Set<() => void>();
	private closed = false;

	private constructor(options: McpManagerCreateOptions) {
		this.settingsManager = options.settingsManager;
		this.authStorage = options.authStorage;
		this.cwd = options.cwd;
		this.environment = options.environment ?? process.env;
	}

	static async create(options: McpManagerCreateOptions): Promise<McpManager> {
		const manager = new McpManager(options);
		await manager.initialize(resolveMcpSettings(options.settingsManager, options.cwd, options.environment));
		return manager;
	}

	private createClients(settings: ResolvedMcpSettings): Map<string, McpServerClient> {
		return new Map(
			settings.servers.map((config) => {
				const resolved = this.applyStoredCredential(config);
				return [resolved.name, new McpServerClient(resolved, this.authStorage)] as const;
			}),
		);
	}

	private storedSecret(config: ResolvedMcpServerConfig): McpSecretCredential | undefined {
		const credential = this.authStorage.get(mcpCredentialKey(config.name));
		return credential?.type === "mcp_secret" && credential.serverFingerprint === serverFingerprint(config)
			? credential
			: undefined;
	}

	private applyStoredCredential(config: ResolvedMcpServerConfig): ResolvedMcpServerConfig {
		const credential = this.storedSecret(config);
		if (!credential) return config;
		return {
			...config,
			bearerToken: credential.bearerToken ?? config.bearerToken,
			env: { ...(config.env ?? {}), ...(credential.env ?? {}) },
		};
	}

	private async startClients(clients: Map<string, McpServerClient>): Promise<void> {
		const enabled = [...clients.values()].filter((client) => client.resolvedConfig.enabled);
		const results = await Promise.allSettled(enabled.map((client) => client.start()));
		const requiredFailure = results.findIndex(
			(result, index) => result.status === "rejected" && enabled[index].resolvedConfig.required,
		);
		if (requiredFailure === -1) return;

		const failedClient = enabled[requiredFailure];
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
				for (const listener of this.catalogListeners) listener();
			}),
		);
	}

	private async initialize(settings: ResolvedMcpSettings): Promise<void> {
		const clients = this.createClients(settings);
		await this.startClients(clients);
		this.clients = clients;
		this.attachClientSubscriptions();
		this.rebuildRecords();
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
			return {
				serverName: config.name,
				rawName: tool.name,
				modelName,
				tool,
				sourceName: config.name,
				sourceDescription: snapshot.instructions,
				searchText: buildSearchText(modelName, config.name, tool, snapshot.instructions),
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

	callTool(modelName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
		const record = this.recordFor(modelName);
		return this.clientFor(record.serverName).callTool(record.rawName, args, signal);
	}

	getToolAnnotations(modelName: string): ToolAnnotations | undefined {
		return this.recordFor(modelName).tool.annotations;
	}

	private async aggregate(
		capability: "resources" | "prompts",
		operation: (client: McpServerClient) => Promise<object>,
	): Promise<{ servers: object[] }> {
		const clients = [...this.clients.values()].filter((client) => {
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
	}

	listResources(server?: string, cursor?: string): Promise<unknown> {
		if (cursor && !server) return Promise.reject(new Error("cursor can only be used when a server is specified"));
		if (server) return this.clientFor(server).listResources(cursor);
		return this.aggregate("resources", (client) => client.listResources());
	}

	listResourceTemplates(server?: string, cursor?: string): Promise<unknown> {
		if (cursor && !server) return Promise.reject(new Error("cursor can only be used when a server is specified"));
		if (server) return this.clientFor(server).listResourceTemplates(cursor);
		return this.aggregate("resources", (client) => client.listResourceTemplates());
	}

	readResource(server: string, uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
		return this.clientFor(server).readResource(uri, signal);
	}

	listPrompts(server?: string, cursor?: string): Promise<unknown> {
		if (cursor && !server) return Promise.reject(new Error("cursor can only be used when a server is specified"));
		if (server) return this.clientFor(server).listPrompts(cursor);
		return this.aggregate("prompts", (client) => client.listPrompts());
	}

	getPrompt(server: string, name: string, args?: Record<string, string>): Promise<GetPromptResult> {
		return this.clientFor(server).getPrompt(name, args);
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

	async reload(): Promise<void> {
		const settings = resolveMcpSettings(this.settingsManager, this.cwd, this.environment);
		const nextClients = this.createClients(settings);
		await this.startClients(nextClients);
		const previousClients = this.clients;
		this.clients = nextClients;
		this.attachClientSubscriptions();
		this.rebuildRecords();
		for (const listener of this.catalogListeners) listener();
		await Promise.all([...previousClients.values()].map((client) => client.close()));
	}

	async setSecret(server: string, credential: Omit<McpSecretCredential, "type">): Promise<void> {
		const client = this.clientFor(server);
		const environment = Object.entries(credential.env ?? {});
		if (credential.bearerToken === "" || environment.some(([name, value]) => !name || !value)) {
			throw new Error("MCP secret names and values must not be empty");
		}
		if (!credential.bearerToken && environment.length === 0) {
			throw new Error("MCP secret must contain a bearer token or environment value");
		}
		const key = mcpCredentialKey(server);
		const previous = this.authStorage.get(key);
		this.authStorage.set(key, {
			type: "mcp_secret",
			...credential,
			serverFingerprint: serverFingerprint(client.resolvedConfig),
		});
		try {
			await this.reload();
		} catch (error) {
			if (previous) this.authStorage.set(key, previous);
			else this.authStorage.remove(key);
			throw error;
		}
	}

	deleteCredential(server: string): void {
		this.authStorage.remove(mcpCredentialKey(server));
	}

	async logout(server: string): Promise<void> {
		this.clientFor(server);
		const key = mcpCredentialKey(server);
		const previous = this.authStorage.get(key);
		this.authStorage.remove(key);
		try {
			await this.reload();
		} catch (error) {
			if (previous) this.authStorage.set(key, previous);
			throw error;
		}
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
		for (const listener of this.catalogListeners) listener();
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		for (const unsubscribe of this.clientUnsubscribers) unsubscribe();
		this.clientUnsubscribers = [];
		await Promise.all([...this.clients.values()].map((client) => client.close()));
		this.catalogListeners.clear();
	}

	dispose(): void {
		if (this.closed) return;
		this.closed = true;
		for (const unsubscribe of this.clientUnsubscribers) unsubscribe();
		this.clientUnsubscribers = [];
		for (const client of this.clients.values()) client.dispose();
		this.catalogListeners.clear();
	}
}
