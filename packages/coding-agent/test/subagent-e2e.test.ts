import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@arcmind/ai/compat";
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

describe("Ultra subagent end to end", () => {
	it("activates orchestration, runs and resumes one durable child, then deletes it", async () => {
		const root = mkdtempSync(join(tmpdir(), "arcmind-subagent-e2e-"));
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
				return fauxAssistantMessage("follow-up handoff");
			},
		]);
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey(faux.getModel().provider, "faux-key");
		const extensionFactory: ExtensionFactory = (arcmind: ExtensionAPI) => {
			arcmind.registerProvider(faux.getModel().provider, {
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
			expect(runtime.session.systemPrompt).not.toContain("<subagent_coordination>");

			runtime.session.setThinkingSelection("ultra");
			expect(runtime.session.getThinkingSelection()).toBe("ultra");
			expect(runtime.session.getActiveToolNames()).toContain(SUBAGENT_ACTIVATION_TOOL_NAME);
			expect(runtime.session.getActiveToolNames()).not.toEqual(expect.arrayContaining([...SUBAGENT_TOOL_NAMES]));
			expect(runtime.session.systemPrompt).not.toContain("<subagent_coordination>");

			await runtime.session.prompt("Delegate the independent inspection work");

			expect(parentProviderContexts).toHaveLength(2);
			expect(parentProviderContexts[0]!.tools).toContain(SUBAGENT_ACTIVATION_TOOL_NAME);
			expect(parentProviderContexts[0]!.tools).not.toEqual(expect.arrayContaining([...SUBAGENT_TOOL_NAMES]));
			expect(parentProviderContexts[0]!.systemPrompt).not.toContain("<subagent_coordination>");
			expect(parentProviderContexts[1]!.tools).not.toContain(SUBAGENT_ACTIVATION_TOOL_NAME);
			expect(parentProviderContexts[1]!.tools).toEqual(expect.arrayContaining([...SUBAGENT_TOOL_NAMES]));
			expect(parentProviderContexts[1]!.systemPrompt).toContain("<subagent_coordination>");
			expect(parentProviderContexts[1]!.systemPrompt).toContain(
				"Continue useful work instead of immediately waiting.",
			);
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
				forkTurns: 1,
			});
			await manager.wait({ agentIds: [spawned.agentId] });
			await vi.waitFor(() => expect(manager.listSummaries()[0]?.status).toBe("done"));
			expect(manager.listSummaries()[0]).toMatchObject({
				agentId: spawned.agentId,
				status: "done",
				finalSummary: "first durable handoff",
			});
			const inspected = await manager.inspect({ agentId: spawned.agentId, limit: 20 });
			expect(inspected.journal?.map((entry) => entry.type)).toEqual(Array(6).fill("message"));
			expect(inspected.usage.output).toBeGreaterThan(0);

			runtime.session.setThinkingSelection("high");
			expect(
				runtime.session.getActiveToolNames().filter((name) => SUBAGENT_TOOL_NAMES.includes(name as never)),
			).toEqual(["inspect_agents", "wait_agents", "interrupt_agent", "close_agent"]);
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
				expect.arrayContaining([
					SUBAGENT_ACTIVATION_TOOL_NAME,
					"inspect_agents",
					"wait_agents",
					"interrupt_agent",
					"close_agent",
				]),
			);
			expect(runtime.session.getActiveToolNames()).not.toContain("spawn_agent");
			expect(runtime.session.getActiveToolNames()).not.toContain("message_agent");
			expect(runtime.session.systemPrompt).not.toContain("<subagent_coordination>");

			await activationTool.execute("reactivate", {}, undefined, undefined, {} as never);
			expect(runtime.session.getActiveToolNames()).toEqual(expect.arrayContaining([...SUBAGENT_TOOL_NAMES]));
			expect(runtime.session.systemPrompt).toContain("<subagent_coordination>");
			await manager.message({ agentId: spawned.agentId, mode: "follow_up", message: "Verify the follow-up" });
			await vi.waitFor(() => expect(manager.listSummaries()[0]?.finalSummary).toBe("follow-up handoff"));
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
			expect(JSON.stringify(providerOptions)).not.toContain("ultra");
			expect(
				parentManager.getDurableJournalSnapshot().some((entry) => entry.type === "custom_message" && entry.display),
			).toBe(true);

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
				expect(reopened.session.systemPrompt).not.toContain("<subagent_coordination>");
			} finally {
				await reopened.dispose();
			}
		} finally {
			if (!runtimeDisposed) await runtime.dispose();
			faux.unregister();
		}
	});
});
