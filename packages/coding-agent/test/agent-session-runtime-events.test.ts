import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@metis/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMode } from "../src/core/agent-mode.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { reduceRuntimeJournal } from "../src/core/runtime-recovery.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import type {
	ExtensionAPI,
	ExtensionFactory,
	SessionBeforeForkEvent,
	SessionBeforeSwitchEvent,
	SessionShutdownEvent,
	SessionStartEvent,
} from "../src/index.ts";

type RecordedSessionEvent =
	| SessionBeforeSwitchEvent
	| SessionBeforeForkEvent
	| SessionShutdownEvent
	| SessionStartEvent;

describe("AgentSessionRuntime session lifecycle events", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createRuntimeHost(extensionFactory: ExtensionFactory, initialMode: AgentMode = "code") {
		const tempDir = join(tmpdir(), `metis-runtime-events-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: faux.getModel(),
			resourceLoaderOptions: {
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
					},
					extensionFactory,
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtimeHost = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir, join(tempDir, "sessions"), { mode: initialMode }),
		});
		await runtimeHost.session.bindExtensions({});

		cleanups.push(async () => {
			await runtimeHost.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtimeHost, faux };
	}

	it("inherits mode for new and forked sessions and changes it only for an explicit new session", async () => {
		const { runtimeHost } = await createRuntimeHost(() => {}, "chat");

		await runtimeHost.newSession();
		expect(runtimeHost.session.mode).toBe("chat");

		await runtimeHost.newSession({ mode: "code" });
		expect(runtimeHost.session.mode).toBe("code");

		await runtimeHost.session.prompt("hello");
		const userMessage = runtimeHost.session.getUserMessagesForForking()[0];
		await runtimeHost.fork(userMessage.entryId, { position: "at" });
		expect(runtimeHost.session.mode).toBe("code");
	});

	it("emits session_before_switch and session_start for new and resume flows", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((metis) => {
			metis.on("session_before_switch", (event) => {
				events.push(event);
			});
			metis.on("session_shutdown", (event) => {
				events.push(event);
			});
			metis.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;
		expect(originalSessionFile).toBeTruthy();

		const newSessionResult = await runtimeHost.newSession();
		expect(newSessionResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		const secondSessionFile = runtimeHost.session.sessionFile;
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "new", targetSessionFile: undefined },
			{ type: "session_shutdown", reason: "new", targetSessionFile: secondSessionFile },
			{ type: "session_start", reason: "new", previousSessionFile: originalSessionFile },
		]);

		events.length = 0;
		expect(secondSessionFile).toBeTruthy();

		const switchResult = await runtimeHost.switchSession(originalSessionFile!);
		expect(switchResult.cancelled).toBe(false);
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_shutdown", reason: "resume", targetSessionFile: originalSessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile: secondSessionFile },
		]);
	});

	it("honors session_before_switch cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		const { runtimeHost } = await createRuntimeHost((metis) => {
			metis.on("session_before_switch", (event) => {
				events.push(event);
				return { cancel: true };
			});
			metis.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const originalSessionFile = runtimeHost.session.sessionFile;

		const result = await runtimeHost.newSession();
		expect(result.cancelled).toBe(true);
		expect(runtimeHost.session.sessionFile).toBe(originalSessionFile);
		expect(events).toEqual([{ type: "session_before_switch", reason: "new", targetSessionFile: undefined }]);
	});

	it("runs beforeSessionInvalidate after session_shutdown and before rebindSession", async () => {
		const phases: string[] = [];
		const { runtimeHost } = await createRuntimeHost((metis) => {
			metis.on("session_shutdown", () => {
				phases.push("session_shutdown");
			});
		});
		const oldSession = runtimeHost.session;
		runtimeHost.setBeforeSessionInvalidate(() => {
			phases.push("beforeSessionInvalidate");
			expect(oldSession.extensionRunner.createContext().cwd).toBe(oldSession.sessionManager.getCwd());
		});
		runtimeHost.setRebindSession(async () => {
			phases.push("rebindSession");
		});

		await runtimeHost.newSession();

		expect(phases).toEqual(["session_shutdown", "beforeSessionInvalidate", "rebindSession"]);
		expect(() => oldSession.extensionRunner.createContext().cwd).toThrow(
			"This extension ctx is stale after session replacement or reload. Do not use a captured metis or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		runtimeHost.setBeforeSessionInvalidate(undefined);
		runtimeHost.setRebindSession(undefined);
	});

	it("emits session_before_fork and session_start and honors cancellation", async () => {
		const events: RecordedSessionEvent[] = [];
		let cancelNextFork = false;
		const { runtimeHost } = await createRuntimeHost((metis) => {
			metis.on("session_before_fork", (event) => {
				events.push(event);
				if (cancelNextFork) {
					cancelNextFork = false;
					return { cancel: true };
				}
			});
			metis.on("session_shutdown", (event) => {
				events.push(event);
			});
			metis.on("session_start", (event) => {
				events.push(event);
			});
		});

		expect(events).toEqual([{ type: "session_start", reason: "startup" }]);
		events.length = 0;

		await runtimeHost.session.prompt("hello");
		const userMessage = runtimeHost.session.getUserMessagesForForking()[0];
		const previousSessionFile = runtimeHost.session.sessionFile;

		const successResult = await runtimeHost.fork(userMessage.entryId);
		expect(successResult.cancelled).toBe(false);
		expect(successResult.selectedText).toBe("hello");
		await runtimeHost.session.bindExtensions({});
		expect(events).toEqual([
			{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" },
			{ type: "session_shutdown", reason: "fork", targetSessionFile: runtimeHost.session.sessionFile },
			{ type: "session_start", reason: "fork", previousSessionFile },
		]);

		events.length = 0;
		cancelNextFork = true;
		const cancelResult = await runtimeHost.fork(userMessage.entryId);
		expect(cancelResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: userMessage.entryId, position: "before" }]);

		events.length = 0;
		cancelNextFork = true;
		const cancelAtResult = await runtimeHost.fork("missing-entry", { position: "at" });
		expect(cancelAtResult).toEqual({ cancelled: true });
		expect(events).toEqual([{ type: "session_before_fork", entryId: "missing-entry", position: "at" }]);
	});
});

function countAcceptedPlanStatusEntries(sessionManager: SessionManager): number {
	const sessionFile = sessionManager.getSessionFile();
	if (!sessionFile) return 0;
	return readFileSync(sessionFile, "utf8")
		.split("\n")
		.filter((line) => line.includes('"type":"session_plan_status"') && line.includes('"status":"accepted"')).length;
}

describe("AgentSessionRuntime plan execution", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) {
			await cleanups.pop()?.();
		}
	});

	async function createPlanRuntime(initialMode: AgentMode = "code", noTools?: "all" | "builtin") {
		const tempDir = join(tmpdir(), `metis-plan-runtime-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });

		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two"), fauxAssistantMessage("three")]);

		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");

		const runtimeOptions = {
			agentDir: tempDir,
			authStorage,
			model: faux.getModel(),
			resourceLoaderOptions: {
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
					},
				],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
			},
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				...runtimeOptions,
				cwd,
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					noTools,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"), { mode: initialMode });
		sessionManager.setPermissionPreset("full");
		const sessionCwd = sessionManager.getCwd();
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: sessionCwd,
			agentDir: tempDir,
			sessionManager,
		});
		await runtime.session.bindExtensions({});

		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		});

		return { runtime, session: runtime.session, faux };
	}

	it("completes a successful plan submission and reopens the durable session with the pending proposal", async () => {
		const { runtime, session, faux } = await createPlanRuntime();
		await session.setCollaborationMode("plan");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("submit_plan", { title: "Plan", markdown: "# Complete plan" })], {
				stopReason: "toolUse",
			}),
		]);
		await runtime.submitPrompt({ requestId: "submit-plan-completed", text: "Make a plan" });
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
		await session.waitForIdle();
		const sessionFile = session.sessionManager.getSessionFile()!;
		const journal = readFileSync(sessionFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(
			journal
				.filter((entry) => entry.type === "runtime_turn" && entry.state !== "started")
				.map((entry) => entry.state),
		).toEqual(["completed"]);
		expect(reduceRuntimeJournal(journal).decisions).toEqual([]);
		await runtime.dispose();
		const reopened = SessionManager.open(sessionFile);
		expect(reopened.getPlanState().currentPlan).toMatchObject({ title: "Plan", status: "proposed" });
		expect(
			reduceRuntimeJournal(
				readFileSync(sessionFile, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line)),
			).decisions,
		).toEqual([]);
		reopened.close();
	});

	it("holds queued turns until the pending Plan is accepted or cancelled", async () => {
		const { runtime, session, faux } = await createPlanRuntime();
		await session.setCollaborationMode("plan");
		faux.setResponses([
			() => {
				runtime.enqueueQueuedTurn({ requestId: "91000000-0000-4000-8000-000000000002", text: "queued next task" });
				return fauxAssistantMessage([fauxToolCall("submit_plan", { title: "Plan", markdown: "# Plan" })], {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("accepted plan executed"),
			fauxAssistantMessage("queued task executed"),
		]);
		await runtime.submitPrompt({ requestId: "plan-before-fifo", text: "Make a plan" });
		await runtime.waitForIdle();
		expect(faux.state.callCount).toBe(1);
		expect(session.sessionManager.getPlanState().currentPlan).toBeDefined();
		expect(runtime.queuedTurns).toHaveLength(1);
		expect(runtime.queuedTurns[0].input.text).toBe("queued next task");
		const proposal = session.sessionManager.getPlanState().currentPlan!;
		await runtime.submitPrompt({
			requestId: "accept-before-fifo",
			text: "Execute",
			planExecution: { planId: proposal.planId, revision: proposal.revision },
		});
		await runtime.waitForIdle();
		expect(faux.state.callCount).toBe(3);
		expect(runtime.queuedTurns).toHaveLength(0);
	});

	it("retains durable steering and follow-up after submission and accepts the plan without recovery", async () => {
		const { runtime, session, faux } = await createPlanRuntime();
		await session.setCollaborationMode("plan");
		faux.setResponses([
			async () => {
				await runtime.submitPrompt({
					requestId: "plan-steer",
					text: "queued steering",
					streamingBehavior: "steer",
				});
				await runtime.submitPrompt({
					requestId: "plan-follow",
					text: "queued follow-up",
					streamingBehavior: "followUp",
				});
				return fauxAssistantMessage([fauxToolCall("submit_plan", { title: "Plan", markdown: "# Plan" })], {
					stopReason: "toolUse",
				});
			},
			fauxAssistantMessage("steering received"),
			fauxAssistantMessage("follow-up received"),
		]);
		await runtime.submitPrompt({ requestId: "plan-with-steering", text: "Make a plan" });
		await runtime.waitForIdle();
		expect(faux.state.callCount).toBe(1);
		const heldState = reduceRuntimeJournal(session.sessionManager.getDurableJournalSnapshot());
		expect(heldState.turns).toMatchObject([{ state: "completed" }]);
		expect(heldState.decisions.some((decision) => decision.type === "interrupt_turn")).toBe(false);
		expect(session.getSteeringMessages()).toEqual(["queued steering"]);
		expect(session.getFollowUpMessages()).toEqual(["queued follow-up"]);
		const proposal = session.sessionManager.getPlanState().currentPlan!;
		await runtime.submitPrompt({
			requestId: "accept-with-steering",
			text: "Execute",
			planExecution: { planId: proposal.planId, revision: proposal.revision },
		});
		await runtime.waitForIdle();
		expect(session.pendingMessageCount).toBe(0);
		expect(faux.state.callCount).toBe(3);
		expect(reduceRuntimeJournal(session.sessionManager.getDurableJournalSnapshot()).decisions).toEqual([]);
	});

	it("opens a legacy interrupted plan submission without losing its actionable proposal", async () => {
		const { runtime, session, faux } = await createPlanRuntime();
		await session.setCollaborationMode("plan");
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("submit_plan", { title: "Legacy plan", markdown: "# Legacy" })], {
				stopReason: "toolUse",
			}),
		]);
		await runtime.submitPrompt({ requestId: "legacy-plan", text: "Make a plan" });
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
		await session.waitForIdle();
		const sessionFile = session.sessionManager.getSessionFile()!;
		const journal = readFileSync(sessionFile, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		for (const entry of journal) {
			if (
				entry.type === "message" &&
				entry.message.role === "toolResult" &&
				entry.message.toolName === "submit_plan"
			)
				delete entry.message.details.turnCompletion;
			if ((entry.type === "runtime_turn" || entry.type === "runtime_operation") && entry.state === "completed")
				entry.state = "interrupted";
		}
		await runtime.dispose();
		const legacyFile = join(dirname(sessionFile), "legacy-plan.jsonl");
		writeFileSync(legacyFile, `${journal.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
		const reopened = SessionManager.open(legacyFile);
		try {
			const proposal = reopened.getPlanState().currentPlan!;
			expect(proposal).toMatchObject({ title: "Legacy plan", status: "proposed" });
			expect(reduceRuntimeJournal(journal).decisions).toEqual([]);
			expect(reopened.cancelPlan({ planId: proposal.planId, revision: proposal.revision }).status).toBe("cancelled");
		} finally {
			reopened.close();
		}
	});

	it("returns a tool error outside Plan and preserves the failed call/result pair for the model", async () => {
		const { runtime, session, faux } = await createPlanRuntime();
		let observed: unknown[] = [];
		faux.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("submit_plan", { title: "Plan", markdown: "# Plan" }, { id: "non-plan-submit" })],
				{ stopReason: "toolUse" },
			),
			(context) => {
				observed = structuredClone(context.messages);
				return fauxAssistantMessage("Please enable Plan mode.");
			},
		]);
		await runtime.submitPrompt({ requestId: "non-plan-submit", text: "Submit" });
		await vi.waitFor(() => expect(faux.state.callCount).toBe(2));
		await session.waitForIdle();
		expect(JSON.stringify(observed)).toContain('"name":"submit_plan"');
		expect(JSON.stringify(observed)).toContain("You are not in Plan mode");
		expect(session.sessionManager.getPlanState().currentPlan).toBeUndefined();
		expect(
			reduceRuntimeJournal(
				readFileSync(session.sessionManager.getSessionFile()!, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line)),
			).decisions,
		).toEqual([]);
	});

	it.each(["all", "builtin"] as const)("does not inject submit_plan through noTools=%s", async (noTools) => {
		const { session } = await createPlanRuntime("code", noTools);
		expect(session.getAllTools().map((tool) => tool.name)).not.toContain("submit_plan");
		const configured = session.getActiveToolNames();
		await session.setCollaborationMode("plan");
		expect(session.getActiveToolNames()).toEqual(configured);
	});

	it("rejects stale Plan execution before provider work", async () => {
		const { runtime, session, faux } = await createPlanRuntime();
		await session.setCollaborationMode("plan");
		const first = session.sessionManager.submitPlan({ title: "First", markdown: "rev1-body" });
		session.sessionManager.submitPlan({ title: "Second", markdown: "rev2-body" });

		await expect(
			runtime.submitPrompt({
				requestId: "request-stale-plan",
				text: "Execute the accepted plan.",
				planExecution: { planId: first.planId, revision: first.revision },
			}),
		).rejects.toThrow(/current proposed revision/iu);
		expect(faux.state.callCount).toBe(0);
	});

	it("accepts the plan, restores Default mode, and injects accepted markdown for one provider call", async () => {
		const observed: Array<{
			toolNames: string[];
			messages: unknown[];
			collaborationMode: string;
		}> = [];
		const { runtime, session, faux } = await createPlanRuntime();
		faux.setResponses([
			(context) => {
				observed.push({
					toolNames: (context.tools ?? []).map((tool) => tool.name),
					messages: structuredClone(context.messages),
					collaborationMode: session.sessionManager.getCollaborationMode(),
				});
				return fauxAssistantMessage("done");
			},
		]);

		await session.setCollaborationMode("plan");
		const plan = session.sessionManager.submitPlan({ title: "Plan", markdown: "accepted-plan-markdown-body" });
		await runtime.submitPrompt({
			requestId: "request-plan-exec",
			text: "Execute the accepted plan.",
			planExecution: { planId: plan.planId, revision: plan.revision },
		});
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
		await session.waitForIdle();

		expect(session.sessionManager.getCollaborationMode()).toBe("default");
		expect(
			session.sessionManager.getPlanState().plans.find((candidate) => candidate.revision === plan.revision)?.status,
		).toBe("accepted");
		expect(observed).toHaveLength(1);
		expect(observed[0].collaborationMode).toBe("default");
		expect(observed[0].toolNames).toContain("edit");
		expect(observed[0].toolNames).toContain("set_tasks");
		expect(observed[0].toolNames).toContain("submit_plan");
		const serialized = JSON.stringify(observed[0].messages);
		expect(serialized).toContain("accepted-plan-markdown-body");
	});

	it("keeps configured Default tools when Plan is active and subagent capabilities resync", async () => {
		const { session } = await createPlanRuntime();
		const configured = session.getConfiguredActiveToolNames();
		expect(configured).toEqual(expect.arrayContaining(["edit", "write", "set_tasks", "submit_plan"]));
		expect(session.getDelegatableToolNames()).not.toContain("submit_plan");

		await session.setCollaborationMode("plan");
		expect(session.getActiveToolNames()).toEqual(configured);
		session.setThinkingSelection(session.getThinkingSelection());
		expect(session.getConfiguredActiveToolNames()).toEqual(configured);

		await session.setCollaborationMode("default");
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["edit", "write", "set_tasks"]));
		expect(session.getActiveToolNames()).toEqual(configured);
		expect(session.getActiveToolNames()).toContain("submit_plan");
	});

	it("does not inject plan context on the next ordinary Default prompt", async () => {
		const observed: unknown[][] = [];
		const { runtime, session, faux } = await createPlanRuntime();
		faux.setResponses([
			(context) => {
				observed.push(structuredClone(context.messages));
				return fauxAssistantMessage("one");
			},
			(context) => {
				observed.push(structuredClone(context.messages));
				return fauxAssistantMessage("two");
			},
		]);

		await session.setCollaborationMode("plan");
		const plan = session.sessionManager.submitPlan({ title: "Plan", markdown: "execution-markdown-only" });
		await runtime.submitPrompt({
			requestId: "request-plan-first",
			text: "Execute",
			planExecution: { planId: plan.planId, revision: plan.revision },
		});
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
		await session.waitForIdle();

		await runtime.submitPrompt({ requestId: "request-plan-second", text: "follow up" });
		await vi.waitFor(() => expect(faux.state.callCount).toBe(2));
		await session.waitForIdle();

		expect(JSON.stringify(observed[1])).not.toContain("metis_plan_context");
		expect(JSON.stringify(observed[1])).not.toContain('"name":"submit_plan"');
	});

	it("replays the same request ID without duplicate acceptance status records", async () => {
		const { runtime, session, faux } = await createPlanRuntime();
		await session.setCollaborationMode("plan");
		const plan = session.sessionManager.submitPlan({ title: "Plan", markdown: "replay-body" });
		const submission = {
			requestId: "request-plan-replay",
			text: "Execute",
			planExecution: { planId: plan.planId, revision: plan.revision },
		};
		await runtime.submitPrompt(submission);
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
		await session.waitForIdle();
		const statusCountAfterFirst = countAcceptedPlanStatusEntries(session.sessionManager);

		const replay = await runtime.submitPrompt(submission);
		expect(replay.status).toBe("existing");
		expect(countAcceptedPlanStatusEntries(session.sessionManager)).toBe(statusCountAfterFirst);
		expect(statusCountAfterFirst).toBe(1);
	});

	it("replays an already accepted Plan revision without a duplicate status record", async () => {
		const { runtime, session, faux } = await createPlanRuntime();
		await session.setCollaborationMode("plan");
		const plan = session.sessionManager.submitPlan({ title: "Plan", markdown: "recovery-body" });
		session.sessionManager.acceptPlan({ planId: plan.planId, revision: plan.revision });

		await runtime.submitPrompt({
			requestId: "request-plan-recovery",
			text: "Execute the accepted plan.",
			planExecution: { planId: plan.planId, revision: plan.revision },
		});
		await vi.waitFor(() => expect(faux.state.callCount).toBe(1));
		await session.waitForIdle();

		expect(countAcceptedPlanStatusEntries(session.sessionManager)).toBe(1);
		expect(session.sessionManager.getCollaborationMode()).toBe("default");
	});
});
