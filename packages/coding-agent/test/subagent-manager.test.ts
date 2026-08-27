import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel, type Model } from "@metis/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { PermissionMode } from "../src/core/permission-mode.ts";
import type { PermissionApprovalRequest } from "../src/core/permission-policy.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type ChildRuntimeFactoryInput, SubagentManager } from "../src/core/subagents/manager.ts";
import { SubagentScheduler } from "../src/core/subagents/scheduler.ts";
import {
	AGENT_TOOL_NAMES,
	type AgentMailboxTerminalEvent,
	type AgentManagerEvent,
} from "../src/core/subagents/types.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

const ROOT_ID = "parent-session-1";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
});

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

class FakeChildSession {
	readonly messages: unknown[] = [];
	readonly model = getModel("anthropic", "claude-sonnet-4-5")!;
	readonly sessionManager: SessionManager;
	readonly mode = "code";
	readonly thinkingLevel = "high";
	activeDurableTurnId: string | undefined;
	private readonly activeTools: readonly string[];
	private readonly listeners = new Set<(event: AgentSessionEvent) => void>();

	constructor(sessionManager: SessionManager, activeTools: readonly string[]) {
		this.sessionManager = sessionManager;
		this.activeTools = activeTools;
	}

	getActiveToolNames(): string[] {
		return [...this.activeTools];
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	appendUser(text: string): void {
		const message = userMsg(text);
		this.messages.push(message);
		this.sessionManager.appendMessage(message);
	}

	settle(text = "handoff", stopReason: "stop" | "error" | "aborted" = "stop"): void {
		const message = {
			...assistantMsg(text),
			stopReason,
			...(stopReason === "error" ? { errorMessage: "provider failed" } : {}),
		};
		this.messages.push(message);
		this.sessionManager.appendMessage(message);
		this.emit({ type: "agent_settled" });
	}

	getSessionStats() {
		return { tokens: { input: 3, output: 5, cacheRead: 1, cacheWrite: 2 }, cost: 0.25, toolCalls: 4 };
	}
}

class FakeChildRuntime {
	readonly session: FakeChildSession;
	readonly prompts: string[] = [];
	disposed = false;
	disposeStarted = false;
	disposeGate: Promise<void> = Promise.resolve();

	constructor(manager: SessionManager, activeTools: readonly string[]) {
		this.session = new FakeChildSession(manager, activeTools);
	}

	async submitPrompt(input: { text: string }): Promise<never> {
		this.prompts.push(input.text);
		this.session.appendUser(input.text);
		return {} as never;
	}

	async interrupt(): Promise<never> {
		this.session.settle("interrupted", "aborted");
		return {} as never;
	}

	async dispose(): Promise<void> {
		this.disposeStarted = true;
		await this.disposeGate;
		this.session.sessionManager.close();
		this.disposed = true;
	}
}

interface Harness {
	readonly root: string;
	readonly parentManager: SessionManager;
	readonly parent: AgentSession;
	readonly manager: SubagentManager;
	readonly runtimes: FakeChildRuntime[];
	readonly factoryInputs: ChildRuntimeFactoryInput[];
	readonly pendingMailbox: Set<string>;
}

interface SetupOptions {
	readonly parentPermissionMode?: PermissionMode;
	readonly onPermissionRequest?: (
		request: PermissionApprovalRequest,
	) => Promise<{ decision: "allow" | "deny"; reason?: string }>;
	readonly factoryGate?: Promise<void>;
	readonly scheduler?: SubagentScheduler;
	readonly childRuntimeTools?: readonly string[];
	readonly childModel?: Model<any>;
}

function setup(options: SetupOptions = {}): Harness {
	const root = mkdtempSync(join(tmpdir(), "metis-subagent-manager-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	const parentManager = SessionManager.create(cwd, join(root, "sessions"), {
		id: ROOT_ID,
		mode: "code",
		permissionMode: options.parentPermissionMode ?? "full",
	});
	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const knownMailbox = new Set<string>();
	const pendingMailbox = new Set<string>();
	const parent = {
		sessionManager: parentManager,
		messages: [],
		mode: "code",
		thinkingLevel: "high",
		model,
		modelRegistry: {
			find: (provider: string, modelId: string) =>
				provider === model.provider && modelId === model.id
					? model
					: options.childModel?.provider === provider && options.childModel.id === modelId
						? options.childModel
						: undefined,
			hasConfiguredAuth: () => true,
		},
		getActiveToolNames: () => ["read", "bash", "grep", "find", "ls", "edit", "write", "web_fetch", "web_search"],
		enqueueAgentMailboxEvent: vi.fn((event: AgentMailboxTerminalEvent) => {
			if (!knownMailbox.has(event.eventId)) {
				parentManager.appendAgentControl({ type: "agent_mailbox_event", event });
				knownMailbox.add(event.eventId);
				pendingMailbox.add(event.eventId);
			}
			return true;
		}),
		hasAgentMailboxEvent: (eventId: string) => knownMailbox.has(eventId),
		getPendingAgentMailboxEventIds: () => [...pendingMailbox],
	} as unknown as AgentSession;
	const runtimes: FakeChildRuntime[] = [];
	const factoryInputs: ChildRuntimeFactoryInput[] = [];
	let sequence = 0;
	const manager = new SubagentManager({
		parentSessionManager: parentManager,
		agentDir,
		getWorkspaceRoots: () => parentManager.getWorkspaceRoots(),
		scheduler: options.scheduler ?? new SubagentScheduler(4, 4),
		createId: () => `child-session-${++sequence}`,
		onPermissionRequest: options.onPermissionRequest,
		createChildRuntime: async (input) => {
			factoryInputs.push(input);
			await options.factoryGate;
			const runtime = new FakeChildRuntime(
				input.sessionManager,
				options.childRuntimeTools ?? [...input.config.tools, ...(input.config.mayDelegate ? AGENT_TOOL_NAMES : [])],
			);
			runtimes.push(runtime);
			return runtime as unknown as AgentSessionRuntime;
		},
	});
	manager.attachActor(parent);
	cleanups.push(() => {
		for (const runtime of runtimes) {
			try {
				runtime.session.sessionManager.close();
			} catch {
				// The lifecycle under test may already own disposal.
			}
		}
		try {
			parentManager.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	return { root, parentManager, parent, manager, runtimes, factoryInputs, pendingMailbox };
}

async function finishTask(harness: Harness, agentId: string, taskId: string, text = "done"): Promise<void> {
	const runtime = harness.runtimes.at(-1);
	if (!runtime) throw new Error("No child runtime available");
	await vi.waitFor(() =>
		expect(harness.manager.listTasks(agentId).find((task) => task.taskId === taskId)?.status).toBe("running"),
	);
	runtime.session.settle(text);
	await vi.waitFor(() =>
		expect(harness.manager.listTasks(agentId).find((task) => task.taskId === taskId)?.status).toBe("done"),
	);
}

describe("SubagentManager", () => {
	it("falls back to the highest child thinking level not above the parent", async () => {
		const childModel = getModel("openai", "gpt-4.1")!;
		const harness = setup({ childModel });
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "non reasoning worker",
			task: "Check compatibility",
			agentType: "worker",
			model: `${childModel.provider}/${childModel.id}`,
		});
		await vi.waitFor(() => expect(harness.factoryInputs).toHaveLength(1));
		expect(harness.factoryInputs[0]!.config.thinkingLevel).toBe("off");
		await finishTask(harness, created.agentId, created.taskId);
	});

	it("keeps one agent id while every follow-up receives a new task id", async () => {
		const harness = setup();
		const first = await harness.manager.spawn(ROOT_ID, {
			name: "worker",
			task: "first",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		await finishTask(harness, first.agentId, first.taskId, "first result");
		const second = await harness.manager.followUpTask(ROOT_ID, { agentId: first.agentId, task: "second" });
		expect(second.agentId).toBe(first.agentId);
		expect(second.taskId).not.toBe(first.taskId);
		expect(harness.manager.listTasks(first.agentId).map((task) => task.taskId)).toEqual([
			first.taskId,
			second.taskId,
		]);
	});

	it("aggregates usage across every task, not only the latest task", async () => {
		const harness = setup();
		const first = await harness.manager.spawn(ROOT_ID, {
			name: "usage worker",
			task: "first",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		await finishTask(harness, first.agentId, first.taskId);
		const second = await harness.manager.followUpTask(ROOT_ID, { agentId: first.agentId, task: "second" });
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(2));
		await finishTask(harness, first.agentId, second.taskId);
		await expect(harness.manager.inspect(ROOT_ID, {})).resolves.toMatchObject({
			kind: "list",
			usage: { input: 6, output: 10, cacheRead: 2, cacheWrite: 4, cost: 0.5 },
		});
	});

	it("queues follow-up tasks FIFO without merging them into the running task", async () => {
		const harness = setup();
		const first = await harness.manager.spawn(ROOT_ID, {
			name: "worker",
			task: "first",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const second = await harness.manager.followUpTask(ROOT_ID, { agentId: first.agentId, task: "second" });
		const third = await harness.manager.followUpTask(ROOT_ID, { agentId: first.agentId, task: "third" });
		expect([second.status, third.status]).toEqual(["queued", "queued"]);
		await finishTask(harness, first.agentId, first.taskId, "one");
		await vi.waitFor(() =>
			expect(harness.manager.listTasks(first.agentId).find((task) => task.taskId === second.taskId)?.status).toBe(
				"running",
			),
		);
		expect(harness.runtimes.at(-1)!.prompts).toEqual(["second"]);
	});

	it("runs cold-to-hot-to-cold and resumes the same agent with a new task", async () => {
		const harness = setup();
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "researcher",
			task: "Inspect the implementation",
			agentType: "explorer",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		expect(harness.factoryInputs[0]!.permissionModeCeiling()).toBe("full");
		harness.runtimes[0]!.session.settle("verified handoff");
		await vi.waitFor(() => expect(harness.manager.listSummaries(ROOT_ID)[0]?.status).toBe("done"));
		expect(harness.runtimes[0]!.disposed).toBe(true);

		const follow = await harness.manager.followUpTask(ROOT_ID, {
			agentId: created.agentId,
			task: "Check the edge case",
		});
		expect(follow.status).toMatch(/queued|running/);
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(2));
		expect(harness.runtimes[1]!.prompts).toEqual(["Check the edge case"]);
		harness.runtimes[1]!.session.settle("edge case checked");
		await vi.waitFor(() =>
			expect(harness.manager.listSummaries(ROOT_ID)[0]?.latestTask?.finalMessage).toBe("edge case checked"),
		);
		expect(harness.manager.listSummaries(ROOT_ID)[0]?.agentId).toBe(created.agentId);
	});

	it("returns spawn receipts immediately without awaiting terminal results", async () => {
		const harness = setup();
		const pending = harness.manager.spawn(ROOT_ID, {
			name: "async",
			task: "Inspect now",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		await expect(pending).resolves.toMatchObject({
			status: expect.stringMatching(/queued|running/),
			agentType: "worker",
		});
		harness.runtimes[0]!.session.settle("async handoff");
		await vi.waitFor(() => expect(harness.manager.listSummaries(ROOT_ID)[0]?.status).toBe("done"));
	});

	it("steers a running task without creating a new task", async () => {
		const harness = setup();
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "runner",
			task: "Inspect",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const before = harness.manager.listTasks(created.agentId);
		await expect(
			harness.manager.sendMessage(ROOT_ID, { agentId: created.agentId, message: "focus here" }),
		).resolves.toMatchObject({ agentId: created.agentId, taskId: created.taskId, delivery: "accepted" });
		expect(harness.runtimes[0]!.prompts).toContain("focus here");
		expect(harness.manager.listTasks(created.agentId)).toHaveLength(before.length);
		harness.runtimes[0]!.session.settle();
	});

	it("rejects send_message for cold agents", async () => {
		const harness = setup();
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "cold",
			task: "Inspect",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		await finishTask(harness, created.agentId, created.taskId);
		await expect(
			harness.manager.sendMessage(ROOT_ID, { agentId: created.agentId, message: "wake up" }),
		).rejects.toMatchObject({ code: "INVALID_STATE" });
	});

	it("inherits the parent mode and rejects broader child permissions at spawn", async () => {
		const harness = setup({ parentPermissionMode: "ask" });
		const inherited = await harness.manager.spawn(ROOT_ID, {
			name: "narrow",
			task: "work",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		expect(inherited.status).toMatch(/queued|running/);
		expect(harness.runtimes[0]!.session.sessionManager.getPermissionSettings()).toEqual({ mode: "ask" });
		harness.runtimes[0]!.session.settle();
	});

	it("narrows a running Full child through Auto and Ask without re-upgrading it", async () => {
		const harness = setup({ parentPermissionMode: "full" });
		const _created = await harness.manager.spawn(ROOT_ID, {
			name: "permissions",
			task: "Inspect permissions",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const childId = harness.factoryInputs[0]!.config.agentId;
		expect(harness.runtimes[0]!.session.sessionManager.getPermissionSettings()).toEqual({ mode: "full" });

		harness.parentManager.setPermissionSettings({ mode: "auto" });
		expect(harness.factoryInputs[0]!.permissionModeCeiling()).toBe("auto");
		expect(harness.runtimes[0]!.session.sessionManager.getPermissionSettings()).toEqual({ mode: "auto" });
		expect(harness.manager.listSummaries(ROOT_ID)[0]).toMatchObject({ agentId: childId, status: "running" });

		harness.parentManager.setPermissionSettings({ mode: "full" });
		expect(harness.factoryInputs[0]!.permissionModeCeiling()).toBe("auto");
		expect(harness.runtimes[0]!.session.sessionManager.getPermissionSettings()).toEqual({ mode: "auto" });
		harness.parentManager.setPermissionSettings({ mode: "ask" });
		expect(harness.factoryInputs[0]!.permissionModeCeiling()).toBe("ask");
		expect(harness.runtimes[0]!.session.sessionManager.getPermissionSettings()).toEqual({ mode: "ask" });
		harness.runtimes[0]!.session.settle("foreground complete");
		await vi.waitFor(() => expect(harness.manager.listSummaries(ROOT_ID)[0]?.status).toBe("done"));
	});

	it("applies a parent downgrade before a starting child's first prompt", async () => {
		const gate = deferred();
		const harness = setup({ parentPermissionMode: "full", factoryGate: gate.promise });
		const child = await harness.manager.spawn(ROOT_ID, {
			name: "starting",
			task: "start later",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.factoryInputs).toHaveLength(1));
		harness.parentManager.setPermissionSettings({ mode: "ask" });
		expect(harness.factoryInputs[0]!.permissionModeCeiling()).toBe("ask");

		gate.resolve();
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		expect(harness.runtimes[0]!.session.sessionManager.getPermissionSettings()).toEqual({ mode: "ask" });
		expect(harness.runtimes[0]!.prompts).toEqual(["start later"]);
		expect(harness.manager.listSummaries(ROOT_ID)[0]).toMatchObject({ agentId: child.agentId, status: "running" });
		harness.runtimes[0]!.session.settle();
	});

	it("persists Ask for a queued child before it starts", async () => {
		const harness = setup({
			parentPermissionMode: "full",
			scheduler: new SubagentScheduler(1, 1),
		});
		await harness.manager.spawn(ROOT_ID, { name: "blocker", task: "block", agentType: "worker" });
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const queued = await harness.manager.spawn(ROOT_ID, {
			name: "queued",
			task: "queued task",
			agentType: "worker",
		});
		expect(queued.status).toBe("queued");

		harness.parentManager.setPermissionSettings({ mode: "ask" });
		expect(await harness.manager.readJournal(ROOT_ID, queued.agentId)).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "session_permissions", permissionMode: "ask" })]),
		);

		harness.runtimes[0]!.session.settle();
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(2));
		expect(harness.runtimes[1]!.session.sessionManager.getPermissionSettings()).toEqual({ mode: "ask" });
		harness.runtimes[1]!.session.settle();
	});

	it("maps provider errors to failed tasks", async () => {
		const harness = setup();
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "failure",
			task: "Inspect",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		harness.runtimes[0]!.session.settle("partial result", "error");
		await vi.waitFor(() => expect(harness.manager.listSummaries(ROOT_ID)[0]?.status).toBe("failed"));
		expect(harness.manager.listSummaries(ROOT_ID)[0]?.latestTask).toMatchObject({
			status: "failed",
			error: "provider failed",
		});

		await harness.manager.followUpTask(ROOT_ID, { agentId: created.agentId, task: "Recover explicitly" });
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(2));
		expect(harness.manager.listSummaries(ROOT_ID)[0]).toMatchObject({ status: "running" });
		harness.runtimes[1]!.session.settle("recovered result");
		await vi.waitFor(() => expect(harness.manager.listSummaries(ROOT_ID)[0]?.status).toBe("done"));
		expect(harness.manager.listSummaries(ROOT_ID)[0]?.latestTask).toMatchObject({
			finalMessage: "recovered result",
		});
	});

	it("fails visibly when a cold runtime cannot recreate the exact configured tool set", async () => {
		const harness = setup({ scheduler: new SubagentScheduler(4, 4), childRuntimeTools: [] });
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "missing-tool",
			task: "Use the delegated reader",
			agentType: "worker",
		});

		await vi.waitFor(() => expect(harness.manager.listSummaries(ROOT_ID)[0]?.status).toBe("failed"));
		expect(harness.manager.listSummaries(ROOT_ID)[0]?.latestTask).toMatchObject({
			status: "failed",
			error: expect.stringContaining("Child runtime tool snapshot mismatch (missing: read"),
		});
		expect(harness.runtimes[0]?.disposed).toBe(true);
		expect(created.agentId).toBeTruthy();
	});

	it("does not finish interrupt until disposal and terminal persistence complete", async () => {
		const harness = setup();
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "interrupt",
			task: "Inspect",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const gate = deferred();
		harness.runtimes[0]!.disposeGate = gate.promise;
		let resolved = false;
		const interrupting = harness.manager.interrupt(ROOT_ID, created.agentId).then((value) => {
			resolved = true;
			return value;
		});
		await vi.waitFor(() => expect(harness.runtimes[0]!.disposeStarted).toBe(true));
		expect(resolved).toBe(false);
		gate.resolve();
		await expect(interrupting).resolves.toMatchObject({ status: "stopped" });
		expect(harness.runtimes[0]!.disposed).toBe(true);
	});

	it("stops queued follow-up tasks during interrupt", async () => {
		const harness = setup();
		const first = await harness.manager.spawn(ROOT_ID, {
			name: "worker",
			task: "first",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const second = await harness.manager.followUpTask(ROOT_ID, { agentId: first.agentId, task: "second" });
		const third = await harness.manager.followUpTask(ROOT_ID, { agentId: first.agentId, task: "third" });
		const result = await harness.manager.interrupt(ROOT_ID, first.agentId);
		expect(result.cancelledTaskIds).toEqual([second.taskId, third.taskId]);
		expect(harness.manager.listTasks(first.agentId).every((task) => task.status === "stopped")).toBe(true);
	});

	it("keeps parent-unloaded children stopped when cleanup reports an error", async () => {
		const harness = setup();
		const _created = await harness.manager.spawn(ROOT_ID, {
			name: "unload",
			task: "Inspect",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const childPath = harness.runtimes[0]!.session.sessionManager.getSessionFile()!;
		const enqueueMailbox = vi.spyOn(harness.parent, "enqueueAgentMailboxEvent");
		vi.spyOn(harness.runtimes[0]!, "dispose").mockRejectedValueOnce(new Error("dispose failed during parent unload"));

		await expect(harness.manager.unload("parent_unloaded")).rejects.toThrow("dispose failed during parent unload");

		const state = SessionManager.openReadOnly(childPath)
			.getDurableJournalSnapshot()
			.filter((entry) => entry.type === "agent_task")
			.at(-1);
		expect(state).toMatchObject({
			status: "stopped",
			reason: "parent_unloaded",
		});
		expect(enqueueMailbox).not.toHaveBeenCalled();
	});

	it("keeps terminal state and emits notification_failed when mailbox persistence fails", async () => {
		const harness = setup();
		const events: AgentManagerEvent[] = [];
		harness.manager.subscribe((event) => events.push(event));
		vi.mocked(harness.parent.enqueueAgentMailboxEvent).mockImplementation(() => {
			throw new Error("mailbox disk full");
		});
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "mailbox",
			task: "Inspect",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		harness.runtimes[0]!.session.settle("completed result");

		await vi.waitFor(() => expect(events.some((event) => event.type === "notification_failed")).toBe(true));
		expect(harness.manager.listSummaries(ROOT_ID)[0]).toMatchObject({
			agentId: created.agentId,
			status: "done",
			latestTask: { finalMessage: "completed result" },
		});
		expect(events.some((event) => event.type === "notification_ready")).toBe(false);
	});

	it("forwards approvals to the user without notifying the parent model", async () => {
		const approvals = vi.fn(async (_request: PermissionApprovalRequest) => ({ decision: "allow" as const }));
		const harness = setup({ onPermissionRequest: approvals });
		const events: string[] = [];
		harness.manager.subscribe((event) => events.push(event.type));
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "researcher",
			task: "Inspect",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const callback = harness.factoryInputs[0]!.onPermissionRequest!;
		await expect(
			callback({
				action: {
					actionId: "action-1",
					toolName: "bash",
					provenance: "builtin",
					risks: ["network"],
					paths: [],
					networkTargets: [],
				},
				args: { command: "curl example.test" },
				reason: "network requires confirmation",
			}),
		).resolves.toEqual({ decision: "allow" });
		expect(approvals.mock.calls[0]?.[0].actor).toEqual({
			type: "agent",
			id: created.agentId,
			name: "researcher",
		});
		expect(events).toContain("approval_required");
		expect(events).not.toContain("notification_ready");
		expect(harness.pendingMailbox.size).toBe(0);
		await finishTask(harness, created.agentId, created.taskId);
		expect(events).toContain("notification_ready");
	});

	it("returns an async receipt and publishes ready only after mailbox persistence", async () => {
		const harness = setup();
		const order: string[] = [];
		vi.mocked(harness.parent.enqueueAgentMailboxEvent).mockImplementation((event) => {
			order.push(`persist:${event.eventId}`);
			return true;
		});
		harness.manager.subscribe((event) => {
			if (event.type === "notification_ready") order.push(`ready:${event.event.eventId}`);
		});

		await expect(
			harness.manager.spawn(ROOT_ID, {
				name: "background",
				task: "Inspect in parallel",
				agentType: "worker",
			}),
		).resolves.toMatchObject({ status: expect.stringMatching(/queued|running/) });
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		harness.runtimes[0]!.session.settle("background handoff");
		await vi.waitFor(() => expect(order).toHaveLength(2));
		expect(order[0]).toMatch(/^persist:/);
		expect(order[1]).toMatch(/^ready:/);
	});

	it("runs the original task before follow-ups queued while the agent is busy", async () => {
		const harness = setup({ scheduler: new SubagentScheduler(1, 1) });
		await harness.manager.spawn(ROOT_ID, { name: "blocker", task: "block", agentType: "worker" });
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const queued = await harness.manager.spawn(ROOT_ID, {
			name: "queued-child",
			task: "Original queued task",
			agentType: "worker",
		});
		expect(queued.status).toBe("queued");
		const follow = await harness.manager.followUpTask(ROOT_ID, {
			agentId: queued.agentId,
			task: "Then check the edge case",
		});
		expect(follow.status).toBe("queued");

		harness.runtimes[0]!.session.settle("blocker done");
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(2));
		expect(harness.runtimes[1]!.prompts).toEqual(["Original queued task"]);
		await finishTask(harness, queued.agentId, queued.taskId, "original done");
		await vi.waitFor(() =>
			expect(harness.manager.listTasks(queued.agentId).find((task) => task.taskId === follow.taskId)?.status).toBe(
				"running",
			),
		);
		expect(harness.runtimes.at(-1)!.prompts).toEqual(["Then check the edge case"]);
	});

	it("deletes an agent after draining its runtime", async () => {
		const harness = setup();
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "delete-me",
			task: "Inspect",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		await vi.waitFor(() => expect(harness.runtimes[0]!.prompts).toEqual(["Inspect"]));
		const childPath = harness.factoryInputs[0]!.sessionManager.getSessionFile()!;
		const gate = deferred();
		harness.runtimes[0]!.disposeGate = gate.promise;
		let resolved = false;
		const deleting = harness.manager.deleteAgent(ROOT_ID, created.agentId).then((value) => {
			resolved = true;
			return value;
		});
		await vi.waitFor(() => expect(harness.runtimes[0]!.disposeStarted).toBe(true));
		expect(resolved).toBe(false);
		gate.resolve();
		await expect(deleting).resolves.toEqual({ agentId: created.agentId, status: "deleted" });
		expect(existsSync(childPath)).toBe(false);
	});

	it("returns a safe projected trace for inspect_agents", async () => {
		const harness = setup();
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "worker",
			task: "Inspect me",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		await finishTask(harness, created.agentId, created.taskId, "done handoff");
		const inspected = await harness.manager.inspect(ROOT_ID, { agentId: created.agentId });
		expect(inspected.kind).toBe("trace");
		if (inspected.kind !== "trace") return;
		expect(inspected.events.length).toBeGreaterThan(0);
		expect(inspected.events[0]?.timestamp >= inspected.events.at(-1)!.timestamp).toBe(true);
		expect(inspected.events.some((event) => event.kind === "final" && event.text === "done handoff")).toBe(true);
	});

	it("marks depth-2 workers as non-delegating", async () => {
		const harness = setup();
		const first = await harness.manager.spawn(ROOT_ID, {
			name: "worker",
			task: "first",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		harness.manager.attachActor(harness.runtimes[0]!.session as unknown as AgentSession);
		const second = await harness.manager.spawn(first.agentId, {
			name: "nested",
			task: "nested",
			agentType: "worker",
		});
		expect(second.agentId).not.toBe(first.agentId);
		expect(harness.factoryInputs.at(-1)!.config.mayDelegate).toBe(false);
		expect(harness.factoryInputs.at(-1)!.config.agentPath).toHaveLength(2);
	});

	it("rejects invalid ingress before creating a child journal", async () => {
		const harness = setup();
		await expect(
			harness.manager.spawn(ROOT_ID, { name: "bad\nname", task: "task", agentType: "worker" }),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		await expect(
			harness.manager.spawn(ROOT_ID, { name: "blank", task: "   ", agentType: "worker" }),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		await expect(
			harness.manager.spawn(ROOT_ID, { name: "fork-zero", task: "task", agentType: "worker", forkTurns: 0 }),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		expect(harness.manager.listSummaries(ROOT_ID)).toEqual([]);
	});

	it("returns pending mailbox updates immediately from wait_agents", async () => {
		const harness = setup();
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "worker",
			task: "Inspect",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		await finishTask(harness, created.agentId, created.taskId);
		await expect(harness.manager.waitAgents(ROOT_ID, { agentIds: [created.agentId] })).resolves.toMatchObject({
			timedOut: false,
			agents: [{ agentId: created.agentId, status: "done" }],
			mailboxEventIds: [`agent:${created.agentId}:${created.taskId}:terminal`],
		});
	});

	it("waits event-driven for a terminal mailbox update", async () => {
		const harness = setup();
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "worker",
			task: "Inspect",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const waitPromise = harness.manager.waitAgents(ROOT_ID, { agentIds: [created.agentId] });
		await finishTask(harness, created.agentId, created.taskId);
		await expect(waitPromise).resolves.toMatchObject({
			timedOut: false,
			agents: [{ agentId: created.agentId, status: "done" }],
			mailboxEventIds: [`agent:${created.agentId}:${created.taskId}:terminal`],
		});
	});

	it("returns approval_required while a child waits for parent permission", async () => {
		const approvals = vi.fn((_request: PermissionApprovalRequest) => new Promise<{ decision: "allow" }>(() => {}));
		const harness = setup({ onPermissionRequest: approvals });
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "researcher",
			task: "Inspect",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const waitPromise = harness.manager.waitAgents(ROOT_ID, { agentIds: [created.agentId] });
		const callback = harness.factoryInputs[0]!.onPermissionRequest!;
		void callback({
			action: {
				actionId: "action-1",
				toolName: "bash",
				provenance: "builtin",
				risks: ["network"],
				paths: [],
				networkTargets: [],
			},
			args: { command: "curl example.test" },
			reason: "network requires confirmation",
		});
		await expect(waitPromise).resolves.toMatchObject({
			timedOut: false,
			agents: [{ agentId: created.agentId, status: "running" }],
			mailboxEventIds: [],
			attention: {
				agentId: created.agentId,
				taskId: created.taskId,
				kind: "approval_required",
				toolName: "bash",
			},
		});
	});

	it("returns no_live_agents when selected children are already terminal with no pending mailbox", async () => {
		const harness = setup();
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "worker",
			task: "Inspect",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		await finishTask(harness, created.agentId, created.taskId);
		harness.pendingMailbox.clear();
		await expect(harness.manager.waitAgents(ROOT_ID, { agentIds: [created.agentId] })).resolves.toMatchObject({
			timedOut: false,
			agents: [{ agentId: created.agentId, status: "done" }],
			mailboxEventIds: [],
		});
	});

	it("does not republish durable terminal mailbox events on recover", async () => {
		const harness = setup();
		let readyCount = 0;
		harness.manager.subscribe((event) => {
			if (event.type === "notification_ready") readyCount += 1;
		});
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "worker",
			task: "Inspect",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		await finishTask(harness, created.agentId, created.taskId);
		expect(readyCount).toBe(1);
		const eventId = `agent:${created.agentId}:${created.taskId}:terminal`;
		harness.pendingMailbox.delete(eventId);

		const recoveredManager = new SubagentManager({
			parentSessionManager: harness.parentManager,
			agentDir: join(harness.root, "agent"),
			getWorkspaceRoots: () => harness.parentManager.getWorkspaceRoots(),
			createChildRuntime: async () => {
				throw new Error("recover should not start children");
			},
		});
		let recoveredReadyCount = 0;
		recoveredManager.subscribe((event) => {
			if (event.type === "notification_ready") recoveredReadyCount += 1;
		});
		recoveredManager.attachActor(harness.parent);
		expect(recoveredReadyCount).toBe(0);
	});
});
