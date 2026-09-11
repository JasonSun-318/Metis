import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ClientRpcSuccessResponse, PROTOCOL_VERSION, RPC_ERROR_CODES } from "@metis/app-protocol";
import {
	createSessionId,
	getDefaultSessionDir,
	ScheduleManager,
	type ScheduleRunClaim,
	SessionManager,
} from "@metis/coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trashScheduledTaskData } from "../../coding-agent/src/core/schedules/delete.ts";
import { AppServer } from "../src/app-server.ts";
import type { ConnectionOutboundEnvelope } from "../src/connection.ts";
import type { OutboundEnvelope } from "../src/outbound-queue.ts";

const SOURCE_ID = "10000000-0000-4000-8000-000000000001";
const CHAT_ID = "10000000-0000-4000-8000-000000000002";
const MANAGED_CHAT_ID = "10000000-0000-4000-8000-000000000003";
const TASK_ID = "20000000-0000-4000-8000-000000000001";
const FIXED_TASK_ID = "20000000-0000-4000-8000-000000000002";
const GLOBAL_TASK_ID = "20000000-0000-4000-8000-000000000003";
const MANAGED_TASK_ID = "20000000-0000-4000-8000-000000000004";
const RUN_ID = "30000000-0000-4000-8000-000000000001";
const RETAIN_TASK_ID = "30000000-0000-4000-8000-000000000002";
const RETAIN_RUN_ID = "30000000-0000-4000-8000-000000000003";
const MISSING_SESSION_ID = "60000000-0000-4000-8000-000000000001";
const MODEL = { provider: "openai", modelId: "gpt-4" } as const;

function configureModel(agentDir: string): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "test" } }));
}

function managerWithTestTrash(
	agentDir: string,
	execute: (
		claim: ScheduleRunClaim,
		signal: AbortSignal,
	) => Promise<{
		runId: string;
		sessionId: string;
		sessionFile: string;
		result: string;
	}>,
): ScheduleManager {
	return ScheduleManager.create({
		agentDir,
		execute,
		trashScheduledData: (input) =>
			trashScheduledTaskData(input, { trash: (payload) => rmSync(payload, { recursive: true }) }),
	});
}

function initialize() {
	return {
		jsonrpc: "2.0" as const,
		id: "initialize",
		method: "initialize" as const,
		params: { protocolVersion: PROTOCOL_VERSION, client: { name: "test", version: "1" }, capabilities: [] },
	};
}

function request(method: string, params: Record<string, unknown>, id = method) {
	return { jsonrpc: "2.0" as const, id, method, params };
}

async function waitForRun(connection: ReturnType<AppServer["connect"]>, taskId: string, runId: string) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const response = await connection.handle(request("schedule/run/get", { taskId, runId }, `run-${attempt}`));
		if ("result" in response) {
			const run = (response as ClientRpcSuccessResponse<"schedule/run/get">).result.run;
			if (["succeeded", "failed", "missed", "skipped", "cancelled"].includes(run.status)) return run;
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	throw new Error("scheduled run did not finish");
}

describe("AppServer schedule contract", () => {
	let tempDir: string | undefined;
	let server: AppServer | undefined;

	afterEach(async () => {
		server?.beginShutdown();
		await server?.waitForShutdown();
		if (tempDir) rmSync(tempDir, { recursive: true, force: true });
		server = undefined;
		tempDir = undefined;
	});

	it("derives targets at the host and exposes no internal execution fields", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "app-server-schedule-target-"));
		const agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "project");
		const chatDir = join(tempDir, "notes");
		const additionalWorkspaceCwd = join(tempDir, "granted");
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(chatDir, { recursive: true });
		mkdirSync(additionalWorkspaceCwd, { recursive: true });
		configureModel(agentDir);
		server = await AppServer.create({ agentDir, scheduleExecute: async () => Promise.reject(new Error("unused")) });
		const connection = server.connect();
		const initialized = await connection.handle(initialize());
		expect(initialized).toMatchObject({
			result: { capabilities: expect.arrayContaining(["models.v1", "schedules.v2"]) },
		});
		expect(await connection.handle(request("model/list", {}))).toMatchObject({
			result: { models: expect.arrayContaining([expect.objectContaining(MODEL)]) },
		});

		await connection.handle(request("session/create", { requestId: SOURCE_ID, mode: "code", cwd: projectDir }));
		await connection.handle(request("session/create", { requestId: CHAT_ID, mode: "chat", cwd: chatDir }));
		await connection.handle(request("session/create", { requestId: MANAGED_CHAT_ID, mode: "chat" }));
		const create = async (taskId: string, sourceSessionId?: string, additionalCwd?: string) =>
			connection.handle(
				request("schedule/create", {
					requestId: taskId,
					...(sourceSessionId ? { sourceSessionId } : {}),
					...(additionalCwd ? { additionalWorkspaceCwd: additionalCwd } : {}),
					name: "每日简报",
					description: "桌面显示说明",
					instruction: "生成日报",
					model: MODEL,
					schedule: { kind: "daily", time: "09:00" },
				}),
			);
		const code = await create(TASK_ID, SOURCE_ID);
		const fixed = await create(FIXED_TASK_ID, CHAT_ID);
		const managed = await create(MANAGED_TASK_ID, MANAGED_CHAT_ID);
		const global = await create(GLOBAL_TASK_ID, undefined, additionalWorkspaceCwd);

		expect(code).toMatchObject({ error: { code: RPC_ERROR_CODES.INVALID_REQUEST } });
		expect(fixed).toMatchObject({
			result: { task: { target: { kind: "general", workspace: "fixed", cwd: realpathSync(chatDir) } } },
		});
		expect(managed).toMatchObject({ result: { task: { target: { kind: "general", workspace: "task" } } } });
		expect(JSON.stringify(managed)).not.toContain("schedule-workspaces");
		expect(global).toMatchObject({
			result: {
				task: {
					target: {
						kind: "general",
						workspace: "task",
						additionalWorkspaceCwd: realpathSync(additionalWorkspaceCwd),
					},
				},
			},
		});
		expect(JSON.stringify(global)).not.toContain("schedule-workspaces");
		expect(await create("40000000-0000-4000-8000-000000000002", CHAT_ID, additionalWorkspaceCwd)).toMatchObject({
			error: { code: RPC_ERROR_CODES.INVALID_PARAMS },
		});
		expect(
			await connection.handle(
				request("schedule/update", {
					requestId: "40000000-0000-4000-8000-000000000003",
					taskId: GLOBAL_TASK_ID,
					additionalWorkspaceCwd: null,
				}),
			),
		).toMatchObject({
			result: { task: { target: { kind: "general", workspace: "task" } } },
		});
		expect(
			await connection.handle(
				request("schedule/create", {
					requestId: "40000000-0000-4000-8000-000000000001",
					name: "非法",
					instruction: "非法",
					model: MODEL,
					schedule: { kind: "daily", time: "09:00" },
					cwd: projectDir,
				}),
			),
		).toMatchObject({ error: { code: RPC_ERROR_CODES.INVALID_PARAMS } });
		expect(await create("70000000-0000-4000-8000-000000000001", MISSING_SESSION_ID)).toMatchObject({
			error: { code: RPC_ERROR_CODES.NOT_FOUND, data: { sessionId: MISSING_SESSION_ID } },
		});
	});

	it("runs into a fresh visible read-only Chat session and deletes the whole task history", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "app-server-schedule-run-"));
		const agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "project");
		mkdirSync(projectDir, { recursive: true });
		configureModel(agentDir);
		const execute = async (claim: ScheduleRunClaim) => {
			const sessionId = createSessionId();
			const manager = SessionManager.create(
				claim.snapshot.target.cwd,
				getDefaultSessionDir(claim.snapshot.target.cwd, agentDir),
				{
					id: sessionId,
					mode: "chat" as const,
					cwdOrigin: "user-selected" as const,
					scheduled: { taskId: claim.taskId, runId: claim.runId },
				},
			);
			manager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "日报已生成" }],
				api: "openai-completions",
				provider: "openai",
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
			const sessionFile = manager.getSessionFile()!;
			manager.close();
			return { runId: claim.runId, sessionId, sessionFile, result: "日报已生成" };
		};
		server = await AppServer.create({
			agentDir,
			scheduleManager: managerWithTestTrash(agentDir, execute),
		});
		let connection = server.connect();
		const events: OutboundEnvelope[] = [];
		const recordEvent = (message: ConnectionOutboundEnvelope) => {
			if ("method" in message && message.method === "connection/events") events.push(message);
		};
		connection.onMessage(recordEvent);
		await connection.handle(initialize());
		await connection.handle(request("session/create", { requestId: SOURCE_ID, mode: "chat", cwd: projectDir }));
		await connection.handle(
			request("schedule/create", {
				requestId: TASK_ID,
				sourceSessionId: SOURCE_ID,
				name: "每日简报",
				description: "工作日摘要",
				instruction: "生成日报",
				model: MODEL,
				schedule: { kind: "daily", time: "09:00" },
			}),
		);
		await connection.handle(request("schedule/subscribe", {}));
		const refresh = vi.spyOn(server.catalog, "refresh");
		await connection.handle(request("schedule/run-now", { requestId: RUN_ID, taskId: TASK_ID }));
		const run = await waitForRun(connection, TASK_ID, RUN_ID);
		expect(run).toMatchObject({ status: "succeeded", resultPreview: "日报已生成", unread: true });
		expect(run).not.toHaveProperty("sessionFile");
		for (let attempt = 0; attempt < 100; attempt += 1) {
			try {
				if (server.catalog.get(run.sessionId!).scheduled) break;
			} catch {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}
		}

		const listed = await connection.handle(request("session/list", {}));
		expect(listed).toMatchObject({
			result: {
				sessions: expect.arrayContaining([
					expect.objectContaining({
						sessionId: run.sessionId!,
						mode: "chat",
						scheduled: { taskId: TASK_ID, runId: RUN_ID },
					}),
				]),
			},
		});
		expect(await connection.handle(request("session/open", { sessionId: run.sessionId! }))).toMatchObject({
			result: { session: { sessionId: run.sessionId! } },
		});
		const subscribed = await connection.handle(request("session/subscribe", { sessionId: run.sessionId! }));
		const snapshot = (subscribed as ClientRpcSuccessResponse<"session/subscribe">).result.snapshot;
		const turnId = snapshot.recentItems[0]?.turnId;
		expect(turnId).toBeTruthy();
		expect(snapshot.recentItems.every((item) => item.turnId === turnId)).toBe(true);
		expect(snapshot.turns).toEqual([expect.objectContaining({ turnId, state: "completed" })]);
		const items = await connection.handle(
			request("session/readItems", { sessionId: run.sessionId!, beforeItemId: null, limit: 20 }),
		);
		expect(JSON.stringify(items)).toContain("日报已生成");
		expect(
			await connection.handle(
				request("turn/start", {
					sessionId: run.sessionId!,
					requestId: "50000000-0000-4000-8000-000000000001",
					text: "继续",
				}),
			),
		).toMatchObject({ error: { code: RPC_ERROR_CODES.READ_ONLY_SESSION } });
		expect(
			await connection.handle(
				request("session/close", {
					sessionId: run.sessionId!,
					requestId: "50000000-0000-4000-8000-000000000004",
				}),
			),
		).toMatchObject({ result: { sessionId: run.sessionId!, closed: true } });
		expect(await connection.handle(request("session/open", { sessionId: run.sessionId! }))).toMatchObject({
			result: { session: { sessionId: run.sessionId! } },
		});
		await vi.waitFor(() =>
			expect(
				events
					.flatMap((event) =>
						"method" in event && event.method === "connection/events" ? event.params.events : [],
					)
					.some(
						(event) =>
							event.type === "schedule/runUpdated" &&
							event.run.id === RUN_ID &&
							event.run.status === "succeeded",
					),
			).toBe(true),
		);
		expect(refresh).not.toHaveBeenCalled();
		const visibleFile = server.catalog.get(run.sessionId!).path;
		await connection.handle(
			request("schedule/create", {
				requestId: RETAIN_TASK_ID,
				sourceSessionId: SOURCE_ID,
				name: "保留历史",
				instruction: "生成保留结果",
				model: MODEL,
				schedule: { kind: "daily", time: "09:30" },
			}),
		);
		await connection.handle(request("schedule/run-now", { requestId: RETAIN_RUN_ID, taskId: RETAIN_TASK_ID }));
		const retainedRun = await waitForRun(connection, RETAIN_TASK_ID, RETAIN_RUN_ID);
		await vi.waitFor(() => expect(server!.catalog.get(retainedRun.sessionId!).scheduled).toBeDefined());
		const retainedFile = server.catalog.get(retainedRun.sessionId!).path;
		expect(
			await connection.handle(
				request("schedule/delete", {
					requestId: "50000000-0000-4000-8000-000000000006",
					taskId: RETAIN_TASK_ID,
					deleteSessions: false,
				}),
			),
		).toMatchObject({
			result: { deleted: true, deletedSessionCount: 0, retainedSessionCount: 1 },
		});
		expect(existsSync(retainedFile)).toBe(true);
		expect(JSON.stringify(await connection.handle(request("session/list", {})))).toContain(retainedRun.sessionId!);
		expect(JSON.stringify(await connection.handle(request("schedule/list", {})))).not.toContain(RETAIN_TASK_ID);

		server.beginShutdown();
		await server.waitForShutdown();
		server = await AppServer.create({
			agentDir,
			scheduleManager: managerWithTestTrash(agentDir, async () => Promise.reject(new Error("unused"))),
		});
		connection = server.connect();
		connection.onMessage(recordEvent);
		await connection.handle(initialize());
		expect(JSON.stringify(await connection.handle(request("session/list", {})))).toContain(run.sessionId!);
		expect(JSON.stringify(await connection.handle(request("session/list", {})))).toContain(retainedRun.sessionId!);
		expect(await connection.handle(request("session/open", { sessionId: retainedRun.sessionId! }))).toMatchObject({
			result: {
				session: { sessionId: retainedRun.sessionId!, scheduled: { taskId: RETAIN_TASK_ID, runId: RETAIN_RUN_ID } },
			},
		});
		expect(await connection.handle(request("session/open", { sessionId: run.sessionId! }))).toMatchObject({
			result: { session: { sessionId: run.sessionId!, scheduled: { taskId: TASK_ID, runId: RUN_ID } } },
		});
		vi.spyOn(SessionManager, "deleteSession").mockImplementation(async (path) => {
			rmSync(path, { force: true });
			return { ok: true, method: "trash" };
		});
		expect(
			await connection.handle(
				request("session/delete", {
					sessionId: run.sessionId!,
					requestId: "60000000-0000-4000-8000-000000000001",
				}),
			),
		).toMatchObject({ error: { code: RPC_ERROR_CODES.READ_ONLY_SESSION } });
		expect(
			await connection.handle(
				request("session/delete", {
					sessionId: retainedRun.sessionId!,
					requestId: "60000000-0000-4000-8000-000000000002",
				}),
			),
		).toMatchObject({ result: { sessionId: retainedRun.sessionId!, deleted: true } });
		expect(existsSync(retainedFile)).toBe(false);
		expect(JSON.stringify(await connection.handle(request("session/list", {})))).not.toContain(
			retainedRun.sessionId!,
		);
		const originalJournal = readFileSync(visibleFile, "utf8");
		const wrongModeJournal = originalJournal.replace('"mode":"chat"', '"mode":"code"');
		expect(wrongModeJournal).not.toBe(originalJournal);
		writeFileSync(visibleFile, wrongModeJournal);
		expect(await connection.handle(request("schedule/run/get", { taskId: TASK_ID, runId: RUN_ID }))).toMatchObject({
			error: { code: RPC_ERROR_CODES.SESSION_CORRUPT },
		});
		writeFileSync(visibleFile, originalJournal);
		const forgedJournal = originalJournal.replace(RUN_ID, FIXED_TASK_ID);
		writeFileSync(visibleFile, forgedJournal);
		expect(await connection.handle(request("schedule/run/get", { taskId: TASK_ID, runId: RUN_ID }))).toMatchObject({
			error: { code: RPC_ERROR_CODES.SESSION_CORRUPT },
		});
		writeFileSync(visibleFile, originalJournal);
		expect(await connection.handle(request("schedule/run/get", { taskId: TASK_ID, runId: RUN_ID }))).toHaveProperty(
			"result.run.sessionId",
			run.sessionId,
		);
		await connection.handle(
			request("session/close", {
				sessionId: run.sessionId!,
				requestId: "50000000-0000-4000-8000-000000000005",
			}),
		);
		writeFileSync(visibleFile, forgedJournal);
		expect(await connection.handle(request("session/open", { sessionId: run.sessionId! }))).toMatchObject({
			error: { code: RPC_ERROR_CODES.SESSION_CORRUPT },
		});
		writeFileSync(visibleFile, originalJournal);
		await connection.handle(request("schedule/run/get", { taskId: TASK_ID, runId: RUN_ID }));
		expect(await connection.handle(request("session/open", { sessionId: run.sessionId! }))).toMatchObject({
			result: { session: { sessionId: run.sessionId! } },
		});
		expect(await connection.handle(request("session/markRead", { sessionId: run.sessionId! }))).toMatchObject({
			result: { session: { sessionId: run.sessionId!, unread: false } },
		});
		expect(await connection.handle(request("schedule/run/get", { taskId: TASK_ID, runId: RUN_ID }))).toMatchObject({
			result: { run: { unread: false } },
		});

		const marked = await connection.handle(
			request("schedule/run/mark-read", {
				requestId: "50000000-0000-4000-8000-000000000002",
				taskId: TASK_ID,
				runId: RUN_ID,
			}),
		);
		expect(marked).toMatchObject({ result: { run: { unread: false }, unreadCount: 0 } });
		const listRuns = vi.spyOn(server.scheduleManager, "listRuns");
		const deleted = await connection.handle(
			request("schedule/delete", {
				requestId: "50000000-0000-4000-8000-000000000003",
				taskId: TASK_ID,
				deleteSessions: true,
			}),
		);
		expect(deleted).toMatchObject({ result: { taskId: TASK_ID, deleted: true } });
		expect(listRuns).not.toHaveBeenCalled();
		expect(server.registry.has(run.sessionId!)).toBe(false);
		expect(existsSync(visibleFile)).toBe(false);
		expect(existsSync(projectDir)).toBe(true);
		expect(JSON.stringify(await connection.handle(request("session/list", {})))).not.toContain(run.sessionId!);
		await vi.waitFor(() =>
			expect(
				events
					.flatMap((event) =>
						"method" in event && event.method === "connection/events" ? event.params.events : [],
					)
					.some(
						(event) =>
							event.type === "session/invalidated" &&
							event.sessionId === run.sessionId &&
							event.reason === "deleted",
					),
			).toBe(true),
		);
	});

	it("reports a corrupt schedule store explicitly while ordinary sessions remain available", async () => {
		tempDir = mkdtempSync(join(tmpdir(), "app-server-schedule-corrupt-"));
		const agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(agentDir, "schedules.json"), "not-json\n");
		server = await AppServer.create({ agentDir, scheduleExecute: async () => Promise.reject(new Error("unused")) });
		const connection = server.connect();
		await connection.handle(initialize());

		expect(await connection.handle(request("schedule/list", {}))).toMatchObject({
			error: { data: { name: "SCHEDULE_STORE_CORRUPT", retryable: false } },
		});
		expect(
			await connection.handle(request("session/create", { requestId: SOURCE_ID, mode: "code", cwd: projectDir })),
		).toMatchObject({ result: { session: { sessionId: SOURCE_ID } } });
	});
});
