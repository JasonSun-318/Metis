import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, getModel, registerFauxProvider } from "@metis/ai/compat";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { type CreateAgentSessionRuntimeFactory, createAgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SubagentManager } from "../src/core/subagents/manager.ts";
import { buildChildSystemPrompt } from "../src/core/subagents/prompts.ts";
import { SubagentScheduler } from "../src/core/subagents/scheduler.ts";
import { createSubagentTools } from "../src/core/subagents/tools.ts";
import type { AgentMailboxTerminalEvent } from "../src/core/subagents/types.ts";
import type { ExtensionAPI } from "../src/index.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

const ROOT_ID = "parent-session-1";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

class FakeChildSession {
	readonly messages: unknown[] = [];
	readonly model = getModel("anthropic", "claude-sonnet-4-5")!;
	readonly sessionManager: SessionManager;
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

	constructor(sessionManager: SessionManager, activeTools: readonly string[]) {
		this.session = new FakeChildSession(sessionManager, activeTools);
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
		this.session.sessionManager.close();
		this.disposed = true;
	}
}

function setupHarness() {
	const root = mkdtempSync(join(tmpdir(), "metis-agent-e2e-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	const parentManager = SessionManager.create(cwd, join(root, "sessions"), {
		id: ROOT_ID,
		mode: "code",
		permissionMode: "full",
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
				provider === model.provider && modelId === model.id ? model : undefined,
			hasConfiguredAuth: () => true,
		},
		getActiveToolNames: () => ["read", "bash", "grep", "find", "ls", "web_fetch", "web_search"],
		getDelegatableToolNames: () => ["read", "bash", "grep", "find", "ls", "web_fetch", "web_search"],
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
		stageAgentMailboxDelivery: (eventIds: readonly string[]) => {
			for (const eventId of eventIds) pendingMailbox.delete(eventId);
			return eventIds;
		},
	} as unknown as AgentSession;
	const runtimes: FakeChildRuntime[] = [];
	let sequence = 0;
	const manager = new SubagentManager({
		parentSessionManager: parentManager,
		agentDir,
		getWorkspaceRoots: () => parentManager.getWorkspaceRoots(),
		scheduler: new SubagentScheduler(4, 4),
		createId: () => `child-session-${++sequence}`,
		createChildRuntime: async (input) => {
			const runtime = new FakeChildRuntime(input.sessionManager, input.config.tools);
			runtimes.push(runtime);
			return runtime as unknown as AgentSessionRuntime;
		},
	});
	manager.attachActor(parent);
	const tools = createSubagentTools({ getManager: () => manager, getSession: () => parent });
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
	return { manager, tools, runtimes };
}

async function executeTool(tool: ReturnType<typeof createSubagentTools>[number], params: Record<string, unknown>) {
	return tool.execute("call", params, undefined, undefined, {} as never);
}

describe("agent system e2e", () => {
	it("runs the persisted root and default child through the real runtime and faux provider", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-agent-real-e2e-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd);
		mkdirSync(agentDir);
		const secretPath = join(cwd, "secret.txt");
		writeFileSync(secretPath, "TOP SECRET TOOL OUTPUT");
		const faux = registerFauxProvider();
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path: secretPath })], { stopReason: "toolUse" }),
			fauxAssistantMessage(
				[
					{ type: "thinking", thinking: "hidden child reasoning" },
					{ type: "text", text: "first child handoff" },
				],
				{ stopReason: "stop" },
			),
			fauxAssistantMessage("parent integrated first handoff"),
			fauxAssistantMessage("second child handoff"),
			fauxAssistantMessage("parent integrated second handoff"),
		]);
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({
			cwd: runtimeCwd,
			sessionManager,
			sessionStartEvent,
			childConfig,
			permissionModeCeiling,
			ultraAvailable,
		}) => {
			const authStorage = AuthStorage.inMemory();
			authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
			const services = await createAgentSessionServices({
				cwd: runtimeCwd,
				agentDir,
				authStorage,
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
			});
			const created = await createAgentSessionFromServices({
				services,
				sessionManager,
				sessionStartEvent,
				model: faux.getModel(),
				thinkingLevel: childConfig?.thinkingLevel ?? "high",
				tools: childConfig ? [...childConfig.tools] : ["read"],
				excludeTools: childConfig?.writePolicy === "deny" ? ["edit", "write"] : undefined,
				additionalSystemPrompt: childConfig ? buildChildSystemPrompt(childConfig) : undefined,
				workspaceWritePolicy: childConfig?.writePolicy,
				permissionModeCeiling,
				ultraAvailable,
			});
			return { ...created, services, diagnostics: services.diagnostics };
		};
		const rootManager = SessionManager.create(cwd, join(root, "sessions"), {
			id: ROOT_ID,
			mode: "code",
			permissionMode: "full",
		});
		const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: rootManager });
		cleanups.push(async () => {
			await runtime.dispose();
			faux.unregister();
			rmSync(root, { recursive: true, force: true });
		});
		for (const selection of runtime.session.getAvailableThinkingSelections()) {
			runtime.session.setThinkingSelection(selection);
			expect(runtime.session.getActiveToolNames()).toEqual(
				expect.arrayContaining([
					"spawn_agent",
					"inspect_agents",
					"send_message",
					"followup_task",
					"wait_agents",
					"interrupt_agent",
				]),
			);
		}
		expect(runtime.session.getAvailableThinkingSelections()).toContain("ultra");

		const run = (name: string, params: Record<string, unknown>) =>
			runtime.session.getToolDefinition(name)!.execute("call", params, undefined, undefined, {} as never);
		const spawned = await run("spawn_agent", {
			name: "real worker",
			task: "Return a concise verified handoff",
			agentType: "default",
		});
		expect(spawned.details).toMatchObject({
			tools: [
				"read",
				"spawn_agent",
				"inspect_agents",
				"send_message",
				"followup_task",
				"wait_agents",
				"interrupt_agent",
			],
			writePolicy: "inherit",
			mayDelegate: true,
		});
		const receipt = spawned.details as { agentId: string; taskId: string };
		const waited = await run("wait_agents", { agentIds: [receipt.agentId], timeoutMs: 5_000 });
		expect(waited.details).toMatchObject({
			timedOut: false,
			agents: [{ agentId: receipt.agentId, status: "done" }],
		});
		const inspected = await run("inspect_agents", { agentId: receipt.agentId });
		const safeTrace = inspected.content.find((block) => block.type === "text")?.text ?? "";
		expect(safeTrace).toContain("[Tool success] read");
		expect(safeTrace).toContain("[Final]");
		expect(safeTrace).not.toContain(secretPath);
		expect(safeTrace).not.toContain("TOP SECRET TOOL OUTPUT");
		expect(safeTrace).not.toContain("hidden child reasoning");

		const followed = await run("followup_task", {
			agentId: receipt.agentId,
			task: "Return one more concise handoff",
		});
		const followupReceipt = followed.details as { taskId: string };
		await vi.waitFor(
			() =>
				expect(runtime.subagentManager?.listSummaries(ROOT_ID, true)[0]?.latestTask).toMatchObject({
					taskId: followupReceipt.taskId,
					status: "done",
				}),
			{ timeout: 5_000 },
		);
	});

	it("runs spawn → mailbox → inspect → follow-up → wait → interrupt through the six tools", async () => {
		const { manager, tools, runtimes } = setupHarness();
		const spawn = tools.find((tool) => tool.name === "spawn_agent")!;
		const spawnResult = await executeTool(spawn, {
			name: "researcher",
			task: "Inspect the module boundary",
			agentType: "explorer",
		});
		expect(spawnResult.details).toMatchObject({
			agentType: "explorer",
			tools: ["read", "grep", "find", "ls", "web_fetch", "web_search"],
			writePolicy: "deny",
			mayDelegate: false,
		});
		const created = spawnResult.details as { agentId: string; taskId: string };
		await vi.waitFor(() => expect(runtimes).toHaveLength(1));
		const send = tools.find((tool) => tool.name === "send_message")!;
		await executeTool(send, { agentId: created.agentId, message: "Focus on the exported boundary" });
		runtimes[0]!.session.settle("verified boundary");
		await vi.waitFor(() => expect(manager.listSummaries(ROOT_ID)[0]?.status).toBe("done"));

		const wait = tools.find((tool) => tool.name === "wait_agents")!;
		const waitResult = await executeTool(wait, { agentIds: [created.agentId] });
		expect(waitResult.details).toMatchObject({
			timedOut: false,
			agents: [{ agentId: created.agentId, status: "done" }],
			mailboxEventIds: [`agent:${created.agentId}:${created.taskId}:terminal`],
		});

		const inspect = tools.find((tool) => tool.name === "inspect_agents")!;
		const inspectResult = await executeTool(inspect, {});
		expect(inspectResult.content.find((block) => block.type === "text")?.text ?? "").toContain("researcher");
		expect(inspectResult.details).toMatchObject({
			agents: [
				{
					agentType: "explorer",
					tools: ["read", "grep", "find", "ls", "web_fetch", "web_search"],
					writePolicy: "deny",
					mayDelegate: false,
				},
			],
		});

		const followUp = tools.find((tool) => tool.name === "followup_task")!;
		await executeTool(followUp, { agentId: created.agentId, task: "Check the edge case" });
		await vi.waitFor(() => expect(runtimes).toHaveLength(2));
		runtimes[1]!.session.settle("edge case covered");
		await vi.waitFor(() =>
			expect(manager.listSummaries(ROOT_ID)[0]?.latestTask?.finalMessage).toBe("edge case covered"),
		);

		await manager.followUpTask(ROOT_ID, { agentId: created.agentId, task: "will be stopped" });
		const interrupt = tools.find((tool) => tool.name === "interrupt_agent")!;
		const interruptResult = await executeTool(interrupt, { agentId: created.agentId });
		expect(interruptResult.details).toMatchObject({ status: "stopped" });
		expect(
			manager.listTasks(created.agentId).every((task) => task.status === "stopped" || task.status === "done"),
		).toBe(true);
	});

	it("exposes all six orchestration tools to the parent session", () => {
		const { tools } = setupHarness();
		expect(tools.map((tool) => tool.name)).toEqual([
			"spawn_agent",
			"inspect_agents",
			"send_message",
			"followup_task",
			"wait_agents",
			"interrupt_agent",
		]);
	});
});
