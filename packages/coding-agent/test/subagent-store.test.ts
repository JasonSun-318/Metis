import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_SESSION_VERSION, getSessionAgentDir, SessionManager } from "../src/core/session-manager.ts";
import { AgentStore } from "../src/core/subagents/store.ts";
import type { AgentConfig } from "../src/core/subagents/types.ts";

const ROOT_ID = "parent-session-1";
const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(): { root: string; agentDir: string; parent: SessionManager; store: AgentStore } {
	const root = mkdtempSync(join(tmpdir(), "metis-agent-store-"));
	roots.push(root);
	const project = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(project);
	const parent = SessionManager.create(project, join(root, "sessions"), { id: ROOT_ID });
	return { root, agentDir, parent, store: new AgentStore(parent, agentDir) };
}

function config(
	root: string,
	overrides?: Partial<AgentConfig> & { readonly taskId?: string },
): {
	config: AgentConfig;
	taskId: string;
} {
	const agentId = overrides?.agentId ?? "agent-1";
	const taskId = overrides?.taskId ?? "task-1";
	return {
		taskId,
		config: {
			agentId,
			name: overrides?.name ?? "worker",
			agentType: overrides?.agentType ?? "worker",
			initialTask: overrides?.initialTask ?? "Implement the manager",
			tools: overrides?.tools ?? ["read", "bash"],
			writePolicy: overrides?.writePolicy ?? "inherit",
			permissionMode: overrides?.permissionMode ?? "ask",
			model: overrides?.model ?? { provider: "openai", modelId: "gpt-test" },
			thinkingLevel: overrides?.thinkingLevel ?? "high",
			cwd: overrides?.cwd ?? join(root, "project"),
			forkTurns: overrides?.forkTurns ?? 0,
			timeoutSeconds: overrides?.timeoutSeconds ?? 60,
			mayDelegate: overrides?.mayDelegate ?? true,
			parentSessionId: overrides?.parentSessionId ?? ROOT_ID,
			rootSessionId: overrides?.rootSessionId ?? ROOT_ID,
			agentPath: overrides?.agentPath ?? [agentId],
		},
	};
}

describe("AgentStore", () => {
	it("persists one canonical agent header and distinct task ids", () => {
		const { root, store } = setup();
		const { config: agentConfig, taskId } = config(root, { agentId: "agent-1", taskId: "task-1" });
		const created = store.create(agentConfig, [], taskId);
		store.appendTask("agent-1", { taskId: "task-2", text: "verify again", status: "queued" });
		expect(created.header).toMatchObject({ agentId: "agent-1", rootSessionId: ROOT_ID });
		expect(store.listTasks("agent-1").map((task) => task.taskId)).toEqual(["task-1", "task-2"]);
	});

	it("preserves task creation time across state transitions", () => {
		const { root, store } = setup();
		const { config: agentConfig, taskId } = config(root);
		store.create(agentConfig, [], taskId);
		const createdAt = store.listTasks(agentConfig.agentId)[0]!.createdAt;
		store.appendTaskState(agentConfig.agentId, { taskId, status: "running" });
		store.appendTaskState(agentConfig.agentId, { taskId, status: "done", finalMessage: "complete" });
		const task = store.listTasks(agentConfig.agentId)[0]!;
		expect(task.createdAt).toBe(createdAt);
		expect(task.updatedAt >= task.createdAt).toBe(true);
	});

	it("does not scan the removed subagents directory", () => {
		const { agentDir, store } = setup();
		mkdirSync(join(agentDir, "subagents", ROOT_ID), { recursive: true });
		writeFileSync(join(agentDir, "subagents", ROOT_ID, "old-child.jsonl"), "legacy sentinel");
		expect(store.listTree().agents).toEqual([]);
		expect(getSessionAgentDir(agentDir, ROOT_ID)).toBe(join(agentDir, "agents", ROOT_ID));
	});

	it("writes v13 agent headers and agent_task records", () => {
		const { root, store } = setup();
		const { config: agentConfig, taskId } = config(root);
		const created = store.create(agentConfig, [], taskId);
		const journal = store.readJournal(created.agentId);
		const header = journal[0];
		expect(header.type).toBe("session");
		if (header.type !== "session") throw new Error("expected session header");
		expect(header.version).toBe(CURRENT_SESSION_VERSION);
		expect(header.agent?.agentType).toBe("worker");
		expect(journal.some((entry) => entry.type === "agent_task")).toBe(true);
		expect(existsSync(created.path)).toBe(true);
	});
});
