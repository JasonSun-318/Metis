import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CURRENT_SESSION_VERSION, SessionManager } from "../src/core/session-manager.ts";

const roots: string[] = [];

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "arcmind-scheduled-session-"));
	roots.push(root);
	const cwd = join(root, "workspace");
	const sessionDir = join(root, "sessions");
	mkdirSync(cwd);
	mkdirSync(sessionDir);
	return { root, cwd, sessionDir };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("scheduled session metadata", () => {
	it("persists hidden metadata, excludes ordinary lists, and permits exact read-only open", async () => {
		const { cwd, sessionDir } = fixture();
		const manager = SessionManager.create(cwd, sessionDir, {
			id: "session-scheduled",
			mode: "chat",
			cwdOrigin: "user-selected",
			scheduled: { taskId: "task-1", runId: "run-1" },
		});
		const path = manager.getSessionFile()!;
		expect(manager.getHeader()).toMatchObject({
			version: CURRENT_SESSION_VERSION,
			scheduled: { taskId: "task-1", runId: "run-1" },
		});
		manager.close();
		expect(await SessionManager.list(cwd, sessionDir)).toEqual([]);
		expect(await SessionManager.listAll(sessionDir)).toEqual([]);
		expect(SessionManager.openReadOnly(path).getHeader()?.scheduled).toEqual({ taskId: "task-1", runId: "run-1" });
	});

	it("rejects malformed, legacy, and mixed ownership markers", () => {
		const { cwd, sessionDir } = fixture();
		const base = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: "session-invalid",
			timestamp: "2026-07-26T00:00:00Z",
			cwd,
			mode: "code",
			cwdOrigin: "user-selected",
			permissionMode: "ask",
		};
		const malformed = join(sessionDir, "malformed.jsonl");
		writeFileSync(malformed, `${JSON.stringify({ ...base, scheduled: { taskId: "../escape", runId: "run-1" } })}\n`);
		expect(() => SessionManager.openReadOnly(malformed)).toThrow(/scheduled id/);

		const legacy = join(sessionDir, "legacy.jsonl");
		writeFileSync(
			legacy,
			`${JSON.stringify({ ...base, version: 9, scheduled: { taskId: "task-1", runId: "run-1" } })}\n`,
		);
		expect(() => SessionManager.openReadOnly(legacy)).toThrow(/v10/);

		const mixed = join(sessionDir, "mixed.jsonl");
		writeFileSync(
			mixed,
			`${JSON.stringify({
				...base,
				scheduled: { taskId: "task-1", runId: "run-1" },
				subagent: { agentId: "agent-1", name: "child", parentSessionId: "parent-1" },
			})}\n`,
		);
		expect(() => SessionManager.openReadOnly(mixed)).toThrow(/both scheduled and a subagent/);
	});

	it("rejects branch, fork, import, and mismatched permanent deletion", async () => {
		const { root, cwd, sessionDir } = fixture();
		const manager = SessionManager.create(cwd, sessionDir, {
			id: "session-owned",
			scheduled: { taskId: "task-owned", runId: "run-owned" },
		});
		const path = manager.getSessionFile()!;
		expect(() => manager.createBranchedSessionManager(null)).toThrow(/read-only/);
		manager.close();
		expect(() => SessionManager.forkFrom(path, cwd, sessionDir)).toThrow(/read-only/);
		expect(() => SessionManager.importFrom(path, join(root, "copy.jsonl"))).toThrow(/read-only/);

		expect(
			await SessionManager.deleteSession(path, {
				permanent: true,
				expectedScheduled: { taskId: "task-other", runId: "run-owned" },
			}),
		).toMatchObject({ ok: false });
		expect(existsSync(path)).toBe(true);
		expect(
			await SessionManager.deleteSession(path, {
				permanent: true,
				expectedScheduled: { taskId: "task-owned", runId: "run-owned" },
			}),
		).toEqual({ ok: true, method: "unlink" });
		expect(existsSync(path)).toBe(false);
		expect(
			await SessionManager.deleteSession(path, {
				permanent: true,
				expectedScheduled: { taskId: "task-owned", runId: "run-owned" },
			}),
		).toEqual({ ok: true, method: "unlink" });
	});
});
