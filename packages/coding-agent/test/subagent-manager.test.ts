import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@arcmind/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import type { PermissionApprovalRequest } from "../src/core/permission-policy.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type ChildRuntimeFactoryInput, SubagentManager } from "../src/core/subagents/manager.ts";
import { SubagentScheduler } from "../src/core/subagents/scheduler.ts";
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
	private readonly listeners = new Set<(event: { type: string }) => void>();

	constructor(sessionManager: SessionManager) {
		this.sessionManager = sessionManager;
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

	constructor(manager: SessionManager) {
		this.session = new FakeChildSession(manager);
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
	readonly manager: SubagentManager;
	readonly runtimes: FakeChildRuntime[];
	readonly factoryInputs: ChildRuntimeFactoryInput[];
}

function setup(
	onPermissionRequest?: (request: PermissionApprovalRequest) => Promise<{ decision: "allow" | "deny" }>,
	factoryGate?: Promise<void>,
): Harness {
	const root = mkdtempSync(join(tmpdir(), "arcmind-subagent-manager-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	const parentManager = SessionManager.create(cwd, join(root, "sessions"), {
		id: "parent-session-1",
		mode: "code",
		permissionMode: "full",
		reviewerEnabled: true,
	});
	const model = getModel("anthropic", "claude-sonnet-4-5")!;
	const parent = {
		sessionManager: parentManager,
		messages: [],
		mode: "code",
		thinkingLevel: "high",
		model,
		modelRegistry: {},
		getActiveToolNames: () => ["read", "bash"],
	} as unknown as AgentSession;
	const runtimes: FakeChildRuntime[] = [];
	const factoryInputs: ChildRuntimeFactoryInput[] = [];
	let sequence = 0;
	const manager = new SubagentManager({
		parentSessionManager: parentManager,
		agentDir,
		workspaceRoots: [cwd],
		scheduler: new SubagentScheduler(4, 4),
		createId: () => `child-session-${++sequence}`,
		onPermissionRequest,
		createChildRuntime: async (input) => {
			factoryInputs.push(input);
			await factoryGate;
			const runtime = new FakeChildRuntime(input.sessionManager);
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
	return { root, parentManager, manager, runtimes, factoryInputs };
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
		first.session.settle("verified handoff");
		await expect(harness.manager.wait({ agentIds: [created.agentId] })).resolves.toMatchObject({
			agents: [{ agentId: created.agentId, status: "done", finalSummary: "verified handoff" }],
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

	it("maps provider errors to failed and exposes only bounded visible activity", async () => {
		const harness = setup();
		const created = await spawn(harness);
		harness.runtimes[0]!.session.settle("partial result", "error");
		await vi.waitFor(() => expect(harness.manager.listSummaries()[0]?.status).toBe("failed"));
		const inspected = await harness.manager.inspect({ agentId: created.agentId, limit: 20 });
		expect(inspected.agents[0]).toMatchObject({ status: "failed", error: "provider failed" });
		expect(inspected.journal?.map((entry) => entry.type)).toEqual(["message", "message"]);
		expect(JSON.stringify(inspected.journal)).not.toContain("subagent_created");
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

	it("forwards approvals with child identity and emits an approval event", async () => {
		const approvals = vi.fn(async (_request: PermissionApprovalRequest) => ({ decision: "allow" as const }));
		const harness = setup(approvals);
		const created = await spawn(harness);
		const events: string[] = [];
		harness.manager.subscribe((event) => events.push(event.type));
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
					sandbox: "workspace-write",
				},
				args: { command: "curl example.test" },
				userMessages: [],
				reason: "network requires confirmation",
				fullOnceRequired: false,
			}),
		).resolves.toEqual({ decision: "allow" });
		expect(approvals.mock.calls[0]?.[0].reason).toContain(`Subagent researcher (${created.agentId})`);
		expect(events).toContain("approval_required");
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
		await expect(harness.manager.wait({ agentIds: [created.agentId] })).resolves.toMatchObject({
			agents: [{ agentId: created.agentId, status: "closed" }],
		});
	});

	it("lets close take ownership while the child runtime is still starting", async () => {
		const gate = deferred();
		const harness = setup(undefined, gate.promise);
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

	it("rejects invalid ingress before creating a child journal", async () => {
		const harness = setup();
		await expect(harness.manager.spawn({ name: "bad\nname", task: "task", tools: [] })).rejects.toThrow("control");
		await expect(harness.manager.spawn({ name: "blank", task: "   ", tools: [] })).rejects.toThrow("non-empty");
		await expect(harness.manager.spawn({ name: "fork-zero", task: "task", tools: [], forkTurns: 0 })).rejects.toThrow(
			"1 through 1000",
		);
		expect(harness.manager.listSummaries()).toEqual([]);
	});
});
