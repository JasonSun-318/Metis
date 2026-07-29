import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
	ClientParams,
	ClientResult,
	RpcErrorResponse,
	ServerRpcRequest,
	SessionSnapshot,
	SessionSummary,
} from "@arcmind/app-protocol";
import { RPC_ERROR_CODES } from "@arcmind/app-protocol";
import { getManagedWorkspaceDir, ProjectTrustStore, SessionManager } from "@arcmind/coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppServer } from "../src/app-server.ts";
import {
	type DurableSessionMutation,
	type PreparedSessionMutation,
	prepareSessionMutation,
} from "../src/durable-mutation.ts";
import type {
	OpenedSessionRuntime,
	SessionEventListener,
	SessionRef,
	SessionRuntimeHost,
} from "../src/session-runtime-host.ts";

const REQUEST_A = "00000000-0000-4000-8000-000000000001";
const REQUEST_B = "00000000-0000-4000-8000-000000000002";
const REQUEST_C = "00000000-0000-4000-8000-000000000003";

class FakeRuntime implements OpenedSessionRuntime {
	readonly sessionId: string;
	private readonly ref: SessionRef;
	active = false;
	closed = false;
	startCalls = 0;

	constructor(ref: SessionRef) {
		this.ref = ref;
		this.sessionId = ref.summary.sessionId;
	}

	isActive(): boolean {
		return this.active;
	}

	hasPendingInteractions(): boolean {
		return false;
	}

	getSummary(): SessionSummary {
		return { ...this.ref.summary, state: this.active ? "running" : "idle" };
	}

	async listSkills(): Promise<ClientResult<"skill/list">> {
		return { skills: [{ name: "pdf", description: "Read and create PDF documents" }] };
	}

	async readItems(_input: ClientParams<"session/readItems">): Promise<ClientResult<"session/readItems">> {
		return { items: [], nextBeforeItemId: null };
	}

	async readSubagentItems(_input: ClientParams<"subagent/readItems">): Promise<ClientResult<"subagent/readItems">> {
		return { items: [], nextBeforeItemId: null };
	}

	async setThinkingSelection(
		input: ClientParams<"session/setThinkingSelection">,
	): Promise<ClientResult<"session/setThinkingSelection">> {
		return {
			thinkingSelection: input.selection,
			actualThinkingLevel: input.selection === "ultra" ? "max" : input.selection,
			availableThinkingSelections: ["off", "high", "ultra"],
		};
	}

	async setModel(input: ClientParams<"session/setModel">): Promise<ClientResult<"session/setModel">> {
		return {
			model: { provider: input.provider, modelId: input.modelId },
			thinkingSelection: "high",
			actualThinkingLevel: "high",
			availableThinkingSelections: ["off", "high", "max"],
		};
	}

	async snapshot(serverEpoch: string, currentCursor: () => number): Promise<SessionSnapshot> {
		return {
			session: this.getSummary(),
			turns: [],
			recentItems: [],
			nextBeforeItemId: null,
			activeTurnId: null,
			pendingInteractions: [],
			thinkingSelection: "high",
			actualThinkingLevel: "high",
			availableThinkingSelections: ["off", "high", "ultra"],
			subagents: [],
			serverEpoch,
			cursor: currentCursor(),
		};
	}

	async startTurn(input: ClientParams<"turn/start">): Promise<ClientResult<"turn/start">> {
		this.startCalls += 1;
		return { operationId: input.requestId, status: "accepted" };
	}

	async steer(input: ClientParams<"turn/steer">): Promise<ClientResult<"turn/steer">> {
		return { operationId: input.requestId, status: "accepted" };
	}

	async interrupt(input: ClientParams<"turn/interrupt">): Promise<ClientResult<"turn/interrupt">> {
		this.active = false;
		return { operationId: input.requestId, status: "accepted" };
	}

	async prepareMutation(_input: DurableSessionMutation): Promise<PreparedSessionMutation> {
		const manager = SessionManager.open(this.ref.path);
		try {
			return prepareSessionMutation(manager, _input);
		} finally {
			manager.close();
		}
	}

	subscribe(_listener: SessionEventListener): () => void {
		return () => undefined;
	}

	async close(): Promise<void> {
		this.closed = true;
	}
}

class FakeHost implements SessionRuntimeHost {
	readonly runtimes = new Map<string, FakeRuntime>();
	readonly listSkills = vi.fn(
		async (): Promise<ClientResult<"skill/list">> => ({
			skills: [{ name: "global", description: "A global Skill" }],
		}),
	);
	readonly open = vi.fn(async (ref: SessionRef): Promise<FakeRuntime> => {
		const runtime = new FakeRuntime(ref);
		this.runtimes.set(runtime.sessionId, runtime);
		return runtime;
	});
}

function initialize(id = "initialize") {
	return {
		jsonrpc: "2.0" as const,
		id,
		method: "initialize" as const,
		params: { protocolVersion: 6, client: { name: "test", version: "1" }, capabilities: [] },
	};
}

function writeSession(root: string, sessionId: string, cwd: string, tail = ""): string {
	const directory = join(root, "project");
	mkdirSync(directory, { recursive: true });
	const path = join(directory, `${sessionId}.jsonl`);
	writeFileSync(
		path,
		`${JSON.stringify({
			type: "session",
			version: 5,
			id: sessionId,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
		})}\n${tail}`,
	);
	return path;
}

function expectError(response: unknown, code: number): RpcErrorResponse {
	expect(response).toMatchObject({ jsonrpc: "2.0", error: { code } });
	return response as RpcErrorResponse;
}

describe("AppServer", () => {
	let tempDir: string;
	let agentDir: string;
	let sessionsRoot: string;
	let projectDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "app-server-test-"));
		agentDir = join(tempDir, "agent");
		sessionsRoot = join(agentDir, "sessions");
		projectDir = join(tempDir, "project");
		mkdirSync(projectDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("prunes stale document work directories on startup", async () => {
		const stale = join(agentDir, "tmp", "document-work", "stale");
		mkdirSync(stale, { recursive: true });
		const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
		utimesSync(stale, expired, expired);

		await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });

		expect(existsSync(stale)).toBe(false);
	});

	it("enforces initialization and protocol version per connection", async () => {
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const connection = server.connect();

		expectError(
			await connection.handle({ jsonrpc: "2.0", id: "list", method: "session/list", params: {} }),
			RPC_ERROR_CODES.NOT_INITIALIZED,
		);
		expectError(
			await connection.handle({
				...initialize("wrong-version"),
				params: { ...initialize().params, protocolVersion: 1 },
			}),
			RPC_ERROR_CODES.PROTOCOL_MISMATCH,
		);
		const initialized = await connection.handle(initialize());
		expect(initialized).toMatchObject({
			result: { protocolVersion: 6, server: { name: "arcmind-app-server" }, serverEpoch: server.serverEpoch },
		});
		expectError(await connection.handle(initialize("again")), RPC_ERROR_CODES.INVALID_REQUEST);
	});

	it("does not invoke an invalid envelope id getter while correlating the error", async () => {
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const connection = server.connect();
		let reads = 0;
		const request = { jsonrpc: "invalid", method: "session/list", params: {} } as Record<string, unknown>;
		Object.defineProperty(request, "id", {
			enumerable: true,
			get() {
				reads += 1;
				throw new Error("getter must not be retried");
			},
		});

		const response = await connection.handle(request);
		expect(response).toMatchObject({ id: null, error: { code: RPC_ERROR_CODES.INVALID_REQUEST } });
		expect(reads).toBe(0);
	});

	it("hosts two sessions lazily in one server and closes only the requested runtime", async () => {
		writeSession(sessionsRoot, "session-a", projectDir);
		writeSession(sessionsRoot, "session-b", projectDir);
		const host = new FakeHost();
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: host });
		const connection = server.connect();
		await connection.handle(initialize());

		const listed = await connection.handle({ jsonrpc: "2.0", id: "list", method: "session/list", params: {} });
		expect(listed).toMatchObject({ result: { sessions: [{}, {}] } });
		expect(
			(listed as { result: { sessions: SessionSummary[] } }).result.sessions
				.map((session) => session.sessionId)
				.sort(),
		).toEqual(["session-a", "session-b"]);
		expect(host.open).not.toHaveBeenCalled();
		await Promise.all([
			connection.handle({
				jsonrpc: "2.0",
				id: "open-a",
				method: "session/open",
				params: { sessionId: "session-a" },
			}),
			connection.handle({
				jsonrpc: "2.0",
				id: "open-b",
				method: "session/open",
				params: { sessionId: "session-b" },
			}),
		]);
		expect(host.open).toHaveBeenCalledTimes(2);

		await connection.handle({
			jsonrpc: "2.0",
			id: "close-a",
			method: "session/close",
			params: { sessionId: "session-a", requestId: REQUEST_A },
		});
		expect(host.runtimes.get("session-a")?.closed).toBe(true);
		expect(host.runtimes.get("session-b")?.closed).toBe(false);
	});

	it("routes replay-protected model selection through the opened runtime", async () => {
		writeSession(sessionsRoot, "session-a", projectDir);
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const connection = server.connect();
		await connection.handle(initialize());
		await connection.handle({
			jsonrpc: "2.0",
			id: "open",
			method: "session/open",
			params: { sessionId: "session-a" },
		});

		const response = await connection.handle({
			jsonrpc: "2.0",
			id: "set-model",
			method: "session/setModel",
			params: {
				sessionId: "session-a",
				requestId: REQUEST_A,
				provider: "xiaomi",
				modelId: "mimo-v2.5-pro",
			},
		});

		expect(response).toMatchObject({
			result: {
				model: { provider: "xiaomi", modelId: "mimo-v2.5-pro" },
				availableThinkingSelections: ["off", "high", "max"],
			},
		});
	});

	it("lists draft and opened-session skills through their owning runtime boundary", async () => {
		writeSession(sessionsRoot, "session-a", projectDir);
		const host = new FakeHost();
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: host });
		const connection = server.connect();
		await connection.handle(initialize());

		expect(
			await connection.handle({ jsonrpc: "2.0", id: "skills-draft", method: "skill/list", params: { cwd: null } }),
		).toMatchObject({ result: { skills: [{ name: "global" }] } });
		expect(host.open).not.toHaveBeenCalled();
		expect(
			await connection.handle({
				jsonrpc: "2.0",
				id: "skills-session",
				method: "skill/list",
				params: { sessionId: "session-a" },
			}),
		).toMatchObject({ result: { skills: [{ name: "pdf" }] } });
		expect(host.open).toHaveBeenCalledOnce();
	});

	it("lists draft skills without creating a session or trusting project resources", async () => {
		const writeSkill = (root: string, name: string, description: string) => {
			const directory = join(root, name);
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n`);
		};
		writeSkill(join(agentDir, "skills"), "global-skill", "Available to every session");
		writeSkill(join(projectDir, ".arcmind", "skills"), "project-skill", "Available only after trust");
		const server = await AppServer.create({ agentDir, sessionsRoot });
		const connection = server.connect();
		await connection.handle(initialize());

		const untrusted = await connection.handle({
			jsonrpc: "2.0",
			id: "skills-untrusted",
			method: "skill/list",
			params: { cwd: projectDir },
		});
		const untrustedNames = (untrusted as { result: ClientResult<"skill/list"> }).result.skills.map(
			(skill) => skill.name,
		);
		expect(untrustedNames).toContain("global-skill");
		expect(untrustedNames).not.toContain("project-skill");
		expect(server.catalog.list({}).sessions).toEqual([]);

		new ProjectTrustStore(agentDir).set(projectDir, true);
		const trusted = await connection.handle({
			jsonrpc: "2.0",
			id: "skills-trusted",
			method: "skill/list",
			params: { cwd: projectDir },
		});
		const trustedSkills = (trusted as { result: ClientResult<"skill/list"> }).result.skills;
		const trustedNames = trustedSkills.map((skill) => skill.name);
		expect(trustedNames).toEqual(expect.arrayContaining(["global-skill", "project-skill"]));
		expect(trustedSkills.find((skill) => skill.name === "global-skill")?.source).toBe("user");
		expect(trustedSkills.find((skill) => skill.name === "project-skill")?.source).toBe("project");
		expect(trustedSkills.find((skill) => skill.name === "pdf")?.source).toBe("system");
	});

	it("replays an identical mutation and rejects changed parameters", async () => {
		writeSession(sessionsRoot, "session-a", projectDir);
		const host = new FakeHost();
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: host });
		const connection = server.connect();
		await connection.handle(initialize());
		const request = {
			jsonrpc: "2.0" as const,
			id: "turn-1",
			method: "turn/start" as const,
			params: { sessionId: "session-a", requestId: REQUEST_A, text: "hello" },
		};

		const first = await connection.handle(request);
		const second = await connection.handle({ ...request, id: "turn-1-replay" });
		expect(second).toMatchObject({ result: (first as { result: unknown }).result });
		expect(host.runtimes.get("session-a")?.startCalls).toBe(1);
		expectError(
			await connection.handle({ ...request, id: "turn-1-reused", params: { ...request.params, text: "changed" } }),
			RPC_ERROR_CODES.REQUEST_ID_REUSED,
		);
	});

	it("applies replayed close cleanup to the calling connection and rejects unknown sessions", async () => {
		writeSession(sessionsRoot, "session-a", projectDir);
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const first = server.connect();
		const second = server.connect();
		await Promise.all([first.handle(initialize("first")), second.handle(initialize("second"))]);
		const request = {
			jsonrpc: "2.0" as const,
			id: "close-first",
			method: "session/close" as const,
			params: { sessionId: "session-a", requestId: REQUEST_A },
		};
		await first.handle({
			jsonrpc: "2.0",
			id: "subscribe-first",
			method: "session/subscribe",
			params: { sessionId: "session-a" },
		});
		expect(first.state.subscriptions.has("session-a")).toBe(true);
		await first.handle(request);
		expect(first.state.subscriptions.has("session-a")).toBe(false);

		await second.handle({
			jsonrpc: "2.0",
			id: "subscribe-second",
			method: "session/subscribe",
			params: { sessionId: "session-a" },
		});
		expect(second.state.subscriptions.has("session-a")).toBe(true);
		await second.handle({ ...request, id: "close-replay" });
		expect(second.state.subscriptions.has("session-a")).toBe(false);
		expectError(
			await second.handle({
				...request,
				id: "close-missing",
				params: { sessionId: "missing", requestId: REQUEST_B },
			}),
			RPC_ERROR_CODES.NOT_FOUND,
		);
	});

	it("normalizes create names and refuses a request id already claimed by duplicate journals", async () => {
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const connection = server.connect();
		await connection.handle(initialize());
		const create = {
			jsonrpc: "2.0" as const,
			id: "create",
			method: "session/create" as const,
			params: { requestId: REQUEST_A, cwd: projectDir, name: "  hello\nworld  " },
		};
		const created = await connection.handle(create);
		expect(created).toMatchObject({ result: { session: { sessionId: REQUEST_A, name: "hello world" } } });
		expect(await connection.handle({ ...create, id: "create-replay" })).toMatchObject({
			result: { session: { sessionId: REQUEST_A, name: "hello world" } },
		});

		writeSession(sessionsRoot, REQUEST_B, projectDir);
		writeSession(join(sessionsRoot, "duplicate-root"), REQUEST_B, projectDir);
		await server.catalog.refresh();
		expectError(
			await connection.handle({
				...create,
				id: "create-duplicate",
				params: { requestId: REQUEST_B, cwd: projectDir },
			}),
			RPC_ERROR_CODES.REQUEST_ID_REUSED,
		);
	});

	it("replays a completed create after its working directory is removed", async () => {
		const firstServer = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const first = firstServer.connect();
		await first.handle(initialize("first"));
		const create = {
			jsonrpc: "2.0" as const,
			id: "create",
			method: "session/create" as const,
			params: { requestId: REQUEST_A, mode: "chat" as const, cwd: projectDir, name: "durable replay" },
		};
		const created = await first.handle(create);
		firstServer.beginShutdown();
		await firstServer.waitForShutdown();
		rmSync(projectDir, { recursive: true, force: true });
		const secondServer = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const second = secondServer.connect();
		await second.handle(initialize("second"));

		expect(await second.handle({ ...create, id: "create-replay" })).toEqual({
			...created,
			id: "create-replay",
		});
	});

	it("creates managed and folder-backed chat sessions with durable mode metadata", async () => {
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const connection = server.connect();
		await connection.handle(initialize());
		const managedCreate = {
			jsonrpc: "2.0" as const,
			id: "create-managed-chat",
			method: "session/create" as const,
			params: { requestId: REQUEST_A, mode: "chat" as const, name: "Managed chat" },
		};

		const managed = await connection.handle(managedCreate);
		const managedCwd = realpathSync(getManagedWorkspaceDir(REQUEST_A, agentDir));
		expect(managed).toMatchObject({
			result: {
				session: {
					sessionId: REQUEST_A,
					mode: "chat",
					cwdOrigin: "managed",
					cwd: managedCwd,
				},
			},
		});
		expect(existsSync(managedCwd)).toBe(true);
		expect(await connection.handle({ ...managedCreate, id: "create-managed-chat-replay" })).toMatchObject({
			result: { session: { sessionId: REQUEST_A, cwd: managedCwd } },
		});

		const manager = SessionManager.open(server.catalog.get(REQUEST_A).path);
		try {
			expect(manager.getMode()).toBe("chat");
			expect(manager.getCwdOrigin()).toBe("managed");
		} finally {
			manager.close();
		}

		const selected = await connection.handle({
			jsonrpc: "2.0",
			id: "create-folder-chat",
			method: "session/create",
			params: { requestId: REQUEST_B, mode: "chat", cwd: projectDir },
		});
		expect(selected).toMatchObject({
			result: {
				session: {
					sessionId: REQUEST_B,
					mode: "chat",
					cwdOrigin: "user-selected",
					cwd: realpathSync(projectDir),
				},
			},
		});

		expectError(
			await connection.handle({
				...managedCreate,
				id: "reuse-managed-chat-id",
				params: { requestId: REQUEST_A, mode: "code" },
			}),
			RPC_ERROR_CODES.REQUEST_ID_REUSED,
		);
	});

	it("replays create durably and rejects reusing its id for a turn after restart", async () => {
		const firstServer = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const first = firstServer.connect();
		await first.handle(initialize("first"));
		const create = {
			jsonrpc: "2.0" as const,
			id: "create",
			method: "session/create" as const,
			params: { requestId: REQUEST_A, cwd: projectDir, name: "desktop session" },
		};
		await first.handle(create);
		firstServer.beginShutdown();
		await firstServer.waitForShutdown();

		const secondServer = await AppServer.create({ agentDir, sessionsRoot });
		const second = secondServer.connect();
		await second.handle(initialize("second"));
		expect(await second.handle({ ...create, id: "create-replay" })).toMatchObject({
			result: { session: { sessionId: REQUEST_A, name: "desktop session" } },
		});
		await second.handle({
			jsonrpc: "2.0",
			id: "open",
			method: "session/open",
			params: { sessionId: REQUEST_A },
		});
		expectError(
			await second.handle({
				jsonrpc: "2.0",
				id: "turn-with-create-id",
				method: "turn/start",
				params: { sessionId: REQUEST_A, requestId: REQUEST_A, text: "must not run" },
			}),
			RPC_ERROR_CODES.REQUEST_ID_REUSED,
		);
		secondServer.beginShutdown();
		await secondServer.waitForShutdown();
	});

	it.runIf(process.platform !== "win32")("does not follow symlinked catalog directories", async () => {
		const outside = join(tempDir, "outside");
		writeSession(outside, "outside-session", projectDir);
		mkdirSync(sessionsRoot, { recursive: true });
		symlinkSync(outside, join(sessionsRoot, "linked"), "dir");
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const connection = server.connect();
		await connection.handle(initialize());

		const response = await connection.handle({ jsonrpc: "2.0", id: "list", method: "session/list", params: {} });
		expect(response).toMatchObject({ result: { sessions: [] } });
	});

	it("lists corrupt journals without parsing valid transcript tails", async () => {
		writeSession(sessionsRoot, "header-only", projectDir, `${"x".repeat(128 * 1024)}\n`);
		mkdirSync(sessionsRoot, { recursive: true });
		writeFileSync(join(sessionsRoot, "broken.jsonl"), "not-json\n");
		const host = new FakeHost();
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: host });
		const connection = server.connect();
		await connection.handle(initialize());

		const response = await connection.handle({ jsonrpc: "2.0", id: "list", method: "session/list", params: {} });
		const sessions = (response as { result: { sessions: SessionSummary[] } }).result.sessions;
		expect(sessions.find((session) => session.sessionId === "header-only")?.state).toBe("idle");
		const corrupt = sessions.find((session) => session.state === "corrupt");
		expect(corrupt?.sessionId).toMatch(/^corrupt-/);
		expectError(
			await connection.handle({
				jsonrpc: "2.0",
				id: "open-corrupt",
				method: "session/open",
				params: { sessionId: corrupt!.sessionId },
			}),
			RPC_ERROR_CODES.SESSION_CORRUPT,
		);
		expect(host.open).not.toHaveBeenCalled();
	});

	it("archives and restores a closed journal without deleting it", async () => {
		const source = writeSession(sessionsRoot, "session-a", projectDir);
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const connection = server.connect();
		await connection.handle(initialize());

		const archived = await connection.handle({
			jsonrpc: "2.0",
			id: "archive",
			method: "session/archive",
			params: { sessionId: "session-a", requestId: REQUEST_B },
		});
		expect(archived).toMatchObject({ result: { session: { sessionId: "session-a", archived: true } } });
		expect(() => readFileSync(source)).toThrow();

		const restored = await connection.handle({
			jsonrpc: "2.0",
			id: "unarchive",
			method: "session/unarchive",
			params: { sessionId: "session-a", requestId: REQUEST_C },
		});
		expect(restored).toMatchObject({ result: { session: { sessionId: "session-a", archived: false } } });
		expect(readFileSync(source, "utf8")).toContain('"id":"session-a"');
	});

	it("replays completed session mutations from the journal after process restarts", async () => {
		const source = writeSession(sessionsRoot, "session-a", projectDir);
		const firstServer = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const first = firstServer.connect();
		await first.handle(initialize("first"));
		const archive = {
			jsonrpc: "2.0" as const,
			id: "archive",
			method: "session/archive" as const,
			params: { sessionId: "session-a", requestId: REQUEST_B },
		};
		await first.handle(archive);
		await first.handle({
			jsonrpc: "2.0",
			id: "unarchive",
			method: "session/unarchive",
			params: { sessionId: "session-a", requestId: REQUEST_C },
		});
		firstServer.beginShutdown();
		await firstServer.waitForShutdown();

		const secondServer = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const second = secondServer.connect();
		await second.handle(initialize("second"));
		const replayed = await second.handle({ ...archive, id: "archive-replay" });
		expect(replayed).toMatchObject({ result: { session: { sessionId: "session-a", archived: true } } });
		expect(readFileSync(source, "utf8")).toContain('"id":"session-a"');
		secondServer.beginShutdown();
		await secondServer.waitForShutdown();

		const thirdServer = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const third = thirdServer.connect();
		await third.handle(initialize("third"));
		expectError(
			await third.handle({
				jsonrpc: "2.0",
				id: "reused-as-unarchive",
				method: "session/unarchive",
				params: { sessionId: "session-a", requestId: REQUEST_B },
			}),
			RPC_ERROR_CODES.REQUEST_ID_REUSED,
		);
	});

	it("scopes durable request ids to one session across process restarts", async () => {
		writeSession(sessionsRoot, "session-a", projectDir);
		writeSession(sessionsRoot, "session-b", projectDir);
		const archive = (sessionId: string, id: string) => ({
			jsonrpc: "2.0" as const,
			id,
			method: "session/archive" as const,
			params: { sessionId, requestId: REQUEST_A },
		});
		const firstServer = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const first = firstServer.connect();
		await first.handle(initialize("first"));
		expect(await first.handle(archive("session-a", "archive-a"))).toMatchObject({
			result: { session: { sessionId: "session-a", archived: true } },
		});
		expect(await first.handle(archive("session-b", "archive-b"))).toMatchObject({
			result: { session: { sessionId: "session-b", archived: true } },
		});
		firstServer.beginShutdown();
		await firstServer.waitForShutdown();

		const secondServer = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const second = secondServer.connect();
		await second.handle(initialize("second"));
		expect(await second.handle(archive("session-a", "archive-a-replay"))).toMatchObject({
			result: { session: { sessionId: "session-a", archived: true } },
		});
		expect(await second.handle(archive("session-b", "archive-b-replay"))).toMatchObject({
			result: { session: { sessionId: "session-b", archived: true } },
		});
		expectError(
			await second.handle({
				jsonrpc: "2.0",
				id: "reuse-in-session-a",
				method: "session/unarchive",
				params: { sessionId: "session-a", requestId: REQUEST_A },
			}),
			RPC_ERROR_CODES.REQUEST_ID_REUSED,
		);
	});

	it("does not repeat a journal-completed close against a later reopened runtime", async () => {
		writeSession(sessionsRoot, "session-a", projectDir);
		const firstHost = new FakeHost();
		const firstServer = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: firstHost });
		const first = firstServer.connect();
		await first.handle(initialize("first"));
		await first.handle({ jsonrpc: "2.0", id: "open", method: "session/open", params: { sessionId: "session-a" } });
		const close = {
			jsonrpc: "2.0" as const,
			id: "close",
			method: "session/close" as const,
			params: { sessionId: "session-a", requestId: REQUEST_A },
		};
		await first.handle(close);
		expect(firstHost.runtimes.get("session-a")?.closed).toBe(true);
		firstServer.beginShutdown();
		await firstServer.waitForShutdown();

		const secondHost = new FakeHost();
		const secondServer = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: secondHost });
		const second = secondServer.connect();
		await second.handle(initialize("second"));
		await second.handle({ jsonrpc: "2.0", id: "reopen", method: "session/open", params: { sessionId: "session-a" } });
		const replayed = await second.handle({ ...close, id: "close-replay" });
		expect(replayed).toMatchObject({ result: { sessionId: "session-a", closed: true } });
		expect(secondHost.runtimes.get("session-a")?.closed).toBe(false);
	});

	it("gracefully closes all runtimes after host shutdown", async () => {
		writeSession(sessionsRoot, "session-a", projectDir);
		writeSession(sessionsRoot, "session-b", projectDir);
		const host = new FakeHost();
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: host });
		const connection = server.connect();
		await connection.handle(initialize());
		await Promise.all(
			["session-a", "session-b"].map((sessionId) =>
				connection.handle({
					jsonrpc: "2.0",
					id: `open-${sessionId}`,
					method: "session/open",
					params: { sessionId },
				}),
			),
		);

		const response = await server.handleHost({
			jsonrpc: "2.0",
			id: "shutdown",
			method: "server/shutdown",
			params: { requestId: REQUEST_A },
		});
		expect(response).toMatchObject({ result: { accepted: true } });
		await server.waitForShutdown();
		expect([...host.runtimes.values()].every((runtime) => runtime.closed)).toBe(true);
	});

	it("opens the production runtime offline without loading untrusted project resources", async () => {
		const projectConfig = join(projectDir, ".arcmind");
		mkdirSync(join(projectConfig, "extensions"), { recursive: true });
		writeFileSync(
			join(projectConfig, "extensions", "must-not-load.ts"),
			"throw new Error('untrusted resource loaded');\n",
		);
		const manager = SessionManager.create(projectDir, join(sessionsRoot, "project"));
		const sessionId = manager.getSessionId();
		const internalPath = "/private/attachments/token-report.pdf";
		manager.appendMessage({
			role: "user",
			content: `<attachment>${JSON.stringify({ name: "report.pdf", path: internalPath, size: 12 })}</attachment> ${"x".repeat(2 * 1024 * 1024)}`,
			timestamp: Date.now(),
		});
		manager.close();
		const server = await AppServer.create({ agentDir, sessionsRoot });
		const connection = server.connect();
		await connection.handle(initialize());

		const opened = await connection.handle({
			jsonrpc: "2.0",
			id: "open-production",
			method: "session/open",
			params: { sessionId },
		});
		expect(opened).toMatchObject({ result: { session: { sessionId, cwd: projectDir } } });
		const subscribed = await connection.handle({
			jsonrpc: "2.0",
			id: "subscribe-production",
			method: "session/subscribe",
			params: { sessionId },
		});
		expect(subscribed).toMatchObject({
			result: { snapshot: { session: { sessionId }, pendingInteractions: [] } },
		});
		const recentItems = (subscribed as { result: { snapshot: SessionSnapshot } }).result.snapshot.recentItems;
		expect(recentItems).toHaveLength(1);
		expect(Buffer.byteLength(JSON.stringify(recentItems[0]), "utf8")).toBeLessThan(20 * 1024);
		expect(JSON.stringify(recentItems[0])).toContain("[report.pdf]");
		expect(JSON.stringify(recentItems[0])).not.toContain(internalPath);

		await connection.handle({
			jsonrpc: "2.0",
			id: "close-production",
			method: "session/close",
			params: { sessionId, requestId: REQUEST_C },
		});
		server.beginShutdown();
		await server.waitForShutdown();
		expect(() => server.connect()).toThrow(expect.objectContaining({ code: "BUSY" }));
	});

	it("resolves parent and session-only trust before binding project extension UI", async () => {
		const parentProject = join(tempDir, "parent-scope", "project");
		const sessionProject = join(tempDir, "session-scope", "project");
		for (const cwd of [parentProject, sessionProject]) {
			const extensionDir = join(cwd, ".arcmind", "extensions");
			mkdirSync(extensionDir, { recursive: true });
			writeFileSync(
				join(extensionDir, "interaction.ts"),
				`export default function (arcmind) {
					arcmind.on("session_start", async (_event, ctx) => {
						await ctx.ui.confirm("Extension loaded", "The trusted project extension is active.");
					});
				}
`,
			);
		}

		const server = await AppServer.create({ agentDir, sessionsRoot });
		const connection = server.connect();
		const interactions: ServerRpcRequest[] = [];
		connection.onMessage((envelope) => {
			if (!("method" in envelope) || envelope.method !== "interaction/request") return;
			interactions.push(envelope);
			const interaction = envelope.params.interaction;
			if (interaction.kind === "project_trust") {
				const label =
					interaction.projectPath === realpathSync(parentProject)
						? "Trust parent folder"
						: "Trust (this session only)";
				const choice = interaction.choices.find((candidate) => candidate.label.startsWith(label));
				if (!choice) throw new Error(`Missing project trust choice: ${label}`);
				connection.handleServerResponse({
					jsonrpc: "2.0",
					id: envelope.id,
					result: { interactionId: interaction.interactionId, kind: "project_trust", choiceId: choice.id },
				});
				return;
			}
			connection.handleServerResponse({
				jsonrpc: "2.0",
				id: envelope.id,
				result: { interactionId: interaction.interactionId, kind: "confirm", confirmed: true },
			});
		});
		await connection.handle(initialize());

		for (const [requestId, cwd] of [
			[REQUEST_A, parentProject],
			[REQUEST_B, sessionProject],
		] as const) {
			await connection.handle({
				jsonrpc: "2.0",
				id: `create-${requestId}`,
				method: "session/create",
				params: { requestId, cwd },
			});
			const opened = await connection.handle({
				jsonrpc: "2.0",
				id: `open-${requestId}`,
				method: "session/open",
				params: { sessionId: requestId },
			});
			expect(opened).toMatchObject({ result: { session: { sessionId: requestId, cwd: realpathSync(cwd) } } });
		}

		expect(interactions.map((request) => request.params.interaction.kind)).toEqual([
			"project_trust",
			"confirm",
			"project_trust",
			"confirm",
		]);
		const trustStore = new ProjectTrustStore(agentDir);
		expect(trustStore.getEntry(parentProject)).toEqual({
			path: realpathSync(dirname(parentProject)),
			decision: true,
		});
		expect(trustStore.getEntry(sessionProject)).toBeNull();

		server.beginShutdown();
		await server.waitForShutdown();
	});
});
