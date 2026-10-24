import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, fauxAssistantMessage, registerFauxProvider } from "@metis/ai/compat";
import { afterEach, expect, it, vi } from "vitest";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
} from "../src/core/agent-session-runtime.ts";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-services.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { getSessionImageDir, SessionManager } from "../src/core/session-manager.ts";
import { buildChildSystemPrompt } from "../src/core/subagents/prompts.ts";
import type { ExtensionAPI } from "../src/index.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

it("preserves Chat roles and trusted origins in real provider requests, including identical steering and images", async () => {
	const root = mkdtempSync(join(tmpdir(), "metis-agent-conversation-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	const faux = registerFauxProvider();
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const childRequests: Context[] = [];
	const factoryResponse = async (context: Context) => {
		if (context.systemPrompt?.includes("<agent_contract>")) {
			childRequests.push({ systemPrompt: context.systemPrompt, messages: structuredClone(context.messages) });
			if (childRequests.length === 1) await gate;
			return fauxAssistantMessage("Child verified the requested dimensions.");
		}
		return fauxAssistantMessage("Parent acknowledged the child event.");
	};
	faux.setResponses(Array.from({ length: 20 }, () => factoryResponse));
	const childSessions: AgentSessionRuntime["session"][] = [];
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
					(metis: ExtensionAPI) =>
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
						}),
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
		if (childConfig) childSessions.push(created.session);
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const rootManager = SessionManager.create(cwd, join(root, "sessions"), {
		id: "root-chat",
		mode: "chat",
		permissionPreset: "full",
	});
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: rootManager });
	cleanups.push(async () => {
		release();
		await runtime.dispose();
		faux.unregister();
		rmSync(root, { recursive: true, force: true });
	});
	const manager = runtime.subagentManager!;
	const child = await manager.spawn("root-chat", {
		name: "Image dimensions",
		task: "Inspect image dimensions",
		agentType: "worker",
	});
	await vi.waitFor(
		() => {
			expect(manager.listTasks(child.agentId)[0]?.error).toBeUndefined();
			expect(childRequests).toHaveLength(1);
		},
		{ timeout: 5000 },
	);
	expect(childRequests[0].systemPrompt).toContain("<agent_contract>");
	expect(childRequests[0].systemPrompt).toContain("<agent_role_instructions>");
	expect(childRequests[0].systemPrompt).toContain("<agent_coordination>");
	expect(JSON.stringify(childRequests[0].messages)).toContain('\\"kind\\":\\"agent\\"');
	const image = Buffer.from(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jL1EAAAAASUVORK5CYII=",
		"base64",
	);
	const hash = createHash("sha256").update(image).digest("hex");
	const imageDir = getSessionImageDir(rootManager.getSessionFile()!);
	mkdirSync(imageDir, { recursive: true });
	writeFileSync(join(imageDir, `${hash}.png`), image, { mode: 0o600 });
	const first = await manager.submitMessage(
		{ kind: "user" },
		{
			agentId: child.agentId,
			requestId: "identical-1",
			input: {
				text: "Check width first",
				images: [{ type: "image_ref", hash, mimeType: "image/png", size: image.length }],
			},
		},
	);
	const second = await manager.submitMessage(
		{ kind: "user" },
		{ agentId: child.agentId, requestId: "identical-2", input: { text: "Check width first" } },
	);
	expect(first.state).toBe("accepted");
	expect(second.state).toBe("accepted");
	release();
	await vi.waitFor(
		() =>
			expect(manager.listTasks(child.agentId)[0]).toMatchObject({
				status: "done",
				instructionRevision: 3,
				consumedInstructionRevision: 3,
			}),
		{ timeout: 5000 },
	);
	const journal = await manager.readJournal("root-chat", child.agentId);
	const inputs = journal.filter((entry) => entry.type === "agent_input" && entry.state === "delivered");
	expect(inputs.map((entry) => (entry.type === "agent_input" ? entry.messageId : undefined))).toEqual(
		expect.arrayContaining([first.messageId, second.messageId]),
	);
	const userEntries = journal.filter((entry) => entry.type === "message" && entry.message.role === "user");
	expect(userEntries.map((entry) => (entry.type === "message" ? entry.agentMessageId : undefined))).toEqual(
		expect.arrayContaining([first.messageId, second.messageId]),
	);
	expect(new Set(userEntries.map((entry) => (entry.type === "message" ? entry.agentMessageId : undefined))).size).toBe(
		3,
	);
	expect(JSON.stringify(childRequests.at(-1)?.messages)).toContain('\\"kind\\":\\"user\\"');
	expect(JSON.stringify(childRequests.at(-1)?.messages)).toContain('"type":"image"');
	expect(childSessions[0].mode).toBe("chat");
	// The permission review source list must contain only authenticated human submissions.
	const trusted = (childSessions[0] as unknown as { _trustedUserMessages: Array<{ messageId: string; text: string }> })
		._trustedUserMessages;
	expect(trusted.map((item) => item.messageId)).toEqual([first.messageId, second.messageId]);
	expect(trusted.map((item) => item.text)).not.toContain("Inspect image dimensions");
}, 15000);
