import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, type FauxResponseStep, fauxAssistantMessage } from "@metis/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionRuntime, type CreateAgentSessionRuntimeFactory } from "../src/core/agent-session-runtime.ts";
import { createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SubagentManager } from "../src/core/subagents/manager.ts";
import {
	type AgentMailboxTerminalEvent,
	type AgentManagerEvent,
	MAX_AGENT_MAILBOX_PENDING_EVENTS,
} from "../src/core/subagents/types.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

const ROOT_ID = "mailbox-root";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface Gate {
	readonly promise: Promise<void>;
	resolve(): void;
}

function deferred(): Gate {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function terminalEvent(
	agentId: string,
	taskId: string,
	finalMessage: string,
	parentSessionId = "unused",
): AgentMailboxTerminalEvent {
	return {
		eventId: `agent:${agentId}:${taskId}:terminal`,
		taskId,
		agentId,
		parentSessionId,
		name: "grandchild",
		type: "terminal",
		status: "done",
		finalMessage,
		completedAt: new Date(0).toISOString(),
	};
}

interface Fixture {
	readonly root: string;
	readonly cwd: string;
	readonly agentDir: string;
	readonly rootHarness: Harness;
	readonly manager: SubagentManager;
	readonly childHarnesses: Harness[];
	readonly childRuntimes: AgentSessionRuntime[];
	readonly contexts: Map<string, Context[]>;
	readonly release: (depth: number) => void;
	readonly detachRoot: () => void;
}

/**
 * Builds a real root AgentSession and real per-child AgentSessionRuntimes. Each
 * child shares the root manager, so grandchildren are journaled by the same
 * manager while the child runtime itself can be disposed.
 */
async function createFixture(options: { readonly prefillMailbox?: number } = {}): Promise<Fixture> {
	const root = mkdtempSync(join(tmpdir(), "metis-mailbox-recovery-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	const rootSessionManager = SessionManager.create(cwd, join(root, "sessions"), {
		id: ROOT_ID,
		mode: "code",
		permissionPreset: "full",
	});
	for (let index = 0; index < (options.prefillMailbox ?? 0); index += 1) {
		const event = terminalEvent(`synthetic-${index}`, `synthetic-task-${index}`, "synthetic", ROOT_ID);
		rootSessionManager.appendAgentControl({ type: "agent_mailbox_event", event });
	}
	const rootHarness = await createHarness({
		sessionManager: rootSessionManager,
		withAgentDir: true,
	});
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		authStorage: rootHarness.authStorage,
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		},
	});
	const childHarnesses: Harness[] = [];
	const childRuntimes: AgentSessionRuntime[] = [];
	const contexts = new Map<string, Context[]>();
	const gates = new Map<number, Gate>();
	const gate = (depth: number): Gate => {
		let value = gates.get(depth);
		if (!value) {
			value = deferred();
			gates.set(depth, value);
		}
		return value;
	};

	let manager!: SubagentManager;
	let sequence = 0;
	manager = new SubagentManager({
		parentSessionManager: rootHarness.sessionManager,
		agentDir,
		getWorkspaceRoots: () => rootHarness.sessionManager.getWorkspaceRoots(),
		createId: () => `mailbox-child-${++sequence}`,
		createChildRuntime: async (input) => {
			const depth = input.config.agentPath.length;
			const childHarness = await createHarness({
				sessionManager: input.sessionManager,
				withAgentDir: true,
				initialActiveToolNames: [...input.config.tools],
				permissionPreset: input.config.permissionPreset,
				includeAutoMemory: false,
			});
			childHarnesses.push(childHarness);
			const agentContexts = contexts.get(input.config.agentId) ?? [];
			contexts.set(input.config.agentId, agentContexts);
			const respond: FauxResponseStep = async (context) => {
				const index = agentContexts.length;
				agentContexts.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) });
				if (index === 0) await gate(depth).promise;
				return fauxAssistantMessage(index === 0 ? `${input.config.name} initial done` : "mailbox integrated");
			};
			childHarness.setResponses([respond, respond, respond, respond]);
			const runtime = new AgentSessionRuntime(
				childHarness.session,
				services,
				vi.fn() as unknown as CreateAgentSessionRuntimeFactory,
				[],
				undefined,
				undefined,
				cwd,
				manager,
			);
			childRuntimes.push(runtime);
			return runtime;
		},
	});
	const detachRoot = manager.attachActor(rootHarness.session);
	cleanups.push(async () => {
		for (const value of gates.values()) value.resolve();
		try {
			await manager.unload("parent_unloaded");
		} catch {
			// The lifecycle under test may already own disposal.
		}
		for (const runtime of childRuntimes) {
			try {
				await runtime.dispose();
			} catch {
				// Already disposed by the manager.
			}
		}
		for (const harness of childHarnesses) {
			try {
				await harness.cleanup();
			} catch {
				// Already disposed by the runtime.
			}
		}
		try {
			await rootHarness.cleanup();
		} finally {
			services.resourceLoader.dispose?.();
			rmSync(root, { recursive: true, force: true });
		}
	});
	return {
		root,
		cwd,
		agentDir,
		rootHarness,
		manager,
		childHarnesses,
		childRuntimes,
		contexts,
		release: (depth) => gate(depth).resolve(),
		detachRoot,
	};
}

describe("subagent mailbox recovery", () => {
	it.each([true, false])(
		"consumes a cold child mailbox (explicit resume: %s) without waking the root",
		async (explicitResume) => {
			const fixture = await createFixture();
			const child = await fixture.manager.spawn(ROOT_ID, {
				name: "coordinator",
				task: "coordinate a grandchild",
				agentType: "worker",
			});
			await vi.waitFor(() => expect(fixture.childRuntimes).toHaveLength(1));
			await vi.waitFor(() => expect(fixture.contexts.get(child.agentId)).toHaveLength(1));

			const grandchild = await fixture.manager.spawn(child.agentId, {
				name: "leaf",
				task: "finish later",
				agentType: "explorer",
			});
			await vi.waitFor(() => expect(fixture.childRuntimes).toHaveLength(2));
			await vi.waitFor(() => expect(fixture.contexts.get(grandchild.agentId)).toHaveLength(1));

			// The child finishes first. Its runtime is disposed while the grandchild is
			// still running, so the later terminal event has to be journaled cold.
			fixture.release(1);
			await vi.waitFor(() =>
				expect(fixture.manager.listTasks(child.agentId).find((task) => task.taskId === child.taskId)?.status).toBe(
					"done",
				),
			);
			if (explicitResume)
				await fixture.manager.control(
					{ kind: "user" },
					{ agentId: child.agentId, action: "stop", scope: "self", requestId: "pause-child-only" },
				);
			const childCallCount = fixture.contexts.get(child.agentId)!.length;
			const rootCallCount = fixture.rootHarness.faux.state.callCount;
			fixture.release(2);
			await vi.waitFor(() =>
				expect(
					fixture.manager.listTasks(grandchild.agentId).find((task) => task.taskId === grandchild.taskId)?.status,
				).toBe("done"),
			);
			const grandchildEventId = `agent:${grandchild.agentId}:${grandchild.taskId}:terminal`;
			await vi.waitFor(async () => {
				const journal = await fixture.manager.readJournal(ROOT_ID, child.agentId);
				expect(
					journal.some(
						(entry) => entry.type === "agent_mailbox_event" && entry.event.eventId === grandchildEventId,
					),
				).toBe(true);
			});

			const childPendingResponses = fixture.childHarnesses[0]!.getPendingResponseCount();
			const runtimeCount = fixture.childRuntimes.length;

			// Cold inspection is journal-only and must never create a runtime or model call.
			fixture.manager.listSummaries(ROOT_ID);
			fixture.manager.listTasks(child.agentId);
			await fixture.manager.readJournal(ROOT_ID, child.agentId);
			if (explicitResume) expect(fixture.contexts.get(child.agentId)).toHaveLength(childCallCount);
			expect(fixture.childHarnesses[0]!.getPendingResponseCount()).toBe(childPendingResponses);
			expect(fixture.childRuntimes).toHaveLength(runtimeCount);
			expect(fixture.rootHarness.faux.state.callCount).toBe(rootCallCount);

			if (explicitResume)
				await fixture.manager.control(
					{ kind: "user" },
					{ agentId: child.agentId, action: "resume", scope: "self", requestId: "resume-cold-child" },
				);

			// Explicit resume must rehydrate the child conversation and let its model
			// consume the pending event. The root must not be resumed as a substitute.
			await vi.waitFor(
				() => {
					expect(fixture.contexts.get(child.agentId)?.length ?? 0).toBeGreaterThan(childCallCount);
					expect(fixture.rootHarness.faux.state.callCount).toBe(rootCallCount);
				},
				{ timeout: 2_000 },
			);
			const resumedContext = fixture.contexts.get(child.agentId)!.at(-1)!;
			expect(JSON.stringify(resumedContext.messages)).toContain(grandchildEventId);
		},
	);

	it.each([
		{ failure: "one-time writer failure", reattach: true },
		{ failure: "mailbox capacity", reattach: true },
		{ failure: "one-time writer failure", reattach: false },
		{ failure: "mailbox capacity", reattach: false },
	])(
		"recovers a human intervention after $failure (reattach: $reattach)",
		async ({ failure, reattach }) => {
			const fixture = await createFixture(
				failure === "mailbox capacity" ? { prefillMailbox: MAX_AGENT_MAILBOX_PENDING_EVENTS } : {},
			);
			const child = await fixture.manager.spawn(ROOT_ID, {
				name: "worker",
				task: "wait for a human",
				agentType: "worker",
			});
			await vi.waitFor(() => expect(fixture.childRuntimes).toHaveLength(1));
			await vi.waitFor(() => expect(fixture.contexts.get(child.agentId)).toHaveLength(1));

			if (failure === "mailbox capacity") {
				fixture.rootHarness.setResponses([fauxAssistantMessage("drained two events")]);
				expect(fixture.rootHarness.session.getPendingAgentMailboxEventIds()).toHaveLength(
					MAX_AGENT_MAILBOX_PENDING_EVENTS,
				);
			} else {
				const append = fixture.rootHarness.sessionManager.appendAgentControl.bind(
					fixture.rootHarness.sessionManager,
				);
				let failed = false;
				vi.spyOn(fixture.rootHarness.sessionManager, "appendAgentControl").mockImplementation((payload) => {
					if (!failed && payload.type === "agent_mailbox_event" && payload.event.type === "intervention") {
						failed = true;
						throw new Error("simulated one-time journal write failure");
					}
					return append(payload);
				});
			}

			const events: AgentManagerEvent[] = [];
			fixture.manager.subscribe((event) => events.push(event));
			const intervention = await fixture.manager.submitMessage(
				{ kind: "user" },
				{
					agentId: child.agentId,
					requestId: `human-${failure}`,
					delivery: "steer",
					input: { text: "Human guidance while the task is running" },
				},
			);
			await vi.waitFor(() => expect(events.some((event) => event.type === "notification_failed")).toBe(true));

			if (failure === "mailbox capacity") {
				// Reserve room for both the intervention and terminal notifications.
				await fixture.rootHarness.session.continueAgentMailbox([
					`agent:synthetic-0:synthetic-task-0:terminal`,
					`agent:synthetic-1:synthetic-task-1:terminal`,
				]);
				expect(fixture.rootHarness.session.getPendingAgentMailboxEventIds()).toHaveLength(
					MAX_AGENT_MAILBOX_PENDING_EVENTS - 2,
				);
			}

			fixture.release(1);
			await vi.waitFor(() => expect(fixture.manager.listTasks(child.agentId)[0]?.status).toBe("done"));

			// Reattaching the actor is the durable recovery path: terminal events are
			// republished, and the human intervention must be republished as well.
			if (reattach) {
				fixture.detachRoot();
				fixture.manager.attachActor(fixture.rootHarness.session);
			}
			await vi.waitFor(
				() => {
					const journal = fixture.rootHarness.sessionManager.getDurableJournalSnapshot();
					// Positive control: the terminal notification is not lost either.
					expect(
						journal.some(
							(entry) =>
								entry.type === "agent_mailbox_event" &&
								entry.event.eventId === `agent:${child.agentId}:${child.taskId}:terminal`,
						),
					).toBe(true);
					const interventionEventId = `agent:${child.agentId}:${intervention.messageId}:intervention:${ROOT_ID}`;
					expect(
						journal.some(
							(entry) => entry.type === "agent_mailbox_event" && entry.event.eventId === interventionEventId,
						),
					).toBe(true);
				},
				{ timeout: 3000 },
			);
			expect(fixture.rootHarness.session.getPendingAgentMailboxEventIds().length).toBeLessThanOrEqual(
				MAX_AGENT_MAILBOX_PENDING_EVENTS,
			);
		},
		30_000,
	);
});
