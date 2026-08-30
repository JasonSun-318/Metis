import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type NewSessionOptions, SessionManager } from "../src/core/session-manager.ts";
import type { SubagentManager } from "../src/core/subagents/manager.ts";
import {
	SessionAgentCoordinator,
	type SessionAgentCoordinatorOptions,
} from "../src/core/subagents/session-agent-coordinator.ts";
import {
	AGENT_TOOL_NAMES,
	type AgentMailboxTerminalEvent,
	type AgentManagerEvent,
} from "../src/core/subagents/types.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const harnesses: Harness[] = [];
const managers: SessionManager[] = [];
const roots: string[] = [];

afterEach(async () => {
	while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	while (managers.length > 0) managers.pop()?.close();
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function agentHeader(
	cwd: string,
	input: Pick<
		NonNullable<NewSessionOptions["agent"]>,
		"agentId" | "parentSessionId" | "rootSessionId" | "mayDelegate"
	>,
): NonNullable<NewSessionOptions["agent"]> {
	return {
		name: "worker",
		agentType: "worker",
		agentPath: [input.agentId],
		cwd,
		tools: ["read"],
		writePolicy: "inherit",
		permissionMode: "ask",
		model: { provider: "faux", modelId: "faux" },
		thinkingLevel: "high",
		initialTask: "Coordinate work",
		forkTurns: 0,
		timeoutSeconds: 60,
		...input,
	};
}

function terminalEvent(overrides: Partial<AgentMailboxTerminalEvent> = {}): AgentMailboxTerminalEvent {
	return {
		eventId: "agent:child:task:terminal",
		taskId: "task",
		agentId: "child",
		parentSessionId: "root",
		name: "worker",
		type: "terminal",
		status: "done",
		finalMessage: "done",
		completedAt: new Date(0).toISOString(),
		...overrides,
	};
}

async function persistedHarness(
	options: Omit<NewSessionOptions, "agent"> & {
		agent?: (cwd: string) => NonNullable<NewSessionOptions["agent"]>;
	},
): Promise<{ harness: Harness; sessionManager: SessionManager }> {
	const root = mkdtempSync(join(tmpdir(), "metis-session-agent-coordinator-"));
	const cwd = join(root, "workspace");
	mkdirSync(cwd);
	const { agent, ...sessionOptions } = options;
	const sessionManager = SessionManager.create(cwd, join(root, "sessions"), {
		...sessionOptions,
		...(agent ? { agent: agent(cwd) } : {}),
	});
	const harness = await createHarness({
		sessionManager,
		withAgentDir: true,
		initialActiveToolNames: ["read"],
	});
	roots.push(root);
	managers.push(sessionManager);
	harnesses.push(harness);
	return { harness, sessionManager };
}

function managerAdapter() {
	let listener: ((event: AgentManagerEvent) => void) | undefined;
	const detach = vi.fn();
	const unsubscribe = vi.fn();
	const manager = {
		attachActor: vi.fn(() => detach),
		subscribe: vi.fn((next: (event: AgentManagerEvent) => void) => {
			listener = next;
			return unsubscribe;
		}),
		assertCanEnterPlan: vi.fn(),
		unload: vi.fn(async () => undefined),
	} as unknown as SubagentManager;
	return { manager, detach, unsubscribe, emit: (event: AgentManagerEvent) => listener?.(event) };
}

function coordinatorOptions(
	agentDir: string,
	overrides: Partial<SessionAgentCoordinatorOptions> = {},
): SessionAgentCoordinatorOptions {
	return {
		agentDir,
		createChildRuntime: async () => {
			throw new Error("unused in coordinator seam tests");
		},
		onDiagnostic: vi.fn(),
		...overrides,
	};
}

describe("SessionAgentCoordinator", () => {
	it("owns a persisted Code root and disposes it once", async () => {
		const { harness, sessionManager } = await persistedHarness({ id: "root", mode: "code" });
		const adapter = managerAdapter();
		const createManager = vi.fn(() => adapter.manager);
		const guardSpy = vi.spyOn(harness.session, "setCollaborationModeGuard");
		const coordinator = new SessionAgentCoordinator(coordinatorOptions(harness.tempDir, { createManager }));

		await coordinator.initialize(harness.session);

		expect(coordinator.manager).toBe(adapter.manager);
		expect(harness.session.getActiveToolNames()).toEqual(expect.arrayContaining([...AGENT_TOOL_NAMES]));
		await harness.session.setCollaborationMode("plan");
		expect(adapter.manager.assertCanEnterPlan).toHaveBeenCalledWith(sessionManager.getSessionId());

		await coordinator.dispose();
		await coordinator.dispose();

		expect(adapter.manager.unload).toHaveBeenCalledTimes(1);
		expect(adapter.unsubscribe).toHaveBeenCalledOnce();
		expect(guardSpy).toHaveBeenLastCalledWith(undefined);
	});

	it("borrows a child manager without unloading it", async () => {
		const { harness } = await persistedHarness({
			id: "child",
			mode: "code",
			agent: (cwd) =>
				agentHeader(cwd, {
					agentId: "child",
					parentSessionId: "root",
					rootSessionId: "root",
					mayDelegate: false,
				}),
		});
		const adapter = managerAdapter();
		const coordinator = new SessionAgentCoordinator(
			coordinatorOptions(harness.tempDir, { inheritedManager: adapter.manager }),
		);

		coordinator.attach(harness.session);

		expect(coordinator.manager).toBe(adapter.manager);
		expect(harness.session.getActiveToolNames().filter((name) => AGENT_TOOL_NAMES.includes(name as never))).toEqual(
			[],
		);
		await coordinator.dispose();
		expect(adapter.detach).toHaveBeenCalledOnce();
		expect(adapter.manager.unload).not.toHaveBeenCalled();
	});

	it("disables coordination for non-persisted and scheduled sessions", async () => {
		const memoryHarness = await createHarness({ withAgentDir: true });
		harnesses.push(memoryHarness);
		const scheduled = await persistedHarness({
			id: "scheduled",
			mode: "chat",
			scheduled: { taskId: "task", runId: "run" },
		});

		for (const harness of [memoryHarness, scheduled.harness]) {
			const createManager = vi.fn(() => managerAdapter().manager);
			const coordinator = new SessionAgentCoordinator(coordinatorOptions(harness.tempDir, { createManager }));
			await coordinator.initialize(harness.session);
			expect(coordinator.manager).toBeUndefined();
			expect(createManager).not.toHaveBeenCalled();
			await coordinator.dispose();
		}
	});

	it("rebinds after owned cleanup without retaining the previous manager", async () => {
		const root = await persistedHarness({ id: "root", mode: "code" });
		const replacement = await createHarness({ withAgentDir: true });
		harnesses.push(replacement);
		const adapter = managerAdapter();
		const coordinator = new SessionAgentCoordinator(
			coordinatorOptions(root.harness.tempDir, { createManager: () => adapter.manager }),
		);
		await coordinator.initialize(root.harness.session);

		await coordinator.dispose();
		await coordinator.rebind(replacement.session);

		expect(adapter.manager.unload).toHaveBeenCalledOnce();
		expect(coordinator.manager).toBeUndefined();
	});

	it("ignores a continuation that becomes stale during disposal", async () => {
		const { harness } = await persistedHarness({
			id: "child",
			mode: "code",
			agent: (cwd) =>
				agentHeader(cwd, {
					agentId: "child",
					parentSessionId: "root",
					rootSessionId: "root",
					mayDelegate: true,
				}),
		});
		const adapter = managerAdapter();
		const coordinator = new SessionAgentCoordinator(
			coordinatorOptions(harness.tempDir, { inheritedManager: adapter.manager }),
		);
		let releaseIdle!: () => void;
		const waitForIdle = vi
			.spyOn(harness.session, "waitForIdle")
			.mockImplementationOnce(
				() =>
					new Promise<void>((resolve) => {
						releaseIdle = resolve;
					}),
			)
			.mockResolvedValue(undefined);
		const continueMailbox = vi.spyOn(harness.session, "continueAgentMailbox");
		coordinator.attach(harness.session);

		adapter.emit({ type: "notification_ready", event: terminalEvent({ parentSessionId: "child" }) });
		await vi.waitFor(() => expect(waitForIdle).toHaveBeenCalled());
		await coordinator.dispose();
		releaseIdle();
		await new Promise<void>((resolve) => setImmediate(resolve));

		expect(continueMailbox).not.toHaveBeenCalled();
	});

	it("reports manager notification failures through the diagnostic callback", async () => {
		const { harness } = await persistedHarness({ id: "root", mode: "code" });
		const adapter = managerAdapter();
		const onDiagnostic = vi.fn();
		const coordinator = new SessionAgentCoordinator(
			coordinatorOptions(harness.tempDir, { createManager: () => adapter.manager, onDiagnostic }),
		);
		await coordinator.initialize(harness.session);

		adapter.emit({
			type: "notification_failed",
			event: terminalEvent({ parentSessionId: "root" }),
			error: "offline",
		});

		expect(onDiagnostic).toHaveBeenCalledWith("Agent notification failed: offline");
	});
});
