import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createMcpToolDefinitions, type McpManager, type McpToolRecord } from "../src/core/mcp/index.ts";

function record(instructions = "Use Drive as the source of truth."): McpToolRecord {
	return {
		serverName: "drive",
		rawName: "search_files",
		modelName: "mcp__drive__search_files",
		tool: {
			name: "search_files",
			description: "Search files",
			inputSchema: {
				type: "object",
				properties: { query: { type: "string" } },
				required: ["query"],
				additionalProperties: false,
			},
			annotations: { readOnlyHint: true },
		},
		sourceName: "drive",
		sourceDescription: instructions,
		searchText: `search files drive ${instructions}`,
	};
}

function fakeManager(
	options: { instructions?: string; callResult?: CallToolResult; directNames?: string[] } = {},
): McpManager {
	const tool = record(options.instructions);
	return {
		getToolRecords: () => [tool],
		getDirectToolNames: () => options.directNames ?? ["tool_search"],
		searchTools: vi.fn(() => [tool]),
		callTool: vi.fn(async () => options.callResult ?? { content: [{ type: "text", text: "ok" }] }),
		getToolAnnotations: () => tool.tool.annotations,
		listResources: vi.fn(async () => ({ servers: [] })),
		listResourceTemplates: vi.fn(async () => ({ servers: [] })),
		readResource: vi.fn(async () => ({ contents: [{ uri: "docs://guide", text: "guide" }] })),
		listPrompts: vi.fn(async () => ({ servers: [] })),
		getPrompt: vi.fn(async () => ({
			messages: [{ role: "user", content: { type: "text", text: "review" } }],
		})),
	} as unknown as McpManager;
}

function activation(initial: string[] = []) {
	let active = [...initial];
	return {
		getActiveToolNames: () => [...active],
		setActiveToolsByName: (names: string[]) => {
			active = [...names];
		},
	};
}

const extensionContext = {} as ExtensionContext;

describe("MCP model tools", () => {
	it("shows bounded sources but keeps server schemas deferred", () => {
		const manager = fakeManager({ instructions: `Use Drive.${"x".repeat(600)}` });
		const definitions = createMcpToolDefinitions(manager, activation());
		const search = definitions.direct.find((tool) => tool.name === "tool_search")!;

		expect(search.description).toContain("- drive: Use Drive.");
		expect(search.description).not.toContain("x".repeat(513));
		expect(definitions.direct.map((tool) => tool.name)).not.toContain("mcp__drive__search_files");
		expect(definitions.deferred[0].definition.parameters).toEqual(manager.getToolRecords()[0].tool.inputSchema);
	});

	it("activates hits and records only newly added names", async () => {
		const manager = fakeManager();
		const state = activation(["tool_search"]);
		const search = createMcpToolDefinitions(manager, state).direct.find((tool) => tool.name === "tool_search")!;

		const result = await search.execute("call", { query: "files", limit: 8 }, undefined, undefined, extensionContext);

		expect(state.getActiveToolNames()).toEqual(["tool_search", "mcp__drive__search_files"]);
		expect(result.addedToolNames).toEqual(["mcp__drive__search_files"]);
	});

	it("uses model identity for routing and preserves MCP result content", async () => {
		const manager = fakeManager({
			callResult: {
				content: [
					{ type: "text", text: "ok" },
					{ type: "image", mimeType: "image/png", data: "aW1n" },
					{ type: "audio", mimeType: "audio/wav", data: "YXVkaW8=" },
				],
				structuredContent: { count: 1 },
			},
		});
		const definition = createMcpToolDefinitions(manager, activation()).deferred[0].definition;

		const result = await definition.execute("call", { query: "x" }, undefined, undefined, extensionContext);

		expect(manager.callTool).toHaveBeenCalledWith("mcp__drive__search_files", { query: "x" }, undefined);
		expect(result.content).toEqual([
			{ type: "text", text: "ok" },
			{ type: "image", mimeType: "image/png", data: "aW1n" },
			{ type: "text", text: "[MCP audio: audio/wav, 8 base64 characters]" },
			{ type: "text", text: 'Structured content:\n{\n  "count": 1\n}' },
		]);
	});

	it("registers and executes capability-gated resource and prompt tools", async () => {
		const manager = fakeManager({
			directNames: [
				"tool_search",
				"list_mcp_resources",
				"list_mcp_resource_templates",
				"read_mcp_resource",
				"list_mcp_prompts",
				"get_mcp_prompt",
			],
		});
		const direct = createMcpToolDefinitions(manager, activation()).direct;

		expect(direct.map((tool) => tool.name)).toEqual(
			expect.arrayContaining([
				"list_mcp_resources",
				"list_mcp_resource_templates",
				"read_mcp_resource",
				"list_mcp_prompts",
				"get_mcp_prompt",
			]),
		);
		const read = direct.find((tool) => tool.name === "read_mcp_resource")!;
		const result = await read.execute(
			"call",
			{ server: "drive", uri: "docs://guide" },
			undefined,
			undefined,
			extensionContext,
		);
		expect(manager.readResource).toHaveBeenCalledWith("drive", "docs://guide", undefined);
		expect(result.content).toEqual([{ type: "text", text: "guide" }]);
	});

	it("turns MCP error results into tool errors", async () => {
		const manager = fakeManager({
			callResult: { content: [{ type: "text", text: "remote failure" }], isError: true },
		});
		const definition = createMcpToolDefinitions(manager, activation()).deferred[0].definition;

		await expect(definition.execute("call", { query: "x" }, undefined, undefined, extensionContext)).rejects.toThrow(
			"remote failure",
		);
	});
});
