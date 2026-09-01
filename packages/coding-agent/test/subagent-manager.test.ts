import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@metis/agent-core";
import { getModel, type Model } from "@metis/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { PermissionApprovalRequest } from "../src/core/permissions/approval.ts";
import type { PermissionPreset } from "../src/core/permissions/settings.ts";
import {
	intersectPermissionSettings,
	PERMISSION_PRESETS,
	settingsForPreset,
} from "../src/core/permissions/settings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type ChildRuntimeFactoryInput, SubagentManager } from "../src/core/subagents/manager.ts";
import { SubagentScheduler } from "../src/core/subagents/scheduler.ts";
import { AgentStore } from "../src/core/subagents/store.ts";
import {
	AGENT_TOOL_NAMES,
	type AgentMailboxTerminalEvent,
	type AgentManagerEvent,
	MAX_AGENT_INPUT_UTF8_BYTES,
	MAX_AGENT_QUEUED_TASKS,
	MAX_AGENT_TASKS,
} from "../src/core/subagents/types.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

const ROOT_ID = "parent-session-1";

const cleanups: Array<() => void> = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	vi.useRealTimers();
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
	private taskSettled = false;
	private readonly activeTools: readonly string[];
	private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
	private readonly knownMailbox = new Set<string>();
	private readonly pendingMailbox = new Set<string>();

	private readonly permissionSettingsCeiling?: () => ReturnType<typeof settingsForPreset>;

	constructor(
		sessionManager: SessionManager,
		activeTools: readonly string[],
		permissionSettingsCeiling?: () => ReturnType<typeof settingsForPreset>,
	) {
		this.sessionManager = sessionManager;
		this.activeTools = activeTools;
		this.permissionSettingsCeiling = permissionSettingsCeiling;
	}

	get permissionView() {
		const permissionPreset = this.sessionManager.getPermissionPreset();
		const requested = settingsForPreset(permissionPreset);
		const ceiling = this.permissionSettingsCeiling?.() ?? requested;
		const effectiveSettings = intersectPermissionSettings(requested, ceiling);
		return {
			permissionPreset,
			effectiveSettings,
			constrainedByParent:
				effectiveSettings.sandboxPolicy !== requested.sandboxPolicy ||
				effectiveSettings.approvalPolicy !== requested.approvalPolicy,
			sandboxHealth: "healthy" as const,
		};
	}

	getActiveToolNames(): string[] {
		return [...this.activeTools];
	}

	getDelegatableToolNames(): string[] {
		return [...this.activeTools];
	}

	enqueueAgentMailboxEvent(event: AgentMailboxTerminalEvent): boolean {
		if (this.knownMailbox.has(event.eventId)) return this.pendingMailbox.has(event.eventId);
		this.sessionManager.appendAgentControl({ type: "agent_mailbox_event", event });
		this.knownMailbox.add(event.eventId);
		this.pendingMailbox.add(event.eventId);
		return true;
	}

	hasAgentMailboxEvent(eventId: string): boolean {
		return this.knownMailbox.has(eventId);
	}

	getPendingAgentMailboxEventIds(): readonly string[] {
		return [...this.pendingMailbox];
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
		this.taskSettled = true;
		this.emit({ type: "agent_settled" });
	}

	getSessionStats() {
		const prior = this.sessionManager.getDurableJournalSnapshot().reduce(
			(total, entry) => {
				if (entry.type !== "agent_task" || !entry.usage) return total;
				return {
					input: total.input + entry.usage.input,
					output: total.output + entry.usage.output,
					cacheRead: total.cacheRead + entry.usage.cacheRead,
					cacheWrite: total.cacheWrite + entry.usage.cacheWrite,
					cost: total.cost + (entry.usage.cost ?? 0),
					toolCalls: total.toolCalls + (entry.usage.toolCalls ?? 0),
				};
			},
			{ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, toolCalls: 0 },
		);
		const task = this.taskSettled
			? { input: 3, output: 5, cacheRead: 1, cacheWrite: 2, cost: 0.25, toolCalls: 4 }
			: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, toolCalls: 0 };
		return {
			tokens: {
				input: prior.input + task.input,
				output: prior.output + task.output,
				cacheRead: prior.cacheRead + task.cacheRead,
				cacheWrite: prior.cacheWrite + task.cacheWrite,
			},
			cost: prior.cost + task.cost,
			toolCalls: prior.toolCalls + task.toolCalls,
		};
	}
}

class FakeChildRuntime {
	readonly session: FakeChildSession;
	readonly prompts: string[] = [];
	disposed = false;
	disposeStarted = false;
	disposeGate: Promise<void> = Promise.resolve();

	constructor(
		manager: SessionManager,
		activeTools: readonly string[],
		ceiling?: () => ReturnType<typeof settingsForPreset>,
	) {
		this.session = new FakeChildSession(manager, activeTools, ceiling);
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
	readonly parentPermissionPreset?: PermissionPreset;
	readonly parentThinkingLevel?: ThinkingLevel;
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
		permissionPreset: options.parentPermissionPreset ?? "full",
	});
	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const knownMailbox = new Set<string>();
	const pendingMailbox = new Set<string>();
	const parent = {
		sessionManager: parentManager,
		messages: [],
		mode: "code",
		thinkingLevel: options.parentThinkingLevel ?? "high",
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
		getDelegatableToolNames: () => ["read", "bash", "grep", "find", "ls", "edit", "write", "web_fetch", "web_search"],
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
				input.permissionSettingsCeiling,
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
	it("accepts provider-qualified model ids that contain slashes", async () => {
		const base = getModel("anthropic", "claude-sonnet-4-5")!;
		const childModel = { ...base, provider: "fixture", id: "family/model" } as unknown as Model<any>;
		const harness = setup({ childModel });
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "slash model worker",
			task: "Check model routing",
			agentType: "worker",
			model: "fixture/family/model",
		});
		await vi.waitFor(() => expect(harness.factoryInputs).toHaveLength(1));
		expect(harness.factoryInputs[0]!.config.model).toEqual({ provider: "fixture", modelId: "family/model" });
		await finishTask(harness, created.agentId, created.taskId);
	});

	it("forces Plan-spawned workers into the write-denied capability set", async () => {
		const harness = setup();
		harness.parentManager.setCollaborationMode("plan");
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "plan worker",
			task: "Inspect without writes",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.factoryInputs).toHaveLength(1));
		expect(harness.factoryInputs[0]!.config.writePolicy).toBe("deny");
		expect(harness.factoryInputs[0]!.config.tools).toEqual(expect.arrayContaining(["read", "grep", "bash"]));
		await finishTask(harness, created.agentId, created.taskId);
	});

	it("blocks Plan entry and follow-up while a writable agent could escape it", async () => {
		const harness = setup();
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "writable worker",
			task: "Implement",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		expect(() => harness.manager.assertCanEnterPlan(ROOT_ID)).toThrow(/Stop writable agent/);
		await finishTask(harness, created.agentId, created.taskId);
		expect(() => harness.manager.assertCanEnterPlan(ROOT_ID)).not.toThrow();
		harness.parentManager.setCollaborationMode("plan");
		await expect(
			harness.manager.followUpTask(ROOT_ID, { agentId: created.agentId, task: "Write from Plan" }),
		).rejects.toMatchObject({ code: "INVALID_STATE" });
	});

	it("builds a multi-agent summary with one tree scan", async () => {
		const harness = setup();
		for (const name of ["one", "two", "three"]) {
			await harness.manager.spawn(ROOT_ID, { name, task: `Inspect ${name}`, agentType: "worker" });
		}
		const listTree = vi.spyOn(AgentStore.prototype, "listTree");
		listTree.mockClear();
		expect(harness.manager.listSummaries(ROOT_ID)).toHaveLength(3);
		expect(listTree).toHaveBeenCalledTimes(1);
	});

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

	it("rejects a child model when every supported thinking level exceeds the parent", async () => {
		const base = getModel("anthropic", "claude-sonnet-4-5")!;
		const childModel = {
			...base,
			provider: "fixture",
			id: "high-only",
			thinkingLevelMap: { off: null, minimal: null, low: null, medium: null },
		} as unknown as Model<any>;
		const harness = setup({ childModel, parentThinkingLevel: "off" });

		await expect(
			harness.manager.spawn(ROOT_ID, {
				name: "incompatible thinker",
				task: "Check compatibility",
				agentType: "worker",
				model: `${childModel.provider}/${childModel.id}`,
			}),
		).rejects.toMatchObject({ code: "MODEL_UNAVAILABLE" });
		expect(harness.factoryInputs).toEqual([]);
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
		expect(harness.factoryInputs[0]!.permissionSettingsCeiling()).toEqual(PERMISSION_PRESETS.full);
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

	it("never borrows a prior task final when a follow-up is interrupted", async () => {
		const harness = setup();
		const first = await harness.manager.spawn(ROOT_ID, {
			name: "scoped final",
			task: "finish once",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		await finishTask(harness, first.agentId, first.taskId, "first final");
		const second = await harness.manager.followUpTask(ROOT_ID, {
			agentId: first.agentId,
			task: "stop before completion",
		});
		await vi.waitFor(() =>
			expect(harness.manager.listTasks(first.agentId).find((task) => task.taskId === second.taskId)?.status).toBe(
				"running",
			),
		);

		await expect(harness.manager.interrupt(ROOT_ID, first.agentId)).resolves.toMatchObject({ status: "stopped" });

		const tasks = harness.manager.listTasks(first.agentId);
		expect(tasks.find((task) => task.taskId === first.taskId)?.finalMessage).toBe("first final");
		expect(tasks.find((task) => task.taskId === second.taskId)?.finalMessage).toBeUndefined();
	});

	it("keeps aborted assistant text as activity instead of a final reply", async () => {
		const harness = setup();
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "aborted output",
			task: "start a response",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		harness.runtimes[0]!.session.settle("partial only", "aborted");
		await vi.waitFor(() => expect(harness.manager.listSummaries(ROOT_ID)[0]?.status).toBe("stopped"));
		expect(harness.manager.listTasks(created.agentId)[0]?.finalMessage).toBeUndefined();
	});

	it("does not promote a tool-calling assistant message to final", async () => {
		const harness = setup();
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "tool handoff",
			task: "call a tool",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const runtime = harness.runtimes[0]!;
		const message = {
			...assistantMsg("I will inspect this."),
			stopReason: "toolUse" as const,
			content: [
				{ type: "text" as const, text: "I will inspect this." },
				{ type: "toolCall" as const, id: "call-1", name: "read", arguments: { path: "README.md" } },
			],
		};
		runtime.session.messages.push(message);
		runtime.session.sessionManager.appendMessage(message);
		runtime.session.emit({ type: "agent_settled" });
		await vi.waitFor(() => expect(harness.manager.listSummaries(ROOT_ID)[0]?.status).toBe("done"));
		expect(harness.manager.listTasks(created.agentId)[0]?.finalMessage).toBeUndefined();
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

	it("relays visible child message activity with its agent and task identity", async () => {
		const harness = setup();
		const events: AgentManagerEvent[] = [];
		harness.manager.subscribe((event) => events.push(event));
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "streaming",
			task: "Report progress",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const message = assistantMsg("Reading the project");

		harness.runtimes[0]!.session.emit({ type: "message_start", message });

		expect(events).toContainEqual({
			type: "activity",
			agentId: created.agentId,
			taskId: created.taskId,
			event: { type: "message_start", message },
		});
		harness.runtimes[0]!.session.settle();
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

	it("records a cancelled message when steering admission fails", async () => {
		const harness = setup();
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "reject steering",
			task: "Inspect",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		vi.spyOn(harness.runtimes[0]!, "submitPrompt").mockRejectedValueOnce(new Error("runtime is disposing"));
		await expect(
			harness.manager.sendMessage(ROOT_ID, { agentId: created.agentId, message: "too late" }),
		).rejects.toThrow("runtime is disposing");
		const messages = harness.runtimes[0]!.session.sessionManager.getDurableJournalSnapshot().filter(
			(entry) => entry.type === "agent_message",
		);
		expect(messages.map((entry) => entry.state)).toEqual(["accepted", "cancelled"]);
		expect(new Set(messages.map((entry) => entry.messageId)).size).toBe(1);
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

	it("inherits the parent preset and intersects a requested Full child independently", async () => {
		const harness = setup({ parentPermissionPreset: "auto" });
		const child = await harness.manager.spawn(ROOT_ID, {
			name: "narrow",
			task: "work",
			agentType: "worker",
			permissionPreset: "full",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		expect(child.status).toMatch(/queued|running/);
		expect(harness.runtimes[0]!.session.sessionManager.getPermissionPreset()).toBe("full");
		expect(harness.runtimes[0]!.session.permissionView.effectiveSettings).toEqual({
			sandboxPolicy: "workspace-write",
			approvalPolicy: "user",
		});
		harness.runtimes[0]!.session.settle();
	});

	it("narrows a running Full child through Auto and Ask without rewriting the saved preset", async () => {
		const harness = setup({ parentPermissionPreset: "full" });
		const _created = await harness.manager.spawn(ROOT_ID, {
			name: "permissions",
			task: "Inspect permissions",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const childId = harness.factoryInputs[0]!.config.agentId;
		expect(harness.runtimes[0]!.session.sessionManager.getPermissionPreset()).toBe("full");
		expect(harness.runtimes[0]!.session.permissionView.effectiveSettings).toEqual(PERMISSION_PRESETS.full);

		harness.parentManager.setPermissionPreset("auto");
		const parentAutoCeiling = intersectPermissionSettings(PERMISSION_PRESETS.full, PERMISSION_PRESETS.auto);
		expect(harness.factoryInputs[0]!.permissionSettingsCeiling()).toEqual(parentAutoCeiling);
		expect(harness.runtimes[0]!.session.sessionManager.getPermissionPreset()).toBe("full");
		expect(harness.runtimes[0]!.session.permissionView.effectiveSettings).toEqual({
			sandboxPolicy: "workspace-write",
			approvalPolicy: "user",
		});
		expect(harness.manager.listSummaries(ROOT_ID)[0]).toMatchObject({ agentId: childId, status: "running" });

		harness.parentManager.setPermissionPreset("full");
		expect(harness.factoryInputs[0]!.permissionSettingsCeiling()).toEqual(parentAutoCeiling);
		expect(harness.runtimes[0]!.session.sessionManager.getPermissionPreset()).toBe("full");
		harness.parentManager.setPermissionPreset("ask");
		expect(harness.factoryInputs[0]!.permissionSettingsCeiling()).toEqual(PERMISSION_PRESETS.ask);
		expect(harness.runtimes[0]!.session.permissionView.effectiveSettings).toEqual(PERMISSION_PRESETS.ask);
		harness.runtimes[0]!.session.settle("foreground complete");
		await vi.waitFor(() => expect(harness.manager.listSummaries(ROOT_ID)[0]?.status).toBe("done"));
	});

	it("applies a parent downgrade before a starting child's first prompt", async () => {
		const gate = deferred();
		const harness = setup({ parentPermissionPreset: "full", factoryGate: gate.promise });
		const child = await harness.manager.spawn(ROOT_ID, {
			name: "starting",
			task: "start later",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.factoryInputs).toHaveLength(1));
		harness.parentManager.setPermissionPreset("ask");
		expect(harness.factoryInputs[0]!.permissionSettingsCeiling()).toEqual(PERMISSION_PRESETS.ask);

		gate.resolve();
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		expect(harness.runtimes[0]!.session.sessionManager.getPermissionPreset()).toBe("full");
		expect(harness.runtimes[0]!.session.permissionView.effectiveSettings).toEqual(PERMISSION_PRESETS.ask);
		expect(harness.runtimes[0]!.prompts).toEqual(["start later"]);
		expect(harness.manager.listSummaries(ROOT_ID)[0]).toMatchObject({ agentId: child.agentId, status: "running" });
		harness.runtimes[0]!.session.settle();
	});

	it("keeps the queued child's saved preset when the parent ceiling narrows", async () => {
		const harness = setup({
			parentPermissionPreset: "full",
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

		harness.parentManager.setPermissionPreset("ask");
		expect(await harness.manager.readJournal(ROOT_ID, queued.agentId)).toEqual(
			expect.not.arrayContaining([expect.objectContaining({ type: "session_permissions" })]),
		);

		harness.runtimes[0]!.session.settle();
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(2));
		expect(harness.runtimes[1]!.session.sessionManager.getPermissionPreset()).toBe("full");
		expect(harness.runtimes[1]!.session.permissionView.effectiveSettings).toEqual(PERMISSION_PRESETS.ask);
		harness.runtimes[1]!.session.settle();
	});

	it("does not rewrite descendant journals when a cold parent ceiling reapplies", async () => {
		const harness = setup({ parentPermissionPreset: "full" });
		const parent = await harness.manager.spawn(ROOT_ID, {
			name: "permission parent",
			task: "Coordinate",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const parentSession = harness.runtimes[0]!.session;
		const detach = harness.manager.attachActor(parentSession as unknown as AgentSession);
		const child = await harness.manager.spawn(parent.agentId, {
			name: "permission child",
			task: "Inspect",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(2));
		detach();
		parentSession.sessionManager.setPermissionPreset("ask");
		expect(harness.runtimes[1]!.session.sessionManager.getPermissionPreset()).toBe("full");
		await harness.manager.unload("parent_unloaded");
		const store = new AgentStore(harness.parentManager, join(harness.root, "agent"));
		const parentPath = store.load(parent.agentId).path;
		const childPath = store.load(child.agentId).path;
		const coldParentManager = SessionManager.open(parentPath);
		const coldParent = {
			sessionManager: coldParentManager,
			enqueueAgentMailboxEvent: parentSession.enqueueAgentMailboxEvent.bind(parentSession),
			hasAgentMailboxEvent: parentSession.hasAgentMailboxEvent.bind(parentSession),
			getPendingAgentMailboxEventIds: parentSession.getPendingAgentMailboxEventIds.bind(parentSession),
		} as unknown as AgentSession;

		const recoveredManager = new SubagentManager({
			parentSessionManager: harness.parentManager,
			agentDir: join(harness.root, "agent"),
			getWorkspaceRoots: () => harness.parentManager.getWorkspaceRoots(),
			createChildRuntime: async () => {
				throw new Error("recovery should not start children");
			},
		});
		recoveredManager.attachActor(coldParent);
		const recoveredChild = SessionManager.open(childPath);
		try {
			expect(recoveredChild.getPermissionPreset()).toBe("full");
		} finally {
			recoveredChild.close();
		}
		coldParentManager.setPermissionPreset("full");
		const stillSaved = SessionManager.open(childPath);
		try {
			expect(stillSaved.getPermissionPreset()).toBe("full");
		} finally {
			stillSaved.close();
			coldParentManager.close();
		}
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
		expect(harness.manager.listSummaries(ROOT_ID)[0]?.latestTask?.finalMessage).toBeUndefined();

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
		expect(harness.pendingMailbox).toEqual(
			new Set([
				`agent:${first.agentId}:${second.taskId}:terminal`,
				`agent:${first.agentId}:${third.taskId}:terminal`,
				`agent:${first.agentId}:${first.taskId}:terminal`,
			]),
		);
	});

	it("sorts summaries by the last task state change rather than the newest-created task", async () => {
		const harness = setup();
		const first = await harness.manager.spawn(ROOT_ID, {
			name: "ordering worker",
			task: "First",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const second = await harness.manager.followUpTask(ROOT_ID, { agentId: first.agentId, task: "Second" });
		await new Promise((resolve) => setTimeout(resolve, 5));
		harness.runtimes[0]!.session.sessionManager.appendAgentControl({
			type: "agent_task",
			agentId: first.agentId,
			taskId: second.taskId,
			text: "Second",
			taskSummary: "Second",
			status: "stopped",
			reason: "interrupted",
		});
		await new Promise((resolve) => setTimeout(resolve, 5));
		harness.runtimes[0]!.session.settle("first done");
		await vi.waitFor(() => expect(harness.manager.listTasks(first.agentId)[0]?.status).toBe("done"));
		const summary = harness.manager.listSummaries(ROOT_ID)[0]!;
		expect(summary.latestTask?.taskId).toBe(second.taskId);
		expect(summary.updatedAt).toBe(summary.tasks.find((task) => task.taskId === first.taskId)?.updatedAt);
	});

	it("publishes queued spawn, follow-up, and interrupt state immediately", async () => {
		const harness = setup({ scheduler: new SubagentScheduler(1, 1) });
		await harness.manager.spawn(ROOT_ID, { name: "blocker", task: "block", agentType: "worker" });
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const events: AgentManagerEvent[] = [];
		harness.manager.subscribe((event) => events.push(event));
		const queued = await harness.manager.spawn(ROOT_ID, { name: "queued", task: "queued", agentType: "worker" });
		expect(queued.status).toBe("queued");
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "updated",
				summary: expect.objectContaining({ agentId: queued.agentId, status: "queued" }),
			}),
		);
		const follow = await harness.manager.followUpTask(ROOT_ID, { agentId: queued.agentId, task: "queued follow-up" });
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "updated",
				summary: expect.objectContaining({
					agentId: queued.agentId,
					latestTask: expect.objectContaining({ taskId: follow.taskId, status: "queued" }),
				}),
			}),
		);
		await harness.manager.interrupt(ROOT_ID, queued.agentId);
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "updated",
				summary: expect.objectContaining({ agentId: queued.agentId, status: "stopped" }),
			}),
		);
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

	it("stops queued follow-ups on unload without rescheduling them", async () => {
		const harness = setup();
		const first = await harness.manager.spawn(ROOT_ID, {
			name: "unload queue",
			task: "First task",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const childPath = harness.runtimes[0]!.session.sessionManager.getSessionFile()!;
		const second = await harness.manager.followUpTask(ROOT_ID, { agentId: first.agentId, task: "Second task" });

		await harness.manager.unload("parent_unloaded");
		await new Promise((resolve) => setTimeout(resolve, 0));

		const readOnly = SessionManager.openReadOnly(childPath);
		const tasks = readOnly
			.getDurableJournalSnapshot()
			.filter((entry) => entry.type === "agent_task")
			.reduce((latest, entry) => latest.set(entry.taskId, entry), new Map());
		expect([...tasks.values()]).toEqual([
			expect.objectContaining({ taskId: first.taskId, status: "stopped", reason: "parent_unloaded" }),
			expect.objectContaining({ taskId: second.taskId, status: "stopped", reason: "parent_unloaded" }),
		]);
		expect(harness.runtimes).toHaveLength(1);
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
		const waiting = harness.manager.waitAgents(ROOT_ID, { agentIds: [created.agentId], timeoutMs: 1_000 });
		harness.runtimes[0]!.session.settle("completed result");

		await vi.waitFor(() => expect(events.some((event) => event.type === "notification_failed")).toBe(true));
		expect(harness.manager.listSummaries(ROOT_ID)[0]).toMatchObject({
			agentId: created.agentId,
			status: "done",
			latestTask: { finalMessage: "completed result" },
		});
		expect(events.some((event) => event.type === "notification_ready")).toBe(false);
		await expect(waiting).resolves.toMatchObject({
			timedOut: false,
			agents: [{ agentId: created.agentId, status: "done" }],
			mailboxEventIds: [],
		});
	});

	it("forwards approvals to the user without notifying the parent model", async () => {
		const approvals = vi.fn(async (_request: PermissionApprovalRequest) => ({ decision: "allow" as const }));
		const harness = setup({ onPermissionRequest: approvals });
		const events: AgentManagerEvent[] = [];
		harness.manager.subscribe((event) => events.push(event));
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
			taskId: created.taskId,
		});
		expect(events).toContainEqual(
			expect.objectContaining({
				type: "approval_required",
				summary: expect.objectContaining({
					status: "running",
					currentTask: expect.objectContaining({ status: "running" }),
				}),
			}),
		);
		expect(events.some((event) => event.type === "notification_ready")).toBe(false);
		expect(harness.pendingMailbox.size).toBe(0);
		await finishTask(harness, created.agentId, created.taskId);
		expect(events.some((event) => event.type === "notification_ready")).toBe(true);
	});

	it("records an explicit failure reason when a child times out", async () => {
		vi.useFakeTimers();
		const harness = setup();
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "timeout worker",
			task: "Never settle",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		await vi.advanceTimersByTimeAsync(1_800_000);
		await vi.waitFor(() => expect(harness.manager.listSummaries(ROOT_ID)[0]?.status).toBe("failed"));
		expect(harness.manager.listTasks(created.agentId)[0]).toMatchObject({
			status: "failed",
			error: "Agent task timed out after 1800 seconds",
		});
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

	it("rejects overlapping ancestor deletion while a descendant deletion is active", async () => {
		const harness = setup();
		const parent = await harness.manager.spawn(ROOT_ID, {
			name: "delete parent",
			task: "Coordinate",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		harness.manager.attachActor(harness.runtimes[0]!.session as unknown as AgentSession);
		const child = await harness.manager.spawn(parent.agentId, {
			name: "delete child",
			task: "Inspect",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(2));
		const gate = deferred();
		harness.runtimes[1]!.disposeGate = gate.promise;
		const deletingChild = harness.manager.deleteAgent(ROOT_ID, child.agentId);
		await vi.waitFor(() => expect(harness.runtimes[1]!.disposeStarted).toBe(true));
		await expect(harness.manager.deleteAgent(ROOT_ID, parent.agentId)).rejects.toMatchObject({
			code: "INVALID_STATE",
		});
		gate.resolve();
		await expect(deletingChild).resolves.toMatchObject({ status: "deleted" });
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

	it("rejects task trace parameters when inspect_agents has no agent id", async () => {
		const harness = setup();
		await expect(harness.manager.inspect(ROOT_ID, { taskId: "task-1" })).rejects.toMatchObject({
			code: "INVALID_INPUT",
		});
		await expect(harness.manager.inspect(ROOT_ID, { beforeEventId: "event-1" })).rejects.toMatchObject({
			code: "INVALID_INPUT",
		});
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

	it("treats an archived ancestor as an archive overlay for its terminal subtree", async () => {
		const harness = setup();
		const parent = await harness.manager.spawn(ROOT_ID, {
			name: "archive parent",
			task: "Coordinate",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		harness.manager.attachActor(harness.runtimes[0]!.session as unknown as AgentSession);
		const child = await harness.manager.spawn(parent.agentId, {
			name: "archive child",
			task: "Inspect",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(2));
		harness.runtimes[1]!.session.settle("child done");
		await vi.waitFor(() => expect(harness.manager.listTasks(child.agentId)[0]?.status).toBe("done"));
		harness.runtimes[0]!.session.settle("parent done");
		await vi.waitFor(() => expect(harness.manager.listTasks(parent.agentId)[0]?.status).toBe("done"));

		await harness.manager.setArchived(ROOT_ID, parent.agentId, true);
		expect(harness.manager.listSummaries(ROOT_ID)).toEqual([]);
		expect(
			harness.manager
				.listSummaries(ROOT_ID, true)
				.map((agent) => agent.agentId)
				.sort(),
		).toEqual([parent.agentId, child.agentId].sort());
		await expect(
			harness.manager.followUpTask(ROOT_ID, { agentId: child.agentId, task: "Hidden follow-up" }),
		).rejects.toMatchObject({ code: "INVALID_STATE" });

		await harness.manager.setArchived(ROOT_ID, parent.agentId, false);
		expect(
			harness.manager
				.listSummaries(ROOT_ID)
				.map((agent) => agent.agentId)
				.sort(),
		).toEqual([parent.agentId, child.agentId].sort());
	});

	it("recovers terminal mailbox events whenever a nested parent actor attaches", async () => {
		const harness = setup();
		const parent = await harness.manager.spawn(ROOT_ID, {
			name: "parent worker",
			task: "coordinate",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const parentSession = harness.runtimes[0]!.session;
		const detach = harness.manager.attachActor(parentSession as unknown as AgentSession);
		const nested = await harness.manager.spawn(parent.agentId, {
			name: "nested worker",
			task: "nested",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(2));
		const nestedManager = harness.runtimes[1]!.session.sessionManager;
		nestedManager.appendAgentControl({
			type: "agent_task",
			agentId: nested.agentId,
			taskId: nested.taskId,
			text: "nested",
			taskSummary: "nested",
			status: "stopped",
			reason: "interrupted",
		});
		const eventId = `agent:${nested.agentId}:${nested.taskId}:terminal`;
		expect(parentSession.hasAgentMailboxEvent(eventId)).toBe(false);
		detach();
		harness.manager.attachActor(parentSession as unknown as AgentSession);
		expect(parentSession.hasAgentMailboxEvent(eventId)).toBe(true);
	});

	it("wakes a root waiter when a grandchild becomes terminal", async () => {
		const harness = setup();
		const parent = await harness.manager.spawn(ROOT_ID, {
			name: "coordinator",
			task: "coordinate",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		harness.manager.attachActor(harness.runtimes[0]!.session as unknown as AgentSession);
		const nested = await harness.manager.spawn(parent.agentId, {
			name: "leaf",
			task: "review",
			agentType: "reviewer",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(2));
		const waiting = harness.manager.waitAgents(ROOT_ID, { agentIds: [nested.agentId], timeoutMs: 1_000 });
		await finishTask(harness, nested.agentId, nested.taskId, "leaf done");
		await expect(waiting).resolves.toMatchObject({
			timedOut: false,
			agents: [{ agentId: nested.agentId, status: "done" }],
			mailboxEventIds: [],
		});
	});

	it("rejects follow-up once the durable task history reaches its protocol bound", { timeout: 15_000 }, async () => {
		const harness = setup();
		const created = await harness.manager.spawn(ROOT_ID, {
			name: "long-lived worker",
			task: "initial",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const manager = harness.runtimes[0]!.session.sessionManager;
		for (let index = 1; index < MAX_AGENT_TASKS; index++) {
			manager.appendAgentControl({
				type: "agent_task",
				agentId: created.agentId,
				taskId: `history-${index}`,
				text: `history ${index}`,
				taskSummary: `history ${index}`,
				status: "done",
			});
		}
		await expect(
			harness.manager.followUpTask(ROOT_ID, { agentId: created.agentId, task: "one too many" }),
		).rejects.toMatchObject({ code: "QUEUE_FULL" });
		expect(harness.manager.listTasks(created.agentId)).toHaveLength(MAX_AGENT_TASKS);
	});

	it("bounds queued work across the whole agent tree", { timeout: 15_000 }, async () => {
		const harness = setup({ scheduler: new SubagentScheduler(1, 1) });
		await harness.manager.spawn(ROOT_ID, { name: "queue blocker", task: "Block", agentType: "worker" });
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const queued = await harness.manager.spawn(ROOT_ID, {
			name: "queue owner",
			task: "First queued task",
			agentType: "worker",
		});
		for (let index = 1; index < MAX_AGENT_QUEUED_TASKS; index++) {
			await harness.manager.followUpTask(ROOT_ID, {
				agentId: queued.agentId,
				task: `Queued task ${index + 1}`,
			});
		}
		expect(
			harness.manager.listSummaries(ROOT_ID, true).find((agent) => agent.agentId === queued.agentId),
		).toMatchObject({
			status: "queued",
			currentTask: { taskId: queued.taskId, taskSummary: "First queued task" },
		});
		await expect(
			harness.manager.spawn(ROOT_ID, { name: "queue overflow", task: "Overflow", agentType: "worker" }),
		).rejects.toMatchObject({ code: "QUEUE_FULL" });
		expect(harness.manager.listSummaries(ROOT_ID, true).some((agent) => agent.name === "queue overflow")).toBe(false);
	});

	it("rejects invalid ingress before creating a child journal", async () => {
		const harness = setup();
		await expect(
			harness.manager.spawn(ROOT_ID, { name: "bad\nname", task: "task", agentType: "worker" }),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		await expect(
			harness.manager.spawn(ROOT_ID, { name: "   ", task: "task", agentType: "worker" }),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		await expect(
			harness.manager.spawn(ROOT_ID, { name: "worker ", task: "task", agentType: "worker" }),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		await expect(
			harness.manager.spawn(ROOT_ID, { name: "blank", task: "   ", agentType: "worker" }),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		await expect(
			harness.manager.spawn(ROOT_ID, { name: "fork-zero", task: "task", agentType: "worker", forkTurns: 0 }),
		).rejects.toMatchObject({ code: "INVALID_INPUT" });
		await expect(
			harness.manager.spawn(ROOT_ID, {
				name: "oversized",
				task: "界".repeat(Math.floor(MAX_AGENT_INPUT_UTF8_BYTES / 3) + 1),
				agentType: "worker",
			}),
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
