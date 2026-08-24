import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@metis/agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@metis/ai";
import { getModel } from "@metis/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { getMemorySqlitePath } from "../src/core/auto-memory.ts";
import type { MemoryExtractResult, RunMemoryExtractOptions } from "../src/core/memory/memory-extract.ts";
import { openMemoryStore } from "../src/core/memory/memory-store.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function extractResult(status: MemoryExtractResult["status"], options: { reason?: string } = {}): MemoryExtractResult {
	return {
		status,
		runId: "extract-test",
		...(options.reason ? { reason: options.reason } : {}),
	};
}

function setExtractRunner(
	session: AgentSession,
	runner: (options: RunMemoryExtractOptions) => Promise<MemoryExtractResult>,
): void {
	(session as unknown as { _memoryExtractRunner: typeof runner })._memoryExtractRunner = runner;
}

function createCompactionSession(): {
	session: AgentSession;
	events: AgentSessionEvent[];
	cwd: string;
	agentDir: string;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
} {
	const root = mkdtempSync(join(tmpdir(), "metis-session-extract-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
	mkdirSync(cwd);
	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const streamFn: Agent["streamFn"] = (requestModel) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					...fauxAssistantMessage("compacted"),
					api: requestModel.api,
					provider: requestModel.provider,
					model: requestModel.id,
				},
			});
		});
		return stream;
	};
	const agent = new Agent({
		initialState: { model, thinkingLevel: "off", systemPrompt: "Test", tools: [] },
		streamFn,
		transport: "sse",
	});
	const sessionManager = SessionManager.inMemory(cwd);
	const now = Date.now();
	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "fact already summarized" }],
		timestamp: now - 2,
	});
	sessionManager.appendMessage({
		...fauxAssistantMessage("old response"),
		api: model.api,
		provider: model.provider,
		model: model.id,
		timestamp: now - 1,
	});
	const firstKeptEntryId = sessionManager.getEntries()[0]!.id;
	sessionManager.appendCompaction("previous-summary-marker", firstKeptEntryId, 100, undefined, false);
	for (let turn = 0; turn < 2; turn++) {
		sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: `verified user fact ${turn}` }],
			timestamp: now + turn * 2,
		});
		const assistant: AgentMessage = {
			...fauxAssistantMessage(`assistant response ${turn}`),
			api: model.api,
			provider: model.provider,
			model: model.id,
			timestamp: now + turn * 2 + 1,
		};
		sessionManager.appendMessage(assistant);
	}
	agent.state.messages = sessionManager.buildSessionContext().messages;
	const settingsManager = SettingsManager.inMemory({ autoMemoryEnabled: true });
	settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		agentDir,
		modelRegistry: ModelRegistry.inMemory(authStorage),
		resourceLoader: createTestResourceLoader(),
	});
	const events: AgentSessionEvent[] = [];
	session.subscribe((event) => events.push(event));
	return { session, events, cwd, agentDir, sessionManager, settingsManager };
}

function scheduleThrottled(session: AgentSession): void {
	(
		session as unknown as {
			_scheduleThrottledMemoryExtract: () => void;
		}
	)._scheduleThrottledMemoryExtract();
}

describe("AgentSession memory extract", () => {
	it("waits for extract, exposes live status, and rejects overlapping compaction", async () => {
		let finishExtract!: (result: MemoryExtractResult) => void;
		const extractPromise = new Promise<MemoryExtractResult>((resolve) => {
			finishExtract = resolve;
		});
		const runner = vi.fn((_options: RunMemoryExtractOptions) => extractPromise);
		const { session, events, cwd } = createCompactionSession();
		setExtractRunner(session, runner);

		const compactPromise = session.compact();
		await expect(session.compact()).rejects.toThrow("Compaction already in progress");
		await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
		expect(session.getMemoryExtractStatus().active).toMatchObject({
			cwd,
			mode: "code",
			extractMode: "reconcile",
		});
		expect(events.some((event) => event.type === "compaction_end")).toBe(false);

		finishExtract(extractResult("success"));
		await compactPromise;
		expect(session.getMemoryExtractStatus().active).toBeUndefined();
		expect(events.filter((event) => event.type === "compaction_end")).toHaveLength(1);
		session.dispose();
	});

	it("isolates extract failures and excludes prior synthetic summaries", async () => {
		const { session } = createCompactionSession();
		const runner = vi.fn(async (_options: RunMemoryExtractOptions) =>
			extractResult("failed", { reason: "invalid extract payload" }),
		);
		setExtractRunner(session, runner);

		await expect(session.compact()).resolves.toMatchObject({ summary: expect.stringContaining("compacted") });
		const input = runner.mock.calls[0]![0];
		expect(input.mode).toBe("reconcile");
		expect(input.thinkingLevel).toBe("off");
		expect(input.evidence?.length).toBeGreaterThan(0);
		expect(input.transport).toBe("sse");
		expect(input.evidence).not.toContain("previous-summary-marker");
		session.dispose();
	});

	it("does not start extract while long-term memory is off", async () => {
		const { session, settingsManager } = createCompactionSession();
		const runner = vi.fn(async (_options: RunMemoryExtractOptions) => extractResult("success"));
		setExtractRunner(session, runner);
		settingsManager.setAutoMemoryEnabled(false);
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });

		await session.compact();
		expect(runner).not.toHaveBeenCalled();
		session.dispose();
	});

	it("does not start extract after compaction has already been cancelled", async () => {
		const { session } = createCompactionSession();
		const runner = vi.fn(async (_options: RunMemoryExtractOptions) => extractResult("success"));
		const compactWork = vi.fn(async () => ({ summary: "should not run" }));
		setExtractRunner(session, runner);
		const controller = new AbortController();
		controller.abort();
		const compactWithMemoryExtract = Reflect.get(session, "_compactWithMemoryExtract") as (
			preparation: { messagesToSummarize: AgentMessage[]; turnPrefixMessages: AgentMessage[] },
			reason: "manual",
			signal: AbortSignal,
			work: typeof compactWork,
		) => Promise<unknown>;

		await expect(
			compactWithMemoryExtract.call(
				session,
				{ messagesToSummarize: [], turnPrefixMessages: [] },
				"manual",
				controller.signal,
				compactWork,
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(runner).not.toHaveBeenCalled();
		expect(compactWork).not.toHaveBeenCalled();
		session.dispose();
	});

	it.each(["threshold", "overflow"] as const)("runs reconcile extract for %s auto-compaction", async (reason) => {
		const { session } = createCompactionSession();
		const runner = vi.fn(async (_options: RunMemoryExtractOptions) => extractResult("skipped"));
		setExtractRunner(session, runner);
		const runAutoCompaction = (
			session as unknown as {
				_runAutoCompaction: (trigger: "threshold" | "overflow", willRetry: boolean) => Promise<boolean>;
			}
		)._runAutoCompaction.bind(session);

		await runAutoCompaction(reason, reason === "overflow");

		expect(runner).toHaveBeenCalledOnce();
		expect(runner.mock.calls[0]![0].mode).toBe("reconcile");
		expect(runner.mock.calls[0]![0].trigger).toBe(reason);
		session.dispose();
	});

	it("rejects direct extension commands and bash while compacting", async () => {
		const { session } = createCompactionSession();
		vi.spyOn(session.extensionRunner, "getCommand").mockReturnValue({} as never);
		const controller = new AbortController();
		(session as unknown as { _compactionAbortController?: AbortController })._compactionAbortController = controller;

		await expect(session.prompt("/test-command")).rejects.toThrow(
			"Wait for compaction to finish before running extension commands",
		);
		await expect(session.executeBash("echo unsafe")).rejects.toThrow(
			"Wait for compaction to finish before running bash",
		);

		controller.abort();
		(session as unknown as { _compactionAbortController?: AbortController })._compactionAbortController = undefined;
		session.dispose();
	});

	it("does not run throttled commit extract on the first three generic user turns", async () => {
		const { session } = createCompactionSession();
		const runner = vi.fn(async (_options: RunMemoryExtractOptions) => extractResult("success"));
		setExtractRunner(session, runner);
		session.agent.state.messages = [
			{
				role: "user",
				content: [{ type: "text", text: "fix this" }],
				timestamp: Date.now(),
			},
		];

		scheduleThrottled(session);
		scheduleThrottled(session);
		scheduleThrottled(session);
		await session.waitForMemoryExtract();
		expect(runner).not.toHaveBeenCalled();
		session.dispose();
	});

	it("runs throttled commit extract on the fourth user turn", async () => {
		const { session } = createCompactionSession();
		const runner = vi.fn(async (_options: RunMemoryExtractOptions) => extractResult("success"));
		setExtractRunner(session, runner);
		session.agent.state.messages = [
			{
				role: "user",
				content: [{ type: "text", text: "fix this" }],
				timestamp: Date.now(),
			},
		];

		scheduleThrottled(session);
		scheduleThrottled(session);
		scheduleThrottled(session);
		scheduleThrottled(session);
		await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
		const input = runner.mock.calls[0]![0];
		expect(input.mode).toBe("commit");
		expect(input.trigger).toBe("turn");
		await session.waitForMemoryExtract();
		session.dispose();
	});

	it("runs throttled commit extract immediately on durable-intent user text", async () => {
		const { session } = createCompactionSession();
		const runner = vi.fn(async (_options: RunMemoryExtractOptions) => extractResult("success"));
		setExtractRunner(session, runner);
		session.agent.state.messages = [
			{
				role: "user",
				content: [{ type: "text", text: "请记住以后用中文回复" }],
				timestamp: Date.now(),
			},
		];

		scheduleThrottled(session);
		await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
		expect(runner.mock.calls[0]![0].mode).toBe("commit");
		await session.waitForMemoryExtract();
		session.dispose();
	});

	it("does not attach an Embedding adapter while the memory engine is Index", async () => {
		const { session } = createCompactionSession();
		const runner = vi.fn(async (_options: RunMemoryExtractOptions) => extractResult("success"));
		const createEmbedder = vi.fn(async () => ({
			key: "configured-embedding",
			embed: async () => [new Float32Array([1])],
		}));
		setExtractRunner(session, runner);
		(
			session as unknown as {
				_createMemoryEmbedder: typeof createEmbedder;
			}
		)._createMemoryEmbedder = createEmbedder;
		session.agent.state.messages = [{ role: "user", content: "remember without vectors", timestamp: Date.now() }];

		scheduleThrottled(session);
		await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
		expect(createEmbedder).not.toHaveBeenCalled();
		expect(runner.mock.calls[0]![0]).not.toHaveProperty("embedTexts");
		await session.waitForMemoryExtract();
		session.dispose();
	});

	it("resumes pending Index evidence immediately after a settings refresh", async () => {
		const { session } = createCompactionSession();
		const runner = vi.fn(async (_options: RunMemoryExtractOptions) => extractResult("success"));
		setExtractRunner(session, runner);

		await session.applyModelServiceSettingsRefresh();
		await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
		expect(runner.mock.calls[0]![0]).toMatchObject({ mode: "commit", trigger: "settings-refresh" });
		await session.waitForMemoryExtract();
		session.dispose();
	});

	it("drains entries appended during an active extract", async () => {
		let finishFirst!: (result: MemoryExtractResult) => void;
		const first = new Promise<MemoryExtractResult>((resolve) => {
			finishFirst = resolve;
		});
		const runner = vi.fn(async (_options: RunMemoryExtractOptions) => {
			if (runner.mock.calls.length === 1) return first;
			return extractResult("success");
		});
		const { session, sessionManager } = createCompactionSession();
		setExtractRunner(session, runner);
		const firstMessage: AgentMessage = { role: "user", content: "remember first", timestamp: Date.now() };
		sessionManager.appendMessage(firstMessage);
		session.agent.state.messages = [firstMessage];
		scheduleThrottled(session);
		await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
		sessionManager.appendMessage({ role: "user", content: "remember second", timestamp: Date.now() + 1 });
		finishFirst(extractResult("success"));
		await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(2));
		await session.waitForMemoryExtract();
		expect(runner.mock.calls[1]![0].evidence).toContain("remember second");
		expect(runner.mock.calls[1]![0].evidence).not.toContain("remember first");
		session.dispose();
	});

	it("does not report background extraction as Compact or block Bash", async () => {
		let finish!: (result: MemoryExtractResult) => void;
		const pending = new Promise<MemoryExtractResult>((resolve) => {
			finish = resolve;
		});
		const { session } = createCompactionSession();
		setExtractRunner(session, () => pending);
		const message: AgentMessage = { role: "user", content: "remember background", timestamp: Date.now() };
		session.agent.state.messages = [message];
		scheduleThrottled(session);
		await vi.waitFor(() => expect(session.getMemoryExtractStatus().active).toBeDefined());
		expect(session.isCompacting).toBe(false);
		await expect(session.executeBash("printf ok")).resolves.toMatchObject({ exitCode: 0 });
		finish(extractResult("success"));
		await session.waitForMemoryExtract();
		session.dispose();
	});

	it("times out an injected runner, preserves the cursor, and releases active state", async () => {
		const { session, agentDir } = createCompactionSession();
		setExtractRunner(session, () => new Promise<MemoryExtractResult>(() => {}));
		(session as unknown as { _memoryExtractTimeoutMs: number })._memoryExtractTimeoutMs = 10;
		const message: AgentMessage = { role: "user", content: "remember timeout", timestamp: Date.now() };
		session.agent.state.messages = [message];
		scheduleThrottled(session);
		await session.waitForMemoryExtract();
		expect(session.getMemoryExtractStatus().active).toBeUndefined();
		const store = openMemoryStore(getMemorySqlitePath(agentDir));
		expect(store.getExtractCursor(session.sessionId)).toBeNull();
		expect(store.listHealth()).toContainEqual(expect.objectContaining({ operation: "extract", status: "error" }));
		store.close();
		session.dispose();
	});

	it("skips throttled commit extract while compact reconcile is running", async () => {
		let finishExtract!: (result: MemoryExtractResult) => void;
		const extractPromise = new Promise<MemoryExtractResult>((resolve) => {
			finishExtract = resolve;
		});
		const runner = vi.fn((_options: RunMemoryExtractOptions) => extractPromise);
		const { session } = createCompactionSession();
		setExtractRunner(session, runner);

		const compactPromise = session.compact();
		await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
		expect(session.getMemoryExtractStatus().active?.extractMode).toBe("reconcile");

		session.agent.state.messages = [
			{
				role: "user",
				content: [{ type: "text", text: "请记住这个偏好" }],
				timestamp: Date.now(),
			},
		];
		scheduleThrottled(session);
		expect(runner).toHaveBeenCalledOnce();

		finishExtract(extractResult("success"));
		await compactPromise;
		await session.waitForMemoryExtract();
		session.dispose();
	});
});
