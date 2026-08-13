import { createHash } from "node:crypto";
import { type Dir, constants as fsConstants } from "node:fs";
import { type FileHandle, lstat, open, opendir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	type AgentMode,
	type ClientParams,
	type ClientResult,
	type CwdOrigin,
	MAX_NAME_UTF16_UNITS,
	type SessionSummary,
} from "@metis/app-protocol";
import {
	assertValidSessionId,
	CURRENT_SESSION_VERSION,
	canonicalizePathForCreation,
	encodePathForStorage,
	getDefaultSessionDir,
	getOwnedManagedWorkspace,
	MAX_SESSION_RECORD_BYTES,
	migrateSessionDisplayMetadata,
	moveSessionFileWithLease,
	readSessionDisplayMetadata,
	readSessionUnreadState,
	removeOwnedManagedWorkspace,
	resolveNewSessionWorkspace,
	type ScheduleRun,
	SessionManager,
} from "@metis/coding-agent";
import {
	completeSessionMutation,
	type DurableSessionMutation,
	type PreparedSessionMutation,
	prepareSessionMutation,
} from "./durable-mutation.ts";
import { AppServerError, type SessionRef } from "./session-runtime-host.ts";

const MAX_HEADER_BYTES = 64 * 1024;
const LAST_EVENT_READ_BUFFER_BYTES = 64 * 1024;
const MAX_SESSION_OUTCOME_TAIL_BYTES = 1024 * 1024;
const MAX_SESSION_INFO_BYTES = 8 * 1024;
const DEFAULT_LIST_LIMIT = 50;
const MAX_CATALOG_FILES = 100_000;
const MAX_CONCURRENT_CATALOG_SCANS = 32;

interface ScannedSession {
	readonly key: string;
	readonly path: string;
	readonly relativePath: string;
	readonly archived: boolean;
	readonly name?: string;
	readonly unread: boolean;
	readonly header?: {
		readonly id: string;
		readonly timestamp: string;
		readonly cwd: string;
		readonly mode: AgentMode;
		readonly cwdOrigin: CwdOrigin;
		readonly lastTurnOutcome?: "completed" | "failed";
		readonly scheduled?: { readonly taskId: string; readonly runId: string };
	};
	readonly updatedAt: string;
	readonly storageUpdatedAt: string;
}

interface CachedSessionName {
	readonly fingerprint: string;
	readonly dev: number;
	readonly ino: number;
	readonly scannedBytes: number;
	readonly updatedAt: string;
	readonly lastTurnOutcome?: "completed" | "failed";
	readonly name?: string;
}

export interface SessionCatalogOptions {
	readonly agentDir: string;
	readonly sessionsRoot?: string;
}

export interface ModeProjectSnapshot {
	readonly mode: AgentMode;
	readonly cwd: string;
	readonly refs: readonly SessionRef[];
	readonly revision: string;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: undefined;
}

function isInside(root: string, candidate: string): boolean {
	const child = relative(root, candidate);
	return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function safeIsoTimestamp(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length <= 40 &&
		/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
		Number.isFinite(Date.parse(value))
	);
}

interface SessionTailMetadata {
	readonly updatedAt?: string;
	readonly lastTurnOutcome?: "completed" | "failed";
}

function eventMetadata(bytes: Buffer): SessionTailMetadata {
	const line = bytes.toString("utf8").trim();
	if (!line) return {};
	try {
		const value = JSON.parse(line) as Record<string, unknown>;
		const lastTurnOutcome =
			value.type === "runtime_turn" && value.state === "completed"
				? "completed"
				: value.type === "runtime_turn" && value.state === "interrupted"
					? "failed"
					: undefined;
		return {
			...(safeIsoTimestamp(value.timestamp) ? { updatedAt: value.timestamp } : {}),
			...(lastTurnOutcome ? { lastTurnOutcome } : {}),
		};
	} catch {
		return {};
	}
}

async function readSessionTailMetadata(handle: FileHandle, size: number): Promise<SessionTailMetadata> {
	let position = size;
	let suffixBytes = 0;
	let suffixChunks: Buffer[] = [];
	let updatedAt: string | undefined;
	let lastTurnOutcome: "completed" | "failed" | undefined;
	const inspect = (line: Buffer) => {
		const metadata = eventMetadata(line);
		updatedAt ??= metadata.updatedAt;
		lastTurnOutcome ??= metadata.lastTurnOutcome;
	};
	while (position > 0) {
		const length = Math.min(position, LAST_EVENT_READ_BUFFER_BYTES);
		position -= length;
		const chunk = Buffer.allocUnsafe(length);
		const { bytesRead } = await handle.read(chunk, 0, length, position);
		if (bytesRead !== length) throw new Error("Session journal changed while reading its tail");
		let lineEnd = chunk.length;
		for (let index = chunk.length - 1; index >= 0; index -= 1) {
			if (chunk[index] !== 0x0a) continue;
			const segment = chunk.subarray(index + 1, lineEnd);
			if (segment.byteLength > 0 || suffixBytes > 0) {
				const line =
					suffixBytes > 0 ? Buffer.concat([segment, ...suffixChunks], segment.byteLength + suffixBytes) : segment;
				inspect(line);
				if (updatedAt && lastTurnOutcome) return { updatedAt, lastTurnOutcome };
			}
			suffixBytes = 0;
			suffixChunks = [];
			lineEnd = index;
		}
		const prefix = chunk.subarray(0, lineEnd);
		if (position === 0) {
			const line =
				suffixBytes > 0 ? Buffer.concat([prefix, ...suffixChunks], prefix.byteLength + suffixBytes) : prefix;
			inspect(line);
			break;
		}
		if (prefix.byteLength > 0) {
			suffixChunks.unshift(prefix);
			suffixBytes += prefix.byteLength;
			if (suffixBytes > MAX_SESSION_RECORD_BYTES) break;
		}
		if (updatedAt && size - position >= MAX_SESSION_OUTCOME_TAIL_BYTES) break;
	}
	return {
		...(updatedAt ? { updatedAt } : {}),
		...(lastTurnOutcome ? { lastTurnOutcome } : {}),
	};
}

function normalizedSessionName(value: string | undefined): string | undefined {
	const normalized = value
		?.replace(/[\r\n]+/g, " ")
		.trim()
		.slice(0, MAX_NAME_UTF16_UNITS);
	return normalized ? normalized : undefined;
}

function corruptId(relativePath: string, discriminator = ""): string {
	return `corrupt-${createHash("sha256").update(relativePath).update(discriminator).digest("hex").slice(0, 32)}`;
}

function corruptSummary(sessionId: string, scanned: ScannedSession): SessionSummary {
	return {
		sessionId,
		mode: "code",
		cwdOrigin: "user-selected",
		cwd: null,
		createdAt: scanned.updatedAt,
		updatedAt: scanned.updatedAt,
		state: "corrupt",
		archived: scanned.archived,
		unread: false,
		recoveryNotice: "Session journal could not be opened safely.",
	};
}

function canonicalProjectCwd(cwd: string): string {
	return canonicalizePathForCreation(resolve(cwd));
}

function summaryCwd(cwd: string): string | null {
	return cwd ? canonicalProjectCwd(cwd) : null;
}

function isSameProjectCwd(cwd: string, canonicalCwd: string, cache: Map<string, string>): boolean {
	let candidate = cache.get(cwd);
	if (candidate === undefined) {
		candidate = canonicalProjectCwd(cwd);
		cache.set(cwd, candidate);
	}
	return candidate === canonicalCwd;
}

function projectKey(mode: AgentMode, cwd: string): string {
	return JSON.stringify([mode, cwd]);
}

function storageRoot(relativePath: string): string {
	const index = relativePath.indexOf(sep);
	return index < 0 ? relativePath : relativePath.slice(0, index);
}

function isInStorage(relativePath: string, storageKey: string): boolean {
	return relativePath.startsWith(`${storageKey}${sep}`);
}

async function isAbsent(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return false;
	} catch (error) {
		if (errorCode(error) === "ENOENT") return true;
		throw error;
	}
}

async function readHeader(
	path: string,
	nameStart: number | false | undefined = undefined,
	cachedTail?: SessionTailMetadata,
): Promise<{
	id: string;
	timestamp: string;
	updatedAt: string;
	lastTurnOutcome?: "completed" | "failed";
	cwd: string;
	mode: AgentMode;
	cwdOrigin: CwdOrigin;
	name?: string;
	nameScannedThrough: number;
	scheduled?: { taskId: string; runId: string };
}> {
	const before = await lstat(path);
	if (!before.isFile() || before.nlink !== 1) throw new Error("Session journal is not a single-link regular file");
	const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
	const nonBlock = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
	const handle = await open(path, fsConstants.O_RDONLY | noFollow | nonBlock);
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== before.dev || opened.ino !== before.ino) {
			throw new Error("Session journal changed while opening");
		}
		const bytes = Buffer.allocUnsafe(MAX_HEADER_BYTES + 1);
		const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
		const newline = bytes.subarray(0, bytesRead).indexOf(0x0a);
		if (newline < 0 && bytesRead > MAX_HEADER_BYTES) throw new Error("Session header exceeds its size limit");
		const length = newline < 0 ? bytesRead : newline;
		if (length === 0) throw new Error("Session header is empty");
		const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))) as Record<
			string,
			unknown
		>;
		if (value.type !== "session") throw new Error("Session header has the wrong type");
		if (
			value.version !== undefined &&
			(!Number.isInteger(value.version) ||
				(value.version as number) < 1 ||
				(value.version as number) > CURRENT_SESSION_VERSION)
		) {
			throw new Error("Session header version is unsupported");
		}
		if (typeof value.id !== "string") throw new Error("Session header id is invalid");
		assertValidSessionId(value.id);
		let scheduled: { taskId: string; runId: string } | undefined;
		if (value.scheduled !== undefined) {
			if (
				typeof value.scheduled !== "object" ||
				value.scheduled === null ||
				Array.isArray(value.scheduled) ||
				Object.keys(value.scheduled).some((key) => key !== "taskId" && key !== "runId")
			) {
				throw new Error("Session scheduled metadata is invalid");
			}
			const marker = value.scheduled as Record<string, unknown>;
			if (typeof marker.taskId !== "string" || typeof marker.runId !== "string") {
				throw new Error("Session scheduled metadata is invalid");
			}
			assertValidSessionId(marker.taskId);
			assertValidSessionId(marker.runId);
			scheduled = { taskId: marker.taskId, runId: marker.runId };
		}
		if (!safeIsoTimestamp(value.timestamp)) throw new Error("Session header timestamp is invalid");
		if (typeof value.cwd !== "string" || Buffer.byteLength(value.cwd, "utf8") > 32 * 1024) {
			throw new Error("Session header cwd is invalid");
		}
		let name: string | undefined;
		const scanStart = nameStart === false ? undefined : Math.max(newline + 1, nameStart ?? newline + 1);
		let nameScannedThrough = nameStart === false ? opened.size : (scanStart ?? newline + 1);
		if (scanStart !== undefined && newline >= 0 && scanStart < opened.size) {
			const buffer = Buffer.allocUnsafe(64 * 1024);
			let position = scanStart;
			let chunks: Buffer[] = [];
			let chunkBytes = 0;
			let oversized = false;
			const finishLine = () => {
				if (!oversized && chunkBytes > 0) {
					const line = Buffer.concat(chunks, chunkBytes);
					if (line.includes("session_info")) {
						try {
							const record = JSON.parse(line.toString("utf8")) as Record<string, unknown>;
							if (record.type === "session_info" && typeof record.name === "string") {
								name = normalizedSessionName(record.name);
							}
						} catch {
							// Transcript corruption remains an open-time concern; catalog identity is header-only.
						}
					}
				}
				chunks = [];
				chunkBytes = 0;
				oversized = false;
			};
			while (position < opened.size) {
				const { bytesRead: chunkLength } = await handle.read(
					buffer,
					0,
					Math.min(buffer.byteLength, opened.size - position),
					position,
				);
				if (chunkLength === 0) break;
				const chunk = buffer.subarray(0, chunkLength);
				let segmentStart = 0;
				let lineEnd = chunk.indexOf(0x0a);
				while (lineEnd >= 0) {
					const segment = chunk.subarray(segmentStart, lineEnd);
					if (!oversized && chunkBytes + segment.byteLength <= MAX_SESSION_INFO_BYTES) {
						chunks.push(Buffer.from(segment));
						chunkBytes += segment.byteLength;
					} else {
						chunks = [];
						chunkBytes = 0;
						oversized = true;
					}
					finishLine();
					nameScannedThrough = position + lineEnd + 1;
					segmentStart = lineEnd + 1;
					lineEnd = chunk.indexOf(0x0a, segmentStart);
				}
				const remainder = chunk.subarray(segmentStart);
				if (!oversized && chunkBytes + remainder.byteLength <= MAX_SESSION_INFO_BYTES) {
					chunks.push(Buffer.from(remainder));
					chunkBytes += remainder.byteLength;
				} else if (remainder.byteLength > 0) {
					chunks = [];
					chunkBytes = 0;
					oversized = true;
				}
				position += chunkLength;
			}
		}
		const tail = cachedTail ?? (await readSessionTailMetadata(handle, opened.size));
		const updatedAt = tail.updatedAt ?? value.timestamp;
		const current = await lstat(path);
		if (!current.isFile() || current.nlink !== 1 || current.dev !== opened.dev || current.ino !== opened.ino) {
			throw new Error("Session journal identity changed while reading its header");
		}
		return {
			id: value.id,
			timestamp: value.timestamp,
			updatedAt,
			...(tail.lastTurnOutcome ? { lastTurnOutcome: tail.lastTurnOutcome } : {}),
			cwd: value.cwd,
			mode: value.mode === "chat" || value.mode === "code" ? value.mode : "code",
			cwdOrigin:
				value.cwdOrigin === "managed" || value.cwdOrigin === "user-selected" ? value.cwdOrigin : "user-selected",
			...(name ? { name } : {}),
			nameScannedThrough,
			...(scheduled ? { scheduled } : {}),
		};
	} finally {
		await handle.close();
	}
}

async function collectJsonlFiles(root: string, skipArchive: boolean): Promise<string[]> {
	let canonicalRoot: string;
	try {
		if (!(await lstat(root)).isDirectory()) return [];
		canonicalRoot = await realpath(root);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return [];
		throw error;
	}
	const result: string[] = [];
	const pending = [root];
	while (pending.length > 0) {
		const directory = pending.pop()!;
		let iterator: Dir;
		try {
			if (!(await lstat(directory)).isDirectory()) continue;
			if (!isInside(canonicalRoot, await realpath(directory))) {
				throw new AppServerError("OPERATION_FAILED");
			}
			iterator = await opendir(directory);
		} catch (error) {
			if (errorCode(error) === "ENOENT") continue;
			throw error;
		}
		for await (const entry of iterator) {
			if (skipArchive && directory === root && entry.name === ".archive") continue;
			if (entry.isDirectory() && entry.name === "subagents") continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) result.push(path);
			if (result.length > MAX_CATALOG_FILES) throw new AppServerError("OVERLOADED");
		}
	}
	return result;
}

/** Bounded catalog reconstructed from session identity plus persisted display metadata. */
export class SessionCatalog {
	readonly agentDir: string;
	readonly sessionsRoot: string;
	readonly archiveRoot: string;
	private sessions = new Map<string, SessionRef>();
	private claimedSessionIds = new Set<string>();
	private readonly blockedProjectKeys = new Set<string>();
	private readonly activeSessionMutations = new Set<string>();
	private readonly sessionNames = new Map<string, CachedSessionName>();
	private mutationTail: Promise<void> = Promise.resolve();

	constructor(options: SessionCatalogOptions) {
		this.agentDir = resolve(options.agentDir);
		this.sessionsRoot = resolve(options.sessionsRoot ?? join(this.agentDir, "sessions"));
		this.archiveRoot = join(this.sessionsRoot, ".archive");
	}

	private async scanOne(path: string, archived: boolean): Promise<ScannedSession> {
		const root = archived ? this.archiveRoot : this.sessionsRoot;
		const relativePath = relative(root, path);
		const key = `${archived ? "archive" : "active"}:${relativePath}`;
		try {
			const stats = await lstat(path);
			const fingerprint = `${stats.dev}:${stats.ino}:${stats.size}:${stats.mtimeMs}`;
			const cachedName = this.sessionNames.get(path);
			const sameIdentity = cachedName?.dev === stats.dev && cachedName.ino === stats.ino;
			const canContinueNameScan = sameIdentity && stats.size > cachedName.scannedBytes;
			let persistedName = cachedName ? undefined : readSessionDisplayMetadata(path);
			const nameStart =
				cachedName?.fingerprint === fingerprint
					? false
					: canContinueNameScan
						? cachedName.scannedBytes
						: persistedName
							? false
							: undefined;
			const unchanged = cachedName?.fingerprint === fingerprint;
			const cachedTail = unchanged
				? {
						updatedAt: cachedName.updatedAt,
						...(cachedName.lastTurnOutcome ? { lastTurnOutcome: cachedName.lastTurnOutcome } : {}),
					}
				: undefined;
			let metadata = await readHeader(path, nameStart, cachedTail);
			if (persistedName && persistedName.sessionId !== metadata.id) {
				persistedName = undefined;
				metadata = await readHeader(path, undefined, cachedTail);
			}
			const { name: scannedName, nameScannedThrough, updatedAt, ...header } = metadata;
			const name =
				cachedName?.fingerprint === fingerprint || canContinueNameScan
					? (scannedName ?? cachedName.name)
					: (persistedName?.name ?? scannedName);
			const after = await lstat(path);
			if (!after.isFile() || after.nlink !== 1 || after.dev !== stats.dev || after.ino !== stats.ino) {
				throw new Error("Session journal identity changed while reading its metadata");
			}
			if (cachedName?.fingerprint !== fingerprint) {
				this.sessionNames.set(path, {
					fingerprint,
					dev: stats.dev,
					ino: stats.ino,
					scannedBytes: nameScannedThrough,
					updatedAt,
					...(header.lastTurnOutcome ? { lastTurnOutcome: header.lastTurnOutcome } : {}),
					...(name ? { name } : {}),
				});
			}
			if (nameStart === undefined) {
				migrateSessionDisplayMetadata(path, {
					sessionId: header.id,
					...(name ? { name } : {}),
					dev: stats.dev,
					ino: stats.ino,
					size: stats.size,
					mtimeMs: stats.mtimeMs,
					ctimeMs: stats.ctimeMs,
				});
			}
			return {
				key,
				path,
				relativePath,
				archived,
				unread: readSessionUnreadState(path, header.id),
				header,
				...(name ? { name } : {}),
				updatedAt,
				storageUpdatedAt: new Date(after.mtimeMs).toISOString(),
			};
		} catch {
			this.sessionNames.delete(path);
			let storageUpdatedAt = new Date(0).toISOString();
			try {
				storageUpdatedAt = new Date((await lstat(path)).mtimeMs).toISOString();
			} catch {
				// Keep the deterministic epoch fallback for a disappearing file.
			}
			return { key, path, relativePath, archived, unread: false, updatedAt: storageUpdatedAt, storageUpdatedAt };
		}
	}

	private async scanCandidates(
		candidates: readonly {
			readonly path: string;
			readonly archived: boolean;
		}[],
	): Promise<ScannedSession[]> {
		const scanned = new Array<ScannedSession>(candidates.length);
		let nextCandidate = 0;
		await Promise.all(
			Array.from({ length: Math.min(MAX_CONCURRENT_CATALOG_SCANS, candidates.length) }, async () => {
				while (nextCandidate < candidates.length) {
					const index = nextCandidate++;
					const candidate = candidates[index]!;
					scanned[index] = await this.scanOne(candidate.path, candidate.archived);
				}
			}),
		);
		return scanned;
	}

	async refresh(): Promise<void> {
		const [activeFiles, archivedFiles] = await Promise.all([
			collectJsonlFiles(this.sessionsRoot, true),
			collectJsonlFiles(this.archiveRoot, false),
		]);
		const candidates = [
			...activeFiles.map((path) => ({ path, archived: false })),
			...archivedFiles.map((path) => ({ path, archived: true })),
		];
		const candidatePaths = new Set(candidates.map((candidate) => candidate.path));
		for (const path of this.sessionNames.keys()) {
			if (!candidatePaths.has(path)) this.sessionNames.delete(path);
		}
		const scanned = await this.scanCandidates(candidates);
		const ordinary = scanned;
		const idCounts = new Map<string, number>();
		for (const item of ordinary) {
			if (item.header) idCounts.set(item.header.id, (idCounts.get(item.header.id) ?? 0) + 1);
		}
		this.claimedSessionIds = new Set(idCounts.keys());

		const next = new Map<string, SessionRef>();
		for (const item of ordinary) {
			const duplicate = item.header !== undefined && idCounts.get(item.header.id)! > 1;
			let sessionId = item.header && !duplicate ? item.header.id : corruptId(item.relativePath);
			if (next.has(sessionId)) sessionId = corruptId(item.relativePath, item.key);
			const summary =
				item.header && !duplicate
					? {
							sessionId,
							mode: item.header.mode,
							cwdOrigin: item.header.cwdOrigin,
							cwd: summaryCwd(item.header.cwd),
							createdAt: item.header.timestamp,
							updatedAt: item.updatedAt,
							state: "idle" as const,
							...(item.header.lastTurnOutcome ? { lastTurnOutcome: item.header.lastTurnOutcome } : {}),
							archived: item.archived,
							unread: item.unread,
							...(item.name ? { name: item.name } : {}),
							...(item.header.scheduled ? { scheduled: item.header.scheduled } : {}),
						}
					: corruptSummary(sessionId, item);
			next.set(sessionId, {
				path: item.path,
				relativePath: item.relativePath,
				storageUpdatedAt: item.storageUpdatedAt,
				summary,
				...(item.header?.scheduled ? { scheduled: item.header.scheduled } : {}),
			});
		}
		this.sessions = next;
	}

	async refreshModeProjectStorage(cwd: string): Promise<string> {
		const canonicalCwd = canonicalProjectCwd(cwd);
		const storageKeys = new Set([encodePathForStorage(canonicalCwd)]);
		const canonicalCwds = new Map<string, string>();
		for (const ref of this.sessions.values()) {
			if (
				ref.summary.cwd &&
				ref.summary.cwdOrigin === "user-selected" &&
				isSameProjectCwd(ref.summary.cwd, canonicalCwd, canonicalCwds)
			) {
				storageKeys.add(storageRoot(ref.relativePath));
			}
		}
		const files = await Promise.all(
			[...storageKeys].flatMap((storageKey) => [
				collectJsonlFiles(join(this.sessionsRoot, storageKey), false).then((paths) =>
					paths.map((path) => ({ path, archived: false })),
				),
				collectJsonlFiles(join(this.archiveRoot, storageKey), false).then((paths) =>
					paths.map((path) => ({ path, archived: true })),
				),
			]),
		);
		const candidates = files.flat();
		if (candidates.length > MAX_CATALOG_FILES) throw new AppServerError("OVERLOADED");
		const scanned = await this.scanCandidates([...candidates]);
		await this.mutate(async () => {
			const storageKeyList = [...storageKeys];
			const next = new Map(
				[...this.sessions].filter(([, ref]) => !storageKeyList.some((key) => isInStorage(ref.relativePath, key))),
			);
			const idCounts = new Map<string, number>();
			for (const item of scanned) {
				if (item.header) idCounts.set(item.header.id, (idCounts.get(item.header.id) ?? 0) + 1);
			}
			for (const item of scanned) {
				const duplicate =
					item.header !== undefined && (idCounts.get(item.header.id)! > 1 || next.has(item.header.id));
				let sessionId = item.header && !duplicate ? item.header.id : corruptId(item.relativePath);
				if (next.has(sessionId)) sessionId = corruptId(item.relativePath, item.key);
				const summary =
					item.header && !duplicate
						? {
								sessionId,
								mode: item.header.mode,
								cwdOrigin: item.header.cwdOrigin,
								cwd: summaryCwd(item.header.cwd),
								createdAt: item.header.timestamp,
								updatedAt: item.updatedAt,
								state: "idle" as const,
								...(item.header.lastTurnOutcome ? { lastTurnOutcome: item.header.lastTurnOutcome } : {}),
								archived: item.archived,
								unread: item.unread,
								...(item.name ? { name: item.name } : {}),
								...(item.header.scheduled ? { scheduled: item.header.scheduled } : {}),
							}
						: corruptSummary(sessionId, item);
				next.set(sessionId, {
					path: item.path,
					relativePath: item.relativePath,
					storageUpdatedAt: item.storageUpdatedAt,
					summary,
					...(item.header?.scheduled ? { scheduled: item.header.scheduled } : {}),
				});
				if (item.header) this.claimedSessionIds.add(item.header.id);
			}
			this.sessions = next;
		});
		return canonicalCwd;
	}

	async registerScheduledRun(
		run: ScheduleRun,
	): Promise<{ readonly session: SessionSummary; readonly changed: boolean } | undefined> {
		if (!run.sessionId || !run.sessionFile) return;
		const sessionId = run.sessionId;
		const sessionFile = run.sessionFile;
		return await this.mutate(async () => {
			try {
				const expectedRoot = await realpath(getDefaultSessionDir(run.snapshot.target.cwd, this.agentDir));
				const expectedCwdOrigin = run.snapshot.target.workspace === "task" ? "managed" : "user-selected";
				const path = resolve(sessionFile);
				const canonicalPath = await realpath(path);
				if (!isInside(expectedRoot, canonicalPath)) throw new Error("Session is outside its task directory");
				const header = await readHeader(path, false);
				if (
					header.id !== sessionId ||
					header.scheduled?.taskId !== run.taskId ||
					header.scheduled.runId !== run.id ||
					header.mode !== "chat" ||
					header.cwdOrigin !== expectedCwdOrigin ||
					header.cwd !== run.snapshot.target.cwd
				) {
					throw new Error("Session identity does not match its run");
				}
				const existing = this.sessions.get(sessionId);
				if (existing && existing.path !== path) throw new Error("Session id is already claimed");
				const storageUpdatedAt = new Date((await lstat(path)).mtimeMs).toISOString();
				const summary: SessionSummary = {
					sessionId,
					mode: header.mode,
					cwdOrigin: header.cwdOrigin,
					cwd: summaryCwd(header.cwd),
					createdAt: header.timestamp,
					updatedAt: header.updatedAt,
					state: "idle",
					...(header.lastTurnOutcome ? { lastTurnOutcome: header.lastTurnOutcome } : {}),
					archived: false,
					unread: run.unread,
					scheduled: header.scheduled,
				};
				const changed = JSON.stringify(existing?.summary) !== JSON.stringify(summary);
				this.sessions.set(sessionId, {
					path,
					relativePath: relative(this.agentDir, path),
					storageUpdatedAt,
					scheduled: header.scheduled,
					summary,
				});
				this.claimedSessionIds.add(sessionId);
				return { session: summary, changed };
			} catch {
				throw new AppServerError("SESSION_CORRUPT");
			}
		});
	}

	async removeScheduledTask(taskId: string): Promise<string[]> {
		return await this.mutate(async () => {
			const removed: string[] = [];
			for (const [sessionId, ref] of this.sessions) {
				if (ref.scheduled?.taskId !== taskId) continue;
				this.sessions.delete(sessionId);
				this.claimedSessionIds.delete(sessionId);
				removed.push(sessionId);
			}
			return removed;
		});
	}

	scheduledSessionIds(taskId: string): string[] {
		return [...this.sessions.entries()]
			.filter(([, ref]) => ref.scheduled?.taskId === taskId)
			.map(([sessionId]) => sessionId);
	}

	modeProjectSnapshot(mode: AgentMode, cwd: string): ModeProjectSnapshot {
		const canonicalCwd = canonicalProjectCwd(cwd);
		return this.snapshotModeProject(mode, canonicalCwd);
	}

	private async existingProjectStorageCwd(canonicalCwd: string): Promise<string | undefined> {
		const refs = [...this.sessions.values()].filter(
			(ref) =>
				!ref.scheduled &&
				ref.summary.state !== "corrupt" &&
				ref.summary.cwdOrigin === "user-selected" &&
				ref.summary.cwd !== null &&
				canonicalProjectCwd(ref.summary.cwd) === canonicalCwd,
		);
		if (refs.length === 0) return undefined;
		const roots = new Set(refs.map((ref) => storageRoot(ref.relativePath)));
		if (roots.size !== 1) throw new AppServerError("SESSION_CORRUPT");
		try {
			const header = await readHeader(refs[0]!.path, false);
			if (
				header.cwdOrigin !== "user-selected" ||
				canonicalProjectCwd(header.cwd) !== canonicalCwd ||
				encodePathForStorage(header.cwd) !== roots.values().next().value
			) {
				throw new Error("Project storage identity does not match its journal");
			}
			return header.cwd;
		} catch {
			throw new AppServerError("SESSION_CORRUPT");
		}
	}

	async withModeProjectBlocked<T>(
		input: {
			readonly mode: AgentMode;
			readonly cwd: string;
			readonly expectedRevision: string;
		},
		operation: (snapshot: ModeProjectSnapshot) => Promise<T>,
	): Promise<T> {
		const canonicalCwd = canonicalProjectCwd(input.cwd);
		const key = projectKey(input.mode, canonicalCwd);
		const snapshot = await this.mutate(async () => {
			if (this.blockedProjectKeys.has(key)) throw new AppServerError("BUSY");
			const value = this.snapshotModeProject(input.mode, canonicalCwd);
			if (value.revision !== input.expectedRevision) throw new AppServerError("BUSY");
			if (value.refs.some((ref) => this.activeSessionMutations.has(ref.summary.sessionId))) {
				throw new AppServerError("BUSY");
			}
			this.blockedProjectKeys.add(key);
			return value;
		});
		let result: T;
		try {
			result = await operation(snapshot);
		} catch (error) {
			try {
				await this.refreshModeProjectStorage(canonicalCwd);
			} finally {
				await this.mutate(() => {
					this.blockedProjectKeys.delete(key);
				});
			}
			throw error;
		}

		try {
			await this.mutate(() => {
				for (const ref of snapshot.refs) {
					const sessionId = ref.summary.sessionId;
					const current = this.sessions.get(sessionId);
					if (
						current?.path === ref.path &&
						current.relativePath === ref.relativePath &&
						current.storageUpdatedAt === ref.storageUpdatedAt &&
						current.summary.archived === ref.summary.archived
					) {
						this.sessions.delete(sessionId);
						this.claimedSessionIds.delete(sessionId);
					}
				}
				this.blockedProjectKeys.delete(key);
			});
			return result;
		} catch (error) {
			const deleted = (await Promise.all(snapshot.refs.map((ref) => isAbsent(ref.path)))).every(Boolean);
			let refreshError: unknown;
			try {
				await this.refreshModeProjectStorage(canonicalCwd);
			} catch (reconcileError) {
				refreshError = reconcileError;
			} finally {
				await this.mutate(() => {
					this.blockedProjectKeys.delete(key);
				});
			}
			if (deleted) return result;
			throw refreshError ?? error;
		}
	}

	async withSessionProjectMutable<T>(sessionId: string, operation: (ref: SessionRef) => Promise<T>): Promise<T> {
		const ref = await this.mutate(() => {
			const current = this.get(sessionId);
			if (!current.scheduled && current.summary.cwdOrigin === "user-selected" && current.summary.cwd) {
				const key = projectKey(current.summary.mode, canonicalProjectCwd(current.summary.cwd));
				if (this.blockedProjectKeys.has(key)) throw new AppServerError("BUSY", { sessionId });
			}
			if (this.activeSessionMutations.has(sessionId)) throw new AppServerError("BUSY", { sessionId });
			this.activeSessionMutations.add(sessionId);
			return current;
		});
		try {
			return await operation(ref);
		} finally {
			await this.mutate(() => {
				this.activeSessionMutations.delete(sessionId);
			});
		}
	}

	private snapshotModeProject(mode: AgentMode, canonicalCwd: string): ModeProjectSnapshot {
		const key = projectKey(mode, canonicalCwd);
		if (this.blockedProjectKeys.has(key)) throw new AppServerError("BUSY");
		const canonicalCwds = new Map<string, string>();
		const refs = [...this.sessions.values()].filter(
			(ref) =>
				!ref.scheduled &&
				ref.summary.state !== "corrupt" &&
				ref.summary.mode === mode &&
				ref.summary.cwdOrigin === "user-selected" &&
				ref.summary.cwd !== null &&
				isSameProjectCwd(ref.summary.cwd, canonicalCwd, canonicalCwds),
		);
		const storageKeys = new Set([encodePathForStorage(canonicalCwd)]);
		for (const ref of this.sessions.values()) {
			if (
				ref.summary.state !== "corrupt" &&
				ref.summary.cwdOrigin === "user-selected" &&
				ref.summary.cwd &&
				isSameProjectCwd(ref.summary.cwd, canonicalCwd, canonicalCwds)
			) {
				storageKeys.add(storageRoot(ref.relativePath));
			}
		}
		const storageKeyList = [...storageKeys];
		for (const ref of this.sessions.values()) {
			if (
				ref.summary.state === "corrupt" &&
				storageKeyList.some((storageKey) => isInStorage(ref.relativePath, storageKey))
			) {
				throw new AppServerError("SESSION_CORRUPT");
			}
		}
		for (const ref of refs) {
			if (dirname(ref.relativePath) !== storageRoot(ref.relativePath)) {
				throw new AppServerError("SESSION_CORRUPT", {
					sessionId: ref.summary.sessionId,
				});
			}
		}
		refs.sort((left, right) => left.summary.sessionId.localeCompare(right.summary.sessionId));
		const hash = createHash("sha256").update(mode).update("\0").update(canonicalCwd).update("\0");
		for (const ref of refs) {
			hash
				.update(ref.summary.sessionId)
				.update("\0")
				.update(ref.summary.archived ? "1" : "0")
				.update("\0")
				.update(ref.relativePath)
				.update("\0")
				.update(ref.storageUpdatedAt ?? ref.summary.updatedAt)
				.update("\0");
		}
		return { mode, cwd: canonicalCwd, refs, revision: hash.digest("hex") };
	}

	private mutate<T>(operation: () => T | Promise<T>): Promise<T> {
		const result = this.mutationTail.then(operation);
		this.mutationTail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	get(sessionId: string): SessionRef {
		const ref = this.sessions.get(sessionId);
		if (!ref) throw new AppServerError("NOT_FOUND", { sessionId });
		return ref;
	}

	list(input: ClientParams<"session/list">): ClientResult<"session/list"> {
		const sessions = [...this.sessions.values()]
			.map((ref) => ref.summary)
			.filter((summary) => input.includeArchived === true || !summary.archived)
			.sort(
				(left, right) =>
					right.updatedAt.localeCompare(left.updatedAt) || left.sessionId.localeCompare(right.sessionId),
			);
		let offset = 0;
		if (input.afterSessionId) {
			const index = sessions.findIndex((summary) => summary.sessionId === input.afterSessionId);
			if (index < 0)
				throw new AppServerError("NOT_FOUND", {
					sessionId: input.afterSessionId,
				});
			offset = index + 1;
		}
		const limit = input.limit ?? DEFAULT_LIST_LIMIT;
		const page = sessions.slice(offset, offset + limit);
		return {
			sessions: page,
			nextAfterSessionId: offset + page.length < sessions.length ? page.at(-1)!.sessionId : null,
		};
	}

	create(input: ClientParams<"session/create">): Promise<SessionSummary> {
		return this.mutate(async () => {
			const mode = input.mode ?? "code";
			const projectCwd =
				input.cwd !== undefined
					? canonicalProjectCwd(input.cwd)
					: mode === "code"
						? canonicalProjectCwd(process.cwd())
						: null;
			if (projectCwd && this.blockedProjectKeys.has(projectKey(mode, projectCwd))) {
				throw new AppServerError("BUSY", { requestId: input.requestId });
			}
			const requestedName = normalizedSessionName(input.name);
			const requestedPermissionMode = input.permissionMode ?? "auto";
			const mutation: DurableSessionMutation = {
				method: "session/create",
				kind: "session_create",
				requestId: input.requestId,
				params: {
					...(input.mode === undefined ? {} : { mode: input.mode }),
					...(input.cwd === undefined ? {} : { cwd: input.cwd }),
					...(input.name === undefined ? {} : { name: input.name }),
					...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
				},
			};
			const existing = this.sessions.get(input.requestId);
			if (existing?.scheduled) {
				throw new AppServerError("REQUEST_ID_REUSED", {
					requestId: input.requestId,
				});
			}
			if (existing) {
				const manager = SessionManager.open(existing.path);
				try {
					const prepared = prepareSessionMutation(manager, mutation);
					if (prepared.state === "completed") return prepared.result as SessionSummary;
					const name = normalizedSessionName(manager.getSessionName());
					const requestedCwd = input.cwd === undefined ? undefined : await realpath(resolve(input.cwd));
					const workspaceMatches = requestedCwd
						? manager.getCwd() === requestedCwd && manager.getCwdOrigin() === "user-selected"
						: mode === "chat"
							? getOwnedManagedWorkspace({
									id: input.requestId,
									cwd: manager.getCwd(),
									cwdOrigin: manager.getCwdOrigin(),
									agentDir: this.agentDir,
								}) !== undefined
							: manager.getCwd() === (await realpath(process.cwd())) &&
								manager.getCwdOrigin() === "user-selected";
					if (
						manager.getMode() !== mode ||
						!workspaceMatches ||
						name !== requestedName ||
						manager.getPermissionSettings().mode !== requestedPermissionMode
					) {
						throw new AppServerError("REQUEST_ID_REUSED", {
							requestId: input.requestId,
						});
					}
					const summary = {
						...existing.summary,
						...(name === undefined ? {} : { name }),
					};
					return completeSessionMutation(manager, mutation, summary) as SessionSummary;
				} finally {
					manager.close();
				}
			}
			if (this.claimedSessionIds.has(input.requestId)) {
				throw new AppServerError("REQUEST_ID_REUSED", {
					requestId: input.requestId,
				});
			}

			const existingStorageCwd = projectCwd ? await this.existingProjectStorageCwd(projectCwd) : undefined;
			const workspace = existingStorageCwd
				? { cwd: existingStorageCwd, cwdOrigin: "user-selected" as const }
				: resolveNewSessionWorkspace({
						id: input.requestId,
						mode,
						requestedCwd: input.cwd,
						hostCwd: process.cwd(),
						agentDir: this.agentDir,
					});
			let manager: SessionManager | undefined;
			try {
				try {
					manager = SessionManager.create(workspace.cwd, getDefaultSessionDir(workspace.cwd, this.agentDir), {
						id: input.requestId,
						mode,
						cwdOrigin: workspace.cwdOrigin,
						...(input.permissionMode === undefined ? {} : { permissionMode: input.permissionMode }),
					});
				} catch (error) {
					if (workspace.cwdOrigin === "managed") {
						removeOwnedManagedWorkspace({
							id: input.requestId,
							cwd: workspace.cwd,
							cwdOrigin: workspace.cwdOrigin,
							agentDir: this.agentDir,
						});
					}
					throw error;
				}
				if (requestedName !== undefined) manager.appendSessionInfo(requestedName);
				prepareSessionMutation(manager, mutation);
			} finally {
				manager?.close();
			}
			await this.refresh();
			const summary =
				requestedName === undefined
					? this.get(input.requestId).summary
					: this.updateSummary(input.requestId, { name: requestedName });
			const completed = SessionManager.open(this.get(input.requestId).path);
			try {
				return completeSessionMutation(completed, mutation, summary) as SessionSummary;
			} finally {
				completed.close();
				await this.refresh();
			}
		});
	}

	prepareDurableMutation(sessionId: string, input: DurableSessionMutation): PreparedSessionMutation {
		const manager = SessionManager.open(this.get(sessionId).path);
		try {
			return prepareSessionMutation(manager, input);
		} finally {
			manager.close();
		}
	}

	completeDurableMutation(sessionId: string, input: DurableSessionMutation, result: unknown): unknown {
		const manager = SessionManager.open(this.get(sessionId).path);
		try {
			return completeSessionMutation(manager, input, result);
		} finally {
			manager.close();
		}
	}

	updateSummary(sessionId: string, update: Partial<SessionSummary>): SessionSummary {
		const ref = this.get(sessionId);
		const { cwd, name, ...merged } = { ...ref.summary, ...update };
		const normalizedName = normalizedSessionName(name);
		const summary: SessionSummary = {
			...merged,
			cwd: cwd && merged.cwdOrigin === "user-selected" ? summaryCwd(cwd) : cwd,
			...(normalizedName === undefined ? {} : { name: normalizedName }),
			sessionId,
			archived: ref.summary.archived,
		};
		this.sessions.set(sessionId, { ...ref, summary });
		return summary;
	}

	renameClosedSession(sessionId: string, value: string): Promise<SessionSummary> {
		return this.mutate(() => {
			const ref = this.get(sessionId);
			if (ref.summary.state === "corrupt") throw new AppServerError("SESSION_CORRUPT", { sessionId });
			if (ref.scheduled) throw new AppServerError("READ_ONLY_SESSION", { sessionId });
			const name = normalizedSessionName(value);
			if (!name) throw new AppServerError("INVALID_REQUEST", { sessionId });
			const manager = SessionManager.open(ref.path);
			try {
				manager.appendSessionInfo(name);
			} finally {
				manager.close();
			}
			return this.updateSummary(sessionId, { name });
		});
	}

	markClosedSessionRead(sessionId: string): Promise<{ readonly session: SessionSummary; readonly changed: boolean }> {
		return this.mutate(() => {
			const ref = this.get(sessionId);
			if (ref.summary.state === "corrupt") throw new AppServerError("SESSION_CORRUPT", { sessionId });
			if (ref.scheduled) throw new AppServerError("READ_ONLY_SESSION", { sessionId });
			if (!ref.summary.unread) return { session: ref.summary, changed: false };
			const manager = SessionManager.open(ref.path);
			try {
				manager.setSessionUnread(false);
			} finally {
				manager.close();
			}
			return { session: this.updateSummary(sessionId, { unread: false }), changed: true };
		});
	}

	removeDeletedSession(sessionId: string, path: string): Promise<void> {
		return this.mutate(() => {
			if (this.sessions.get(sessionId)?.path !== path) return;
			this.sessions.delete(sessionId);
			this.claimedSessionIds.delete(sessionId);
		});
	}

	markCorrupt(sessionId: string): void {
		const ref = this.get(sessionId);
		this.sessions.set(sessionId, {
			...ref,
			summary: {
				...ref.summary,
				state: "corrupt",
				recoveryNotice: "Session journal could not be opened safely.",
			},
		});
	}

	archive(sessionId: string, requestId: string): Promise<SessionSummary> {
		return this.move(sessionId, requestId, true);
	}

	unarchive(sessionId: string, requestId: string): Promise<SessionSummary> {
		return this.move(sessionId, requestId, false);
	}

	private move(sessionId: string, requestId: string, archived: boolean): Promise<SessionSummary> {
		return this.mutate(async () => {
			let ref = this.get(sessionId);
			if (!ref.scheduled && ref.summary.cwdOrigin === "user-selected" && ref.summary.cwd) {
				const key = projectKey(ref.summary.mode, canonicalProjectCwd(ref.summary.cwd));
				if (this.blockedProjectKeys.has(key)) throw new AppServerError("BUSY", { sessionId });
			}
			const mutation: DurableSessionMutation = {
				method: archived ? "session/archive" : "session/unarchive",
				kind: archived ? "session_archive" : "session_unarchive",
				requestId,
				params: { sessionId },
			};
			const prepared = this.prepareDurableMutation(sessionId, mutation);
			if (prepared.state === "completed") return prepared.result as SessionSummary;
			if (ref.summary.archived === archived) {
				return this.completeDurableMutation(sessionId, mutation, ref.summary) as SessionSummary;
			}
			const destination = join(archived ? this.archiveRoot : this.sessionsRoot, ref.relativePath);
			const expectedRoot = archived ? this.archiveRoot : this.sessionsRoot;
			if (!isInside(expectedRoot, destination)) throw new AppServerError("OPERATION_FAILED", { sessionId });
			try {
				moveSessionFileWithLease(ref.path, destination);
			} catch (error) {
				if (errorCode(error) === "EEXIST") throw new AppServerError("SESSION_IN_USE", { sessionId });
				if (error instanceof Error && error.name === "SessionLeaseError") {
					throw new AppServerError("SESSION_IN_USE", { sessionId });
				}
				throw new AppServerError("OPERATION_FAILED", { sessionId });
			}
			await this.refresh();
			ref = this.get(sessionId);
			return this.completeDurableMutation(sessionId, mutation, ref.summary) as SessionSummary;
		});
	}
}
