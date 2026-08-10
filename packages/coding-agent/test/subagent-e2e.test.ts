import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@metis/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { getSessionSubagentDir, SessionManager } from "../src/core/session-manager.ts";
import { buildChildSystemPrompt } from "../src/core/subagents/prompts.ts";
import { SUBAGENT_ACTIVATION_TOOL_NAME, SUBAGENT_TOOL_NAMES } from "../src/core/subagents/types.ts";
import type { ExtensionAPI, ExtensionFactory } from "../src/index.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

async function createActivatedSubagentHarness() {
	const root = mkdtempSync(join(tmpdir(), "metis-subagent-continuation-"));
	roots.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	mkdirSync(agentDir);
	const parentProviderContexts: string[] = [];
	const faux = registerFauxProvider({ models: [{ id: "faux-reasoning", reasoning: true }] });
	const authStorage = AuthStorage.inMemory();
	authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
	const extensionFactory: ExtensionFactory = (metis: ExtensionAPI) => {
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
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
		const services = await createAgentSessionServices({
			cwd: options.cwd,
			agentDir,
			authStorage,
			resourceLoaderOptions: {
				extensionFactories: [extensionFactory],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				...(options.childConfig
					? { systemPromptOverride: () => undefined, appendSystemPromptOverride: () => [] }
					: {}),
			},
		});
		const child = options.childConfig;
		const model = child
			? services.modelRegistry.find(child.model.provider, child.model.modelId)
			: services.modelRegistry.find(faux.getModel().provider, faux.getModel().id);
		if (!model) throw new Error("Missing faux model");
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: options.sessionManager,
			sessionStartEvent: options.sessionStartEvent,
			model,
			ultraAvailable: options.ultraAvailable,
			...(child
				? {
						thinkingLevel: child.thinkingLevel,
						tools: [...child.tools],
						additionalSystemPrompt: buildChildSystemPrompt(child),
						includeAutoMemory: false,
						permissionModeCeiling: options.permissionModeCeiling,
					}
				: {}),
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd,
		agentDir,
		sessionManager: SessionManager.create(cwd, join(root, "sessions"), {
			id: `parent-${Date.now()}`,
			mode: "code",
			permissionMode: "full",
		}),
	});
	runtime.session.setThinkingSelection("ultra");
	await runtime.session
		.getToolDefinition(SUBAGENT_ACTIVATION_TOOL_NAME)!
		.execute("activate", {}, undefined, undefined, {} as never);
	const manager = runtime.subagentManager!;
	return {
		root,
		faux,
		runtime,
		manager,
		parentProviderContexts,
		async dispose() {
			try {
				await runtime.dispose();
			} finally {
				faux.unregister();
				const index = roots.indexOf(root);
				if (index >= 0) roots.splice(index, 1);
				rmSync(root, { recursive: true, force: true });
			}
		},
	};
}

describe("Ultra subagent end to end", () => {
	it("activates orchestration, runs and resumes one durable child, then deletes it", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-subagent-e2e-"));
		roots.push(root);
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		const providerOptions: unknown[] = [];
		const parentProviderContexts: Array<{ tools: string[]; systemPrompt: string }> = [];
		const faux = registerFauxProvider({ models: [{ id: "faux-reasoning", reasoning: true }] });
		faux.setResponses([
			(context, options) => {
				providerOptions.push(options);
				parentProviderContexts.push({
					tools: (context.tools ?? []).map((tool) => tool.name),
					systemPrompt: context.systemPrompt ?? "",
				});
				return fauxAssistantMessage(fauxToolCall(SUBAGENT_ACTIVATION_TOOL_NAME, {}), { stopReason: "toolUse" });
			},
			(context, options) => {
				providerOptions.push(options);
				parentProviderContexts.push({
					tools: (context.tools ?? []).map((tool) => tool.name),
					systemPrompt: context.systemPrompt ?? "",
				});
				return fauxAssistantMessage("subagents activated");
			},
			(_context, options) => {
				providerOptions.push(options);
				return fauxAssistantMessage("first durable handoff");
			},
			(_context, options) => {
				providerOptions.push(options);
				return fauxAssistantMessage("first result integrated");
			},
			(_context, options) => {
				providerOptions.push(options);
				return fauxAssistantMessage("follow-up handoff");
			},
			(_context, options) => {
				providerOptions.push(options);
				return fauxAssistantMessage("follow-up result integrated");
			},
		]);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const extensionFactory: ExtensionFactory = (metis: ExtensionAPI) => {
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
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async (options) => {
			if (options.childConfig && !options.permissionModeCeiling) {
				throw new Error("Child runtime is missing its permission ceiling");
			}
			const services = await createAgentSessionServices({
				cwd: options.cwd,
				agentDir,
				authStorage,
				resourceLoaderOptions: {
					extensionFactories: [extensionFactory],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					...(options.childConfig
						? { systemPromptOverride: () => undefined, appendSystemPromptOverride: () => [] }
						: {}),
				},
			});
			const child = options.childConfig;
			const model = child
				? services.modelRegistry.find(child.model.provider, child.model.modelId)
				: services.modelRegistry.find(faux.getModel().provider, faux.getModel().id);
			if (!model) throw new Error("Missing faux model");
			const created = await createAgentSessionFromServices({
				services,
				sessionManager: options.sessionManager,
				sessionStartEvent: options.sessionStartEvent,
				model,
				ultraAvailable: options.ultraAvailable,
				...(child
					? {
							thinkingLevel: child.thinkingLevel,
							tools: [...child.tools],
							additionalSystemPrompt: buildChildSystemPrompt(child),
							includeAutoMemory: false,
							permissionModeCeiling: options.permissionModeCeiling,
						}
					: {}),
			});
			return { ...created, services, diagnostics: services.diagnostics };
		};
		const parentManager = SessionManager.create(cwd, join(root, "sessions"), {
			id: "parent-e2e-1",
			mode: "code",
			permissionMode: "full",
		});
		const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: parentManager });
		let runtimeDisposed = false;
		try {
			expect(runtime.session.getActiveToolNames()).not.toEqual(expect.arrayContaining([...SUBAGENT_TOOL_NAMES]));
			expect(runtime.session.getActiveToolNames()).not.toContain(SUBAGENT_ACTIVATION_TOOL_NAME);
			expect(runtime.session.getActiveToolNames()).not.toContain("wait_agents");
			expect(runtime.session.systemPrompt).not.toContain("<subagent_coordination>");

			runtime.session.setThinkingSelection("ultra");
			expect(runtime.session.getThinkingSelection()).toBe("ultra");
			expect(runtime.session.getActiveToolNames()).toContain(SUBAGENT_ACTIVATION_TOOL_NAME);
			expect(runtime.session.getActiveToolNames()).not.toEqual(expect.arrayContaining([...SUBAGENT_TOOL_NAMES]));
			expect(runtime.session.getActiveToolNames()).not.toContain("wait_agents");
			expect(runtime.session.systemPrompt).not.toContain("<subagent_coordination>");

			await runtime.session.prompt("Delegate the independent inspection work");

			expect(parentProviderContexts).toHaveLength(2);
			expect(parentProviderContexts[0]!.tools).toContain(SUBAGENT_ACTIVATION_TOOL_NAME);
			expect(parentProviderContexts[0]!.tools).not.toEqual(expect.arrayContaining([...SUBAGENT_TOOL_NAMES]));
			expect(parentProviderContexts[0]!.tools).not.toContain("wait_agents");
			expect(parentProviderContexts[0]!.systemPrompt).not.toContain("<subagent_coordination>");
			expect(parentProviderContexts[1]!.tools).not.toContain(SUBAGENT_ACTIVATION_TOOL_NAME);
			expect(parentProviderContexts[1]!.tools).toEqual(expect.arrayContaining([...SUBAGENT_TOOL_NAMES]));
			expect(parentProviderContexts[1]!.systemPrompt).toContain("<subagent_coordination>");
			expect(parentProviderContexts[1]!.systemPrompt).toContain(
				"While background work runs, continue other useful work.",
			);
			expect(parentProviderContexts[1]!.tools).not.toContain("wait_agents");
			expect(runtime.session.getActiveToolNames()).toEqual(expect.arrayContaining([...SUBAGENT_TOOL_NAMES]));
			expect(runtime.session.systemPrompt).toContain("<subagent_coordination>");
			runtime.session.refreshSystemPrompt();
			expect(runtime.session.systemPrompt).toContain("<subagent_coordination>");

			const activationTool = runtime.session.getToolDefinition(SUBAGENT_ACTIVATION_TOOL_NAME)!;
			await expect(activationTool.execute("repeat", {}, undefined, undefined, {} as never)).resolves.toMatchObject({
				details: { activated: true, alreadyActivated: true },
			});
			const manager = runtime.subagentManager!;
			const spawned = await manager.spawn({
				name: "researcher",
				task: "Inspect the durable runtime",
				tools: ["read"],
				background: true,
				forkTurns: 1,
			});
			await vi.waitFor(() => expect(manager.listSummaries()[0]?.status).toBe("done"));
			expect(manager.listSummaries()[0]).toMatchObject({
				agentId: spawned.agentId,
				status: "done",
				finalSummary: "first durable handoff",
			});
			const inspected = await manager.inspect({ agentId: spawned.agentId, limit: 20 });
			expect(inspected.journal?.map((entry) => entry.type)).toEqual(Array(6).fill("message"));
			expect(inspected.usage.output).toBeGreaterThan(0);
			await vi.waitFor(() => expect(runtime.session.getPendingSubagentMailboxEventIds()).toEqual([]));

			runtime.session.setThinkingSelection("high");
			expect(
				runtime.session.getActiveToolNames().filter((name) => SUBAGENT_TOOL_NAMES.includes(name as never)),
			).toEqual(["inspect_agents", "interrupt_agent", "close_agent"]);
			expect(runtime.session.getActiveToolNames()).not.toContain("wait_agents");
			expect(runtime.session.getActiveToolNames()).not.toContain(SUBAGENT_ACTIVATION_TOOL_NAME);
			expect(runtime.session.systemPrompt).not.toContain("<subagent_coordination>");
			const cleanupTools = runtime.session.getActiveToolNames();
			await expect(activationTool.execute("stale", {}, undefined, undefined, {} as never)).rejects.toThrow(
				"Ultra is required",
			);
			expect(runtime.session.getActiveToolNames()).toEqual(cleanupTools);
			expect(runtime.session.systemPrompt).not.toContain("<subagent_coordination>");

			runtime.session.setThinkingSelection("ultra");
			expect(runtime.session.getActiveToolNames()).toEqual(
				expect.arrayContaining([SUBAGENT_ACTIVATION_TOOL_NAME, "inspect_agents", "interrupt_agent", "close_agent"]),
			);
			expect(runtime.session.getActiveToolNames()).not.toContain("wait_agents");
			expect(runtime.session.getActiveToolNames()).not.toContain("spawn_agent");
			expect(runtime.session.getActiveToolNames()).not.toContain("message_agent");
			expect(runtime.session.systemPrompt).not.toContain("<subagent_coordination>");

			await activationTool.execute("reactivate", {}, undefined, undefined, {} as never);
			expect(runtime.session.getActiveToolNames()).toEqual(expect.arrayContaining([...SUBAGENT_TOOL_NAMES]));
			expect(runtime.session.systemPrompt).toContain("<subagent_coordination>");
			await manager.message({
				agentId: spawned.agentId,
				mode: "follow_up",
				message: "Verify the follow-up",
				background: true,
			});
			await vi.waitFor(() => expect(manager.listSummaries()[0]?.finalSummary).toBe("follow-up handoff"));
			await vi.waitFor(() => expect(runtime.session.getPendingSubagentMailboxEventIds()).toEqual([]));
			expect(manager.listSummaries()[0]?.agentId).toBe(spawned.agentId);

			const childDirectory = getSessionSubagentDir(agentDir, parentManager.getSessionId());
			const childFile = readdirSync(childDirectory).find((name) => name.endsWith(".jsonl"));
			const childPath = childFile ? join(childDirectory, childFile) : undefined;
			expect(childPath && existsSync(childPath)).toBe(true);
			await expect(manager.close(spawned.agentId)).resolves.toMatchObject({ status: "closed" });
			expect(childPath && existsSync(childPath)).toBe(false);
			expect(manager.listSummaries()).toMatchObject([{ agentId: spawned.agentId, status: "closed" }]);
			runtime.session.setThinkingSelection("high");
			expect(runtime.session.getActiveToolNames().some((name) => SUBAGENT_TOOL_NAMES.includes(name as never))).toBe(
				false,
			);
			expect(runtime.session.getActiveToolNames()).not.toContain("wait_agents");
			expect(JSON.stringify(providerOptions)).not.toContain("ultra");
			expect(
				parentManager.getDurableJournalSnapshot().some((entry) => entry.type === "subagent_mailbox_event"),
			).toBe(true);

			const scheduledProviderTools: string[][] = [];
			faux.setResponses([
				(context) => {
					scheduledProviderTools.push((context.tools ?? []).map((tool) => tool.name));
					return fauxAssistantMessage("scheduled complete");
				},
			]);
			const scheduledRuntime = await createAgentSessionRuntime(createRuntime, {
				cwd,
				agentDir,
				sessionManager: SessionManager.create(cwd, join(root, "scheduled-sessions"), {
					id: "scheduled-parent-e2e",
					mode: "code",
					permissionMode: "full",
					scheduled: { taskId: "task-1", runId: "run-1" },
				}),
			});
			try {
				expect(scheduledRuntime.subagentManager).toBeUndefined();
				scheduledRuntime.session.setThinkingSelection("ultra");
				expect(scheduledRuntime.session.getActiveToolNames()).not.toContain(SUBAGENT_ACTIVATION_TOOL_NAME);
				expect(scheduledRuntime.session.getActiveToolNames()).not.toEqual(
					expect.arrayContaining([...SUBAGENT_TOOL_NAMES]),
				);
				expect(scheduledRuntime.session.getActiveToolNames()).not.toContain("wait_agents");
				await scheduledRuntime.session.prompt("Run the scheduled task directly");
				expect(scheduledProviderTools).toHaveLength(1);
				expect(scheduledProviderTools[0]).not.toEqual(expect.arrayContaining([...SUBAGENT_TOOL_NAMES]));
				expect(scheduledProviderTools[0]).not.toContain(SUBAGENT_ACTIVATION_TOOL_NAME);
				expect(scheduledProviderTools[0]).not.toContain("wait_agents");
			} finally {
				await scheduledRuntime.dispose();
			}

			runtime.session.setThinkingSelection("ultra");
			await activationTool.execute("activate-before-reopen", {}, undefined, undefined, {} as never);
			const parentSessionPath = runtime.session.sessionManager.getSessionFile()!;
			await runtime.dispose();
			runtimeDisposed = true;

			const reopened = await createAgentSessionRuntime(createRuntime, {
				cwd,
				agentDir,
				sessionManager: SessionManager.open(parentSessionPath),
			});
			try {
				expect(reopened.session.getThinkingSelection()).toBe("ultra");
				expect(reopened.session.getActiveToolNames()).toContain(SUBAGENT_ACTIVATION_TOOL_NAME);
				expect(reopened.session.getActiveToolNames()).not.toEqual(expect.arrayContaining([...SUBAGENT_TOOL_NAMES]));
				expect(reopened.session.getActiveToolNames()).not.toContain("wait_agents");
				expect(reopened.session.systemPrompt).not.toContain("<subagent_coordination>");
			} finally {
				await reopened.dispose();
			}
		} finally {
			if (!runtimeDisposed) await runtime.dispose();
			faux.unregister();
		}
	});

	it("automatically resumes once for coalesced background completions", async () => {
		const harness = await createActivatedSubagentHarness();
		try {
			const parentReply = deferred<ReturnType<typeof fauxAssistantMessage>>();
			const firstReply = deferred<ReturnType<typeof fauxAssistantMessage>>();
			const secondReply = deferred<ReturnType<typeof fauxAssistantMessage>>();
			let inFlightContext = "";
			let childStarts = 0;
			harness.faux.setResponses([
				(context) => {
					inFlightContext = JSON.stringify(context);
					return parentReply.promise;
				},
				() => {
					childStarts += 1;
					return firstReply.promise;
				},
				() => {
					childStarts += 1;
					return secondReply.promise;
				},
				(context) => {
					harness.parentProviderContexts.push(JSON.stringify(context));
					return fauxAssistantMessage("integrated both results");
				},
			]);

			await harness.runtime.submitPrompt({ requestId: "busy-parent", text: "continue parent work" });
			await vi.waitFor(() => expect(inFlightContext).not.toBe(""));
			const first = await harness.manager.spawn({
				name: "first",
				task: "first task",
				tools: ["read"],
				background: true,
			});
			const second = await harness.manager.spawn({
				name: "second",
				task: "second task",
				tools: ["read"],
				background: true,
			});
			await vi.waitFor(() => expect(childStarts).toBe(2));

			firstReply.resolve(fauxAssistantMessage("first result"));
			secondReply.resolve(fauxAssistantMessage("second result"));
			await vi.waitFor(() => expect(harness.runtime.session.getPendingSubagentMailboxEventIds()).toHaveLength(2));
			expect(inFlightContext).not.toContain(first.runId);
			expect(inFlightContext).not.toContain(second.runId);

			parentReply.resolve(fauxAssistantMessage("parent finished its independent work"));
			await vi.waitFor(() => expect(harness.parentProviderContexts).toHaveLength(1));
			await harness.runtime.session.waitForIdle();
			const continuation = harness.parentProviderContexts[0]!;
			expect(continuation).toContain(first.runId);
			expect(continuation).toContain(second.runId);
			expect(harness.runtime.session.getPendingSubagentMailboxEventIds()).toEqual([]);
		} finally {
			await harness.dispose();
		}
	});

	it("lets a user turn consume the mailbox before the scheduled continuation", async () => {
		const harness = await createActivatedSubagentHarness();
		const childReply = deferred<ReturnType<typeof fauxAssistantMessage>>();
		const continuationGate = deferred<void>();
		let childStarted = false;
		let immediateSpy: ReturnType<typeof vi.spyOn> | undefined;
		try {
			harness.faux.setResponses([
				() => {
					childStarted = true;
					return childReply.promise;
				},
				(context) => {
					harness.parentProviderContexts.push(JSON.stringify(context));
					return fauxAssistantMessage("user turn integrated the result");
				},
			]);
			const child = await harness.manager.spawn({
				name: "user-race",
				task: "finish in the background",
				tools: ["read"],
				background: true,
			});
			await vi.waitFor(() => expect(childStarted).toBe(true));
			immediateSpy = vi.spyOn(global, "setImmediate").mockImplementationOnce(((callback: () => void) => {
				void continuationGate.promise.then(callback);
				return {} as NodeJS.Immediate;
			}) as typeof setImmediate);
			childReply.resolve(fauxAssistantMessage("background result"));
			await vi.waitFor(() => expect(harness.runtime.session.getPendingSubagentMailboxEventIds()).toHaveLength(1));

			await harness.runtime.session.prompt("continue with my update");
			continuationGate.resolve();
			await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
			await harness.runtime.session.waitForIdle();
			expect(harness.parentProviderContexts[0]).toContain(child.runId);
			expect(harness.parentProviderContexts).toHaveLength(1);
			expect(harness.runtime.session.getPendingSubagentMailboxEventIds()).toEqual([]);
		} finally {
			immediateSpy?.mockRestore();
			await harness.dispose();
		}
	});

	it("does not loop after an automatic continuation persistence failure", async () => {
		const harness = await createActivatedSubagentHarness();
		const childReply = deferred<ReturnType<typeof fauxAssistantMessage>>();
		let childStarted = false;
		const appendMessage = harness.runtime.session.sessionManager.appendMessage.bind(
			harness.runtime.session.sessionManager,
		);
		let appendSpy: ReturnType<typeof vi.spyOn> | undefined;
		try {
			harness.faux.setResponses([
				() => {
					childStarted = true;
					return childReply.promise;
				},
				(context) => {
					harness.parentProviderContexts.push(JSON.stringify(context));
					return fauxAssistantMessage("continuation response");
				},
			]);
			await harness.manager.spawn({
				name: "failure",
				task: "finish in the background",
				tools: ["read"],
				background: true,
			});
			await vi.waitFor(() => expect(childStarted).toBe(true));
			appendSpy = vi
				.spyOn(harness.runtime.session.sessionManager, "appendMessage")
				.mockImplementation((message, toolOutput, turnId) => {
					if (message.role === "assistant") throw new Error("assistant persistence failed");
					return appendMessage(message, toolOutput, turnId);
				});
			vi.useFakeTimers({ toFake: ["setImmediate"] });
			childReply.resolve(fauxAssistantMessage("background result"));
			await vi.waitFor(() => expect(harness.runtime.session.getPendingSubagentMailboxEventIds()).toHaveLength(1));
			await vi.runAllTimersAsync();
			await vi.waitFor(() =>
				expect(
					harness.runtime.diagnostics.some((item) =>
						item.message.includes("Automatic subagent continuation failed"),
					),
				).toBe(true),
			);
			await vi.runAllTimersAsync();
			expect(harness.parentProviderContexts).toHaveLength(1);
			expect(harness.runtime.session.getPendingSubagentMailboxEventIds()).toHaveLength(1);
		} finally {
			appendSpy?.mockRestore();
			vi.useRealTimers();
			await expect(harness.dispose()).rejects.toThrow("assistant persistence failed");
		}
	});

	it("delivers a background result after leaving Ultra", async () => {
		const harness = await createActivatedSubagentHarness();
		const childReply = deferred<ReturnType<typeof fauxAssistantMessage>>();
		let childStarted = false;
		try {
			harness.faux.setResponses([
				() => {
					childStarted = true;
					return childReply.promise;
				},
				(context) => {
					harness.parentProviderContexts.push(JSON.stringify(context));
					return fauxAssistantMessage("integrated after Ultra");
				},
			]);
			const child = await harness.manager.spawn({
				name: "ultra-exit",
				task: "finish after the mode changes",
				tools: ["read"],
				background: true,
			});
			await vi.waitFor(() => expect(childStarted).toBe(true));
			harness.runtime.session.setThinkingSelection("high");
			childReply.resolve(fauxAssistantMessage("result after Ultra"));
			await vi.waitFor(() => expect(harness.parentProviderContexts).toHaveLength(1));
			await harness.runtime.session.waitForIdle();
			expect(harness.parentProviderContexts[0]).toContain(child.runId);
			expect(harness.runtime.session.getPendingSubagentMailboxEventIds()).toEqual([]);
		} finally {
			await harness.dispose();
		}
	});

	it("does not start a continuation during teardown", async () => {
		const harness = await createActivatedSubagentHarness();
		const childReply = deferred<ReturnType<typeof fauxAssistantMessage>>();
		let childStarted = false;
		try {
			harness.faux.setResponses([
				() => {
					childStarted = true;
					return childReply.promise;
				},
			]);
			await harness.manager.spawn({
				name: "teardown",
				task: "finish during teardown",
				tools: ["read"],
				background: true,
			});
			await vi.waitFor(() => expect(childStarted).toBe(true));
			const disposal = harness.runtime.dispose();
			childReply.resolve(fauxAssistantMessage("late result"));
			await disposal;
			await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
			expect(harness.parentProviderContexts).toHaveLength(0);
		} finally {
			await harness.dispose();
		}
	});
});
