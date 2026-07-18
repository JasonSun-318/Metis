import { randomUUID } from "node:crypto";
import { discoverOAuthServerInfo, UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
	StreamableHTTPClientTransport,
	StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
	type CallToolResult,
	CallToolResultSchema,
	type GetPromptResult,
	type ListPromptsResult,
	type ListResourcesResult,
	type ListResourceTemplatesResult,
	type Prompt,
	type ReadResourceResult,
	type Resource,
	type ResourceTemplate,
	type ServerCapabilities,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { VERSION } from "../../config.ts";
import { type AuthStorage, mcpCredentialKey } from "../auth-storage.ts";
import type { ResolvedMcpServerConfig } from "./config.ts";
import { ArcMindMcpOAuthProvider, startMcpOAuthCallback } from "./oauth.ts";

const MAX_CATALOG_ITEMS = 10_000;
const RECONNECT_DELAYS_MS = [250, 1_000, 4_000, 10_000] as const;

export type McpConnectionState =
	| "disabled"
	| "connecting"
	| "connected"
	| "auth_required"
	| "reconnecting"
	| "error"
	| "closed";

export type McpAuthRequirement = "oauth" | "token";

export interface McpCatalogSnapshot {
	serverName: string;
	serverInfo?: { name: string; version: string };
	capabilities: ServerCapabilities;
	instructions?: string;
	tools: Tool[];
	resources: Resource[];
	resourceTemplates: ResourceTemplate[];
	prompts: Prompt[];
}

export interface McpServerClientStatus {
	state: McpConnectionState;
	lastError?: string;
	authRequirement?: McpAuthRequirement;
}

export interface McpLoginCallbacks {
	signal?: AbortSignal;
	onAuthorize(url: URL): void;
}

export interface McpOAuthCallbackSettings {
	port?: number;
	baseUrl?: URL;
}

type McpTransport = StdioClientTransport | StreamableHTTPClientTransport;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("Login cancelled", "AbortError");
}

async function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	if (signal.aborted) throw abortReason(signal);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(abortReason(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

export class McpServerClient {
	private config: ResolvedMcpServerConfig;
	private readonly authStorage: AuthStorage;
	private client?: Client;
	private transport?: McpTransport;
	private connectionState: McpConnectionState;
	private lastError?: string;
	private authRequirement?: McpAuthRequirement;
	private catalog: McpCatalogSnapshot;
	private readonly catalogListeners = new Set<() => void>();
	private readonly statusListeners = new Set<() => void>();
	private reconnectTimer?: NodeJS.Timeout;
	private reconnectAttempt = 0;
	private intentionallyClosing = false;
	private disposed = false;
	private startPromise?: Promise<void>;

	constructor(config: ResolvedMcpServerConfig, authStorage: AuthStorage) {
		this.config = config;
		this.authStorage = authStorage;
		this.connectionState = config.enabled ? "closed" : "disabled";
		this.catalog = {
			serverName: config.name,
			capabilities: {},
			tools: [],
			resources: [],
			resourceTemplates: [],
			prompts: [],
		};
	}

	get name(): string {
		return this.config.name;
	}

	get resolvedConfig(): ResolvedMcpServerConfig {
		return this.config;
	}

	snapshot(): McpCatalogSnapshot {
		return structuredClone(this.catalog);
	}

	status(): McpServerClientStatus {
		return { state: this.connectionState, lastError: this.lastError, authRequirement: this.authRequirement };
	}

	subscribeCatalog(listener: () => void): () => void {
		this.catalogListeners.add(listener);
		return () => this.catalogListeners.delete(listener);
	}

	subscribeStatus(listener: () => void): () => void {
		this.statusListeners.add(listener);
		return () => this.statusListeners.delete(listener);
	}

	private credentialValues(): string[] {
		const values = [this.config.bearerToken, ...Object.values(this.config.env ?? {})];
		const credential = this.authStorage.get(mcpCredentialKey(this.config.name));
		if (credential?.type === "mcp_oauth") {
			values.push(credential.tokens?.access_token, credential.tokens?.refresh_token);
		}
		return values.filter((value): value is string => Boolean(value));
	}

	private safeErrorMessage(error: unknown): string {
		let message = errorMessage(error);
		for (const value of this.credentialValues()) message = message.replaceAll(value, "[REDACTED]");
		return message;
	}

	private setState(state: McpConnectionState, error?: unknown): void {
		this.connectionState = state;
		if (state !== "auth_required") this.authRequirement = undefined;
		if (error !== undefined) this.lastError = this.safeErrorMessage(error);
		else if (state === "connected") this.lastError = undefined;
		for (const listener of this.statusListeners) listener();
	}

	private emitCatalog(): void {
		for (const listener of this.catalogListeners) listener();
	}

	private createClient(): Client {
		return new Client(
			{ name: "arcmind", version: VERSION },
			{
				capabilities: {},
				listChanged: {
					tools: {
						autoRefresh: false,
						debounceMs: 100,
						onChanged: (error) => {
							if (error) this.setState(this.connectionState, error);
							else
								void this.refreshTools().catch((refreshError) =>
									this.setState(this.connectionState, refreshError),
								);
						},
					},
					resources: {
						autoRefresh: false,
						debounceMs: 100,
						onChanged: (error) => {
							if (error) this.setState(this.connectionState, error);
							else
								void this.refreshResources().catch((refreshError) =>
									this.setState(this.connectionState, refreshError),
								);
						},
					},
					prompts: {
						autoRefresh: false,
						debounceMs: 100,
						onChanged: (error) => {
							if (error) this.setState(this.connectionState, error);
							else
								void this.refreshPrompts().catch((refreshError) =>
									this.setState(this.connectionState, refreshError),
								);
						},
					},
				},
			},
		);
	}

	private oauthProvider(redirectUrl: URL, onRedirect: (url: URL) => void, state?: string): ArcMindMcpOAuthProvider {
		return new ArcMindMcpOAuthProvider({
			serverName: this.config.name,
			redirectUrl,
			authStorage: this.authStorage,
			onRedirect,
			state,
		});
	}

	private createTransport(options: { oauthProvider?: ArcMindMcpOAuthProvider } = {}): McpTransport {
		if (this.config.transport === "stdio") {
			const transport = new StdioClientTransport({
				command: this.config.command!,
				args: this.config.args,
				env: { ...getDefaultEnvironment(), ...this.config.env },
				cwd: this.config.cwd,
				stderr: "pipe",
			});
			transport.stderr?.on("data", () => undefined);
			return transport;
		}

		const headers = {
			...this.config.httpHeaders,
			...(this.config.bearerToken ? { Authorization: `Bearer ${this.config.bearerToken}` } : {}),
		};
		return new StreamableHTTPClientTransport(this.config.url!, {
			authProvider: options.oauthProvider,
			requestInit: { headers },
		});
	}

	private startupOAuthProvider(): ArcMindMcpOAuthProvider | undefined {
		if (this.config.transport !== "http") return undefined;
		if (this.authStorage.get(mcpCredentialKey(this.config.name))?.type !== "mcp_oauth") return undefined;
		return this.oauthProvider(new URL("http://127.0.0.1/mcp/oauth"), () => {
			this.setState("auth_required", "MCP OAuth authorization required");
		});
	}

	private async detectAuthRequirement(): Promise<McpAuthRequirement> {
		if (this.config.transport !== "http") return "token";
		if (this.authStorage.get(mcpCredentialKey(this.config.name))?.type === "mcp_oauth") return "oauth";
		try {
			const discovered = await discoverOAuthServerInfo(this.config.url!, {
				fetchFn: (input, init) =>
					fetch(input, { ...init, signal: AbortSignal.timeout(this.config.startupTimeoutMs) }),
			});
			return discovered.authorizationServerMetadata?.authorization_endpoint ||
				discovered.resourceMetadata?.authorization_servers?.length
				? "oauth"
				: "token";
		} catch {
			return "token";
		}
	}

	private async collectPages<T>(
		fetchPage: (cursor?: string) => Promise<{ items: T[]; nextCursor?: string }>,
	): Promise<T[]> {
		const items: T[] = [];
		const seenCursors = new Set<string>();
		let cursor: string | undefined;
		let pages = 0;
		do {
			pages += 1;
			if (pages > MAX_CATALOG_ITEMS) {
				throw new Error(`MCP server "${this.config.name}" catalog pagination exceeds ${MAX_CATALOG_ITEMS} pages`);
			}
			const page = await fetchPage(cursor);
			items.push(...page.items);
			if (items.length > MAX_CATALOG_ITEMS) {
				throw new Error(`MCP server "${this.config.name}" catalog exceeds ${MAX_CATALOG_ITEMS} items`);
			}
			cursor = page.nextCursor;
			if (cursor && seenCursors.has(cursor)) {
				throw new Error(`MCP server "${this.config.name}" repeated catalog cursor "${cursor}"`);
			}
			if (cursor) seenCursors.add(cursor);
		} while (cursor);
		return items;
	}

	private requestOptions(signal?: AbortSignal): { signal?: AbortSignal; timeout: number } {
		return { signal, timeout: this.config.toolTimeoutMs };
	}

	private startupRequestOptions(): { timeout: number } {
		return { timeout: this.config.startupTimeoutMs };
	}

	private requireClient(): Client {
		if (!this.client) {
			throw new Error(`MCP server "${this.config.name}" is not connected`);
		}
		return this.client;
	}

	private async refreshTools(): Promise<void> {
		const client = this.requireClient();
		if (!client.getServerCapabilities()?.tools) return;
		const tools = await this.collectPages(async (cursor) => {
			const result = await client.listTools(cursor ? { cursor } : undefined, this.startupRequestOptions());
			return { items: result.tools, nextCursor: result.nextCursor };
		});
		this.catalog = { ...this.catalog, tools };
		this.emitCatalog();
	}

	private async refreshResources(): Promise<void> {
		const client = this.requireClient();
		if (!client.getServerCapabilities()?.resources) return;
		const [resources, resourceTemplates] = await Promise.all([
			this.collectPages(async (cursor) => {
				const result = await client.listResources(cursor ? { cursor } : undefined, this.startupRequestOptions());
				return { items: result.resources, nextCursor: result.nextCursor };
			}),
			this.collectPages(async (cursor) => {
				const result = await client.listResourceTemplates(
					cursor ? { cursor } : undefined,
					this.startupRequestOptions(),
				);
				return { items: result.resourceTemplates, nextCursor: result.nextCursor };
			}),
		]);
		this.catalog = { ...this.catalog, resources, resourceTemplates };
		this.emitCatalog();
	}

	private async refreshPrompts(): Promise<void> {
		const client = this.requireClient();
		if (!client.getServerCapabilities()?.prompts) return;
		const prompts = await this.collectPages(async (cursor) => {
			const result = await client.listPrompts(cursor ? { cursor } : undefined, this.startupRequestOptions());
			return { items: result.prompts, nextCursor: result.nextCursor };
		});
		this.catalog = { ...this.catalog, prompts };
		this.emitCatalog();
	}

	private async loadCatalog(client: Client): Promise<void> {
		const serverInfo = client.getServerVersion();
		this.catalog = {
			serverName: this.config.name,
			serverInfo: serverInfo ? { name: serverInfo.name, version: serverInfo.version } : undefined,
			capabilities: client.getServerCapabilities() ?? {},
			instructions: client.getInstructions(),
			tools: [],
			resources: [],
			resourceTemplates: [],
			prompts: [],
		};
		await Promise.all([this.refreshTools(), this.refreshResources(), this.refreshPrompts()]);
	}

	private attachConnection(client: Client, transport: McpTransport): void {
		this.client = client;
		this.transport = transport;
		client.onclose = () => {
			if (this.client !== client) return;
			this.client = undefined;
			this.transport = undefined;
			if (!this.intentionallyClosing && !this.disposed) this.scheduleReconnect("MCP transport closed");
		};
		client.onerror = (error) => {
			if (this.client === client) this.lastError = this.safeErrorMessage(error);
		};
	}

	private async startOnce(): Promise<void> {
		if (!this.config.enabled) {
			this.setState("disabled");
			return;
		}
		if (this.disposed) throw new Error(`MCP server "${this.config.name}" is closed`);
		this.intentionallyClosing = false;
		this.setState(this.reconnectAttempt > 0 ? "reconnecting" : "connecting");

		const client = this.createClient();
		const transport = this.createTransport({ oauthProvider: this.startupOAuthProvider() });
		this.attachConnection(client, transport);
		try {
			await client.connect(transport, this.startupRequestOptions());
			await this.loadCatalog(client);
			this.reconnectAttempt = 0;
			this.setState("connected");
		} catch (error) {
			client.onclose = undefined;
			if (this.client === client) {
				this.client = undefined;
				this.transport = undefined;
			}
			await client.close().catch(() => undefined);
			if (this.intentionallyClosing || this.disposed) {
				this.setState("closed");
			} else if (
				error instanceof UnauthorizedError ||
				(error instanceof StreamableHTTPError && error.code === 401)
			) {
				this.authRequirement = await this.detectAuthRequirement();
				this.setState("auth_required", "Authentication required");
			} else {
				this.setState("error", error);
				this.scheduleReconnect(error);
			}
			throw error;
		}
	}

	start(): Promise<void> {
		if (this.client && this.connectionState === "connected") return Promise.resolve();
		if (this.startPromise) return this.startPromise;
		this.startPromise = this.startOnce().finally(() => {
			this.startPromise = undefined;
		});
		return this.startPromise;
	}

	private scheduleReconnect(error: unknown): void {
		if (this.reconnectTimer || this.intentionallyClosing || this.disposed || !this.config.enabled) return;
		this.lastError = this.safeErrorMessage(error);
		this.setState("reconnecting");
		const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
		this.reconnectAttempt += 1;
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = undefined;
			void this.start().catch(() => undefined);
		}, delay);
		this.reconnectTimer.unref?.();
	}

	async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<CallToolResult> {
		const client = this.requireClient();
		const result = await client.callTool(
			{ name, arguments: args },
			CallToolResultSchema,
			this.requestOptions(signal),
		);
		return CallToolResultSchema.parse(result);
	}

	listResources(cursor?: string, signal?: AbortSignal): Promise<ListResourcesResult> {
		return this.requireClient().listResources(cursor ? { cursor } : undefined, this.requestOptions(signal));
	}

	listResourceTemplates(cursor?: string, signal?: AbortSignal): Promise<ListResourceTemplatesResult> {
		return this.requireClient().listResourceTemplates(cursor ? { cursor } : undefined, this.requestOptions(signal));
	}

	readResource(uri: string, signal?: AbortSignal): Promise<ReadResourceResult> {
		return this.requireClient().readResource({ uri }, this.requestOptions(signal));
	}

	listPrompts(cursor?: string, signal?: AbortSignal): Promise<ListPromptsResult> {
		return this.requireClient().listPrompts(cursor ? { cursor } : undefined, this.requestOptions(signal));
	}

	getPrompt(name: string, args?: Record<string, string>, signal?: AbortSignal): Promise<GetPromptResult> {
		return this.requireClient().getPrompt({ name, arguments: args }, this.requestOptions(signal));
	}

	async login(callbacks: McpLoginCallbacks, callbackSettings: McpOAuthCallbackSettings = {}): Promise<void> {
		if (this.config.transport !== "http") {
			throw new Error(`MCP server "${this.config.name}" does not support OAuth over stdio`);
		}
		callbacks.signal?.throwIfAborted();
		const state = randomUUID();
		const callback = await startMcpOAuthCallback({ state, ...callbackSettings });
		const codePromise = callback.waitForCode;
		void codePromise.catch(() => undefined);
		const provider = this.oauthProvider(callback.redirectUrl, callbacks.onAuthorize, state);
		const transport = this.createTransport({ oauthProvider: provider }) as StreamableHTTPClientTransport;
		const client = this.createClient();

		try {
			await client.connect(transport, this.startupRequestOptions());
			await this.replaceConnection(client, transport);
			await callback.close();
			return;
		} catch (error) {
			if (!(error instanceof UnauthorizedError)) throw error;
			const authorizationCode = await withAbort(codePromise, callbacks.signal);
			await transport.finishAuth(authorizationCode);
			await client.close().catch(() => undefined);
			await this.closeConnection();
			await this.start();
		} finally {
			await callback.close().catch(() => undefined);
			if (this.client !== client) await client.close().catch(() => undefined);
		}
	}

	private async replaceConnection(client: Client, transport: McpTransport): Promise<void> {
		await this.closeConnection();
		this.attachConnection(client, transport);
		await this.loadCatalog(client);
		this.reconnectAttempt = 0;
		this.setState("connected");
	}

	private async closeConnection(): Promise<void> {
		const client = this.client;
		this.client = undefined;
		this.transport = undefined;
		if (!client) return;
		client.onclose = undefined;
		await client.close().catch(() => undefined);
	}

	async close(): Promise<void> {
		this.intentionallyClosing = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		await this.closeConnection();
		this.setState(this.config.enabled ? "closed" : "disabled");
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.intentionallyClosing = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = undefined;
		void this.closeConnection();
		this.setState("closed");
	}
}
