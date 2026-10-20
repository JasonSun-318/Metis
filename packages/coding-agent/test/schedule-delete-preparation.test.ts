import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recoverInterruptedScheduleTrash, trashScheduledTaskData } from "../src/core/schedules/delete.ts";
import { ScheduleManager } from "../src/core/schedules/manager.ts";
import { createScheduleWorkspace } from "../src/core/schedules/paths.ts";
import type { ScheduleRun, ScheduleTask } from "../src/core/schedules/types.ts";
import { getDefaultSessionDir, getSessionImageDir, SessionManager } from "../src/core/session-manager.ts";

const faults = vi.hoisted(() => ({
	payloadMkdirError: undefined as Error | undefined,
	payloadMkdirFault: undefined as ((payload: string) => void) | undefined,
	manifestOpenError: undefined as Error | undefined,
	manifestOpenFault: undefined as ((temporary: string) => void) | undefined,
	manifestDirectorySyncError: undefined as Error | undefined,
	manifestDirectorySyncPath: undefined as string | undefined,
	manifestDirectorySyncHits: 0,
	openPaths: new Map<number, string>(),
	cleanupRmdirError: undefined as Error | undefined,
	cleanupRmdirPath: undefined as string | undefined,
}));

function insideScheduleTrash(path: string): boolean {
	return path.includes(`${sep}schedule-trash${sep}`);
}

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return {
		...actual,
		mkdirSync: ((path: Parameters<typeof actual.mkdirSync>[0], options: Parameters<typeof actual.mkdirSync>[1]) => {
			if (insideScheduleTrash(String(path)) && basename(String(path)) === "payload") {
				faults.payloadMkdirFault?.(String(path));
				if (faults.payloadMkdirError) throw faults.payloadMkdirError;
			}
			return actual.mkdirSync(path, options);
		}) as typeof actual.mkdirSync,
		openSync: ((path: Parameters<typeof actual.openSync>[0], ...args: unknown[]) => {
			if (insideScheduleTrash(String(path)) && String(path).endsWith(".tmp")) {
				faults.manifestOpenFault?.(String(path));
				if (faults.manifestOpenError) throw faults.manifestOpenError;
			}
			const fd = (actual.openSync as (...parameters: unknown[]) => number)(path, ...args);
			if (insideScheduleTrash(String(path))) faults.openPaths.set(fd, String(path));
			return fd;
		}) as typeof actual.openSync,
		closeSync: ((fd: number) => {
			faults.openPaths.delete(fd);
			return actual.closeSync(fd);
		}) as typeof actual.closeSync,
		fsyncSync: ((fd: number) => {
			const path = faults.openPaths.get(fd);
			if (
				path !== undefined &&
				path === faults.manifestDirectorySyncPath &&
				faults.manifestDirectorySyncError !== undefined &&
				actual.existsSync(join(path, "manifest.json"))
			) {
				const error = faults.manifestDirectorySyncError;
				faults.manifestDirectorySyncError = undefined;
				faults.manifestDirectorySyncHits += 1;
				throw error;
			}
			return actual.fsyncSync(fd);
		}) as typeof actual.fsyncSync,
		rmdirSync: ((path: Parameters<typeof actual.rmdirSync>[0], options?: Parameters<typeof actual.rmdirSync>[1]) => {
			if (
				faults.cleanupRmdirError &&
				faults.cleanupRmdirPath !== undefined &&
				String(path) === faults.cleanupRmdirPath
			) {
				throw faults.cleanupRmdirError;
			}
			return actual.rmdirSync(path, options);
		}) as typeof actual.rmdirSync,
	};
});

const roots: string[] = [];

function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "metis-schedule-delete-preparation-"));
	roots.push(path);
	return path;
}

function fixture() {
	const agentDir = tempDir();
	const taskId = "20000000-0000-4000-8000-000000000001";
	const runId = "20000000-0000-4000-8000-000000000002";
	const sessionId = "20000000-0000-4000-8000-000000000003";
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

function resetFaults(): void {
	faults.payloadMkdirError = undefined;
	faults.payloadMkdirFault = undefined;
	faults.manifestOpenError = undefined;
	faults.manifestOpenFault = undefined;
	faults.manifestDirectorySyncError = undefined;
	faults.manifestDirectorySyncPath = undefined;
	faults.openPaths.clear();
	faults.cleanupRmdirError = undefined;
	faults.cleanupRmdirPath = undefined;
}

function expectOriginalsIntact(value: ReturnType<typeof fixture>): void {
	expect(readFileSync(join(value.workspace, "task-output.txt"), "utf8")).toBe("owned");
	expect(existsSync(value.sessionFile)).toBe(true);
	expect(readFileSync(join(value.imageDir, "owned.png"), "utf8")).toBe("image");
	expect(readFileSync(join(value.additionalWorkspaceCwd, "user-file.txt"), "utf8")).toBe("keep");
	expect(existsSync(`${value.sessionFile}.lease`)).toBe(false);
}

async function expectPreparedFailureThenUsable(
	fault: (value: ReturnType<typeof fixture>) => Error,
	operationId?: string,
) {
	const value = fixture();
	const injected = fault(value);
	const rename = vi.fn();
	const trash = vi.fn();
	const input = { agentDir: value.agentDir, task: value.task, runs: [value.run], deleteSessions: true };
	const hooks = operationId === undefined ? { rename, trash } : { rename, trash, operationId: () => operationId };

	try {
		await expect(trashScheduledTaskData(input, hooks)).rejects.toBe(injected);
		expect(rename).not.toHaveBeenCalled();
		expect(trash).not.toHaveBeenCalled();
		expectOriginalsIntact(value);
		expect(readdirSync(join(value.agentDir, "schedule-trash"))).toEqual([]);
	} finally {
		resetFaults();
	}

	expect(() => recoverInterruptedScheduleTrash(value.agentDir)).not.toThrow();
	expect(() => recoverInterruptedScheduleTrash(value.agentDir)).not.toThrow();
	expect(() => ScheduleManager.create({ agentDir: value.agentDir })).not.toThrow();
	const trashRetry = vi.fn((payload: string) => rmSync(payload, { recursive: true }));
	await expect(trashScheduledTaskData(input, { trash: trashRetry })).resolves.toEqual({
		deletedSessionCount: 1,
		retainedSessionCount: 0,
	});
	expect(trashRetry).toHaveBeenCalledTimes(1);
	expect(existsSync(value.workspace)).toBe(false);
	expect(existsSync(value.sessionFile)).toBe(false);
	expect(readFileSync(join(value.additionalWorkspaceCwd, "user-file.txt"), "utf8")).toBe("keep");
	expect(() => recoverInterruptedScheduleTrash(value.agentDir)).not.toThrow();
	expect(() => ScheduleManager.create({ agentDir: value.agentDir })).not.toThrow();
}

afterEach(() => {
	resetFaults();
	faults.manifestDirectorySyncHits = 0;
	vi.restoreAllMocks();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("scheduled task deletion preparation", () => {
	it("cleans the owned operation when payload creation fails", async () => {
		await expectPreparedFailureThenUsable(() => {
			const injected = Object.assign(new Error("injected payload mkdir"), { code: "EACCES" });
			faults.payloadMkdirError = injected;
			return injected;
		});
	});

	it("cleans the owned operation when manifest creation fails before publication", async () => {
		await expectPreparedFailureThenUsable(() => {
			const injected = Object.assign(new Error("injected manifest write"), { code: "EIO" });
			faults.manifestOpenError = injected;
			return injected;
		});
	});

	it("cleans the owned operation when directory sync fails after manifest publication", async () => {
		const operationId = "20000000-0000-4000-8000-000000000013";
		await expectPreparedFailureThenUsable((value) => {
			const operationDir = join(realpathSync(value.agentDir), "schedule-trash", operationId);
			const injected = Object.assign(new Error("injected manifest publication sync"), { code: "EIO" });
			faults.manifestDirectorySyncHits = 0;
			faults.manifestDirectorySyncPath = operationDir;
			faults.manifestDirectorySyncError = injected;
			return injected;
		}, operationId);
		expect(faults.manifestDirectorySyncHits).toBe(1);
	});

	it("preserves an operation directory created by a colliding operation id", async () => {
		const value = fixture();
		const operationId = "20000000-0000-4000-8000-000000000010";
		const operationDir = join(value.agentDir, "schedule-trash", operationId);
		const input = { agentDir: value.agentDir, task: value.task, runs: [value.run], deleteSessions: true };
		await expect(
			trashScheduledTaskData(input, {
				operationId: () => {
					mkdirSync(operationDir, { recursive: true });
					writeFileSync(join(operationDir, "sentinel.txt"), "not ours");
					return operationId;
				},
			}),
		).rejects.toMatchObject({ code: "EEXIST" });
		expect(readFileSync(join(operationDir, "sentinel.txt"), "utf8")).toBe("not ours");
		expect(readdirSync(join(value.agentDir, "schedule-trash"))).toEqual([operationId]);
		expectOriginalsIntact(value);
	});

	it("keeps strict rejection and leaves an independently created manifestless operation untouched", async () => {
		const value = fixture();
		const operationId = "20000000-0000-4000-8000-000000000011";
		const operationDir = join(value.agentDir, "schedule-trash", operationId);
		mkdirSync(operationDir, { recursive: true });
		writeFileSync(join(operationDir, "sentinel.txt"), "independent");
		const input = { agentDir: value.agentDir, task: value.task, runs: [value.run], deleteSessions: true };
		await expect(trashScheduledTaskData(input)).rejects.toThrow(/Missing Schedule Trash manifest/);
		expect(readFileSync(join(operationDir, "sentinel.txt"), "utf8")).toBe("independent");
		expect(() => recoverInterruptedScheduleTrash(value.agentDir)).toThrow(/Missing Schedule Trash manifest/);
		expect(() => ScheduleManager.create({ agentDir: value.agentDir })).toThrow(/Missing Schedule Trash manifest/);
		expectOriginalsIntact(value);
	});

	it("reports a cleanup operation failure with both causes", async () => {
		const value = fixture();
		const operationId = "20000000-0000-4000-8000-000000000012";
		const operationDir = join(realpathSync(value.agentDir), "schedule-trash", operationId);
		const injected = Object.assign(new Error("injected payload mkdir"), { code: "EACCES" });
		const cleanupFailure = Object.assign(new Error("injected cleanup rmdir"), { code: "EIO" });
		faults.payloadMkdirError = injected;
		faults.cleanupRmdirPath = operationDir;
		faults.cleanupRmdirError = cleanupFailure;
		const rename = vi.fn();
		const trash = vi.fn();
		const input = { agentDir: value.agentDir, task: value.task, runs: [value.run], deleteSessions: true };
		let failure: unknown;
		try {
			await trashScheduledTaskData(input, { operationId: () => operationId, rename, trash });
		} catch (error) {
			failure = error;
		}
		resetFaults();

		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors).toEqual([injected, cleanupFailure]);
		expect(rename).not.toHaveBeenCalled();
		expect(trash).not.toHaveBeenCalled();
		expectOriginalsIntact(value);
		expect(readdirSync(operationDir)).toEqual([]);
	});

	it("refuses to remove a preparation payload with unknown non-empty contents", async () => {
		const value = fixture();
		const operationId = "20000000-0000-4000-8000-000000000014";
		const operationDir = join(realpathSync(value.agentDir), "schedule-trash", operationId);
		const payload = join(operationDir, "payload");
		const injected = Object.assign(new Error("injected manifest write"), { code: "EIO" });
		faults.manifestOpenError = injected;
		faults.manifestOpenFault = () => {
			writeFileSync(join(payload, "unknown.txt"), "unknown payload content");
		};
		const rename = vi.fn();
		const trash = vi.fn();
		const input = { agentDir: value.agentDir, task: value.task, runs: [value.run], deleteSessions: true };
		let failure: unknown;
		try {
			await trashScheduledTaskData(input, { operationId: () => operationId, rename, trash });
		} catch (error) {
			failure = error;
		}
		resetFaults();

		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors[0]).toBe(injected);
		expect(rename).not.toHaveBeenCalled();
		expect(trash).not.toHaveBeenCalled();
		expectOriginalsIntact(value);
		expect(readdirSync(operationDir)).toEqual(["payload"]);
		expect(readFileSync(join(payload, "unknown.txt"), "utf8")).toBe("unknown payload content");
	});

	it("reports cleanup failure without deleting unknown preparation contents", async () => {
		const value = fixture();
		const injected = Object.assign(new Error("injected payload mkdir"), { code: "EACCES" });
		faults.payloadMkdirError = injected;
		faults.payloadMkdirFault = (payload) => {
			writeFileSync(join(dirname(payload), "sentinel.txt"), "unknown");
		};
		const rename = vi.fn();
		const trash = vi.fn();
		const input = { agentDir: value.agentDir, task: value.task, runs: [value.run], deleteSessions: true };
		let failure: unknown;
		try {
			await trashScheduledTaskData(input, { rename, trash });
		} catch (error) {
			failure = error;
		}
		resetFaults();

		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors[0]).toBe(injected);
		expect((failure as Error).message).toMatch(/preparation cleanup failed/i);
		expect(rename).not.toHaveBeenCalled();
		expect(trash).not.toHaveBeenCalled();
		expectOriginalsIntact(value);
		const operations = readdirSync(join(value.agentDir, "schedule-trash"));
		expect(operations).toHaveLength(1);
		expect(readFileSync(join(value.agentDir, "schedule-trash", operations[0]!, "sentinel.txt"), "utf8")).toBe(
			"unknown",
		);
		expect(() => recoverInterruptedScheduleTrash(value.agentDir)).toThrow(/Missing Schedule Trash manifest/);
	});
});
