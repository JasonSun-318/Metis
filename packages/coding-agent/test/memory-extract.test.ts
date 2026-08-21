import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, AgentTool } from "@metis/agent-core";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAutoMemoryPaths, getMemorySqlitePath } from "../src/core/auto-memory.ts";
import {
	COMMIT_EXTRACT_SYSTEM_PROMPT,
	hasDurableMemoryIntent,
	RECONCILE_EXTRACT_SYSTEM_PROMPT,
	runMemoryExtract,
} from "../src/core/memory/memory-extract.ts";
import { memoryProjectIdentity } from "../src/core/memory/memory-project.ts";
import { openMemoryStore } from "../src/core/memory/memory-store.ts";
import {
	CommitFactsParamsSchema,
	createCommitFactsTool,
	createReconcileFactsTool,
	type MemoryToolContext,
	ReconcileFactsParamsSchema,
} from "../src/core/memory/memory-tools.ts";

describe("memory extract tools + runner", () => {
	const dirs: string[] = [];
	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function tempRoot(): string {
		const root = mkdtempSync(join(tmpdir(), "metis-extract-"));
		dirs.push(root);
		return root;
	}

	function toolContext(
		root: string,
		store = openMemoryStore(getMemorySqlitePath(join(root, "agent"))),
	): MemoryToolContext {
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		return {
			store,
			agentDir,
			projectKey: memoryProjectIdentity(cwd).projectKey,
			sourceTurn: "turn-1",
			createdAt: "2026-08-21T12:00:00.000Z",
		};
	}

	function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
		return result.content
			.filter(
				(part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string",
			)
			.map((part) => part.text)
			.join("\n");
	}

	describe("commit_facts", () => {
		it("inserts valid facts, drops secrets and invalid topicFile, allows empty array", async () => {
			const root = tempRoot();
			const ctx = toolContext(root);
			const tool = createCommitFactsTool(ctx);

			const empty = await tool.execute("e0", { facts: [] }, undefined, undefined, {} as never);
			expect(textOf(empty).toLowerCase()).toMatch(/ok|success|0/);
			expect(ctx.store.countFacts()).toBe(0);

			const result = await tool.execute(
				"c1",
				{
					facts: [
						{ text: "Auth lives in app-server", scope: "project", topicFile: "auth.md" },
						{ text: "sk-abc1234567890secret", scope: "project", topicFile: "auth.md" },
						{ text: "Missing file omitted", scope: "project" } as never,
						{ text: "Bad path", scope: "project", topicFile: "../escape.md" },
						{ text: "Also bad", scope: "project", topicFile: ".hidden.md" },
						{ text: "Global pref", scope: "global", topicFile: "preferences.md" },
					],
				},
				undefined,
				undefined,
				{} as never,
			);

			expect(textOf(result)).toMatch(/2/);
			const project = ctx.store.listActiveFacts("project", ctx.projectKey, null);
			const global = ctx.store.listActiveFacts("global", null, null);
			expect(project.map((f) => f.text)).toEqual(["Auth lives in app-server"]);
			expect(project[0]?.topicFile).toBe("auth.md");
			expect(project[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
			expect(global.map((f) => f.text)).toEqual(["Global pref"]);
			expect(global[0]?.cwdKey).toBeNull();
			expect(global[0]?.mode).toBeNull();
			ctx.store.close();
		});

		it("rejects unknown fields or bad scope with an error string and inserts nothing", async () => {
			const root = tempRoot();
			const ctx = toolContext(root);
			const tool = createCommitFactsTool(ctx);

			expect(Value.Check(CommitFactsParamsSchema, { facts: [], extra: true })).toBe(false);
			expect(
				Value.Check(CommitFactsParamsSchema, {
					facts: [{ text: "x", scope: "workspace", topicFile: "auth.md" }],
				}),
			).toBe(false);

			const unknown = await tool.execute(
				"bad1",
				{ facts: [{ text: "x", scope: "project", topicFile: "auth.md" }], extra: true } as never,
				undefined,
				undefined,
				{} as never,
			);
			expect(textOf(unknown).toLowerCase()).toMatch(/error|invalid/);
			expect(ctx.store.countFacts()).toBe(0);

			const badScope = await tool.execute(
				"bad2",
				{ facts: [{ text: "x", scope: "workspace", topicFile: "auth.md" }] } as never,
				undefined,
				undefined,
				{} as never,
			);
			expect(textOf(badScope).toLowerCase()).toMatch(/error|invalid/);
			expect(ctx.store.countFacts()).toBe(0);
			ctx.store.close();
		});

		it("still inserts when embedding fails, leaving embedding NULL", async () => {
			const root = tempRoot();
			const ctx = toolContext(root);
			ctx.embeddingModel = "openai/text-embedding-3-small";
			ctx.embedText = async () => {
				throw new Error("embed down");
			};
			const tool = createCommitFactsTool(ctx);
			await tool.execute(
				"c-embed-fail",
				{ facts: [{ text: "User prefers concise replies", scope: "global", topicFile: "prefs.md" }] },
				undefined,
				undefined,
				{} as never,
			);
			const facts = ctx.store.listActiveFacts("global", null, null);
			expect(facts).toHaveLength(1);
			expect(facts[0]?.embedding).toBeNull();
			expect(facts[0]?.embeddingModel).toBeNull();
			ctx.store.close();
		});

		it("stores embedding after a successful embedText", async () => {
			const root = tempRoot();
			const ctx = toolContext(root);
			ctx.embeddingModel = "openai/text-embedding-3-small";
			ctx.embedText = async () => new Float32Array([0.25, 0.5, 0.75]);
			const tool = createCommitFactsTool(ctx);
			await tool.execute(
				"c-embed-ok",
				{ facts: [{ text: "User prefers concise replies", scope: "global", topicFile: "prefs.md" }] },
				undefined,
				undefined,
				{} as never,
			);
			const facts = ctx.store.listActiveFacts("global", null, null);
			expect(facts[0]?.embeddingModel).toBe("openai/text-embedding-3-small");
			expect(Array.from(facts[0]!.embedding!).map((n) => Number(n.toFixed(2)))).toEqual([0.25, 0.5, 0.75]);
			ctx.store.close();
		});
	});

	describe("reconcile_facts", () => {
		it("supersedes only when the new fact is newer by createdAt/sourceTurn", async () => {
			const root = tempRoot();
			const ctx = toolContext(root);
			ctx.store.insertFact({
				id: "old",
				scope: "project",
				cwdKey: ctx.projectKey,
				mode: null,
				topicFile: "auth.md",
				text: "Old auth location",
				status: "active",
				createdAt: "2026-08-21T10:00:00.000Z",
				sourceTurn: "turn-1",
				embedding: null,
				embeddingModel: null,
			});
			ctx.store.insertFact({
				id: "newer",
				scope: "project",
				cwdKey: ctx.projectKey,
				mode: null,
				topicFile: "auth.md",
				text: "New auth location",
				status: "active",
				createdAt: "2026-08-21T11:00:00.000Z",
				sourceTurn: "turn-2",
				embedding: null,
				embeddingModel: null,
			});
			ctx.store.insertFact({
				id: "older-new",
				scope: "project",
				cwdKey: ctx.projectKey,
				mode: null,
				topicFile: "auth.md",
				text: "Stale candidate",
				status: "active",
				createdAt: "2026-08-21T09:00:00.000Z",
				sourceTurn: "turn-0",
				embedding: null,
				embeddingModel: null,
			});

			const tool = createReconcileFactsTool(ctx);
			expect(Value.Check(ReconcileFactsParamsSchema, { supersede: [{ oldId: "old", newId: "newer" }] })).toBe(true);

			const rejected = await tool.execute(
				"r0",
				{ supersede: [{ oldId: "old", newId: "older-new" }] },
				undefined,
				undefined,
				{} as never,
			);
			expect(textOf(rejected).toLowerCase()).toMatch(/reject|older|recency|not newer/);
			expect(ctx.store.getFactById("old")?.status).toBe("active");

			const accepted = await tool.execute(
				"r1",
				{ supersede: [{ oldId: "old", newId: "newer" }] },
				undefined,
				undefined,
				{} as never,
			);
			expect(textOf(accepted).toLowerCase()).not.toMatch(/error|invalid|reject/);
			expect(ctx.store.getFactById("old")?.status).toBe("superseded");
			expect(ctx.store.getFactById("newer")?.status).toBe("active");
			ctx.store.close();
		});

		it("rejects ids outside global plus the exact current project", async () => {
			const root = tempRoot();
			const ctx = toolContext(root);
			ctx.store.insertFact({
				id: "sibling",
				scope: "project",
				cwdKey: "b".repeat(64),
				mode: null,
				topicFile: "private.md",
				text: "sibling marker",
				status: "active",
				createdAt: "2026-08-21T10:00:00.000Z",
				sourceTurn: "turn-1",
				embedding: null,
				embeddingModel: null,
			});
			const result = await createReconcileFactsTool(ctx).execute(
				"r-sibling",
				{ deleteIds: ["sibling"] },
				undefined,
				undefined,
				{} as never,
			);
			expect(textOf(result)).toMatch(/unknown|invalid|error/i);
			expect(ctx.store.getFactById("sibling")?.status).toBe("active");
			ctx.store.close();
		});
	});

	describe("prompts + durable intent", () => {
		it("documents extract rules in system prompts", () => {
			expect(COMMIT_EXTRACT_SYSTEM_PROMPT).toMatch(/project/i);
			expect(COMMIT_EXTRACT_SYSTEM_PROMPT).toMatch(/ADD-only|add-only|commit_facts/i);
			expect(COMMIT_EXTRACT_SYSTEM_PROMPT).toMatch(/do not read|memory directory/i);
			expect(RECONCILE_EXTRACT_SYSTEM_PROMPT).toMatch(/recency|timestamp/i);
			expect(RECONCILE_EXTRACT_SYSTEM_PROMPT).toMatch(/merge|moveScope|move scope/i);
		});

		it("detects durable memory intent phrases", () => {
			expect(hasDurableMemoryIntent("请记住我喜欢中文")).toBe(true);
			expect(hasDurableMemoryIntent("以后不要再问")).toBe(true);
			expect(hasDurableMemoryIntent("我的偏好是 dark mode")).toBe(true);
			expect(hasDurableMemoryIntent("Please remember this")).toBe(true);
			expect(hasDurableMemoryIntent("always use tabs")).toBe(true);
			expect(hasDurableMemoryIntent("never push to main")).toBe(true);
			expect(hasDurableMemoryIntent("I prefer quiet")).toBe(true);
			expect(hasDurableMemoryIntent("fix the typo")).toBe(false);
		});
	});

	describe("runMemoryExtract", () => {
		function toolResultMessage(
			toolName: string,
			text: string,
			isError: boolean,
		): Extract<AgentMessage, { role: "toolResult" }> {
			return {
				role: "toolResult",
				toolCallId: "tc-1",
				toolName,
				content: [{ type: "text", text }],
				isError,
				timestamp: Date.now(),
			};
		}

		it("fails without writes when the model never calls the tool", async () => {
			const root = tempRoot();
			const agentDir = join(root, "agent");
			const cwd = join(root, "project");
			const writeProjection = vi.fn();
			const result = await runMemoryExtract({
				mode: "commit",
				agentDir,
				cwd,
				agentMode: "code",
				sessionId: "s1",
				messages: [{ role: "user", content: "remember auth", timestamp: 1 }],
				trigger: "manual",
				signal: AbortSignal.timeout(5_000),
				writeProjection,
				promptFn: async () => [
					{
						role: "assistant",
						content: [{ type: "text", text: "no tool" }],
						api: "test",
						provider: "test",
						model: "test",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "stop",
						timestamp: Date.now(),
					},
				],
			});

			expect(["failed", "skipped"]).toContain(result.status);
			expect(writeProjection).not.toHaveBeenCalled();
			const store = openMemoryStore(getMemorySqlitePath(agentDir));
			expect(store.countFacts()).toBe(0);
			store.close();
		});

		it("applies a single tool call and writes projection", async () => {
			const root = tempRoot();
			const agentDir = join(root, "agent");
			const cwd = join(root, "project");
			const writeProjection = vi.fn();

			const result = await runMemoryExtract({
				mode: "commit",
				agentDir,
				cwd,
				agentMode: "code",
				sessionId: "s1",
				messages: [{ role: "user", content: "Auth lives in app-server", timestamp: 1 }],
				trigger: "manual",
				signal: AbortSignal.timeout(5_000),
				sourceTurn: "turn-9",
				createdAt: "2026-08-21T12:00:00.000Z",
				writeProjection,
				promptFn: async ({ tool }) => {
					const agentTool = tool as AgentTool;
					const executed = await agentTool.execute(
						"tc-1",
						{
							facts: [{ text: "Auth lives in app-server", scope: "project", topicFile: "auth.md" }],
						},
						undefined,
						undefined,
					);
					return [
						{
							role: "assistant",
							content: [
								{
									type: "toolCall",
									id: "tc-1",
									name: "commit_facts",
									arguments: {
										facts: [{ text: "Auth lives in app-server", scope: "project", topicFile: "auth.md" }],
									},
								},
							],
							api: "test",
							provider: "test",
							model: "test",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "toolUse",
							timestamp: Date.now(),
						},
						toolResultMessage("commit_facts", textOf(executed), false),
					];
				},
			});

			expect(result.status).toBe("success");
			expect(writeProjection).toHaveBeenCalledOnce();
			const store = openMemoryStore(getMemorySqlitePath(agentDir));
			expect(
				store.listActiveFacts("project", memoryProjectIdentity(cwd).projectKey, null).map((f) => f.text),
			).toEqual(["Auth lives in app-server"]);
			store.close();
		});

		it("retries once on invalid payload then inserts; two invalid attempts insert nothing", async () => {
			const root = tempRoot();
			const agentDir = join(root, "agent");
			const cwd = join(root, "project");

			const ok = await runMemoryExtract({
				mode: "commit",
				agentDir,
				cwd,
				agentMode: "code",
				sessionId: "s1",
				messages: [{ role: "user", content: "remember", timestamp: 1 }],
				trigger: "manual",
				signal: AbortSignal.timeout(5_000),
				sourceTurn: "turn-1",
				createdAt: "2026-08-21T12:00:00.000Z",
				writeProjection: vi.fn(),
				promptFn: async ({ tool, attempt }) => {
					const agentTool = tool as AgentTool;
					if (attempt === 0) {
						const executed = await agentTool.execute(
							"tc-bad",
							{ facts: [{ text: "x", scope: "project", topicFile: "auth.md" }], extra: true } as never,
							undefined,
							undefined,
						);
						return [
							{
								role: "assistant",
								content: [{ type: "toolCall", id: "tc-bad", name: "commit_facts", arguments: { facts: [] } }],
								api: "test",
								provider: "test",
								model: "test",
								usage: {
									input: 0,
									output: 0,
									cacheRead: 0,
									cacheWrite: 0,
									totalTokens: 0,
									cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
								},
								stopReason: "toolUse",
								timestamp: Date.now(),
							},
							toolResultMessage("commit_facts", textOf(executed), true),
						];
					}
					const executed = await agentTool.execute(
						"tc-ok",
						{ facts: [{ text: "Retried fact", scope: "project", topicFile: "auth.md" }] },
						undefined,
						undefined,
					);
					return [
						{
							role: "assistant",
							content: [{ type: "toolCall", id: "tc-ok", name: "commit_facts", arguments: {} }],
							api: "test",
							provider: "test",
							model: "test",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "toolUse",
							timestamp: Date.now(),
						},
						toolResultMessage("commit_facts", textOf(executed), false),
					];
				},
			});
			expect(ok.status).toBe("success");
			let store = openMemoryStore(getMemorySqlitePath(agentDir));
			expect(
				store.listActiveFacts("project", memoryProjectIdentity(cwd).projectKey, null).map((f) => f.text),
			).toEqual(["Retried fact"]);
			store.close();

			const root2 = tempRoot();
			const fail = await runMemoryExtract({
				mode: "commit",
				agentDir: join(root2, "agent"),
				cwd: join(root2, "project"),
				agentMode: "code",
				sessionId: "s2",
				messages: [{ role: "user", content: "remember", timestamp: 1 }],
				trigger: "manual",
				signal: AbortSignal.timeout(5_000),
				writeProjection: vi.fn(),
				promptFn: async ({ tool }) => {
					const agentTool = tool as AgentTool;
					const executed = await agentTool.execute(
						"tc-bad",
						{ facts: [{ text: "x", scope: "workspace", topicFile: "auth.md" }] } as never,
						undefined,
						undefined,
					);
					return [
						{
							role: "assistant",
							content: [{ type: "toolCall", id: "tc-bad", name: "commit_facts", arguments: {} }],
							api: "test",
							provider: "test",
							model: "test",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "toolUse",
							timestamp: Date.now(),
						},
						toolResultMessage("commit_facts", textOf(executed), true),
					];
				},
			});
			expect(["failed", "skipped"]).toContain(fail.status);
			store = openMemoryStore(getMemorySqlitePath(join(root2, "agent")));
			expect(store.countFacts()).toBe(0);
			store.close();
		});

		it("records extract_runs audit rows", async () => {
			const root = tempRoot();
			const agentDir = join(root, "agent");
			await runMemoryExtract({
				mode: "commit",
				agentDir,
				cwd: join(root, "project"),
				agentMode: "code",
				sessionId: "s1",
				messages: [],
				trigger: "threshold",
				signal: AbortSignal.timeout(5_000),
				writeProjection: vi.fn(),
				promptFn: async () => [],
			});
			const store = openMemoryStore(getMemorySqlitePath(agentDir));
			const runs = store.listExtractRuns();
			expect(runs.length).toBeGreaterThanOrEqual(1);
			expect(runs[0]).toMatchObject({
				trigger: "threshold",
				status: expect.stringMatching(/failed|skipped/),
			});
			expect(runs[0]?.id).toBeTruthy();
			expect(runs[0]?.startedAt).toBeTruthy();
			store.close();
		});

		it("bounds reconcile candidates and excludes sibling project facts", async () => {
			const root = tempRoot();
			const agentDir = join(root, "agent");
			const cwd = join(root, "project");
			const identity = memoryProjectIdentity(cwd);
			const store = openMemoryStore(getMemorySqlitePath(agentDir));
			store.resolveProject(identity);
			for (let index = 0; index < 150; index++) {
				store.insertFact({
					id: `candidate-${index}`,
					scope: "project",
					cwdKey: identity.projectKey,
					mode: null,
					topicFile: "context.md",
					text: `${String(index).padStart(3, "0")}-${"x".repeat(1_000)}`,
					status: index < 100 ? "active" : "superseded",
					createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
					sourceTurn: `turn-${index}`,
					embedding: new Float32Array([1, 2, 3]),
					embeddingModel: "must-not-enter-prompt",
				});
			}
			store.insertFact({
				id: "sibling-candidate",
				scope: "project",
				cwdKey: "c".repeat(64),
				mode: null,
				topicFile: "private.md",
				text: "SIBLING_MARKER_MUST_NOT_ENTER_PROMPT",
				status: "active",
				createdAt: "2026-12-31T00:00:00.000Z",
				sourceTurn: "sibling",
				embedding: null,
				embeddingModel: null,
			});
			store.close();

			let captured = "";
			const result = await runMemoryExtract({
				mode: "reconcile",
				agentDir,
				cwd,
				agentMode: "code",
				sessionId: "bounded",
				messages: [],
				trigger: "test",
				signal: AbortSignal.timeout(5_000),
				writeProjection: vi.fn(),
				promptFn: async ({ tool, userPrompt }) => {
					captured = userPrompt;
					const executed = await (tool as AgentTool).execute("tc-bounded", {}, undefined, undefined);
					return [
						{
							role: "assistant",
							content: [{ type: "toolCall", id: "tc-bounded", name: "reconcile_facts", arguments: {} }],
							api: "test",
							provider: "test",
							model: "test",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "toolUse",
							timestamp: Date.now(),
						},
						toolResultMessage("reconcile_facts", textOf(executed), false),
					];
				},
			});
			expect(result.status).toBe("success");
			expect(captured.length).toBeLessThan(34_000);
			expect(captured).not.toContain("SIBLING_MARKER_MUST_NOT_ENTER_PROMPT");
			expect(captured).not.toContain("must-not-enter-prompt");
		});
	});

	it("does not leave projection unwritten after a real disk commit path", async () => {
		const root = tempRoot();
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		await runMemoryExtract({
			mode: "commit",
			agentDir,
			cwd,
			agentMode: "code",
			sessionId: "s1",
			messages: [{ role: "user", content: "Auth lives in app-server", timestamp: 1 }],
			trigger: "manual",
			signal: AbortSignal.timeout(5_000),
			sourceTurn: "turn-1",
			createdAt: "2026-08-21T12:00:00.000Z",
			promptFn: async ({ tool }) => {
				const executed = await (tool as AgentTool).execute(
					"tc-1",
					{ facts: [{ text: "Auth lives in app-server", scope: "project", topicFile: "auth.md" }] },
					undefined,
					undefined,
				);
				return [
					{
						role: "assistant",
						content: [{ type: "toolCall", id: "tc-1", name: "commit_facts", arguments: {} }],
						api: "test",
						provider: "test",
						model: "test",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: Date.now(),
					},
					{
						role: "toolResult",
						toolCallId: "tc-1",
						toolName: "commit_facts",
						content: executed.content,
						details: executed.details,
						isError: false,
						timestamp: Date.now(),
					},
				];
			},
		});
		const paths = getAutoMemoryPaths(agentDir, cwd);
		expect(existsSync(paths.project.indexPath)).toBe(true);
		expect(readFileSync(paths.project.indexPath, "utf8")).toContain("auth.md");
	});
});
