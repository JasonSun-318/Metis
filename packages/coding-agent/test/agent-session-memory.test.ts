import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@metis/agent-core";
import { createAssistantMessageEventStream, fauxAssistantMessage } from "@metis/ai";
import { getModel } from "@metis/ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { MemoryVault } from "../src/core/memory/vault.ts";
import { getNotePath, getScopeDir, getVaultRoot } from "../src/core/memory/vault-paths.ts";
import { resolveVaultProject } from "../src/core/memory/vault-project.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import type { PermissionPreset } from "../src/core/permissions/settings.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { type Settings, SettingsManager } from "../src/core/settings-manager.ts";
import { createUnattendedExecutionProfile } from "../src/core/unattended-execution.ts";
import { createTestResourceLoader } from "./utilities.ts";

describe("AgentSession memory vault", () => {
	const tempDirs: string[] = [];
	const makeTemp = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "metis-session-vault-"));
		tempDirs.push(dir);
		return dir;
	};

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function layout() {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		return { root, agentDir, cwd };
	}

	async function seedNote(
		agentDir: string,
		cwd: string,
		opts: { scope: "global" | "project"; slug: string; description: string; body?: string },
	): Promise<void> {
		const vault = new MemoryVault({
			agentDir,
			project: resolveVaultProject(cwd, "user-selected"),
		});
		vault.ensureLayout();
		const result = await vault.write(
			{
				op: "create",
				scope: opts.scope,
				target: { slug: opts.slug },
				frontmatter: { type: "reference", name: opts.slug, description: opts.description },
				content: opts.body ?? opts.description,
			},
			{ kind: "user" },
		);
		if (!result.ok) throw new Error(result.error);
	}

	function createSession(input: {
		agentDir?: string;
		cwd: string;
		settings?: Partial<Settings>;
		preset?: PermissionPreset;
		includeAutoMemory?: boolean;
		unattended?: boolean;
		managedCwd?: boolean;
		useMemory?: boolean;
		contributeMemory?: boolean;
	}) {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			initialState: { model, thinkingLevel: "off", systemPrompt: "Test", tools: [] },
		});
		const authStorage = AuthStorage.inMemory();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const sessionManager = SessionManager.inMemory(input.cwd, {
			...(input.managedCwd ? { cwdOrigin: "managed" as const } : {}),
			...(input.useMemory !== undefined ? { useMemory: input.useMemory } : {}),
			...(input.contributeMemory !== undefined ? { contributeMemory: input.contributeMemory } : {}),
		});
		if (input.preset) sessionManager.setPermissionPreset(input.preset);
		else sessionManager.setPermissionPreset("full");
		const events: AgentSessionEvent[] = [];
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: SettingsManager.inMemory(input.settings),
			cwd: input.cwd,
			agentDir: input.agentDir,
			modelRegistry: ModelRegistry.inMemory(authStorage),
			resourceLoader: createTestResourceLoader(),
			...(input.includeAutoMemory !== undefined ? { includeAutoMemory: input.includeAutoMemory } : {}),
			...(input.unattended
				? {
						unattendedExecution: createUnattendedExecutionProfile({
							workspaceRoots: [input.cwd],
							bashOperations: { exec: async () => ({ exitCode: 0 }) },
						}),
					}
				: {}),
		});
		session.subscribe((event) => events.push(event));
		return { session, events };
	}

	it("injects the frozen vault snapshot and registers memory tools at session start", async () => {
		const { agentDir, cwd } = layout();
		await seedNote(agentDir, cwd, {
			scope: "global",
			slug: "prefs",
			description: "user-global-marker",
		});
		await seedNote(agentDir, cwd, {
			scope: "project",
			slug: "arch",
			description: "project-memory-marker",
		});

		const { session } = createSession({ agentDir, cwd });
		try {
			expect(session.systemPrompt).toContain("<auto_memory>");
			expect(session.systemPrompt).toContain("user-global-marker");
			expect(session.systemPrompt).toContain("project-memory-marker");
			expect(session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["memory_search", "memory_read", "memory_write"]),
			);
		} finally {
			session.dispose();
		}
	});

	it("keeps the prompt byte-stable across vault writes until a snapshot boundary", async () => {
		const { agentDir, cwd } = layout();
		await seedNote(agentDir, cwd, { scope: "global", slug: "prefs", description: "before-marker" });
		const { session } = createSession({ agentDir, cwd });
		try {
			const memorySection = (prompt: string) => prompt.match(/<auto_memory>[\s\S]*<\/auto_memory>/)?.[0];
			const frozen = memorySection(session.systemPrompt);
			expect(frozen).toBeDefined();
			await seedNote(agentDir, cwd, { scope: "global", slug: "later", description: "after-marker" });
			session.refreshSystemPrompt();
			expect(memorySection(session.systemPrompt)).toBe(frozen);
			expect(session.systemPrompt).not.toContain("after-marker");

			// The enable toggle is an explicit refresh boundary: the vault is re-read.
			await session.setAutoMemoryEnabled(false);
			expect(session.systemPrompt).not.toContain("<auto_memory>");
			await session.setAutoMemoryEnabled(true);
			expect(session.systemPrompt).toContain("after-marker");
		} finally {
			session.dispose();
		}
	});

	it("re-reads the snapshot after compaction", async () => {
		const { agentDir, cwd } = layout();
		await seedNote(agentDir, cwd, { scope: "global", slug: "prefs", description: "pre-compact-marker" });
		const { session } = createSession({
			agentDir,
			cwd,
			settings: { compaction: { keepRecentTokens: 1 } },
		});
		const model = session.model!;
		const now = Date.now();
		session.sessionManager.appendMessage({
			role: "user",
			content: [{ type: "text", text: "message to compact" }],
			timestamp: now - 1000,
		});
		session.sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "assistant response to compact" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 100,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: now - 500,
		});
		session.agent.state.messages = session.sessionManager.buildSessionContext().messages;
		session.agent.streamFn = (summaryModel) => {
			const stream = createAssistantMessageEventStream();
			queueMicrotask(() => {
				stream.push({
					type: "done",
					reason: "stop",
					message: {
						...fauxAssistantMessage("compacted"),
						api: summaryModel.api,
						provider: summaryModel.provider,
						model: summaryModel.id,
					},
				});
			});
			return stream;
		};

		try {
			await seedNote(agentDir, cwd, { scope: "global", slug: "post", description: "post-compact-marker" });
			expect(session.systemPrompt).not.toContain("post-compact-marker");
			await session.compact();
			expect(session.systemPrompt).toContain("post-compact-marker");
		} finally {
			session.dispose();
		}
	});

	it("persists memory_write through the session and emits memory_changed without touching the prompt", async () => {
		const { agentDir, cwd } = layout();
		const { session, events } = createSession({ agentDir, cwd });
		try {
			const before = session.systemPrompt;
			const write = session.agent.state.tools.find((tool) => tool.name === "memory_write");
			expect(write).toBeDefined();
			const result = await write!.execute(
				"call-1",
				{
					op: "create",
					scope: "global",
					target: { slug: "via-tool" },
					frontmatter: { type: "reference", name: "via-tool", description: "written via tool" },
					content: "body",
				},
				undefined,
				undefined,
			);
			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Saved memory") });
			const notePath = getNotePath(getScopeDir(getVaultRoot(agentDir), "global"), "via-tool");
			expect(readFileSync(notePath, "utf8")).toContain("written via tool");
			expect(events.filter((event) => event.type === "memory_changed")).toHaveLength(1);
			expect(session.systemPrompt).toBe(before);

			const undo = await session.undoMemoryChange();
			expect(undo.ok).toBe(true);
			expect(existsSync(notePath)).toBe(false);
		} finally {
			session.dispose();
		}
	});

	it("approves memory_write under the ask preset without a user prompt", async () => {
		const { agentDir, cwd } = layout();
		const { session } = createSession({ agentDir, cwd, preset: "ask" });
		try {
			const write = session.agent.state.tools.find((tool) => tool.name === "memory_write");
			const result = await write!.execute(
				"call-1",
				{
					op: "create",
					scope: "global",
					target: { slug: "ask-preset" },
					frontmatter: { type: "reference", name: "ask-preset", description: "managed write" },
					content: "body",
				},
				undefined,
				undefined,
			);
			expect(result.content[0]).toMatchObject({ text: expect.stringContaining("Saved memory") });
		} finally {
			session.dispose();
		}
	});

	it("still denies generic write/edit inside the vault root", async () => {
		const { agentDir, cwd } = layout();
		const { session } = createSession({ agentDir, cwd });
		try {
			const vaultFile = join(getVaultRoot(agentDir), "global", "MEMORY.md");
			mkdirSync(join(getVaultRoot(agentDir), "global"), { recursive: true });
			writeFileSync(vaultFile, "keep\n");
			const write = session.agent.state.tools.find((tool) => tool.name === "write");
			await expect(
				write!.execute("w-1", { path: vaultFile, content: "bad\n" }, undefined, undefined),
			).rejects.toThrow(/memory/i);
			expect(readFileSync(vaultFile, "utf8")).toBe("keep\n");
		} finally {
			session.dispose();
		}
	});

	it.each([
		{ name: "includeAutoMemory=false", input: { includeAutoMemory: false } },
		{ name: "autoMemoryEnabled=false", input: { settings: { autoMemoryEnabled: false } } },
		{ name: "unattended execution", input: { unattended: true } },
	] as const)("registers no memory tools and no snapshot for $name", async ({ input }) => {
		const { agentDir, cwd } = layout();
		await seedNote(agentDir, cwd, { scope: "global", slug: "prefs", description: "hidden-marker" });
		const { session } = createSession({ agentDir, cwd, ...input });
		try {
			expect(session.getActiveToolNames()).not.toContain("memory_write");
			expect(session.getActiveToolNames()).not.toContain("memory_search");
			expect(session.systemPrompt).not.toContain("<auto_memory>");
			expect(session.systemPrompt).not.toContain("hidden-marker");
		} finally {
			session.dispose();
		}
	});

	it("drops all memory tools and the snapshot when useMemory is off", async () => {
		const { agentDir, cwd } = layout();
		await seedNote(agentDir, cwd, { scope: "global", slug: "prefs", description: "hidden-marker" });
		const { session } = createSession({ agentDir, cwd, useMemory: false });
		try {
			expect(session.getActiveToolNames()).not.toContain("memory_search");
			expect(session.getActiveToolNames()).not.toContain("memory_read");
			expect(session.getActiveToolNames()).not.toContain("memory_write");
			expect(session.systemPrompt).not.toContain("<auto_memory>");
			expect(session.systemPrompt).not.toContain("hidden-marker");
		} finally {
			session.dispose();
		}
	});

	it("keeps read/search but drops memory_write when contributeMemory is off", async () => {
		const { agentDir, cwd } = layout();
		await seedNote(agentDir, cwd, { scope: "global", slug: "prefs", description: "visible-marker" });
		const { session } = createSession({ agentDir, cwd, contributeMemory: false });
		try {
			expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["memory_search", "memory_read"]));
			expect(session.getActiveToolNames()).not.toContain("memory_write");
			expect(session.systemPrompt).toContain("visible-marker");
		} finally {
			session.dispose();
		}
	});

	it("rebuilds tools and prompt when setMemoryFlags toggles either flag", async () => {
		const { agentDir, cwd } = layout();
		await seedNote(agentDir, cwd, { scope: "global", slug: "prefs", description: "toggle-marker" });
		const { session } = createSession({ agentDir, cwd });
		try {
			await session.setMemoryFlags({ contributeMemory: false });
			expect(session.getActiveToolNames()).not.toContain("memory_write");
			expect(session.getActiveToolNames()).toContain("memory_search");
			expect(session.systemPrompt).toContain("toggle-marker");

			await session.setMemoryFlags({ useMemory: false });
			expect(session.getActiveToolNames()).not.toContain("memory_search");
			expect(session.systemPrompt).not.toContain("<auto_memory>");

			await session.setMemoryFlags({ useMemory: true, contributeMemory: true });
			expect(session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["memory_search", "memory_read", "memory_write"]),
			);
			expect(session.systemPrompt).toContain("toggle-marker");
		} finally {
			session.dispose();
		}
	});

	it("persists memory flags through the display-metadata sidecar across reopen", () => {
		const { agentDir, cwd } = layout();
		const sessionDir = join(agentDir, "sessions");
		const created = SessionManager.create(cwd, sessionDir, { useMemory: false, contributeMemory: false });
		const file = created.getSessionFile()!;
		created.close();

		const reopened = SessionManager.open(file, sessionDir);
		try {
			expect(reopened.getUseMemory()).toBe(false);
			expect(reopened.getContributeMemory()).toBe(false);
			// Flags re-enable cleanly and persist again.
			reopened.setMemoryFlags({ useMemory: true });
			expect(reopened.getUseMemory()).toBe(true);
			expect(reopened.getContributeMemory()).toBe(false);
		} finally {
			reopened.close();
		}

		const again = SessionManager.open(file, sessionDir);
		try {
			expect(again.getUseMemory()).toBe(true);
			expect(again.getContributeMemory()).toBe(false);
		} finally {
			again.close();
		}
	});

	it("omits the project scope for managed workspaces", async () => {
		const { agentDir, cwd } = layout();
		await seedNote(agentDir, cwd, { scope: "project", slug: "proj", description: "project-only-marker" });
		await seedNote(agentDir, cwd, { scope: "global", slug: "prefs", description: "global-visible-marker" });
		const { session } = createSession({ agentDir, cwd, managedCwd: true });
		try {
			expect(session.systemPrompt).toContain("global-visible-marker");
			expect(session.systemPrompt).not.toContain("project-only-marker");
		} finally {
			session.dispose();
		}
	});

	it("model refresh preserves the frozen memory section", async () => {
		const { agentDir, cwd } = layout();
		await seedNote(agentDir, cwd, { scope: "global", slug: "before", description: "before-marker" });
		const { session } = createSession({ agentDir, cwd });
		try {
			const section = (s: string) => s.match(/<auto_memory>[\s\S]*<\/auto_memory>/)?.[0];
			const frozen = section(session.systemPrompt);
			expect(frozen).toBeDefined();
			await seedNote(agentDir, cwd, { scope: "global", slug: "after", description: "after-marker" });
			await session.applyModelServiceSettingsRefresh();
			expect(section(session.systemPrompt)).toBe(frozen);
			expect(session.systemPrompt).not.toContain("after-marker");
		} finally {
			session.dispose();
		}
	});

	it("saving unchanged memory flags does not refresh the snapshot", async () => {
		const { agentDir, cwd } = layout();
		const { session } = createSession({ agentDir, cwd });
		try {
			const before = session.getMemorySnapshot();
			await seedNote(agentDir, cwd, { scope: "global", slug: "later", description: "later-marker" });
			await session.setAutoMemoryEnabled(true);
			await session.setMemoryFlags({ useMemory: true, contributeMemory: true });
			expect(session.getMemorySnapshot()).toBe(before);
		} finally {
			session.dispose();
		}
	});

	it("Dream-only settings refresh leaves the captured memory object unchanged", async () => {
		const { agentDir, cwd } = layout();
		const { session } = createSession({ agentDir, cwd });
		try {
			const before = session.getMemorySnapshot();
			session.settingsManager.setMemorySettings({ dream: { minHours: 48 } });
			await session.refreshMemorySettings();
			expect(session.getMemorySnapshot()).toBe(before);
		} finally {
			session.dispose();
		}
	});

	it("drops and restores memory tools and the section through refreshMemorySettings", async () => {
		const { agentDir, cwd } = layout();
		await seedNote(agentDir, cwd, { scope: "global", slug: "prefs", description: "toggle-marker" });
		const { session } = createSession({ agentDir, cwd });
		try {
			session.settingsManager.setAutoMemoryEnabled(false);
			await session.refreshMemorySettings();
			expect(session.getActiveToolNames()).not.toContain("memory_search");
			expect(session.getActiveToolNames()).not.toContain("memory_read");
			expect(session.getActiveToolNames()).not.toContain("memory_write");
			expect(session.systemPrompt).not.toContain("<auto_memory>");

			session.settingsManager.setAutoMemoryEnabled(true);
			await session.refreshMemorySettings();
			expect(session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["memory_search", "memory_read", "memory_write"]),
			);
			expect(session.systemPrompt).toContain("toggle-marker");

			await session.setMemoryFlags({ contributeMemory: false });
			expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["memory_search", "memory_read"]));
			expect(session.getActiveToolNames()).not.toContain("memory_write");
		} finally {
			session.dispose();
		}
	});

	it("keeps full provider prompts stable across three turns and a real memory tool call", async () => {
		const { agentDir, cwd } = layout();
		const { session } = createSession({ agentDir, cwd, preset: "ask" });
		const prompts: string[] = [];
		session.agent.streamFn = (model, context) => {
			prompts.push(context.systemPrompt ?? "");
			const stream = createAssistantMessageEventStream();
			const call = prompts.length === 2;
			queueMicrotask(() =>
				stream.push({
					type: "done",
					reason: call ? "toolUse" : "stop",
					message: {
						...fauxAssistantMessage("acknowledged"),
						api: model.api,
						provider: model.provider,
						model: model.id,
						...(call
							? {
									stopReason: "toolUse" as const,
									content: [
										{
											type: "toolCall" as const,
											id: "test-memory-write",
											name: "memory_write",
											arguments: {
												op: "create",
												scope: "global",
												target: { slug: "provider-flow" },
												frontmatter: { type: "reference", description: "new-persisted-marker" },
												content: "remembered",
											},
										},
									],
								}
							: {}),
					},
				}),
			);
			return stream;
		};
		try {
			await session.prompt("first turn");
			await session.prompt("remember this convention");
			await session.prompt("third turn");
			expect(prompts).toHaveLength(4);
			expect(new Set(prompts).size).toBe(1);
			expect(prompts[0]).not.toContain("new-persisted-marker");
			expect(new MemoryVault({ agentDir }).readNote("global", "provider-flow")?.body).toBe("remembered");
			await session.reload();
			expect(session.systemPrompt).toContain("new-persisted-marker");
		} finally {
			session.dispose();
		}
	});
});
