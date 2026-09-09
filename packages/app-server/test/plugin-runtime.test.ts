import { once } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@metis/app-protocol";
import { OFFICIAL_MARKET_ID } from "@metis/coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppServer } from "../src/app-server.ts";
import type { ConnectionOutboundEnvelope } from "../src/connection.ts";

function crc32(bytes: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of bytes) {
		crc ^= byte;
		for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

function createZip(entries: Record<string, string | { readonly content: string; readonly mode: number }>): Buffer {
	const local: Buffer[] = [];
	const central: Buffer[] = [];
	let offset = 0;
	for (const [name, value] of Object.entries(entries)) {
		const fileName = Buffer.from(name);
		const bytes = Buffer.from(typeof value === "string" ? value : value.content);
		const mode = typeof value === "string" ? 0o100600 : value.mode;
		const checksum = crc32(bytes);
		const header = Buffer.alloc(30);
		header.writeUInt32LE(0x04034b50, 0);
		header.writeUInt16LE(20, 4);
		header.writeUInt32LE(checksum, 14);
		header.writeUInt32LE(bytes.length, 18);
		header.writeUInt32LE(bytes.length, 22);
		header.writeUInt16LE(fileName.length, 26);
		local.push(header, fileName, bytes);

		const directory = Buffer.alloc(46);
		directory.writeUInt32LE(0x02014b50, 0);
		directory.writeUInt16LE(0x0314, 4);
		directory.writeUInt16LE(20, 6);
		directory.writeUInt32LE(checksum, 16);
		directory.writeUInt32LE(bytes.length, 20);
		directory.writeUInt32LE(bytes.length, 24);
		directory.writeUInt16LE(fileName.length, 28);
		directory.writeUInt32LE((mode << 16) >>> 0, 38);
		directory.writeUInt32LE(offset, 42);
		central.push(directory, fileName);
		offset += header.length + fileName.length + bytes.length;
	}
	const directoryBytes = Buffer.concat(central);
	const end = Buffer.alloc(22);
	end.writeUInt32LE(0x06054b50, 0);
	end.writeUInt16LE(Object.keys(entries).length, 8);
	end.writeUInt16LE(Object.keys(entries).length, 10);
	end.writeUInt32LE(directoryBytes.length, 12);
	end.writeUInt32LE(offset, 16);
	return Buffer.concat([...local, directoryBytes, end]);
}

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
			id: "chatcmpl-plugin-runtime",
			object: "chat.completion.chunk",
			created: 1,
			model: "plugin-runtime-model",
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

describe("app-server plugin runtime end-to-end", () => {
	const temporaryRoots: string[] = [];
	const serversToClose: Server[] = [];
	const COMMIT_1 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

	afterEach(async () => {
		for (const s of serversToClose.splice(0)) {
			s.close();
		}
		for (const root of temporaryRoots.splice(0)) {
			rmSync(root, { recursive: true, force: true });
		}
	});

	function createPluginMockFetch() {
		const marketplaceJson = JSON.stringify({
			name: "official-market",
			plugins: [
				{
					name: "gatekeeper",
					description: "Gatekeeper plugin",
					source: "./plugins/gatekeeper",
				},
			],
		});

		const repoZip = createZip({
			[`repo-${COMMIT_1}/plugins/gatekeeper/.claude-plugin/plugin.json`]: JSON.stringify({
				name: "gatekeeper",
				description: "Gatekeeper plugin with UserPromptSubmit hook",
				hooks: "./hooks/hooks.json",
			}),
			[`repo-${COMMIT_1}/plugins/gatekeeper/hooks/hooks.json`]: JSON.stringify({
				hooks: {
					UserPromptSubmit: [
						{
							type: "command",
							command: `${process.execPath} -e "let d=''; process.stdin.on('data', c => d += c); process.stdin.on('end', () => { const j = JSON.parse(d); if (j.text && j.text.includes('danger')) { console.error('Blocked by plugin gatekeeper'); process.exit(2); } process.exit(0); });"`,
						},
					],
				},
			}),
		});

		return vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/repos/anthropics/claude-plugins-official")) {
				return new Response(JSON.stringify({ default_branch: "main" }));
			}
			if (url.endsWith("/commits/main")) {
				return new Response(JSON.stringify({ sha: COMMIT_1 }));
			}
			if (url.includes("/contents/.claude-plugin/marketplace.json")) {
				return new Response(marketplaceJson);
			}
			if (url.includes("codeload.github.com")) {
				return new Response(repoZip);
			}
			return new Response(null, { status: 404 });
		}) as typeof fetch;
	}

	it("activates plugin hook on next turn in existing open session", async () => {
		let providerRequestCount = 0;
		const provider = createServer(async (request, response) => {
			for await (const _ of request) {
			}
			providerRequestCount += 1;
			finishText(response, "Provider reply");
		});
		serversToClose.push(provider);
		const providerPort = await listen(provider);

		const root = mkdtempSync(join(tmpdir(), "metis-plugin-runtime-"));
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
								id: "plugin-runtime-model",
								name: "Plugin Runtime Model",
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
			JSON.stringify({ defaultProvider: "local", defaultModel: "plugin-runtime-model", retry: { enabled: false } }),
		);

		const fetchImpl = createPluginMockFetch();
		const server = await AppServer.create({
			agentDir,
			sessionsRoot,
			fetchImpl,
			titleGenerator: { generate: async () => undefined },
		});

		const connection = server.connect();
		const outbound: ConnectionOutboundEnvelope[] = [];
		connection.onMessage((msg) => {
			outbound.push(msg);
		});
		const events = () =>
			outbound.flatMap((m) => ("method" in m && m.method === "connection/events" ? m.params.events : []));

		await connection.handle({
			jsonrpc: "2.0",
			id: "init",
			method: "initialize",
			params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, capabilities: [] },
		});

		const sessionId = "00000000-0000-4000-8000-000000000001";
		await connection.handle({
			jsonrpc: "2.0",
			id: "create-session",
			method: "session/create",
			params: {
				requestId: sessionId,
				cwd: projectDir,
				permissionPreset: "full",
			},
		});

		await connection.handle({
			jsonrpc: "2.0",
			id: "open-session",
			method: "session/open",
			params: { sessionId },
		});

		await connection.handle({
			jsonrpc: "2.0",
			id: "sub-session",
			method: "session/subscribe",
			params: { sessionId },
		});

		// Turn 1: Normal turn without plugin
		await connection.handle({
			jsonrpc: "2.0",
			id: "turn-1",
			method: "turn/start",
			params: { sessionId, requestId: "20000000-0000-4000-8000-000000000001", text: "Hello" },
		});

		await expect.poll(() => providerRequestCount, { timeout: 10_000 }).toBe(1);

		// Install plugin via RPC while session is open
		const inspectRes = (await connection.handle({
			jsonrpc: "2.0",
			id: "inspect",
			method: "plugin/inspect",
			params: { sourceId: OFFICIAL_MARKET_ID, entryId: "entry-gatekeeper" },
		})) as { result: { inspectionId: string; registryRevision: number } };

		if (!inspectRes.result) console.log("INSPECT_RES_ERROR:", inspectRes);
		expect(inspectRes.result).toBeDefined();

		const installRes = (await connection.handle({
			jsonrpc: "2.0",
			id: "install",
			method: "plugin/install",
			params: {
				requestId: "30000000-0000-4000-8000-000000000001",
				inspectionId: inspectRes.result.inspectionId,
				expectedRevision: inspectRes.result.registryRevision,
			},
		})) as { result: { activation: string } };

		expect(installRes.result.activation).toBe("applied");

		// Turn 2: In the same session, submit prompt that triggers the newly installed plugin hook
		await connection.handle({
			jsonrpc: "2.0",
			id: "turn-2",
			method: "turn/start",
			params: { sessionId, requestId: "20000000-0000-4000-8000-000000000002", text: "Trigger danger hook" },
		});

		// Verify hook blocked the turn
		await expect
			.poll(() => events().some((e) => JSON.stringify(e).includes("Blocked by plugin gatekeeper")), {
				timeout: 10_000,
			})
			.toBe(true);

		// Provider was NOT called for Turn 2
		expect(providerRequestCount).toBe(1);
	}, 30_000);

	it("disables plugin capability on next turn when disabled during active turn", async () => {
		let providerRequestCount = 0;
		let releaseTurn1: () => void = () => {};

		const provider = createServer(async (request, response) => {
			for await (const _ of request) {
			}
			providerRequestCount += 1;
			if (providerRequestCount === 1) {
				// Delay Turn 1 completion until released
				await new Promise<void>((resolve) => {
					releaseTurn1 = resolve;
				});
			}
			finishText(response, "Provider reply");
		});
		serversToClose.push(provider);
		const providerPort = await listen(provider);

		const root = mkdtempSync(join(tmpdir(), "metis-plugin-runtime-"));
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
								id: "plugin-runtime-model",
								name: "Plugin Runtime Model",
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
			JSON.stringify({ defaultProvider: "local", defaultModel: "plugin-runtime-model", retry: { enabled: false } }),
		);

		const fetchImpl = createPluginMockFetch();
		const server = await AppServer.create({
			agentDir,
			sessionsRoot,
			fetchImpl,
			titleGenerator: { generate: async () => undefined },
		});

		const connection = server.connect();
		const outbound: ConnectionOutboundEnvelope[] = [];
		connection.onMessage((msg) => {
			outbound.push(msg);
		});

		await connection.handle({
			jsonrpc: "2.0",
			id: "init",
			method: "initialize",
			params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, capabilities: [] },
		});

		// Install plugin before opening session
		const inspectRes = (await connection.handle({
			jsonrpc: "2.0",
			id: "inspect",
			method: "plugin/inspect",
			params: { sourceId: OFFICIAL_MARKET_ID, entryId: "entry-gatekeeper" },
		})) as { result: { inspectionId: string; registryRevision: number; plugin: { id: string } } };

		expect(inspectRes.result).toBeDefined();

		const installRes = (await connection.handle({
			jsonrpc: "2.0",
			id: "install",
			method: "plugin/install",
			params: {
				requestId: "30000000-0000-4000-8000-000000000001",
				inspectionId: inspectRes.result.inspectionId,
				expectedRevision: inspectRes.result.registryRevision,
			},
		})) as { result: { registryRevision: number } };

		const pluginId = inspectRes.result.plugin.id;

		const sessionId = "00000000-0000-4000-8000-000000000002";
		await connection.handle({
			jsonrpc: "2.0",
			id: "create-session",
			method: "session/create",
			params: {
				requestId: sessionId,
				cwd: projectDir,
				permissionPreset: "full",
			},
		});

		await connection.handle({
			jsonrpc: "2.0",
			id: "open-session",
			method: "session/open",
			params: { sessionId },
		});

		await connection.handle({
			jsonrpc: "2.0",
			id: "sub-session",
			method: "session/subscribe",
			params: { sessionId },
		});

		// Start Turn 1 (will be held open by provider)
		void connection.handle({
			jsonrpc: "2.0",
			id: "turn-1",
			method: "turn/start",
			params: { sessionId, requestId: "20000000-0000-4000-8000-000000000001", text: "Run turn 1" },
		});

		// Wait until Turn 1 reaches provider
		await expect.poll(() => providerRequestCount, { timeout: 10_000 }).toBe(1);

		// While Turn 1 is actively running, disable the plugin via RPC
		const disableRes = (await connection.handle({
			jsonrpc: "2.0",
			id: "disable-plugin",
			method: "plugin/setEnabled",
			params: {
				requestId: "40000000-0000-4000-8000-000000000001",
				pluginId,
				enabled: false,
				expectedRevision: installRes.result.registryRevision,
			},
		})) as { result: { activation: string } };

		// Because session is currently running a turn, activation must report "next-turn"
		expect(disableRes.result.activation).toBe("next-turn");

		// Release Turn 1 to let it finish
		releaseTurn1();

		// Wait for session to return to idle
		await expect.poll(() => server.catalog.get(sessionId).summary.state, { timeout: 10_000 }).toBe("idle");

		// Now Turn 2: With plugin disabled, prompt should proceed without being blocked
		await connection.handle({
			jsonrpc: "2.0",
			id: "turn-2",
			method: "turn/start",
			params: { sessionId, requestId: "20000000-0000-4000-8000-000000000002", text: "Proceed danger normal" },
		});

		// Provider should be called for Turn 2!
		await expect.poll(() => providerRequestCount, { timeout: 10_000 }).toBe(2);
	}, 30_000);

	it("drains queued turns through turn admission boundary", async () => {
		let providerRequestCount = 0;
		let releaseTurn1: () => void = () => {};

		const provider = createServer(async (request, response) => {
			for await (const _ of request) {
			}
			providerRequestCount += 1;
			if (providerRequestCount === 1) {
				await new Promise<void>((resolve) => {
					releaseTurn1 = resolve;
				});
			}
			finishText(response, "Provider reply");
		});
		serversToClose.push(provider);
		const providerPort = await listen(provider);

		const root = mkdtempSync(join(tmpdir(), "metis-plugin-runtime-"));
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
								id: "plugin-runtime-model",
								name: "Plugin Runtime Model",
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
			JSON.stringify({ defaultProvider: "local", defaultModel: "plugin-runtime-model", retry: { enabled: false } }),
		);

		const fetchImpl = createPluginMockFetch();
		const server = await AppServer.create({
			agentDir,
			sessionsRoot,
			fetchImpl,
			titleGenerator: { generate: async () => undefined },
		});

		const connection = server.connect();
		const outbound: ConnectionOutboundEnvelope[] = [];
		connection.onMessage((msg) => {
			outbound.push(msg);
		});
		const events = () =>
			outbound.flatMap((m) => ("method" in m && m.method === "connection/events" ? m.params.events : []));

		await connection.handle({
			jsonrpc: "2.0",
			id: "init",
			method: "initialize",
			params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, capabilities: [] },
		});

		const sessionId = "00000000-0000-4000-8000-000000000003";
		await connection.handle({
			jsonrpc: "2.0",
			id: "create-session",
			method: "session/create",
			params: {
				requestId: sessionId,
				cwd: projectDir,
				permissionPreset: "full",
			},
		});

		await connection.handle({
			jsonrpc: "2.0",
			id: "open-session",
			method: "session/open",
			params: { sessionId },
		});

		await connection.handle({
			jsonrpc: "2.0",
			id: "sub-session",
			method: "session/subscribe",
			params: { sessionId },
		});

		// Turn 1 starts and pauses
		void connection.handle({
			jsonrpc: "2.0",
			id: "turn-1",
			method: "turn/start",
			params: { sessionId, requestId: "20000000-0000-4000-8000-000000000001", text: "Long turn" },
		});

		await expect.poll(() => providerRequestCount, { timeout: 10_000 }).toBe(1);

		// Queue Turn 2 while Turn 1 is active
		await connection.handle({
			jsonrpc: "2.0",
			id: "queue-turn-2",
			method: "turn/queue",
			params: { sessionId, requestId: "20000000-0000-4000-8000-000000000002", text: "Queued danger turn" },
		});

		// Install plugin while turn is active
		const inspectRes = (await connection.handle({
			jsonrpc: "2.0",
			id: "inspect",
			method: "plugin/inspect",
			params: { sourceId: OFFICIAL_MARKET_ID, entryId: "entry-gatekeeper" },
		})) as { result: { inspectionId: string; registryRevision: number } };

		await connection.handle({
			jsonrpc: "2.0",
			id: "install",
			method: "plugin/install",
			params: {
				requestId: "30000000-0000-4000-8000-000000000001",
				inspectionId: inspectRes.result.inspectionId,
				expectedRevision: inspectRes.result.registryRevision,
			},
		});

		// Complete Turn 1
		releaseTurn1();

		// Queued turn will drain and enter beforeTurnAdmission, which triggers ensurePluginsCurrent and runs the hook
		await expect
			.poll(() => events().some((e) => JSON.stringify(e).includes("Blocked by plugin gatekeeper")), {
				timeout: 10_000,
			})
			.toBe(true);
	}, 30_000);

	it("does not reload or emit redundant SessionStart during active execution", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-plugin-runtime-"));
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
						baseUrl: "http://127.0.0.1:9999/v1",
						apiKey: "test-key",
						api: "openai-completions",
						models: [{ id: "m", name: "m", contextWindow: 32_000, maxTokens: 1024, reasoning: false }],
					},
				},
			}),
		);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "m" }));

		const fetchImpl = createPluginMockFetch();
		const server = await AppServer.create({
			agentDir,
			sessionsRoot,
			fetchImpl,
			titleGenerator: { generate: async () => undefined },
		});

		const connection = server.connect();
		await connection.handle({
			jsonrpc: "2.0",
			id: "init",
			method: "initialize",
			params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, capabilities: [] },
		});

		const sessionId = "00000000-0000-4000-8000-000000000004";
		await connection.handle({
			jsonrpc: "2.0",
			id: "create-session",
			method: "session/create",
			params: {
				requestId: sessionId,
				cwd: projectDir,
				permissionPreset: "full",
			},
		});

		await connection.handle({
			jsonrpc: "2.0",
			id: "open-session",
			method: "session/open",
			params: { sessionId },
		});

		// Inspect opened runtime directly
		const ref = server.catalog.get(sessionId);
		const runtime = await server.registry.open(ref);
		expect(runtime).toBeDefined();

		// Calling ensurePluginsCurrent() when idle runs clean
		await expect(runtime.ensurePluginsCurrent?.()).resolves.toBeUndefined();

		// Mock runtime.isActive() to true (e.g. continuation turn during stop hook)
		const originalIsActive = runtime.isActive;
		let reloadCalled = false;
		// @ts-expect-error test override
		runtime.session.reload = async () => {
			reloadCalled = true;
		};
		runtime.isActive = () => true;

		try {
			await runtime.ensurePluginsCurrent?.();
			expect(reloadCalled).toBe(false);
		} finally {
			runtime.isActive = originalIsActive;
		}
	});

	it("retains session runtime and does not lose turns when reload fails", async () => {
		let providerRequestCount = 0;
		const provider = createServer(async (request, response) => {
			for await (const _ of request) {
			}
			providerRequestCount += 1;
			finishText(response, "Provider reply");
		});
		serversToClose.push(provider);
		const providerPort = await listen(provider);

		const root = mkdtempSync(join(tmpdir(), "metis-plugin-runtime-"));
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
						models: [{ id: "m", name: "m", contextWindow: 32_000, maxTokens: 1024, reasoning: false }],
					},
				},
			}),
		);
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "local", defaultModel: "m" }));

		const fetchImpl = createPluginMockFetch();
		const server = await AppServer.create({
			agentDir,
			sessionsRoot,
			fetchImpl,
			titleGenerator: { generate: async () => undefined },
		});

		const connection = server.connect();
		await connection.handle({
			jsonrpc: "2.0",
			id: "init",
			method: "initialize",
			params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, capabilities: [] },
		});

		const sessionId = "00000000-0000-4000-8000-000000000005";
		await connection.handle({
			jsonrpc: "2.0",
			id: "create-session",
			method: "session/create",
			params: {
				requestId: sessionId,
				cwd: projectDir,
				permissionPreset: "full",
			},
		});

		await connection.handle({
			jsonrpc: "2.0",
			id: "open-session",
			method: "session/open",
			params: { sessionId },
		});

		const ref = server.catalog.get(sessionId);
		const runtime = await server.registry.open(ref);
		// Force reload to throw an error
		// @ts-expect-error test mock
		runtime.session.reload = async () => {
			throw new Error("Simulated reload failure");
		};

		// Turn should not throw and should proceed to provider
		await connection.handle({
			jsonrpc: "2.0",
			id: "turn-resilient",
			method: "turn/start",
			params: { sessionId, requestId: "20000000-0000-4000-8000-000000000001", text: "Resilient input" },
		});

		await expect.poll(() => providerRequestCount, { timeout: 10_000 }).toBe(1);
	}, 30_000);
});
