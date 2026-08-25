import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@metis/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMode } from "../src/core/agent-mode.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
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

	async function createPlanRuntime(initialMode: AgentMode = "code") {
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
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const sessionManager = SessionManager.create(tempDir, join(tempDir, "sessions"), { mode: initialMode });
		sessionManager.setPermissionSettings({ mode: "full" });
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
		expect(observed[0].toolNames).not.toContain("submit_plan");
		const serialized = JSON.stringify(observed[0].messages);
		expect(serialized).toContain("accepted-plan-markdown-body");
	});

	it("keeps configured Default tools when Plan is active and subagent capabilities resync", async () => {
		const { session } = await createPlanRuntime();
		const configured = session.getConfiguredActiveToolNames();
		expect(configured).toEqual(expect.arrayContaining(["edit", "write", "set_tasks"]));

		await session.setCollaborationMode("plan");
		expect(session.getActiveToolNames()).not.toContain("write");
		session.setThinkingSelection(session.getThinkingSelection());
		expect(session.getConfiguredActiveToolNames()).toEqual(configured);

		await session.setCollaborationMode("default");
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["edit", "write", "set_tasks"]));
		expect(session.getActiveToolNames()).not.toContain("submit_plan");
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
});
