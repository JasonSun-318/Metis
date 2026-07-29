import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import lockfile from "proper-lockfile";
import { resolvePath } from "../../utils/paths.ts";
import { createFileAtomicallySync, readSingleLinkTextFileSync } from "../durable-file.ts";
import { assertValidSessionId, createSessionId } from "../session-id.ts";
import { getDefaultSessionDir, SessionManager } from "../session-manager.ts";
import { createScheduleWorkspace, getScheduleLeaderPath, removeOwnedScheduleWorkspace } from "./paths.ts";
import { ScheduleStore } from "./store.ts";
import {
	advancePastNow,
	firstOccurrence,
	nextOccurrence,
	normalizeScheduleSpec,
	validateScheduleInputSpec,
	validateScheduleTimezone,
} from "./time.ts";
import {
	type ScheduleCreateInput,
	type ScheduleCreateTarget,
	ScheduleError,
	type ScheduleEvent,
	type ScheduleExecutionResult,
	type ScheduleRun,
	type ScheduleRunClaim,
	type ScheduleRunListInput,
	type ScheduleRunPage,
	type ScheduleTarget,
	type ScheduleTask,
	type ScheduleTaskPage,
	type ScheduleUpdateInput,
} from "./types.ts";

const MAX_LIST_ITEMS = 200;
const MAX_INSTRUCTION_BYTES = 64 * 1024;
const LEADER_POLL_MS = 15_000;
const OBSERVER_POLL_MS = 2_000;
const MAX_CONCURRENT_RUNS = 2;
const MISSED_GRACE_MS = 60_000;

type OwnedRun = {
	readonly taskId: string;
	readonly controller: AbortController;
	promise: Promise<void>;
};

export interface ScheduleManagerOptions {
	readonly agentDir: string;
	readonly runnerId?: string;
	readonly now?: () => Date;
	readonly execute?: (claim: ScheduleRunClaim, signal: AbortSignal) => Promise<ScheduleExecutionResult>;
}

function validateInstruction(value: unknown): string {
	if (
		typeof value !== "string" ||
		value.trim().length === 0 ||
		Buffer.byteLength(value, "utf8") > MAX_INSTRUCTION_BYTES
	) {
		throw new ScheduleError("INVALID_SCHEDULE", "Task instruction must be non-empty and at most 64 KiB");
	}
	return value;
}

function titleFromInstruction(instruction: string): string {
	const collapsed = instruction.replace(/\s+/gu, " ").trim();
	let title = "";
	for (const character of collapsed) {
		if (title.length + character.length > 120) break;
		title += character;
	}
	return title;
}

function existingRealDirectory(path: string): string {
	const resolved = resolvePath(path);
	try {
		const metadata = lstatSync(resolved);
		if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("not a real directory");
		return realpathSync(resolved);
	} catch (error) {
		throw new ScheduleError("WORKSPACE_MISSING", `Scheduled task workspace is unavailable: ${resolved}`, {
			cause: error,
		});
	}
}

function resolveRunSessionFile(agentDir: string, run: ScheduleRun): string | undefined {
	if (run.sessionFile) return run.sessionFile;
	if (!run.sessionId) return undefined;
	const sessionDir = getDefaultSessionDir(run.snapshot.target.cwd, agentDir);
	const suffix = `_${run.sessionId}.jsonl`;
	const matches = readdirSync(sessionDir).filter((name) => name.endsWith(suffix));
	if (matches.length > 1) {
		throw new ScheduleError("TASK_DELETING", "Scheduled session identity is ambiguous");
	}
	return matches[0] ? join(sessionDir, matches[0]) : undefined;
}

function validateCreateTarget(target: ScheduleCreateTarget): ScheduleCreateTarget {
	if (typeof target !== "object" || target === null)
		throw new ScheduleError("INVALID_SCHEDULE", "Invalid task target");
	if (target.kind === "general" && target.workspace === "fixed") {
		if (
			Object.keys(target).some((key) => key !== "kind" && key !== "workspace" && key !== "cwd") ||
			!isAbsolute(target.cwd)
		) {
			throw new ScheduleError("INVALID_SCHEDULE", "Invalid fixed task target");
		}
		return { kind: "general", workspace: "fixed", cwd: existingRealDirectory(target.cwd) };
	}
	if (
		target.kind === "general" &&
		target.workspace === "task" &&
		Object.keys(target).every((key) => key === "kind" || key === "workspace")
	) {
		return { kind: "general", workspace: "task" };
	}
	throw new ScheduleError("INVALID_SCHEDULE", "Invalid task target");
}

function creationMatches(
	task: ScheduleTask,
	input: {
		instruction: string;
		schedule: ScheduleTask["schedule"];
		timezone: string;
		target: ScheduleCreateTarget;
	},
): boolean {
	const targetMatches =
		input.target.workspace === "fixed"
			? task.target.kind === "general" && task.target.workspace === "fixed" && task.target.cwd === input.target.cwd
			: task.target.kind === "general" && task.target.workspace === "task";
	return (
		task.instruction === input.instruction &&
		JSON.stringify(task.schedule) === JSON.stringify(input.schedule) &&
		task.timezone === input.timezone &&
		targetMatches
	);
}

function calculateNextRunAt(schedule: ScheduleTask["schedule"], timezone: string, now: Date): string {
	const nextRunAt = firstOccurrence(schedule, timezone, now.toISOString());
	if (schedule.kind === "once" && Date.parse(nextRunAt) <= now.getTime()) {
		throw new ScheduleError("INVALID_SCHEDULE", "One-time task must be scheduled in the future");
	}
	return nextRunAt;
}

function taskSnapshot(task: ScheduleTask): ScheduleRun["snapshot"] {
	return {
		instruction: task.instruction,
		schedule: task.schedule,
		timezone: task.timezone,
		target: task.target,
	};
}

function summarizeRun(run: ScheduleRun): NonNullable<ScheduleTask["lastRun"]> {
	return {
		id: run.id,
		taskId: run.taskId,
		sequence: run.sequence,
		status: run.status,
		scheduledFor: run.scheduledFor,
		createdAt: run.createdAt,
		...(run.completedAt ? { completedAt: run.completedAt } : {}),
		...(run.sessionId ? { sessionId: run.sessionId } : {}),
		...(run.resultPreview !== undefined ? { resultPreview: run.resultPreview } : {}),
		...(run.error ? { error: run.error } : {}),
		...(run.reason ? { reason: run.reason } : {}),
		...(run.skippedCount !== undefined ? { skippedCount: run.skippedCount } : {}),
		unread: run.unread,
	};
}

function truncateUtf8(value: string, maximumBytes: number): string {
	if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
	let result = "";
	let bytes = 0;
	for (const character of value) {
		const size = Buffer.byteLength(character, "utf8");
		if (bytes + size > maximumBytes) break;
		result += character;
		bytes += size;
	}
	return result;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: undefined;
}

export class ScheduleManager {
	readonly agentDir: string;
	readonly runnerId: string;
	private readonly store: ScheduleStore;
	private readonly now: () => Date;
	private readonly execute?: ScheduleManagerOptions["execute"];
	private readonly listeners = new Set<(event: ScheduleEvent) => void>();
	private healthError?: ScheduleError;
	private started = false;
	private eventCursor?: number;
	private indexFingerprint?: string;
	private taskSnapshot: readonly ScheduleTask[] = [];
	private leaderTimer?: NodeJS.Timeout;
	private observerTimer?: NodeJS.Timeout;
	private leaderRelease?: () => Promise<void>;
	private leaderTickRunning = false;
	private readonly ownedRuns = new Map<string, OwnedRun>();
	private readonly eligible = new Map<string, string>();

	private constructor(options: ScheduleManagerOptions) {
		this.agentDir = resolvePath(options.agentDir);
		this.runnerId = options.runnerId ?? randomUUID();
		assertValidSessionId(this.runnerId);
		this.now = options.now ?? (() => new Date());
		this.execute = options.execute;
		this.store = ScheduleStore.open(this.agentDir);
	}

	static create(options: ScheduleManagerOptions): ScheduleManager {
		return new ScheduleManager(options);
	}

	async start(): Promise<void> {
		if (this.started) return;
		this.started = true;
		try {
			const index = this.store.readIndex();
			this.eventCursor = index.events.at(-1)?.sequence ?? 0;
			this.indexFingerprint = this.store.indexFingerprint();
			this.taskSnapshot = index.tasks;
			this.armObserver();
			this.armLeaderTick(0);
		} catch (error) {
			if (error instanceof ScheduleError && error.code === "STORE_CORRUPT") {
				this.healthError = error;
				return;
			}
			this.started = false;
			throw error;
		}
	}

	async stop(): Promise<void> {
		if (!this.started && !this.leaderRelease && this.ownedRuns.size === 0) return;
		this.started = false;
		if (this.leaderTimer) clearTimeout(this.leaderTimer);
		if (this.observerTimer) clearTimeout(this.observerTimer);
		this.leaderTimer = undefined;
		this.observerTimer = undefined;
		while (this.leaderTickRunning) await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
		await this.abortOwnedRuns("interrupted");
		const release = this.leaderRelease;
		this.leaderRelease = undefined;
		await release?.().catch(() => undefined);
		this.eligible.clear();
	}

	// biome-ignore lint/suspicious/useAdjacentOverloadSignatures: the static factory and instance mutation share a domain verb.
	async create(input: ScheduleCreateInput): Promise<ScheduleTask> {
		this.assertHealthy();
		assertValidSessionId(input.id);
		const instruction = validateInstruction(input.instruction);
		let schedule: ScheduleTask["schedule"];
		let timezone: string;
		try {
			timezone = validateScheduleTimezone(input.timezone);
			schedule = normalizeScheduleSpec(validateScheduleInputSpec(input.schedule), timezone);
		} catch (error) {
			throw new ScheduleError("INVALID_SCHEDULE", "Invalid task time or recurrence", { cause: error });
		}
		const targetInput = validateCreateTarget(input.target);
		this.ensureEventCursor();
		const current = this.callStore(() => this.store.readIndex().tasks.find(({ id }) => id === input.id));
		if (current) {
			if (
				creationMatches(current, {
					instruction,
					schedule,
					timezone,
					target: targetInput,
				})
			) {
				return current;
			}
			throw new ScheduleError("TASK_ID_REUSED", "Task id was already used for different input");
		}

		let ownedWorkspace: string | undefined;
		try {
			const now = this.now();
			const nextRunAt = calculateNextRunAt(schedule, timezone, now);
			const result = await this.callStoreAsync(() =>
				this.store.mutate((draft, files) => {
					const existing = draft.tasks.find(({ id }) => id === input.id);
					if (existing) {
						if (
							creationMatches(existing, {
								instruction,
								schedule,
								timezone,
								target: targetInput,
							})
						) {
							return existing;
						}
						throw new ScheduleError("TASK_ID_REUSED", "Task id was already used for different input");
					}
					let target: ScheduleTarget;
					if (targetInput.workspace === "task") {
						try {
							ownedWorkspace = createScheduleWorkspace(this.agentDir, input.id);
							target = { kind: "general", workspace: "task", cwd: ownedWorkspace };
						} catch (error) {
							throw new ScheduleError("TASK_ID_REUSED", "Task workspace already exists", { cause: error });
						}
					} else target = targetInput;
					const task: ScheduleTask = {
						id: input.id,
						title: titleFromInstruction(instruction),
						instruction,
						schedule,
						timezone,
						target,
						status: "active",
						createdAt: now.toISOString(),
						updatedAt: now.toISOString(),
						nextRunAt,
						unreadCount: 0,
						nextRunSequence: 1,
					};
					draft.tasks.push(task);
					files.appendEvent({ type: "task-updated", taskId: task.id });
					return task;
				}),
			);
			await this.drainEvents();
			return result;
		} catch (error) {
			if (ownedWorkspace) removeOwnedScheduleWorkspace(this.agentDir, input.id, ownedWorkspace);
			throw error;
		}
	}

	async list(
		input: { afterTaskId?: string; limit?: number; unreadOnly?: boolean; withRunsOnly?: boolean } = {},
	): Promise<ScheduleTaskPage> {
		this.assertHealthy();
		if (input.afterTaskId) assertValidSessionId(input.afterTaskId);
		const limit = Math.min(input.limit ?? 50, MAX_LIST_ITEMS);
		if (!Number.isSafeInteger(limit) || limit < 1) throw new TypeError("Invalid task page limit");
		let tasks = [...this.callStore(() => this.store.readIndex().tasks)]
			.filter((task) => !input.unreadOnly || task.unreadCount > 0)
			.filter((task) => !input.withRunsOnly || task.lastRun !== undefined)
			.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.id.localeCompare(left.id));
		if (input.afterTaskId) {
			const cursor = tasks.findIndex(({ id }) => id === input.afterTaskId);
			if (cursor === -1) throw new ScheduleError("SCHEDULE_NOT_FOUND", "Scheduled task cursor was not found");
			tasks = tasks.slice(cursor + 1);
		}
		const page = tasks.slice(0, limit + 1);
		return {
			tasks: page.slice(0, limit),
			nextAfterTaskId: page.length > limit ? (page[limit - 1]?.id ?? null) : null,
		};
	}

	async get(taskId: string): Promise<ScheduleTask> {
		this.assertHealthy();
		return this.callStore(() => this.store.getTask(taskId));
	}

	unreadCount(): number {
		this.assertHealthy();
		return this.callStore(() => this.store.readIndex().tasks.reduce((total, task) => total + task.unreadCount, 0));
	}

	async update(taskId: string, input: ScheduleUpdateInput): Promise<ScheduleTask> {
		this.assertHealthy();
		assertValidSessionId(taskId);
		if (input.instruction === undefined && input.schedule === undefined) {
			throw new ScheduleError("INVALID_SCHEDULE", "Task update is empty");
		}
		if (Object.keys(input).some((key) => key !== "instruction" && key !== "schedule")) {
			throw new ScheduleError("INVALID_SCHEDULE", "Task update contains unsupported fields");
		}
		this.ensureEventCursor();
		const result = await this.callStoreAsync(() =>
			this.store.mutate((draft, files) => {
				const index = draft.tasks.findIndex(({ id }) => id === taskId);
				if (index === -1) throw new ScheduleError("SCHEDULE_NOT_FOUND", "Scheduled task was not found");
				const current = draft.tasks[index];
				if (current.status === "deleting")
					throw new ScheduleError("TASK_DELETING", "Scheduled task is being deleted");
				if (current.status === "completed" && current.schedule.kind === "once") {
					throw new ScheduleError("INVALID_SCHEDULE", "Completed one-time task cannot be edited");
				}
				const instruction =
					input.instruction === undefined ? current.instruction : validateInstruction(input.instruction);
				let schedule = current.schedule;
				if (input.schedule !== undefined) {
					try {
						schedule = normalizeScheduleSpec(validateScheduleInputSpec(input.schedule), current.timezone);
					} catch (error) {
						throw new ScheduleError("INVALID_SCHEDULE", "Invalid task time or recurrence", { cause: error });
					}
				}
				const now = this.now();
				const updated: ScheduleTask = {
					...current,
					instruction,
					title: titleFromInstruction(instruction),
					schedule,
					updatedAt: now.toISOString(),
					...(input.schedule === undefined
						? {}
						: { nextRunAt: calculateNextRunAt(schedule, current.timezone, now) }),
				};
				draft.tasks[index] = updated;
				files.appendEvent({ type: "task-updated", taskId });
				return updated;
			}),
		);
		await this.drainEvents();
		return result;
	}

	async pause(taskId: string): Promise<ScheduleTask> {
		return this.setPaused(taskId, true);
	}

	async resume(taskId: string): Promise<ScheduleTask> {
		return this.setPaused(taskId, false);
	}

	async delete(taskId: string): Promise<{ taskId: string; deleted: true }> {
		this.assertHealthy();
		assertValidSessionId(taskId);
		this.ensureEventCursor();
		await this.callStoreAsync(() =>
			this.store.mutate((draft, files) => {
				const index = draft.tasks.findIndex(({ id }) => id === taskId);
				if (index === -1) throw new ScheduleError("SCHEDULE_NOT_FOUND", "Scheduled task was not found");
				const current = draft.tasks[index];
				if (current.status !== "deleting") {
					draft.tasks[index] = {
						...current,
						status: "deleting",
						nextRunAt: null,
						deletingSince: this.now().toISOString(),
						updatedAt: this.now().toISOString(),
					};
					files.appendEvent({ type: "task-updated", taskId });
				}
			}),
		);
		if (!this.started || this.leaderRelease) await this.finishDelete(taskId);
		else {
			this.wakeLeader();
			await this.waitForDeletion(taskId);
		}
		await this.drainEvents();
		return { taskId, deleted: true };
	}

	async runNow(taskId: string, runId: string): Promise<ScheduleRun> {
		this.assertHealthy();
		assertValidSessionId(taskId);
		assertValidSessionId(runId);
		this.ensureEventCursor();
		const now = this.now().toISOString();
		const result = await this.callStoreAsync(() =>
			this.store.mutate((draft, files) => {
				const existing = this.store.findRun(runId);
				if (existing) {
					if (existing.taskId === taskId && existing.trigger === "manual") return existing;
					throw new ScheduleError("RUN_ID_REUSED", "Run id was already used");
				}
				const index = draft.tasks.findIndex(({ id }) => id === taskId);
				if (index === -1) throw new ScheduleError("SCHEDULE_NOT_FOUND", "Scheduled task was not found");
				const task = draft.tasks[index];
				if (task.status === "deleting") throw new ScheduleError("TASK_DELETING", "Scheduled task is being deleted");
				if (task.activeRunId) throw new ScheduleError("TASK_BUSY", "Scheduled task already has an active run");
				const run: ScheduleRun = {
					id: runId,
					taskId,
					sequence: task.nextRunSequence,
					trigger: "manual",
					status: "queued",
					scheduledFor: now,
					createdAt: now,
					unread: false,
					snapshot: taskSnapshot(task),
				};
				files.createRun(run);
				files.appendEvent({ type: "run-updated", taskId, runId });
				draft.tasks[index] = { ...task, activeRunId: runId, nextRunSequence: task.nextRunSequence + 1 };
				return run;
			}),
		);
		await this.drainEvents();
		this.wakeLeader();
		return result;
	}

	async listRuns(taskId: string, input: ScheduleRunListInput = {}): Promise<ScheduleRunPage> {
		this.assertHealthy();
		const limit = Math.min(input.limit ?? 20, MAX_LIST_ITEMS);
		return this.callStore(() => this.store.listRuns(taskId, { beforeRunId: input.beforeRunId, limit }));
	}

	async getRun(taskId: string, runId: string): Promise<ScheduleRun> {
		this.assertHealthy();
		return this.callStore(() => this.store.getRun(taskId, runId));
	}

	async markRunRead(taskId: string, runId: string): Promise<ScheduleRun> {
		this.assertHealthy();
		this.ensureEventCursor();
		const result = await this.callStoreAsync(() =>
			this.store.mutate((draft, files) => {
				const current = this.store.getRun(taskId, runId);
				if (!current.unread) return current;
				const index = draft.tasks.findIndex(({ id }) => id === taskId);
				if (index === -1) throw new ScheduleError("SCHEDULE_NOT_FOUND", "Scheduled task was not found");
				const task = draft.tasks[index];
				const updated = { ...current, unread: false };
				files.replaceRun(updated);
				files.appendEvent({ type: "run-updated", taskId, runId });
				draft.tasks[index] = {
					...task,
					unreadCount: Math.max(0, task.unreadCount - 1),
					...(task.lastRun?.id === runId ? { lastRun: { ...task.lastRun, unread: false } } : {}),
				};
				return updated;
			}),
		);
		await this.drainEvents();
		return result;
	}

	subscribe(listener: (event: ScheduleEvent) => void): () => void {
		this.assertHealthy();
		this.ensureEventCursor();
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private async setPaused(taskId: string, paused: boolean): Promise<ScheduleTask> {
		this.assertHealthy();
		assertValidSessionId(taskId);
		this.ensureEventCursor();
		const result = await this.callStoreAsync(() =>
			this.store.mutate((draft, files) => {
				const index = draft.tasks.findIndex(({ id }) => id === taskId);
				if (index === -1) throw new ScheduleError("SCHEDULE_NOT_FOUND", "Scheduled task was not found");
				const current = draft.tasks[index];
				if (current.status === "deleting")
					throw new ScheduleError("TASK_DELETING", "Scheduled task is being deleted");
				if (paused && current.status === "paused") return current;
				if (!paused && current.status === "active") return current;
				if (current.status === "completed") {
					throw new ScheduleError("INVALID_SCHEDULE", "Completed one-time task cannot be paused or resumed");
				}
				const now = this.now();
				if (!paused) existingRealDirectory(current.target.cwd);
				const updated: ScheduleTask = paused
					? { ...current, status: "paused", pauseReason: "user", updatedAt: now.toISOString() }
					: {
							...current,
							status: "active",
							pauseReason: undefined,
							nextRunAt: calculateNextRunAt(current.schedule, current.timezone, now),
							updatedAt: now.toISOString(),
						};
				draft.tasks[index] = updated;
				files.appendEvent({ type: "task-updated", taskId });
				return updated;
			}),
		);
		await this.drainEvents();
		return result;
	}

	private armLeaderTick(delayMs = LEADER_POLL_MS): void {
		if (!this.started || this.healthError) return;
		this.leaderTimer = setTimeout(async () => {
			this.leaderTimer = undefined;
			if (this.leaderTickRunning) {
				this.armLeaderTick();
				return;
			}
			this.leaderTickRunning = true;
			try {
				await this.ensureLeadership();
				if (this.leaderRelease) await this.tickLeader();
			} catch (error) {
				if (error instanceof ScheduleError && error.code === "STORE_CORRUPT") {
					this.healthError = error;
					await this.dropLeadership("interrupted");
				}
			} finally {
				this.leaderTickRunning = false;
				this.armLeaderTick();
			}
		}, delayMs);
		this.leaderTimer.unref();
	}

	private wakeLeader(): void {
		if (!this.started || this.healthError) return;
		if (this.leaderTimer) clearTimeout(this.leaderTimer);
		this.leaderTimer = undefined;
		this.armLeaderTick(0);
	}

	private armObserver(): void {
		if (!this.started || this.healthError) return;
		this.observerTimer = setTimeout(async () => {
			this.observerTimer = undefined;
			try {
				await this.drainEvents();
			} catch (error) {
				if (error instanceof ScheduleError && error.code === "STORE_CORRUPT") {
					this.healthError = error;
					await this.dropLeadership("interrupted");
				}
			} finally {
				this.armObserver();
			}
		}, OBSERVER_POLL_MS);
		this.observerTimer.unref();
	}

	private async ensureLeadership(): Promise<void> {
		if (this.leaderRelease || !this.started) return;
		const path = getScheduleLeaderPath(this.agentDir);
		if (!existsSync(path)) {
			try {
				createFileAtomicallySync(path, "", { mode: 0o600 });
			} catch (error) {
				if (errorCode(error) !== "EEXIST") throw error;
			}
		}
		if (readSingleLinkTextFileSync(path, { maxBytes: 0 }) === undefined) {
			throw new ScheduleError("STORE_CORRUPT", "Schedule leader file is unsafe");
		}
		let release: (() => Promise<void>) | undefined;
		try {
			release = await lockfile.lock(path, {
				realpath: false,
				stale: 45_000,
				update: 15_000,
				retries: 0,
				onCompromised: () => {
					if (this.leaderRelease === release) void this.dropLeadership("interrupted", false);
				},
			});
		} catch (error) {
			if (errorCode(error) === "ELOCKED") return;
			throw new ScheduleError("STORE_CORRUPT", "Schedule leader lock is unavailable", { cause: error });
		}
		if (!this.started) {
			await release().catch(() => undefined);
			return;
		}
		this.leaderRelease = release;
		await this.store.reconcile();
		await this.recoverInterruptedRuns();
		await this.drainEvents();
	}

	private async dropLeadership(reason: "interrupted", releaseLock = true): Promise<void> {
		const release = this.leaderRelease;
		this.leaderRelease = undefined;
		await this.abortOwnedRuns(reason);
		if (releaseLock) await release?.().catch(() => undefined);
		this.eligible.clear();
	}

	private async recoverInterruptedRuns(): Promise<void> {
		await this.store.mutate((draft, files) => {
			for (let taskIndex = 0; taskIndex < draft.tasks.length; taskIndex += 1) {
				let task = draft.tasks[taskIndex];
				if (!task.activeRunId) continue;
				let active: ScheduleRun;
				try {
					active = this.store.getRun(task.id, task.activeRunId);
				} catch {
					continue;
				}
				if (active.status !== "running") continue;
				const failed: ScheduleRun = {
					...active,
					status: "failed",
					completedAt: this.now().toISOString(),
					error: { code: "INTERRUPTED", message: "Scheduled run was interrupted" },
					reason: "interrupted",
					unread: true,
				};
				files.replaceRun(failed);
				files.appendEvent({ type: "run-updated", taskId: task.id, runId: active.id });
				task = {
					...task,
					activeRunId: undefined,
					lastRun: summarizeRun(failed),
					unreadCount: task.unreadCount + (active.unread ? 0 : 1),
					updatedAt: this.now().toISOString(),
					...(active.trigger === "scheduled" && active.snapshot.schedule.kind === "once"
						? { status: "completed" }
						: {}),
				};
				draft.tasks[taskIndex] = task;
			}
		});
	}

	private async tickLeader(): Promise<void> {
		const tasks = this.taskSnapshot;
		for (const task of tasks.filter(({ status }) => status === "deleting")) {
			await this.finishDelete(task.id);
		}

		for (const task of tasks) {
			if (this.ownedRuns.size >= MAX_CONCURRENT_RUNS) break;
			if (!task.activeRunId || task.status === "deleting") continue;
			let run: ScheduleRun;
			try {
				run = this.store.getRun(task.id, task.activeRunId);
			} catch {
				continue;
			}
			if (run.status === "queued") await this.startQueuedRun(task, run);
		}

		const now = this.now();
		const dueTasks = tasks
			.filter(
				(task) =>
					task.status === "active" && task.nextRunAt !== null && Date.parse(task.nextRunAt) <= now.getTime(),
			)
			.sort(
				(left, right) =>
					(left.nextRunAt ?? "").localeCompare(right.nextRunAt ?? "") || left.id.localeCompare(right.id),
			);
		for (const task of dueTasks) {
			const scheduledFor = task.nextRunAt;
			if (!scheduledFor) continue;
			if (task.activeRunId) {
				await this.recordSkippedOrMissed(task, "skipped", "overlap");
				this.eligible.delete(task.id);
				continue;
			}
			const observed = this.eligible.get(task.id) === scheduledFor;
			if (!observed && now.getTime() - Date.parse(scheduledFor) > MISSED_GRACE_MS) {
				await this.recordSkippedOrMissed(task, "missed", "offline");
				continue;
			}
			this.eligible.set(task.id, scheduledFor);
		}

		for (const [taskId, scheduledFor] of [...this.eligible]) {
			if (this.ownedRuns.size >= MAX_CONCURRENT_RUNS) break;
			let task: ScheduleTask;
			try {
				task = this.store.getTask(taskId);
			} catch {
				this.eligible.delete(taskId);
				continue;
			}
			if (task.status !== "active" || task.nextRunAt !== scheduledFor || task.activeRunId) {
				this.eligible.delete(taskId);
				continue;
			}
			await this.claimScheduledRun(task);
		}
	}

	private async startQueuedRun(task: ScheduleTask, queued: ScheduleRun): Promise<void> {
		try {
			existingRealDirectory(task.target.cwd);
		} catch {
			await this.failMissingWorkspace(task, queued);
			return;
		}
		const running = await this.store.mutate((draft, files) => {
			const taskIndex = draft.tasks.findIndex(({ id }) => id === task.id);
			if (taskIndex === -1 || draft.tasks[taskIndex].status === "deleting") return undefined;
			const current = this.store.getRun(task.id, queued.id);
			if (current.status !== "queued") return undefined;
			const next: ScheduleRun = {
				...current,
				status: "running",
				startedAt: this.now().toISOString(),
				runnerId: this.runnerId,
				sessionId: current.sessionId ?? createSessionId(),
			};
			files.replaceRun(next);
			files.appendEvent({ type: "run-updated", taskId: task.id, runId: next.id });
			return next;
		});
		if (!running) return;
		await this.drainEvents();
		this.startExecution(running);
	}

	private async claimScheduledRun(task: ScheduleTask): Promise<void> {
		try {
			existingRealDirectory(task.target.cwd);
		} catch {
			await this.failMissingWorkspace(task);
			this.eligible.delete(task.id);
			return;
		}
		const scheduledFor = task.nextRunAt;
		if (!scheduledFor) return;
		const now = this.now().toISOString();
		const runId = randomUUID();
		const running = await this.store.mutate((draft, files) => {
			const taskIndex = draft.tasks.findIndex(({ id }) => id === task.id);
			if (taskIndex === -1) return undefined;
			const current = draft.tasks[taskIndex];
			if (current.status !== "active" || current.activeRunId || current.nextRunAt !== scheduledFor) return undefined;
			const run: ScheduleRun = {
				id: runId,
				taskId: current.id,
				sessionId: createSessionId(),
				sequence: current.nextRunSequence,
				trigger: "scheduled",
				status: "running",
				scheduledFor,
				createdAt: now,
				startedAt: now,
				runnerId: this.runnerId,
				unread: false,
				snapshot: taskSnapshot(current),
			};
			files.createRun(run);
			files.appendEvent({ type: "run-updated", taskId: current.id, runId });
			draft.tasks[taskIndex] = {
				...current,
				activeRunId: runId,
				nextRunSequence: current.nextRunSequence + 1,
				nextRunAt:
					current.schedule.kind === "once"
						? null
						: nextOccurrence(current.schedule, current.timezone, scheduledFor),
			};
			return run;
		});
		this.eligible.delete(task.id);
		if (!running) return;
		await this.drainEvents();
		this.startExecution(running);
	}

	private startExecution(run: ScheduleRun): void {
		const controller = new AbortController();
		const state: OwnedRun = { taskId: run.taskId, controller, promise: Promise.resolve() };
		this.ownedRuns.set(run.id, state);
		state.promise = this.performExecution(run, controller.signal)
			.catch((error) => {
				this.healthError =
					error instanceof ScheduleError && error.code === "STORE_CORRUPT"
						? error
						: new ScheduleError("STORE_CORRUPT", "Scheduled run state could not be persisted", { cause: error });
			})
			.finally(() => {
				if (this.ownedRuns.get(run.id) === state) this.ownedRuns.delete(run.id);
				if (this.healthError) void this.dropLeadership("interrupted").catch(() => undefined);
				else this.wakeLeader();
			});
	}

	private async performExecution(run: ScheduleRun, signal: AbortSignal): Promise<void> {
		try {
			if (!this.execute) throw new ScheduleError("SANDBOX_UNAVAILABLE", "Scheduled executor is unavailable");
			if (!run.sessionId) throw new ScheduleError("STORE_CORRUPT", "Scheduled run is missing its session id");
			const result = await this.execute(
				{
					taskId: run.taskId,
					runId: run.id,
					sessionId: run.sessionId,
					scheduledFor: run.scheduledFor,
					snapshot: run.snapshot,
				},
				signal,
			);
			if (result.runId !== run.id) throw new Error("Scheduled executor returned the wrong run id");
			await this.finalizeExecution(run, {
				status: "succeeded",
				completedAt: this.now().toISOString(),
				sessionId: result.sessionId,
				sessionFile: result.sessionFile,
				resultPreview: truncateUtf8(result.result, 4 * 1024),
				unread: true,
			});
		} catch (error) {
			const abortReason = signal.aborted ? signal.reason : undefined;
			const deleted = abortReason === "deleted";
			const interrupted = signal.aborted && !deleted;
			const workspaceMissing = error instanceof ScheduleError && error.code === "WORKSPACE_MISSING";
			const executionSession = error instanceof ScheduleError ? error.executionSession : undefined;
			await this.finalizeExecution(
				run,
				deleted
					? {
							status: "cancelled",
							completedAt: this.now().toISOString(),
							reason: "deleted",
							...executionSession,
							unread: false,
						}
					: {
							status: "failed",
							completedAt: this.now().toISOString(),
							error: {
								code: interrupted
									? "INTERRUPTED"
									: error instanceof ScheduleError
										? error.code
										: "EXECUTION_FAILED",
								message: truncateUtf8(
									interrupted
										? "Scheduled run was interrupted"
										: error instanceof Error
											? error.message.split(/\r?\n/, 1)[0]
											: "Scheduled run failed",
									4 * 1024,
								),
							},
							...(interrupted ? { reason: "interrupted" as const } : {}),
							...executionSession,
							unread: true,
						},
				workspaceMissing,
			);
		}
	}

	private async finalizeExecution(
		run: ScheduleRun,
		patch: Pick<ScheduleRun, "status" | "completedAt" | "unread"> &
			Partial<Pick<ScheduleRun, "sessionId" | "sessionFile" | "resultPreview" | "error" | "reason">>,
		autoPause = false,
	): Promise<void> {
		await this.store.mutate((draft, files) => {
			const taskIndex = draft.tasks.findIndex(({ id }) => id === run.taskId);
			if (taskIndex === -1) return;
			const currentRun = this.store.getRun(run.taskId, run.id);
			if (currentRun.status !== "running") return;
			const updated: ScheduleRun = { ...currentRun, ...patch };
			files.replaceRun(updated);
			files.appendEvent({ type: "run-updated", taskId: run.taskId, runId: run.id });
			const task = draft.tasks[taskIndex];
			draft.tasks[taskIndex] = {
				...task,
				activeRunId: task.activeRunId === run.id ? undefined : task.activeRunId,
				lastRun: summarizeRun(updated),
				unreadCount: task.unreadCount + (updated.unread && !currentRun.unread ? 1 : 0),
				updatedAt: this.now().toISOString(),
				...(task.status === "deleting"
					? {}
					: autoPause
						? { status: "paused" as const, pauseReason: "workspace_missing" as const }
						: run.trigger === "scheduled" && run.snapshot.schedule.kind === "once"
							? { status: "completed" as const }
							: {}),
			};
		});
		await this.drainEvents();
	}

	private async failMissingWorkspace(task: ScheduleTask, queued?: ScheduleRun): Promise<void> {
		const now = this.now().toISOString();
		await this.store.mutate((draft, files) => {
			const taskIndex = draft.tasks.findIndex(({ id }) => id === task.id);
			if (taskIndex === -1) return;
			const current = draft.tasks[taskIndex];
			let failed: ScheduleRun;
			if (queued) {
				const currentRun = this.store.getRun(task.id, queued.id);
				if (currentRun.status !== "queued") return;
				failed = {
					...currentRun,
					status: "failed",
					completedAt: now,
					error: { code: "WORKSPACE_MISSING", message: "Scheduled task workspace is unavailable" },
					unread: true,
				};
				files.replaceRun(failed);
			} else {
				const scheduledFor = current.nextRunAt;
				if (!scheduledFor) return;
				failed = {
					id: randomUUID(),
					taskId: current.id,
					sequence: current.nextRunSequence,
					trigger: "scheduled",
					status: "failed",
					scheduledFor,
					createdAt: now,
					completedAt: now,
					error: { code: "WORKSPACE_MISSING", message: "Scheduled task workspace is unavailable" },
					unread: true,
					snapshot: taskSnapshot(current),
				};
				files.createRun(failed);
			}
			files.appendEvent({ type: "run-updated", taskId: current.id, runId: failed.id });
			draft.tasks[taskIndex] = {
				...current,
				...(current.status === "completed"
					? { status: "completed" as const, pauseReason: undefined }
					: { status: "paused" as const, pauseReason: "workspace_missing" as const }),
				activeRunId: undefined,
				...(queued ? {} : { nextRunSequence: current.nextRunSequence + 1 }),
				nextRunAt:
					queued || current.schedule.kind === "once" || current.nextRunAt === null
						? current.nextRunAt
						: nextOccurrence(current.schedule, current.timezone, current.nextRunAt),
				lastRun: summarizeRun(failed),
				unreadCount: current.unreadCount + 1,
				updatedAt: now,
			};
		});
		await this.drainEvents();
	}

	private async recordSkippedOrMissed(
		task: ScheduleTask,
		status: "skipped" | "missed",
		reason: "overlap" | "offline",
	): Promise<void> {
		const scheduledFor = task.nextRunAt;
		if (!scheduledFor) return;
		const now = this.now().toISOString();
		await this.store.mutate((draft, files) => {
			const taskIndex = draft.tasks.findIndex(({ id }) => id === task.id);
			if (taskIndex === -1) return;
			const current = draft.tasks[taskIndex];
			if (current.nextRunAt !== scheduledFor) return;
			const advanced =
				current.schedule.kind === "once"
					? undefined
					: advancePastNow({
							spec: current.schedule,
							timezone: current.timezone,
							dueAt: scheduledFor,
							now,
						});
			const run: ScheduleRun = {
				id: randomUUID(),
				taskId: current.id,
				sequence: current.nextRunSequence,
				trigger: "scheduled",
				status,
				scheduledFor,
				createdAt: now,
				completedAt: now,
				reason,
				...(advanced && advanced.skippedCount > 0 ? { skippedCount: advanced.skippedCount } : {}),
				unread: true,
				snapshot: taskSnapshot(current),
			};
			files.createRun(run);
			files.appendEvent({ type: "run-updated", taskId: current.id, runId: run.id });
			draft.tasks[taskIndex] = {
				...current,
				nextRunSequence: current.nextRunSequence + 1,
				nextRunAt: advanced?.nextRunAt ?? null,
				lastRun: summarizeRun(run),
				unreadCount: current.unreadCount + 1,
				updatedAt: now,
				...(current.schedule.kind === "once" ? { status: "completed" as const } : {}),
			};
		});
		await this.drainEvents();
	}

	private async abortOwnedRuns(reason: "deleted" | "interrupted", taskId?: string): Promise<void> {
		const matching = [...this.ownedRuns.values()].filter((run) => taskId === undefined || run.taskId === taskId);
		for (const run of matching) run.controller.abort(reason);
		await Promise.allSettled(matching.map(({ promise }) => promise));
	}

	private async waitForDeletion(taskId: string): Promise<void> {
		while (true) {
			try {
				this.store.getTask(taskId);
			} catch (error) {
				if (error instanceof ScheduleError && error.code === "SCHEDULE_NOT_FOUND") return;
				throw error;
			}
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
		}
	}

	private async finishDelete(taskId: string): Promise<void> {
		await this.abortOwnedRuns("deleted", taskId);
		let task: ScheduleTask;
		try {
			task = this.store.getTask(taskId);
		} catch (error) {
			if (error instanceof ScheduleError && error.code === "SCHEDULE_NOT_FOUND") return;
			throw error;
		}
		const runs = this.store.listAllRuns(taskId);
		const active = runs.find(({ id }) => id === task.activeRunId);
		if (active && (active.status === "queued" || active.status === "running")) {
			const cancelled: ScheduleRun = {
				...active,
				status: "cancelled",
				completedAt: this.now().toISOString(),
				reason: "deleted",
				unread: false,
			};
			await this.store.mutate((draft, files) => {
				const index = draft.tasks.findIndex(({ id }) => id === taskId);
				if (index === -1) return;
				files.replaceRun(cancelled);
				draft.tasks[index] = { ...draft.tasks[index], activeRunId: undefined };
			});
		}
		for (const run of this.store.listAllRuns(taskId)) {
			const sessionFile = resolveRunSessionFile(this.agentDir, run);
			if (!sessionFile) continue;
			const result = await SessionManager.deleteSession(sessionFile, {
				agentDir: this.agentDir,
				permanent: true,
				expectedScheduled: { taskId, runId: run.id },
			});
			if (!result.ok) throw new ScheduleError("TASK_DELETING", result.error ?? "Failed to delete scheduled session");
		}
		if (task.target.kind === "general" && task.target.workspace === "task") {
			if (!removeOwnedScheduleWorkspace(this.agentDir, task.id, task.target.cwd)) {
				throw new ScheduleError("TASK_DELETING", "Task workspace ownership check failed");
			}
		}
		await this.store.mutate((draft, files) => {
			if (!draft.tasks.some(({ id }) => id === taskId)) return;
			files.removeRunDirectory(taskId);
			files.appendEvent({ type: "task-deleted", taskId });
			draft.tasks = draft.tasks.filter(({ id }) => id !== taskId);
		});
	}

	private assertHealthy(): void {
		if (this.healthError) throw this.healthError;
	}

	private ensureEventCursor(): void {
		if (this.eventCursor !== undefined) return;
		const index = this.callStore(() => this.store.readIndex());
		this.eventCursor = index.events.at(-1)?.sequence ?? 0;
	}

	private async drainEvents(): Promise<void> {
		const fingerprint = this.store.indexFingerprint();
		if (fingerprint === this.indexFingerprint) return;
		const index = this.callStore(() => this.store.readIndex());
		this.indexFingerprint = fingerprint;
		this.taskSnapshot = index.tasks;
		const cursor = this.eventCursor ?? 0;
		if (index.events.length > 0 && cursor < index.events[0].sequence - 1) {
			this.emit({ type: "schedule/refreshed", revision: index.revision });
			this.eventCursor = index.events.at(-1)?.sequence ?? cursor;
			return;
		}
		for (const envelope of index.events) {
			if (envelope.sequence <= cursor) continue;
			if (envelope.type === "task-deleted") {
				this.emit({ type: "schedule/deleted", revision: envelope.revision, taskId: envelope.taskId });
			} else {
				const task = index.tasks.find(({ id }) => id === envelope.taskId);
				if (!task) {
					this.emit({ type: "schedule/refreshed", revision: index.revision });
				} else if (envelope.type === "task-updated") {
					this.emit({ type: "schedule/updated", revision: envelope.revision, task });
				} else if (envelope.runId) {
					try {
						const run = this.store.getRun(envelope.taskId, envelope.runId);
						this.emit({ type: "schedule/run-updated", revision: envelope.revision, task, run });
					} catch {
						this.emit({ type: "schedule/refreshed", revision: index.revision });
					}
				}
			}
			this.eventCursor = envelope.sequence;
		}
	}

	private emit(event: ScheduleEvent): void {
		for (const listener of this.listeners) listener(event);
	}

	private callStore<T>(operation: () => T): T {
		try {
			return operation();
		} catch (error) {
			if (error instanceof ScheduleError && error.code === "STORE_CORRUPT") this.healthError = error;
			throw error;
		}
	}

	private async callStoreAsync<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof ScheduleError && error.code === "STORE_CORRUPT") this.healthError = error;
			throw error;
		}
	}
}
