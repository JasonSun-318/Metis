import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { trashScheduledTaskData } from "../src/core/schedules/delete.ts";
import { ScheduleManager } from "../src/core/schedules/manager.ts";
import { ScheduleStore } from "../src/core/schedules/store.ts";
import { ScheduleError, type ScheduleEvent, type ScheduleRun } from "../src/core/schedules/types.ts";
import { getDefaultSessionDir, SessionManager } from "../src/core/session-manager.ts";

const roots: string[] = [];
const fixedNow = () => new Date("2026-07-26T00:00:00Z");
const TASK_DEFAULTS = { name: "Test task", model: { provider: "openai", modelId: "gpt-test" } } as const;
const testTrashScheduledData: typeof trashScheduledTaskData = (input) =>
	trashScheduledTaskData(input, { trash: (payload) => rmSync(payload, { recursive: true }) });

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
	const path = mkdtempSync(join(tmpdir(), "metis-schedule-manager-"));
	roots.push(path);
	return path;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("schedule manager", () => {
	it("counts every fixed-workspace blocker for one canonical cwd", async () => {
		const agentDir = tempDir();
		const project = tempDir();
		const child = join(project, "child");
		mkdirSync(child);
		const manager = ScheduleManager.create({ agentDir, now: fixedNow });
		const create = (id: string, target: { kind: "general"; workspace: "fixed"; cwd: string }) =>
			manager.create({
				...TASK_DEFAULTS,
				id,
				instruction: id,
				schedule: { kind: "daily", time: "09:00" },
				timezone: "Asia/Shanghai",
				target,
			});
		const first = await create("fixed-blocker-active", { kind: "general", workspace: "fixed", cwd: project });
		const second = await create("fixed-blocker-paused", {
			kind: "general",
			workspace: "fixed",
			cwd: join(project, "."),
		});
		await manager.pause(second.id);
		await create("fixed-child", { kind: "general", workspace: "fixed", cwd: child });
		await manager.create({
			...TASK_DEFAULTS,
			id: "task-owned-not-blocking",
			instruction: "task owned",
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});

		expect((await manager.list({ limit: 1 })).nextAfterTaskId).not.toBeNull();
		expect(manager.countFixedWorkspaceTasks(project)).toBe(2);
		expect(manager.countFixedWorkspaceTasks(child)).toBe(1);
		expect((await manager.get(first.id)).status).toBe("active");
		expect((await manager.get(second.id)).status).toBe("paused");
		rmSync(project, { recursive: true, force: true });
		expect(manager.countFixedWorkspaceTasks(project)).toBe(2);
		await expect(manager.withNoFixedWorkspaceTasks(project, async () => undefined)).rejects.toMatchObject({
			code: "TASK_BUSY",
		});
	});

	it("fails fast when fixed-schedule creation and project deletion race", async () => {
		const agentDir = tempDir();
		const project = tempDir();
		const otherProject = tempDir();
		const retryProject = tempDir();
		const deletionHost = ScheduleManager.create({ agentDir, now: fixedNow });
		const creationHost = ScheduleManager.create({ agentDir, now: fixedNow });
		let enterDeletion!: () => void;
		let releaseDeletion!: () => void;
		const deletionEntered = new Promise<void>((resolve) => {
			enterDeletion = resolve;
		});
		const deletionGate = new Promise<void>((resolve) => {
			releaseDeletion = resolve;
		});
		const deletion = deletionHost.withNoFixedWorkspaceTasks(project, async () => {
			enterDeletion();
			await deletionGate;
			return "deleted";
		});
		await deletionEntered;

		try {
			await expect(
				creationHost.create({
					...TASK_DEFAULTS,
					id: "fixed-create-loses-race",
					instruction: "same cwd",
					schedule: { kind: "daily", time: "09:00" },
					timezone: "Asia/Shanghai",
					target: { kind: "general", workspace: "fixed", cwd: project },
				}),
			).rejects.toMatchObject({ code: "TASK_BUSY" });
			await expect(
				creationHost.create({
					...TASK_DEFAULTS,
					id: "fixed-create-other-cwd",
					instruction: "other cwd",
					schedule: { kind: "daily", time: "09:00" },
					timezone: "Asia/Shanghai",
					target: { kind: "general", workspace: "fixed", cwd: otherProject },
				}),
			).resolves.toMatchObject({ target: { workspace: "fixed", cwd: realpathSync(otherProject) } });
			await expect(
				creationHost.create({
					...TASK_DEFAULTS,
					id: "task-create-during-delete",
					instruction: "task workspace",
					schedule: { kind: "daily", time: "09:00" },
					timezone: "Asia/Shanghai",
					target: { kind: "general", workspace: "task" },
				}),
			).resolves.toMatchObject({ target: { workspace: "task" } });
		} finally {
			releaseDeletion();
			await deletion;
		}

		let mutationEntered!: () => void;
		let releaseMutation!: () => void;
		const entered = new Promise<void>((resolve) => {
			mutationEntered = resolve;
		});
		const mutationGate = new Promise<void>((resolve) => {
			releaseMutation = resolve;
		});
		const creationStore = (creationHost as unknown as { store: ScheduleStore }).store;
		const originalMutate = creationStore.mutate.bind(creationStore);
		vi.spyOn(creationStore, "mutate").mockImplementationOnce(async (mutation) => {
			mutationEntered();
			await mutationGate;
			return originalMutate(mutation);
		});
		const committedFirst = creationHost.create({
			...TASK_DEFAULTS,
			id: "fixed-create-wins-race",
			instruction: "create first",
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "fixed", cwd: project },
		});
		await entered;
		const operation = vi.fn(async () => undefined);
		try {
			await expect(deletionHost.withNoFixedWorkspaceTasks(project, operation)).rejects.toMatchObject({
				code: "TASK_BUSY",
			});
			expect(operation).not.toHaveBeenCalled();
		} finally {
			releaseMutation();
			await committedFirst;
		}
		await expect(deletionHost.withNoFixedWorkspaceTasks(project, operation)).rejects.toMatchObject({
			code: "TASK_BUSY",
		});
		expect(operation).not.toHaveBeenCalled();

		await expect(
			deletionHost.withNoFixedWorkspaceTasks(retryProject, async () => {
				throw new Error("delete failed");
			}),
		).rejects.toThrow("delete failed");
		await expect(
			creationHost.create({
				...TASK_DEFAULTS,
				id: "fixed-create-after-release",
				instruction: "retry",
				schedule: { kind: "daily", time: "09:00" },
				timezone: "Asia/Shanghai",
				target: { kind: "general", workspace: "fixed", cwd: retryProject },
			}),
		).resolves.toMatchObject({ target: { workspace: "fixed", cwd: realpathSync(retryProject) } });
	});

	it("rejects an unsafe fixed-workspace lock target", async () => {
		const agentDir = tempDir();
		const project = tempDir();
		const canonicalCwd = realpathSync(project);
		const digest = createHash("sha256").update(canonicalCwd).digest("hex");
		symlinkSync(project, join(agentDir, `schedules.cwd.${digest}`));

		await expect(
			ScheduleManager.create({ agentDir, now: fixedNow }).withNoFixedWorkspaceTasks(project, async () => undefined),
		).rejects.toMatchObject({ code: "STORE_CORRUPT" });
	});

	it("uses the explicit display name and creates the task-owned workspace once", async () => {
		const agentDir = tempDir();
		const manager = ScheduleManager.create({ agentDir, now: fixedNow });
		const input = {
			...TASK_DEFAULTS,
			name: "每天整理下载目录并输出摘要",
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

	it("persists and replaces the optional task workspace access root", async () => {
		const agentDir = tempDir();
		const firstAccessRoot = tempDir();
		const secondAccessRoot = tempDir();
		const manager = ScheduleManager.create({ agentDir, now: fixedNow });
		const task = await manager.create({
			...TASK_DEFAULTS,
			id: "018f0000-0000-7000-8000-000000000002",
			instruction: "Work in the granted folder",
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: {
				kind: "general",
				workspace: "task",
				additionalWorkspaceCwd: firstAccessRoot,
			},
		});
		expect(task.target).toMatchObject({
			workspace: "task",
			additionalWorkspaceCwd: realpathSync(firstAccessRoot),
		});
		expect((await ScheduleManager.create({ agentDir, now: fixedNow }).get(task.id)).target).toMatchObject({
			workspace: "task",
			additionalWorkspaceCwd: realpathSync(firstAccessRoot),
		});

		const replaced = await manager.update(task.id, {
			target: {
				kind: "general",
				workspace: "task",
				additionalWorkspaceCwd: secondAccessRoot,
			},
		});
		expect(replaced.target).toMatchObject({
			workspace: "task",
			additionalWorkspaceCwd: realpathSync(secondAccessRoot),
		});
		expect(await manager.update(task.id, { target: { kind: "general", workspace: "task" } })).not.toHaveProperty(
			"target.additionalWorkspaceCwd",
		);
		await expect(
			manager.update(task.id, {
				target: {
					kind: "general",
					workspace: "task",
					additionalWorkspaceCwd: "relative/folder",
				},
			}),
		).rejects.toMatchObject({ code: "INVALID_SCHEDULE" });
	});

	it("idempotently creates one task-owned workspace across concurrent hosts", async () => {
		const agentDir = tempDir();
		const input = {
			...TASK_DEFAULTS,
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
			...TASK_DEFAULTS,
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

	it("returns promptly when deletion is delegated to another process leader", async () => {
		const agentDir = tempDir();
		const leader = ScheduleManager.create({ agentDir, now: fixedNow, trashScheduledData: testTrashScheduledData });
		const task = await leader.create({
			...TASK_DEFAULTS,
			id: "task-follower-delete",
			instruction: "delete me",
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});
		const follower = ScheduleManager.create({ agentDir, now: fixedNow, trashScheduledData: testTrashScheduledData });
		await leader.start();
		await eventually(() =>
			expect((leader as unknown as { leaderRelease?: () => Promise<void> }).leaderRelease).toBeTypeOf("function"),
		);
		await follower.start();
		const events: ScheduleEvent[] = [];
		follower.subscribe((event) => events.push(event));
		try {
			const deletion = follower.delete(task.id, { deleteSessions: true });
			const outcome = await Promise.race([
				deletion.then(
					() => ({ code: "resolved" }),
					(error: unknown) => error,
				),
				new Promise((resolvePromise) => setTimeout(() => resolvePromise({ code: "timeout" }), 150)),
			]);

			expect(outcome).toMatchObject({ code: "TASK_DELETING" });
			expect((await follower.get(task.id)).status).toBe("deleting");
			expect(events).toContainEqual(
				expect.objectContaining({
					type: "schedule/updated",
					task: expect.objectContaining({ id: task.id, status: "deleting" }),
				}),
			);
			await leader.delete(task.id, { deleteSessions: true });
		} finally {
			await follower.stop();
			await leader.stop();
		}
	});

	it("rejects edits while running and keeps completed run snapshots immutable", async () => {
		const agentDir = tempDir();
		const manager = ScheduleManager.create({ agentDir, now: fixedNow });
		const task = await manager.create({
			...TASK_DEFAULTS,
			id: "task-edit",
			instruction: "old",
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});
		const running = await manager.runNow(task.id, "run-edit");
		await expect(
			manager.update(task.id, { instruction: "new", schedule: { kind: "daily", time: "10:00" } }),
		).rejects.toMatchObject({ code: "TASK_BUSY" });
		expect((await manager.pause(task.id)).activeRunId).toBe(running.id);
		await ScheduleStore.open(agentDir).mutate((draft, files) => {
			files.replaceRun({ ...running, status: "succeeded", completedAt: fixedNow().toISOString(), unread: true });
			const index = draft.tasks.findIndex(({ id }) => id === task.id);
			draft.tasks[index] = { ...draft.tasks[index], activeRunId: undefined };
		});
		await manager.update(task.id, { instruction: "new", schedule: { kind: "daily", time: "10:00" } });
		expect((await manager.getRun(task.id, running.id)).snapshot.instruction).toBe("old");
	});

	it("reactivates a completed one-time task when it is rescheduled", async () => {
		const agentDir = tempDir();
		const manager = ScheduleManager.create({ agentDir, now: fixedNow });
		const task = await manager.create({
			...TASK_DEFAULTS,
			id: "task-rescheduled",
			instruction: "once",
			schedule: { kind: "once", date: "2026-07-26", time: "08:01" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});
		await ScheduleStore.open(agentDir).mutate((draft) => {
			const index = draft.tasks.findIndex(({ id }) => id === task.id);
			draft.tasks[index] = { ...draft.tasks[index], status: "completed", nextRunAt: null };
		});

		await expect(
			manager.update(task.id, { model: { provider: "openai", modelId: "gpt-next" } }),
		).rejects.toMatchObject({
			code: "INVALID_SCHEDULE",
		});
		const updated = await manager.update(task.id, {
			model: { provider: "openai", modelId: "gpt-next" },
			schedule: { kind: "once", date: "2026-07-27", time: "09:00" },
		});

		expect(updated).toMatchObject({
			status: "active",
			nextRunAt: "2026-07-27T01:00:00Z",
			model: { provider: "openai", modelId: "gpt-next" },
		});
	});

	it("keeps a completed one-time task completed when a manual run loses its workspace", async () => {
		const agentDir = tempDir();
		const project = tempDir();
		const manager = ScheduleManager.create({ agentDir, now: fixedNow });
		const task = await manager.create({
			...TASK_DEFAULTS,
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

	it("deletes an owned workspace but never a fixed cwd", async () => {
		const agentDir = tempDir();
		const manager = ScheduleManager.create({ agentDir, now: fixedNow, trashScheduledData: testTrashScheduledData });
		const owned = await manager.create({
			...TASK_DEFAULTS,
			id: "task-owned",
			instruction: "owned",
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});
		const ownedRun = await manager.runNow(owned.id, "run-owned");
		const store = ScheduleStore.open(agentDir);
		await store.mutate((draft, files) => {
			files.replaceRun({
				...ownedRun,
				status: "succeeded",
				completedAt: fixedNow().toISOString(),
				sessionId: "session-owned",
				sessionFile: join(agentDir, "session.jsonl"),
			});
			const index = draft.tasks.findIndex(({ id }) => id === owned.id);
			draft.tasks[index] = { ...draft.tasks[index], activeRunId: undefined };
		});
		await manager.delete(owned.id, { deleteSessions: true });
		expect(existsSync(owned.target.cwd)).toBe(false);

		const fixedCwd = tempDir();
		const fixed = await manager.create({
			...TASK_DEFAULTS,
			id: "task-fixed",
			instruction: "fixed",
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "fixed", cwd: fixedCwd },
		});
		await manager.delete(fixed.id, { deleteSessions: true });
		expect(existsSync(fixedCwd)).toBe(true);
	});

	it("deletes a run session created before an interrupted executor returned its file", async () => {
		const agentDir = tempDir();
		const fixedCwd = tempDir();
		const executor = deferredExecutor();
		const manager = ScheduleManager.create({
			agentDir,
			now: fixedNow,
			execute: executor.run,
			trashScheduledData: testTrashScheduledData,
		});
		const task = await manager.create({
			...TASK_DEFAULTS,
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
		await manager.delete(task.id, { deleteSessions: true });
		expect(existsSync(sessionFile)).toBe(false);
		expect(existsSync(fixedCwd)).toBe(true);
	});

	it("resumes a crash-interrupted deleting tombstone", async () => {
		const agentDir = tempDir();
		const manager = ScheduleManager.create({ agentDir, now: fixedNow });
		const task = await manager.create({
			...TASK_DEFAULTS,
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
		const reopened = ScheduleManager.create({
			agentDir,
			now: fixedNow,
			trashScheduledData: testTrashScheduledData,
		});
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
			...TASK_DEFAULTS,
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
				...TASK_DEFAULTS,
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
			...TASK_DEFAULTS,
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
			...TASK_DEFAULTS,
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
			...TASK_DEFAULTS,
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
			...TASK_DEFAULTS,
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
			...TASK_DEFAULTS,
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
			...TASK_DEFAULTS,
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
				name: task.title,
				instruction: task.instruction,
				model: task.model,
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

	it("pause lets an active run finish while delete rejects a running task", async () => {
		const agentDir = tempDir();
		const setup = ScheduleManager.create({ agentDir, now: fixedNow });
		const pausedTask = await setup.create({
			...TASK_DEFAULTS,
			id: "task-pause-active",
			instruction: "pause active",
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});
		await setup.runNow(pausedTask.id, "run-pause-active");
		const executor = deferredExecutor();
		const runner = ScheduleManager.create({
			agentDir,
			now: fixedNow,
			execute: executor.run,
			trashScheduledData: testTrashScheduledData,
		});
		await runner.start();
		await eventually(() => expect(executor.pending).toHaveLength(1));
		await runner.pause(pausedTask.id);
		expect(executor.aborted).toBe(0);
		executor.finish();
		await eventually(async () => expect((await runner.get(pausedTask.id)).status).toBe("paused"));

		const deletedTask = await runner.create({
			...TASK_DEFAULTS,
			id: "task-delete-active",
			instruction: "delete active",
			schedule: { kind: "daily", time: "09:00" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});
		await runner.runNow(deletedTask.id, "run-delete-active");
		await eventually(() => expect(executor.pending).toHaveLength(2));
		await expect(runner.delete(deletedTask.id, { deleteSessions: true })).rejects.toMatchObject({
			code: "TASK_BUSY",
		});
		expect(executor.aborted).toBe(0);
		executor.finish(1);
		await eventually(async () => expect((await runner.get(deletedTask.id)).activeRunId).toBeUndefined());
		await runner.delete(deletedTask.id, { deleteSessions: true });
		await expect(runner.get(deletedTask.id)).rejects.toMatchObject({ code: "SCHEDULE_NOT_FOUND" });
		await runner.stop();
	});

	it("records a provider failure once without automatic retry", async () => {
		const agentDir = tempDir();
		let clock = new Date("2026-07-26T00:00:00Z");
		const setup = ScheduleManager.create({ agentDir, now: () => clock });
		const task = await setup.create({
			...TASK_DEFAULTS,
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

	it("pauses a task when its pinned model becomes unavailable", async () => {
		const agentDir = tempDir();
		let clock = new Date("2026-07-26T00:00:00Z");
		const setup = ScheduleManager.create({ agentDir, now: () => clock });
		const task = await setup.create({
			...TASK_DEFAULTS,
			id: "task-model-unavailable",
			instruction: "use the pinned model",
			schedule: { kind: "daily", time: "08:01" },
			timezone: "Asia/Shanghai",
			target: { kind: "general", workspace: "task" },
		});
		clock = new Date("2026-07-26T00:01:00Z");
		const execute = vi.fn().mockRejectedValue(new ScheduleError("MODEL_UNAVAILABLE", "model removed"));
		const runner = ScheduleManager.create({ agentDir, now: () => clock, execute });
		await runner.start();
		await eventually(async () => {
			const paused = await runner.get(task.id);
			expect(paused).toMatchObject({
				status: "paused",
				pauseReason: "model_unavailable",
			});
			expect(paused).not.toHaveProperty("activeRunId");
			expect((await runner.listRuns(task.id)).runs[0]).toMatchObject({
				status: "failed",
				error: { code: "MODEL_UNAVAILABLE" },
			});
		});
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(execute).toHaveBeenCalledTimes(1);
		await runner.stop();
	});

	it("fails closed and releases a detached run when terminal persistence breaks", async () => {
		const agentDir = tempDir();
		const executor = deferredExecutor();
		const manager = ScheduleManager.create({ agentDir, now: fixedNow, execute: executor.run });
		const task = await manager.create({
			...TASK_DEFAULTS,
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
			...TASK_DEFAULTS,
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
				name: task.title,
				instruction: task.instruction,
				model: task.model,
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
			...TASK_DEFAULTS,
			id: "z-no-run",
			instruction: "No run",
			schedule: { kind: "daily", time: "10:00" },
			timezone: "Asia/Shanghai",
			target,
		});
		const withRun = await manager.create({
			...TASK_DEFAULTS,
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
			...TASK_DEFAULTS,
			name: "Create one report",
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
				...TASK_DEFAULTS,
				id: "task-past",
				instruction: "past",
				schedule: { kind: "once", date: "2026-07-25", time: "09:30" },
				timezone: "Asia/Shanghai",
				target: { kind: "general", workspace: "task" },
			}),
		).rejects.toMatchObject({ code: "INVALID_SCHEDULE" });
	});
});
