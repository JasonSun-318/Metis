import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	type ClientParams,
	type ClientRequestMethod,
	type ClientResult,
	PROTOCOL_VERSION,
	ProtocolValidationError,
	RPC_ERROR_CODES,
	validateClientRequest,
	validateResponseFor,
} from "@metis/app-protocol";
import { AgentStore, formatSessionAttachments, SessionManager } from "@metis/coding-agent/host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntimeHost } from "../src/agent-session-runtime-host.ts";
import { AppServer } from "../src/app-server.ts";
import type { OpenedSessionRuntime, SessionRef } from "../src/session-runtime-host.ts";

const ROOT = "00000000-0000-4000-8000-000000000501";
const OTHER_ROOT = "00000000-0000-4000-8000-000000000502";
const AGENT = "00000000-0000-4000-8000-000000000503";
const OTHER_AGENT = "00000000-0000-4000-8000-000000000504";
const TASK = "00000000-0000-4000-8000-000000000505";
const REQUEST = "00000000-0000-4000-8000-000000000506";
const OTHER_REQUEST = "00000000-0000-4000-8000-000000000507";
const SCHEDULED_ROOT = "00000000-0000-4000-8000-000000000508";
const ARCHIVED_ROOT = "00000000-0000-4000-8000-000000000509";
const mutation = {
	sessionId: ROOT,
	agentId: AGENT,
	requestId: REQUEST,
	queueItemId: "queued-human-message",
	expectedRevision: "queue-entry-revision",
};
const receipt = {
	agentId: AGENT,
	taskId: TASK,
	messageId: mutation.queueItemId,
	requestId: REQUEST,
	delivery: "steer",
	state: "accepted",
	instructionRevision: 2,
} as const;
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	try {
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	} finally {
		vi.restoreAllMocks();
	}
});

function request(method: ClientRequestMethod, params: Record<string, unknown>, id = "queue-request") {
	return { jsonrpc: "2.0" as const, id, method, params };
}

function expectProtocolError(run: () => unknown, kind: ProtocolValidationError["kind"]): void {
	let caught: unknown;
	try {
		run();
	} catch (error) {
		caught = error;
	}
	expect(caught).toBeInstanceOf(ProtocolValidationError);
	expect((caught as ProtocolValidationError).kind).toBe(kind);
}

function createFixture() {
	const root = mkdtempSync(join(tmpdir(), "metis-agent-queue-server-"));
	cleanups.push(() => rmSync(root, { force: true, recursive: true }));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const sessionsRoot = join(agentDir, "sessions");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	const manager = SessionManager.create(cwd, sessionsRoot, { id: ROOT, mode: "code", permissionPreset: "full" });
	const path = manager.getSessionFile()!;
	const store = new AgentStore(manager, agentDir);
	manager.close();
	const ref: SessionRef = {
		path,
		relativePath: basename(path),
		summary: {
			sessionId: ROOT,
			mode: "code",
			cwdOrigin: "user-selected",
			cwd,
			createdAt: "2026-10-26T00:00:00.000Z",
			updatedAt: "2026-10-26T00:00:00.000Z",
			state: "idle",
			archived: false,
			unread: false,
			useMemory: true,
			contributeMemory: true,
		},
	};
	return { root, cwd, agentDir, sessionsRoot, ref, store };
}

function seedPausedChild(fixture: ReturnType<typeof createFixture>, messageId = mutation.queueItemId) {
	const record = fixture.store.create(
		{
			agentId: AGENT,
			name: "Queue worker",
			agentType: "worker",
			initialTask: "Pending human task",
			tools: ["read"],
			writePolicy: "inherit",
			permissionPreset: "full",
			model: { provider: "fixture", modelId: "never-requested" },
			thinkingLevel: "off",
			cwd: fixture.cwd,
			forkTurns: 0,
			timeoutSeconds: 60,
			mayDelegate: false,
			parentSessionId: ROOT,
			rootSessionId: ROOT,
			agentPath: [AGENT],
		},
		[],
		TASK,
		{
			type: "agent_input",
			agentId: AGENT,
			taskId: TASK,
			messageId,
			requestId: OTHER_REQUEST,
			requestHash: "a".repeat(64),
			delivery: "queue",
			state: "queued",
			instructionRevision: 1,
			origin: { kind: "user" },
			input: {
				text: formatSessionAttachments("Pending human task", [
					{ name: "report.pdf", path: join(fixture.root, "private", "report.pdf"), size: 12 },
				]),
			},
		},
	);
	const child = SessionManager.open(record.path);
	try {
		child.appendAgentControl({
			type: "agent_run_control",
			agentId: AGENT,
			action: "stop",
			state: "user_paused",
			scope: "self",
			requestId: REQUEST,
			origin: { kind: "user" },
		});
	} finally {
		child.close();
	}
	return record.path;
}

async function openRuntime(fixture: ReturnType<typeof createFixture>) {
	const opened = await new AgentSessionRuntimeHost({ agentDir: fixture.agentDir }).open(fixture.ref);
	cleanups.push(() => opened.close());
	return opened;
}

async function routingFixture() {
	const fixture = createFixture();
	const host = new AgentSessionRuntimeHost({ agentDir: fixture.agentDir });
	const read = vi.fn(
		async (_input: ClientParams<"agent/queue/read">): Promise<ClientResult<"agent/queue/read">> => ({
			queuedTurns: [],
		}),
	);
	const remove = vi.fn(
		async (input: ClientParams<"agent/queue/delete">): Promise<ClientResult<"agent/queue/delete">> => ({
			queueItemId: input.queueItemId,
			deleted: true,
		}),
	);
	const send = vi.fn(
		async (input: ClientParams<"agent/queue/send">): Promise<ClientResult<"agent/queue/send">> => ({
			...receipt,
			agentId: input.agentId,
			requestId: input.requestId,
			delivery: input.delivery,
		}),
	);
	const opened = new Map<string, OpenedSessionRuntime>();
	const open = vi.fn(async (ref: SessionRef) => {
		const runtime = await host.open(ref);
		opened.set(runtime.sessionId, runtime);
		vi.spyOn(runtime, "readAgentQueuedMessages").mockImplementation(read);
		vi.spyOn(runtime, "deleteAgentQueuedMessage").mockImplementation(remove);
		vi.spyOn(runtime, "sendAgentQueuedMessage").mockImplementation(send);
		return runtime;
	});
	const server = await AppServer.create({
		agentDir: fixture.agentDir,
		sessionsRoot: fixture.sessionsRoot,
		runtimeHost: { open },
		titleGenerator: { generate: async () => undefined },
	});
	cleanups.push(async () => {
		server.beginShutdown();
		await server.waitForShutdown();
	});
	const connection = server.connect();
	await connection.handle({
		jsonrpc: "2.0",
		id: "initialize",
		method: "initialize",
		params: { protocolVersion: PROTOCOL_VERSION, client: { name: "queue-test", version: "1" }, capabilities: [] },
	});
	return { ...fixture, server, connection, open, opened, read, remove, send };
}

describe("child queued-message protocol", () => {
	it.each(["agent/queue/read", "agent/queue/delete", "agent/queue/send"] as const)(
		"%s rejects unknown fields, impersonation, and incomplete identities",
		(method) => {
			const params =
				method === "agent/queue/read"
					? { sessionId: ROOT, agentId: AGENT }
					: { ...mutation, ...(method === "agent/queue/send" ? { delivery: "steer" } : {}) };
			expect(validateClientRequest(request(method, params))).toEqual(request(method, params));
			for (const extra of [{ origin: { kind: "user" } }, { actorId: OTHER_AGENT }, { text: "replace queue" }]) {
				expectProtocolError(
					() => validateClientRequest(request(method, { ...params, ...extra })),
					"invalid_params",
				);
			}
			const { agentId: _agentId, ...withoutAgent } = params;
			expectProtocolError(() => validateClientRequest(request(method, withoutAgent)), "invalid_params");
		},
	);

	it.each(["agent/queue/delete", "agent/queue/send"] as const)(
		"%s requires an exact revision and request UUID",
		(method) => {
			const params = { ...mutation, ...(method === "agent/queue/send" ? { delivery: "steer" } : {}) };
			for (const invalid of [{ expectedRevision: "" }, { queueItemId: "" }, { requestId: "not-a-uuid" }]) {
				expectProtocolError(
					() => validateClientRequest(request(method, { ...params, ...invalid })),
					"invalid_params",
				);
			}
			const { expectedRevision: _revision, ...withoutRevision } = params;
			expectProtocolError(() => validateClientRequest(request(method, withoutRevision)), "invalid_params");
		},
	);

	it("accepts only Guide or Start for a selected queued message", () => {
		for (const delivery of ["steer", "start"]) {
			expect(() => validateClientRequest(request("agent/queue/send", { ...mutation, delivery }))).not.toThrow();
		}
		for (const delivery of ["auto", "queue", "follow_up", "followUp"]) {
			expectProtocolError(
				() => validateClientRequest(request("agent/queue/send", { ...mutation, delivery })),
				"invalid_params",
			);
		}
	});

	it("rejects raw storage paths and journal fields in queue projections", () => {
		const pending = request("agent/queue/read", { sessionId: ROOT, agentId: AGENT });
		const queuedTurn = {
			queueItemId: mutation.queueItemId,
			revision: mutation.expectedRevision,
			state: "queued",
			text: "Pending task",
			attachments: [{ name: "report.pdf", byteLength: 12 }],
		};
		const response = (value: unknown) => ({
			jsonrpc: "2.0" as const,
			id: pending.id,
			result: { queuedTurns: [value] },
		});
		expect(() => validateResponseFor("client", pending, response(queuedTurn))).not.toThrow();
		for (const invalid of [
			{ ...queuedTurn, input: { text: "raw durable input" } },
			{ ...queuedTurn, state: "delivered" },
			{ ...queuedTurn, attachments: [{ ...queuedTurn.attachments[0], path: "/private/report.pdf" }] },
		]) {
			expectProtocolError(() => validateResponseFor("client", pending, response(invalid)), "invalid_response");
		}
	});

	it("binds delete and send receipts to the selected queue, child, and request", () => {
		const deletion = request("agent/queue/delete", mutation);
		const sending = request("agent/queue/send", { ...mutation, delivery: "steer" });
		const response = (result: unknown) => ({ jsonrpc: "2.0" as const, id: "queue-request", result });
		expect(() =>
			validateResponseFor("client", deletion, response({ queueItemId: mutation.queueItemId, deleted: true })),
		).not.toThrow();
		expectProtocolError(
			() => validateResponseFor("client", deletion, response({ queueItemId: "another-message", deleted: true })),
			"invalid_response",
		);
		expect(() => validateResponseFor("client", sending, response(receipt))).not.toThrow();
		for (const invalid of [
			{ ...receipt, agentId: OTHER_AGENT },
			{ ...receipt, requestId: OTHER_REQUEST },
		]) {
			expectProtocolError(() => validateResponseFor("client", sending, response(invalid)), "invalid_response");
		}
	});
});

describe("child queued-message app-server routes", () => {
	it("keeps reads read-only and forwards the complete selected identity", async () => {
		const fixture = await routingFixture();
		const { connection, read, remove, send, open } = fixture;
		const path = seedPausedChild(fixture);
		const before = readFileSync(path, "utf8");
		expect(await connection.handle(request("agent/queue/read", { sessionId: ROOT, agentId: AGENT }))).toMatchObject({
			result: { queuedTurns: [{ queueItemId: mutation.queueItemId, state: "paused" }] },
		});
		expect(open).not.toHaveBeenCalled();
		expect(read).not.toHaveBeenCalled();
		expect(readFileSync(path, "utf8")).toBe(before);
		await connection.handle(request("session/open", { sessionId: ROOT }, "open-root"));
		expect(await connection.handle(request("agent/queue/read", { sessionId: ROOT, agentId: AGENT }))).toMatchObject({
			result: { queuedTurns: [] },
		});
		expect(read).toHaveBeenCalledExactlyOnceWith({ sessionId: ROOT, agentId: AGENT });
		expect(remove).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
		expect(await connection.handle(request("agent/queue/delete", mutation))).toMatchObject({
			result: { queueItemId: mutation.queueItemId, deleted: true },
		});
		expect(remove).toHaveBeenCalledExactlyOnceWith(mutation);
	});

	it("coalesces concurrent Guide requests and refuses to reuse one request for a different selection", async () => {
		const { connection, send } = await routingFixture();
		let release!: () => void;
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		send.mockImplementationOnce(async () => {
			await blocked;
			return receipt;
		});
		const pending = request("agent/queue/send", { ...mutation, delivery: "steer" });
		const first = connection.handle(pending);
		const second = connection.handle({ ...pending, id: "queue-replay" });
		try {
			await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
		} finally {
			release();
		}
		for (const result of await Promise.all([first, second])) expect(result).toMatchObject({ result: receipt });
		expect(send).toHaveBeenCalledExactlyOnceWith(pending.params);
		for (const changed of [
			{ agentId: OTHER_AGENT },
			{ queueItemId: "another-message" },
			{ expectedRevision: "new-revision" },
			{ delivery: "start" },
		]) {
			expect(
				await connection.handle({ ...pending, id: "queue-conflict", params: { ...pending.params, ...changed } }),
			).toMatchObject({ error: { code: RPC_ERROR_CODES.REQUEST_ID_REUSED } });
		}
		expect(send).toHaveBeenCalledOnce();
	});

	it.each(["agent/queue/delete", "agent/queue/send"] as const)(
		"%s refuses scheduled and archived roots before opening a runtime",
		async (method) => {
			const { connection, server, cwd, sessionsRoot, open, remove, send } = await routingFixture();
			for (const [sessionId, archived] of [
				[SCHEDULED_ROOT, false],
				[ARCHIVED_ROOT, true],
			] as const) {
				const directory = join(sessionsRoot, ...(archived ? [".archive", "fixture"] : ["fixture"]));
				mkdirSync(directory, { recursive: true });
				writeFileSync(
					join(directory, `${sessionId}.jsonl`),
					`${JSON.stringify({ type: "session", version: 10, id: sessionId, timestamp: "2026-10-26T00:00:00.000Z", cwd, mode: "code", cwdOrigin: "user-selected", ...(!archived ? { scheduled: { taskId: "schedule-fixture", runId: "run-fixture" } } : {}) })}\n`,
				);
			}
			await server.catalog.refresh();
			for (const [sessionId, code] of [
				[SCHEDULED_ROOT, RPC_ERROR_CODES.READ_ONLY_SESSION],
				[ARCHIVED_ROOT, RPC_ERROR_CODES.NOT_FOUND],
			] as const) {
				expect(
					await connection.handle(
						request(method, {
							...mutation,
							sessionId,
							...(method === "agent/queue/send" ? { delivery: "steer" } : {}),
						}),
					),
				).toMatchObject({ error: { code } });
			}
			expect(open).not.toHaveBeenCalled();
			expect(remove).not.toHaveBeenCalled();
			expect(send).not.toHaveBeenCalled();
		},
	);
});

describe("child queued-message durable runtime adapter", () => {
	it("projects a paused human input without leaking attachment paths or changing its journal", async () => {
		const fixture = createFixture();
		const childPath = seedPausedChild(fixture);
		const opened = await openRuntime(fixture);
		const before = readFileSync(childPath, "utf8");
		const result = await opened.readAgentQueuedMessages({ sessionId: ROOT, agentId: AGENT });
		expect(result.queuedTurns).toEqual([
			{
				queueItemId: mutation.queueItemId,
				revision: expect.any(String),
				state: "paused",
				text: "Pending human task",
				attachments: [{ name: "report.pdf", byteLength: 12 }],
			},
		]);
		expect(JSON.stringify(result)).not.toContain(fixture.root);
		expect(readFileSync(childPath, "utf8")).toBe(before);
	});

	it.each([mutation.queueItemId, `legacy|${"x".repeat(160)}`])(
		"rejects stale deletion, then deletes the projected pending input durably (%s)",
		async (messageId) => {
			const fixture = createFixture();
			const childPath = seedPausedChild(fixture, messageId);
			const opened = await openRuntime(fixture);
			const [queued] = (await opened.readAgentQueuedMessages({ sessionId: ROOT, agentId: AGENT })).queuedTurns;
			expect(queued).toBeDefined();
			const selected = { ...mutation, queueItemId: queued!.queueItemId };
			const before = readFileSync(childPath, "utf8");
			await expect(
				opened.deleteAgentQueuedMessage({ ...selected, expectedRevision: "stale-revision" }),
			).rejects.toThrow();
			expect(readFileSync(childPath, "utf8")).toBe(before);
			expect(await opened.deleteAgentQueuedMessage({ ...selected, expectedRevision: queued!.revision })).toEqual({
				queueItemId: queued!.queueItemId,
				deleted: true,
			});
			expect((await opened.readAgentQueuedMessages({ sessionId: ROOT, agentId: AGENT })).queuedTurns).toEqual([]);
			const record = fixture.store.load(AGENT);
			expect(record.tasks.find((task) => task.taskId === TASK)?.status).toBe("stopped");
		},
	);

	it("cannot read or delete a queued input through another root session", async () => {
		const fixture = createFixture();
		const childPath = seedPausedChild(fixture);
		const other = SessionManager.create(fixture.cwd, fixture.sessionsRoot, { id: OTHER_ROOT, mode: "code" });
		const otherPath = other.getSessionFile()!;
		other.close();
		const opened = await new AgentSessionRuntimeHost({ agentDir: fixture.agentDir }).open({
			...fixture.ref,
			path: otherPath,
			relativePath: basename(otherPath),
			summary: { ...fixture.ref.summary, sessionId: OTHER_ROOT },
		});
		cleanups.push(() => opened.close());
		const before = readFileSync(childPath, "utf8");
		await expect(opened.readAgentQueuedMessages({ sessionId: OTHER_ROOT, agentId: AGENT })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		await expect(opened.deleteAgentQueuedMessage({ ...mutation, sessionId: OTHER_ROOT })).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(readFileSync(childPath, "utf8")).toBe(before);
	});
});
