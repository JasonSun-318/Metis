import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@arcmind/agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@arcmind/ai";
import { getModel } from "@arcmind/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type {
	DreamHistoryRecord,
	DreamRunStatus,
	DreamScopeChanges,
	MemoryDreamRunOptions,
} from "../src/core/memory-dream.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

const tempDirs: string[] = [];

afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function emptyChanges(): DreamScopeChanges {
	return { created: [], updated: [], deleted: [] };
}

function dreamRecord(
	status: DreamRunStatus,
	cwd: string,
	options: { reason?: string; changed?: boolean } = {},
): DreamHistoryRecord {
	const result = (file: "MEMORY.md" | "project.md") => ({
		status,
		changes: options.changed ? { created: [], updated: [file], deleted: [] } : emptyChanges(),
		durationMs: 500,
		...(options.reason ? { reason: options.reason } : {}),
	});
	return {
		id: "dream-test",
		sessionId: "session-test",
		mode: "code",
		cwd,
		trigger: "manual",
		startedAt: "2026-07-15T00:00:00.000Z",
		completedAt: "2026-07-15T00:00:01.000Z",
		durationMs: 1000,
		global: result("MEMORY.md"),
		project: result("project.md"),
	};
}

function setDreamRunner(
	session: AgentSession,
	runner: (options: MemoryDreamRunOptions) => Promise<DreamHistoryRecord>,
): void {
	(session as unknown as { _memoryDreamRunner: typeof runner })._memoryDreamRunner = runner;
}

function createCompactionSession(): {
	session: AgentSession;
	events: AgentSessionEvent[];
	cwd: string;
	settingsManager: SettingsManager;
} {
	const root = mkdtempSync(join(tmpdir(), "arcmind-session-dream-"));
	tempDirs.push(root);
	const agentDir = join(root, "agent");
	const cwd = join(root, "project");
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
	return { session, events, cwd, settingsManager };
}

describe("AgentSession memory Dream", () => {
	it("waits for Dream, exposes live status, and rejects overlapping compaction", async () => {
		let finishDream!: (record: DreamHistoryRecord) => void;
		const dreamPromise = new Promise<DreamHistoryRecord>((resolve) => {
			finishDream = resolve;
		});
		const runner = vi.fn(() => dreamPromise);
		const { session, events, cwd } = createCompactionSession();
		setDreamRunner(session, runner);

		const compactPromise = session.compact();
		await expect(session.compact()).rejects.toThrow("Compaction already in progress");
		await vi.waitFor(() => expect(runner).toHaveBeenCalledOnce());
		expect(session.getDreamStatus().active).toMatchObject({ cwd, mode: "code" });
		expect(events.some((event) => event.type === "compaction_end")).toBe(false);

		finishDream(dreamRecord("success", cwd, { changed: true }));
		await compactPromise;
		expect(session.getDreamStatus().active).toBeUndefined();
		expect(events.filter((event) => event.type === "compaction_end")).toHaveLength(1);
		session.dispose();
	});

	it("isolates Dream failures and excludes prior synthetic summaries", async () => {
		const { session, cwd } = createCompactionSession();
		const runner = vi.fn(async (_options: MemoryDreamRunOptions) =>
			dreamRecord("failed", cwd, { reason: "invalid Dream JSON" }),
		);
		setDreamRunner(session, runner);

		await expect(session.compact()).resolves.toMatchObject({ summary: expect.stringContaining("compacted") });
		const input = runner.mock.calls[0]![0];
		expect(input.messages.length).toBeGreaterThan(0);
		expect(input.transport).toBe("sse");
		expect(JSON.stringify(input.messages)).not.toContain("previous-summary-marker");
		expect(
			input.messages.every((message) => message.role !== "compactionSummary" && message.role !== "branchSummary"),
		).toBe(true);
		session.dispose();
	});

	it("does not start Dream while long-term memory is off", async () => {
		const { session, settingsManager } = createCompactionSession();
		const runner = vi.fn(async () => dreamRecord("success", "/project", { changed: true }));
		setDreamRunner(session, runner);
		settingsManager.setAutoMemoryEnabled(false);
		settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });

		await session.compact();
		expect(runner).not.toHaveBeenCalled();
		session.dispose();
	});

	it("does not start Dream after compaction has already been cancelled", async () => {
		const { session } = createCompactionSession();
		const runner = vi.fn(async () => dreamRecord("success", "/project", { changed: true }));
		const compactWork = vi.fn(async () => ({ summary: "should not run" }));
		setDreamRunner(session, runner);
		const controller = new AbortController();
		controller.abort();
		const compactWithDream = Reflect.get(session, "_compactWithDream") as (
			preparation: { messagesToSummarize: AgentMessage[]; turnPrefixMessages: AgentMessage[] },
			reason: "manual",
			signal: AbortSignal,
			work: typeof compactWork,
		) => Promise<unknown>;

		await expect(
			compactWithDream.call(
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

	it.each(["threshold", "overflow"] as const)("runs Dream for %s auto-compaction", async (reason) => {
		const { session, cwd } = createCompactionSession();
		const runner = vi.fn(async (_options: MemoryDreamRunOptions) => dreamRecord("skipped", cwd));
		setDreamRunner(session, runner);
		const runAutoCompaction = (
			session as unknown as {
				_runAutoCompaction: (trigger: "threshold" | "overflow", willRetry: boolean) => Promise<boolean>;
			}
		)._runAutoCompaction.bind(session);

		await runAutoCompaction(reason, reason === "overflow");

		expect(runner).toHaveBeenCalledOnce();
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
});
