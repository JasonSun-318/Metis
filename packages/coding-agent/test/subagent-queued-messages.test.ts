import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import type { ThinkingLevel } from "@metis/agent-core";
import { fauxAssistantMessage, getModel, registerFauxProvider } from "@metis/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../src/core/agent-session-runtime.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { QueuedTurnConflictError, QueuedTurnNotFoundError } from "../src/core/queued-turn-queue.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type ChildRuntimeFactoryInput, SubagentManager } from "../src/core/subagents/manager.ts";
import { buildChildSystemPrompt } from "../src/core/subagents/prompts.ts";
import { queuedAdmissionRequestId, queuedAgentMessages } from "../src/core/subagents/queued-messages.ts";
import { SubagentScheduler } from "../src/core/subagents/scheduler.ts";
import type { AgentMailboxTerminalEvent } from "../src/core/subagents/types.ts";
import type { ExtensionAPI } from "../src/index.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

const ROOT_ID = "parent-session-1";
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0)) await cleanup();
});

class FakeChildSession {
	readonly messages: unknown[] = [];
	readonly model = getModel("anthropic", "claude-sonnet-4-5")!;
	readonly sessionManager: SessionManager;
	readonly mode = "code";
	readonly thinkingLevel = "high";
	activeDurableTurnId: string | undefined;
	private readonly tools: readonly string[];
	private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
	private readonly consumedListeners = new Set<(requestId: string) => void>();

	constructor(sessionManager: SessionManager, tools: readonly string[]) {
		this.sessionManager = sessionManager;
		this.tools = tools;
	}

	getActiveToolNames(): string[] {
		return [...this.tools];
	}
	getDelegatableToolNames(): string[] {
		return [...this.tools];
	}
	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	subscribeDurablePromptConsumed(listener: (requestId: string) => void): () => void {
		this.consumedListeners.add(listener);
		return () => this.consumedListeners.delete(listener);
	}
	emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) listener(event);
	}
	emitConsumed(requestId: string): void {
		for (const listener of this.consumedListeners) listener(requestId);
	}
	appendUser(text: string): void {
		const message = userMsg(text);
		this.messages.push(message);
		this.sessionManager.appendMessage(message);
	}
	settle(text = "done"): void {
		const message = assistantMsg(text);
		this.messages.push(message);
		this.sessionManager.appendMessage(message);
		for (const listener of this.listeners) listener({ type: "agent_settled" });
	}
	getSessionStats() {
		return {
			tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			cost: 0,
			toolCalls: 0,
		};
	}
}

class FakeChildRuntime {
	readonly session: FakeChildSession;
	readonly prompts: string[] = [];
	constructor(manager: SessionManager, tools: readonly string[]) {
		this.session = new FakeChildSession(manager, tools);
	}
	async submitPrompt(input: { text: string; requestId?: string }): Promise<never> {
		this.prompts.push(input.text);
		this.session.appendUser(input.text);
		if (input.requestId) this.session.emitConsumed(input.requestId);
		return {} as never;
	}
	async interrupt(): Promise<never> {
		this.session.settle("interrupted");
		return {} as never;
	}
	async dispose(): Promise<void> {
		this.session.sessionManager.close();
	}
}

interface Harness {
	readonly root: string;
	readonly parentManager: SessionManager;
	readonly parent: AgentSession;
	readonly manager: SubagentManager;
	readonly runtimes: FakeChildRuntime[];
	readonly factoryInputs: ChildRuntimeFactoryInput[];
	readonly mailboxEvents: Array<{ type?: string; eventId?: string; taskId?: string; state?: string }>;
}

function setup(scheduler = new SubagentScheduler(4, 4)): Harness {
	const root = mkdtempSync(join(tmpdir(), "metis-subagent-queued-messages-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	const parentManager = SessionManager.create(cwd, join(root, "sessions"), {
		id: ROOT_ID,
		mode: "code",
		permissionPreset: "full",
	});
	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const pendingMailbox = new Set<string>();
	const mailboxEvents: Array<{ type?: string; eventId?: string; taskId?: string }> = [];
	const parent = {
		sessionManager: parentManager,
		messages: [],
		mode: "code",
		thinkingLevel: "high" as ThinkingLevel,
		model,
		getActiveToolNames: () => ["read"],
		getDelegatableToolNames: () => ["read"],
		enqueueAgentMailboxEvent: vi.fn((event: AgentMailboxTerminalEvent) => {
			pendingMailbox.add(event.eventId);
			mailboxEvents.push(event);
			return true;
		}),
		hasAgentMailboxEvent: (eventId: string) => pendingMailbox.has(eventId),
		getPendingAgentMailboxEventIds: () => [...pendingMailbox],
	} as unknown as AgentSession;
	const runtimes: FakeChildRuntime[] = [];
	const factoryInputs: ChildRuntimeFactoryInput[] = [];
	let sequence = 0;
	const manager = new SubagentManager({
		parentSessionManager: parentManager,
		agentDir,
		getWorkspaceRoots: () => parentManager.getWorkspaceRoots(),
		scheduler,
		createId: () => `child-session-${++sequence}`,
		createChildRuntime: async (input) => {
			factoryInputs.push(input);
			const runtime = new FakeChildRuntime(input.sessionManager, [
				...input.config.tools,
				...(input.config.mayDelegate
					? ["spawn_agent", "inspect_agents", "send_message", "followup_task", "wait_agents", "interrupt_agent"]
					: []),
			]);
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
				// Lifecycle under test may already own disposal.
			}
		}
		try {
			parentManager.close();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	return { root, parentManager, parent, manager, runtimes, factoryInputs, mailboxEvents };
}

async function queueHuman(harness: Harness, agentId: string, text: string, requestId: string) {
	return await harness.manager.submitMessage(
		{ kind: "user" },
		{ agentId, requestId, delivery: "queue", input: { text } },
	);
}

async function finishCurrent(harness: Harness, agentId: string, taskId: string, text = "done"): Promise<void> {
	const runtime = harness.runtimes.at(-1)!;
	runtime.session.settle(text);
	await vi.waitFor(() =>
		expect(harness.manager.listTasks(agentId).find((task) => task.taskId === taskId)?.status).toBe("done"),
	);
}

describe("SubagentManager durable queued messages", () => {
	it("lists one pending human message and guides it into the running task exactly once", async () => {
		const harness = setup();
		const child = await harness.manager.spawn(ROOT_ID, { name: "worker", task: "Inspect", agentType: "worker" });
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const queued = await queueHuman(harness, child.agentId, "Guided follow-up", "human-queue-1");
		expect(queued.state).toBe("queued");

		const [pending] = harness.manager.listQueuedMessages({ kind: "user" }, child.agentId);
		expect(pending).toMatchObject({
			messageId: queued.messageId,
			state: "queued",
			input: { text: "Guided follow-up" },
		});
		expect(pending.revision).toEqual(expect.any(String));

		const receipt = await harness.manager.sendQueuedMessage(
			{ kind: "user" },
			{
				agentId: child.agentId,
				requestId: "guide-1",
				messageId: pending.messageId,
				expectedRevision: pending.revision,
				delivery: "steer",
			},
		);
		expect(receipt).toMatchObject({ taskId: child.taskId, delivery: "steer" });
		expect(harness.manager.listQueuedMessages({ kind: "user" }, child.agentId)).toEqual([]);
		expect(harness.runtimes[0]!.prompts).toEqual(["Inspect", "Guided follow-up"]);

		await finishCurrent(harness, child.agentId, child.taskId);
		expect(harness.runtimes).toHaveLength(1);
		expect(harness.manager.listTasks(child.agentId).map((task) => task.status)).toEqual(["done", "stopped"]);
		expect(harness.manager.listTasks(child.agentId).find((task) => task.taskId === queued.taskId)?.status).toBe(
			"stopped",
		);
		const journal = await harness.manager.readJournal(ROOT_ID, child.agentId);
		const latest = [...journal]
			.reverse()
			.find((entry) => entry.type === "agent_input" && entry.messageId === queued.messageId);
		const queuedEntry = journal.find(
			(entry) => entry.type === "agent_input" && entry.messageId === queued.messageId && entry.state === "queued",
		);
		expect(queuedEntry?.type).toBe("agent_input");
		expect(latest).toMatchObject({
			taskId: child.taskId,
			requestId: queued.requestId,
			requestHash: queuedEntry?.type === "agent_input" ? queuedEntry.requestHash : "missing",
			delivery: "steer",
			state: "delivered",
		});
		expect(
			harness.mailboxEvents.filter((event) => event.type === "terminal" && event.taskId === queued.taskId),
		).toEqual([]);
	});

	it("rejects stale and duplicate guide actions without delivering twice", async () => {
		const harness = setup();
		const child = await harness.manager.spawn(ROOT_ID, { name: "worker", task: "Inspect", agentType: "worker" });
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		await queueHuman(harness, child.agentId, "Only once", "human-queue-2");
		const [pending] = harness.manager.listQueuedMessages({ kind: "user" }, child.agentId);

		await harness.manager.sendQueuedMessage(
			{ kind: "user" },
			{
				agentId: child.agentId,
				requestId: "guide-first",
				messageId: pending.messageId,
				expectedRevision: pending.revision,
				delivery: "steer",
			},
		);
		await expect(
			harness.manager.sendQueuedMessage(
				{ kind: "user" },
				{
					agentId: child.agentId,
					requestId: "guide-second",
					messageId: pending.messageId,
					expectedRevision: pending.revision,
					delivery: "steer",
				},
			),
		).rejects.toBeInstanceOf(QueuedTurnConflictError);
		expect(harness.runtimes[0]!.prompts.filter((text) => text === "Only once")).toHaveLength(1);
		await finishCurrent(harness, child.agentId, child.taskId);
	});

	it("deletes a queued message and stops its queued task", async () => {
		const harness = setup();
		const child = await harness.manager.spawn(ROOT_ID, { name: "worker", task: "Inspect", agentType: "worker" });
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const queued = await queueHuman(harness, child.agentId, "Delete me", "human-queue-3");
		const [pending] = harness.manager.listQueuedMessages({ kind: "user" }, child.agentId);

		await harness.manager.deleteQueuedMessage(
			{ kind: "user" },
			{
				agentId: child.agentId,
				requestId: "delete-1",
				messageId: pending.messageId,
				expectedRevision: pending.revision,
			},
		);
		expect(harness.manager.listQueuedMessages({ kind: "user" }, child.agentId)).toEqual([]);
		expect(harness.manager.listTasks(child.agentId).find((task) => task.taskId === queued.taskId)?.status).toBe(
			"stopped",
		);
		expect(
			harness.mailboxEvents.filter((event) => event.type === "terminal" && event.taskId === queued.taskId),
		).toEqual([]);
		await expect(
			harness.manager.deleteQueuedMessage(
				{ kind: "user" },
				{
					agentId: child.agentId,
					requestId: "delete-2",
					messageId: pending.messageId,
					expectedRevision: pending.revision,
				},
			),
		).rejects.toBeInstanceOf(QueuedTurnConflictError);
		await finishCurrent(harness, child.agentId, child.taskId);
		expect(harness.runtimes).toHaveLength(1);
	});

	it("keeps the message queued when guide admission fails, then retries safely", async () => {
		const harness = setup();
		const child = await harness.manager.spawn(ROOT_ID, { name: "worker", task: "Inspect", agentType: "worker" });
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		await queueHuman(harness, child.agentId, "Retry me", "human-queue-4");
		const [pending] = harness.manager.listQueuedMessages({ kind: "user" }, child.agentId);
		vi.spyOn(harness.runtimes[0]!, "submitPrompt").mockRejectedValueOnce(new Error("admission failed"));

		await expect(
			harness.manager.sendQueuedMessage(
				{ kind: "user" },
				{
					agentId: child.agentId,
					requestId: "guide-failed",
					messageId: pending.messageId,
					expectedRevision: pending.revision,
					delivery: "steer",
				},
			),
		).rejects.toThrow("admission failed");
		const [retry] = harness.manager.listQueuedMessages({ kind: "user" }, child.agentId);
		expect(retry).toMatchObject({ messageId: pending.messageId, input: { text: "Retry me" } });

		await harness.manager.sendQueuedMessage(
			{ kind: "user" },
			{
				agentId: child.agentId,
				requestId: "guide-retry",
				messageId: retry.messageId,
				expectedRevision: retry.revision,
				delivery: "steer",
			},
		);
		expect(harness.runtimes[0]!.prompts.filter((text) => text === "Retry me")).toHaveLength(1);
		await finishCurrent(harness, child.agentId, child.taskId);
		expect(harness.runtimes).toHaveLength(1);
	});

	it("supports explicit start for a paused queued task without reordering", async () => {
		const harness = setup();
		const child = await harness.manager.spawn(ROOT_ID, { name: "worker", task: "Inspect", agentType: "worker" });
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		await queueHuman(harness, child.agentId, "Start me", "human-queue-5");
		await harness.manager.control(
			{ kind: "user" },
			{ agentId: child.agentId, action: "stop", scope: "self", requestId: "pause-start" },
		);
		const [pending] = harness.manager.listQueuedMessages({ kind: "user" }, child.agentId);
		expect(pending.state).toBe("paused");

		await harness.manager.control(
			{ kind: "user" },
			{ agentId: child.agentId, action: "resume", scope: "self", requestId: "resume-start" },
		);
		await harness.manager.sendQueuedMessage(
			{ kind: "user" },
			{
				agentId: child.agentId,
				requestId: "start-1",
				messageId: pending.messageId,
				expectedRevision: pending.revision,
				delivery: "start",
			},
		);
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(2));
		expect(harness.runtimes[1]!.prompts).toEqual(["Start me"]);
		await finishCurrent(
			harness,
			child.agentId,
			harness.manager.listTasks(child.agentId).find((task) => task.status === "running")!.taskId,
		);
	});

	it("rejects Guide while the task is not accepting without dropping the message", async () => {
		const harness = setup();
		const child = await harness.manager.spawn(ROOT_ID, { name: "worker", task: "Inspect", agentType: "worker" });
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		await queueHuman(harness, child.agentId, "Still pending", "human-queue-busy");
		Object.defineProperty(harness.runtimes[0]!.session, "isStreaming", { value: false });
		const [pending] = harness.manager.listQueuedMessages({ kind: "user" }, child.agentId);
		await expect(
			harness.manager.sendQueuedMessage(
				{ kind: "user" },
				{
					agentId: child.agentId,
					requestId: "guide-busy",
					messageId: pending.messageId,
					expectedRevision: pending.revision,
					delivery: "steer",
				},
			),
		).rejects.toMatchObject({ name: "AgentError", code: "INVALID_STATE" });
		expect(harness.manager.listQueuedMessages({ kind: "user" }, child.agentId)).toMatchObject([
			{ messageId: pending.messageId, input: { text: "Still pending" } },
		]);
		await finishCurrent(harness, child.agentId, child.taskId);
	});

	it("reports an unknown queued message separately from a stale revision", async () => {
		const harness = setup();
		const child = await harness.manager.spawn(ROOT_ID, { name: "worker", task: "Inspect", agentType: "worker" });
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		await expect(
			harness.manager.deleteQueuedMessage(
				{ kind: "user" },
				{ agentId: child.agentId, requestId: "missing", messageId: "missing-message", expectedRevision: "rev" },
			),
		).rejects.toBeInstanceOf(QueuedTurnNotFoundError);
		await finishCurrent(harness, child.agentId, child.taskId);
	});

	it("retries a failed real runtime Guide once and consumes it exactly once", async () => {
		const faux = registerFauxProvider();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		let childCalls = 0;
		let blockGuide = true;
		faux.setResponses([
			async () => {
				childCalls += 1;
				if (childCalls === 1) await gate;
				return fauxAssistantMessage("done");
			},
			async () => fauxAssistantMessage("done"),
		]);
		const root = mkdtempSync(join(tmpdir(), "metis-guide-retry-"));
		const cwd = join(root, "workspace");
		const agentDir = join(root, "agent");
		mkdirSync(cwd);
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd: runtimeCwd,
			sessionManager,
			childConfig,
			permissionSettingsCeiling,
		}) => {
			const authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
			const services = await createAgentSessionServices({
				cwd: runtimeCwd,
				agentDir,
				authStorage,
				resourceLoaderOptions: {
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					extensionFactories: [
						(metis: ExtensionAPI) => {
							metis.registerProvider(faux.getModel().provider, {
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
								api: faux.api,
								streamSimple: faux.streamSimple,
								models: faux.models.map((model) => ({
									id: model.id,
									name: model.name,
									api: model.api,
									reasoning: model.reasoning,
									input: model.input,
									cost: model.cost,
									contextWindow: model.contextWindow,
									maxTokens: model.maxTokens,
								})),
							});
							metis.on("input", (event) => {
								if (blockGuide && event.streamingBehavior === "steer")
									return { action: "block", reason: "admission failed" };
								return undefined;
							});
						},
					],
				},
			});
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				model: faux.getModel(),
				tools: childConfig ? [...childConfig.tools] : ["read"],
				additionalSystemPrompt: childConfig ? buildChildSystemPrompt(childConfig, { agentDir }) : undefined,
				permissionSettingsCeiling,
				includeAutoMemory: false,
			});
			return { ...created, services, diagnostics: services.diagnostics };
		};
		const parentManager = SessionManager.create(cwd, join(root, "sessions"), {
			id: ROOT_ID,
			mode: "code",
			permissionPreset: "full",
		});
		const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: parentManager });
		cleanups.push(async () => {
			release();
			await runtime.dispose();
			faux.unregister();
			rmSync(root, { recursive: true, force: true });
		});
		const manager = runtime.subagentManager!;
		const child = await manager.spawn(ROOT_ID, { name: "real worker", task: "Inspect", agentType: "worker" });
		await vi.waitFor(() => expect(childCalls).toBe(1));
		const queued = await manager.submitMessage(
			{ kind: "user" },
			{ agentId: child.agentId, requestId: "real-guide", delivery: "queue", input: { text: "Guide once" } },
		);
		const [pending] = manager.listQueuedMessages({ kind: "user" }, child.agentId);
		await expect(
			manager.sendQueuedMessage(
				{ kind: "user" },
				{
					agentId: child.agentId,
					requestId: "guide-fail",
					messageId: pending.messageId,
					expectedRevision: pending.revision,
					delivery: "steer",
				},
			),
		).rejects.toThrow("admission failed");
		expect(manager.listQueuedMessages({ kind: "user" }, child.agentId)).toMatchObject([
			{ messageId: queued.messageId, input: { text: "Guide once" } },
		]);
		blockGuide = false;
		const [retry] = manager.listQueuedMessages({ kind: "user" }, child.agentId);
		const receipt = await manager.sendQueuedMessage(
			{ kind: "user" },
			{
				agentId: child.agentId,
				requestId: "guide-retry",
				messageId: retry.messageId,
				expectedRevision: retry.revision,
				delivery: "steer",
			},
		);
		expect(receipt).toMatchObject({ taskId: child.taskId, delivery: "steer" });
		release();
		await vi.waitFor(() => expect(manager.listTasks(child.agentId)[0]?.status).toBe("done"), { timeout: 5000 });
		const journal = await manager.readJournal(ROOT_ID, child.agentId);
		const consumed = journal.filter(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "user" &&
				JSON.stringify(entry.message.content).includes("Guide once"),
		);
		expect(consumed).toHaveLength(1);
		expect(manager.listQueuedMessages({ kind: "user" }, child.agentId)).toEqual([]);
		expect(manager.listTasks(child.agentId).filter((task) => task.status !== "stopped")).toHaveLength(1);
	}, 15000);

	it("projects archived records as empty without opening a runtime", () => {
		const input = { text: "Archived follow-up" };
		expect(
			queuedAgentMessages({
				archived: true,
				tasks: [],
				inputs: [
					{
						type: "agent_input",
						id: "revision-1",
						parentId: null,
						timestamp: "2026-10-26T00:00:00.000Z",
						agentId: "child",
						taskId: "task",
						messageId: "message",
						requestId: "request",
						requestHash: "hash",
						delivery: "queue",
						state: "queued",
						instructionRevision: 1,
						input,
						origin: { kind: "user" },
					},
				],
			}),
		).toEqual([]);
	});

	it("recovers an unsent human queue as paused and cancels only agent-origin input", async () => {
		const harness = setup();
		const child = await harness.manager.spawn(ROOT_ID, { name: "worker", task: "Inspect", agentType: "worker" });
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const queued = await queueHuman(harness, child.agentId, "Keep me", "human-queue-recover");
		await harness.manager.followUpTask(ROOT_ID, { agentId: child.agentId, task: "Agent follow-up" });
		await harness.manager.unload("parent_unloaded");

		const recovered = new SubagentManager({
			parentSessionManager: harness.parentManager,
			agentDir: join(harness.root, "agent"),
			getWorkspaceRoots: () => harness.parentManager.getWorkspaceRoots(),
			createChildRuntime: async () => {
				throw new Error("Recovery must not start a model");
			},
		});
		recovered.attachActor(harness.parent);
		try {
			expect(recovered.listQueuedMessages({ kind: "user" }, child.agentId)).toMatchObject([
				{ messageId: queued.messageId, state: "paused", input: { text: "Keep me" } },
			]);
			const journal = await recovered.readJournal(ROOT_ID, child.agentId);
			const latest = (messageId: string) =>
				[...journal].reverse().find((entry) => entry.type === "agent_input" && entry.messageId === messageId);
			expect(latest(queued.messageId)).toMatchObject({ state: "queued", requestId: queued.requestId });
			const agentInput = journal.find(
				(entry) => entry.type === "agent_input" && entry.origin.kind === "agent" && entry.delivery !== "start",
			);
			expect(agentInput && latest(agentInput.type === "agent_input" ? agentInput.messageId : "")).toMatchObject({
				state: "cancelled",
			});
			expect(recovered.listTasks(child.agentId).every((task) => task.status === "stopped")).toBe(true);
		} finally {
			await recovered.unload("parent_unloaded");
		}
	});

	it("keeps queue mutations isolated to descendants of the acting session", async () => {
		const harness = setup();
		const child = await harness.manager.spawn(ROOT_ID, { name: "worker", task: "Inspect", agentType: "worker" });
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		await queueHuman(harness, child.agentId, "Scoped", "human-queue-6");
		expect(() =>
			harness.manager.listQueuedMessages({ kind: "agent", sessionId: "other-root" }, child.agentId),
		).toThrow(/Unknown agent actor/i);
		await finishCurrent(harness, child.agentId, child.taskId);
	});

	it.each([
		{ consumed: false, scenario: "before durable admission as one paused human input" },
		{ consumed: true, scenario: "after durable consumption without requeueing" },
	])("recovers a Guide interrupted $scenario", async ({ consumed }) => {
		const harness = setup();
		const child = await harness.manager.spawn(ROOT_ID, {
			name: "crash worker",
			task: "Inspect",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		const queued = await queueHuman(harness, child.agentId, "Recover this Guide", "crash-guide-input");
		const [pending] = harness.manager.listQueuedMessages({ kind: "user" }, child.agentId);
		let rejectAdmission!: (error: Error) => void;
		const admission = new Promise<never>((_resolve, reject) => {
			rejectAdmission = reject;
		});
		const submit = vi.spyOn(harness.runtimes[0]!, "submitPrompt").mockReturnValueOnce(admission);
		const guiding = harness.manager.sendQueuedMessage(
			{ kind: "user" },
			{
				agentId: child.agentId,
				requestId: "crash-guide-action",
				messageId: pending.messageId,
				expectedRevision: pending.revision,
				delivery: "steer",
			},
		);
		const rejected = guiding.catch((error: unknown) => error);
		let recovered: SubagentManager | undefined;
		let recoveredParent: SessionManager | undefined;
		try {
			await vi.waitFor(() => expect(submit).toHaveBeenCalledOnce());
			const originalPath = harness.runtimes[0]!.session.sessionManager.getSessionFile()!;
			const recoveryRoot = join(harness.root, "crashed-process");
			const agentDir = join(recoveryRoot, "agent");
			const copiedPath = join(agentDir, relative(join(harness.root, "agent"), originalPath));
			mkdirSync(dirname(copiedPath), { recursive: true });
			// Copy only durable facts, without normal unload or the live writer lease.
			writeFileSync(copiedPath, readFileSync(originalPath));
			const admissionRequestId = queuedAdmissionRequestId(pending.messageId, pending.revision);
			if (consumed) {
				const copied = SessionManager.open(copiedPath);
				try {
					copied.appendMessage(
						userMsg("Recover this Guide"),
						undefined,
						undefined,
						undefined,
						undefined,
						admissionRequestId,
					);
				} finally {
					copied.close();
				}
			}
			recoveredParent = SessionManager.create(harness.parentManager.getCwd(), join(recoveryRoot, "sessions"), {
				id: ROOT_ID,
				mode: "code",
				permissionPreset: "full",
			});
			const createChildRuntime = vi.fn(async (): Promise<AgentSessionRuntime> => {
				throw new Error("Crash recovery must not execute a model");
			});
			recovered = new SubagentManager({
				parentSessionManager: recoveredParent,
				agentDir,
				getWorkspaceRoots: () => recoveredParent!.getWorkspaceRoots(),
				createChildRuntime,
			});
			recovered.attachActor({ ...harness.parent, sessionManager: recoveredParent } as AgentSession);
			expect(recovered.listQueuedMessages({ kind: "user" }, child.agentId)).toEqual(
				consumed
					? []
					: [
							expect.objectContaining({
								messageId: queued.messageId,
								state: "paused",
								input: { text: "Recover this Guide" },
							}),
						],
			);
			expect(createChildRuntime).not.toHaveBeenCalled();
			const journal = await recovered.readJournal(ROOT_ID, child.agentId);
			const latest = [...journal]
				.reverse()
				.find((entry) => entry.type === "agent_input" && entry.messageId === queued.messageId);
			expect(latest).toMatchObject({ state: consumed ? "delivered" : "queued", requestId: queued.requestId });
			if (consumed) {
				expect(
					journal.filter((entry) => entry.type === "message" && entry.agentMessageId === admissionRequestId),
				).toHaveLength(1);
				await expect(
					recovered.sendQueuedMessage(
						{ kind: "user" },
						{
							agentId: child.agentId,
							requestId: "do-not-repeat-consumed-guide",
							messageId: pending.messageId,
							expectedRevision: pending.revision,
							delivery: "start",
						},
					),
				).rejects.toBeInstanceOf(QueuedTurnConflictError);
				expect(createChildRuntime).not.toHaveBeenCalled();
			}
		} finally {
			rejectAdmission(new Error("Simulated process exited before admission"));
			await rejected;
			submit.mockRestore();
			await recovered?.unload("parent_unloaded");
			recoveredParent?.close();
			await harness.manager.unload("parent_unloaded");
		}
	});

	it("counts paused pending inputs toward capacity after one is explicitly started", async () => {
		const harness = setup();
		const child = await harness.manager.spawn(ROOT_ID, {
			name: "capacity worker",
			task: "Inspect",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		try {
			for (let index = 0; index < 32; index++)
				await queueHuman(harness, child.agentId, `Paused ${index}`, `paused-${index}`);
			await harness.manager.control(
				{ kind: "user" },
				{ agentId: child.agentId, action: "stop", scope: "self", requestId: "pause-capacity" },
			);
			const pending = harness.manager.listQueuedMessages({ kind: "user" }, child.agentId);
			expect(pending).toHaveLength(32);
			expect(pending.every((message) => message.state === "paused")).toBe(true);
			await harness.manager.sendQueuedMessage(
				{ kind: "user" },
				{
					agentId: child.agentId,
					requestId: "start-one-paused",
					messageId: pending[0]!.messageId,
					expectedRevision: pending[0]!.revision,
					delivery: "start",
				},
			);
			await vi.waitFor(() => expect(harness.runtimes).toHaveLength(2));
			expect(harness.manager.listQueuedMessages({ kind: "user" }, child.agentId)).toHaveLength(31);
			await queueHuman(harness, child.agentId, "The 32nd pending input", "fill-paused-capacity");
			expect(harness.manager.listQueuedMessages({ kind: "user" }, child.agentId)).toHaveLength(32);
			await expect(
				queueHuman(harness, child.agentId, "The 33rd must be refused", "overflow-paused-capacity"),
			).rejects.toMatchObject({ code: "QUEUE_FULL" });
			expect(harness.manager.listQueuedMessages({ kind: "user" }, child.agentId)).toHaveLength(32);
			expect(harness.runtimes[1]!.prompts).toEqual(["Paused 0"]);
		} finally {
			await harness.manager.unload("parent_unloaded");
		}
	});

	it("deletes a scheduler-waiting human task without creating its runtime or publishing terminal", async () => {
		const scheduler = new SubagentScheduler(1, 1);
		const harness = setup(scheduler);
		const child = await harness.manager.spawn(ROOT_ID, {
			name: "idle worker",
			task: "Initial task",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		await finishCurrent(harness, child.agentId, child.taskId);
		await vi.waitFor(() => expect(scheduler.runningCount).toBe(0));
		const blocker = await harness.manager.spawn(ROOT_ID, {
			name: "slot blocker",
			task: "Hold slot",
			agentType: "worker",
		});
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(2));
		try {
			const queued = await queueHuman(harness, child.agentId, "Delete before slot opens", "scheduler-delete-input");
			expect(scheduler.queuedCount).toBe(1);
			const [pending] = harness.manager.listQueuedMessages({ kind: "user" }, child.agentId);
			await harness.manager.deleteQueuedMessage(
				{ kind: "user" },
				{
					agentId: child.agentId,
					requestId: "scheduler-delete-action",
					messageId: pending.messageId,
					expectedRevision: pending.revision,
				},
			);
			expect.soft(scheduler.queuedCount).toBe(0);
			await finishCurrent(harness, blocker.agentId, blocker.taskId);
			await vi.waitFor(() => expect(scheduler.runningCount).toBe(0));
			expect.soft(harness.factoryInputs.filter((input) => input.config.agentId === child.agentId)).toHaveLength(1);
			expect(
				harness.mailboxEvents.filter((event) => event.type === "terminal" && event.taskId === queued.taskId),
			).toEqual([]);
			expect(harness.manager.listQueuedMessages({ kind: "user" }, child.agentId)).toEqual([]);
		} finally {
			await harness.manager.unload("parent_unloaded");
		}
	});
});
