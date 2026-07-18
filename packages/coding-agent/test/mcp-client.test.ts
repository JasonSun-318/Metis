import { fileURLToPath } from "node:url";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { McpServerClient, type ResolvedMcpServerConfig } from "../src/core/mcp/index.ts";
import { createMcpTestServer, type McpTestServer } from "./helpers/mcp-test-server.ts";

function httpConfig(url: URL, overrides: Partial<ResolvedMcpServerConfig> = {}): ResolvedMcpServerConfig {
	return {
		name: "docs",
		transport: "http",
		enabled: true,
		required: false,
		startupTimeoutMs: 10_000,
		toolTimeoutMs: 60_000,
		enabledTools: undefined,
		disabledTools: [],
		url,
		httpHeaders: {},
		...overrides,
	};
}

function stdioFixtureConfig(): ResolvedMcpServerConfig {
	return {
		name: "fixture",
		transport: "stdio",
		enabled: true,
		required: true,
		startupTimeoutMs: 10_000,
		toolTimeoutMs: 60_000,
		enabledTools: undefined,
		disabledTools: [],
		command: process.execPath,
		args: [fileURLToPath(new URL("./fixtures/mcp-stdio-server.mjs", import.meta.url))],
		env: {},
		cwd: process.cwd(),
	};
}

const clients: McpServerClient[] = [];
const servers: McpTestServer[] = [];

afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.close()));
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("McpServerClient", () => {
	it("initializes HTTP and collects every catalog page", async () => {
		const tools: Tool[] = ["search_docs", "read_docs"].map((name) => ({
			name,
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
		}));
		const testServer = await createMcpTestServer({ tools, pageSize: 1 });
		servers.push(testServer);
		const client = new McpServerClient(httpConfig(testServer.url), AuthStorage.inMemory());
		clients.push(client);

		await client.start();

		expect(client.snapshot()).toMatchObject({
			serverName: "docs",
			serverInfo: { name: "arcmind-mcp-test", version: "1.0.0" },
			instructions: "Use docs before guessing.",
			tools: [{ name: "search_docs" }, { name: "read_docs" }],
			resources: [{ uri: "docs://guide" }],
			prompts: [{ name: "review" }],
		});
		expect(client.status().state).toBe("connected");
	});

	it("spawns and closes a stdio server", async () => {
		const client = new McpServerClient(stdioFixtureConfig(), AuthStorage.inMemory());
		clients.push(client);

		await client.start();

		expect(client.snapshot().tools.map((tool) => tool.name)).toContain("echo");
		await client.close();
		expect(client.status().state).toBe("closed");
	});

	it("reconnects with bounded backoff after a stdio transport closes", async () => {
		const client = new McpServerClient(stdioFixtureConfig(), AuthStorage.inMemory());
		clients.push(client);
		await client.start();
		const states: string[] = [];
		client.subscribeStatus(() => states.push(client.status().state));

		await expect(client.callTool("crash", {})).rejects.toThrow();

		await vi.waitFor(() => expect(states).toContain("reconnecting"));
		await vi.waitFor(() => expect(client.status().state).toBe("connected"), { timeout: 5_000 });
	});

	it("refreshes after tools/list_changed", async () => {
		const testServer = await createMcpTestServer();
		servers.push(testServer);
		const client = new McpServerClient(httpConfig(testServer.url), AuthStorage.inMemory());
		clients.push(client);
		await client.start();
		const changed = vi.fn();
		client.subscribeCatalog(changed);

		await testServer.setTools(["new_tool"]);

		await vi.waitFor(() => expect(client.snapshot().tools.map((tool) => tool.name)).toEqual(["new_tool"]));
		expect(changed).toHaveBeenCalled();
	});

	it("refreshes after resources/list_changed and prompts/list_changed", async () => {
		const testServer = await createMcpTestServer();
		servers.push(testServer);
		const client = new McpServerClient(httpConfig(testServer.url), AuthStorage.inMemory());
		clients.push(client);
		await client.start();

		await testServer.setResources(["docs://new"]);
		await testServer.setPrompts(["new_prompt"]);

		await vi.waitFor(() =>
			expect(client.snapshot().resources.map((resource) => resource.uri)).toEqual(["docs://new"]),
		);
		await vi.waitFor(() => expect(client.snapshot().prompts.map((prompt) => prompt.name)).toEqual(["new_prompt"]));
	});

	it("applies the configured request timeout", async () => {
		const testServer = await createMcpTestServer({ callDelayMs: 100 });
		servers.push(testServer);
		const client = new McpServerClient(httpConfig(testServer.url, { toolTimeoutMs: 20 }), AuthStorage.inMemory());
		clients.push(client);
		await client.start();

		await expect(client.callTool("search_docs", { query: "x" })).rejects.toThrow();
		expect(testServer.toolCallCount()).toBe(1);
	});

	it("does not replay a tool call after transport failure", async () => {
		const testServer = await createMcpTestServer({ closeDuringTool: true });
		servers.push(testServer);
		const client = new McpServerClient(httpConfig(testServer.url, { toolTimeoutMs: 100 }), AuthStorage.inMemory());
		clients.push(client);
		await client.start();

		await expect(client.callTool("search_docs", { query: "x" })).rejects.toThrow();
		expect(testServer.toolCallCount()).toBe(1);
	});
});
