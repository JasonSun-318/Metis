import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createSandbox: vi.fn(),
	createServices: vi.fn(),
	createSession: vi.fn(),
	prompts: [] as Array<{ text: string; options: unknown }>,
	sessionOptions: [] as unknown[],
	serviceOptions: [] as unknown[],
	rejectPrompt: undefined as ((error: Error) => void) | undefined,
	finalText: "日报完成" as string | undefined,
	finalStopReason: "stop",
	modelAvailable: true,
}));

vi.mock("../src/core/workspace-sandbox.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/core/workspace-sandbox.ts")>()),
	createWorkspaceSandbox: mocks.createSandbox,
}));

vi.mock("../src/core/agent-session-services.ts", () => ({
	createAgentSessionServices: mocks.createServices,
	createAgentSessionFromServices: mocks.createSession,
}));

import { reduceRuntimeJournal } from "../src/core/runtime-recovery.ts";
import { createScheduledRunExecutor, SCHEDULE_EXECUTION_PROMPT } from "../src/core/schedules/executor.ts";
import type { ScheduleRunClaim } from "../src/core/schedules/types.ts";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";

const roots: string[] = [];

function tempWorkspace(): string {
	const root = mkdtempSync(join(tmpdir(), "metis-schedule-executor-"));
	roots.push(root);
	const workspace = join(root, "workspace");
	mkdirSync(workspace);
	return realpathSync(workspace);
}

function claim(cwd: string, runId: string, fixed = false): ScheduleRunClaim {
	return {
		taskId: "task-executor",
		runId,
		sessionId: `session-${runId}`,
		scheduledFor: "2026-07-26T00:00:00Z",
		snapshot: {
			name: "生成日报",
			instruction: "生成日报",
			model: { provider: "openai", modelId: "gpt-test" },
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: fixed ? "fixed" : "task", cwd },
		},
	};
}

beforeEach(() => {
	mocks.prompts.length = 0;
	mocks.sessionOptions.length = 0;
	mocks.serviceOptions.length = 0;
	mocks.rejectPrompt = undefined;
	mocks.finalText = "日报完成";
	mocks.finalStopReason = "stop";
	mocks.modelAvailable = true;
	mocks.createSandbox.mockReset().mockImplementation(async () => ({
		operations: { exec: vi.fn() },
		dispose: vi.fn(),
	}));
	mocks.createServices.mockReset().mockImplementation(async (options) => {
		mocks.serviceOptions.push(options);
		const model = { provider: "openai", id: "gpt-test" };
		return {
			...options,
			resourceLoader: { dispose: vi.fn() },
			modelRegistry: {
				find: vi.fn(() => (mocks.modelAvailable ? model : undefined)),
				hasConfiguredAuth: vi.fn(() => mocks.modelAvailable),
			},
		};
	});
	mocks.createSession.mockReset().mockImplementation(async (options) => {
		mocks.sessionOptions.push(options);
		let idle = true;
		let activeIdentity:
			| {
					requestId: string;
					requestHash: string;
					operationId: string;
					turnId: string;
			  }
			| undefined;
		const runPrompt = async (text: string, promptOptions: unknown, turnId?: string) => {
			idle = false;
			mocks.prompts.push({ text, options: promptOptions });
			options.sessionManager.appendMessage(
				{
					role: "user",
					content: [{ type: "text", text }],
					timestamp: Date.now(),
				},
				undefined,
				turnId,
			);
			if (mocks.rejectPrompt) {
				await new Promise<void>((_resolve, reject) => {
					mocks.rejectPrompt = reject;
				});
			}
			idle = true;
		};
		const session = {
			get messages() {
				return [{ role: "assistant", stopReason: mocks.finalStopReason }];
			},
			get isIdle() {
				return idle;
			},
			prompt: runPrompt,
			assertCanDrainAgentEventPersistence: vi.fn(),
			assertDurablePromptCapacity: vi.fn(),
			prepareDurablePrompt: vi.fn(),
			beginDurableDirectTurn: vi.fn((identity) => {
				activeIdentity = identity;
				options.sessionManager.appendRuntimeControl({
					type: "runtime_turn",
					turnId: identity.turnId,
					operationIds: [identity.operationId],
					state: "started",
					consumedQueueItemIds: [],
				});
			}),
			runAcceptedDurablePrompt: vi.fn(async (turnId, input) => {
				await runPrompt(input.text, { expandPromptTemplates: false, source: "rpc" }, turnId);
				options.sessionManager.appendMessage(
					{
						role: "assistant",
						content: [{ type: "text", text: mocks.finalText ?? "" }],
						api: "openai-completions",
						provider: "openai",
						model: "gpt-test",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: mocks.finalStopReason,
						timestamp: Date.now(),
					},
					undefined,
					turnId,
				);
				const state = mocks.finalStopReason === "stop" ? "completed" : "interrupted";
				options.sessionManager.appendRuntimeControl({
					type: "runtime_turn",
					turnId,
					operationIds: [activeIdentity!.operationId],
					state,
					consumedQueueItemIds: [],
				});
				options.sessionManager.appendRuntimeControl({
					type: "runtime_operation",
					operationId: activeIdentity!.operationId,
					requestId: activeIdentity!.requestId,
					requestHash: activeIdentity!.requestHash,
					kind: "turn",
					state,
					turnId,
				});
			}),
			waitForIdle: vi.fn(async () => {}),
			abort: vi.fn(async () => {
				idle = true;
				mocks.rejectPrompt?.(new Error("aborted"));
			}),
			getLastAssistantText: vi.fn(() => mocks.finalText),
			dispose: vi.fn(() => {
				options.services.resourceLoader.dispose();
				options.sessionManager.close();
			}),
		};
		return { session, extensionsResult: { extensions: [], runtime: {} } };
	});
});

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("scheduled run executor", () => {
	it("creates a fresh visible Chat session with only the saved instruction", async () => {
		const cwd = tempWorkspace();
		const agentDir = join(cwd, ".agent");
		const executor = createScheduledRunExecutor({ agentDir });
		const first = await executor(claim(cwd, "run-first"), new AbortController().signal);
		const second = await executor(claim(cwd, "run-second"), new AbortController().signal);
		expect(first.sessionId).not.toBe(second.sessionId);
		for (const result of [first, second]) {
			const normalRoot = getDefaultSessionDir(cwd, agentDir);
			expect(relative(normalRoot, result.sessionFile).startsWith(`..${sep}`)).toBe(false);
			const session = SessionManager.openReadOnly(result.sessionFile);
			expect(session.getHeader()?.scheduled).toEqual({ taskId: "task-executor", runId: result.runId });
			expect(session.getHeader()?.mode).toBe("chat");
			expect(session.getHeader()?.cwdOrigin).toBe("managed");
			expect(session.getSessionName()).toBe("生成日报");
			const journal = session.getDurableJournalSnapshot();
			const [turn] = reduceRuntimeJournal(journal).turns;
			expect(turn).toMatchObject({ state: "completed", operationIds: [expect.any(String)] });
			expect(
				journal.filter((entry) => entry.type === "message").every((entry) => entry.turnId === turn!.turnId),
			).toBe(true);
			expect(
				session
					.getBranch()
					.filter((entry) => entry.type === "message" && entry.message.role === "user")
					.map((entry) => (entry.type === "message" ? entry.message : undefined)),
			).toEqual([
				expect.objectContaining({
					role: "user",
					content: [expect.objectContaining({ type: "text", text: "生成日报" })],
				}),
			]);
		}
		expect(mocks.prompts).toEqual([
			{ text: "生成日报", options: { expandPromptTemplates: false, source: "rpc" } },
			{ text: "生成日报", options: { expandPromptTemplates: false, source: "rpc" } },
		]);
		expect(
			(await SessionManager.list(cwd, getDefaultSessionDir(cwd, agentDir))).map(({ id, scheduled }) => ({
				id,
				scheduled,
			})),
		).toEqual(
			expect.arrayContaining([
				{ id: first.sessionId, scheduled: { taskId: "task-executor", runId: "run-first" } },
				{ id: second.sessionId, scheduled: { taskId: "task-executor", runId: "run-second" } },
			]),
		);
	});

	it("derives mode, enables Skills, and excludes extensions, schedule, MCP, and subagents", async () => {
		const cwd = tempWorkspace();
		const agentDir = join(cwd, ".agent");
		const result = await createScheduledRunExecutor({ agentDir })(
			claim(cwd, "run-project", true),
			new AbortController().signal,
		);
		const options = mocks.sessionOptions[0] as Record<string, unknown>;
		expect(SessionManager.openReadOnly(result.sessionFile).getHeader()).toMatchObject({
			mode: "chat",
			cwdOrigin: "user-selected",
		});
		expect(options.additionalSystemPrompt).toBe(SCHEDULE_EXECUTION_PROMPT);
		expect(options.includeAutoMemory).toBe(false);
		expect(options.model).toMatchObject({ provider: "openai", id: "gpt-test" });
		expect(options.customTools).toEqual([]);
		expect(options.tools).toEqual(expect.arrayContaining(["read", "write", "bash", "web_fetch"]));
		expect(options.tools).not.toEqual(expect.arrayContaining(["schedule", "spawn_agent"]));
		expect(mocks.serviceOptions[0]).toMatchObject({
			resourceLoaderOptions: { noExtensions: true, noPromptTemplates: true, noThemes: true },
		});
		expect(
			(mocks.serviceOptions[0] as { resourceLoaderOptions: Record<string, unknown> }).resourceLoaderOptions,
		).not.toHaveProperty("noSkills");
	});

	it("grants a task workspace and one additional folder to the sandbox", async () => {
		const cwd = tempWorkspace();
		const additionalWorkspaceCwd = tempWorkspace();
		const base = claim(cwd, "run-additional-workspace");
		const input: ScheduleRunClaim = {
			...base,
			snapshot: {
				...base.snapshot,
				target: {
					kind: "general",
					workspace: "task",
					cwd,
					additionalWorkspaceCwd,
				},
			},
		};
		await createScheduledRunExecutor({ agentDir: join(cwd, ".agent") })(input, new AbortController().signal);
		expect(mocks.createSandbox).toHaveBeenCalledWith({
			cwd,
			workspaceRoots: [cwd, additionalWorkspaceCwd],
			signal: expect.any(AbortSignal),
		});
		expect(mocks.sessionOptions[0]).toMatchObject({
			unattendedExecution: { workspaceRoots: [cwd, additionalWorkspaceCwd] },
		});
	});

	it("fails before runtime creation for missing workspaces and maps sandbox startup failure", async () => {
		const missing = join(tempWorkspace(), "missing");
		const executor = createScheduledRunExecutor({ agentDir: join(missing, ".agent") });
		await expect(executor(claim(missing, "run-missing"), new AbortController().signal)).rejects.toMatchObject({
			code: "WORKSPACE_MISSING",
		});
		expect(mocks.createSandbox).not.toHaveBeenCalled();

		const cwd = tempWorkspace();
		const missingBase = claim(cwd, "run-missing-additional");
		const missingAdditional: ScheduleRunClaim = {
			...missingBase,
			snapshot: {
				...missingBase.snapshot,
				target: {
					kind: "general",
					workspace: "task",
					cwd,
					additionalWorkspaceCwd: join(cwd, "missing"),
				},
			},
		};
		await expect(executor(missingAdditional, new AbortController().signal)).rejects.toMatchObject({
			code: "WORKSPACE_MISSING",
		});
		expect(mocks.createSandbox).not.toHaveBeenCalled();

		mocks.createSandbox.mockRejectedValueOnce(new Error("not supported"));
		await expect(
			createScheduledRunExecutor({ agentDir: join(cwd, ".agent") })(
				claim(cwd, "run-sandbox"),
				new AbortController().signal,
			),
		).rejects.toMatchObject({ code: "SANDBOX_UNAVAILABLE" });
	});

	it("fails closed before journal creation when the pinned model is unavailable", async () => {
		const cwd = tempWorkspace();
		mocks.modelAvailable = false;
		await expect(
			createScheduledRunExecutor({ agentDir: join(cwd, ".agent") })(
				claim(cwd, "run-model-unavailable"),
				new AbortController().signal,
			),
		).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
		expect(mocks.createSession).not.toHaveBeenCalled();
	});

	it("rejects incomplete model executions instead of recording a false success", async () => {
		const cwd = tempWorkspace();
		const executor = createScheduledRunExecutor({ agentDir: join(cwd, ".agent") });
		mocks.finalStopReason = "error";
		await expect(executor(claim(cwd, "run-error"), new AbortController().signal)).rejects.toMatchObject({
			code: "EXECUTION_FAILED",
			message: "Scheduled task model execution did not complete successfully",
			executionSession: {
				sessionId: expect.any(String),
				sessionFile: expect.stringContaining(`${sep}sessions${sep}`),
			},
		});

		mocks.finalStopReason = "stop";
		mocks.finalText = undefined;
		await expect(executor(claim(cwd, "run-empty"), new AbortController().signal)).rejects.toThrow(
			"returned no final text result",
		);
	});

	it("preserves the execution failure when cleanup also fails", async () => {
		const cwd = tempWorkspace();
		mocks.finalStopReason = "error";
		mocks.createSandbox.mockResolvedValueOnce({
			operations: { exec: vi.fn() },
			dispose: vi.fn(async () => {
				throw new Error("cleanup failed");
			}),
		});
		await expect(
			createScheduledRunExecutor({ agentDir: join(cwd, ".agent") })(
				claim(cwd, "run-error-cleanup"),
				new AbortController().signal,
			),
		).rejects.toMatchObject({
			code: "EXECUTION_FAILED",
			message: "Scheduled task model execution did not complete successfully",
		});
	});

	it("closes the journal when pre-session resource cleanup fails", async () => {
		const cwd = tempWorkspace();
		const close = vi.spyOn(SessionManager.prototype, "close");
		mocks.createServices.mockResolvedValueOnce({
			modelRegistry: {
				find: vi.fn(() => ({ provider: "openai", id: "gpt-test" })),
				hasConfiguredAuth: vi.fn(() => true),
			},
			resourceLoader: {
				dispose: vi.fn(() => {
					throw new Error("resource cleanup failed");
				}),
			},
		});
		mocks.createSession.mockRejectedValueOnce(new Error("runtime creation failed"));
		try {
			await expect(
				createScheduledRunExecutor({ agentDir: join(cwd, ".agent") })(
					claim(cwd, "run-create-failed"),
					new AbortController().signal,
				),
			).rejects.toMatchObject({
				code: "EXECUTION_FAILED",
				message: "runtime creation failed",
				executionSession: { sessionId: expect.any(String), sessionFile: expect.any(String) },
			});
			expect(close).toHaveBeenCalledOnce();
			const sandbox = await mocks.createSandbox.mock.results[0].value;
			expect(sandbox.dispose).toHaveBeenCalledOnce();
		} finally {
			close.mockRestore();
		}
	});

	it("aborts an active prompt and disposes every owned resource", async () => {
		const cwd = tempWorkspace();
		mocks.rejectPrompt = () => {};
		const controller = new AbortController();
		const promise = createScheduledRunExecutor({ agentDir: join(cwd, ".agent") })(
			claim(cwd, "run-abort"),
			controller.signal,
		);
		await vi.waitFor(() => expect(mocks.prompts).toHaveLength(1));
		controller.abort();
		await expect(promise).rejects.toThrow("aborted");
		const sandbox = await mocks.createSandbox.mock.results[0].value;
		expect(sandbox.dispose).toHaveBeenCalledOnce();
		const services = await mocks.createServices.mock.results[0].value;
		expect(services.resourceLoader.dispose).toHaveBeenCalledOnce();
	});
});
