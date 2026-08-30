import { mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION, RPC_ERROR_CODES } from "@metis/app-protocol";
import { SessionManager } from "@metis/coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { AppServer } from "../src/app-server.ts";

const directories: string[] = [];
const servers = new Set<AppServer>();

afterEach(async () => {
	for (const server of servers) server.beginShutdown();
	await Promise.all([...servers].map((server) => server.waitForShutdown().catch(() => undefined)));
	servers.clear();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function createSession(name: string): SessionManager {
	const directory = mkdtempSync(join(tmpdir(), "metis-fork-"));
	directories.push(directory);
	return SessionManager.create(directory, directory, { id: name, mode: "chat", cwdOrigin: "user-selected" });
}

function userMsg(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

function assistantMsg(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

describe("session fork branch creation", () => {
	it("resolves the durable entry id for the exact appended message object", () => {
		const session = createSession("original");
		const message = assistantMsg("reply");
		const entryId = session.appendMessage(message);

		expect(session.getMessageEntryId(message)).toBe(entryId);
		session.close();
	});

	it("creates an independent branch at an assistant reply with a fresh id and forked name", () => {
		const session = createSession("original");
		const user = session.appendMessage(userMsg("hello"));
		const assistant = session.appendMessage(assistantMsg("reply"));
		void user;

		// The app-server fork implementation performs exactly these steps:
		// createBranchedSessionManager(entryId) then appendSessionInfo(name).
		const branch = session.createBranchedSessionManager(assistant);
		const forkedName = "fork original";
		branch.appendSessionInfo(forkedName);
		const forkedId = branch.getSessionId();
		expect(forkedId).not.toBe("original");
		const sessionFile = branch.getSessionFile();
		expect(sessionFile).toBeDefined();
		branch.close();

		// The forked session is an independent, persisted file that carries the
		// branch path (including the assistant reply) and the forked name.
		const reopened = SessionManager.open(sessionFile!);
		try {
			expect(reopened.getSessionId()).toBe(forkedId);
			expect(reopened.getSessionName()).toBe(forkedName);
			const entries = reopened.getEntries().filter((entry) => entry.type === "message");
			expect(entries.map((entry) => entry.message.role)).toEqual(["user", "assistant"]);
		} finally {
			reopened.close();
		}

		// The original session is untouched and remains open.
		expect(session.getSessionId()).toBe("original");
		expect(session.getEntries()).toHaveLength(2);
		session.close();
	});

	it("rejects forking from an unknown entry id", () => {
		const session = createSession("original");
		session.appendMessage(userMsg("hello"));

		expect(() => session.createBranchedSessionManager("does-not-exist")).toThrow("Entry does-not-exist not found");
		session.close();
	});

	it("forks from a user message with the same branch semantics", () => {
		const session = createSession("original");
		const user = session.appendMessage(userMsg("hello"));
		session.appendMessage(assistantMsg("reply"));

		const branch = session.createBranchedSessionManager(user);
		const forkedId = branch.getSessionId();
		expect(forkedId).not.toBe("original");
		const sessionFile = branch.getSessionFile()!;
		branch.close();

		const reopened = SessionManager.open(sessionFile);
		try {
			const entries = reopened.getEntries().filter((entry) => entry.type === "message");
			// Branch rooted at the user message keeps only that message.
			expect(entries.map((entry) => entry.message.role)).toEqual(["user"]);
		} finally {
			reopened.close();
		}
		session.close();
	});
});

describe("session/fork RPC end-to-end", () => {
	it("forks a real session through the dispatcher and exposes the forked session in the catalog", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-fork-e2e-"));
		directories.push(root);
		const agentDir = join(root, "agent");
		const sessionsRoot = join(agentDir, "sessions");
		const projectDir = join(root, "project");
		mkdirSync(projectDir, { recursive: true });

		// Create a real session file with a user message and an assistant reply.
		const manager = SessionManager.create(projectDir, join(sessionsRoot, "dir"), {
			id: "source-session",
			mode: "chat",
			cwdOrigin: "user-selected",
		});
		manager.appendSessionInfo("Original title");
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		const assistantId = manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "reply" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		manager.close();

		const server = await AppServer.create({ agentDir, sessionsRoot });
		servers.add(server);
		const connection = server.connect();
		try {
			const init = await connection.handle({
				jsonrpc: "2.0",
				id: "init-1",
				method: "initialize",
				params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, capabilities: [] },
			});
			expect(init).toMatchObject({ jsonrpc: "2.0", result: { protocolVersion: PROTOCOL_VERSION } });

			const open = await connection.handle({
				jsonrpc: "2.0",
				id: "open-1",
				method: "session/open",
				params: { sessionId: "source-session" },
			});
			expect(open).toMatchObject({
				jsonrpc: "2.0",
				result: { session: { sessionId: "source-session" } },
			});

			const forked = await connection.handle({
				jsonrpc: "2.0",
				id: "fork-1",
				method: "session/fork",
				params: {
					requestId: "00000000-0000-4000-8000-0000000000f1",
					sessionId: "source-session",
					entryId: assistantId,
				},
			});
			expect(forked).toMatchObject({
				jsonrpc: "2.0",
				result: {
					session: { name: "fork Original title", mode: "chat" },
					entryId: assistantId,
				},
			});
			const forkedResult = forked as { result?: { session?: { sessionId?: string } } };
			const forkedId = forkedResult.result?.session?.sessionId;
			expect(forkedId).toBeDefined();
			expect(forkedId).not.toBe("source-session");

			// The forked session is visible in the catalog (sidebar list).
			const listed = await connection.handle({
				jsonrpc: "2.0",
				id: "list-1",
				method: "session/list",
				params: {},
			});
			const sessions =
				(listed as { result?: { sessions?: { sessionId?: string; name?: string }[] } }).result?.sessions ?? [];
			expect(sessions.some((s) => s.sessionId === forkedId && s.name === "fork Original title")).toBe(true);

			// The original session remains listed and switchable.
			expect(sessions.some((s) => s.sessionId === "source-session")).toBe(true);
			const reopened = await connection.handle({
				jsonrpc: "2.0",
				id: "open-2",
				method: "session/open",
				params: { sessionId: "source-session" },
			});
			expect(reopened).toMatchObject({
				jsonrpc: "2.0",
				result: { session: { sessionId: "source-session" } },
			});

			// Opening the forked session must also succeed (the desktop
			// navigates to it right after forking).
			const openForked = await connection.handle({
				jsonrpc: "2.0",
				id: "open-3",
				method: "session/open",
				params: { sessionId: forkedId },
			});
			expect(openForked).toMatchObject({
				jsonrpc: "2.0",
				result: { session: { sessionId: forkedId } },
			});
		} finally {
			connection.close();
		}
	});

	it("replays a persisted fork after an app-server restart without creating a duplicate", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-fork-restart-"));
		directories.push(root);
		const agentDir = join(root, "agent");
		const sessionsRoot = join(agentDir, "sessions");
		const projectDir = join(root, "project");
		mkdirSync(projectDir, { recursive: true });
		const manager = SessionManager.create(projectDir, join(sessionsRoot, "dir"), {
			id: "restart-source",
			mode: "chat",
			cwdOrigin: "user-selected",
		});
		const entryId = manager.appendMessage(userMsg("fork once"));
		manager.close();
		const otherManager = SessionManager.create(projectDir, join(sessionsRoot, "dir"), {
			id: "restart-other-source",
			mode: "chat",
			cwdOrigin: "user-selected",
		});
		const otherEntryId = otherManager.appendMessage(userMsg("fork separately"));
		otherManager.close();
		const request = {
			jsonrpc: "2.0" as const,
			id: "fork-before-restart",
			method: "session/fork" as const,
			params: {
				requestId: "00000000-0000-4000-8000-0000000000f3",
				sessionId: "restart-source",
				entryId,
			},
		};

		const run = async (server: AppServer, id: string, input = request) => {
			const connection = server.connect();
			await connection.handle({
				jsonrpc: "2.0",
				id: `init-${id}`,
				method: "initialize",
				params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, capabilities: [] },
			});
			await connection.handle({
				jsonrpc: "2.0",
				id: `open-${id}`,
				method: "session/open",
				params: { sessionId: input.params.sessionId },
			});
			const result = await connection.handle({ ...input, id: `fork-${id}` });
			connection.close();
			return result as { result?: { session?: { sessionId?: string } } };
		};

		const firstServer = await AppServer.create({ agentDir, sessionsRoot });
		servers.add(firstServer);
		const first = await run(firstServer, "one");
		const firstForkId = first.result?.session?.sessionId;
		expect(firstForkId).toBeDefined();
		firstServer.beginShutdown();
		await firstServer.waitForShutdown();
		servers.delete(firstServer);

		const secondServer = await AppServer.create({ agentDir, sessionsRoot });
		servers.add(secondServer);
		const targetConnection = secondServer.connect();
		await targetConnection.handle({
			jsonrpc: "2.0",
			id: "init-target",
			method: "initialize",
			params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, capabilities: [] },
		});
		await targetConnection.handle({
			jsonrpc: "2.0",
			id: "open-target",
			method: "session/open",
			params: { sessionId: firstForkId! },
		});
		const second = await run(secondServer, "two");
		const other = await run(secondServer, "other", {
			...request,
			params: { ...request.params, sessionId: "restart-other-source", entryId: otherEntryId },
		});
		targetConnection.close();

		expect(second.result?.session?.sessionId).toBe(firstForkId);
		expect(other.result?.session?.sessionId).toBeDefined();
		expect(other.result?.session?.sessionId).not.toBe(firstForkId);
		const files = await import("node:fs/promises").then(({ readdir }) => readdir(sessionsRoot, { recursive: true }));
		expect(files.filter((file) => file.endsWith(`_${firstForkId}.jsonl`))).toHaveLength(1);
	});

	it("replays a fork of a fork after restart while preserving its ancestor marker", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-nested-fork-restart-"));
		directories.push(root);
		const agentDir = join(root, "agent");
		const sessionsRoot = join(agentDir, "sessions");
		const projectDir = join(root, "project");
		mkdirSync(projectDir, { recursive: true });
		const source = SessionManager.create(projectDir, join(sessionsRoot, "dir"), {
			id: "nested-source",
			mode: "chat",
			cwdOrigin: "user-selected",
		});
		const sourceEntryId = source.appendMessage(userMsg("first generation"));
		source.close();

		const initialize = async (server: AppServer, suffix: string) => {
			const connection = server.connect();
			await connection.handle({
				jsonrpc: "2.0",
				id: `init-${suffix}`,
				method: "initialize",
				params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, capabilities: [] },
			});
			return connection;
		};
		const firstServer = await AppServer.create({ agentDir, sessionsRoot });
		servers.add(firstServer);
		const firstConnection = await initialize(firstServer, "first");
		await firstConnection.handle({
			jsonrpc: "2.0",
			id: "open-first",
			method: "session/open",
			params: { sessionId: "nested-source" },
		});
		const firstFork = (await firstConnection.handle({
			jsonrpc: "2.0",
			id: "fork-first",
			method: "session/fork",
			params: {
				requestId: "00000000-0000-4000-8000-0000000000f4",
				sessionId: "nested-source",
				entryId: sourceEntryId,
			},
		})) as { result?: { session?: { sessionId?: string } } };
		const firstForkId = firstFork.result?.session?.sessionId;
		expect(firstForkId).toBeDefined();
		firstConnection.close();
		firstServer.beginShutdown();
		await firstServer.waitForShutdown();
		servers.delete(firstServer);

		const firstForkRelativePath = readdirSync(sessionsRoot, { recursive: true, encoding: "utf8" }).find((path) =>
			path.endsWith(`_${firstForkId}.jsonl`),
		);
		expect(firstForkRelativePath).toBeDefined();
		const firstForkManager = SessionManager.open(join(sessionsRoot, firstForkRelativePath!));
		const nestedEntryId = firstForkManager.appendMessage(userMsg("second generation"));
		firstForkManager.close();
		const nestedRequest = {
			jsonrpc: "2.0" as const,
			method: "session/fork" as const,
			params: {
				requestId: "00000000-0000-4000-8000-0000000000f5",
				sessionId: firstForkId!,
				entryId: nestedEntryId,
			},
		};

		const secondServer = await AppServer.create({ agentDir, sessionsRoot });
		servers.add(secondServer);
		const secondConnection = await initialize(secondServer, "second");
		await secondConnection.handle({
			jsonrpc: "2.0",
			id: "open-second",
			method: "session/open",
			params: { sessionId: firstForkId! },
		});
		const nestedFork = (await secondConnection.handle({ ...nestedRequest, id: "fork-second" })) as {
			result?: { session?: { sessionId?: string } };
		};
		secondConnection.close();
		secondServer.beginShutdown();
		await secondServer.waitForShutdown();
		servers.delete(secondServer);

		const thirdServer = await AppServer.create({ agentDir, sessionsRoot });
		servers.add(thirdServer);
		const thirdConnection = await initialize(thirdServer, "third");
		await thirdConnection.handle({
			jsonrpc: "2.0",
			id: "open-third",
			method: "session/open",
			params: { sessionId: firstForkId! },
		});
		const replay = (await thirdConnection.handle({ ...nestedRequest, id: "fork-third" })) as {
			result?: { session?: { sessionId?: string } };
		};
		thirdConnection.close();

		expect(replay.result?.session?.sessionId).toBe(nestedFork.result?.session?.sessionId);
	});

	it("rejects an unknown live item id instead of forking from the latest assistant entry", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-fork-e2e-live-"));
		directories.push(root);
		const agentDir = join(root, "agent");
		const sessionsRoot = join(agentDir, "sessions");
		const projectDir = join(root, "project");
		mkdirSync(projectDir, { recursive: true });

		const manager = SessionManager.create(projectDir, join(sessionsRoot, "dir"), {
			id: "live-session",
			mode: "chat",
			cwdOrigin: "user-selected",
		});
		manager.appendSessionInfo("Live title");
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "live reply" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "test",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		});
		manager.close();

		const server = await AppServer.create({ agentDir, sessionsRoot });
		servers.add(server);
		const connection = server.connect();
		try {
			await connection.handle({
				jsonrpc: "2.0",
				id: "init-1",
				method: "initialize",
				params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, capabilities: [] },
			});
			const forked = await connection.handle({
				jsonrpc: "2.0",
				id: "fork-1",
				method: "session/fork",
				params: {
					requestId: "00000000-0000-4000-8000-0000000000f2",
					sessionId: "live-session",
					entryId: "live:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				},
			});
			expect(forked).toMatchObject({
				jsonrpc: "2.0",
				error: {
					code: RPC_ERROR_CODES.NOT_FOUND,
					data: { sessionId: "live-session" },
				},
			});
		} finally {
			connection.close();
		}
	});
});
