import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { type AuthStorage, type McpOAuthCredential, mcpCredentialKey } from "../auth-storage.ts";

export class ArcMindMcpOAuthProvider implements OAuthClientProvider {
	readonly clientMetadataUrl = undefined;
	readonly flowState: string;
	private readonly options: {
		serverName: string;
		redirectUrl: URL;
		authStorage: AuthStorage;
		onRedirect(url: URL): void;
		state?: string;
	};

	constructor(options: {
		serverName: string;
		redirectUrl: URL;
		authStorage: AuthStorage;
		onRedirect(url: URL): void;
		state?: string;
	}) {
		this.options = options;
		this.flowState = options.state ?? randomUUID();
	}

	get redirectUrl(): URL {
		return this.options.redirectUrl;
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			client_name: "ArcMind",
			redirect_uris: [String(this.redirectUrl)],
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}

	state(): string {
		return this.flowState;
	}

	private read(): McpOAuthCredential {
		const value = this.options.authStorage.get(mcpCredentialKey(this.options.serverName));
		return value?.type === "mcp_oauth" ? value : { type: "mcp_oauth" };
	}

	private write(patch: Partial<McpOAuthCredential>): void {
		this.options.authStorage.set(mcpCredentialKey(this.options.serverName), {
			...this.read(),
			...patch,
			type: "mcp_oauth",
		});
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		return this.read().clientInformation;
	}

	saveClientInformation(value: OAuthClientInformationMixed): void {
		this.write({ clientInformation: value });
	}

	tokens(): OAuthTokens | undefined {
		return this.read().tokens;
	}

	saveTokens(value: OAuthTokens): void {
		this.write({ tokens: value });
	}

	redirectToAuthorization(url: URL): void {
		this.options.onRedirect(url);
	}

	saveCodeVerifier(value: string): void {
		this.write({ codeVerifier: value });
	}

	codeVerifier(): string {
		const value = this.read().codeVerifier;
		if (!value) throw new Error(`No OAuth code verifier for MCP server "${this.options.serverName}"`);
		return value;
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		return this.read().discoveryState;
	}

	saveDiscoveryState(value: OAuthDiscoveryState): void {
		this.write({ discoveryState: value });
	}

	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
		if (scope === "all") {
			this.options.authStorage.remove(mcpCredentialKey(this.options.serverName));
			return;
		}
		const next = { ...this.read() };
		if (scope === "client") delete next.clientInformation;
		if (scope === "tokens") delete next.tokens;
		if (scope === "verifier") delete next.codeVerifier;
		if (scope === "discovery") delete next.discoveryState;
		this.options.authStorage.set(mcpCredentialKey(this.options.serverName), next);
	}
}

export interface McpOAuthCallback {
	redirectUrl: URL;
	waitForCode: Promise<string>;
	close(): Promise<void>;
}

export async function startMcpOAuthCallback(options: {
	state: string;
	port?: number;
	baseUrl?: URL;
}): Promise<McpOAuthCallback> {
	let resolveCode!: (code: string) => void;
	let rejectCode!: (error: Error) => void;
	let settled = false;
	const code = new Promise<string>((resolve, reject) => {
		resolveCode = resolve;
		rejectCode = reject;
	});
	const settle = (result: { code: string } | { error: Error }): void => {
		if (settled) return;
		settled = true;
		if ("code" in result) resolveCode(result.code);
		else rejectCode(result.error);
	};

	const callbackId = randomUUID();
	let server!: Server;
	let closed = false;
	server = createServer((request, response) => {
		const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
		if (!requestUrl.pathname.endsWith(`/${callbackId}`)) {
			response.writeHead(404).end("Not found");
			return;
		}

		const error = requestUrl.searchParams.get("error");
		const state = requestUrl.searchParams.get("state");
		const authorizationCode = requestUrl.searchParams.get("code");
		if (state !== options.state) {
			response.writeHead(400).end("OAuth state mismatch");
			settle({ error: new Error("OAuth state mismatch") });
		} else if (error) {
			response.writeHead(400).end("OAuth authorization failed");
			settle({ error: new Error(`OAuth authorization failed: ${error}`) });
		} else if (!authorizationCode) {
			response.writeHead(400).end("Missing authorization code");
			settle({ error: new Error("Missing OAuth authorization code") });
		} else {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end("<h1>ArcMind authorization complete</h1><p>You can close this window.</p>");
			settle({ code: authorizationCode });
		}
	});

	const localNames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
	const localCallback = !options.baseUrl || localNames.has(options.baseUrl.hostname);
	const basePort = options.baseUrl?.port ? Number(options.baseUrl.port) : undefined;
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port ?? basePort ?? 0, localCallback ? "127.0.0.1" : "0.0.0.0", resolve);
	});

	const address = server.address() as AddressInfo;
	const redirectUrl = options.baseUrl
		? new URL(options.baseUrl)
		: new URL(`http://127.0.0.1:${address.port}/mcp/oauth`);
	if (localCallback) redirectUrl.port = String(address.port);
	redirectUrl.pathname = `${redirectUrl.pathname.replace(/\/$/, "")}/${callbackId}`;

	const close = async (): Promise<void> => {
		if (closed) return;
		closed = true;
		if (!settled) settle({ error: new Error("OAuth callback closed") });
		await new Promise<void>((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()));
		});
	};

	return {
		redirectUrl,
		waitForCode: code.finally(close),
		close,
	};
}
