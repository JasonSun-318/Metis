import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	unlinkSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type {
	AgentMode,
	ClientParams,
	ClientResult,
	RpcErrorResponse,
	ServerRpcRequest,
	SessionSnapshot,
	SessionSummary,
} from "@arcmind/app-protocol";
import { RPC_ERROR_CODES } from "@arcmind/app-protocol";
import {
	getDefaultSessionDir,
	getManagedWorkspaceDir,
	getSessionDisplayMetadataPath,
	ProjectTrustStore,
	SessionManager,
} from "@arcmind/coding-agent";
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
const REQUEST_D = "00000000-0000-4000-8000-000000000004";

class FakeRuntime implements OpenedSessionRuntime {
	readonly sessionId: string;
	private readonly ref: SessionRef;
	active = false;
	pendingInteractions = false;
	closed = false;
	startCalls = 0;
	sessionName: string | undefined;

	constructor(ref: SessionRef) {
		this.ref = ref;
		this.sessionId = ref.summary.sessionId;
	}

	isActive(): boolean {
		return this.active;
	}

	hasPendingInteractions(): boolean {
		return this.pendingInteractions;
	}

	getSummary(): SessionSummary {
		return {
			...this.ref.summary,
			...(this.sessionName ? { name: this.sessionName } : {}),
			state: this.active ? "running" : "idle",
		};
	}

	async renameSession(name: string): Promise<SessionSummary> {
		this.sessionName = name.trim();
		return this.getSummary();
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

	async setPermissionMode(
		input: ClientParams<"session/setPermissionMode">,
	): Promise<ClientResult<"session/setPermissionMode">> {
		return { permissionMode: input.permissionMode };
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
			permissionMode: "ask",
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
		params: { protocolVersion: 7, client: { name: "test", version: "1" }, capabilities: [] },
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

function writeModeSession(
	agentDir: string,
	sessionsRoot: string,
	sessionId: string,
	cwd: string,
	mode: AgentMode,
	options: {
		archived?: boolean;
		cwdOrigin?: "managed" | "user-selected";
		scheduled?: { taskId: string; runId: string };
	} = {},
): string {
	const storageKey = basename(getDefaultSessionDir(cwd, agentDir));
	const directory = options.archived ? join(sessionsRoot, ".archive", storageKey) : join(sessionsRoot, storageKey);
	mkdirSync(directory, { recursive: true });
	const path = join(directory, `${sessionId}.jsonl`);
	writeFileSync(
		path,
		`${JSON.stringify({
			type: "session",
			version: 10,
			id: sessionId,
			timestamp: "2026-01-01T00:00:00.000Z",
			cwd,
			mode,
			cwdOrigin: options.cwdOrigin ?? "user-selected",
			...(options.scheduled ? { scheduled: options.scheduled } : {}),
		})}\n`,
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
		vi.restoreAllMocks();
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("fails startup visibly when interrupted project Trash recovery is ambiguous", async () => {
		const recovery = vi.spyOn(SessionManager, "recoverInterruptedProjectTrash").mockImplementation(() => {
			throw new Error("ambiguous project Trash manifest");
		});

		await expect(AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() })).rejects.toThrow(
			"ambiguous project Trash manifest",
		);
		expect(recovery).toHaveBeenCalledWith(agentDir);
	});

	it("prunes stale document work directories on startup", async () => {
		const stale = join(agentDir, "tmp", "document-work", "stale");
		mkdirSync(stale, { recursive: true });
		const expired = new Date(Date.now() - 25 * 60 * 60 * 1000);
		utimesSync(stale, expired, expired);

		await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });

		expect(existsSync(stale)).toBe(false);
	});

	it("restores persisted session names and caches unchanged journal metadata", async () => {
		const path = writeSession(sessionsRoot, "named-session", projectDir);
		const manager = SessionManager.open(path);
		manager.appendSessionInfo("Persisted name");
		manager.close();

		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		expect(server.catalog.list({}).sessions).toMatchObject([{ sessionId: "named-session", name: "Persisted name" }]);
		expect(server.catalog.updateSummary("named-session", { cwd: projectDir }).cwd).toBe(realpathSync(projectDir));
		const cache = (server.catalog as unknown as { sessionNames: Map<string, unknown> }).sessionNames;
		const cached = cache.get(path);
		expect(cached).toBeDefined();
		await server.catalog.refresh();
		expect(server.catalog.list({}).sessions).toMatchObject([{ sessionId: "named-session", name: "Persisted name" }]);
		expect(cache.get(path)).toBe(cached);
	});

	it("migrates a legacy session name once into bounded display metadata", async () => {
		const path = writeSession(sessionsRoot, "legacy-named-session", projectDir);
		appendFileSync(
			path,
			`${JSON.stringify({
				type: "session_info",
				id: "legacy-name-entry",
				parentId: null,
				timestamp: new Date().toISOString(),
				name: "Legacy name",
			})}\n`,
		);
		const metadataPath = getSessionDisplayMetadataPath(path);
		expect(existsSync(metadataPath)).toBe(false);

		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		expect(server.catalog.list({}).sessions).toMatchObject([
			{ sessionId: "legacy-named-session", name: "Legacy name" },
		]);
		expect(existsSync(metadataPath)).toBe(true);

		const cold = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		expect(cold.catalog.list({}).sessions).toMatchObject([
			{ sessionId: "legacy-named-session", name: "Legacy name" },
		]);
	});

	it("drops a cached name when the same journal inode is truncated", async () => {
		const path = writeSession(sessionsRoot, "truncated-name", projectDir);
		const manager = SessionManager.open(path);
		manager.appendSessionInfo("Old name");
		manager.close();
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		expect(server.catalog.get("truncated-name").summary.name).toBe("Old name");

		const [header] = readFileSync(path, "utf8").split("\n");
		writeFileSync(path, `${header}\n`);
		await server.catalog.refresh();

		expect(server.catalog.get("truncated-name").summary.name).toBeUndefined();
	});

	it("keeps a growing journal idle when optional name discovery races an append", async () => {
		const path = writeSession(
			sessionsRoot,
			"growing-session",
			projectDir,
			`${`${"x".repeat(8 * 1024)}\n`.repeat(1024)}`,
		);
		let writing = true;
		const writer = (async () => {
			while (writing) {
				appendFileSync(path, '{"type":"message"}\n');
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
		})();

		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		writing = false;
		await writer;

		expect(server.catalog.list({}).sessions).toMatchObject([{ sessionId: "growing-session", state: "idle" }]);
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
			result: { protocolVersion: 7, server: { name: "arcmind-app-server" }, serverEpoch: server.serverEpoch },
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

	it("publishes one canonical cwd for aliased project journals", async () => {
		const alias = join(tempDir, "project-alias");
		symlinkSync(projectDir, alias, "dir");
		writeModeSession(agentDir, sessionsRoot, "aliased-project", alias, "chat");
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const connection = server.connect();
		await connection.handle(initialize());

		const listed = await connection.handle({ jsonrpc: "2.0", id: "list-alias", method: "session/list", params: {} });
		expect(listed).toMatchObject({
			result: { sessions: [{ sessionId: "aliased-project", cwd: realpathSync(projectDir) }] },
		});
	});

	it("creates new sessions in an aliased project's existing storage directory", async () => {
		const alias = join(tempDir, "project-alias");
		symlinkSync(projectDir, alias, "dir");
		const existingPath = writeModeSession(agentDir, sessionsRoot, "aliased-project", alias, "chat");
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const connection = server.connect();
		await connection.handle(initialize());

		expect(
			await connection.handle({
				jsonrpc: "2.0",
				id: "create-in-alias",
				method: "session/create",
				params: { requestId: REQUEST_A, mode: "chat", cwd: realpathSync(projectDir) },
			}),
		).toMatchObject({ result: { session: { sessionId: REQUEST_A, cwd: realpathSync(projectDir) } } });
		expect(dirname(server.catalog.get(REQUEST_A).path)).toBe(dirname(existingPath));

		const preview = await connection.handle({
			jsonrpc: "2.0",
			id: "preview-alias",
			method: "project/deletePreview",
			params: { mode: "chat", cwd: realpathSync(projectDir) },
		});
		const revision = (preview as { result: ClientResult<"project/deletePreview"> }).result.revision;
		expect(
			await connection.handle({
				jsonrpc: "2.0",
				id: "delete-alias",
				method: "project/delete",
				params: { requestId: REQUEST_B, mode: "chat", cwd: realpathSync(projectDir), expectedRevision: revision },
			}),
		).toMatchObject({ result: { deletedSessionCount: 2 } });
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

	it("routes replay-protected permission selection through the opened runtime", async () => {
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

		const request = {
			jsonrpc: "2.0" as const,
			id: "set-permissions",
			method: "session/setPermissionMode" as const,
			params: { sessionId: "session-a", requestId: REQUEST_A, permissionMode: "full" as const },
		};
		expect(await connection.handle(request)).toMatchObject({ result: { permissionMode: "full" } });
		expect(await connection.handle({ ...request, id: "set-permissions-replay" })).toMatchObject({
			result: { permissionMode: "full" },
		});
		expectError(
			await connection.handle({
				...request,
				id: "set-permissions-conflict",
				params: { ...request.params, permissionMode: "ask" },
			}),
			RPC_ERROR_CODES.REQUEST_ID_REUSED,
		);
	});

	it("renames ordinary sessions and rejects scheduled session actions", async () => {
		writeSession(sessionsRoot, "session-a", projectDir);
		writeSession(sessionsRoot, "session-archived", projectDir);
		writeModeSession(agentDir, sessionsRoot, "scheduled-session", projectDir, "chat", {
			scheduled: { taskId: REQUEST_A, runId: REQUEST_B },
		});
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const connection = server.connect();
		await connection.handle(initialize());
		await connection.handle({
			jsonrpc: "2.0",
			id: "open-session-a",
			method: "session/open",
			params: { sessionId: "session-a" },
		});
		await connection.handle({
			jsonrpc: "2.0",
			id: "archive-session",
			method: "session/archive",
			params: { sessionId: "session-archived", requestId: REQUEST_C },
		});

		const rename = {
			jsonrpc: "2.0" as const,
			id: "rename",
			method: "session/rename" as const,
			params: { sessionId: "session-a", requestId: REQUEST_A, name: "Renamed session" },
		};
		expect(await connection.handle(rename)).toMatchObject({
			result: { session: { sessionId: "session-a", name: "Renamed session" } },
		});
		expect(await connection.handle({ ...rename, id: "rename-replay" })).toMatchObject({
			result: { session: { name: "Renamed session" } },
		});
		expect(
			await connection.handle({
				jsonrpc: "2.0",
				id: "rename-archived",
				method: "session/rename",
				params: { sessionId: "session-archived", requestId: REQUEST_B, name: "Renamed archived" },
			}),
		).toMatchObject({ result: { session: { archived: true, name: "Renamed archived" } } });
		const archivedPath = server.catalog.get("session-archived").path;
		const deleteSession = vi.spyOn(SessionManager, "deleteSession").mockImplementation(async (path) => {
			unlinkSync(path);
			return { ok: true, method: "trash" };
		});
		try {
			expect(
				await connection.handle({
					jsonrpc: "2.0",
					id: "delete-archived",
					method: "session/delete",
					params: { sessionId: "session-archived", requestId: REQUEST_D },
				}),
			).toMatchObject({ result: { sessionId: "session-archived", deleted: true } });
			expect(existsSync(archivedPath)).toBe(false);
		} finally {
			deleteSession.mockRestore();
		}

		for (const method of ["session/rename", "session/delete"] as const) {
			expectError(
				await connection.handle({
					jsonrpc: "2.0",
					id: `scheduled-${method}`,
					method,
					params: {
						sessionId: "scheduled-session",
						requestId: method === "session/rename" ? REQUEST_C : REQUEST_A,
						...(method === "session/rename" ? { name: "Nope" } : {}),
					},
				}),
				RPC_ERROR_CODES.READ_ONLY_SESSION,
			);
		}
	});

	it("closes and deletes an idle opened session but rejects active work", async () => {
		const idlePath = writeSession(sessionsRoot, "session-idle", projectDir);
		const activePath = writeSession(sessionsRoot, "session-active", projectDir);
		const host = new FakeHost();
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: host });
		const connection = server.connect();
		await connection.handle(initialize());
		for (const sessionId of ["session-idle", "session-active"]) {
			await connection.handle({
				jsonrpc: "2.0",
				id: `open-${sessionId}`,
				method: "session/open",
				params: { sessionId },
			});
		}
		host.runtimes.get("session-active")!.active = true;
		const deleteSession = vi.spyOn(SessionManager, "deleteSession").mockImplementation(async (path) => {
			unlinkSync(path);
			return { ok: true, method: "trash" };
		});
		try {
			const request = {
				jsonrpc: "2.0" as const,
				id: "delete-idle",
				method: "session/delete" as const,
				params: { sessionId: "session-idle", requestId: REQUEST_A },
			};
			expect(await connection.handle(request)).toMatchObject({
				result: { sessionId: "session-idle", deleted: true, method: "trash" },
			});
			expect(await connection.handle({ ...request, id: "delete-idle-replay" })).toMatchObject({
				result: { sessionId: "session-idle", deleted: true },
			});
			expect(host.runtimes.get("session-idle")?.closed).toBe(true);
			expect(existsSync(idlePath)).toBe(false);
			expectError(
				await connection.handle({
					jsonrpc: "2.0",
					id: "delete-active",
					method: "session/delete",
					params: { sessionId: "session-active", requestId: REQUEST_B },
				}),
				RPC_ERROR_CODES.SESSION_IN_USE,
			);
			expect(existsSync(activePath)).toBe(true);
		} finally {
			deleteSession.mockRestore();
		}
	});

	it("notifies every subscribed client when a session is deleted", async () => {
		const path = writeSession(sessionsRoot, "session-shared", projectDir);
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const first = server.connect();
		const second = server.connect();
		const firstMessages: unknown[] = [];
		const secondMessages: unknown[] = [];
		first.onMessage((message) => {
			firstMessages.push(message);
		});
		second.onMessage((message) => {
			secondMessages.push(message);
		});
		await Promise.all([first.handle(initialize("first")), second.handle(initialize("second"))]);
		await first.handle({
			jsonrpc: "2.0",
			id: "first-subscribe",
			method: "session/subscribe",
			params: { sessionId: "session-shared" },
		});
		const deleteSession = vi.spyOn(SessionManager, "deleteSession").mockImplementation(async () => {
			unlinkSync(path);
			return { ok: true, method: "trash" };
		});

		try {
			await first.handle({
				jsonrpc: "2.0",
				id: "delete-shared",
				method: "session/delete",
				params: { sessionId: "session-shared", requestId: REQUEST_A },
			});
			await new Promise<void>((resolve) => setImmediate(resolve));
			for (const messages of [firstMessages, secondMessages]) {
				expect(JSON.stringify(messages)).toContain('"type":"session/invalidated"');
				expect(JSON.stringify(messages)).toContain('"reason":"deleted"');
			}
		} finally {
			deleteSession.mockRestore();
		}
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

	it("creates a session with its initial permission atomically and rejects conflicting replay", async () => {
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const connection = server.connect();
		await connection.handle(initialize());
		const create = {
			jsonrpc: "2.0" as const,
			id: "create-full",
			method: "session/create" as const,
			params: { requestId: REQUEST_A, mode: "chat" as const, cwd: projectDir, permissionMode: "full" as const },
		};

		expect(await connection.handle(create)).toMatchObject({ result: { session: { sessionId: REQUEST_A } } });
		const manager = SessionManager.open(server.catalog.get(REQUEST_A).path);
		try {
			expect(manager.getPermissionSettings()).toEqual({ mode: "full" });
		} finally {
			manager.close();
		}
		expect(await connection.handle({ ...create, id: "create-full-replay" })).toMatchObject({
			result: { session: { sessionId: REQUEST_A } },
		});
		expectError(
			await connection.handle({
				...create,
				id: "create-full-conflict",
				params: { ...create.params, permissionMode: "ask" },
			}),
			RPC_ERROR_CODES.REQUEST_ID_REUSED,
		);
	});

	it("rejects a scheduled session id before mutable create replay", async () => {
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const connection = server.connect();
		await connection.handle(initialize());
		const scheduled = SessionManager.create(projectDir, join(sessionsRoot, "scheduled"), {
			id: REQUEST_C,
			mode: "chat",
			cwdOrigin: "user-selected",
			scheduled: { taskId: REQUEST_A, runId: REQUEST_B },
		});
		scheduled.close();
		await server.catalog.refresh();
		expectError(
			await connection.handle({
				jsonrpc: "2.0",
				id: "create-scheduled-collision",
				method: "session/create",
				params: { requestId: REQUEST_C, mode: "chat", cwd: projectDir },
			}),
			RPC_ERROR_CODES.REQUEST_ID_REUSED,
		);
	});

	it("bounds catalog refresh concurrency", async () => {
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		for (let index = 0; index < 64; index += 1) {
			writeSession(sessionsRoot, `catalog-session-${index}`, projectDir);
		}
		type ScanOne = (path: string, archived: boolean) => Promise<unknown>;
		const catalog = server.catalog as unknown as { scanOne: ScanOne };
		const original = catalog.scanOne.bind(server.catalog);
		let active = 0;
		let maximum = 0;
		catalog.scanOne = async (path, archived) => {
			active += 1;
			maximum = Math.max(maximum, active);
			await new Promise((resolvePromise) => setImmediate(resolvePromise));
			try {
				return await original(path, archived);
			} finally {
				active -= 1;
			}
		};

		await server.catalog.refresh();
		expect(maximum).toBeLessThanOrEqual(32);
	});

	it("builds complete mode-project snapshots and refreshes only the targeted storage", async () => {
		const paths: string[] = [];
		for (let index = 0; index < 205; index += 1) {
			paths.push(
				writeModeSession(agentDir, sessionsRoot, `bulk-${String(index).padStart(3, "0")}`, projectDir, "code", {
					archived: index % 2 === 0,
				}),
			);
		}
		writeModeSession(agentDir, sessionsRoot, "same-cwd-chat", projectDir, "chat");
		const child = join(projectDir, "child");
		mkdirSync(child);
		writeModeSession(agentDir, sessionsRoot, "child-code", child, "code");
		writeModeSession(agentDir, sessionsRoot, "managed-code", projectDir, "code", { cwdOrigin: "managed" });
		writeModeSession(agentDir, sessionsRoot, "scheduled-code", projectDir, "code", {
			scheduled: { taskId: REQUEST_A, runId: REQUEST_B },
		});
		const otherProject = join(tempDir, "other-project");
		mkdirSync(otherProject);
		const other = writeModeSession(agentDir, sessionsRoot, "other-code", otherProject, "code");
		writeFileSync(join(dirname(other), "broken.jsonl"), "not-json\n");

		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const snapshot = server.catalog.modeProjectSnapshot("code", projectDir);
		expect(snapshot.refs).toHaveLength(205);
		expect(snapshot.refs.map((ref) => ref.summary.sessionId)).toEqual(
			[...snapshot.refs.map((ref) => ref.summary.sessionId)].sort(),
		);
		expect(server.catalog.list({ includeArchived: true, limit: 200 }).sessions).toHaveLength(200);

		type ScanOne = (path: string, archived: boolean) => Promise<unknown>;
		const catalog = server.catalog as unknown as { scanOne: ScanOne };
		const original = catalog.scanOne.bind(server.catalog);
		const scannedPaths: string[] = [];
		catalog.scanOne = async (path, archived) => {
			scannedPaths.push(path);
			return original(path, archived);
		};
		writeModeSession(agentDir, sessionsRoot, "created-after-startup", projectDir, "code");
		await server.catalog.refreshModeProjectStorage(projectDir);
		expect(server.catalog.modeProjectSnapshot("code", projectDir).refs).toHaveLength(206);
		const projectStorageKey = basename(getDefaultSessionDir(projectDir, agentDir));
		expect(scannedPaths.length).toBeGreaterThan(0);
		expect(scannedPaths.every((path) => path.includes(`${projectStorageKey}/`))).toBe(true);

		writeFileSync(join(dirname(paths[0]!), "broken.jsonl"), "not-json\n");
		await server.catalog.refreshModeProjectStorage(projectDir);
		expect(() => server.catalog.modeProjectSnapshot("code", projectDir)).toThrowError(
			expect.objectContaining({ code: "SESSION_CORRUPT" }),
		);
	});

	it("deletes one mode-project snapshot, closes subscriptions, and replays the result", async () => {
		const activePath = writeModeSession(agentDir, sessionsRoot, "chat-active", projectDir, "chat");
		const archivedPath = writeModeSession(agentDir, sessionsRoot, "chat-archived", projectDir, "chat", {
			archived: true,
		});
		writeModeSession(agentDir, sessionsRoot, "code-preserved", projectDir, "code");
		const child = join(projectDir, "child");
		mkdirSync(child);
		writeModeSession(agentDir, sessionsRoot, "chat-child", child, "chat");
		writeModeSession(agentDir, sessionsRoot, "scheduled-preserved", projectDir, "chat", {
			scheduled: { taskId: REQUEST_A, runId: REQUEST_B },
		});
		const host = new FakeHost();
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: host });
		const connection = server.connect();
		await connection.handle(initialize());
		await connection.handle({
			jsonrpc: "2.0",
			id: "subscribe-before-delete",
			method: "session/subscribe",
			params: { sessionId: "chat-active" },
		});
		const preview = await connection.handle({
			jsonrpc: "2.0",
			id: "preview-chat",
			method: "project/deletePreview",
			params: { mode: "chat", cwd: projectDir },
		});
		expect(preview).toMatchObject({ result: { mode: "chat", sessionCount: 2, blockingScheduleCount: 0 } });
		const previewResult = (preview as { result: ClientResult<"project/deletePreview"> }).result;
		const trash = vi.spyOn(SessionManager, "trashModeProjectData").mockImplementation(async (input) => {
			expect(input.sessions.map(({ sessionId }) => sessionId).sort()).toEqual(["chat-active", "chat-archived"]);
			for (const target of input.sessions) unlinkSync(target.path);
			return { ok: true, method: "trash", deletedSessionCount: input.sessions.length };
		});
		const request = {
			jsonrpc: "2.0" as const,
			id: "delete-chat",
			method: "project/delete" as const,
			params: {
				requestId: REQUEST_C,
				mode: "chat" as const,
				cwd: projectDir,
				expectedRevision: previewResult.revision,
			},
		};

		const deleted = await connection.handle(request);
		expect(deleted).toMatchObject({ result: { mode: "chat", deletedSessionCount: 2 } });
		expect(connection.state.subscriptions.has("chat-active")).toBe(false);
		expect(host.runtimes.get("chat-active")?.closed).toBe(true);
		expect(existsSync(activePath)).toBe(false);
		expect(existsSync(archivedPath)).toBe(false);
		expect(() => server.catalog.get("chat-active")).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
		expect(server.catalog.get("code-preserved").summary.mode).toBe("code");
		expect(server.catalog.get("chat-child").summary.cwd).toBe(realpathSync(child));
		expect(server.catalog.get("scheduled-preserved").scheduled).toEqual({ taskId: REQUEST_A, runId: REQUEST_B });

		expect(await connection.handle({ ...request, id: "delete-chat-replay" })).toEqual({
			...deleted,
			id: "delete-chat-replay",
		});
		expect(trash).toHaveBeenCalledOnce();
		expectError(
			await connection.handle({
				...request,
				id: "delete-chat-reused",
				params: { ...request.params, expectedRevision: "b".repeat(64) },
			}),
			RPC_ERROR_CODES.REQUEST_ID_REUSED,
		);
	});

	it("blocks same-mode project mutations while allowing unrelated projects", async () => {
		writeModeSession(agentDir, sessionsRoot, "chat-selected", projectDir, "chat");
		const otherProject = join(tempDir, "other-project");
		mkdirSync(otherProject);
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const first = server.connect();
		const second = server.connect();
		await Promise.all([first.handle(initialize("first")), second.handle(initialize("second"))]);
		const preview = await first.handle({
			jsonrpc: "2.0",
			id: "preview",
			method: "project/deletePreview",
			params: { mode: "chat", cwd: projectDir },
		});
		const revision = (preview as { result: ClientResult<"project/deletePreview"> }).result.revision;
		let trashEntered!: () => void;
		let releaseTrash!: () => void;
		const entered = new Promise<void>((resolve) => {
			trashEntered = resolve;
		});
		const gate = new Promise<void>((resolve) => {
			releaseTrash = resolve;
		});
		vi.spyOn(SessionManager, "trashModeProjectData").mockImplementation(async (input) => {
			trashEntered();
			await gate;
			return { ok: true, method: "trash", deletedSessionCount: input.sessions.length };
		});
		const deletion = first.handle({
			jsonrpc: "2.0",
			id: "delete-held",
			method: "project/delete",
			params: { requestId: REQUEST_A, mode: "chat", cwd: projectDir, expectedRevision: revision },
		});
		await entered;
		await expect(
			server.scheduleManager.create({
				id: "fixed-create-during-project-delete",
				instruction: "must retry",
				schedule: { kind: "daily", time: "09:00" },
				timezone: "Asia/Shanghai",
				target: { kind: "general", workspace: "fixed", cwd: projectDir },
			}),
		).rejects.toMatchObject({ code: "TASK_BUSY" });
		await expect(
			server.scheduleManager.create({
				id: "task-create-during-project-delete",
				instruction: "independent",
				schedule: { kind: "daily", time: "09:00" },
				timezone: "Asia/Shanghai",
				target: { kind: "general", workspace: "task" },
			}),
		).resolves.toMatchObject({ target: { workspace: "task" } });

		expectError(
			await second.handle({
				jsonrpc: "2.0",
				id: "create-same-project",
				method: "session/create",
				params: { requestId: REQUEST_B, mode: "chat", cwd: projectDir },
			}),
			RPC_ERROR_CODES.BUSY,
		);
		expectError(
			await second.handle({
				jsonrpc: "2.0",
				id: "archive-same-project",
				method: "session/archive",
				params: { requestId: REQUEST_C, sessionId: "chat-selected" },
			}),
			RPC_ERROR_CODES.BUSY,
		);
		await expect(
			second.handle({
				jsonrpc: "2.0",
				id: "create-other-mode",
				method: "session/create",
				params: {
					requestId: "00000000-0000-4000-8000-000000000004",
					mode: "code",
					cwd: projectDir,
				},
			}),
		).resolves.toMatchObject({ result: { session: { mode: "code" } } });
		await expect(
			second.handle({
				jsonrpc: "2.0",
				id: "create-other-project",
				method: "session/create",
				params: {
					requestId: "00000000-0000-4000-8000-000000000005",
					mode: "chat",
					cwd: otherProject,
				},
			}),
		).resolves.toMatchObject({ result: { session: { mode: "chat" } } });
		expectError(
			await second.handle({
				jsonrpc: "2.0",
				id: "delete-second",
				method: "project/delete",
				params: {
					requestId: "00000000-0000-4000-8000-000000000006",
					mode: "chat",
					cwd: projectDir,
					expectedRevision: revision,
				},
			}),
			RPC_ERROR_CODES.BUSY,
		);
		releaseTrash();
		await expect(deletion).resolves.toMatchObject({ result: { deletedSessionCount: 1 } });
		expect(server.catalog.get("00000000-0000-4000-8000-000000000004").summary.mode).toBe("code");
	});

	it("moves nothing for stale, active, pending-interaction, and Trash failures", async () => {
		const sessionPath = writeModeSession(agentDir, sessionsRoot, "chat-failure", projectDir, "chat");
		const host = new FakeHost();
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: host });
		const connection = server.connect();
		await connection.handle(initialize());
		await connection.handle({
			jsonrpc: "2.0",
			id: "open-failure",
			method: "session/open",
			params: { sessionId: "chat-failure" },
		});
		await connection.handle({
			jsonrpc: "2.0",
			id: "subscribe-failure",
			method: "session/subscribe",
			params: { sessionId: "chat-failure" },
		});
		expect(connection.state.subscriptions.has("chat-failure")).toBe(true);
		const preview = await connection.handle({
			jsonrpc: "2.0",
			id: "preview-failure",
			method: "project/deletePreview",
			params: { mode: "chat", cwd: projectDir },
		});
		const revision = (preview as { result: ClientResult<"project/deletePreview"> }).result.revision;
		const trash = vi.spyOn(SessionManager, "trashModeProjectData");
		const request = (requestId: string, expectedRevision = revision) => ({
			jsonrpc: "2.0" as const,
			id: requestId,
			method: "project/delete" as const,
			params: { requestId, mode: "chat" as const, cwd: projectDir, expectedRevision },
		});

		expectError(await connection.handle(request(REQUEST_A, "b".repeat(64))), RPC_ERROR_CODES.BUSY);
		expect(trash).not.toHaveBeenCalled();
		const runtime = host.runtimes.get("chat-failure")!;
		runtime.active = true;
		expectError(await connection.handle(request(REQUEST_B)), RPC_ERROR_CODES.SESSION_IN_USE);
		runtime.active = false;
		runtime.pendingInteractions = true;
		expectError(await connection.handle(request(REQUEST_C)), RPC_ERROR_CODES.SESSION_IN_USE);
		runtime.pendingInteractions = false;
		const close = runtime.close.bind(runtime);
		runtime.close = vi.fn(async () => {
			throw new Error("close failed");
		});
		expectError(
			await connection.handle(request("00000000-0000-4000-8000-000000000004")),
			RPC_ERROR_CODES.OPERATION_FAILED,
		);
		expect(trash).not.toHaveBeenCalled();
		expect(connection.state.subscriptions.has("chat-failure")).toBe(false);
		runtime.close = close;
		trash.mockResolvedValue({
			ok: false,
			method: "trash",
			code: "OPERATION_FAILED",
			error: "Trash failed",
		});
		expectError(
			await connection.handle(request("00000000-0000-4000-8000-000000000005")),
			RPC_ERROR_CODES.OPERATION_FAILED,
		);
		expect(existsSync(sessionPath)).toBe(true);
		const retryPreview = await connection.handle({
			jsonrpc: "2.0",
			id: "preview-after-failure",
			method: "project/deletePreview",
			params: { mode: "chat", cwd: projectDir },
		});
		expect(retryPreview).toMatchObject({ result: { sessionCount: 1 } });
		trash.mockRestore();
		appendFileSync(sessionPath, `${JSON.stringify({ type: "message", id: "after-preview" })}\n`);
		const changedAt = new Date(Date.now() + 2_000);
		utimesSync(sessionPath, changedAt, changedAt);
		const retryRevision = (retryPreview as { result: ClientResult<"project/deletePreview"> }).result.revision;
		expectError(
			await connection.handle(request("00000000-0000-4000-8000-000000000006", retryRevision)),
			RPC_ERROR_CODES.BUSY,
		);
		expect(existsSync(sessionPath)).toBe(true);
		const changedPreview = await connection.handle({
			jsonrpc: "2.0",
			id: "preview-after-journal-change",
			method: "project/deletePreview",
			params: { mode: "chat", cwd: projectDir },
		});
		expect((changedPreview as { result: ClientResult<"project/deletePreview"> }).result.revision).not.toBe(
			retryRevision,
		);
	});

	it("applies fixed-schedule blockers only to Chat project deletion", async () => {
		writeModeSession(agentDir, sessionsRoot, "chat-scheduled-project", projectDir, "chat");
		writeModeSession(agentDir, sessionsRoot, "code-scheduled-project", projectDir, "code");
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const connection = server.connect();
		await connection.handle(initialize());
		const fixed = await server.scheduleManager.create({
			id: "fixed-project-blocker",
			instruction: "fixed",
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "fixed", cwd: projectDir },
		});
		await server.scheduleManager.create({
			id: "task-owned-non-blocker",
			instruction: "task",
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});
		const chatPreview = await connection.handle({
			jsonrpc: "2.0",
			id: "preview-chat-blocked",
			method: "project/deletePreview",
			params: { mode: "chat", cwd: projectDir },
		});
		const codePreview = await connection.handle({
			jsonrpc: "2.0",
			id: "preview-code-unblocked",
			method: "project/deletePreview",
			params: { mode: "code", cwd: projectDir },
		});
		expect(chatPreview).toMatchObject({ result: { blockingScheduleCount: 1 } });
		expect(codePreview).toMatchObject({ result: { blockingScheduleCount: 0 } });
		const trash = vi.spyOn(SessionManager, "trashModeProjectData").mockImplementation(async (input) => ({
			ok: true,
			method: "trash",
			deletedSessionCount: input.sessions.length,
		}));
		const codeResult = (codePreview as { result: ClientResult<"project/deletePreview"> }).result;
		expect(
			await connection.handle({
				jsonrpc: "2.0",
				id: "delete-code-with-chat-schedule",
				method: "project/delete",
				params: {
					requestId: REQUEST_A,
					mode: "code",
					cwd: projectDir,
					expectedRevision: codeResult.revision,
				},
			}),
		).toMatchObject({ result: { deletedSessionCount: 1 } });
		const chatResult = (chatPreview as { result: ClientResult<"project/deletePreview"> }).result;
		expectError(
			await connection.handle({
				jsonrpc: "2.0",
				id: "delete-chat-blocked",
				method: "project/delete",
				params: {
					requestId: REQUEST_B,
					mode: "chat",
					cwd: projectDir,
					expectedRevision: chatResult.revision,
				},
			}),
			RPC_ERROR_CODES.BUSY,
		);
		expect(trash).toHaveBeenCalledTimes(1);
		await server.scheduleManager.stop();
		await server.scheduleManager.delete(fixed.id);
		const retry = await connection.handle({
			jsonrpc: "2.0",
			id: "preview-chat-retry",
			method: "project/deletePreview",
			params: { mode: "chat", cwd: projectDir },
		});
		expect(retry).toMatchObject({ result: { blockingScheduleCount: 0 } });
		const retryResult = (retry as { result: ClientResult<"project/deletePreview"> }).result;
		expect(
			await connection.handle({
				jsonrpc: "2.0",
				id: "delete-chat-retry",
				method: "project/delete",
				params: {
					requestId: REQUEST_C,
					mode: "chat",
					cwd: projectDir,
					expectedRevision: retryResult.revision,
				},
			}),
		).toMatchObject({ result: { deletedSessionCount: 1 } });
	});

	it("ignores a corrupt schedule store for Code preview but reports it for Chat", async () => {
		writeModeSession(agentDir, sessionsRoot, "chat-corrupt-schedules", projectDir, "chat");
		writeModeSession(agentDir, sessionsRoot, "code-corrupt-schedules", projectDir, "code");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "schedules.json"), "{broken");
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const connection = server.connect();
		await connection.handle(initialize());

		expect(
			await connection.handle({
				jsonrpc: "2.0",
				id: "preview-code-corrupt-schedules",
				method: "project/deletePreview",
				params: { mode: "code", cwd: projectDir },
			}),
		).toMatchObject({ result: { sessionCount: 1, blockingScheduleCount: 0 } });
		expectError(
			await connection.handle({
				jsonrpc: "2.0",
				id: "preview-chat-corrupt-schedules",
				method: "project/deletePreview",
				params: { mode: "chat", cwd: projectDir },
			}),
			RPC_ERROR_CODES.SCHEDULE_STORE_CORRUPT,
		);
	});

	it("previews and deletes residual sessions after the source folder is removed", async () => {
		writeModeSession(agentDir, sessionsRoot, "code-missing-source", projectDir, "code");
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const connection = server.connect();
		await connection.handle(initialize());
		rmSync(projectDir, { recursive: true, force: true });
		const preview = await connection.handle({
			jsonrpc: "2.0",
			id: "preview-missing-source",
			method: "project/deletePreview",
			params: { mode: "code", cwd: projectDir },
		});
		expect(preview).toMatchObject({
			result: { cwd: join(realpathSync(tempDir), basename(projectDir)), sessionCount: 1 },
		});
		const result = (preview as { result: ClientResult<"project/deletePreview"> }).result;
		vi.spyOn(SessionManager, "trashModeProjectData").mockImplementation(async (input) => ({
			ok: true,
			method: "trash",
			deletedSessionCount: input.sessions.length,
		}));

		expect(
			await connection.handle({
				jsonrpc: "2.0",
				id: "delete-missing-source",
				method: "project/delete",
				params: {
					requestId: REQUEST_A,
					mode: "code",
					cwd: projectDir,
					expectedRevision: result.revision,
				},
			}),
		).toMatchObject({ result: { deletedSessionCount: 1 } });
	});

	it("returns BUSY when another process creates a matching journal after preview", async () => {
		writeModeSession(agentDir, sessionsRoot, "chat-before-preview", projectDir, "chat");
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const connection = server.connect();
		await connection.handle(initialize());
		const preview = await connection.handle({
			jsonrpc: "2.0",
			id: "preview-before-external-create",
			method: "project/deletePreview",
			params: { mode: "chat", cwd: projectDir },
		});
		const previewResult = (preview as { result: ClientResult<"project/deletePreview"> }).result;
		const external = SessionManager.create(projectDir, getDefaultSessionDir(projectDir, agentDir), {
			id: "chat-created-externally",
			mode: "chat",
			cwdOrigin: "user-selected",
		});
		external.close();

		expectError(
			await connection.handle({
				jsonrpc: "2.0",
				id: "delete-after-external-create",
				method: "project/delete",
				params: {
					requestId: REQUEST_A,
					mode: "chat",
					cwd: projectDir,
					expectedRevision: previewResult.revision,
				},
			}),
			RPC_ERROR_CODES.BUSY,
		);
		const refreshed = await connection.handle({
			jsonrpc: "2.0",
			id: "preview-after-external-create",
			method: "project/deletePreview",
			params: { mode: "chat", cwd: projectDir },
		});
		expect(refreshed).toMatchObject({ result: { sessionCount: 2 } });
	});

	it("rejects a live journal lease before moving project data", async () => {
		const path = writeModeSession(agentDir, sessionsRoot, "chat-live-lease", projectDir, "chat");
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const connection = server.connect();
		await connection.handle(initialize());
		const preview = await connection.handle({
			jsonrpc: "2.0",
			id: "preview-live-lease",
			method: "project/deletePreview",
			params: { mode: "chat", cwd: projectDir },
		});
		const revision = (preview as { result: ClientResult<"project/deletePreview"> }).result.revision;
		const owner = SessionManager.open(path);
		try {
			expectError(
				await connection.handle({
					jsonrpc: "2.0",
					id: "delete-live-lease",
					method: "project/delete",
					params: { requestId: REQUEST_A, mode: "chat", cwd: projectDir, expectedRevision: revision },
				}),
				RPC_ERROR_CODES.SESSION_IN_USE,
			);
			expect(existsSync(path)).toBe(true);
		} finally {
			owner.close();
		}
	});

	it("deletes more than one protocol page from one project snapshot", async () => {
		for (let index = 0; index < 201; index += 1) {
			writeModeSession(agentDir, sessionsRoot, `delete-bulk-${String(index).padStart(3, "0")}`, projectDir, "code");
		}
		const server = await AppServer.create({ agentDir, sessionsRoot, runtimeHost: new FakeHost() });
		const connection = server.connect();
		await connection.handle(initialize());
		const preview = await connection.handle({
			jsonrpc: "2.0",
			id: "preview-bulk",
			method: "project/deletePreview",
			params: { mode: "code", cwd: projectDir },
		});
		expect(preview).toMatchObject({ result: { sessionCount: 201 } });
		const previewResult = (preview as { result: ClientResult<"project/deletePreview"> }).result;
		const trash = vi.spyOn(SessionManager, "trashModeProjectData").mockImplementation(async (input) => ({
			ok: true,
			method: "trash",
			deletedSessionCount: input.sessions.length,
		}));
		expect(
			await connection.handle({
				jsonrpc: "2.0",
				id: "delete-bulk",
				method: "project/delete",
				params: {
					requestId: REQUEST_A,
					mode: "code",
					cwd: projectDir,
					expectedRevision: previewResult.revision,
				},
			}),
		).toMatchObject({ result: { deletedSessionCount: 201 } });
		expect(trash.mock.calls[0]![0].sessions).toHaveLength(201);
		expect(server.catalog.modeProjectSnapshot("code", projectDir).refs).toHaveLength(0);
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
