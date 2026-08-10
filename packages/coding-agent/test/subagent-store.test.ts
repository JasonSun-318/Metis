import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { SubagentManager } from "../src/core/subagents/manager.ts";
import { SubagentStore } from "../src/core/subagents/store.ts";
import type { SubagentConfig } from "../src/core/subagents/types.ts";
import { assistantMsg, userMsg } from "./utilities.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(): { root: string; agentDir: string; parent: SessionManager; store: SubagentStore } {
	const root = mkdtempSync(join(tmpdir(), "metis-subagent-store-"));
	roots.push(root);
	const project = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(project);
	const parent = SessionManager.create(project, join(root, "sessions"), { id: "parent-session-1" });
	return { root, agentDir, parent, store: new SubagentStore(parent, agentDir) };
}

function config(root: string): SubagentConfig {
	return {
		agentId: "child-session-1",
		name: "researcher",
		task: "Inspect the implementation",
		taskSummary: "Inspect the implementation",
		mode: "code",
		tools: ["read"],
		permissionMode: "ask",
		model: { provider: "openai", modelId: "gpt-test" },
		thinkingLevel: "high",
		cwd: join(root, "project"),
		forkTurns: "all",
		timeoutSeconds: 60,
	};
}

describe("SubagentStore", () => {
	it("creates, discovers, and reduces a parent-owned child journal", () => {
		const { root, parent, store } = setup();
		const created = store.create(config(root), []);
		expect(existsSync(created.path)).toBe(true);
		expect(created.agentId).toBe("child-session-1");
		expect(store.list().agents).toMatchObject([{ agentId: "child-session-1", status: "queued" }]);
		const serialized = JSON.stringify(store.readJournal(created.agentId));
		expect(serialized).not.toContain("reviewerEnabled");
		expect(serialized).not.toContain("readPaths");
		expect(serialized).not.toContain("writePaths");

		const running = store.appendState(created.agentId, {
			type: "subagent_state",
			agentId: created.agentId,
			runId: "run-1",
			status: "running",
		});
		expect(running.status).toBe("running");
		parent.close();
	});

	it("persists delivery mode for one run and defaults legacy runs to background", () => {
		const { root, parent, store } = setup();
		const created = store.create(config(root), []);
		store.appendState(created.agentId, {
			type: "subagent_state",
			agentId: created.agentId,
			runId: "run-foreground",
			status: "queued",
			background: false,
		});
		const terminal = store.appendState(created.agentId, {
			type: "subagent_state",
			agentId: created.agentId,
			runId: "run-foreground",
			status: "done",
			reason: "completed",
			finalSummary: "done",
		});
		expect(terminal).toMatchObject({ runId: "run-foreground", status: "done", background: false });

		const legacy = store.appendState(created.agentId, {
			type: "subagent_state",
			agentId: created.agentId,
			runId: "run-legacy",
			status: "queued",
		});
		expect(legacy.background).toBe(true);
		parent.close();
	});

	it("forks only visible messages and strips assistant thinking and custom details", () => {
		const { root, parent, store } = setup();
		const assistant = assistantMsg("visible answer");
		const created = store.create(config(root), [
			userMsg("visible question"),
			{ ...assistant, content: [{ type: "thinking" as const, thinking: "hidden reasoning" }, ...assistant.content] },
			{
				role: "custom",
				customType: "hidden",
				content: "secret",
				display: false,
				details: { secret: true },
				timestamp: 1,
			},
			{
				role: "custom",
				customType: "visible",
				content: "visible notice",
				display: true,
				details: { secret: true },
				timestamp: 2,
			},
		]);
		const journal = store.readJournal(created.agentId);
		expect(JSON.stringify(journal)).toContain("visible question");
		expect(JSON.stringify(journal)).toContain("visible answer");
		expect(JSON.stringify(journal)).toContain("visible notice");
		expect(JSON.stringify(journal)).not.toContain("hidden reasoning");
		expect(JSON.stringify(journal)).not.toContain("secret");
		parent.close();
	});

	it("rejects in-memory and nested parents", () => {
		const root = mkdtempSync(join(tmpdir(), "metis-subagent-store-invalid-"));
		roots.push(root);
		const memory = SessionManager.inMemory(root);
		expect(() => new SubagentStore(memory, join(root, "agent"))).toThrow("persisted parent");
		memory.close();
	});

	it("recovers interrupted work as stopped and cancels queued follow-ups", () => {
		const { root, agentDir, parent, store } = setup();
		const created = store.create(config(root), []);
		store.appendState(created.agentId, {
			type: "subagent_state",
			agentId: created.agentId,
			runId: "run-1",
			status: "running",
		});
		store.appendFollowUp(created.agentId, {
			type: "subagent_follow_up",
			agentId: created.agentId,
			runId: "run-1",
			messageId: "follow-up-1",
			text: "Continue after restart",
			state: "queued",
		});

		new SubagentManager({
			parentSessionManager: parent,
			agentDir,
			getWorkspaceRoots: () => parent.getWorkspaceRoots(),
			store,
			createChildRuntime: async () => {
				throw new Error("Recovery must not start child work");
			},
		});

		expect(store.load(created.agentId).status).toBe("stopped");
		expect(
			store
				.readJournal(created.agentId)
				.flatMap((entry) =>
					entry.type === "subagent_follow_up" && entry.messageId === "follow-up-1" ? [entry.state] : [],
				),
		).toEqual(["queued", "cancelled"]);
		parent.close();
	});

	it("closes by deleting child data and retaining one parent tombstone", async () => {
		const { root, parent, store } = setup();
		const created = store.create(config(root), []);
		const tombstone = {
			agentId: created.agentId,
			name: created.name,
			status: "closed" as const,
			taskSummary: created.taskSummary,
			closedAt: new Date().toISOString(),
		};
		store.beginClose(created.agentId, tombstone);
		await store.recoverCloseMarkers();
		expect(existsSync(created.path)).toBe(false);
		expect(await store.finishClose(created.agentId)).toEqual({ status: "closed" });
		expect(
			parent
				.getDurableJournalSnapshot()
				.filter((entry) => entry.type === "subagent_closed" && entry.tombstone.agentId === created.agentId),
		).toHaveLength(1);
		parent.close();
	});

	it("never mistakes an unreadable residual child for a completed deletion", async () => {
		const { root, parent, store } = setup();
		const created = store.create(config(root), []);
		const tombstone = {
			agentId: created.agentId,
			name: created.name,
			status: "closed" as const,
			taskSummary: created.taskSummary,
			closedAt: new Date().toISOString(),
		};
		store.beginClose(created.agentId, tombstone);
		writeFileSync(created.path, "not-jsonl\n", "utf8");

		await expect(store.finishClose(created.agentId)).rejects.toThrow("still exists but cannot be verified");
		expect(existsSync(created.path)).toBe(true);
		expect(
			parent
				.getDurableJournalSnapshot()
				.some((entry) => entry.type === "subagent_closed" && entry.tombstone.agentId === created.agentId),
		).toBe(false);
		parent.close();
	});
});
