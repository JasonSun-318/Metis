import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createSessionWorkDir,
	getSessionAttachmentDir,
	writeSessionDeliveredFile,
} from "../src/core/session-attachments.ts";
import {
	getSessionAgentDir,
	getSessionImageDir,
	getSessionToolOutputDir,
	SessionManager,
} from "../src/core/session-manager.ts";
import { AgentStore } from "../src/core/subagents/store.ts";
import type { AgentConfig } from "../src/core/subagents/types.ts";

const trash = vi.hoisted(() => ({ trashPathsSync: vi.fn<(paths: readonly string[]) => string | undefined>() }));
vi.mock("../src/utils/trash.ts", () => trash);
const roots: string[] = [];
const managers: SessionManager[] = [];

afterEach(() => {
	for (const manager of managers.splice(0)) manager.close();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	trash.trashPathsSync.mockReset();
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "metis-delete-agent-tree-"));
	roots.push(root);
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	const trashDir = join(root, "trash");
	mkdirSync(cwd);
	mkdirSync(trashDir);
	let trashed = 0;
	trash.trashPathsSync.mockImplementation((paths) => {
		for (const path of paths) renameSync(path, join(trashDir, `${++trashed}-${basename(path)}`));
		return undefined;
	});
	const parent = SessionManager.create(cwd, join(root, "sessions"), { id: "root-session" });
	managers.push(parent);
	parent.appendMessage({ role: "user", content: "parent history", timestamp: Date.now() });
	const store = new AgentStore(parent, agentDir);
	const config = (agentId: string, parentSessionId = parent.getSessionId()): AgentConfig => ({
		agentId,
		name: agentId,
		agentType: "worker",
		initialTask: "task",
		tools: ["read"],
		writePolicy: "inherit",
		permissionPreset: "ask",
		model: { provider: "test", modelId: "test" },
		thinkingLevel: "off",
		cwd,
		forkTurns: 0,
		timeoutSeconds: 60,
		mayDelegate: true,
		parentSessionId,
		rootSessionId: parent.getSessionId(),
		agentPath: parentSessionId === parent.getSessionId() ? [agentId] : [parentSessionId, agentId],
	});
	const child = store.create(config("child-session"), [], "child-task");
	const grandchild = store.create(config("grandchild-session", child.agentId), [], "grandchild-task");
	const owned: string[] = [getSessionAgentDir(agentDir, parent.getSessionId())];
	for (const id of [parent.getSessionId(), child.agentId, grandchild.agentId]) {
		writeSessionDeliveredFile(agentDir, id, "aaaaaaaaaaaaaaaa", "generated.png", Buffer.from("owned image"));
		owned.push(getSessionAttachmentDir(agentDir, id));
		const work = createSessionWorkDir(agentDir, id);
		writeFileSync(join(work, "temporary.txt"), "owned work");
		owned.push(work);
	}
	for (const record of [child, grandchild]) {
		for (const directory of [getSessionImageDir(record.path), getSessionToolOutputDir(record.path)]) {
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, "payload"), "owned journal asset");
		}
	}
	writeSessionDeliveredFile(agentDir, "unrelated-session", "bbbbbbbbbbbbbbbb", "keep.txt", Buffer.from("unrelated"));
	const unrelated = getSessionAttachmentDir(agentDir, "unrelated-session");
	const unrelatedWork = createSessionWorkDir(agentDir, "unrelated-session");
	const external = join(cwd, "user-file.txt");
	writeFileSync(external, "user-owned content");
	const path = parent.getSessionFile()!;
	parent.close();
	return { root, cwd, agentDir, parent, store, path, child, grandchild, owned, unrelated, unrelatedWork, external };
}

describe("root session deletion", () => {
	it("cascades child and grandchild journals, generated images and work directories while preserving unrelated data", async () => {
		const value = fixture();
		value.store.setArchived(value.child.agentId, true);
		const result = await SessionManager.deleteSession(value.path, { agentDir: value.agentDir });
		expect(result).toEqual({ ok: true, method: "trash" });
		for (const path of [value.path, value.child.path, value.grandchild.path, ...value.owned])
			expect(existsSync(path), path).toBe(false);
		expect(existsSync(value.unrelated)).toBe(true);
		expect(existsSync(value.unrelatedWork)).toBe(true);
		expect(readFileSync(value.external, "utf8")).toBe("user-owned content");
	});

	it("preserves the whole tree when a descendant still has a writer", async () => {
		const value = fixture();
		const writer = SessionManager.open(value.grandchild.path);
		managers.push(writer);
		const result = await SessionManager.deleteSession(value.path, { agentDir: value.agentDir });
		expect(result).toMatchObject({ ok: false, code: "SESSION_IN_USE" });
		expect(trash.trashPathsSync).not.toHaveBeenCalled();
		for (const path of [value.path, value.child.path, value.grandchild.path, ...value.owned])
			expect(existsSync(path), path).toBe(true);
	});
});
