import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, type ServerRpcRequest } from "@metis/app-protocol";
import { getSessionAgentDir, SessionManager } from "@metis/coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { AppServer } from "../src/app-server.ts";
import type { ConnectionOutboundEnvelope } from "../src/connection.ts";

const SESSION_ID = "00000000-0000-4000-8000-000000000201";
const TURN_ID = "00000000-0000-4000-8000-000000000202";

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
			id: "chatcmpl-agent-e2e",
			object: "chat.completion.chunk",
			created: 1,
			model: "agent-e2e",
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

function finishToolCall(response: ServerResponse, id: string, name: string, args: object): void {
	beginStream(response);
	chunk(response, {
		role: "assistant",
		tool_calls: [
			{
				index: 0,
				id,
				type: "function",
				function: { name, arguments: JSON.stringify(args) },
			},
		],
	});
	chunk(response, {}, "tool_calls");
	response.end("data: [DONE]\n\n");
}

describe("agent runtime e2e", () => {
	const temporaryRoots: string[] = [];

	afterEach(() => {
		for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("streams a nested child through the real app server and completes the user lifecycle", async () => {
		let rootSpawned = false;
		let coordinatorSpawned = false;
		let leafToolRequested = false;
		let leafResponse: ServerResponse | undefined;
		let reviewerWritePath = "";
		const provider = createServer(async (request, response) => {
			let raw = "";
			for await (const part of request) raw += part.toString();
			const body = JSON.parse(raw) as { messages?: unknown[] };
			const messages = (body.messages ?? []) as Array<{ role?: string; content?: unknown }>;
			const latestUser = [...messages].reverse().find((message) => message.role === "user")?.content;
			const userText = JSON.stringify(latestUser ?? "");
			const isCoordinator = userText.includes("Coordinate a nested review");
			const isLeaf = userText.includes("Inspect the nested boundary");

			if (isLeaf && !leafToolRequested) {
				leafToolRequested = true;
				leafResponse = response;
				beginStream(response);
				chunk(response, { role: "assistant", content: "leaf-live" });
				chunk(response, {
					tool_calls: [
						{
							index: 0,
							id: "call-reviewer-write",
							type: "function",
							function: {
								name: "bash",
								arguments: JSON.stringify({ command: `printf blocked > ${reviewerWritePath}` }),
							},
						},
					],
				});
				return;
			}
			if (isLeaf) {
				finishText(response, "Reviewer write attempt was contained.");
				return;
			}
			if (isCoordinator && !coordinatorSpawned) {
				coordinatorSpawned = true;
				finishToolCall(response, "call-leaf", "spawn_agent", {
					name: "Leaf",
					task: "Inspect the nested boundary",
					agentType: "reviewer",
				});
				return;
			}
			if (isCoordinator) {
				finishText(response, "Coordinator delegated the nested check.");
				return;
			}
			if (!rootSpawned) {
				rootSpawned = true;
				finishToolCall(response, "call-coordinator", "spawn_agent", {
					name: "Coordinator",
					task: "Coordinate a nested review",
					agentType: "worker",
				});
				return;
			}
			finishText(response, "Root accepted the asynchronous handoff.");
		});
		const providerPort = await listen(provider);
		const root = mkdtempSync(join(tmpdir(), "app-server-agent-e2e-"));
		temporaryRoots.push(root);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		const sessionsRoot = join(agentDir, "sessions");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		reviewerWritePath = join(projectDir, "reviewer-write.txt");
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
								id: "agent-e2e",
								name: "Agent E2E",
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
			JSON.stringify({ defaultProvider: "local", defaultModel: "agent-e2e", retry: { enabled: false } }),
		);

		const server = await AppServer.create({
			agentDir,
			sessionsRoot,
			titleGenerator: { generate: async () => undefined },
		});
		const connection = server.connect();
		const outbound: ConnectionOutboundEnvelope[] = [];
		let permissionApprovals = 0;
		connection.onMessage((message) => {
			outbound.push(message);
			if (!("method" in message) || message.method !== "interaction/request") return;
			const request = message as ServerRpcRequest<"interaction/request">;
			const interaction = request.params.interaction;
			if (interaction.kind !== "select" || interaction.presentation !== "permission_approval") return;
			permissionApprovals += 1;
			connection.handleServerResponse({
				jsonrpc: "2.0",
				id: request.id,
				result: {
					interactionId: interaction.interactionId,
					kind: "select",
					choiceId: "permission:allow-once",
				},
			});
		});
		const events = () =>
			outbound.flatMap((message) =>
				"method" in message && message.method === "connection/events" ? message.params.events : [],
			);
		try {
			await connection.handle({
				jsonrpc: "2.0",
				id: "initialize",
				method: "initialize",
				params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, capabilities: [] },
			});
			await connection.handle({
				jsonrpc: "2.0",
				id: "create",
				method: "session/create",
				params: { requestId: SESSION_ID, cwd: projectDir, permissionMode: "full" },
			});
			await connection.handle({
				jsonrpc: "2.0",
				id: "open",
				method: "session/open",
				params: { sessionId: SESSION_ID },
			});
			await connection.handle({
				jsonrpc: "2.0",
				id: "subscribe",
				method: "session/subscribe",
				params: { sessionId: SESSION_ID },
			});
			await connection.handle({
				jsonrpc: "2.0",
				id: "turn",
				method: "turn/start",
				params: { sessionId: SESSION_ID, requestId: TURN_ID, text: "Delegate a nested review." },
			});

			await expect.poll(() => leafResponse !== undefined, { timeout: 10_000 }).toBe(true);
			let agents: Array<{
				agentId: string;
				name: string;
				parentSessionId: string;
				depth: number;
				status: string;
			}> = [];
			await expect
				.poll(async () => {
					const response = await connection.handle({
						jsonrpc: "2.0",
						id: "agents-running",
						method: "agent/list",
						params: { sessionId: SESSION_ID, includeArchived: true, afterAgentId: null, limit: 100 },
					});
					if (!("result" in response) || !("agents" in response.result)) return response;
					agents = response.result.agents;
					return agents.map((agent) => ({ name: agent.name, depth: agent.depth, status: agent.status }));
				})
				.toEqual(
					expect.arrayContaining([
						expect.objectContaining({ name: "Coordinator", depth: 1 }),
						expect.objectContaining({ name: "Leaf", depth: 2, status: "running" }),
					]),
				);
			const coordinator = agents.find((agent) => agent.name === "Coordinator")!;
			const leaf = agents.find((agent) => agent.name === "Leaf")!;
			expect(leaf.parentSessionId).toBe(coordinator.agentId);
			await expect
				.poll(() => events().some((event) => event.type === "agent/item/delta" && event.agentId === leaf.agentId))
				.toBe(true);

			const liveRead = await connection.handle({
				jsonrpc: "2.0",
				id: "read-live",
				method: "agent/readItems",
				params: { sessionId: SESSION_ID, agentId: leaf.agentId, limit: 100 },
			});
			expect(JSON.stringify(liveRead)).toContain("leaf-live");

			chunk(leafResponse!, {}, "tool_calls");
			leafResponse!.end("data: [DONE]\n\n");
			leafResponse = undefined;
			await expect
				.poll(async () => {
					const response = await connection.handle({
						jsonrpc: "2.0",
						id: "agents-done",
						method: "agent/list",
						params: { sessionId: SESSION_ID, includeArchived: true, afterAgentId: null, limit: 100 },
					});
					if (!("result" in response) || !("agents" in response.result)) return [];
					return response.result.agents.map((agent) => agent.status);
				})
				.toEqual(["done", "done"]);
			expect(permissionApprovals).toBe(2);
			expect(existsSync(reviewerWritePath)).toBe(false);

			const archived = await connection.handle({
				jsonrpc: "2.0",
				id: "archive-leaf",
				method: "agent/archive",
				params: {
					sessionId: SESSION_ID,
					agentId: leaf.agentId,
					archived: true,
					requestId: "00000000-0000-4000-8000-000000000203",
				},
			});
			expect(archived).toMatchObject({ result: { agent: { agentId: leaf.agentId, archived: true } } });
			const deleted = await connection.handle({
				jsonrpc: "2.0",
				id: "delete-tree",
				method: "agent/delete",
				params: {
					sessionId: SESSION_ID,
					agentId: coordinator.agentId,
					requestId: "00000000-0000-4000-8000-000000000204",
				},
			});
			expect(deleted).toMatchObject({
				result: { agentId: coordinator.agentId, status: "deleted" },
			});
			expect(events()).toContainEqual(
				expect.objectContaining({
					type: "agent/deleted",
					agentId: coordinator.agentId,
					deletedAgentIds: expect.arrayContaining([coordinator.agentId, leaf.agentId]),
				}),
			);
		} finally {
			leafResponse?.end("data: [DONE]\n\n");
			server.beginShutdown();
			await server.waitForShutdown();
			provider.closeAllConnections();
			await new Promise<void>((resolve) => provider.close(() => resolve()));
		}
	}, 30_000);

	it("pages a 105-agent durable tree and replays an agent mutation exactly once", async () => {
		const root = mkdtempSync(join(tmpdir(), "app-server-agent-pagination-e2e-"));
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
						baseUrl: "http://127.0.0.1:9/v1",
						apiKey: "test-key",
						api: "openai-completions",
						models: [
							{
								id: "agent-e2e",
								name: "Agent E2E",
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
			JSON.stringify({ defaultProvider: "local", defaultModel: "agent-e2e", retry: { enabled: false } }),
		);
		const rootManager = SessionManager.create(projectDir, sessionsRoot, {
			id: SESSION_ID,
			mode: "code",
			permissionPreset: "full",
		});
		for (let index = 0; index < 105; index++) {
			const agentId = `00000000-0000-4000-8000-${String(index + 300).padStart(12, "0")}`;
			const child = SessionManager.create(projectDir, getSessionAgentDir(agentDir, SESSION_ID), {
				id: agentId,
				mode: "code",
				permissionPreset: "full",
				agent: {
					agentId,
					name: `Worker ${String(index + 1).padStart(3, "0")}`,
					agentType: "worker",
					initialTask: `Task ${index + 1}`,
					tools: ["read"],
					writePolicy: "inherit",
					permissionPreset: "full",
					model: { provider: "local", modelId: "agent-e2e" },
					thinkingLevel: "off",
					cwd: projectDir,
					forkTurns: 0,
					timeoutSeconds: 60,
					mayDelegate: false,
					parentSessionId: SESSION_ID,
					rootSessionId: SESSION_ID,
					agentPath: [agentId],
				},
			});
			child.appendAgentControl({
				type: "agent_task",
				agentId,
				taskId: `task-${index + 1}`,
				text: `Task ${index + 1}`,
				taskSummary: `Task ${index + 1}`,
				status: "done",
				reason: "completed",
				finalMessage: `Done ${index + 1}`,
			});
			child.close();
		}
		rootManager.close();

		const server = await AppServer.create({
			agentDir,
			sessionsRoot,
			titleGenerator: { generate: async () => undefined },
		});
		const connection = server.connect();
		try {
			await connection.handle({
				jsonrpc: "2.0",
				id: "initialize-pagination",
				method: "initialize",
				params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, capabilities: [] },
			});
			await connection.handle({
				jsonrpc: "2.0",
				id: "open-pagination",
				method: "session/open",
				params: { sessionId: SESSION_ID },
			});
			const first = await connection.handle({
				jsonrpc: "2.0",
				id: "agents-first",
				method: "agent/list",
				params: { sessionId: SESSION_ID, includeArchived: true, afterAgentId: null, limit: 100 },
			});
			expect(first).toMatchObject({ result: { agents: expect.any(Array), nextAfterAgentId: expect.any(String) } });
			if (!("result" in first) || !("agents" in first.result)) throw new Error("Expected first agent page");
			expect(first.result.agents).toHaveLength(100);
			const second = await connection.handle({
				jsonrpc: "2.0",
				id: "agents-second",
				method: "agent/list",
				params: {
					sessionId: SESSION_ID,
					includeArchived: true,
					afterAgentId: first.result.nextAfterAgentId,
					limit: 100,
				},
			});
			if (!("result" in second) || !("agents" in second.result)) throw new Error("Expected second agent page");
			expect(second.result.agents).toHaveLength(5);
			expect(second.result.nextAfterAgentId).toBeNull();
			expect(new Set([...first.result.agents, ...second.result.agents].map((agent) => agent.agentId)).size).toBe(
				105,
			);

			const target = second.result.agents[0]!;
			const request = {
				jsonrpc: "2.0" as const,
				id: "archive-agent",
				method: "agent/archive" as const,
				params: {
					sessionId: SESSION_ID,
					agentId: target.agentId,
					archived: true,
					requestId: "00000000-0000-4000-8000-000000000205",
				},
			};
			const archived = await connection.handle(request);
			const replayed = await connection.handle({ ...request, id: "archive-agent-replay" });
			expect(replayed).toEqual({ ...archived, id: "archive-agent-replay" });
		} finally {
			server.beginShutdown();
			await server.waitForShutdown();
		}
	}, 90_000);
});
