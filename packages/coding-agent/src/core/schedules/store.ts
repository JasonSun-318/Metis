import { type Dirent, existsSync, lstatSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import lockfile from "proper-lockfile";
import { createFileAtomicallySync, readSingleLinkTextFileSync, replaceFileAtomicallySync } from "../durable-file.ts";
import { assertValidSessionId } from "../session-id.ts";
import {
	ensureScheduleDirectories,
	ensureScheduleRunDirectory,
	getScheduleIndexPath,
	getScheduleRunDir,
	getScheduleRunPath,
	getScheduleRunsRoot,
	getScheduleWorkspacesRoot,
	removeOwnedScheduleWorkspace,
	removeScheduleRunDirectory,
} from "./paths.ts";
import { summarizeRun } from "./run-summary.ts";
import { advancePastNow, validateScheduleSpec, validateScheduleTimezone } from "./time.ts";
import {
	ScheduleError,
	type ScheduleRun,
	type ScheduleRunSummary,
	type ScheduleStoreEvent,
	type ScheduleTask,
} from "./types.ts";

const INDEX_VERSION = 2;
const MAX_TASKS = 10_000;
const MAX_EVENTS = 256;
const MAX_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_RUN_BYTES = 256 * 1024;
const MAX_INSTRUCTION_BYTES = 64 * 1024;
const MAX_NAME_BYTES = 1024;
const MAX_DESCRIPTION_BYTES = 64 * 1024;
const MAX_PREVIEW_BYTES = 4 * 1024;
const MAX_ERROR_BYTES = 4 * 1024;
const ORPHAN_GRACE_MS = 10 * 60 * 1000;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export interface ScheduleIndex {
	readonly version: 2;
	readonly revision: number;
	readonly tasks: readonly ScheduleTask[];
	readonly events: readonly ScheduleStoreEvent[];
}

export interface MutableScheduleIndex {
	version: 2;
	revision: number;
	tasks: ScheduleTask[];
	events: ScheduleStoreEvent[];
}

type PendingEvent = Pick<ScheduleStoreEvent, "type" | "taskId" | "runId">;

export interface ScheduleFileMutation {
	createRun(run: ScheduleRun): void;
	replaceRun(run: ScheduleRun): void;
	removeRunDirectory(taskId: string): void;
	appendEvent(event: PendingEvent): void;
}

function storeCorrupt(message: string, cause?: unknown): ScheduleError {
	return new ScheduleError("STORE_CORRUPT", message, cause === undefined ? undefined : { cause });
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
	if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) {
		throw new Error(`Invalid ${label}`);
	}
	return value;
}

function string(value: unknown, label: string, maximumBytes = Number.POSITIVE_INFINITY): string {
	if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > maximumBytes)
		throw new Error(`Invalid ${label}`);
	return value;
}

function nonemptyString(value: unknown, label: string, maximumBytes: number): string {
	const result = string(value, label, maximumBytes);
	if (result.trim().length === 0) throw new Error(`Invalid ${label}`);
	return result;
}

function integer(value: unknown, label: string, minimum = 0): number {
	if (!Number.isSafeInteger(value) || (value as number) < minimum) throw new Error(`Invalid ${label}`);
	return value as number;
}

function boolean(value: unknown, label: string): boolean {
	if (typeof value !== "boolean") throw new Error(`Invalid ${label}`);
	return value;
}

function id(value: unknown, label: string): string {
	const result = string(value, label, 255);
	assertValidSessionId(result);
	return result;
}

function timestamp(value: unknown, label: string): string {
	const result = string(value, label, 64);
	if (!TIMESTAMP_PATTERN.test(result) || !Number.isFinite(Date.parse(result))) throw new Error(`Invalid ${label}`);
	return result;
}

function optional<T>(value: unknown, parse: (input: unknown) => T): T | undefined {
	return value === undefined ? undefined : parse(value);
}

function parseRunError(value: unknown): { code: string; message: string } {
	const input = record(value, "schedule run error", ["code", "message"]);
	return {
		code: nonemptyString(input.code, "schedule run error code", 128),
		message: string(input.message, "schedule run error message", MAX_ERROR_BYTES),
	};
}

const RUN_STATUSES = new Set(["queued", "running", "succeeded", "failed", "missed", "skipped", "cancelled"]);
const RUN_REASONS = new Set(["overlap", "offline", "interrupted", "deleted"]);
const TASK_STATUSES = new Set(["active", "paused", "completed", "deleting"]);

function parseRunStatus(value: unknown): ScheduleRun["status"] {
	if (typeof value !== "string" || !RUN_STATUSES.has(value)) throw new Error("Invalid schedule run status");
	return value as ScheduleRun["status"];
}

function parseRunReason(value: unknown): ScheduleRun["reason"] {
	if (typeof value !== "string" || !RUN_REASONS.has(value)) throw new Error("Invalid schedule run reason");
	return value as ScheduleRun["reason"];
}

function parseTarget(value: unknown, legacy = false): ScheduleTask["target"] {
	const input = record(
		value,
		"schedule target",
		legacy ? ["kind", "workspace", "cwd"] : ["kind", "workspace", "cwd", "additionalWorkspaceCwd"],
	);
	const cwd = string(input.cwd, "schedule target cwd", 32 * 1024);
	if (!isAbsolute(cwd) || cwd.includes("\0")) throw new Error("Invalid schedule target cwd");
	if (legacy && input.kind === "project") {
		record(value, "project schedule target", ["kind", "cwd"]);
		return { kind: "general", workspace: "fixed", cwd };
	}
	if (input.kind === "general" && (input.workspace === "task" || input.workspace === "fixed")) {
		if (input.workspace === "fixed") {
			if (input.additionalWorkspaceCwd !== undefined)
				throw new Error("Fixed schedule target has an additional workspace");
			return { kind: "general", workspace: "fixed", cwd };
		}
		const additionalWorkspaceCwd =
			input.additionalWorkspaceCwd === undefined
				? undefined
				: string(input.additionalWorkspaceCwd, "schedule target additional workspace cwd", 32 * 1024);
		if (
			additionalWorkspaceCwd !== undefined &&
			(!isAbsolute(additionalWorkspaceCwd) || additionalWorkspaceCwd.includes("\0"))
		) {
			throw new Error("Invalid schedule target additional workspace cwd");
		}
		return {
			kind: "general",
			workspace: "task",
			cwd,
			...(additionalWorkspaceCwd === undefined ? {} : { additionalWorkspaceCwd }),
		};
	}
	throw new Error("Invalid schedule target");
}

function parseModel(value: unknown): ScheduleTask["model"] {
	const input = record(value, "schedule model", ["provider", "modelId"]);
	return {
		provider: nonemptyString(input.provider, "schedule model provider", 255),
		modelId: nonemptyString(input.modelId, "schedule model id", 255),
	};
}

function parseSnapshot(value: unknown, legacyTask?: ScheduleTask): ScheduleRun["snapshot"] {
	const input = record(value, "schedule snapshot", [
		"name",
		"description",
		"instruction",
		"model",
		"schedule",
		"timezone",
		"target",
	]);
	const legacySnapshot = legacyTask !== undefined && input.name === undefined && input.model === undefined;
	return {
		name:
			input.name === undefined
				? (legacyTask?.title ?? "Scheduled task")
				: nonemptyString(input.name, "schedule name", MAX_NAME_BYTES),
		...optional(input.description, (item) => ({
			description: string(item, "schedule description", MAX_DESCRIPTION_BYTES),
		})),
		instruction: nonemptyString(input.instruction, "schedule instruction", MAX_INSTRUCTION_BYTES),
		model:
			input.model === undefined
				? (legacyTask?.model ?? { provider: "legacy", modelId: "unassigned" })
				: parseModel(input.model),
		schedule: validateScheduleSpec(input.schedule),
		timezone: validateScheduleTimezone(input.timezone),
		target: parseTarget(input.target, legacySnapshot),
	};
}

function parseRunSummary(value: unknown): ScheduleRunSummary {
	const input = record(value, "schedule run summary", [
		"id",
		"taskId",
		"sequence",
		"status",
		"scheduledFor",
		"createdAt",
		"completedAt",
		"sessionId",
		"resultPreview",
		"error",
		"reason",
		"skippedCount",
		"unread",
	]);
	return {
		id: id(input.id, "schedule run id"),
		taskId: id(input.taskId, "schedule task id"),
		sequence: integer(input.sequence, "schedule run sequence", 1),
		status: parseRunStatus(input.status),
		scheduledFor: timestamp(input.scheduledFor, "schedule run time"),
		createdAt: timestamp(input.createdAt, "schedule run creation time"),
		...optional(input.completedAt, (item) => ({ completedAt: timestamp(item, "schedule run completion time") })),
		...optional(input.sessionId, (item) => ({ sessionId: id(item, "schedule session id") })),
		...optional(input.resultPreview, (item) => ({
			resultPreview: string(item, "schedule result preview", MAX_PREVIEW_BYTES),
		})),
		...optional(input.error, (item) => ({ error: parseRunError(item) })),
		...optional(input.reason, (item) => ({ reason: parseRunReason(item) })),
		...optional(input.skippedCount, (item) => ({ skippedCount: integer(item, "schedule skipped count") })),
		unread: boolean(input.unread, "schedule unread state"),
	};
}

function parseTask(value: unknown, legacy = false): ScheduleTask {
	const input = record(value, "schedule task", [
		"id",
		"title",
		"description",
		"instruction",
		"model",
		"schedule",
		"timezone",
		"target",
		"status",
		"createdAt",
		"updatedAt",
		"nextRunAt",
		"activeRunId",
		"unreadCount",
		"lastRun",
		"pauseReason",
		"deletingSince",
		"deletionDeleteSessions",
		"deletionPreviousState",
		"nextRunSequence",
		...(legacy ? (["createdFromSessionId"] as const) : []),
	]);
	if (legacy && input.createdFromSessionId !== undefined) {
		id(input.createdFromSessionId, "schedule source session id");
	}
	if (typeof input.status !== "string" || !TASK_STATUSES.has(input.status))
		throw new Error("Invalid schedule task status");
	if (typeof input.title !== "string" || input.title.length === 0 || input.title.length > 120) {
		throw new Error("Invalid schedule task title");
	}
	if (input.nextRunAt !== null && input.nextRunAt === undefined) throw new Error("Invalid schedule next run time");
	if (
		input.pauseReason !== undefined &&
		input.pauseReason !== "user" &&
		input.pauseReason !== "workspace_missing" &&
		input.pauseReason !== "model_unavailable"
	) {
		throw new Error("Invalid schedule pause reason");
	}
	return {
		id: id(input.id, "schedule task id"),
		title: input.title,
		...optional(input.description, (item) => ({
			description: string(item, "schedule description", MAX_DESCRIPTION_BYTES),
		})),
		instruction: nonemptyString(input.instruction, "schedule instruction", MAX_INSTRUCTION_BYTES),
		model:
			input.model === undefined && legacy ? { provider: "legacy", modelId: "unassigned" } : parseModel(input.model),
		schedule: validateScheduleSpec(input.schedule),
		timezone: validateScheduleTimezone(input.timezone),
		target: parseTarget(input.target, legacy),
		status: legacy ? "paused" : (input.status as ScheduleTask["status"]),
		createdAt: timestamp(input.createdAt, "schedule task creation time"),
		updatedAt: timestamp(input.updatedAt, "schedule task update time"),
		nextRunAt: legacy ? null : input.nextRunAt === null ? null : timestamp(input.nextRunAt, "schedule next run time"),
		...(legacy ? {} : optional(input.activeRunId, (item) => ({ activeRunId: id(item, "active schedule run id") }))),
		unreadCount: integer(input.unreadCount, "schedule unread count"),
		...optional(input.lastRun, (item) => ({ lastRun: parseRunSummary(item) })),
		...(legacy
			? { pauseReason: "model_unavailable" as const }
			: input.pauseReason === undefined
				? {}
				: { pauseReason: input.pauseReason }),
		...optional(input.deletingSince, (item) => ({ deletingSince: timestamp(item, "schedule deletion time") })),
		...optional(input.deletionDeleteSessions, (item) => ({
			deletionDeleteSessions: boolean(item, "schedule delete sessions flag"),
		})),
		...optional(input.deletionPreviousState, (item) => {
			const previous = record(item, "schedule deletion previous state", ["status", "nextRunAt", "pauseReason"]);
			if (previous.status !== "active" && previous.status !== "paused" && previous.status !== "completed") {
				throw new Error("Invalid schedule deletion previous status");
			}
			if (
				previous.pauseReason !== undefined &&
				previous.pauseReason !== "user" &&
				previous.pauseReason !== "workspace_missing" &&
				previous.pauseReason !== "model_unavailable"
			) {
				throw new Error("Invalid schedule deletion previous pause reason");
			}
			return {
				deletionPreviousState: {
					status: previous.status,
					nextRunAt:
						previous.nextRunAt === null
							? null
							: timestamp(previous.nextRunAt, "schedule deletion previous next run time"),
					...(previous.pauseReason === undefined ? {} : { pauseReason: previous.pauseReason }),
				},
			};
		}),
		nextRunSequence: integer(input.nextRunSequence, "schedule next run sequence", 1),
	};
}

function parseRun(value: unknown, legacyTask?: ScheduleTask): ScheduleRun {
	const input = record(value, "schedule run", [
		"id",
		"taskId",
		"sequence",
		"trigger",
		"status",
		"scheduledFor",
		"createdAt",
		"startedAt",
		"completedAt",
		"runnerId",
		"sessionId",
		"sessionFile",
		"resultPreview",
		"error",
		"reason",
		"skippedCount",
		"unread",
		"snapshot",
	]);
	if (input.trigger !== "scheduled" && input.trigger !== "manual") throw new Error("Invalid schedule run trigger");
	return {
		id: id(input.id, "schedule run id"),
		taskId: id(input.taskId, "schedule task id"),
		sequence: integer(input.sequence, "schedule run sequence", 1),
		trigger: input.trigger,
		status: parseRunStatus(input.status),
		scheduledFor: timestamp(input.scheduledFor, "schedule run time"),
		createdAt: timestamp(input.createdAt, "schedule run creation time"),
		...optional(input.startedAt, (item) => ({ startedAt: timestamp(item, "schedule run start time") })),
		...optional(input.completedAt, (item) => ({ completedAt: timestamp(item, "schedule run completion time") })),
		...optional(input.runnerId, (item) => ({ runnerId: id(item, "schedule runner id") })),
		...optional(input.sessionId, (item) => ({ sessionId: id(item, "schedule session id") })),
		...optional(input.sessionFile, (item) => ({ sessionFile: string(item, "schedule session file", 32 * 1024) })),
		...optional(input.resultPreview, (item) => ({
			resultPreview: string(item, "schedule result preview", MAX_PREVIEW_BYTES),
		})),
		...optional(input.error, (item) => ({ error: parseRunError(item) })),
		...optional(input.reason, (item) => ({ reason: parseRunReason(item) })),
		...optional(input.skippedCount, (item) => ({ skippedCount: integer(item, "schedule skipped count") })),
		unread: boolean(input.unread, "schedule unread state"),
		snapshot: parseSnapshot(input.snapshot, legacyTask),
	};
}

function parseEvent(value: unknown): ScheduleStoreEvent {
	const input = record(value, "schedule event", ["sequence", "revision", "createdAt", "type", "taskId", "runId"]);
	if (input.type !== "task-updated" && input.type !== "task-deleted" && input.type !== "run-updated") {
		throw new Error("Invalid schedule event type");
	}
	return {
		sequence: integer(input.sequence, "schedule event sequence", 1),
		revision: integer(input.revision, "schedule event revision", 1),
		createdAt: timestamp(input.createdAt, "schedule event time"),
		type: input.type,
		taskId: id(input.taskId, "schedule task id"),
		...optional(input.runId, (item) => ({ runId: id(item, "schedule run id") })),
	};
}

function parseIndexText(contents: string): MutableScheduleIndex {
	let parsed: unknown;
	try {
		parsed = JSON.parse(contents);
	} catch (error) {
		throw storeCorrupt("Schedule index is not valid JSON", error);
	}
	try {
		const input = record(parsed, "schedule index", ["version", "revision", "tasks", "events"]);
		if (input.version !== 1 && input.version !== INDEX_VERSION) throw new Error("Unsupported schedule index version");
		if (!Array.isArray(input.tasks) || input.tasks.length > MAX_TASKS) throw new Error("Invalid schedule task list");
		if (!Array.isArray(input.events) || input.events.length > MAX_EVENTS)
			throw new Error("Invalid schedule event list");
		const legacy = input.version === 1;
		const tasks = input.tasks.map((task) => parseTask(task, legacy));
		if (new Set(tasks.map(({ id: taskId }) => taskId)).size !== tasks.length)
			throw new Error("Duplicate schedule task id");
		const events = input.events.map(parseEvent);
		for (let index = 1; index < events.length; index += 1) {
			if (events[index].sequence <= events[index - 1].sequence)
				throw new Error("Schedule event sequence is not monotonic");
		}
		return { version: 2, revision: integer(input.revision, "schedule revision"), tasks, events };
	} catch (error) {
		if (error instanceof ScheduleError) throw error;
		throw storeCorrupt(error instanceof Error ? error.message : "Schedule index is invalid", error);
	}
}

function serializeRun(run: ScheduleRun): string {
	const parsed = parseRun(run);
	const contents = `${JSON.stringify(parsed)}\n`;
	if (Buffer.byteLength(contents, "utf8") > MAX_RUN_BYTES)
		throw new ScheduleError("STORE_LIMIT", "Schedule run is too large");
	return contents;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: undefined;
}

export class ScheduleStore {
	readonly agentDir: string;
	readonly indexPath: string;
	private orphanCleanupDone = false;

	private constructor(agentDir: string) {
		this.agentDir = agentDir;
		this.indexPath = getScheduleIndexPath(agentDir);
	}

	static open(agentDir: string): ScheduleStore {
		return new ScheduleStore(agentDir);
	}

	readIndex(): ScheduleIndex {
		this.prepare();
		const index = this.readIndexFile();
		if (!this.orphanCleanupDone) {
			this.cleanupOrphanWorkspaces(index);
			this.orphanCleanupDone = true;
		}
		return structuredClone(index);
	}

	indexFingerprint(): string {
		this.prepare();
		try {
			const metadata = lstatSync(this.indexPath, { bigint: true });
			if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1n) {
				throw new Error("Schedule index is not a safe regular file");
			}
			return `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`;
		} catch (error) {
			throw storeCorrupt("Schedule index is unreadable", error);
		}
	}

	getTask(taskId: string): ScheduleTask {
		assertValidSessionId(taskId);
		const task = this.readIndex().tasks.find(({ id: candidate }) => candidate === taskId);
		if (!task) throw new ScheduleError("SCHEDULE_NOT_FOUND", "Scheduled task was not found");
		return task;
	}

	listRuns(
		taskId: string,
		input: { beforeRunId?: string; limit: number },
	): { runs: ScheduleRun[]; nextBeforeRunId: string | null } {
		this.getTask(taskId);
		if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 200)
			throw new TypeError("Invalid run page limit");
		if (input.beforeRunId) assertValidSessionId(input.beforeRunId);
		let names = this.runFileNames(taskId);
		if (input.beforeRunId) {
			const cursor = names.findIndex((name) => name.endsWith(`_${input.beforeRunId}.json`));
			if (cursor === -1) throw new ScheduleError("RUN_NOT_FOUND", "Scheduled run cursor was not found");
			names = names.slice(cursor + 1);
		}
		const selected = names.slice(0, input.limit + 1).map((name) => this.readRunFile(taskId, name));
		const hasMore = selected.length > input.limit;
		const runs = selected.slice(0, input.limit);
		return { runs, nextBeforeRunId: hasMore ? (runs.at(-1)?.id ?? null) : null };
	}

	getRun(taskId: string, runId: string): ScheduleRun {
		this.getTask(taskId);
		assertValidSessionId(runId);
		const name = this.runFileNames(taskId).find((candidate) => candidate.endsWith(`_${runId}.json`));
		if (!name) throw new ScheduleError("RUN_NOT_FOUND", "Scheduled run was not found");
		return this.readRunFile(taskId, name);
	}

	findRun(runId: string): ScheduleRun | undefined {
		assertValidSessionId(runId);
		for (const task of this.readIndex().tasks) {
			const name = this.runFileNames(task.id).find((candidate) => candidate.endsWith(`_${runId}.json`));
			if (name) return this.readRunFile(task.id, name);
		}
		return undefined;
	}

	listAllRuns(taskId: string): ScheduleRun[] {
		this.getTask(taskId);
		return this.runFileNames(taskId).map((name) => this.readRunFile(taskId, name));
	}

	async mutate<T>(fn: (draft: MutableScheduleIndex, files: ScheduleFileMutation) => T): Promise<T> {
		this.prepare();
		let release: (() => Promise<void>) | undefined;
		try {
			release = await lockfile.lock(this.indexPath, {
				realpath: false,
				stale: 10_000,
				update: 3_000,
				retries: { retries: 20, factor: 1.2, minTimeout: 10, maxTimeout: 250 },
			});
			const current = this.readIndexFile();
			const draft = structuredClone(current) as MutableScheduleIndex;
			const operations: Array<() => void> = [];
			const pendingEvents: PendingEvent[] = [];
			const originalEvents = JSON.stringify(draft.events);
			const files: ScheduleFileMutation = {
				createRun: (run) => {
					const contents = serializeRun(run);
					operations.push(() => {
						ensureScheduleRunDirectory(this.agentDir, run.taskId);
						createFileAtomicallySync(
							getScheduleRunPath(this.agentDir, run.taskId, run.sequence, run.id),
							contents,
							{
								mode: 0o600,
							},
						);
					});
				},
				replaceRun: (run) => {
					const contents = serializeRun(run);
					operations.push(() => {
						ensureScheduleRunDirectory(this.agentDir, run.taskId);
						const path = getScheduleRunPath(this.agentDir, run.taskId, run.sequence, run.id);
						if (readSingleLinkTextFileSync(path, { maxBytes: MAX_RUN_BYTES }) === undefined) {
							throw new ScheduleError("RUN_NOT_FOUND", "Scheduled run was not found");
						}
						replaceFileAtomicallySync(path, contents, { mode: 0o600 });
					});
				},
				removeRunDirectory: (taskId) => {
					assertValidSessionId(taskId);
					operations.push(() => {
						if (!removeScheduleRunDirectory(this.agentDir, taskId)) {
							throw storeCorrupt("Schedule run directory ownership check failed");
						}
					});
				},
				appendEvent: (event) => {
					assertValidSessionId(event.taskId);
					if (event.runId) assertValidSessionId(event.runId);
					pendingEvents.push(structuredClone(event));
				},
			};
			const result = fn(draft, files);
			if (JSON.stringify(draft.events) !== originalEvents)
				throw new TypeError("Schedule events must be appended through files.appendEvent()");
			if (draft.tasks.length > MAX_TASKS) throw new ScheduleError("STORE_LIMIT", "Too many scheduled tasks");
			const tasks = draft.tasks.map((task) => parseTask(task));
			if (new Set(tasks.map(({ id: taskId }) => taskId)).size !== tasks.length) {
				throw storeCorrupt("Duplicate schedule task id");
			}
			const changed =
				operations.length > 0 ||
				pendingEvents.length > 0 ||
				JSON.stringify(tasks) !== JSON.stringify(current.tasks);
			if (!changed) return result;
			const revision = current.revision + 1;
			let sequence = current.events.at(-1)?.sequence ?? 0;
			const createdAt = new Date().toISOString();
			const events = [
				...current.events,
				...pendingEvents.map(
					(event): ScheduleStoreEvent => ({
						sequence: ++sequence,
						revision,
						createdAt,
						...event,
					}),
				),
			].slice(-MAX_EVENTS);
			const next: MutableScheduleIndex = { version: 2, revision, tasks, events };
			const contents = `${JSON.stringify(next)}\n`;
			if (Buffer.byteLength(contents, "utf8") > MAX_INDEX_BYTES) {
				throw new ScheduleError("STORE_LIMIT", "Schedule index is too large");
			}
			for (const operation of operations) operation();
			replaceFileAtomicallySync(this.indexPath, contents, { mode: 0o600 });
			return result;
		} catch (error) {
			if (error instanceof ScheduleError) throw error;
			throw storeCorrupt(error instanceof Error ? error.message : "Schedule store mutation failed", error);
		} finally {
			await release?.().catch(() => undefined);
		}
	}

	async reconcile(): Promise<void> {
		this.prepare();
		let runDirectoryNames: Set<string>;
		try {
			runDirectoryNames = new Set(
				readdirSync(getScheduleRunsRoot(this.agentDir), { withFileTypes: true }).map(({ name }) => name),
			);
		} catch (error) {
			throw storeCorrupt("Schedule run root is unreadable", error);
		}
		await this.mutate((draft) => {
			draft.tasks = draft.tasks.map((task) => {
				const runs = runDirectoryNames.has(task.id)
					? this.runFileNames(task.id).map((name) => this.readRunFile(task.id, name))
					: [];
				const nextRunSequence = Math.max(1, ...runs.map(({ sequence }) => sequence + 1));
				const active = runs.find(({ status }) => status === "queued" || status === "running");
				const terminal = runs.find(({ status }) => status !== "queued" && status !== "running");
				const scheduled = runs.find(({ trigger }) => trigger === "scheduled");
				const unreadCount = runs.filter(({ unread }) => unread).length;
				const nextRunAt =
					scheduled && task.nextRunAt !== null && Date.parse(task.nextRunAt) <= Date.parse(scheduled.scheduledFor)
						? scheduled.snapshot.schedule.kind === "once"
							? null
							: advancePastNow({
									spec: scheduled.snapshot.schedule,
									timezone: scheduled.snapshot.timezone,
									dueAt: scheduled.scheduledFor,
									now: scheduled.createdAt,
								}).nextRunAt
						: task.nextRunAt;
				return {
					...task,
					nextRunSequence,
					nextRunAt,
					...(active ? { activeRunId: active.id } : { activeRunId: undefined }),
					...(terminal ? { lastRun: summarizeRun(terminal) } : { lastRun: undefined }),
					unreadCount,
				};
			});
		});
	}

	private prepare(): void {
		try {
			ensureScheduleDirectories(this.agentDir);
			if (!existsSync(this.indexPath)) {
				try {
					createFileAtomicallySync(
						this.indexPath,
						`${JSON.stringify({ version: 2, revision: 0, tasks: [], events: [] })}\n`,
						{ mode: 0o600 },
					);
				} catch (error) {
					if (errorCode(error) !== "EEXIST") throw error;
				}
			}
		} catch (error) {
			throw storeCorrupt("Schedule storage paths are unsafe or unavailable", error);
		}
	}

	private readIndexFile(): MutableScheduleIndex {
		try {
			const contents = readSingleLinkTextFileSync(this.indexPath, { maxBytes: MAX_INDEX_BYTES });
			if (contents === undefined) throw new Error("Schedule index is missing");
			return parseIndexText(contents);
		} catch (error) {
			if (error instanceof ScheduleError) throw error;
			throw storeCorrupt("Schedule index is unreadable", error);
		}
	}

	private runFileNames(taskId: string): string[] {
		assertValidSessionId(taskId);
		this.prepare();
		const directory = getScheduleRunDir(this.agentDir, taskId);
		if (!existsSync(directory)) return [];
		try {
			const metadata = lstatSync(directory);
			if (!metadata.isDirectory() || metadata.isSymbolicLink())
				throw new Error("Schedule run path is not a real directory");
			return readdirSync(directory, { withFileTypes: true })
				.filter(
					(entry) =>
						entry.isFile() &&
						/^\d{16}_(?:[A-Za-z0-9]|[A-Za-z0-9][A-Za-z0-9._-]*[A-Za-z0-9])\.json$/.test(entry.name),
				)
				.map(({ name }) => name)
				.sort()
				.reverse();
		} catch (error) {
			throw storeCorrupt("Schedule run directory is unreadable", error);
		}
	}

	private readRunFile(taskId: string, name: string): ScheduleRun {
		try {
			const contents = readSingleLinkTextFileSync(join(getScheduleRunDir(this.agentDir, taskId), name), {
				maxBytes: MAX_RUN_BYTES,
			});
			if (contents === undefined) throw new Error("Schedule run file is missing");
			const raw = JSON.parse(contents) as unknown;
			const taskIdValue = isRecord(raw) ? raw.taskId : undefined;
			const legacyTask =
				typeof taskIdValue === "string"
					? this.readIndexFile().tasks.find(({ id: candidate }) => candidate === taskIdValue)
					: undefined;
			const run = parseRun(raw, legacyTask);
			const match = /^(\d{16})_(.+)\.json$/.exec(name);
			if (!match || run.taskId !== taskId || run.sequence !== Number(match[1]) || run.id !== match[2]) {
				throw new Error("Schedule run identity does not match its file");
			}
			return run;
		} catch (error) {
			if (error instanceof ScheduleError) throw error;
			throw storeCorrupt("Schedule run file is invalid", error);
		}
	}

	private cleanupOrphanWorkspaces(index: ScheduleIndex): void {
		const taskIds = new Set(index.tasks.map(({ id: taskId }) => taskId));
		const root = getScheduleWorkspacesRoot(this.agentDir);
		let entries: Dirent[];
		try {
			entries = readdirSync(root, { withFileTypes: true });
		} catch (error) {
			throw storeCorrupt("Schedule workspace root is unreadable", error);
		}
		for (const entry of entries) {
			if (!entry.isDirectory() || taskIds.has(entry.name)) continue;
			try {
				assertValidSessionId(entry.name);
				const path = join(root, entry.name);
				if (Date.now() - statSync(path).mtimeMs < ORPHAN_GRACE_MS) continue;
				removeOwnedScheduleWorkspace(this.agentDir, entry.name, path);
			} catch {
				// An unproven child is user data, not an orphan we own.
			}
		}
	}
}
