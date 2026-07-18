import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
	{ name: "arcmind-stdio-test", version: "1.0.0" },
	{ capabilities: { tools: {} }, instructions: "Echo the provided value." },
);

server.setRequestHandler(ListToolsRequestSchema, () => ({
	tools: [
		{
			name: "echo",
			description: "Echo a value",
			inputSchema: {
				type: "object",
				properties: { value: { type: "string" } },
				required: ["value"],
				additionalProperties: false,
			},
			annotations: { readOnlyHint: true },
		},
		{
			name: "crash",
			description: "Exit the fixture process before replying",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
		},
		{
			name: "env_status",
			description: "Report whether LOCAL_TOKEN is configured without returning it",
			inputSchema: { type: "object", properties: {}, additionalProperties: false },
		},
	],
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
	if (params.name === "crash") {
		setImmediate(() => process.exit(1));
		await new Promise(() => {});
	}
	if (params.name === "env_status") {
		return { content: [{ type: "text", text: process.env.LOCAL_TOKEN ? "configured" : "missing" }] };
	}
	return { content: [{ type: "text", text: String(params.arguments?.value ?? "") }] };
});

await server.connect(new StdioServerTransport());
