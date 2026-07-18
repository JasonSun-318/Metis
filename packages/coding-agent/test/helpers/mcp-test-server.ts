import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
	CallToolRequestSchema,
	GetPromptRequestSchema,
	ListPromptsRequestSchema,
	ListResourcesRequestSchema,
	ListResourceTemplatesRequestSchema,
	ListToolsRequestSchema,
	ReadResourceRequestSchema,
	type Tool,
} from "@modelcontextprotocol/sdk/types.js";

export interface McpTestServerOptions {
	tools?: Tool[];
	instructions?: string;
	pageSize?: number;
	closeDuringTool?: boolean;
	callDelayMs?: number;
	requiredBearerToken?: string;
	advertiseOAuth?: boolean;
}

export interface McpTestServer {
	url: URL;
	server: Server;
	setTools(names: string[]): Promise<void>;
	setResources(uris: string[]): Promise<void>;
	setPrompts(names: string[]): Promise<void>;
	toolCallCount(): number;
	lastToolCallName(): string | undefined;
	close(): Promise<void>;
}

function page<T>(items: T[], cursor?: string, pageSize = items.length || 1): { items: T[]; nextCursor?: string } {
	const offset = cursor ? Number(cursor) : 0;
	const next = offset + pageSize;
	return {
		items: items.slice(offset, next),
		nextCursor: next < items.length ? String(next) : undefined,
	};
}

export async function createMcpTestServer(options: McpTestServerOptions = {}): Promise<McpTestServer> {
	const server = new Server(
		{ name: "arcmind-mcp-test", version: "1.0.0" },
		{
			capabilities: {
				tools: { listChanged: true },
				resources: { listChanged: true },
				prompts: { listChanged: true },
			},
			instructions: options.instructions ?? "Use docs before guessing.",
		},
	);
	let toolCalls = 0;
	let lastToolCall: string | undefined;
	let currentTools: Tool[] = options.tools ?? [
		{
			name: "search_docs",
			title: "Search docs",
			description: "Search product documentation",
			inputSchema: {
				type: "object",
				properties: { query: { type: "string" } },
				required: ["query"],
				additionalProperties: false,
			},
			annotations: { readOnlyHint: true },
		},
	];
	let currentResources = [{ uri: "docs://guide", name: "Guide", mimeType: "text/plain" }];
	let currentPrompts = [
		{
			name: "review",
			description: "Review a change",
			arguments: [{ name: "target", required: true }],
		},
	];

	server.setRequestHandler(ListToolsRequestSchema, ({ params }) => {
		const result = page(currentTools, params?.cursor, options.pageSize);
		return { tools: result.items, nextCursor: result.nextCursor };
	});
	server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
		toolCalls += 1;
		lastToolCall = params.name;
		if (options.closeDuringTool) {
			void transport.close();
			throw new Error("test transport closed during tool call");
		}
		if (options.callDelayMs) {
			await new Promise((resolve) => setTimeout(resolve, options.callDelayMs));
		}
		return { content: [{ type: "text" as const, text: `match:${String(params.arguments?.query ?? "")}` }] };
	});
	server.setRequestHandler(ListResourcesRequestSchema, () => ({ resources: currentResources }));
	server.setRequestHandler(ListResourceTemplatesRequestSchema, () => ({ resourceTemplates: [] }));
	server.setRequestHandler(ReadResourceRequestSchema, () => ({
		contents: [{ uri: "docs://guide", mimeType: "text/plain", text: "guide body" }],
	}));
	server.setRequestHandler(ListPromptsRequestSchema, () => ({ prompts: currentPrompts }));
	server.setRequestHandler(GetPromptRequestSchema, ({ params }) => ({
		messages: [
			{
				role: "user" as const,
				content: { type: "text" as const, text: `Review ${params.arguments?.target ?? ""}` },
			},
		],
	}));

	const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
	await server.connect(transport);
	const httpServer = createServer(async (request, response) => {
		try {
			const origin = `http://${request.headers.host}`;
			const requestUrl = new URL(request.url ?? "/", origin);
			if (
				options.advertiseOAuth &&
				(requestUrl.pathname === "/.well-known/oauth-protected-resource" ||
					requestUrl.pathname === "/.well-known/oauth-protected-resource/mcp")
			) {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(JSON.stringify({ resource: `${origin}/mcp`, authorization_servers: [origin] }));
				return;
			}
			if (options.advertiseOAuth && requestUrl.pathname === "/.well-known/oauth-authorization-server") {
				response.writeHead(200, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						issuer: origin,
						authorization_endpoint: `${origin}/authorize`,
						token_endpoint: `${origin}/token`,
						response_types_supported: ["code"],
						code_challenge_methods_supported: ["S256"],
					}),
				);
				return;
			}
			if (options.requiredBearerToken && request.headers.authorization !== `Bearer ${options.requiredBearerToken}`) {
				const challenge = options.advertiseOAuth
					? `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`
					: "Bearer";
				response.writeHead(401, { "www-authenticate": challenge }).end("Unauthorized");
				return;
			}
			await transport.handleRequest(request, response);
		} catch (error) {
			if (!response.headersSent) response.writeHead(500);
			response.end(error instanceof Error ? error.message : String(error));
		}
	});
	await new Promise<void>((resolve, reject) => {
		httpServer.once("error", reject);
		httpServer.listen(0, "127.0.0.1", resolve);
	});
	const address = httpServer.address() as AddressInfo;

	return {
		url: new URL(`http://127.0.0.1:${address.port}/mcp`),
		server,
		async setTools(names) {
			currentTools = names.map((name) => ({
				name,
				description: `The ${name} tool`,
				inputSchema: { type: "object", properties: {}, additionalProperties: false },
			}));
			await server.sendToolListChanged();
		},
		async setResources(uris) {
			currentResources = uris.map((uri) => ({ uri, name: uri, mimeType: "text/plain" }));
			await server.sendResourceListChanged();
		},
		async setPrompts(names) {
			currentPrompts = names.map((name) => ({ name, description: `The ${name} prompt`, arguments: [] }));
			await server.sendPromptListChanged();
		},
		toolCallCount: () => toolCalls,
		lastToolCallName: () => lastToolCall,
		async close() {
			await server.close().catch(() => undefined);
			await new Promise<void>((resolve) => httpServer.close(() => resolve()));
		},
	};
}
