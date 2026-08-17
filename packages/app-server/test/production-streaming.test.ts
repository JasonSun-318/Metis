import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ItemView, RPC_ERROR_CODES } from "@metis/app-protocol";
import { afterEach, describe, expect, it } from "vitest";
import { AppServer } from "../src/app-server.ts";
import type { ConnectionOutboundEnvelope } from "../src/connection.ts";

const SESSION_REQUEST = "00000000-0000-4000-8000-000000000101";
const TURN_REQUEST = "00000000-0000-4000-8000-000000000102";
const BACKGROUND_SESSION_REQUEST = "00000000-0000-4000-8000-000000000109";

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
		try {
			await connection.handle({
				jsonrpc: "2.0",
				id: "initialize",
				method: "initialize",
				params: { protocolVersion: 19, client: { name: "test", version: "1" }, capabilities: [] },
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
				id: "subscribe",
				method: "session/subscribe",
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
			const queuedResponse = await connection.handle({
				jsonrpc: "2.0",
				id: "queue-running",
				method: "turn/queue",
				params: {
					sessionId: SESSION_REQUEST,
					requestId: "00000000-0000-4000-8000-000000000120",
					text: "inspect the reducer next",
					attachments: [{ path: attachmentSource, name: "legal report.pdf" }],
				},
			});
			expect(queuedResponse).toMatchObject({
				result: {
					queuedTurn: {
						state: "queued",
						text: "inspect the reducer next",
						attachments: [{ name: "legal report.pdf", byteLength: 8 }],
					},
				},
			});
			expect(JSON.stringify(queuedResponse)).not.toContain(attachmentSource);
			expect(JSON.stringify(queuedResponse)).not.toContain(join(agentDir, "attachments"));
			if (!("result" in queuedResponse) || !("queuedTurn" in queuedResponse.result)) {
				throw new Error("Expected queued turn result");
			}
			const queuedTurn = queuedResponse.result.queuedTurn;
			const updatedQueueResponse = await connection.handle({
				jsonrpc: "2.0",
				id: "update-queued",
				method: "turn/queue/update",
				params: {
					sessionId: SESSION_REQUEST,
					requestId: "00000000-0000-4000-8000-000000000121",
					queueItemId: queuedTurn.queueItemId,
					expectedRevision: queuedTurn.revision,
					text: "inspect the durable reducer first",
				},
			});
			expect(updatedQueueResponse).toMatchObject({
				result: {
					queuedTurn: { text: "inspect the durable reducer first", attachments: [{ name: "legal report.pdf" }] },
				},
			});
			if (!("result" in updatedQueueResponse) || !("queuedTurn" in updatedQueueResponse.result)) {
				throw new Error("Expected updated queued turn result");
			}
			expect(
				await connection.handle({
					jsonrpc: "2.0",
					id: "update-queued-stale",
					method: "turn/queue/update",
					params: {
						sessionId: SESSION_REQUEST,
						requestId: "00000000-0000-4000-8000-000000000123",
						queueItemId: queuedTurn.queueItemId,
						expectedRevision: queuedTurn.revision,
						text: "stale edit",
					},
				}),
			).toMatchObject({ error: { code: RPC_ERROR_CODES.CONFLICT } });
			expect(
				await connection.handle({
					jsonrpc: "2.0",
					id: "start-queued-while-running",
					method: "turn/queue/send",
					params: {
						sessionId: SESSION_REQUEST,
						requestId: "00000000-0000-4000-8000-000000000124",
						queueItemId: queuedTurn.queueItemId,
						expectedRevision: updatedQueueResponse.result.queuedTurn.revision,
						delivery: "start",
					},
				}),
			).toMatchObject({ error: { code: RPC_ERROR_CODES.BUSY } });
			expect(
				await connection.handle({
					jsonrpc: "2.0",
					id: "delete-queued",
					method: "turn/queue/delete",
					params: {
						sessionId: SESSION_REQUEST,
						requestId: "00000000-0000-4000-8000-000000000122",
						queueItemId: queuedTurn.queueItemId,
						expectedRevision: updatedQueueResponse.result.queuedTurn.revision,
					},
				}),
			).toMatchObject({ result: { queueItemId: queuedTurn.queueItemId, deleted: true } });
			const queueEvents = outbound
				.flatMap((message) =>
					"method" in message && message.method === "connection/events" ? message.params.events : [],
				)
				.filter((event) => event.type === "turn/queueChanged");
			expect(queueEvents.length).toBeGreaterThanOrEqual(3);
			expect(queueEvents.some((event) => event.queuedTurns[0]?.text === "inspect the durable reducer first")).toBe(
				true,
			);
			expect(queueEvents.at(-1)?.queuedTurns).toEqual([]);
			expect(JSON.stringify(queueEvents)).not.toContain(attachmentSource);
			expect(JSON.stringify(queueEvents)).not.toContain(join(agentDir, "attachments"));
			expect(
				await connection.handle({
					jsonrpc: "2.0",
					id: "compact-running",
					method: "session/compact",
					params: {
						sessionId: SESSION_REQUEST,
						requestId: "00000000-0000-4000-8000-000000000108",
					},
				}),
			).toMatchObject({ error: { code: RPC_ERROR_CODES.BUSY } });
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
			expect(
				await connection.handle({
					jsonrpc: "2.0",
					id: "mcp-running",
					method: "mcp/upsert",
					params: {
						sessionId: SESSION_REQUEST,
						requestId: "00000000-0000-4000-8000-000000000106",
						scope: "user",
						name: "docs",
						expectedRevision: null,
						server: { transport: "http", url: "https://mcp.example.test/rpc", enabled: false },
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
			await connection.handle({
				jsonrpc: "2.0",
				id: "create-background",
				method: "session/create",
				params: { requestId: BACKGROUND_SESSION_REQUEST, cwd: projectDir },
			});
			await connection.handle({
				jsonrpc: "2.0",
				id: "open-background",
				method: "session/open",
				params: { sessionId: BACKGROUND_SESSION_REQUEST },
			});
			await connection.handle({
				jsonrpc: "2.0",
				id: "subscribe-background",
				method: "session/subscribe",
				params: { sessionId: BACKGROUND_SESSION_REQUEST },
			});
			await connection.handle({
				jsonrpc: "2.0",
				id: "unsubscribe-running",
				method: "session/unsubscribe",
				params: { sessionId: SESSION_REQUEST },
			});

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
			await expect
				.poll(() => server.catalog.get(SESSION_REQUEST).summary)
				.toMatchObject({
					state: "idle",
					lastTurnOutcome: "completed",
					unread: true,
				});
			const status = await connection.handle({
				jsonrpc: "2.0",
				id: "session-status",
				method: "session/status",
				params: { sessionId: SESSION_REQUEST },
			});
			expect(status).toMatchObject({
				result: {
					sessionId: SESSION_REQUEST,
					mode: "code",
					contextWindow: 32_000,
					cacheHitPercent: null,
				},
			});
			if ("result" in status && "remainingPercent" in status.result) {
				expect(status.result.contextTokens).toEqual(expect.any(Number));
				expect(status.result.remainingPercent).toBeGreaterThanOrEqual(0);
				expect(status.result.remainingPercent).toBeLessThanOrEqual(100);
			}
			await expect
				.poll(() =>
					outbound
						.flatMap((message) =>
							"method" in message && message.method === "connection/events"
								? message.params.events.flatMap((event) =>
										event.type === "session/updated" && event.session.sessionId === SESSION_REQUEST
											? [event.session]
											: [],
									)
								: [],
						)
						.at(-1),
				)
				.toMatchObject({ state: "idle", lastTurnOutcome: "completed", unread: true });

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
			await connection.handle({
				jsonrpc: "2.0",
				id: "unsubscribe-before-resubscribe",
				method: "session/unsubscribe",
				params: { sessionId: SESSION_REQUEST },
			});
			const subscribed = await connection.handle({
				jsonrpc: "2.0",
				id: "subscribe-permissions",
				method: "session/subscribe",
				params: { sessionId: SESSION_REQUEST },
			});
			expect(subscribed).toMatchObject({ result: { snapshot: { permissionMode: "full" } } });

			expect(
				await connection.handle({
					jsonrpc: "2.0",
					id: "mark-success-read",
					method: "session/markRead",
					params: { sessionId: SESSION_REQUEST },
				}),
			).toMatchObject({ result: { session: { unread: false } } });
			await connection.handle({
				jsonrpc: "2.0",
				id: "failed-turn",
				method: "turn/start",
				params: {
					sessionId: SESSION_REQUEST,
					requestId: "00000000-0000-4000-8000-000000000107",
					text: "fail now",
				},
			});
			await expect.poll(() => completionResponse !== undefined).toBe(true);
			completionResponse!.destroy(new Error("provider disconnected"));
			completionResponse = undefined;
			await expect
				.poll(() => server.catalog.get(SESSION_REQUEST).summary)
				.toMatchObject({
					state: "interrupted",
					lastTurnOutcome: "failed",
					unread: true,
				});
		} finally {
			server.beginShutdown();
			await server.waitForShutdown();
			completionResponse?.end("data: [DONE]\n\n");
			provider.closeAllConnections();
			await new Promise<void>((resolve) => provider.close(() => resolve()));
		}
	});

	it("projects a completed compaction entry, refreshes the summary, and reports an informational message when already compacted", async () => {
		const COMPACT_REQUEST = "00000000-0000-4000-8000-000000000110";
		const COMPACT_AGAIN_REQUEST = "00000000-0000-4000-8000-000000000111";
		let compactionRequests = 0;
		const provider = createServer(async (request, response) => {
			if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
				response.writeHead(404).end();
				return;
			}
			let body = "";
			for await (const chunk of request) body += chunk.toString();
			// Summarization requests (history or turn-prefix) wrap the transcript in a
			// `<conversation>` tag that normal chat turns never send.
			const isCompaction = body.includes("<conversation>");
			if (isCompaction) compactionRequests += 1;
			const content = isCompaction ? "## Goal\nVerify compaction projection." : "done";
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(
				`data: ${JSON.stringify({
					id: "chatcmpl-compact-test",
					object: "chat.completion.chunk",
					created: 1,
					model: "compact-test",
					choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
				})}\n\n` +
					`data: ${JSON.stringify({
						id: "chatcmpl-compact-test",
						object: "chat.completion.chunk",
						created: 1,
						model: "compact-test",
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
					})}\n\n` +
					`data: [DONE]\n\n`,
			);
		});
		const providerPort = await listen(provider);

		const root = mkdtempSync(join(tmpdir(), "app-server-compaction-"));
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
						models: [
							{
								id: "compact-test",
								name: "Compact Test",
								contextWindow: 32_000,
								maxTokens: 1_024,
							},
						],
					},
				},
			}),
		);
		// A tiny keepRecentTokens budget forces the single turn to split, so there
		// is always something to summarize without seeding a large fixture.
		writeFileSync(
			join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: "local",
				defaultModel: "compact-test",
				retry: { enabled: false },
				compaction: { keepRecentTokens: 1 },
			}),
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
		try {
			await connection.handle({
				jsonrpc: "2.0",
				id: "initialize",
				method: "initialize",
				params: { protocolVersion: 19, client: { name: "test", version: "1" }, capabilities: [] },
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
				id: "subscribe",
				method: "session/subscribe",
				params: { sessionId: SESSION_REQUEST },
			});
			await connection.handle({
				jsonrpc: "2.0",
				id: "turn",
				method: "turn/start",
				params: { sessionId: SESSION_REQUEST, requestId: TURN_REQUEST, text: "hello" },
			});
			await expect
				.poll(() => server.catalog.get(SESSION_REQUEST).summary)
				.toMatchObject({ state: "idle", lastTurnOutcome: "completed" });
			const updatedAtBefore = server.catalog.get(SESSION_REQUEST).summary.updatedAt;

			const compactResult = await connection.handle({
				jsonrpc: "2.0",
				id: "compact",
				method: "session/compact",
				params: { sessionId: SESSION_REQUEST, requestId: COMPACT_REQUEST },
			});
			expect(compactResult).toMatchObject({
				result: {
					sessionId: SESSION_REQUEST,
					tokensBefore: expect.any(Number),
					estimatedTokensAfter: expect.any(Number),
				},
			});
			expect("message" in (compactResult as { result: object }).result).toBe(false);
			expect(compactionRequests).toBe(1);

			// The compaction entry must be projected as a completed system item and
			// the session summary must refresh through the normal lifecycle path.
			const events = outbound.flatMap((message) =>
				"method" in message && message.method === "connection/events" ? message.params.events : [],
			);
			expect(
				events.some(
					(event) =>
						event.type === "item/completed" &&
						event.item.role === "system" &&
						event.item.content.some((block) => block.type === "compaction"),
				),
			).toBe(true);
			await expect.poll(() => server.catalog.get(SESSION_REQUEST).summary.updatedAt).not.toBe(updatedAtBefore);

			// A second compaction has nothing new to do; the runtime reports it as
			// an informational message rather than an error.
			const againResult = await connection.handle({
				jsonrpc: "2.0",
				id: "compact-again",
				method: "session/compact",
				params: { sessionId: SESSION_REQUEST, requestId: COMPACT_AGAIN_REQUEST },
			});
			expect(againResult).toMatchObject({
				result: {
					sessionId: SESSION_REQUEST,
					tokensBefore: 0,
					estimatedTokensAfter: null,
					message: "Already compacted",
				},
			});
			expect(compactionRequests).toBe(1);
		} finally {
			server.beginShutdown();
			await server.waitForShutdown();
			provider.closeAllConnections();
			await new Promise<void>((resolve) => provider.close(() => resolve()));
		}
	});
});
