import { fauxAssistantMessage, fauxToolCall } from "@metis/ai";
import { getModel } from "@metis/ai/compat";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { McpManager } from "../src/core/mcp/index.ts";
import type { PermissionApprovalRequest } from "../src/core/permission-policy.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createMcpTestServer, type McpTestServer } from "./helpers/mcp-test-server.ts";
import { createHarness, type Harness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

const servers: McpTestServer[] = [];
const harnesses: Harness[] = [];

async function setup(tools?: Tool[], permissionPreset?: "full" | "ask") {
	const server = await createMcpTestServer({ tools });
	servers.push(server);
	const manager = await McpManager.create({
		settingsManager: SettingsManager.inMemory({ mcpServers: { docs: { url: String(server.url) } } }),
		authStorage: AuthStorage.inMemory(),
		cwd: process.cwd(),
	});
	const harness = await createHarness({ mcpManager: manager, permissionPreset });
	harnesses.push(harness);
	return { server, manager, harness };
}

afterEach(async () => {
	await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
	await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("MCP agent loop", () => {
	it("keeps direct MCP tools out of Plan mode even when their runtime source is builtin", async () => {
		const { harness } = await setup();

		const planSource = (
			harness.session as unknown as { _planToolSource(name: string): "builtin" | "mcp" | undefined }
		)._planToolSource("tool_search");
		expect(planSource).toBe("mcp");
		await harness.session.setCollaborationMode("plan");
		expect(harness.session.getActiveToolNames()).not.toContain("tool_search");
	});

	it("searches, exposes the full schema on the next call, invokes raw MCP, and persists the load marker", async () => {
		const { server, harness } = await setup();
		const providerTools: string[][] = [];
		harness.setResponses([
			(context) => {
				providerTools.push((context.tools ?? []).map((tool) => tool.name));
				return fauxAssistantMessage(fauxToolCall("tool_search", { query: "product documentation" }), {
					stopReason: "toolUse",
				});
			},
			(context) => {
				providerTools.push((context.tools ?? []).map((tool) => tool.name));
				const loaded = context.tools?.find((tool) => tool.name === "mcp__docs__search_docs");
				expect(loaded?.parameters).toMatchObject({ properties: { query: { type: "string" } } });
				return fauxAssistantMessage(fauxToolCall("mcp__docs__search_docs", { query: "cache" }), {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Find the cache documentation");

		expect(providerTools[0]).toContain("tool_search");
		expect(providerTools[0]).not.toContain("mcp__docs__search_docs");
		expect(providerTools[1]).toContain("mcp__docs__search_docs");
		expect(
			harness.session.messages
				.filter((message) => message.role === "toolResult")
				.flatMap((message) => message.addedToolNames ?? []),
		).toContain("mcp__docs__search_docs");
		expect(server.toolCallCount()).toBe(1);
		expect(server.lastToolCallName()).toBe("search_docs");
	});

	it("removes stale catalog definitions while leaving new MCP tools deferred", async () => {
		const { server, manager, harness } = await setup();
		expect(harness.session.getAllTools().map((tool) => tool.name)).toContain("mcp__docs__search_docs");

		await server.setTools(["new_docs_tool"]);
		await vi.waitFor(() =>
			expect(harness.session.getAllTools().map((tool) => tool.name)).toContain("mcp__docs__new_docs_tool"),
		);

		expect(harness.session.getAllTools().map((tool) => tool.name)).not.toContain("mcp__docs__search_docs");
		expect(harness.session.getActiveToolNames()).not.toContain("mcp__docs__new_docs_tool");
		expect(manager.searchTools("new docs")[0]?.modelName).toBe("mcp__docs__new_docs_tool");
	});

	it("restores only current durable load markers after compaction", async () => {
		const server = await createMcpTestServer();
		servers.push(server);
		const settingsManager = SettingsManager.inMemory({
			mcpServers: { docs: { url: String(server.url) } },
		});
		const manager = await McpManager.create({
			settingsManager,
			authStorage: AuthStorage.inMemory(),
			cwd: process.cwd(),
		});
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "search-call",
			toolName: "tool_search",
			content: [{ type: "text", text: "loaded" }],
			addedToolNames: ["mcp__docs__search_docs", "mcp__docs__removed"],
			isError: false,
			timestamp: Date.now(),
		});
		const firstKeptEntryId = sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "continue" }],
			timestamp: Date.now(),
		});
		sessionManager.appendCompaction("Earlier tools were loaded.", firstKeptEntryId, 100);

		const { session } = await createAgentSession({
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager,
			resourceLoader: createTestResourceLoader(),
			mcpManager: manager,
		});
		try {
			expect(session.messages.some((message) => message.role === "toolResult")).toBe(false);
			expect(session.getActiveToolNames()).toContain("mcp__docs__search_docs");
			expect(session.getActiveToolNames()).not.toContain("mcp__docs__removed");
			expect(
				session.agent.state.tools.find((tool) => tool.name === "mcp__docs__search_docs")?.parameters,
			).toMatchObject({ properties: { query: { type: "string" } } });
		} finally {
			session.dispose();
		}
	});

	it("denies an incompletely annotated destructive MCP tool before approval or execution", async () => {
		const requestPermissionApproval = vi.fn(async (_request: PermissionApprovalRequest) => ({
			decision: "allow" as const,
			reason: "test approval",
		}));
		const destructive: Tool = {
			name: "destructive_tool",
			description: "Delete remote data",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
			annotations: { destructiveHint: true },
		};
		const server = await createMcpTestServer({ tools: [destructive] });
		servers.push(server);
		const manager = await McpManager.create({
			settingsManager: SettingsManager.inMemory({ mcpServers: { docs: { url: String(server.url) } } }),
			authStorage: AuthStorage.inMemory(),
			cwd: process.cwd(),
		});
		const harness = await createHarness({
			mcpManager: manager,
			permissionPreset: "ask",
			requestPermissionApproval,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("tool_search", { query: "delete remote data" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("mcp__docs__destructive_tool", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Delete it");

		expect(requestPermissionApproval).not.toHaveBeenCalled();
		expect(server.toolCallCount()).toBe(0);
	});

	it("reviews and executes one exactly scoped destructive MCP call", async () => {
		const requestPermissionApproval = vi.fn(async (_request: PermissionApprovalRequest) => ({
			decision: "allow" as const,
			reason: "test approval",
		}));
		const destructive: Tool = {
			name: "delete_document",
			description: "Delete one remote document",
			inputSchema: {
				type: "object",
				properties: { path: { type: "string" } },
				required: ["path"],
				additionalProperties: false,
			},
			annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
		};
		const server = await createMcpTestServer({ tools: [destructive] });
		servers.push(server);
		const manager = await McpManager.create({
			settingsManager: SettingsManager.inMemory({ mcpServers: { docs: { url: String(server.url) } } }),
			authStorage: AuthStorage.inMemory(),
			cwd: process.cwd(),
		});
		const harness = await createHarness({
			mcpManager: manager,
			permissionPreset: "ask",
			requestPermissionApproval,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("tool_search", { query: "delete document" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("mcp__docs__delete_document", { path: "remote/document-1" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("Delete remote document 1");

		expect(requestPermissionApproval).toHaveBeenCalledOnce();
		expect(server.toolCallCount()).toBe(1);
		expect(server.lastToolCallName()).toBe("delete_document");
	});

	it("reloads MCP before resources and disposes an injected manager exactly once", async () => {
		const unsubscribe = vi.fn();
		const reloadMcp = vi.fn(async () => {});
		const disposeMcp = vi.fn();
		const manager = {
			getToolRecords: () => [],
			getCatalogIdentity: () => "empty-catalog",
			getDirectToolNames: () => [],
			subscribeCatalog: vi.fn(() => unsubscribe),
			reload: reloadMcp,
			dispose: disposeMcp,
		} as unknown as McpManager;
		const reloadResources = vi.fn(async () => {});
		const resourceLoader = { ...createTestResourceLoader(), reload: reloadResources };
		const harness = await createHarness({ mcpManager: manager, resourceLoader });

		await harness.session.mcp?.reload();
		expect(reloadMcp).toHaveBeenCalledOnce();
		expect(reloadResources).not.toHaveBeenCalled();
		reloadMcp.mockClear();

		await harness.session.reload();
		expect(reloadMcp).toHaveBeenCalledOnce();
		expect(reloadResources).toHaveBeenCalledOnce();
		expect(reloadMcp.mock.invocationCallOrder[0]).toBeLessThan(reloadResources.mock.invocationCallOrder[0]);

		await harness.cleanup();
		harness.session.dispose();
		expect(unsubscribe).toHaveBeenCalledOnce();
		expect(disposeMcp).toHaveBeenCalledOnce();
	});
});
