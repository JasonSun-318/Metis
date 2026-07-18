import type { ImageContent as AgentImageContent, TextContent as AgentTextContent } from "@arcmind/ai";
import type { CallToolResult, ContentBlock, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { McpManager, McpToolRecord } from "./manager.ts";

const searchSchema = Type.Object(
	{
		query: Type.String({ description: "Search query for deferred tools." }),
		limit: Type.Optional(
			Type.Number({ minimum: 1, maximum: 50, description: "Maximum number of tools to return. Defaults to 8." }),
		),
	},
	{ additionalProperties: false },
);

const optionalServerCursorSchema = Type.Object(
	{
		server: Type.Optional(Type.String()),
		cursor: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

const readResourceSchema = Type.Object({ server: Type.String(), uri: Type.String() }, { additionalProperties: false });

const getPromptSchema = Type.Object(
	{
		server: Type.String(),
		name: Type.String(),
		arguments: Type.Optional(Type.Record(Type.String(), Type.String())),
	},
	{ additionalProperties: false },
);

const directDescriptions = {
	list_mcp_resources:
		"Lists resources provided by MCP servers. Resources allow servers to share data that provides context to language models, such as files, database schemas, or application-specific information. Prefer resources over web search when possible.",
	list_mcp_resource_templates:
		"Lists resource templates provided by MCP servers. Parameterized resource templates allow servers to share data that takes parameters and provides context to language models, such as files, database schemas, or application-specific information. Prefer resource templates over web search when possible.",
	read_mcp_resource: "Read a specific resource from an MCP server given the server name and resource URI.",
	list_mcp_prompts:
		"Lists reusable prompt templates provided by MCP servers. Prompt templates are returned as data and are not automatically inserted into the conversation.",
	get_mcp_prompt:
		"Gets one reusable prompt template from an MCP server with optional string arguments and returns its role/content messages as data.",
} as const;

export function mcpContentToAgent(content: readonly ContentBlock[]): Array<AgentTextContent | AgentImageContent> {
	return content.flatMap((block): Array<AgentTextContent | AgentImageContent> => {
		if (block.type === "text") return [{ type: "text", text: block.text }];
		if (block.type === "image") return [{ type: "image", mimeType: block.mimeType, data: block.data }];
		if (block.type === "audio") {
			return [{ type: "text", text: `[MCP audio: ${block.mimeType}, ${block.data.length} base64 characters]` }];
		}
		if (block.type === "resource_link") return [{ type: "text", text: JSON.stringify(block) }];
		if (block.type === "resource") {
			const resource = block.resource;
			if ("text" in resource) return [{ type: "text", text: resource.text }];
			if (resource.mimeType?.startsWith("image/")) {
				return [{ type: "image", mimeType: resource.mimeType, data: resource.blob }];
			}
			return [
				{
					type: "text",
					text: `[Embedded MCP resource: ${resource.uri}, ${resource.mimeType ?? "application/octet-stream"}]`,
				},
			];
		}
		return [];
	});
}

function readResourceContent(result: ReadResourceResult): Array<AgentTextContent | AgentImageContent> {
	return result.contents.map((resource) => {
		if ("text" in resource) return { type: "text" as const, text: resource.text };
		if (resource.mimeType?.startsWith("image/")) {
			return { type: "image" as const, mimeType: resource.mimeType, data: resource.blob };
		}
		return {
			type: "text" as const,
			text: `[MCP resource: ${resource.uri}, ${resource.mimeType ?? "application/octet-stream"}, ${resource.blob.length} base64 characters]`,
		};
	});
}

function jsonResult(value: unknown) {
	return {
		content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
		details: undefined,
	};
}

function convertToolResult(result: CallToolResult) {
	const content = mcpContentToAgent(result.content);
	if (result.structuredContent !== undefined) {
		content.push({
			type: "text",
			text: `Structured content:\n${JSON.stringify(result.structuredContent, null, 2)}`,
		});
	}
	if (result.isError) {
		const message = content
			.filter((item): item is AgentTextContent => item.type === "text")
			.map((item) => item.text)
			.join("\n");
		throw new Error(message || "MCP tool returned an error");
	}
	return { content, details: undefined };
}

function sourceLines(records: readonly McpToolRecord[]): string {
	const descriptions = new Map<string, string | undefined>();
	for (const record of records) {
		if (!descriptions.has(record.sourceName) || (!descriptions.get(record.sourceName) && record.sourceDescription)) {
			descriptions.set(record.sourceName, record.sourceDescription);
		}
	}
	return [...descriptions]
		.map(([name, description]) => `- ${name}${description ? `: ${description.slice(0, 512)}` : ""}`)
		.join("\n");
}

function createSearchDefinition(
	manager: McpManager,
	activation: { getActiveToolNames(): string[]; setActiveToolsByName(names: string[]): void },
): ToolDefinition<
	typeof searchSchema,
	{ query: string; tools: Array<{ modelName: string; serverName: string; rawName: string }> }
> {
	const sources = sourceLines(manager.getToolRecords());
	return {
		name: "tool_search",
		label: "tool_search",
		description: `# Tool discovery

Searches over deferred tool metadata with BM25 and exposes matching tools for the next model call.

You have access to tools from the following sources:
${sources}
Some of the tools may not have been provided to you upfront, and you should use this tool (\`tool_search\`) to search for the required tools. For MCP tool discovery, always use \`tool_search\` instead of \`list_mcp_resources\` or \`list_mcp_resource_templates\`.`,
		parameters: searchSchema,
		executionMode: "parallel",
		async execute(_toolCallId, { query, limit }) {
			const normalizedQuery = query.trim();
			if (!normalizedQuery) throw new Error("tool_search query must not be empty");
			const hits = manager.searchTools(normalizedQuery, limit ?? 8);
			const before = new Set(activation.getActiveToolNames());
			activation.setActiveToolsByName([...before, ...hits.map((hit) => hit.modelName)]);
			return {
				content: [
					{
						type: "text",
						text: hits.length
							? hits
									.map((hit) => `${hit.modelName}: ${hit.tool.description ?? hit.tool.title ?? "MCP tool"}`)
									.join("\n")
							: "No matching deferred tools found.",
					},
				],
				details: {
					query: normalizedQuery,
					tools: hits.map(({ modelName, serverName, rawName }) => ({ modelName, serverName, rawName })),
				},
				addedToolNames: hits.map((hit) => hit.modelName).filter((name) => !before.has(name)),
			};
		},
	};
}

function deferredDefinition(manager: McpManager, record: McpToolRecord): ToolDefinition<any, undefined> {
	const description = [
		record.tool.title,
		record.tool.description,
		record.sourceDescription ? `Source guidance (${record.serverName}): ${record.sourceDescription}` : undefined,
	]
		.filter(Boolean)
		.join("\n\n");
	return {
		name: record.modelName,
		label: record.tool.title ?? record.rawName,
		description: description || "MCP tool",
		parameters: record.tool.inputSchema as any,
		executionMode: record.tool.annotations?.readOnlyHint === true ? "parallel" : "sequential",
		async execute(_toolCallId, params, signal) {
			return convertToolResult(await manager.callTool(record.modelName, params as Record<string, unknown>, signal));
		},
	};
}

export function createMcpToolDefinitions(
	manager: McpManager,
	activation: { getActiveToolNames(): string[]; setActiveToolsByName(names: string[]): void },
): {
	direct: ToolDefinition<any, any>[];
	deferred: Array<{ definition: ToolDefinition<any, any>; serverName: string }>;
} {
	const directNames = new Set(manager.getDirectToolNames());
	const direct: ToolDefinition<any, any>[] = [];
	if (directNames.has("tool_search")) direct.push(createSearchDefinition(manager, activation));
	if (directNames.has("list_mcp_resources")) {
		direct.push({
			name: "list_mcp_resources",
			label: "list_mcp_resources",
			description: directDescriptions.list_mcp_resources,
			parameters: optionalServerCursorSchema,
			executionMode: "parallel",
			async execute(_id, { server, cursor }) {
				return jsonResult(await manager.listResources(server, cursor));
			},
		});
	}
	if (directNames.has("list_mcp_resource_templates")) {
		direct.push({
			name: "list_mcp_resource_templates",
			label: "list_mcp_resource_templates",
			description: directDescriptions.list_mcp_resource_templates,
			parameters: optionalServerCursorSchema,
			executionMode: "parallel",
			async execute(_id, { server, cursor }) {
				return jsonResult(await manager.listResourceTemplates(server, cursor));
			},
		});
	}
	if (directNames.has("read_mcp_resource")) {
		direct.push({
			name: "read_mcp_resource",
			label: "read_mcp_resource",
			description: directDescriptions.read_mcp_resource,
			parameters: readResourceSchema,
			executionMode: "parallel",
			async execute(_id, { server, uri }, signal) {
				return {
					content: readResourceContent(await manager.readResource(server, uri, signal)),
					details: undefined,
				};
			},
		});
	}
	if (directNames.has("list_mcp_prompts")) {
		direct.push({
			name: "list_mcp_prompts",
			label: "list_mcp_prompts",
			description: directDescriptions.list_mcp_prompts,
			parameters: optionalServerCursorSchema,
			executionMode: "parallel",
			async execute(_id, { server, cursor }) {
				return jsonResult(await manager.listPrompts(server, cursor));
			},
		});
	}
	if (directNames.has("get_mcp_prompt")) {
		direct.push({
			name: "get_mcp_prompt",
			label: "get_mcp_prompt",
			description: directDescriptions.get_mcp_prompt,
			parameters: getPromptSchema,
			executionMode: "parallel",
			async execute(_id, { server, name, arguments: args }) {
				return jsonResult(await manager.getPrompt(server, name, args));
			},
		});
	}

	return {
		direct,
		deferred: manager.getToolRecords().map((record) => ({
			definition: deferredDefinition(manager, record),
			serverName: record.serverName,
		})),
	};
}
