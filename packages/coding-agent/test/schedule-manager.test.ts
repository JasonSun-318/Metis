import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ScheduleManager } from "../src/core/schedules/manager.ts";
import { ScheduleStore } from "../src/core/schedules/store.ts";
import { ScheduleError, type ScheduleRun } from "../src/core/schedules/types.ts";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";

const roots: string[] = [];
const fixedNow = () => new Date("2026-07-26T00:00:00Z");

async function eventually(assertion: () => void | Promise<void>, timeoutMs = 5_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			await assertion();
			return;
		} catch (error) {
			lastError = error;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	throw lastError;
}

function deferredExecutor() {
	type Pending = {
		claim: Parameters<NonNullable<Parameters<typeof ScheduleManager.create>[0]["execute"]>>[0];
		resolve: (value: { runId: string; sessionId: string; sessionFile: string; result: string }) => void;
		reject: (error: Error) => void;
	};
	const pending: Pending[] = [];
	let active = 0;
	let maximumActive = 0;
	let aborted = 0;
	return {
		pending,
		get active() {
			return active;
		},
		get maximumActive() {
			return maximumActive;
		},
		get aborted() {
			return aborted;
		},
		run: (claim: Pending["claim"], signal: AbortSignal) =>
			new Promise<{ runId: string; sessionId: string; sessionFile: string; result: string }>((resolve, reject) => {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				const finish = <T>(callback: (value: T) => void, value: T) => {
					active -= 1;
					callback(value);
				};
				const entry: Pending = {
					claim,
					resolve: (value) => finish(resolve, value),
					reject: (error) => finish(reject, error),
				};
				pending.push(entry);
				signal.addEventListener(
					"abort",
					() => {
						aborted += 1;
						entry.reject(new Error("aborted"));
					},
					{ once: true },
				);
			}),
		finish(index = 0) {
			const entry = pending[index];
			entry.resolve({
				runId: entry.claim.runId,
				sessionId: entry.claim.sessionId,
				sessionFile: join(tempDir(), `${entry.claim.runId}.jsonl`),
				result: "ok",
			});
		},
	};
}

function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "arcmind-schedule-manager-"));
	roots.push(path);
	return path;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("schedule manager", () => {
	it("derives a deterministic title and creates the task-owned workspace once", async () => {
		const agentDir = tempDir();
		const manager = ScheduleManager.create({ agentDir, now: fixedNow });
		const input = {
			id: "018f0000-0000-7000-8000-000000000001",
			instruction: "每天整理下载目录并输出摘要",
			schedule: { kind: "daily", time: "09:00" } as const,
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" } as const,
		};
		const task = await manager.create(input);
		expect(task.title).toBe("每天整理下载目录并输出摘要");
		expect(task.target).toMatchObject({ kind: "general", workspace: "task" });
		expect(existsSync(task.target.cwd)).toBe(true);
		expect((await manager.create(input)).id).toBe(task.id);
		await expect(manager.create({ ...input, instruction: "different" })).rejects.toMatchObject({
			code: "TASK_ID_REUSED",
		});
	});

	it("idempotently creates one task-owned workspace across concurrent hosts", async () => {
		const agentDir = tempDir();
		const input = {
			id: "task-create-race",
			instruction: "same request",
			schedule: { kind: "daily", time: "09:00" } as const,
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" } as const,
		};
		const [first, second] = await Promise.all([
			ScheduleManager.create({ agentDir, now: fixedNow }).create(input),
			ScheduleManager.create({ agentDir, now: fixedNow }).create(input),
		]);
		expect(second).toEqual(first);
		expect(existsSync(first.target.cwd)).toBe(true);
	});

	it("idempotently enqueues one manual run across concurrent hosts", async () => {
		const agentDir = tempDir();
		const firstHost = ScheduleManager.create({ agentDir, now: fixedNow });
		const secondHost = ScheduleManager.create({ agentDir, now: fixedNow });
		const task = await firstHost.create({
			id: "task-run-race",
			instruction: "same run request",
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});
		const [first, second] = await Promise.all([
			firstHost.runNow(task.id, "run-request-race"),
			secondHost.runNow(task.id, "run-request-race"),
		]);
		expect(second).toEqual(first);
		expect((await firstHost.listRuns(task.id)).runs).toHaveLength(1);
	});

	it("edits only future claims and pause leaves the active run untouched", async () => {
		const manager = ScheduleManager.create({ agentDir: tempDir(), now: fixedNow });
		const task = await manager.create({
			id: "task-edit",
			instruction: "old",
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});
		const running = await manager.runNow(task.id, "run-edit");
		await manager.update(task.id, { instruction: "new", schedule: { kind: "daily", time: "10:00" } });
		expect((await manager.getRun(task.id, running.id)).snapshot.instruction).toBe("old");
		expect((await manager.pause(task.id)).activeRunId).toBe(running.id);
	});

	it("keeps a completed one-time task completed when a manual run loses its workspace", async () => {
		const agentDir = tempDir();
		const project = tempDir();
		const manager = ScheduleManager.create({ agentDir, now: fixedNow });
		const task = await manager.create({
			id: "task-completed-missing",
			instruction: "once",
			schedule: { kind: "once", date: "2026-07-26", time: "08:01" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "fixed", cwd: project },
		});
		await ScheduleStore.open(agentDir).mutate((draft) => {
			const index = draft.tasks.findIndex(({ id }) => id === task.id);
			draft.tasks[index] = { ...draft.tasks[index], status: "completed", nextRunAt: null };
		});
		await manager.runNow(task.id, "run-completed-missing");
		rmSync(project, { recursive: true, force: true });
		await manager.start();
		await eventually(async () => {
			expect((await manager.getRun(task.id, "run-completed-missing")).status).toBe("failed");
		});
		const completed = await manager.get(task.id);
		expect(completed.status).toBe("completed");
		expect(completed).not.toHaveProperty("pauseReason");
		await manager.stop();
	});

	it("deletes every run session and owned workspace but never a fixed cwd", async () => {
		const deleteSession = vi.spyOn(SessionManager, "deleteSession").mockResolvedValue({ ok: true, method: "unlink" });
		const agentDir = tempDir();
		const manager = ScheduleManager.create({ agentDir, now: fixedNow });
		const owned = await manager.create({
			id: "task-owned",
			instruction: "owned",
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});
		const ownedRun = await manager.runNow(owned.id, "run-owned");
		const store = ScheduleStore.open(agentDir);
		await store.mutate((_draft, files) =>
			files.replaceRun({ ...ownedRun, sessionId: "session-owned", sessionFile: join(agentDir, "session.jsonl") }),
		);
		await manager.delete(owned.id);
		expect(deleteSession).toHaveBeenCalledWith(join(agentDir, "session.jsonl"), {
			agentDir,
			permanent: true,
			expectedScheduled: { taskId: owned.id, runId: ownedRun.id },
		});
		expect(existsSync(owned.target.cwd)).toBe(false);

		const fixedCwd = tempDir();
		const fixed = await manager.create({
			id: "task-fixed",
			instruction: "fixed",
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "fixed", cwd: fixedCwd },
		});
		await manager.runNow(fixed.id, "run-fixed");
		await manager.delete(fixed.id);
		expect(existsSync(fixedCwd)).toBe(true);
	});

	it("deletes a run session created before an interrupted executor returned its file", async () => {
		const agentDir = tempDir();
		const fixedCwd = tempDir();
		const executor = deferredExecutor();
		const manager = ScheduleManager.create({ agentDir, now: fixedNow, execute: executor.run });
		const task = await manager.create({
			id: "018f0000-0000-7000-8000-000000000021",
			instruction: "interrupted",
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "fixed", cwd: fixedCwd },
		});
		await manager.start();
		const runId = "018f0000-0000-7000-8000-000000000022";
		await manager.runNow(task.id, runId);
		await eventually(() => expect(executor.pending).toHaveLength(1));

		const run = await manager.getRun(task.id, runId);
		expect(run.sessionId).toBe(executor.pending[0].claim.sessionId);
		if (!run.sessionId) throw new Error("running schedule did not reserve a session id");
		const session = SessionManager.create(task.target.cwd, getDefaultSessionDir(task.target.cwd, agentDir), {
			id: run.sessionId,
			mode: "chat",
			cwdOrigin: "user-selected",
			scheduled: { taskId: task.id, runId },
		});
		const sessionFile = session.getSessionFile()!;
		session.close();

		await manager.stop();
		expect(await manager.getRun(task.id, runId)).not.toHaveProperty("sessionFile");
		await manager.delete(task.id);
		expect(existsSync(sessionFile)).toBe(false);
		expect(existsSync(fixedCwd)).toBe(true);
	});

	it("resumes a crash-interrupted deleting tombstone", async () => {
		const agentDir = tempDir();
		const manager = ScheduleManager.create({ agentDir, now: fixedNow });
		const task = await manager.create({
			id: "task-deleting",
			instruction: "delete me",
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});
		await ScheduleStore.open(agentDir).mutate((draft) => {
			const index = draft.tasks.findIndex(({ id }) => id === task.id);
			draft.tasks[index] = { ...draft.tasks[index], status: "deleting", nextRunAt: null };
		});
		const reopened = ScheduleManager.create({ agentDir, now: fixedNow });
		await reopened.start();
		await eventually(async () => {
			await expect(reopened.get(task.id)).rejects.toMatchObject({ code: "SCHEDULE_NOT_FOUND" });
		});
		await reopened.stop();
	});

	it("allows only one of two hosts to claim a due occurrence", async () => {
		const agentDir = tempDir();
		let clock = new Date("2026-07-26T00:00:00Z");
		const setup = ScheduleManager.create({ agentDir, now: () => clock });
		const task = await setup.create({
			id: "task-one-leader",
			instruction: "run once",
			schedule: { kind: "once", date: "2026-07-26", time: "08:01" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});
		clock = new Date("2026-07-26T00:01:00Z");
		const executor = deferredExecutor();
		const first = ScheduleManager.create({
			agentDir,
			runnerId: "runner-one",
			now: () => clock,
			execute: executor.run,
		});
		const second = ScheduleManager.create({
			agentDir,
			runnerId: "runner-two",
			now: () => clock,
			execute: executor.run,
		});
		await Promise.all([first.start(), second.start()]);
		await eventually(() => expect(executor.pending).toHaveLength(1));
		expect(
			ScheduleStore.open(agentDir)
				.listAllRuns(task.id)
				.filter(({ status }) => status === "running"),
		).toHaveLength(1);
		await Promise.all([first.stop(), second.stop()]);
	});

	it("caps cross-task concurrency at two and keeps observed due work eligible", async () => {
		const agentDir = tempDir();
		let clock = new Date("2026-07-26T00:00:00Z");
		const manager = ScheduleManager.create({ agentDir, now: () => clock });
		for (const id of ["task-cap-a", "task-cap-b", "task-cap-c"]) {
			await manager.create({
				id,
				instruction: id,
				schedule: { kind: "once", date: "2026-07-26", time: "08:01" },
				timezone: "Asia/Shanghai",
				target: { kind: "general", workspace: "task" },
			});
		}
		clock = new Date("2026-07-26T00:01:00Z");
		const executor = deferredExecutor();
		const runner = ScheduleManager.create({ agentDir, now: () => clock, execute: executor.run });
		await runner.start();
		await eventually(() => expect(executor.pending).toHaveLength(2));
		expect(executor.maximumActive).toBe(2);
		clock = new Date("2026-07-26T00:03:00Z");
		executor.finish(0);
		await eventually(() => expect(executor.pending).toHaveLength(3));
		expect(executor.pending[2].claim.scheduledFor).toBe("2026-07-26T00:01:00Z");
		executor.finish(1);
		executor.finish(2);
		await eventually(() => expect(executor.active).toBe(0));
		await runner.stop();
	});

	it("records overlap and aggregates offline misses", async () => {
		const agentDir = tempDir();
		let clock = new Date("2026-07-20T00:00:00Z");
		const manager = ScheduleManager.create({ agentDir, now: () => clock });
		const task = await manager.create({
			id: "task-overlap",
			instruction: "daily",
			schedule: { kind: "daily", time: "08:01" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});
		await manager.runNow(task.id, "manual-overlap");
		clock = new Date("2026-07-20T00:01:00Z");
		const executor = deferredExecutor();
		const runner = ScheduleManager.create({ agentDir, now: () => clock, execute: executor.run });
		await runner.start();
		await eventually(() => {
			expect(
				ScheduleStore.open(agentDir)
					.listAllRuns(task.id)
					.some(({ status, reason }) => status === "skipped" && reason === "overlap"),
			).toBe(true);
		});
		await runner.stop();

		const offlineAgentDir = tempDir();
		clock = new Date("2026-07-20T00:00:00Z");
		const offlineSetup = ScheduleManager.create({ agentDir: offlineAgentDir, now: () => clock });
		const offline = await offlineSetup.create({
			id: "task-offline",
			instruction: "daily offline",
			schedule: { kind: "daily", time: "08:01" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});
		clock = new Date("2026-07-24T00:01:01Z");
		const reopened = ScheduleManager.create({ agentDir: offlineAgentDir, now: () => clock, execute: executor.run });
		await reopened.start();
		await eventually(() => {
			expect(ScheduleStore.open(offlineAgentDir).listAllRuns(offline.id)[0]).toMatchObject({
				status: "missed",
				reason: "offline",
				skippedCount: 4,
			});
		});
		await reopened.stop();
	});

	it("does not retry failed runs and auto-pauses a missing workspace", async () => {
		const agentDir = tempDir();
		let clock = new Date("2026-07-26T00:00:00Z");
		const setup = ScheduleManager.create({ agentDir, now: () => clock });
		const fixed = tempDir();
		const task = await setup.create({
			id: "task-missing",
			instruction: "fixed",
			schedule: { kind: "daily", time: "08:01" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "fixed", cwd: fixed },
		});
		rmSync(fixed, { recursive: true, force: true });
		clock = new Date("2026-07-26T00:01:00Z");
		const execute = vi.fn().mockRejectedValue(new Error("provider failed"));
		const runner = ScheduleManager.create({ agentDir, now: () => clock, execute });
		await runner.start();
		await eventually(async () => {
			expect(await runner.get(task.id)).toMatchObject({ status: "paused", pauseReason: "workspace_missing" });
		});
		expect(execute).not.toHaveBeenCalled();
		expect((await runner.listRuns(task.id)).runs[0]).toMatchObject({
			status: "failed",
			error: { code: "WORKSPACE_MISSING" },
		});
		await runner.stop();
	});

	it("keeps manual queues across restart and recovers orphan running records", async () => {
		const agentDir = tempDir();
		const manager = ScheduleManager.create({ agentDir, now: fixedNow });
		const queuedTask = await manager.create({
			id: "task-queued-restart",
			instruction: "queued",
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});
		await manager.runNow(queuedTask.id, "run-queued-restart");
		const executor = deferredExecutor();
		const reopened = ScheduleManager.create({ agentDir, now: fixedNow, execute: executor.run });
		await reopened.start();
		await eventually(() => expect(executor.pending).toHaveLength(1));
		executor.finish();
		await eventually(async () =>
			expect((await reopened.getRun(queuedTask.id, "run-queued-restart")).status).toBe("succeeded"),
		);
		await reopened.stop();

		const orphanAgentDir = tempDir();
		const orphanSetup = ScheduleManager.create({ agentDir: orphanAgentDir, now: fixedNow });
		const orphanTask = await orphanSetup.create({
			id: "task-orphan-running",
			instruction: "orphan",
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});
		const queued = await orphanSetup.runNow(orphanTask.id, "run-orphan-running");
		await ScheduleStore.open(orphanAgentDir).mutate((_draft, files) =>
			files.replaceRun({
				...queued,
				status: "running",
				runnerId: "dead-runner",
				startedAt: fixedNow().toISOString(),
			}),
		);
		const recovered = ScheduleManager.create({ agentDir: orphanAgentDir, now: fixedNow, execute: vi.fn() });
		await recovered.start();
		await eventually(async () =>
			expect(await recovered.getRun(orphanTask.id, queued.id)).toMatchObject({
				status: "failed",
				reason: "interrupted",
			}),
		);
		await recovered.stop();
	});

	it("advances a scheduled occurrence recovered between run and index persistence", async () => {
		const agentDir = tempDir();
		let clock = new Date("2026-07-26T00:00:00Z");
		const setup = ScheduleManager.create({ agentDir, now: () => clock });
		const task = await setup.create({
			id: "task-orphan-scheduled",
			instruction: "do not retry",
			schedule: { kind: "daily", time: "08:01" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});
		const orphan: ScheduleRun = {
			id: "run-orphan-scheduled",
			taskId: task.id,
			sequence: 1,
			trigger: "scheduled",
			status: "running",
			scheduledFor: task.nextRunAt!,
			createdAt: task.nextRunAt!,
			startedAt: task.nextRunAt!,
			runnerId: "dead-runner",
			unread: false,
			snapshot: {
				instruction: task.instruction,
				schedule: task.schedule,
				timezone: task.timezone,
				target: task.target,
			},
		};
		await ScheduleStore.open(agentDir).mutate((_draft, files) => files.createRun(orphan));
		clock = new Date("2026-07-26T00:02:00Z");
		const execute = vi.fn();
		const recovered = ScheduleManager.create({ agentDir, now: () => clock, execute });
		await recovered.start();
		await eventually(async () =>
			expect(await recovered.getRun(task.id, orphan.id)).toMatchObject({
				status: "failed",
				reason: "interrupted",
			}),
		);
		expect((await recovered.get(task.id)).nextRunAt).toBe("2026-07-27T00:01:00Z");
		expect(execute).not.toHaveBeenCalled();
		await recovered.stop();
	});

	it("pause lets an active run finish while delete aborts it", async () => {
		const agentDir = tempDir();
		const setup = ScheduleManager.create({ agentDir, now: fixedNow });
		const pausedTask = await setup.create({
			id: "task-pause-active",
			instruction: "pause active",
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});
		await setup.runNow(pausedTask.id, "run-pause-active");
		const executor = deferredExecutor();
		const runner = ScheduleManager.create({ agentDir, now: fixedNow, execute: executor.run });
		await runner.start();
		await eventually(() => expect(executor.pending).toHaveLength(1));
		await runner.pause(pausedTask.id);
		expect(executor.aborted).toBe(0);
		executor.finish();
		await eventually(async () => expect((await runner.get(pausedTask.id)).status).toBe("paused"));

		const deletedTask = await runner.create({
			id: "task-delete-active",
			instruction: "delete active",
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});
		await runner.runNow(deletedTask.id, "run-delete-active");
		await eventually(() => expect(executor.pending).toHaveLength(2));
		await runner.delete(deletedTask.id);
		expect(executor.aborted).toBe(1);
		await expect(runner.get(deletedTask.id)).rejects.toMatchObject({ code: "SCHEDULE_NOT_FOUND" });
		await runner.stop();
	});

	it("records a provider failure once without automatic retry", async () => {
		const agentDir = tempDir();
		let clock = new Date("2026-07-26T00:00:00Z");
		const setup = ScheduleManager.create({ agentDir, now: () => clock });
		const task = await setup.create({
			id: "task-provider-failure",
			instruction: "fail once",
			schedule: { kind: "daily", time: "08:01" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});
		clock = new Date("2026-07-26T00:01:00Z");
		const execute = vi.fn().mockRejectedValue(
			new ScheduleError("EXECUTION_FAILED", "provider failed", {
				executionSession: {
					sessionId: "session-provider-failure",
					sessionFile: join(agentDir, "provider-failure.jsonl"),
				},
			}),
		);
		const runner = ScheduleManager.create({ agentDir, now: () => clock, execute });
		await runner.start();
		await eventually(async () =>
			expect((await runner.listRuns(task.id)).runs[0]).toMatchObject({
				status: "failed",
				sessionId: "session-provider-failure",
				sessionFile: join(agentDir, "provider-failure.jsonl"),
			}),
		);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(execute).toHaveBeenCalledTimes(1);
		await runner.stop();
	});

	it("fails closed and releases a detached run when terminal persistence breaks", async () => {
		const agentDir = tempDir();
		const executor = deferredExecutor();
		const manager = ScheduleManager.create({ agentDir, now: fixedNow, execute: executor.run });
		const task = await manager.create({
			id: "task-finalize-corrupt",
			instruction: "persist result",
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});
		await manager.start();
		await manager.runNow(task.id, "run-finalize-corrupt");
		await eventually(() => expect(executor.pending).toHaveLength(1));
		const leaderLockPath = join(agentDir, "schedules.leader.lock");
		expect(existsSync(leaderLockPath)).toBe(true);
		const indexPath = join(agentDir, "schedules.json");
		const originalIndex = readFileSync(indexPath, "utf8");
		writeFileSync(indexPath, "{broken");
		executor.finish();
		await eventually(() => expect(existsSync(leaderLockPath)).toBe(false));
		writeFileSync(indexPath, originalIndex);

		await expect(manager.list()).rejects.toMatchObject({ code: "STORE_CORRUPT" });
		await manager.stop();
	});

	it("marks one unread run exactly once across concurrent hosts", async () => {
		const agentDir = tempDir();
		const firstHost = ScheduleManager.create({ agentDir, now: fixedNow });
		const secondHost = ScheduleManager.create({ agentDir, now: fixedNow });
		const task = await firstHost.create({
			id: "task-read-race",
			instruction: "read race",
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});
		const run = (id: string, sequence: number): ScheduleRun => ({
			id,
			taskId: task.id,
			sequence,
			trigger: "scheduled",
			status: "missed",
			scheduledFor: fixedNow().toISOString(),
			createdAt: fixedNow().toISOString(),
			completedAt: fixedNow().toISOString(),
			reason: "offline",
			unread: true,
			snapshot: {
				instruction: task.instruction,
				schedule: task.schedule,
				timezone: task.timezone,
				target: task.target,
			},
		});
		const store = ScheduleStore.open(agentDir);
		await store.mutate((draft, files) => {
			files.createRun(run("run-read-race", 1));
			files.createRun(run("run-still-unread", 2));
			const index = draft.tasks.findIndex(({ id }) => id === task.id);
			draft.tasks[index] = { ...draft.tasks[index], unreadCount: 2, nextRunSequence: 3 };
		});

		await Promise.all([
			firstHost.markRunRead(task.id, "run-read-race"),
			secondHost.markRunRead(task.id, "run-read-race"),
		]);

		expect((await firstHost.get(task.id)).unreadCount).toBe(1);
		expect((await firstHost.getRun(task.id, "run-read-race")).unread).toBe(false);
	});

	it("keeps the host alive and fails schedule calls closed on a corrupt index", async () => {
		const agentDir = tempDir();
		writeFileSync(join(agentDir, "schedules.json"), "{broken");
		const manager = ScheduleManager.create({ agentDir });
		await expect(manager.start()).resolves.toBeUndefined();
		await expect(manager.list()).rejects.toMatchObject({ code: "STORE_CORRUPT" });
		await manager.stop();
	});

	it("filters execution history before pagination", async () => {
		const agentDir = tempDir();
		const fixed = join(agentDir, "fixed");
		mkdirSync(fixed);
		const manager = ScheduleManager.create({ agentDir, now: fixedNow });
		const target = { kind: "general", workspace: "fixed", cwd: fixed } as const;
		await manager.create({
			id: "z-no-run",
			instruction: "No run",
			schedule: { kind: "daily", time: "10:00" },
			timezone: "Asia/Shanghai",
			target,
		});
		const withRun = await manager.create({
			id: "a-with-run",
			instruction: "Has run",
			schedule: { kind: "daily", time: "11:00" },
			timezone: "Asia/Shanghai",
			target,
		});
		await ScheduleStore.open(agentDir).mutate((draft) => {
			const index = draft.tasks.findIndex(({ id }) => id === withRun.id);
			draft.tasks[index] = {
				...draft.tasks[index],
				lastRun: {
					id: "run-history",
					taskId: withRun.id,
					sequence: 1,
					status: "succeeded",
					scheduledFor: fixedNow().toISOString(),
					createdAt: fixedNow().toISOString(),
					completedAt: fixedNow().toISOString(),
					unread: false,
				},
			};
		});

		const page = await manager.list({ limit: 1, withRunsOnly: true });
		expect(page.tasks.map(({ id }) => id)).toEqual([withRun.id]);
		expect(page.nextAfterTaskId).toBeNull();
	});

	it("validates once schedules, fixed workspaces, pagination, and event delivery", async () => {
		const agentDir = tempDir();
		const fixed = join(agentDir, "fixed");
		mkdirSync(fixed);
		const manager = ScheduleManager.create({ agentDir, now: fixedNow });
		const events: string[] = [];
		manager.subscribe((event) => events.push(event.type));
		const task = await manager.create({
			id: "task-once",
			instruction: "  Create   one report  ",
			schedule: { kind: "once", date: "2026-08-03", time: "09:30" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "fixed", cwd: fixed },
		});
		expect(task.title).toBe("Create one report");
		expect(task.nextRunAt).toBe("2026-08-03T01:30:00Z");
		expect((await manager.list({ limit: 1 })).tasks).toHaveLength(1);
		expect(events).toContain("schedule/updated");
		await ScheduleStore.open(agentDir).mutate((draft) => {
			const index = draft.tasks.findIndex(({ id }) => id === task.id);
			draft.tasks[index] = { ...draft.tasks[index], status: "completed", nextRunAt: null };
		});
		await expect(manager.pause(task.id)).rejects.toMatchObject({ code: "INVALID_SCHEDULE" });
		await expect(manager.resume(task.id)).rejects.toMatchObject({ code: "INVALID_SCHEDULE" });
		await expect(
			manager.create({
				id: "task-past",
				instruction: "past",
				schedule: { kind: "once", date: "2026-07-25", time: "09:30" },
				timezone: "Asia/Shanghai",
				target: { kind: "general", workspace: "task" },
			}),
		).rejects.toMatchObject({ code: "INVALID_SCHEDULE" });
	});
});
