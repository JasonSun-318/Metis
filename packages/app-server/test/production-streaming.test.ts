import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ItemView } from "@arcmind/app-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { AppServer } from "../src/app-server.ts";

const SESSION_REQUEST = "00000000-0000-4000-8000-000000000101";
const TURN_REQUEST = "00000000-0000-4000-8000-000000000102";

async function listen(server: Server): Promise<number> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
	return address.port;
}

function textFrom(items: ItemView[]): string {
	return items
		.flatMap((item) => item.content)
		.filter((block) => block.type === "text")
		.map((block) => block.text)
		.join("");
}

describe("production runtime streaming", () => {
	const temporaryRoots: string[] = [];

	afterEach(() => {
		for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("projects text before the provider stream ends", async () => {
		let completionResponse: ServerResponse | undefined;
		let resolveConnected!: () => void;
		const connected = new Promise<void>((resolve) => {
			resolveConnected = resolve;
		});
		const provider = createServer(async (request, response) => {
			for await (const _chunk of request) {
				// Drain the request before responding, as a normal HTTP server would.
			}
			completionResponse = response;
			response.writeHead(200, {
				"cache-control": "no-cache",
				connection: "keep-alive",
				"content-type": "text/event-stream",
			});
			response.flushHeaders();
			resolveConnected();
		});
		const providerPort = await listen(provider);

		const root = mkdtempSync(join(tmpdir(), "app-server-streaming-"));
		temporaryRoots.push(root);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionsRoot = join(agentDir, "sessions");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					local: {
						baseUrl: `http://127.0.0.1:${providerPort}/v1`,
						apiKey: "test-key",
						api: "openai-completions",
						models: [{ id: "streaming-test", name: "Streaming Test", contextWindow: 32_000, maxTokens: 1_024 }],
					},
				},
			}),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "local", defaultModel: "streaming-test", retry: { enabled: false } }),
		);

		const server = await AppServer.create({ agentDir, sessionsRoot });
		const connection = server.connect();
		try {
			await connection.handle({
				jsonrpc: "2.0",
				id: "initialize",
				method: "initialize",
				params: { protocolVersion: 3, client: { name: "test", version: "1" }, capabilities: [] },
			});
			await connection.handle({
				jsonrpc: "2.0",
				id: "create",
				method: "session/create",
				params: { requestId: SESSION_REQUEST, cwd: projectDir },
			});
			await connection.handle({
				jsonrpc: "2.0",
				id: "open",
				method: "session/open",
				params: { sessionId: SESSION_REQUEST },
			});
			await connection.handle({
				jsonrpc: "2.0",
				id: "turn",
				method: "turn/start",
				params: { sessionId: SESSION_REQUEST, requestId: TURN_REQUEST, text: "hello" },
			});
			await connected;
			completionResponse!.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-test",
					object: "chat.completion.chunk",
					created: 1,
					model: "streaming-test",
					choices: [
						{ index: 0, delta: { role: "assistant", content: "visible-before-end" }, finish_reason: null },
					],
				})}\n\n`,
			);

			await expect
				.poll(async () => {
					const response = await connection.handle({
						jsonrpc: "2.0",
						id: "read",
						method: "session/readItems",
						params: { sessionId: SESSION_REQUEST, limit: 200 },
					});
					if (!("result" in response) || !("items" in response.result)) return "";
					return textFrom(response.result.items);
				})
				.toContain("visible-before-end");
		} finally {
			server.beginShutdown();
			await server.waitForShutdown();
			completionResponse?.end("data: [DONE]\n\n");
			provider.closeAllConnections();
			await new Promise<void>((resolve) => provider.close(() => resolve()));
		}
	});
});
