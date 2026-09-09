import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@metis/app-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { AppServer } from "../src/app-server.ts";
import type { ConnectionOutboundEnvelope } from "../src/connection.ts";

const TURN_ID_1 = "00000000-0000-4000-8000-000000000302";
const TURN_ID_2 = "00000000-0000-4000-8000-000000000303";
const TURN_ID_3 = "00000000-0000-4000-8000-000000000304";

async function listen(server: Server): Promise<number> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
	return address.port;
}

function beginStream(response: ServerResponse): void {
	response.writeHead(200, {
		"cache-control": "no-cache",
		connection: "keep-alive",
		"content-type": "text/event-stream",
	});
	response.flushHeaders();
}

function chunk(response: ServerResponse, delta: Record<string, unknown>, finishReason: string | null = null): void {
	response.write(
		`data: ${JSON.stringify({
			id: "chatcmpl-hooks-runtime",
			object: "chat.completion.chunk",
			created: 1,
			model: "hooks-runtime-model",
			choices: [{ index: 0, delta, finish_reason: finishReason }],
		})}\n\n`,
	);
}

function finishText(response: ServerResponse, text: string): void {
	beginStream(response);
	chunk(response, { role: "assistant", content: text });
	chunk(response, {}, "stop");
	response.end("data: [DONE]\n\n");
}

describe("app-server hooks runtime end-to-end", () => {
	const temporaryRoots: string[] = [];
	const serversToClose: Server[] = [];

	afterEach(async () => {
		for (const s of serversToClose.splice(0)) {
			s.close();
		}
		for (const root of temporaryRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("completes full app-server lifecycle: upsert, persist, execute hook, block, inject context, and delete", async () => {
		const capturedProviderRequests: Array<{ messages: any[] }> = [];

		const provider = createServer(async (request, response) => {
			let raw = "";
			for await (const part of request) raw += part.toString();
			const body = JSON.parse(raw) as { messages?: any[] };
			capturedProviderRequests.push({ messages: body.messages ?? [] });
			finishText(response, "App-server provider answer.");
		});
		serversToClose.push(provider);
		const providerPort = await listen(provider);

		const root = mkdtempSync(join(tmpdir(), "app-server-hooks-runtime-"));
		temporaryRoots.push(root);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionsRoot = join(agentDir, "sessions");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });

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
								id: "hooks-runtime-model",
								name: "Hooks Runtime Model",
								contextWindow: 32_000,
								maxTokens: 1_024,
								reasoning: false,
							},
						],
					},
				},
			}),
		);
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "local", defaultModel: "hooks-runtime-model", retry: { enabled: false } }),
		);

		const server = await AppServer.create({
			agentDir,
			sessionsRoot,
			titleGenerator: { generate: async () => undefined },
		});
		const connection = server.connect();
		const outbound: ConnectionOutboundEnvelope[] = [];
		connection.onMessage((message) => {
			outbound.push(message);
		});

		const events = () =>
			outbound.flatMap((message) =>
				"method" in message && message.method === "connection/events" ? message.params.events : [],
			);

		try {
			// 1. Initialize client connection
			const initResponse = await connection.handle({
				jsonrpc: "2.0",
				id: "init",
				method: "initialize",
				params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, capabilities: [] },
			});
			expect(initResponse).toMatchObject({ id: "init" });

			// ==========================================
			// Session 1: Blocking hook (UserPromptSubmit exit 2)
			// ==========================================
			const blockingHookId = "aaaaaaaa-1111-4111-8111-111111111111";
			const upsertResponse = await connection.handle({
				jsonrpc: "2.0",
				id: "upsert-blocking",
				method: "hooks/upsert",
				params: {
					hook: {
						id: blockingHookId,
						name: "Policy Gatekeeper",
						enabled: true,
						event: "UserPromptSubmit",
						protocol: "command-v1",
						runMode: "process",
						command: process.execPath,
						args: ["-e", 'console.error("Denied by enterprise security policy"); process.exit(2);'],
						timeoutSeconds: 60,
					},
				},
			});
			expect(upsertResponse).toMatchObject({
				id: "upsert-blocking",
				result: {
					hooks: [
						expect.objectContaining({
							id: blockingHookId,
							protocol: "command-v1",
							name: "Policy Gatekeeper",
						}),
					],
				},
			});

			// Verify persisted canonically to hooks.json on disk
			const hooksFile = join(agentDir, "hooks.json");
			expect(existsSync(hooksFile)).toBe(true);
			const onDisk = JSON.parse(readFileSync(hooksFile, "utf8"));
			expect(onDisk.hooks[0].protocol).toBe("command-v1");

			// List hooks via hooks/list
			const listResponse = await connection.handle({
				jsonrpc: "2.0",
				id: "list-hooks",
				method: "hooks/list",
				params: {},
			});
			expect(listResponse).toMatchObject({
				id: "list-hooks",
				result: {
					hooks: [
						expect.objectContaining({
							id: blockingHookId,
							protocol: "command-v1",
						}),
					],
				},
			});

			const sessionId1 = "00000000-0000-4000-8000-000000000301";
			await connection.handle({
				jsonrpc: "2.0",
				id: "create-session-1",
				method: "session/create",
				params: { requestId: sessionId1, cwd: projectDir, permissionPreset: "full" },
			});
			await connection.handle({
				jsonrpc: "2.0",
				id: "open-session-1",
				method: "session/open",
				params: { sessionId: sessionId1 },
			});
			await connection.handle({
				jsonrpc: "2.0",
				id: "subscribe-session-1",
				method: "session/subscribe",
				params: { sessionId: sessionId1 },
			});

			// Start a turn that should be blocked by the hook
			await connection.handle({
				jsonrpc: "2.0",
				id: "turn-blocked",
				method: "turn/start",
				params: { sessionId: sessionId1, requestId: TURN_ID_1, text: "Dangerous prompt" },
			});

			// Wait for notification event surfacing the block reason
			await expect
				.poll(() => events().some((e) => JSON.stringify(e).includes("Denied by enterprise security policy")), {
					timeout: 10_000,
				})
				.toBe(true);

			// Provider must NOT have been called (0 calls)
			expect(capturedProviderRequests.length).toBe(0);

			// ==========================================
			// Session 2: Context injection hook
			// ==========================================
			const contextHookId = "bbbbbbbb-2222-4222-8222-222222222222";
			await connection.handle({
				jsonrpc: "2.0",
				id: "upsert-context",
				method: "hooks/upsert",
				params: {
					hook: {
						id: contextHookId,
						name: "Context Injector",
						enabled: true,
						event: "UserPromptSubmit",
						protocol: "command-v1",
						runMode: "process",
						command: process.execPath,
						args: [
							"-e",
							'console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "APP_SERVER_CONTEXT_MARKER" } }))',
						],
						timeoutSeconds: 60,
					},
				},
			});

			// Also delete the blocking hook so only context hook is active
			await connection.handle({
				jsonrpc: "2.0",
				id: "delete-blocking",
				method: "hooks/delete",
				params: { id: blockingHookId },
			});

			const sessionId2 = "00000000-0000-4000-8000-000000000302";
			await connection.handle({
				jsonrpc: "2.0",
				id: "create-session-2",
				method: "session/create",
				params: { requestId: sessionId2, cwd: projectDir, permissionPreset: "full" },
			});
			await connection.handle({
				jsonrpc: "2.0",
				id: "open-session-2",
				method: "session/open",
				params: { sessionId: sessionId2 },
			});
			await connection.handle({
				jsonrpc: "2.0",
				id: "subscribe-session-2",
				method: "session/subscribe",
				params: { sessionId: sessionId2 },
			});

			await connection.handle({
				jsonrpc: "2.0",
				id: "turn-with-context",
				method: "turn/start",
				params: { sessionId: sessionId2, requestId: TURN_ID_2, text: "Legitimate prompt" },
			});

			// Provider must receive the request containing the injected context
			await expect.poll(() => capturedProviderRequests.length, { timeout: 10_000 }).toBe(1);

			const providerReq = capturedProviderRequests[0]!;
			const serializedMessages = JSON.stringify(providerReq.messages);
			expect(serializedMessages).toContain("APP_SERVER_CONTEXT_MARKER");
			expect(serializedMessages).toContain("Legitimate prompt");

			// User-visible item in session events must retain clean prompt
			await expect
				.poll(
					() =>
						events().some(
							(e) =>
								e.type === "item/completed" &&
								e.item.role === "user" &&
								JSON.stringify(e.item.content).includes("Legitimate prompt") &&
								!JSON.stringify(e.item.content).includes("APP_SERVER_CONTEXT_MARKER"),
						),
					{ timeout: 10_000 },
				)
				.toBe(true);

			// ==========================================
			// Session 3: Delete hook and run clean session
			// ==========================================
			const deleteResponse = await connection.handle({
				jsonrpc: "2.0",
				id: "delete-context-hook",
				method: "hooks/delete",
				params: { id: contextHookId },
			});
			expect(deleteResponse).toMatchObject({
				id: "delete-context-hook",
				result: { hooks: [] },
			});

			const onDiskAfterDelete = JSON.parse(readFileSync(hooksFile, "utf8"));
			expect(onDiskAfterDelete.hooks).toHaveLength(0);

			const sessionId3 = "00000000-0000-4000-8000-000000000303";
			await connection.handle({
				jsonrpc: "2.0",
				id: "create-session-3",
				method: "session/create",
				params: { requestId: sessionId3, cwd: projectDir, permissionPreset: "full" },
			});
			await connection.handle({
				jsonrpc: "2.0",
				id: "open-session-3",
				method: "session/open",
				params: { sessionId: sessionId3 },
			});
			await connection.handle({
				jsonrpc: "2.0",
				id: "subscribe-session-3",
				method: "session/subscribe",
				params: { sessionId: sessionId3 },
			});

			await connection.handle({
				jsonrpc: "2.0",
				id: "turn-clean",
				method: "turn/start",
				params: { sessionId: sessionId3, requestId: TURN_ID_3, text: "Third prompt" },
			});

			await expect.poll(() => capturedProviderRequests.length, { timeout: 10_000 }).toBe(2);

			const providerReq2 = capturedProviderRequests[1]!;
			const serializedMessages2 = JSON.stringify(providerReq2.messages);
			expect(serializedMessages2).not.toContain("APP_SERVER_CONTEXT_MARKER");
			expect(serializedMessages2).toContain("Third prompt");
		} finally {
			server.beginShutdown();
			await server.waitForShutdown();
		}
	}, 60_000);
});
