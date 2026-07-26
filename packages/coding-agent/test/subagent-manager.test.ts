import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@arcmind/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { PermissionMode } from "../src/core/permission-mode.ts";
import type { PermissionApprovalRequest } from "../src/core/permission-policy.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type ChildRuntimeFactoryInput, SubagentManager } from "../src/core/subagents/manager.ts";
import { SubagentScheduler } from "../src/core/subagents/scheduler.ts";
import { SUBAGENT_ACTIVATION_TOOL_NAME } from "../src/core/subagents/types.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

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
	private readonly activeTools: readonly string[];
	private readonly listeners = new Set<(event: { type: string }) => void>();

	constructor(sessionManager: SessionManager, activeTools: readonly string[]) {
		this.sessionManager = sessionManager;
		this.activeTools = activeTools;
	}

	getActiveToolNames(): string[] {
		return [...this.activeTools];
	}

	subscribe(listener: (event: { type: string }) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
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
		for (const listener of this.listeners) listener({ type: "agent_settled" });
	}

	getSessionStats() {
		return { tokens: { input: 3, output: 5, cacheRead: 1, cacheWrite: 2 }, cost: 0.25 };
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
}

function setup(options: SetupOptions = {}): Harness {
	const root = mkdtempSync(join(tmpdir(), "arcmind-subagent-manager-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	const parentManager = SessionManager.create(cwd, join(root, "sessions"), {
		id: "parent-session-1",
		mode: "code",
		permissionMode: options.parentPermissionMode ?? "full",
	});
	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const pendingMailbox = new Set<string>();
	const parent = {
		sessionManager: parentManager,
		messages: [],
		mode: "code",
		thinkingLevel: "high",
		model,
		modelRegistry: {},
		getActiveToolNames: () => ["read", "bash", "update_plan"],
		enqueueBackgroundCustomMessage: (
			message: {
				customType: string;
				content: string | Array<{ type: "text"; text: string }>;
				display: boolean;
				details?: unknown;
			},
			key: string,
		) => {
			parentManager.appendCustomMessageEntry(message.customType, message.content, message.display, message.details);
			pendingMailbox.add(key);
		},
		hasPendingBackgroundMessage: (key: string) => pendingMailbox.has(key),
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
			const runtime = new FakeChildRuntime(input.sessionManager, options.childRuntimeTools ?? input.config.tools);
			runtimes.push(runtime);
			return runtime as unknown as AgentSessionRuntime;
		},
	});
	manager.attachParent(parent);
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

async function spawn(harness: Harness, name = "researcher") {
	const result = await harness.manager.spawn({ name, task: "Inspect the implementation", tools: ["read"] });
	await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
	return result;
}

describe("SubagentManager", () => {
	it("runs cold-to-hot-to-cold, persists the handoff, and resumes the same child", async () => {
		const harness = setup();
		const created = await spawn(harness);
		const first = harness.runtimes[0]!;
		expect(harness.factoryInputs[0]!.permissionModeCeiling()).toBe("full");
		first.session.settle("verified handoff");
		await expect(harness.manager.wait({ agentIds: [created.agentId] })).resolves.toMatchObject({
			updatedAgentIds: [created.agentId],
			reason: "mailbox_update",
		});
		expect(first.disposed).toBe(true);
		expect(harness.manager.getAggregateUsage()).toMatchObject({ input: 3, output: 5, cacheRead: 1, cacheWrite: 2 });

		await expect(
			harness.manager.message({ agentId: created.agentId, mode: "follow_up", message: "Check the edge case" }),
		).resolves.toMatchObject({ agentId: created.agentId, delivery: "queued" });
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(2));
		expect(harness.runtimes[1]!.prompts).toEqual(["Check the edge case"]);
		harness.runtimes[1]!.session.settle("edge case checked");
		await vi.waitFor(() => expect(harness.manager.listSummaries()[0]?.finalSummary).toBe("edge case checked"));
		expect(harness.manager.listSummaries()[0]?.agentId).toBe(created.agentId);
	});

	it("inherits the parent mode and rejects a broader child", async () => {
		const harness = setup({ parentPermissionMode: "ask" });
		const inherited = await spawn(harness);
		expect(inherited.permissionMode).toBe("ask");
		expect(harness.runtimes[0]!.session.sessionManager.getPermissionSettings()).toEqual({ mode: "ask" });
		await expect(
			harness.manager.spawn({
				name: "too-wide",
				task: "work",
				tools: ["read"],
				permissionMode: "full",
			}),
		).rejects.toThrow("Child permissions cannot be broader than parent permissions");
		harness.runtimes[0]!.session.settle();
	});

	it("lets a Full parent choose Ask or Full for a new child", async () => {
		const harness = setup({ parentPermissionMode: "full" });
		const ask = await harness.manager.spawn({
			name: "narrow",
			task: "work narrowly",
			tools: ["read"],
			permissionMode: "ask",
		});
		const full = await harness.manager.spawn({
			name: "wide",
			task: "work broadly",
			tools: ["read"],
			permissionMode: "full",
		});
		expect(ask.permissionMode).toBe("ask");
		expect(full.permissionMode).toBe("full");
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(2));
		harness.runtimes[0]!.session.settle();
		harness.runtimes[1]!.session.settle();
	});

	it("downgrades a running Full child and never re-upgrades it", async () => {
		const harness = setup({ parentPermissionMode: "full" });
		const child = await spawn(harness);
		expect(harness.runtimes[0]!.session.sessionManager.getPermissionSettings()).toEqual({ mode: "full" });

		harness.parentManager.setPermissionSettings({ mode: "ask" });
		expect(harness.factoryInputs[0]!.permissionModeCeiling()).toBe("ask");
		expect(harness.runtimes[0]!.session.sessionManager.getPermissionSettings()).toEqual({ mode: "ask" });
		expect(harness.manager.listSummaries()[0]).toMatchObject({
			agentId: child.agentId,
			configuration: { permissionMode: "ask" },
		});

		harness.parentManager.setPermissionSettings({ mode: "full" });
		expect(harness.factoryInputs[0]!.permissionModeCeiling()).toBe("ask");
		expect(harness.runtimes[0]!.session.sessionManager.getPermissionSettings()).toEqual({ mode: "ask" });
		harness.runtimes[0]!.session.settle();
	});

	it("applies a parent downgrade before a starting child's first prompt", async () => {
		const gate = deferred();
		const harness = setup({ parentPermissionMode: "full", factoryGate: gate.promise });
		const child = await harness.manager.spawn({
			name: "starting",
			task: "start later",
			tools: ["read"],
		});
		await vi.waitFor(() => expect(harness.factoryInputs).toHaveLength(1));
		harness.parentManager.setPermissionSettings({ mode: "ask" });
		expect(harness.factoryInputs[0]!.permissionModeCeiling()).toBe("ask");

		gate.resolve();
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		expect(harness.runtimes[0]!.session.sessionManager.getPermissionSettings()).toEqual({ mode: "ask" });
		expect(harness.runtimes[0]!.prompts).toEqual(["start later"]);
		expect(harness.manager.listSummaries()[0]).toMatchObject({
			agentId: child.agentId,
			configuration: { permissionMode: "ask" },
		});
		harness.runtimes[0]!.session.settle();
	});

	it("persists Ask for a queued child before it starts", async () => {
		const harness = setup({
			parentPermissionMode: "full",
			scheduler: new SubagentScheduler(1, 1),
		});
		await spawn(harness, "blocker");
		const queued = await harness.manager.spawn({
			name: "queued",
			task: "queued task",
			tools: ["read"],
		});
		expect(queued.status).toBe("queued");

		harness.parentManager.setPermissionSettings({ mode: "ask" });
		expect(await harness.manager.readJournal(queued.agentId)).toEqual(
			expect.arrayContaining([expect.objectContaining({ type: "session_permissions", permissionMode: "ask" })]),
		);

		harness.runtimes[0]!.session.settle();
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(2));
		expect(harness.runtimes[1]!.session.sessionManager.getPermissionSettings()).toEqual({ mode: "ask" });
		harness.runtimes[1]!.session.settle();
	});

	it("persists a parent downgrade into a cold completed child and never re-upgrades it", async () => {
		const harness = setup({ parentPermissionMode: "full" });
		const child = await spawn(harness);
		const childPath = harness.factoryInputs[0]!.sessionManager.getSessionFile()!;
		harness.runtimes[0]!.session.settle();
		await vi.waitFor(() => expect(harness.manager.listSummaries()[0]?.status).toBe("done"));
		await vi.waitFor(() => expect(harness.runtimes[0]!.disposed).toBe(true));

		harness.parentManager.setPermissionSettings({ mode: "ask" });
		const downgraded = SessionManager.open(childPath);
		expect(downgraded.getPermissionSettings()).toEqual({ mode: "ask" });
		downgraded.close();
		expect(harness.manager.listSummaries()[0]).toMatchObject({
			agentId: child.agentId,
			configuration: { permissionMode: "ask" },
		});

		harness.parentManager.setPermissionSettings({ mode: "full" });
		const reopened = SessionManager.open(childPath);
		expect(reopened.getPermissionSettings()).toEqual({ mode: "ask" });
		reopened.close();
	});

	it("reports a cold child downgrade persistence failure instead of hiding it", async () => {
		const harness = setup({ parentPermissionMode: "full" });
		await spawn(harness);
		harness.runtimes[0]!.session.settle();
		await vi.waitFor(() => expect(harness.runtimes[0]!.disposed).toBe(true));
		const open = vi.spyOn(SessionManager, "open").mockImplementationOnce(() => {
			throw new Error("child journal unavailable");
		});

		expect(() => harness.parentManager.setPermissionSettings({ mode: "ask" })).toThrow(
			"Failed to persist Ask permission for every child session",
		);
		expect(harness.manager.listSummaries()[0]).toMatchObject({
			configuration: { permissionMode: "ask" },
		});
		open.mockRestore();
	});

	it("fails closed when a child approval has no parent UI", async () => {
		const harness = setup();
		await spawn(harness);
		const callback = harness.factoryInputs[0]!.onPermissionRequest!;
		await expect(
			callback({
				action: {
					actionId: "action-1",
					toolName: "bash",
					provenance: "builtin",
					risks: ["shell"],
					paths: [],
					networkTargets: [],
					command: "pwd",
				},
				args: { command: "pwd" },
				reason: "Shell execution",
			}),
		).rejects.toThrow("No interactive parent session owner is available");
		harness.runtimes[0]!.session.settle();
	});

	it("maps provider errors to failed and exposes only bounded visible activity", async () => {
		const harness = setup();
		const created = await spawn(harness);
		harness.runtimes[0]!.session.settle("partial result", "error");
		await vi.waitFor(() => expect(harness.manager.listSummaries()[0]?.status).toBe("failed"));
		const inspected = await harness.manager.inspect({ agentId: created.agentId, limit: 20 });
		expect(inspected.agents[0]).toMatchObject({ status: "failed", error: "provider failed" });
		expect(inspected.journal?.map((entry) => entry.type)).toEqual(["message", "message"]);
		expect(JSON.stringify(inspected.journal)).not.toContain("subagent_created");

		await harness.manager.message({ agentId: created.agentId, mode: "follow_up", message: "Recover explicitly" });
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(2));
		expect(harness.manager.listSummaries()[0]).toMatchObject({ status: "running" });
		expect(harness.manager.listSummaries()[0]).not.toHaveProperty("finalSummary");
		expect(harness.manager.listSummaries()[0]).not.toHaveProperty("error");
		expect(harness.manager.listSummaries()[0]).not.toHaveProperty("usage");
		harness.runtimes[1]!.session.settle("recovered result");
		await vi.waitFor(() => expect(harness.manager.listSummaries()[0]?.status).toBe("done"));
		expect(harness.manager.listSummaries()[0]).toMatchObject({ finalSummary: "recovered result" });
		expect(harness.manager.listSummaries()[0]).not.toHaveProperty("error");
	});

	it("fails visibly when a cold runtime cannot recreate the exact configured tool set", async () => {
		const harness = setup({ scheduler: new SubagentScheduler(4, 4), childRuntimeTools: [] });
		const created = await harness.manager.spawn({
			name: "missing-tool",
			task: "Use the delegated reader",
			tools: ["read"],
		});

		await vi.waitFor(() => expect(harness.manager.listSummaries()[0]?.status).toBe("failed"));
		expect(harness.manager.listSummaries()[0]).toMatchObject({
			agentId: created.agentId,
			error: "Child runtime tool snapshot mismatch (missing: read; unexpected: none)",
		});
		expect(harness.runtimes[0]?.disposed).toBe(true);
	});

	it("does not finish interrupt until disposal and terminal persistence complete", async () => {
		const harness = setup();
		const created = await spawn(harness);
		const gate = deferred();
		harness.runtimes[0]!.disposeGate = gate.promise;
		let resolved = false;
		const interrupting = harness.manager.interrupt(created.agentId).then((value) => {
			resolved = true;
			return value;
		});
		await vi.waitFor(() => expect(harness.runtimes[0]!.disposeStarted).toBe(true));
		expect(resolved).toBe(false);
		gate.resolve();
		await expect(interrupting).resolves.toMatchObject({ status: "stopped" });
		expect(harness.runtimes[0]!.disposed).toBe(true);
	});

	it("keeps parent-unloaded children stopped when cleanup reports an error", async () => {
		const harness = setup();
		const created = await spawn(harness);
		const childPath = harness.runtimes[0]!.session.sessionManager.getSessionFile()!;
		const enqueueMailbox = vi.spyOn(harness.parent, "enqueueBackgroundCustomMessage");
		vi.spyOn(harness.runtimes[0]!, "dispose").mockRejectedValueOnce(new Error("dispose failed during parent unload"));

		await expect(harness.manager.unload("parent_unloaded")).rejects.toThrow("dispose failed during parent unload");

		expect(harness.manager.listSummaries()[0]).toMatchObject({
			agentId: created.agentId,
			status: "stopped",
			error: "dispose failed during parent unload",
		});
		const state = SessionManager.openReadOnly(childPath)
			.getDurableJournalSnapshot()
			.filter((entry) => entry.type === "subagent_state")
			.at(-1);
		expect(state).toMatchObject({
			status: "stopped",
			reason: "parent_unloaded",
			error: "dispose failed during parent unload",
		});
		expect(enqueueMailbox).not.toHaveBeenCalled();
	});

	it("rejects waiters when terminal mailbox persistence fails without changing the child result", async () => {
		const harness = setup();
		const created = await spawn(harness);
		vi.spyOn(harness.parent, "enqueueBackgroundCustomMessage").mockImplementation(() => {
			throw new Error("mailbox disk failed");
		});
		const waiting = harness.manager.wait({ agentIds: [created.agentId] });

		harness.runtimes[0]!.session.settle("completed result");

		await expect(waiting).rejects.toThrow("mailbox disk failed");
		await vi.waitFor(() =>
			expect(harness.manager.listSummaries()[0]).toMatchObject({
				agentId: created.agentId,
				status: "done",
				finalSummary: "completed result",
			}),
		);
	});

	it("forwards approvals to the user without notifying the parent model", async () => {
		const approvals = vi.fn(async (_request: PermissionApprovalRequest) => ({ decision: "allow" as const }));
		const harness = setup({ onPermissionRequest: approvals });
		const created = await spawn(harness);
		const events: string[] = [];
		harness.manager.subscribe((event) => events.push(event.type));
		let waitResolved = false;
		const waiting = harness.manager.wait({ agentIds: [created.agentId] }).then((value) => {
			waitResolved = true;
			return value;
		});
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
			type: "subagent",
			id: created.agentId,
			name: "researcher",
		});
		expect(events).toContain("approval_required");
		await Promise.resolve();
		expect(waitResolved).toBe(false);
		expect(harness.pendingMailbox.size).toBe(0);
		harness.runtimes[0]!.session.settle();
		await expect(waiting).resolves.toEqual({
			updatedAgentIds: [created.agentId],
			reason: "mailbox_update",
		});
	});

	it("does not resolve wait for queued or running progress", async () => {
		const gate = deferred();
		const harness = setup({ factoryGate: gate.promise });
		const created = await harness.manager.spawn({ name: "wait-child", task: "Wait", tools: ["read"] });
		let resolved = false;
		const waiting = harness.manager.wait({ agentIds: [created.agentId] }).then((result) => {
			resolved = true;
			return result;
		});
		await Promise.resolve();
		expect(resolved).toBe(false);

		gate.resolve();
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		await Promise.resolve();
		expect(resolved).toBe(false);

		harness.runtimes[0]!.session.settle("terminal event");
		await expect(waiting).resolves.toEqual({
			updatedAgentIds: [created.agentId],
			reason: "mailbox_update",
		});
	});

	it("runs the original task before follow-ups queued during scheduler admission", async () => {
		const harness = setup({ scheduler: new SubagentScheduler(1, 1) });
		await spawn(harness, "blocker");
		const queued = await harness.manager.spawn({
			name: "queued-child",
			task: "Original queued task",
			tools: ["read"],
		});
		expect(queued.status).toBe("queued");
		await expect(
			harness.manager.message({
				agentId: queued.agentId,
				mode: "follow_up",
				message: "Then check the edge case",
			}),
		).resolves.toMatchObject({ delivery: "queued", runId: queued.runId });

		harness.runtimes[0]!.session.settle("blocker done");
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(2));
		expect(harness.runtimes[1]!.prompts).toEqual(["Original queued task", "Then check the edge case"]);
		harness.runtimes[1]!.session.settle("queued work done");
		await vi.waitFor(() =>
			expect(harness.manager.listSummaries().find((item) => item.agentId === queued.agentId)?.status).toBe("done"),
		);
	});

	it("canonicalizes a child cwd inside the parent workspace", async () => {
		const harness = setup();
		const project = join(harness.root, "project");
		mkdirSync(join(project, "frontend"));
		const first = await harness.manager.spawn({
			name: "frontend-a",
			task: "Own frontend",
			tools: [],
			cwd: "frontend",
		});

		expect(first.cwd).toBe(realpathSync(join(project, "frontend")));
		expect(first).not.toHaveProperty("readPaths");
		expect(first).not.toHaveProperty("writePaths");
		expect(first).not.toHaveProperty("overlaps");
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));
		harness.runtimes[0]!.session.settle();
	});

	it("uses the current parent roots for each future child cwd", async () => {
		const harness = setup();
		const external = join(harness.root, "external");
		mkdirSync(external);

		await expect(
			harness.manager.spawn({ name: "before", task: "work", tools: ["read"], cwd: external }),
		).rejects.toThrow("inside the parent workspace");

		harness.parentManager.addWorkspaceDirectory(external);
		const child = await harness.manager.spawn({ name: "after", task: "work", tools: ["read"], cwd: external });
		expect(child.cwd).toBe(realpathSync(external));
		await vi.waitFor(() => expect(harness.runtimes).toHaveLength(1));

		harness.parentManager.removeWorkspaceDirectory(external);
		expect(harness.manager.listSummaries()[0]?.configuration?.cwd).toBe(realpathSync(external));
		await expect(
			harness.manager.spawn({ name: "removed", task: "work", tools: ["read"], cwd: external }),
		).rejects.toThrow("inside the parent workspace");
		harness.runtimes[0]!.session.settle();
	});

	it("closes idempotently only after a running child is drained and deleted", async () => {
		const harness = setup();
		const created = await spawn(harness);
		const childPath = harness.factoryInputs[0]!.sessionManager.getSessionFile()!;
		const gate = deferred();
		harness.runtimes[0]!.disposeGate = gate.promise;
		let resolved = false;
		const closing = harness.manager.close(created.agentId).then((value) => {
			resolved = true;
			return value;
		});
		await vi.waitFor(() => expect(harness.runtimes[0]!.disposeStarted).toBe(true));
		expect(resolved).toBe(false);
		gate.resolve();
		await expect(closing).resolves.toEqual({ agentId: created.agentId, status: "closed" });
		expect(existsSync(childPath)).toBe(false);
		await expect(harness.manager.close(created.agentId)).resolves.toEqual({
			agentId: created.agentId,
			status: "closed",
			alreadyClosed: true,
		});
		expect(harness.manager.listSummaries()).toMatchObject([{ agentId: created.agentId, status: "closed" }]);
		harness.pendingMailbox.clear();
		await expect(harness.manager.wait({ agentIds: [created.agentId] })).resolves.toEqual({
			updatedAgentIds: [],
			reason: "no_live_agents",
		});
	});

	it("lets close take ownership while the child runtime is still starting", async () => {
		const gate = deferred();
		const harness = setup({ factoryGate: gate.promise });
		const created = await harness.manager.spawn({
			name: "starting-child",
			task: "Start slowly",
			tools: ["read"],
		});
		await vi.waitFor(() => expect(harness.factoryInputs).toHaveLength(1));
		let resolved = false;
		const closing = harness.manager.close(created.agentId).then((value) => {
			resolved = true;
			return value;
		});
		await Promise.resolve();
		expect(resolved).toBe(false);
		gate.resolve();
		await expect(closing).resolves.toEqual({ agentId: created.agentId, status: "closed" });
		expect(harness.runtimes[0]?.disposed).toBe(true);
	});

	it("keeps parent-only control tools out of child snapshots", async () => {
		const harness = setup();
		for (const tool of [SUBAGENT_ACTIVATION_TOOL_NAME, "update_plan"]) {
			await expect(
				harness.manager.spawn({
					name: `child-for-${tool}`,
					task: "Inspect one module",
					tools: [tool],
				}),
			).rejects.toThrow(`Subagent tool is reserved: ${tool}`);
		}
	});

	it("rejects invalid ingress before creating a child journal", async () => {
		const harness = setup();
		await expect(harness.manager.spawn({ name: "bad\nname", task: "task", tools: [] })).rejects.toThrow("control");
		await expect(harness.manager.spawn({ name: "blank", task: "   ", tools: [] })).rejects.toThrow("non-empty");
		await expect(harness.manager.spawn({ name: "fork-zero", task: "task", tools: [], forkTurns: 0 })).rejects.toThrow(
			"1 through 1000",
		);
		await expect(harness.manager.spawn({ name: "escape", task: "task", tools: [], cwd: ".." })).rejects.toThrow(
			"parent workspace",
		);
		expect(harness.manager.listSummaries()).toEqual([]);
	});
});
