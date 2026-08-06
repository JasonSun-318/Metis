import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createScheduleWorkspace,
	ensureScheduleRunDirectory,
	getScheduleRunPath,
	removeOwnedScheduleWorkspace,
} from "../src/core/schedules/paths.ts";
import { ScheduleStore } from "../src/core/schedules/store.ts";
import type { ScheduleRun, ScheduleTask } from "../src/core/schedules/types.ts";

const roots: string[] = [];

function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "arcmind-schedules-"));
	roots.push(path);
	return path;
}

function task(id: string): ScheduleTask {
	return {
		id,
		title: `Task ${id}`,
		instruction: `Run ${id}`,
		model: { provider: "openai", modelId: "gpt-test" },
		schedule: { kind: "daily", time: "09:00" },
		timezone: "Asia/Shanghai",
		target: { kind: "general", workspace: "fixed", cwd: tempDir() },
		status: "active",
		createdAt: "2026-07-26T00:00:00Z",
		updatedAt: "2026-07-26T00:00:00Z",
		nextRunAt: "2026-07-27T01:00:00Z",
		unreadCount: 0,
		nextRunSequence: 1,
	};
}

function run(taskValue: ScheduleTask, index: number): ScheduleRun {
	const runId = `run-${String(index).padStart(3, "0")}`;
	return {
		id: runId,
		taskId: taskValue.id,
		sequence: index + 1,
		trigger: "scheduled",
		status: "succeeded",
		scheduledFor: "2026-07-26T00:00:00Z",
		createdAt: "2026-07-26T00:00:00Z",
		completedAt: "2026-07-26T00:00:01Z",
		resultPreview: `result ${index}`,
		unread: true,
		snapshot: {
			name: taskValue.title,
			instruction: taskValue.instruction,
			model: taskValue.model,
			schedule: taskValue.schedule,
			timezone: taskValue.timezone,
			target: taskValue.target,
		},
	};
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("schedule store", () => {
	it("reads v1 tasks and runs without writing, then persists v2 on the next mutation", async () => {
		const agentDir = tempDir();
		const currentTask = task("legacy-task");
		const legacyTask = { ...currentTask } as unknown as Record<string, unknown>;
		delete legacyTask.model;
		writeFileSync(
			join(agentDir, "schedules.json"),
			JSON.stringify({ version: 1, revision: 0, tasks: [legacyTask], events: [] }),
		);
		const store = ScheduleStore.open(agentDir);
		const migrated = store.readIndex().tasks[0];
		expect(migrated).toMatchObject({
			title: currentTask.title,
			model: { provider: "legacy", modelId: "unassigned" },
			status: "paused",
			pauseReason: "model_unavailable",
			nextRunAt: null,
		});
		expect(JSON.parse(readFileSync(join(agentDir, "schedules.json"), "utf8")).version).toBe(1);

		const legacyRun = run(currentTask, 0) as unknown as Record<string, unknown>;
		const legacySnapshot = legacyRun.snapshot as Record<string, unknown>;
		delete legacySnapshot.name;
		delete legacySnapshot.model;
		ensureScheduleRunDirectory(agentDir, currentTask.id);
		writeFileSync(getScheduleRunPath(agentDir, currentTask.id, 1, "run-000"), JSON.stringify(legacyRun));
		expect(store.getRun(currentTask.id, "run-000").snapshot).toMatchObject({
			name: currentTask.title,
			model: { provider: "legacy", modelId: "unassigned" },
		});

		await store.mutate((draft) => {
			draft.tasks[0] = { ...draft.tasks[0], description: "migrated" };
		});
		expect(JSON.parse(readFileSync(join(agentDir, "schedules.json"), "utf8")).version).toBe(2);
	});

	it("rejects removed Code targets and source-session fields", async () => {
		for (const legacy of [
			{ ...task("legacy-project"), target: { kind: "project", cwd: tempDir() } },
			{ ...task("legacy-source"), createdFromSessionId: "source-session" },
		]) {
			const store = ScheduleStore.open(tempDir());
			await expect(
				store.mutate((draft) => draft.tasks.push(legacy as unknown as ScheduleTask)),
			).rejects.toMatchObject({ code: "STORE_CORRUPT" });
		}
	});

	it("keeps unbounded run history out of the bounded task index", async () => {
		const agentDir = tempDir();
		const store = ScheduleStore.open(agentDir);
		const taskValue = task("task-1");
		await store.mutate((draft, files) => {
			draft.tasks.push({ ...taskValue, nextRunSequence: 301 });
			for (let index = 0; index < 300; index += 1) files.createRun(run(taskValue, index));
		});
		const indexText = readFileSync(join(agentDir, "schedules.json"), "utf8");
		expect(indexText).not.toContain("run-000");
		expect(store.listRuns("task-1", { limit: 50 }).runs).toHaveLength(50);
		expect(store.listRuns("task-1", { limit: 50 }).nextBeforeRunId).toBe("run-250");
	});

	it("serializes concurrent mutations without losing either task", async () => {
		const agentDir = tempDir();
		const first = ScheduleStore.open(agentDir);
		const second = ScheduleStore.open(agentDir);
		await Promise.all([
			first.mutate((draft) => draft.tasks.push(task("task-a"))),
			second.mutate((draft) => draft.tasks.push(task("task-b"))),
		]);
		expect(
			ScheduleStore.open(agentDir)
				.readIndex()
				.tasks.map(({ id }) => id)
				.sort(),
		).toEqual(["task-a", "task-b"]);
	});

	it("creates and replaces run files atomically", async () => {
		const agentDir = tempDir();
		const store = ScheduleStore.open(agentDir);
		const taskValue = task("task-atomic");
		const queued = { ...run(taskValue, 0), status: "queued" as const, completedAt: undefined };
		await store.mutate((draft, files) => {
			draft.tasks.push(taskValue);
			files.createRun(queued);
		});
		await store.mutate((_draft, files) => files.replaceRun({ ...queued, status: "failed", unread: true }));
		expect(store.getRun(taskValue.id, queued.id).status).toBe("failed");
	});

	it("never removes a fixed directory or a forged schedule workspace", () => {
		const agentDir = tempDir();
		const project = tempDir();
		expect(removeOwnedScheduleWorkspace(agentDir, "task-1", project)).toBe(false);
		expect(existsSync(project)).toBe(true);
		const owned = createScheduleWorkspace(agentDir, "task-1");
		expect(removeOwnedScheduleWorkspace(agentDir, "task-2", owned)).toBe(false);
		expect(existsSync(owned)).toBe(true);
		expect(removeOwnedScheduleWorkspace(agentDir, "task-1", owned)).toBe(true);
		expect(removeOwnedScheduleWorkspace(agentDir, "task-1", owned)).toBe(true);
	});

	it.skipIf(process.platform === "win32")("does not treat a broken workspace symlink as already deleted", () => {
		const agentDir = tempDir();
		const owned = createScheduleWorkspace(agentDir, "task-1");
		rmSync(owned, { recursive: true, force: true });
		symlinkSync(join(agentDir, "missing-target"), owned);
		expect(removeOwnedScheduleWorkspace(agentDir, "task-1", owned)).toBe(false);
		expect(lstatSync(owned).isSymbolicLink()).toBe(true);
	});

	it.skipIf(process.platform === "win32")("rejects symlinked roots", () => {
		const agentDir = tempDir();
		const outside = tempDir();
		symlinkSync(outside, join(agentDir, "schedule-runs"), "dir");
		expect(() => ScheduleStore.open(agentDir).readIndex()).toThrowError(
			expect.objectContaining({ code: "STORE_CORRUPT" }),
		);
	});

	it("rejects oversized indexes and malformed versions", () => {
		const oversizedAgentDir = tempDir();
		mkdirSync(join(oversizedAgentDir, "schedule-runs"));
		mkdirSync(join(oversizedAgentDir, "schedule-workspaces"));
		writeFileSync(join(oversizedAgentDir, "schedules.json"), "x".repeat(4 * 1024 * 1024 + 1));
		expect(() => ScheduleStore.open(oversizedAgentDir).readIndex()).toThrowError(
			expect.objectContaining({ code: "STORE_CORRUPT" }),
		);

		const versionAgentDir = tempDir();
		writeFileSync(
			join(versionAgentDir, "schedules.json"),
			JSON.stringify({ version: 3, revision: 0, tasks: [], events: [] }),
		);
		expect(() => ScheduleStore.open(versionAgentDir).readIndex()).toThrowError(
			expect.objectContaining({ code: "STORE_CORRUPT" }),
		);

		const timestampAgentDir = tempDir();
		writeFileSync(
			join(timestampAgentDir, "schedules.json"),
			JSON.stringify({
				version: 1,
				revision: 0,
				tasks: [{ ...task("task-bad-time"), createdAt: "0" }],
				events: [],
			}),
		);
		expect(() => ScheduleStore.open(timestampAgentDir).readIndex()).toThrowError(
			expect.objectContaining({ code: "STORE_CORRUPT" }),
		);
	});
});
