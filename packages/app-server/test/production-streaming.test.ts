import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ItemView, RPC_ERROR_CODES } from "@metis/app-protocol";
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

function summarizedAssistant(items: ItemView[]) {
	const assistant = items.find((item) => item.role === "assistant");
	return {
		state: assistant?.state,
		content: (assistant?.content ?? []).map((block) =>
			block.type === "thinking" || block.type === "text"
				? { type: block.type, text: block.type === "thinking" ? block.text.length : block.text }
				: block.type === "tool_call"
					? { type: block.type, name: block.name }
					: { type: block.type },
		),
	};
}

describe("production runtime streaming", () => {
	const temporaryRoots: string[] = [];

	afterEach(() => {
		for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("projects ordered thinking and text before the provider stream ends", async () => {
		const longThinking = "t".repeat(9 * 1024);
		let completionResponse: ServerResponse | undefined;
		let completionRequestBody = "";
		let resolveConnected!: () => void;
		const connected = new Promise<void>((resolve) => {
			resolveConnected = resolve;
		});
		const provider = createServer(async (request, response) => {
			for await (const chunk of request) completionRequestBody += chunk.toString();
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
		const attachmentSource = join(root, "legal report.pdf");
		writeFileSync(attachmentSource, "document");
		writeFileSync(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					local: {
						baseUrl: `http://127.0.0.1:${providerPort}/v1`,
						apiKey: "test-key",
						api: "openai-completions",
						models: [
							{
								id: "streaming-test",
								name: "Streaming Test",
								contextWindow: 32_000,
								maxTokens: 1_024,
								reasoning: true,
								compat: { thinkingFormat: "deepseek" },
							},
						],
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
				params: { protocolVersion: 11, client: { name: "test", version: "1" }, capabilities: [] },
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
				params: {
					sessionId: SESSION_REQUEST,
					requestId: TURN_REQUEST,
					text: "hello",
					attachments: [{ path: attachmentSource, name: "legal report.pdf" }],
				},
			});
			await connected;
			expect(
				await connection.handle({
					jsonrpc: "2.0",
					id: "permissions-running",
					method: "session/setPermissionMode",
					params: {
						sessionId: SESSION_REQUEST,
						requestId: "00000000-0000-4000-8000-000000000103",
						permissionMode: "full",
					},
				}),
			).toMatchObject({ error: { code: RPC_ERROR_CODES.BUSY } });
			const requestStrings: string[] = [];
			const collectStrings = (value: unknown): void => {
				if (typeof value === "string") requestStrings.push(value);
				else if (Array.isArray(value)) value.forEach(collectStrings);
				else if (typeof value === "object" && value !== null) Object.values(value).forEach(collectStrings);
			};
			collectStrings(JSON.parse(completionRequestBody));
			const attachmentPrompt = requestStrings.find((value) => value.includes("<attachments>"));
			expect(attachmentPrompt).toBeDefined();
			const metadata = JSON.parse(
				attachmentPrompt!.slice(
					attachmentPrompt!.indexOf("<attachments>") + "<attachments>".length,
					attachmentPrompt!.indexOf("</attachments>"),
				),
			) as Array<{ name: string; path: string; size: number }>;
			expect(metadata).toHaveLength(1);
			expect(metadata[0]!.name).toBe("legal report.pdf");
			expect(metadata[0]!.path).not.toBe(attachmentSource);
			expect(metadata[0]!.path).toContain(join(agentDir, "attachments", SESSION_REQUEST));
			expect(existsSync(metadata[0]!.path)).toBe(true);
			expect(readFileSync(metadata[0]!.path, "utf8")).toBe("document");
			const visibleUserItem = await connection.handle({
				jsonrpc: "2.0",
				id: "read-user",
				method: "session/readItems",
				params: { sessionId: SESSION_REQUEST, limit: 200 },
			});
			expect(JSON.stringify(visibleUserItem)).toContain("[legal report.pdf]");
			expect(JSON.stringify(visibleUserItem)).not.toContain(metadata[0]!.path);
			completionResponse!.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-test",
					object: "chat.completion.chunk",
					created: 1,
					model: "streaming-test",
					choices: [
						{
							index: 0,
							delta: { role: "assistant", reasoning_content: longThinking },
							finish_reason: null,
						},
					],
				})}\n\n`,
			);
			completionResponse!.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-test",
					object: "chat.completion.chunk",
					created: 1,
					model: "streaming-test",
					choices: [
						{
							index: 0,
							delta: { content: "visible-before-end" },
							finish_reason: null,
						},
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
					if (!("result" in response) || !("items" in response.result)) return [];
					return summarizedAssistant(response.result.items).content;
				})
				.toEqual([
					{ type: "thinking", text: 8 * 1024 },
					{ type: "text", text: "visible-before-end" },
				]);

			completionResponse!.write(
				`data: ${JSON.stringify({
					id: "chatcmpl-test",
					object: "chat.completion.chunk",
					created: 1,
					model: "streaming-test",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				})}\n\n`,
			);
			completionResponse!.end("data: [DONE]\n\n");
			completionResponse = undefined;
			await expect
				.poll(async () => {
					const response = await connection.handle({
						jsonrpc: "2.0",
						id: "read-completed",
						method: "session/readItems",
						params: { sessionId: SESSION_REQUEST, limit: 200 },
					});
					if (!("result" in response) || !("items" in response.result)) return undefined;
					const completed = summarizedAssistant(response.result.items);
					return {
						...completed,
						content: completed.content.map((block) =>
							block.type === "thinking"
								? { ...block, text: typeof block.text === "number" && block.text > 0 && block.text <= 8 * 1024 }
								: block,
						),
					};
				})
				.toEqual({
					state: "completed",
					content: [
						{ type: "thinking", text: true },
						{ type: "text", text: "visible-before-end" },
					],
				});

			expect(
				await connection.handle({
					jsonrpc: "2.0",
					id: "permissions-idle",
					method: "session/setPermissionMode",
					params: {
						sessionId: SESSION_REQUEST,
						requestId: "00000000-0000-4000-8000-000000000104",
						permissionMode: "full",
					},
				}),
			).toMatchObject({ result: { permissionMode: "full" } });
			expect(readFileSync(server.catalog.get(SESSION_REQUEST).path, "utf8")).toContain('"permissionMode":"full"');
			expect(
				await connection.handle({
					jsonrpc: "2.0",
					id: "rename-idle",
					method: "session/rename",
					params: {
						sessionId: SESSION_REQUEST,
						requestId: "00000000-0000-4000-8000-000000000105",
						name: "Renamed production session",
					},
				}),
			).toMatchObject({ result: { session: { name: "Renamed production session" } } });
			expect(readFileSync(server.catalog.get(SESSION_REQUEST).path, "utf8")).toContain('"type":"session_info"');
			const subscribed = await connection.handle({
				jsonrpc: "2.0",
				id: "subscribe-permissions",
				method: "session/subscribe",
				params: { sessionId: SESSION_REQUEST },
			});
			expect(subscribed).toMatchObject({ result: { snapshot: { permissionMode: "full" } } });
		} finally {
			server.beginShutdown();
			await server.waitForShutdown();
			completionResponse?.end("data: [DONE]\n\n");
			provider.closeAllConnections();
			await new Promise<void>((resolve) => provider.close(() => resolve()));
		}
	});
});
