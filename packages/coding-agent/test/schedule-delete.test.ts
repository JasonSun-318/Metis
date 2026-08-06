import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeScheduledTaskTrash, trashScheduledTaskData } from "../src/core/schedules/delete.ts";
import { createScheduleWorkspace } from "../src/core/schedules/paths.ts";
import type { ScheduleRun, ScheduleTask } from "../src/core/schedules/types.ts";
import { SessionLease } from "../src/core/session-lease.ts";
import { getDefaultSessionDir, getSessionImageDir, SessionManager } from "../src/core/session-manager.ts";

const roots: string[] = [];

function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "arcmind-schedule-delete-"));
	roots.push(path);
	return path;
}

function fixture() {
	const agentDir = tempDir();
	const taskId = "10000000-0000-4000-8000-000000000001";
	const runId = "10000000-0000-4000-8000-000000000002";
	const sessionId = "10000000-0000-4000-8000-000000000003";
	const workspace = createScheduleWorkspace(agentDir, taskId);
	writeFileSync(join(workspace, "task-output.txt"), "owned");
	const additionalWorkspaceCwd = tempDir();
	writeFileSync(join(additionalWorkspaceCwd, "user-file.txt"), "keep");
	const session = SessionManager.create(workspace, getDefaultSessionDir(workspace, agentDir), {
		id: sessionId,
		mode: "chat",
		cwdOrigin: "managed",
		scheduled: { taskId, runId },
	});
	session.appendSessionInfo("Morning brief");
	const sessionFile = session.getSessionFile()!;
	session.close();
	const imageDir = getSessionImageDir(sessionFile);
	mkdirSync(imageDir, { recursive: true });
	writeFileSync(join(imageDir, "owned.png"), "image");
	const task: ScheduleTask = {
		id: taskId,
		title: "Morning brief",
		description: "Weekday summary",
		instruction: "Summarize the morning",
		model: { provider: "openai", modelId: "gpt-test" },
		schedule: { kind: "daily", time: "08:00" },
		timezone: "Asia/Shanghai",
		target: { kind: "general", workspace: "task", cwd: workspace, additionalWorkspaceCwd },
		status: "deleting",
		createdAt: "2026-07-31T00:00:00Z",
		updatedAt: "2026-07-31T00:00:00Z",
		nextRunAt: null,
		unreadCount: 0,
		nextRunSequence: 2,
	};
	const run: ScheduleRun = {
		id: runId,
		taskId,
		sequence: 1,
		trigger: "scheduled",
		status: "succeeded",
		scheduledFor: "2026-07-31T00:00:00Z",
		createdAt: "2026-07-31T00:00:00Z",
		completedAt: "2026-07-31T00:01:00Z",
		sessionId,
		sessionFile,
		unread: true,
		snapshot: {
			name: task.title,
			description: task.description,
			instruction: task.instruction,
			model: task.model,
			schedule: task.schedule,
			timezone: task.timezone,
			target: task.target,
		},
	};
	return { agentDir, task, run, workspace, additionalWorkspaceCwd, sessionFile, imageDir };
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("scheduled task aggregate Trash", () => {
	it("retains generated sessions when unchecked and trashes only the owned task workspace", async () => {
		const value = fixture();
		const trash = vi.fn((payload: string) => rmSync(payload, { recursive: true }));
		const result = await trashScheduledTaskData(
			{ agentDir: value.agentDir, task: value.task, runs: [value.run], deleteSessions: false },
			{ trash },
		);
		expect(result).toEqual({ deletedSessionCount: 0, retainedSessionCount: 1 });
		expect(trash).toHaveBeenCalledTimes(1);
		expect(existsSync(value.workspace)).toBe(false);
		expect(existsSync(value.sessionFile)).toBe(true);
		expect(readFileSync(join(value.additionalWorkspaceCwd, "user-file.txt"), "utf8")).toBe("keep");
		finalizeScheduledTaskTrash(value.agentDir, value.task.id);
	});

	it("moves the journal and path-owned assets through one Trash invocation when checked", async () => {
		const value = fixture();
		const trash = vi.fn((payload: string) => rmSync(payload, { recursive: true }));
		const result = await trashScheduledTaskData(
			{ agentDir: value.agentDir, task: value.task, runs: [value.run], deleteSessions: true },
			{ trash },
		);
		expect(result).toEqual({ deletedSessionCount: 1, retainedSessionCount: 0 });
		expect(trash).toHaveBeenCalledTimes(1);
		for (const path of [value.workspace, value.sessionFile, value.imageDir]) expect(existsSync(path)).toBe(false);
		expect(readFileSync(join(value.additionalWorkspaceCwd, "user-file.txt"), "utf8")).toBe("keep");
		finalizeScheduledTaskTrash(value.agentDir, value.task.id);
		expect(readdirSync(join(value.agentDir, "schedule-trash"))).toEqual([]);
	});

	it("rolls every staged path back when Trash fails", async () => {
		const value = fixture();
		await expect(
			trashScheduledTaskData(
				{ agentDir: value.agentDir, task: value.task, runs: [value.run], deleteSessions: true },
				{ trash: () => Promise.reject(new Error("trash failed")) },
			),
		).rejects.toThrow("trash failed");
		for (const path of [value.workspace, value.sessionFile, value.imageDir]) expect(existsSync(path)).toBe(true);
		expect(readdirSync(join(value.agentDir, "schedule-trash"))).toEqual([]);
	});

	it("rolls back a partial staging failure without invoking Trash", async () => {
		const value = fixture();
		let renames = 0;
		const trash = vi.fn();
		await expect(
			trashScheduledTaskData(
				{ agentDir: value.agentDir, task: value.task, runs: [value.run], deleteSessions: true },
				{
					rename: (source, destination) => {
						if (++renames === 2) throw new Error("staging failed");
						renameSync(source, destination);
					},
					trash,
				},
			),
		).rejects.toThrow("staging failed");
		expect(trash).not.toHaveBeenCalled();
		for (const path of [value.workspace, value.sessionFile, value.imageDir]) expect(existsSync(path)).toBe(true);
	});

	it("releases every acquired session lease when a later ownership check fails", async () => {
		const value = fixture();
		const forgedSessionId = "10000000-0000-4000-8000-000000000005";
		const forgedSession = SessionManager.create(
			value.workspace,
			getDefaultSessionDir(value.workspace, value.agentDir),
			{
				id: forgedSessionId,
				mode: "chat",
				cwdOrigin: "managed",
				scheduled: { taskId: value.task.id, runId: "10000000-0000-4000-8000-000000000006" },
			},
		);
		const forgedSessionFile = forgedSession.getSessionFile()!;
		forgedSession.close();
		const forgedRun = {
			...value.run,
			id: "10000000-0000-4000-8000-000000000004",
			sessionId: forgedSessionId,
			sessionFile: forgedSessionFile,
		};
		await expect(
			trashScheduledTaskData({
				agentDir: value.agentDir,
				task: value.task,
				runs: [value.run, forgedRun],
				deleteSessions: true,
			}),
		).rejects.toThrow("ownership does not match");
		expect(existsSync(`${value.sessionFile}.lease`)).toBe(false);
		const lease = SessionLease.acquireTransient(value.sessionFile);
		lease.close();
	});
});
