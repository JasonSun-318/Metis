import { randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	constants as fsConstants,
	fstatSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	renameSync,
	rmdirSync,
	type Stats,
	unlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { TextDecoder } from "node:util";
import { spawnProcess, waitForChildProcess } from "../utils/child-process.ts";
import { canonicalizePathForCreation, encodePathForStorage, resolvePath } from "../utils/paths.ts";
import { type AgentMode, DEFAULT_AGENT_MODE, isAgentMode } from "./agent-mode.ts";
import { getAutoMemoryPaths } from "./auto-memory.ts";
import {
	ensureDirectoryDurablySync,
	ensureRealDirectoryDurablySync,
	readSingleLinkTextFileSync,
	replaceFileAtomicallySync,
	syncDirectorySync,
} from "./durable-file.ts";
import { getOwnedSessionWorkDirs, getSessionAttachmentDir } from "./session-attachments.ts";
import { assertValidSessionId } from "./session-id.ts";
import { getOwnedSessionJournalArtifacts } from "./session-journal.ts";
import { acquireModeProjectMutationLease, SessionLease, SessionLeaseError } from "./session-lease.ts";

export interface ModeProjectSessionTarget {
	readonly sessionId: string;
	readonly path: string;
	readonly relativePath: string;
	readonly archived: boolean;
	readonly updatedAt?: string;
}

export interface TrashModeProjectDataInput {
	readonly agentDir: string;
	readonly sessionsRoot: string;
	readonly mode: AgentMode;
	readonly cwd: string;
	readonly sessions: readonly ModeProjectSessionTarget[];
}

export type TrashModeProjectDataResult =
	| { readonly ok: true; readonly method: "trash"; readonly deletedSessionCount: number }
	| {
			readonly ok: false;
			readonly method: "trash";
			readonly code: "SESSION_IN_USE" | "SESSION_CORRUPT" | "PROJECT_CHANGED" | "OPERATION_FAILED";
			readonly error: string;
	  };

interface SessionHeaderView {
	readonly id: string;
	readonly cwd: string;
	readonly mode?: AgentMode;
	readonly scheduled?: unknown;
}

export interface ModeProjectDeleteHooks {
	readonly readSessionHeader: (path: string) => SessionHeaderView;
	readonly getSessionImageDir: (path: string) => string;
	readonly getSessionToolOutputDir: (path: string) => string;
	readonly getSessionSubagentDir: (agentDir: string, sessionId: string) => string;
	readonly trash?: (operationDir: string) => unknown | Promise<unknown>;
	readonly rename?: (source: string, destination: string) => void;
	readonly operationId?: () => string;
}

interface ProjectTrashManifest {
	readonly version: 1;
	readonly mode: AgentMode;
	readonly cwd: string;
	readonly createdAt: string;
	readonly targets: readonly {
		readonly original: string;
		readonly stagedRelativePath: string;
	}[];
}

interface OwnedTarget {
	readonly path: string;
	readonly directory: boolean;
}

type ProjectDeleteCode = Exclude<TrashModeProjectDataResult, { ok: true }>["code"];

class ProjectDeleteError extends Error {
	readonly code: ProjectDeleteCode;

	constructor(code: ProjectDeleteCode, message: string) {
		super(message);
		this.name = "ProjectDeleteError";
		this.code = code;
	}
}

const MAX_HEADER_BYTES = 64 * 1024;
const MAX_MANIFEST_BYTES = 64 * 1024 * 1024;
const MAX_TARGETS = 100_000;
const MAX_MANIFEST_TARGETS = MAX_TARGETS * 10 + 1;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: undefined;
}

function inside(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function strictDirectory(path: string, label: string): string {
	const metadata = lstatSync(path);
	if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
	return realpathSync(path);
}

function safeRelativePath(path: string): boolean {
	return path.length > 0 && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`);
}

type Rename = (source: string, destination: string) => void;

function sameIdentity(left: Stats, right: Stats): boolean {
	return (
		left.isFile() &&
		right.isFile() &&
		left.nlink === 1 &&
		right.nlink === 1 &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs
	);
}

function readFastHeader(path: string): SessionHeaderView {
	const before = lstatSync(path);
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
		throw new Error("Session journal is not a single-link regular file");
	}
	const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
	const nonBlocking = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
	const fd = openSync(path, fsConstants.O_RDONLY | noFollow | nonBlocking);
	try {
		const opened = fstatSync(fd);
		if (!sameIdentity(before, opened)) throw new Error("Session journal changed while opening");
		const bytes = Buffer.allocUnsafe(MAX_HEADER_BYTES + 1);
		const count = readSync(fd, bytes, 0, bytes.byteLength, 0);
		const newline = bytes.subarray(0, count).indexOf(0x0a);
		if (newline < 0 && count > MAX_HEADER_BYTES) throw new Error("Session header exceeds its size limit");
		const length = newline < 0 ? count : newline;
		if (length === 0) throw new Error("Session header is empty");
		const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))) as Record<
			string,
			unknown
		>;
		if (value.type !== "session" || typeof value.id !== "string" || typeof value.cwd !== "string") {
			throw new Error("Session header is invalid");
		}
		assertValidSessionId(value.id);
		if (value.mode !== undefined && !isAgentMode(value.mode)) throw new Error("Session header mode is invalid");
		if (!isAbsolute(value.cwd) || Buffer.byteLength(value.cwd, "utf8") > 32 * 1024) {
			throw new Error("Session header cwd is invalid");
		}
		const current = lstatSync(path);
		if (!sameIdentity(opened, current)) throw new Error("Session journal changed while reading its header");
		return {
			id: value.id,
			cwd: value.cwd,
			mode: value.mode as AgentMode | undefined,
			...(value.scheduled === undefined ? {} : { scheduled: value.scheduled }),
		};
	} finally {
		closeSync(fd);
	}
}

function verifyRoots(input: TrashModeProjectDataInput): {
	agentDir: string;
	sessionsRoot: string;
	cwd: string;
	storageCwd: string;
	projectDirectory: string;
	archiveProjectDirectory: string;
} {
	if (!isAgentMode(input.mode)) throw new ProjectDeleteError("SESSION_CORRUPT", "Invalid project mode");
	if (!isAbsolute(input.cwd) || !isAbsolute(input.agentDir) || !isAbsolute(input.sessionsRoot)) {
		throw new ProjectDeleteError("SESSION_CORRUPT", "Project deletion paths must be absolute");
	}
	const inputCwd = resolvePath(input.cwd);
	const cwd = canonicalizePathForCreation(inputCwd);
	const agentDir = resolvePath(input.agentDir);
	ensureRealDirectoryDurablySync(agentDir, 0o700);
	const canonicalAgentDir = strictDirectory(agentDir, "Agent directory");
	const sessionsRoot = canonicalizePathForCreation(input.sessionsRoot);
	if (!inside(canonicalAgentDir, sessionsRoot) || sessionsRoot === canonicalAgentDir) {
		throw new ProjectDeleteError("SESSION_CORRUPT", "Sessions root escapes the agent directory");
	}
	ensureRealDirectoryDurablySync(sessionsRoot, 0o700);
	const canonicalSessionsRoot = strictDirectory(sessionsRoot, "Sessions root");
	let storageKey: string | undefined;
	for (const target of input.sessions) {
		if (typeof target.relativePath !== "string" || !safeRelativePath(target.relativePath)) {
			throw new ProjectDeleteError("SESSION_CORRUPT", "Invalid project session relative path");
		}
		const candidate = dirname(target.relativePath);
		if (candidate === "." || dirname(candidate) !== "." || (storageKey && storageKey !== candidate)) {
			throw new ProjectDeleteError("SESSION_CORRUPT", "Project sessions do not share one storage directory");
		}
		storageKey = candidate;
	}
	// Empty projects have no catalog ref from which to retain a historical path spelling.
	storageKey ??= encodePathForStorage(inputCwd);
	return {
		agentDir: canonicalAgentDir,
		sessionsRoot: canonicalSessionsRoot,
		cwd,
		storageCwd: inputCwd,
		projectDirectory: join(canonicalSessionsRoot, storageKey),
		archiveProjectDirectory: join(canonicalSessionsRoot, ".archive", storageKey),
	};
}

function validateInputTargets(
	input: TrashModeProjectDataInput,
	roots: ReturnType<typeof verifyRoots>,
): Map<string, ModeProjectSessionTarget> {
	if (input.sessions.length > MAX_TARGETS)
		throw new ProjectDeleteError("SESSION_CORRUPT", "Too many project sessions");
	const byPath = new Map<string, ModeProjectSessionTarget>();
	const ids = new Set<string>();
	for (const target of input.sessions) {
		try {
			assertValidSessionId(target.sessionId);
		} catch (error) {
			throw new ProjectDeleteError("SESSION_CORRUPT", errorMessage(error));
		}
		if (typeof target.archived !== "boolean") {
			throw new ProjectDeleteError("SESSION_CORRUPT", "Invalid project session archive marker");
		}
		if (target.updatedAt !== undefined && !Number.isFinite(Date.parse(target.updatedAt))) {
			throw new ProjectDeleteError("SESSION_CORRUPT", "Invalid project session update time");
		}
		if (!safeRelativePath(target.relativePath) || !target.relativePath.endsWith(".jsonl")) {
			throw new ProjectDeleteError("SESSION_CORRUPT", "Invalid project session relative path");
		}
		const root = target.archived ? join(roots.sessionsRoot, ".archive") : roots.sessionsRoot;
		const expected = resolve(root, target.relativePath);
		if (!inside(root, expected) || canonicalizePathForCreation(target.path) !== expected) {
			throw new ProjectDeleteError("SESSION_CORRUPT", "Project session path does not match its catalog path");
		}
		if (ids.has(target.sessionId) || byPath.has(expected)) {
			throw new ProjectDeleteError("SESSION_CORRUPT", "Duplicate project session identity");
		}
		ids.add(target.sessionId);
		byPath.set(expected, target);
	}
	return byPath;
}

function scanProjectStorage(
	directory: string,
	archived: boolean,
	mode: AgentMode,
	cwd: string,
	ids: Set<string>,
): Map<string, { id: string; archived: boolean; updatedAt: string }> {
	const result = new Map<string, { id: string; archived: boolean; updatedAt: string }>();
	if (!existsSync(directory)) return result;
	const canonicalDirectory = strictDirectory(directory, "Project session directory");
	if (canonicalDirectory !== resolve(directory)) throw new Error("Project session directory is aliased");
	for (const name of readdirSync(directory).sort()) {
		if (!name.endsWith(".jsonl")) continue;
		const path = join(directory, name);
		let header: SessionHeaderView;
		try {
			header = readFastHeader(path);
		} catch (error) {
			throw new ProjectDeleteError("SESSION_CORRUPT", `Cannot inspect ${path}: ${errorMessage(error)}`);
		}
		if (canonicalizePathForCreation(header.cwd) !== cwd) {
			throw new ProjectDeleteError("SESSION_CORRUPT", `Session cwd disagrees with its storage directory: ${path}`);
		}
		if (header.scheduled !== undefined || (header.mode ?? DEFAULT_AGENT_MODE) !== mode) continue;
		if (ids.has(header.id)) {
			throw new ProjectDeleteError("SESSION_CORRUPT", `Duplicate session id in project storage: ${header.id}`);
		}
		ids.add(header.id);
		result.set(path, { id: header.id, archived, updatedAt: new Date(lstatSync(path).mtimeMs).toISOString() });
	}
	return result;
}

function verifySnapshot(
	input: TrashModeProjectDataInput,
	roots: ReturnType<typeof verifyRoots>,
	expected: ReadonlyMap<string, ModeProjectSessionTarget>,
): void {
	const ids = new Set<string>();
	const scanned = new Map([
		...scanProjectStorage(roots.projectDirectory, false, input.mode, roots.cwd, ids),
		...scanProjectStorage(roots.archiveProjectDirectory, true, input.mode, roots.cwd, ids),
	]);
	if (scanned.size !== expected.size) throw new ProjectDeleteError("PROJECT_CHANGED", "Project sessions changed");
	for (const [path, entry] of scanned) {
		const target = expected.get(path);
		if (
			!target ||
			target.sessionId !== entry.id ||
			target.archived !== entry.archived ||
			(target.updatedAt !== undefined && target.updatedAt !== entry.updatedAt)
		) {
			throw new ProjectDeleteError("PROJECT_CHANGED", "Project sessions changed");
		}
	}
}

function addOwnedTarget(
	targets: Map<string, OwnedTarget>,
	agentDir: string,
	path: string,
	expectedType: "directory" | "file" | "either" = "either",
): void {
	const resolved = resolve(path);
	if (!inside(agentDir, resolved) || resolved === agentDir)
		throw new Error(`Owned target escapes agent directory: ${path}`);
	let metadata: ReturnType<typeof lstatSync>;
	try {
		metadata = lstatSync(resolved);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw error;
	}
	if (metadata.isSymbolicLink()) throw new Error(`Owned target cannot be a symbolic link: ${path}`);
	const canonical = realpathSync(resolved);
	if (canonical !== resolved || !inside(agentDir, canonical)) throw new Error(`Owned target is aliased: ${path}`);
	if (expectedType === "directory" && !metadata.isDirectory()) {
		throw new Error(`Owned target must be a real directory: ${path}`);
	}
	if (expectedType === "file" && (!metadata.isFile() || metadata.nlink !== 1)) {
		throw new Error(`Owned target must be a single-link file: ${path}`);
	}
	if (!metadata.isDirectory() && (!metadata.isFile() || metadata.nlink !== 1)) {
		throw new Error(`Owned target must be a real directory or single-link file: ${path}`);
	}
	const existing = targets.get(resolved);
	if (existing && existing.directory !== metadata.isDirectory()) throw new Error(`Owned target changed type: ${path}`);
	targets.set(resolved, { path: resolved, directory: metadata.isDirectory() });
}

function assertSafeMemoryTree(root: string, agentDir: string): void {
	if (!existsSync(root)) return;
	const pending = [root];
	while (pending.length > 0) {
		const path = pending.pop()!;
		const metadata = lstatSync(path);
		if (metadata.isSymbolicLink()) throw new Error(`Project memory cannot contain symbolic links: ${path}`);
		if (metadata.isDirectory()) {
			if (!inside(agentDir, realpathSync(path)))
				throw new Error(`Project memory escapes the agent directory: ${path}`);
			for (const name of readdirSync(path)) pending.push(join(path, name));
		} else if (!metadata.isFile() || metadata.nlink !== 1) {
			throw new Error(`Project memory contains an unsafe entry: ${path}`);
		}
	}
}

function pruneDescendants(targets: ReadonlyMap<string, OwnedTarget>): OwnedTarget[] {
	const kept: OwnedTarget[] = [];
	for (const target of targets.values()) {
		let parent = dirname(target.path);
		let covered = false;
		while (parent !== dirname(parent)) {
			if (targets.get(parent)?.directory) {
				covered = true;
				break;
			}
			parent = dirname(parent);
		}
		if (!covered) kept.push(target);
	}
	return kept.sort((left, right) => left.path.localeCompare(right.path));
}

async function collectTargets(
	input: TrashModeProjectDataInput,
	roots: ReturnType<typeof verifyRoots>,
	hooks: ModeProjectDeleteHooks,
	expected: ReadonlyMap<string, ModeProjectSessionTarget>,
): Promise<{ targets: OwnedTarget[]; storageCwd: string }> {
	const targets = new Map<string, OwnedTarget>();
	let storageCwd: string | undefined;
	let inspected = 0;
	for (const [path, target] of [...expected].sort(([left], [right]) => left.localeCompare(right))) {
		const before = lstatSync(path);
		if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
			throw new ProjectDeleteError("SESSION_CORRUPT", `Unsafe session journal: ${path}`);
		}
		if (target.updatedAt !== undefined && new Date(before.mtimeMs).toISOString() !== target.updatedAt) {
			throw new ProjectDeleteError("PROJECT_CHANGED", `Project session changed: ${path}`);
		}
		let header: SessionHeaderView;
		try {
			header = hooks.readSessionHeader(path);
		} catch (error) {
			throw new ProjectDeleteError("SESSION_CORRUPT", `Cannot validate ${path}: ${errorMessage(error)}`);
		}
		const after = lstatSync(path);
		if (!sameIdentity(before, after)) {
			throw new ProjectDeleteError("SESSION_CORRUPT", `Session journal changed during preflight: ${path}`);
		}
		if (
			header.id !== target.sessionId ||
			(header.mode ?? DEFAULT_AGENT_MODE) !== input.mode ||
			canonicalizePathForCreation(header.cwd) !== roots.cwd ||
			header.scheduled !== undefined
		) {
			throw new ProjectDeleteError("SESSION_CORRUPT", `Session ownership marker does not match: ${path}`);
		}
		const headerStorageCwd = resolvePath(header.cwd);
		if (
			encodePathForStorage(headerStorageCwd) !== basename(roots.projectDirectory) ||
			(storageCwd !== undefined && storageCwd !== headerStorageCwd)
		) {
			throw new ProjectDeleteError("SESSION_CORRUPT", `Session storage cwd does not match: ${path}`);
		}
		storageCwd = headerStorageCwd;

		addOwnedTarget(targets, roots.agentDir, path, "file");
		const activePath = join(roots.sessionsRoot, target.relativePath);
		const archivedPath = join(roots.sessionsRoot, ".archive", target.relativePath);
		for (const counterpart of [activePath, archivedPath]) {
			addOwnedTarget(targets, roots.agentDir, hooks.getSessionImageDir(counterpart), "directory");
			addOwnedTarget(targets, roots.agentDir, hooks.getSessionToolOutputDir(counterpart), "directory");
			for (const artifact of getOwnedSessionJournalArtifacts(counterpart)) {
				addOwnedTarget(targets, roots.agentDir, artifact);
			}
		}
		addOwnedTarget(targets, roots.agentDir, getSessionAttachmentDir(roots.agentDir, target.sessionId), "directory");
		addOwnedTarget(
			targets,
			roots.agentDir,
			hooks.getSessionSubagentDir(roots.agentDir, target.sessionId),
			"directory",
		);
		for (const workDir of getOwnedSessionWorkDirs(roots.agentDir, target.sessionId)) {
			addOwnedTarget(targets, roots.agentDir, workDir, "directory");
		}
		if (++inspected % 32 === 0) await yieldToEventLoop();
	}

	const projectMemory = getAutoMemoryPaths(roots.agentDir, roots.cwd, input.mode).project.directory;
	assertSafeMemoryTree(projectMemory, roots.agentDir);
	addOwnedTarget(targets, roots.agentDir, projectMemory, "directory");
	return { targets: pruneDescendants(targets), storageCwd: storageCwd ?? roots.storageCwd };
}

function manifestFor(
	agentDir: string,
	mode: AgentMode,
	cwd: string,
	targets: readonly OwnedTarget[],
): ProjectTrashManifest {
	return {
		version: 1,
		mode,
		cwd,
		createdAt: new Date().toISOString(),
		targets: targets.map((target) => {
			const agentRelative = relative(agentDir, target.path);
			if (!safeRelativePath(agentRelative))
				throw new Error(`Cannot stage target outside agent directory: ${target.path}`);
			return { original: target.path, stagedRelativePath: join("payload", agentRelative) };
		}),
	};
}

function validateManifest(agentDir: string, value: unknown): ProjectTrashManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid project Trash manifest");
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).sort().join("\0") !== ["createdAt", "cwd", "mode", "targets", "version"].sort().join("\0") ||
		record.version !== 1 ||
		!isAgentMode(record.mode) ||
		typeof record.cwd !== "string" ||
		!isAbsolute(record.cwd) ||
		typeof record.createdAt !== "string" ||
		!Number.isFinite(Date.parse(record.createdAt)) ||
		!Array.isArray(record.targets) ||
		record.targets.length > MAX_MANIFEST_TARGETS
	) {
		throw new Error("Invalid project Trash manifest");
	}
	const seenOriginals = new Set<string>();
	const seenStaged = new Set<string>();
	const targets = record.targets.map((value) => {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Trash manifest target");
		const target = value as Record<string, unknown>;
		if (
			Object.keys(target).sort().join("\0") !== ["original", "stagedRelativePath"].sort().join("\0") ||
			typeof target.original !== "string" ||
			typeof target.stagedRelativePath !== "string"
		) {
			throw new Error("Invalid Trash manifest target");
		}
		const original = resolve(target.original);
		if (!inside(agentDir, original) || original === agentDir)
			throw new Error("Trash manifest target escapes agent directory");
		const expected = join("payload", relative(agentDir, original));
		if (!safeRelativePath(target.stagedRelativePath) || target.stagedRelativePath !== expected) {
			throw new Error("Trash manifest staged path is invalid");
		}
		if (seenOriginals.has(original) || seenStaged.has(expected))
			throw new Error("Trash manifest contains duplicates");
		seenOriginals.add(original);
		seenStaged.add(expected);
		return { original, stagedRelativePath: expected };
	});
	return {
		version: 1,
		mode: record.mode,
		cwd: resolvePath(record.cwd),
		createdAt: record.createdAt,
		targets,
	};
}

function assertSafeRecoveryPath(root: string, path: string, label: string): void {
	if (!inside(root, path) || path === root) throw new Error(`${label} escapes its recovery root`);
	let current = path;
	while (current !== root) {
		let metadata: Stats;
		try {
			metadata = lstatSync(current);
		} catch (error) {
			if (errorCode(error) === "ENOENT") {
				current = dirname(current);
				continue;
			}
			throw error;
		}
		if (metadata.isSymbolicLink()) throw new Error(`${label} contains a symbolic link: ${current}`);
		if (current === path) {
			if (!metadata.isDirectory() && (!metadata.isFile() || metadata.nlink !== 1)) {
				throw new Error(`${label} is not a real directory or single-link file: ${current}`);
			}
		} else if (!metadata.isDirectory()) {
			throw new Error(`${label} has a non-directory ancestor: ${current}`);
		}
		if (realpathSync(current) !== current) throw new Error(`${label} contains an aliased path: ${current}`);
		current = dirname(current);
	}
}

function assertSafeRecoveryManifest(agentDir: string, operationDir: string, manifest: ProjectTrashManifest): void {
	for (const target of manifest.targets) {
		assertSafeRecoveryPath(agentDir, target.original, "Project Trash original");
		assertSafeRecoveryPath(operationDir, join(operationDir, target.stagedRelativePath), "Project Trash payload");
	}
}

function readManifest(agentDir: string, operationDir: string): ProjectTrashManifest {
	const text = readSingleLinkTextFileSync(join(operationDir, "manifest.json"), { maxBytes: MAX_MANIFEST_BYTES });
	if (text === undefined) throw new Error(`Missing project Trash manifest: ${operationDir}`);
	return validateManifest(agentDir, JSON.parse(text) as unknown);
}

function durableRename(source: string, destination: string, rename: Rename): void {
	ensureDirectoryDurablySync(dirname(destination), 0o700);
	rename(source, destination);
	syncDirectorySync(dirname(source));
	if (dirname(source) !== dirname(destination)) syncDirectorySync(dirname(destination));
}

function pathExists(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

function removeEmptyTree(path: string): void {
	if (!pathExists(path)) return;
	const metadata = lstatSync(path);
	if (!metadata.isDirectory() || metadata.isSymbolicLink())
		throw new Error(`Recovery payload is not a real directory: ${path}`);
	for (const name of readdirSync(path)) {
		const child = join(path, name);
		if (!lstatSync(child).isDirectory()) throw new Error(`Unexpected file remains in recovery payload: ${child}`);
		removeEmptyTree(child);
	}
	rmdirSync(path);
	syncDirectorySync(dirname(path));
}

function restoreManifest(operationDir: string, manifest: ProjectTrashManifest, rename: Rename): void {
	for (const target of [...manifest.targets].reverse()) {
		const staged = join(operationDir, target.stagedRelativePath);
		const originalExists = pathExists(target.original);
		const stagedExists = pathExists(staged);
		if (originalExists && !stagedExists) continue;
		if (!originalExists && stagedExists) {
			durableRename(staged, target.original, rename);
			continue;
		}
		throw new Error(`Ambiguous project Trash recovery state: ${target.original}`);
	}
	removeEmptyTree(join(operationDir, "payload"));
	unlinkSync(join(operationDir, "manifest.json"));
	syncDirectorySync(operationDir);
	rmdirSync(operationDir);
	syncDirectorySync(dirname(operationDir));
}

async function moveToTrash(operationDir: string): Promise<void> {
	const child = spawnProcess("trash", [operationDir], { stdio: "ignore", timeout: 30_000 });
	const exitCode = await waitForChildProcess(child);
	if (exitCode !== 0) throw new Error(`Trash exited with status ${exitCode ?? "unknown"}`);
}

async function stageAndTrash(
	roots: ReturnType<typeof verifyRoots>,
	input: TrashModeProjectDataInput,
	storageCwd: string,
	targets: readonly OwnedTarget[],
	hooks: ModeProjectDeleteHooks,
): Promise<TrashModeProjectDataResult> {
	if (targets.length === 0) return { ok: true, method: "trash", deletedSessionCount: input.sessions.length };
	const operationId = (hooks.operationId ?? randomUUID)();
	if (!UUID.test(operationId)) throw new Error("Project Trash operation id must be a UUID");
	const manifest = manifestFor(roots.agentDir, input.mode, storageCwd, targets);
	const manifestText = `${JSON.stringify(manifest)}\n`;
	if (manifest.targets.length > MAX_MANIFEST_TARGETS || Buffer.byteLength(manifestText) > MAX_MANIFEST_BYTES) {
		throw new Error("Project Trash manifest exceeds its size limit");
	}
	const operationRoot = join(roots.agentDir, "tmp", "project-delete");
	ensureRealDirectoryDurablySync(operationRoot, 0o700);
	const operationDir = join(operationRoot, operationId);
	mkdirSync(operationDir, { mode: 0o700 });
	chmodSync(operationDir, 0o700);
	syncDirectorySync(operationRoot);
	try {
		replaceFileAtomicallySync(join(operationDir, "manifest.json"), manifestText, { mode: 0o600 });
	} catch (error) {
		if (readdirSync(operationDir).length === 0) {
			rmdirSync(operationDir);
			syncDirectorySync(operationRoot);
		}
		throw error;
	}
	const rename = hooks.rename ?? renameSync;
	try {
		for (let index = 0; index < manifest.targets.length; index++) {
			const target = manifest.targets[index];
			durableRename(target.original, join(operationDir, target.stagedRelativePath), rename);
			if ((index + 1) % 32 === 0) await yieldToEventLoop();
		}
	} catch (error) {
		try {
			assertSafeRecoveryManifest(roots.agentDir, operationDir, manifest);
			restoreManifest(operationDir, manifest, rename);
		} catch (rollbackError) {
			throw new AggregateError([error, rollbackError], "Project staging failed and rollback was incomplete");
		}
		throw error;
	}

	let trashError: unknown;
	try {
		await (hooks.trash ?? moveToTrash)(operationDir);
	} catch (error) {
		trashError = error;
	}
	if (!pathExists(operationDir)) {
		return { ok: true, method: "trash", deletedSessionCount: input.sessions.length };
	}
	const staging = lstatSync(operationDir);
	if (!staging.isDirectory() || staging.isSymbolicLink()) {
		throw new Error(`Project Trash staging path became unsafe: ${operationDir}`);
	}
	try {
		assertSafeRecoveryManifest(roots.agentDir, operationDir, manifest);
		restoreManifest(operationDir, manifest, rename);
	} catch (rollbackError) {
		throw new AggregateError(
			trashError === undefined ? [rollbackError] : [trashError, rollbackError],
			"Trash failed and rollback was incomplete",
		);
	}
	throw new Error(
		trashError ? `Trash failed: ${errorMessage(trashError)}` : "Trash did not remove the staging directory",
	);
}

function closeLeases(leases: SessionLease[]): unknown[] {
	const errors: unknown[] = [];
	for (const lease of [...leases].reverse()) {
		try {
			lease.close();
		} catch (error) {
			try {
				lease.close();
			} catch (retryError) {
				errors.push(new AggregateError([error, retryError], "Failed to release project deletion lease"));
			}
		}
	}
	return errors;
}

export async function trashModeProjectData(
	input: TrashModeProjectDataInput,
	hooks: ModeProjectDeleteHooks,
): Promise<TrashModeProjectDataResult> {
	const leases: SessionLease[] = [];
	let result: TrashModeProjectDataResult;
	try {
		const roots = verifyRoots(input);
		const expected = validateInputTargets(input, roots);
		leases.push(acquireModeProjectMutationLease(roots.projectDirectory, input.mode));
		let acquired = 0;
		for (const path of [...expected.keys()].sort()) {
			leases.push(SessionLease.acquireTransient(path));
			if (++acquired % 32 === 0) await yieldToEventLoop();
		}
		verifySnapshot(input, roots, expected);
		let collected: Awaited<ReturnType<typeof collectTargets>>;
		try {
			collected = await collectTargets(input, roots, hooks, expected);
		} catch (error) {
			if (error instanceof ProjectDeleteError) throw error;
			throw new ProjectDeleteError("SESSION_CORRUPT", errorMessage(error));
		}
		result = await stageAndTrash(roots, input, collected.storageCwd, collected.targets, hooks);
	} catch (error) {
		const code: ProjectDeleteCode =
			error instanceof ProjectDeleteError
				? error.code
				: error instanceof SessionLeaseError
					? "SESSION_IN_USE"
					: "OPERATION_FAILED";
		result = { ok: false, method: "trash", code, error: errorMessage(error) };
	}
	const releaseErrors = closeLeases(leases);
	if (releaseErrors.length > 0 && !result.ok) {
		return {
			ok: false,
			method: "trash",
			code: "OPERATION_FAILED",
			error: `${result.error}; ${releaseErrors.map(errorMessage).join("; ")}`,
		};
	}
	return result;
}

export function recoverInterruptedProjectTrash(agentDir: string): void {
	const resolvedAgentDir = resolvePath(agentDir);
	ensureRealDirectoryDurablySync(resolvedAgentDir, 0o700);
	const canonicalAgentDir = strictDirectory(resolvedAgentDir, "Agent directory");
	const root = join(canonicalAgentDir, "tmp", "project-delete");
	if (!existsSync(root)) return;
	strictDirectory(root, "Project Trash recovery root");
	for (const name of readdirSync(root).sort()) {
		if (!UUID.test(name)) throw new Error(`Invalid project Trash recovery directory: ${name}`);
		const operationDir = join(root, name);
		strictDirectory(operationDir, "Project Trash operation");
		const manifest = readManifest(canonicalAgentDir, operationDir);
		assertSafeRecoveryManifest(canonicalAgentDir, operationDir, manifest);
		const leases: SessionLease[] = [];
		let recoveryError: unknown;
		try {
			const projectDirectory = join(canonicalAgentDir, "sessions", encodePathForStorage(manifest.cwd));
			leases.push(acquireModeProjectMutationLease(projectDirectory, manifest.mode));
			const sessionsRoot = join(canonicalAgentDir, "sessions");
			for (const path of manifest.targets
				.map((target) => target.original)
				.filter((path) => path.endsWith(".jsonl") && inside(sessionsRoot, path))
				.sort()) {
				leases.push(SessionLease.acquire(path));
			}
			restoreManifest(operationDir, manifest, renameSync);
		} catch (error) {
			recoveryError = error;
		}
		const releaseErrors = closeLeases(leases);
		if (recoveryError || releaseErrors.length > 0) {
			throw new AggregateError(
				[...(recoveryError ? [recoveryError] : []), ...releaseErrors],
				`Failed to recover interrupted project Trash operation: ${operationDir}`,
			);
		}
	}
}
