import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@metis/agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@metis/ai";
import { getModel } from "@metis/ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ensureModeScopedMemoryLayout, getAutoMemoryPaths, getMemorySqlitePath } from "../src/core/auto-memory.ts";
import { memoryProjectIdentity } from "../src/core/memory/memory-project.ts";
import { writeProjection } from "../src/core/memory/memory-projection.ts";
import { openMemoryStore } from "../src/core/memory/memory-store.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { createAgentSession } from "../src/core/sdk.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("AgentSession auto memory", () => {
	const tempDirs: string[] = [];
	const makeTemp = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "metis-session-memory-"));
		tempDirs.push(dir);
		return dir;
	};
	const seedMemory = async (agentDir: string, cwd: string, globalText?: string, projectText?: string) => {
		await ensureModeScopedMemoryLayout(agentDir);
		const identity = memoryProjectIdentity(cwd);
		const store = openMemoryStore(getMemorySqlitePath(agentDir));
		store.resolveProject(identity);
		for (const [scope, text] of [
			["global", globalText],
			["project", projectText],
		] as const) {
			if (!text) continue;
			store.insertFact({
				id: randomUUID(),
				scope,
				cwdKey: scope === "global" ? null : identity.projectKey,
				mode: null,
				topicFile: scope === "global" ? "preferences.md" : "context.md",
				text,
				status: "active",
				createdAt: new Date().toISOString(),
				sourceTurn: "test",
				embedding: null,
				embeddingModel: null,
			});
		}
		store.close();
	};

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			try {
				rmSync(dir, { recursive: true, force: true });
			} catch {
				// Windows may briefly hold SQLite WAL handles after dispose.
			}
		}
	});

	it("injects both indexes and refreshes external changes on reload", async () => {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		await seedMemory(agentDir, cwd, "global-memory-v1", "project-memory-v1");
		const paths = getAutoMemoryPaths(agentDir, cwd);

		const { session } = await createAgentSession({
			agentDir,
			cwd,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});
		try {
			expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "grep"]));
			expect(session.systemPrompt).toContain("global-memory-v1");
			expect(session.systemPrompt).toContain("project-memory-v1");

			writeFileSync(paths.project.indexPath, "project-memory-v2");
			expect(session.systemPrompt).not.toContain("project-memory-v2");
			session.refreshSystemPrompt();
			expect(session.systemPrompt).toContain("project-memory-v2");
			expect(session.systemPrompt).not.toContain("project-memory-v1");
		} finally {
			session.dispose();
		}
	});

	it("refreshes Index memory before provider context on each new user turn", async () => {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		await seedMemory(agentDir, cwd, "global-before-turn", "project-before-turn");
		const identity = memoryProjectIdentity(cwd);
		const store = openMemoryStore(getMemorySqlitePath(agentDir));
		await writeProjection(agentDir, identity.projectKey, store);
		store.close();

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		let providerPrompt = "";
		const agent = new Agent({
			initialState: { model, thinkingLevel: "off", systemPrompt: "Test", tools: [] },
			streamFn: (_requestModel, context) => {
				providerPrompt = context.systemPrompt ?? "";
				const stream = createAssistantMessageEventStream();
				queueMicrotask(() => stream.push({ type: "done", reason: "stop", message: fauxAssistantMessage("ok") }));
				return stream;
			},
		});
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager: SettingsManager.inMemory({ autoMemoryEnabled: true, memoryEngine: "index" }),
			cwd,
			agentDir,
			modelRegistry: ModelRegistry.inMemory(authStorage),
			resourceLoader: createTestResourceLoader(),
		});
		try {
			const paths = getAutoMemoryPaths(agentDir, cwd);
			writeFileSync(paths.project.indexPath, "project-visible-on-next-turn");
			await session.prompt("hello");
			expect(providerPrompt).toContain("project-visible-on-next-turn");
		} finally {
			session.dispose();
		}
	});

	it("shares exact-cwd project memory across Chat and Code and isolates sibling cwd", async () => {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const firstCwd = join(root, "first");
		const secondCwd = join(root, "second");
		mkdirSync(firstCwd, { recursive: true });
		mkdirSync(secondCwd, { recursive: true });
		await seedMemory(agentDir, firstCwd, "shared-global-memory", "shared-project-memory");

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const first = await createAgentSession({ agentDir, cwd: firstCwd, model });
		const firstChat = await createAgentSession({ agentDir, cwd: firstCwd, agentMode: "chat", model });
		const second = await createAgentSession({ agentDir, cwd: secondCwd, model });
		try {
			expect(first.session.systemPrompt).toContain("shared-global-memory");
			expect(firstChat.session.systemPrompt).toContain("shared-global-memory");
			expect(second.session.systemPrompt).toContain("shared-global-memory");
			expect(first.session.systemPrompt).toContain("shared-project-memory");
			expect(firstChat.session.systemPrompt).toContain("shared-project-memory");
			expect(second.session.systemPrompt).not.toContain("shared-project-memory");
		} finally {
			first.session.dispose();
			firstChat.session.dispose();
			second.session.dispose();
		}
	});

	it("removes and restores memory from the live prompt when toggled", async () => {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		await seedMemory(agentDir, cwd, "toggle-memory-marker");
		const settingsManager = SettingsManager.inMemory();
		const { session } = await createAgentSession({
			agentDir,
			cwd,
			settingsManager,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});
		try {
			expect(session.systemPrompt).toContain("toggle-memory-marker");
			settingsManager.setAutoMemoryEnabled(false);
			session.refreshSystemPrompt();
			expect(session.systemPrompt).not.toContain("<auto_memory>");

			settingsManager.setAutoMemoryEnabled(true);
			session.refreshSystemPrompt();
			expect(session.systemPrompt).toContain("toggle-memory-marker");
		} finally {
			session.dispose();
		}
	});

	it("uses index catalog by default and extract retrieved stubs when engine is extract", async () => {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		await seedMemory(agentDir, cwd, "index-engine-catalog-marker", "project-catalog-marker");

		const settingsManager = SettingsManager.inMemory({
			autoMemoryEnabled: true,
			memoryEngine: "index",
			embedding: {
				name: "Embedding",
				provider: "OpenAI",
				baseUrl: "https://api.openai.com/v1",
				api: "openai-compatible",
				modelId: "text-embedding-3-small",
			},
		});
		const { session } = await createAgentSession({
			agentDir,
			cwd,
			settingsManager,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
		});
		try {
			expect(session.systemPrompt).toContain("<global_memory_index>");
			expect(session.systemPrompt).toContain("index-engine-catalog-marker");
			expect(session.systemPrompt).toMatch(/maintained in the background/i);
			expect(session.systemPrompt).not.toContain("Proactively maintain memory during normal work");

			settingsManager.setMemoryEngine("extract");
			session.refreshSystemPrompt();
			expect(session.systemPrompt).toContain("<auto_memory>");
			expect(session.systemPrompt).toContain("No relevant long-term memory for this turn.");
			expect(session.systemPrompt).not.toContain("<global_memory_index>");
			expect(session.systemPrompt).not.toContain("index-engine-catalog-marker");
			expect(session.systemPrompt).toMatch(/do not read the memory directory unless the user asks what is stored/i);
		} finally {
			session.dispose();
		}
	});

	it("keeps extract no-memory message when retrieve fails and never dumps the catalog", async () => {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		await seedMemory(agentDir, cwd, "index-engine-catalog-marker", "project-catalog-marker");

		const settingsManager = SettingsManager.inMemory({
			autoMemoryEnabled: true,
			memoryEngine: "extract",
			embedding: {
				name: "Embedding",
				provider: "OpenAI",
				baseUrl: "https://api.openai.com/v1",
				api: "openai-compatible",
				modelId: "text-embedding-3-small",
			},
		});
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const streamFn: Agent["streamFn"] = (requestModel) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage("ok"),
						api: requestModel.api,
						provider: requestModel.provider,
						model: requestModel.id,
					},
				});
			});
			return stream;
		};
		const agent = new Agent({
			initialState: { model, thinkingLevel: "off", systemPrompt: "Test", tools: [] },
			streamFn,
			transport: "sse",
		});
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(cwd),
			settingsManager,
			cwd,
			agentDir,
			modelRegistry: ModelRegistry.inMemory(authStorage),
			resourceLoader: createTestResourceLoader(),
		});
		try {
			await session.prompt("What do you remember about me?");
			expect(session.systemPrompt).toContain("No relevant long-term memory for this turn.");
			expect(session.systemPrompt).not.toContain("<global_memory_index>");
			expect(session.systemPrompt).not.toContain("index-engine-catalog-marker");
		} finally {
			session.dispose();
			await Promise.resolve();
		}
	});
});
