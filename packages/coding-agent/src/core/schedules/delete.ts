import { randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmdirSync,
	unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { resolvePath } from "../../utils/paths.ts";
import { trashPath } from "../../utils/trash.ts";
import {
	ensureDirectoryDurablySync,
	ensureRealDirectoryDurablySync,
	readSingleLinkTextFileSync,
	replaceFileAtomicallySync,
	syncDirectorySync,
} from "../durable-file.ts";
import { errorCode } from "../error-code.ts";
import { getOwnedSessionAttachmentDir, getOwnedSessionWorkDirs } from "../session-attachments.ts";
import { assertValidSessionId } from "../session-id.ts";
import { getOwnedSessionJournalArtifacts } from "../session-journal.ts";
import { SessionLease } from "../session-lease.ts";
import {
	getDefaultSessionDir,
	getSessionAgentDir,
	getSessionDisplayMetadataPath,
	getSessionImageDir,
	getSessionToolOutputDir,
	SessionManager,
	sessionStoragePathVariants,
} from "../session-manager.ts";
import { getOwnedManagedWorkspace } from "../session-workspace.ts";
import { getOwnedScheduleWorkspace } from "./paths.ts";
import { ScheduleError, type ScheduleRun, type ScheduleTask } from "./types.ts";

type Phase = "staging" | "staged" | "trashing" | "trashed";

interface ScheduleTrashManifest {
	readonly version: 1;
	readonly taskId: string;
	readonly phase: Phase;
	readonly createdAt: string;
	readonly deleteSessions: boolean;
	readonly deletedSessionCount: number;
	readonly retainedSessionCount: number;
	readonly targets: readonly { readonly original: string; readonly staged: string }[];
}

export interface ScheduleTrashResult {
	readonly deletedSessionCount: number;
	readonly retainedSessionCount: number;
}

export interface ScheduleTrashHooks {
	readonly operationId?: () => string;
	readonly rename?: (source: string, destination: string) => void;
	readonly trash?: (payload: string) => unknown | Promise<unknown>;
}

const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_TARGETS = 100_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

function inside(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function assertSafeTree(agentDir: string, path: string): string {
	const unresolved = resolvePath(path);
	if (lstatSync(unresolved).isSymbolicLink())
		throw new Error(`Schedule Trash target is a symbolic link: ${unresolved}`);
	const resolved = realpathSync(unresolved);
	if (!inside(agentDir, resolved) || resolved === agentDir)
		throw new Error(`Schedule Trash target is outside agent data: ${resolved}`);
	const pending = [resolved];
	while (pending.length > 0) {
		const current = pending.pop()!;
		const metadata = lstatSync(current);
		if (metadata.isSymbolicLink()) throw new Error(`Schedule Trash target contains a symbolic link: ${current}`);
		if (metadata.isFile()) {
			if (metadata.nlink !== 1) throw new Error(`Schedule Trash target contains a hard-linked file: ${current}`);
			continue;
		}
		if (!metadata.isDirectory())
			throw new Error(`Schedule Trash target is not a regular file or directory: ${current}`);
		if (realpathSync(current) !== current) throw new Error(`Schedule Trash target is aliased: ${current}`);
		for (const name of readdirSync(current)) pending.push(join(current, name));
	}
	return resolved;
}

function canonicalAgentDir(agentDir: string): string {
	const resolved = resolvePath(agentDir);
	ensureRealDirectoryDurablySync(resolved, 0o700);
	return realpathSync(resolved);
}

function root(agentDir: string): string {
	return join(agentDir, "schedule-trash");
}

function writeManifest(operationDir: string, manifest: ScheduleTrashManifest): void {
	const text = `${JSON.stringify(manifest)}\n`;
	if (Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) throw new Error("Schedule Trash manifest is too large");
	replaceFileAtomicallySync(join(operationDir, "manifest.json"), text, { mode: 0o600 });
}

function assertOperationDir(agentDir: string, operationDir: string): void {
	const expectedRoot = root(agentDir);
	if (!inside(expectedRoot, operationDir) || operationDir === expectedRoot) {
		throw new Error(`Invalid Schedule Trash operation path: ${operationDir}`);
	}
	const metadata = lstatSync(operationDir);
	if (!metadata.isDirectory() || metadata.isSymbolicLink() || realpathSync(operationDir) !== operationDir) {
		throw new Error(`Unsafe Schedule Trash operation: ${operationDir}`);
	}
}

function readManifest(agentDir: string, operationDir: string): ScheduleTrashManifest {
	assertOperationDir(agentDir, operationDir);
	const text = readSingleLinkTextFileSync(join(operationDir, "manifest.json"), { maxBytes: MAX_MANIFEST_BYTES });
	if (text === undefined) throw new Error(`Missing Schedule Trash manifest: ${operationDir}`);
	const value = JSON.parse(text) as ScheduleTrashManifest;
	try {
		assertValidSessionId(value.taskId);
	} catch {
		throw new Error(`Invalid Schedule Trash manifest: ${operationDir}`);
	}
	if (
		value.version !== 1 ||
		!["staging", "staged", "trashing", "trashed"].includes(value.phase) ||
		typeof value.createdAt !== "string" ||
		Number.isNaN(Date.parse(value.createdAt)) ||
		typeof value.deleteSessions !== "boolean" ||
		!Number.isSafeInteger(value.deletedSessionCount) ||
		value.deletedSessionCount < 0 ||
		!Number.isSafeInteger(value.retainedSessionCount) ||
		value.retainedSessionCount < 0 ||
		!Array.isArray(value.targets) ||
		value.targets.length > MAX_TARGETS
	) {
		throw new Error(`Invalid Schedule Trash manifest: ${operationDir}`);
	}
	const payload = join(operationDir, "payload");
	const originals = new Set<string>();
	const staged = new Set<string>();
	for (const target of value.targets) {
		if (
			typeof target !== "object" ||
			target === null ||
			Array.isArray(target) ||
			Object.keys(target).some((key) => key !== "original" && key !== "staged") ||
			typeof target.original !== "string" ||
			typeof target.staged !== "string" ||
			resolvePath(target.original) !== target.original ||
			resolvePath(target.staged) !== target.staged ||
			!inside(agentDir, target.original) ||
			target.original === agentDir ||
			!inside(payload, target.staged) ||
			target.staged === payload ||
			originals.has(target.original) ||
			staged.has(target.staged)
		) {
			throw new Error(`Invalid Schedule Trash manifest: ${operationDir}`);
		}
		originals.add(target.original);
		staged.add(target.staged);
	}
	return value;
}

function findOperation(
	agentDir: string,
	taskId: string,
): { operationDir: string; manifest: ScheduleTrashManifest } | undefined {
	const operationRoot = root(agentDir);
	if (!existsSync(operationRoot)) return undefined;
	let found: { operationDir: string; manifest: ScheduleTrashManifest } | undefined;
	for (const name of readdirSync(operationRoot).sort()) {
		if (!UUID.test(name)) throw new Error(`Invalid Schedule Trash operation: ${name}`);
		const operationDir = join(operationRoot, name);
		const manifest = readManifest(agentDir, operationDir);
		if (manifest.taskId !== taskId) continue;
		if (found) throw new Error(`Multiple Schedule Trash operations exist for task ${taskId}`);
		found = { operationDir, manifest };
	}
	return found;
}

function locateSessionFile(agentDir: string, run: ScheduleRun): { path: string; sessionsRoot: string } | undefined {
	const sessionsRoot = getDefaultSessionDir(run.snapshot.target.cwd, agentDir);
	const candidates = new Set<string>();
	const addCandidate = (path: string) => {
		if (pathExists(path)) candidates.add(realpathSync(path));
	};
	if (run.sessionFile) {
		for (const path of sessionStoragePathVariants(run.sessionFile, sessionsRoot)) addCandidate(path);
	}
	if (run.sessionId) {
		const suffix = `_${run.sessionId}.jsonl`;
		for (const directory of [sessionsRoot, join(sessionsRoot, ".archive")]) {
			if (!pathExists(directory)) continue;
			for (const name of readdirSync(directory)) if (name.endsWith(suffix)) addCandidate(join(directory, name));
		}
	}
	if (candidates.size > 1)
		throw new ScheduleError("TASK_DELETING", `Scheduled session identity is ambiguous for run ${run.id}`);
	const path = [...candidates][0];
	return path ? { path, sessionsRoot } : undefined;
}

function existing(paths: readonly (string | undefined)[]): string[] {
	return paths.filter((path): path is string => path !== undefined && pathExists(path));
}

function collectTargets(
	agentDir: string,
	task: ScheduleTask,
	runs: readonly ScheduleRun[],
	deleteSessions: boolean,
): { targets: string[]; leases: SessionLease[]; deletedSessionCount: number; retainedSessionCount: number } {
	const targets: string[] = [];
	const leases: SessionLease[] = [];
	let sessionCount = 0;
	try {
		if (task.target.workspace === "task") {
			const workspace = getOwnedScheduleWorkspace(agentDir, task.id, task.target.cwd);
			if (!workspace) throw new ScheduleError("TASK_DELETING", "Task workspace ownership check failed");
			if (pathExists(workspace)) targets.push(workspace);
		}
		if (deleteSessions) {
			for (const run of runs) {
				const located = locateSessionFile(agentDir, run);
				if (!located) continue;
				const lease = SessionLease.acquireTransient(located.path);
				leases.push(lease);
				const session = SessionManager.openReadOnly(located.path);
				const header = session.getHeader();
				if (
					!header ||
					header.id !== run.sessionId ||
					header.scheduled?.taskId !== task.id ||
					header.scheduled.runId !== run.id
				) {
					throw new ScheduleError("TASK_DELETING", `Scheduled session ownership does not match run ${run.id}`);
				}
				sessionCount += 1;
				const variants = sessionStoragePathVariants(located.path, located.sessionsRoot);
				targets.push(
					located.path,
					...existing(
						variants.flatMap((path) => [
							getSessionDisplayMetadataPath(path),
							getSessionImageDir(path),
							getSessionToolOutputDir(path),
							...getOwnedSessionJournalArtifacts(path),
						]),
					),
					...existing([
						getOwnedSessionAttachmentDir(agentDir, header.id),
						getSessionAgentDir(agentDir, header.id),
						getOwnedManagedWorkspace({
							id: header.id,
							cwd: header.cwd,
							cwdOrigin: header.cwdOrigin ?? "user-selected",
							agentDir,
						}),
						...getOwnedSessionWorkDirs(agentDir, header.id),
					]),
				);
			}
		} else {
			sessionCount = runs.filter((run) => locateSessionFile(agentDir, run) !== undefined).length;
		}
		const safe = [...new Set(targets.map((path) => assertSafeTree(agentDir, path)))].sort();
		const pruned = safe.filter(
			(path, index) => !safe.some((parent, parentIndex) => parentIndex !== index && inside(parent, path)),
		);
		return {
			targets: pruned,
			leases,
			deletedSessionCount: deleteSessions ? sessionCount : 0,
			retainedSessionCount: deleteSessions ? 0 : sessionCount,
		};
	} catch (error) {
		for (const lease of leases.reverse()) lease.close();
		throw error;
	}
}

function durableRename(
	source: string,
	destination: string,
	rename: (source: string, destination: string) => void = renameSync,
): void {
	ensureDirectoryDurablySync(dirname(destination), 0o700);
	rename(source, destination);
	syncDirectorySync(dirname(source));
	if (dirname(source) !== dirname(destination)) syncDirectorySync(dirname(destination));
}

function removeOperation(operationDir: string): void {
	const payload = join(operationDir, "payload");
	if (pathExists(payload)) rmdirSync(payload);
	unlinkSync(join(operationDir, "manifest.json"));
	rmdirSync(operationDir);
	syncDirectorySync(dirname(operationDir));
}

function removeFailedPreparation(operationDir: string, payload: string, cause: unknown): never {
	try {
		const manifest = join(operationDir, "manifest.json");
		for (const name of readdirSync(operationDir)) {
			if (name !== "payload" && name !== "manifest.json") {
				throw new Error(`Unexpected Schedule Trash preparation entry: ${join(operationDir, name)}`);
			}
		}
		if (pathExists(payload)) {
			const metadata = lstatSync(payload);
			if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
				throw new Error(`Unsafe Schedule Trash preparation payload: ${payload}`);
			}
			rmdirSync(payload);
		}
		if (pathExists(manifest)) {
			const metadata = lstatSync(manifest);
			if (!metadata.isFile() || metadata.nlink !== 1) {
				throw new Error(`Unsafe Schedule Trash preparation manifest: ${manifest}`);
			}
			unlinkSync(manifest);
		}
		rmdirSync(operationDir);
		syncDirectorySync(dirname(operationDir));
	} catch (cleanupError) {
		throw new AggregateError([cause, cleanupError], `Schedule Trash preparation cleanup failed: ${operationDir}`);
	}
	throw cause;
}

function restore(
	agentDir: string,
	operationDir: string,
	manifest: ScheduleTrashManifest,
	rename: (source: string, destination: string) => void = renameSync,
): void {
	for (const target of [...manifest.targets].reverse()) {
		const original = pathExists(target.original);
		const staged = pathExists(target.staged);
		if (original) assertSafeTree(agentDir, target.original);
		if (staged) assertSafeTree(agentDir, target.staged);
		if (original && !staged) continue;
		if (!original && staged) {
			durableRename(target.staged, target.original, rename);
			continue;
		}
		throw new Error(`Ambiguous Schedule Trash recovery state: ${target.original}`);
	}
	removeOperation(operationDir);
}

async function trashPayload(payload: string): Promise<void> {
	await trashPath(payload);
}

export async function trashScheduledTaskData(
	input: {
		agentDir: string;
		task: ScheduleTask;
		runs: readonly ScheduleRun[];
		deleteSessions: boolean;
	},
	hooks: ScheduleTrashHooks = {},
): Promise<ScheduleTrashResult> {
	const agentDir = canonicalAgentDir(input.agentDir);
	const existingOperation = findOperation(agentDir, input.task.id);
	if (existingOperation) {
		if (existingOperation.manifest.phase !== "trashed") {
			throw new ScheduleError("TASK_DELETING", "Scheduled task deletion recovery is incomplete");
		}
		return {
			deletedSessionCount: existingOperation.manifest.deletedSessionCount,
			retainedSessionCount: existingOperation.manifest.retainedSessionCount,
		};
	}

	const collected = collectTargets(agentDir, input.task, input.runs, input.deleteSessions);
	try {
		if (collected.targets.length === 0) {
			return {
				deletedSessionCount: collected.deletedSessionCount,
				retainedSessionCount: collected.retainedSessionCount,
			};
		}
		const operationRoot = root(agentDir);
		ensureRealDirectoryDurablySync(operationRoot, 0o700);
		const operationId = (hooks.operationId ?? randomUUID)();
		if (!UUID.test(operationId)) throw new Error("Schedule Trash operation id must be a UUID");
		const operationDir = join(operationRoot, operationId);
		const payload = join(operationDir, "payload");
		const targets = collected.targets.map((original, index) => ({
			original,
			staged: join(payload, `${String(index).padStart(6, "0")}-${basename(original)}`),
		}));
		let manifest: ScheduleTrashManifest = {
			version: 1,
			taskId: input.task.id,
			phase: "staging",
			createdAt: new Date().toISOString(),
			deleteSessions: input.deleteSessions,
			deletedSessionCount: collected.deletedSessionCount,
			retainedSessionCount: collected.retainedSessionCount,
			targets,
		};
		mkdirSync(operationDir, { mode: 0o700 });
		try {
			// Only this call's empty operation entries are owned here; no target has moved yet.
			mkdirSync(payload, { mode: 0o700 });
			writeManifest(operationDir, manifest);
		} catch (error) {
			removeFailedPreparation(operationDir, payload, error);
		}
		try {
			for (const target of targets) durableRename(target.original, target.staged, hooks.rename);
			manifest = { ...manifest, phase: "staged" };
			writeManifest(operationDir, manifest);
			manifest = { ...manifest, phase: "trashing" };
			writeManifest(operationDir, manifest);
			await (hooks.trash ?? trashPayload)(payload);
			if (pathExists(payload)) throw new Error("Trash did not remove the Schedule Trash payload");
			writeManifest(operationDir, { ...manifest, phase: "trashed" });
		} catch (error) {
			if (pathExists(payload)) restore(agentDir, operationDir, manifest, hooks.rename);
			throw error;
		}
		return {
			deletedSessionCount: collected.deletedSessionCount,
			retainedSessionCount: collected.retainedSessionCount,
		};
	} finally {
		for (const lease of collected.leases.reverse()) lease.close();
	}
}

export function finalizeScheduledTaskTrash(agentDirInput: string, taskId: string): void {
	const agentDir = canonicalAgentDir(agentDirInput);
	const operation = findOperation(agentDir, taskId);
	if (!operation) return;
	if (operation.manifest.phase !== "trashed") throw new Error("Schedule Trash transaction is not complete");
	removeOperation(operation.operationDir);
}

export function getScheduledTaskTrashPhase(agentDirInput: string, taskId: string): Phase | undefined {
	const agentDir = canonicalAgentDir(agentDirInput);
	return findOperation(agentDir, taskId)?.manifest.phase;
}

export function recoverInterruptedScheduleTrash(agentDirInput: string): void {
	const agentDir = canonicalAgentDir(agentDirInput);
	const operationRoot = root(agentDir);
	if (!existsSync(operationRoot)) return;
	for (const name of readdirSync(operationRoot).sort()) {
		if (!UUID.test(name)) throw new Error(`Invalid Schedule Trash operation: ${name}`);
		const operationDir = join(operationRoot, name);
		const manifest = readManifest(agentDir, operationDir);
		const payload = join(operationDir, "payload");
		if (manifest.phase === "trashed") {
			if (pathExists(payload)) throw new Error(`Completed Schedule Trash payload still exists: ${operationDir}`);
			continue;
		}
		if (manifest.phase === "trashing" && !pathExists(payload)) {
			writeManifest(operationDir, { ...manifest, phase: "trashed" });
			continue;
		}
		restore(agentDir, operationDir, manifest);
	}
}

export function finalizeOrphanedScheduledTrash(agentDirInput: string, taskIds: ReadonlySet<string>): void {
	const agentDir = canonicalAgentDir(agentDirInput);
	const operationRoot = root(agentDir);
	if (!existsSync(operationRoot)) return;
	for (const name of readdirSync(operationRoot).sort()) {
		const operationDir = join(operationRoot, name);
		const manifest = readManifest(agentDir, operationDir);
		if (manifest.phase === "trashed" && !taskIds.has(manifest.taskId)) removeOperation(operationDir);
	}
}
