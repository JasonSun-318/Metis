import { createHash } from "node:crypto";
import { type Dir, constants as fsConstants } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	type AgentMode,
	type ClientParams,
	type ClientResult,
	type CwdOrigin,
	MAX_NAME_UTF16_UNITS,
	type SessionSummary,
} from "@arcmind/app-protocol";
import {
	assertValidSessionId,
	CURRENT_SESSION_VERSION,
	getDefaultSessionDir,
	getOwnedManagedWorkspace,
	moveSessionFileWithLease,
	removeOwnedManagedWorkspace,
	resolveNewSessionWorkspace,
	type ScheduleRun,
	SessionManager,
} from "@arcmind/coding-agent";
import {
	completeSessionMutation,
	type DurableSessionMutation,
	type PreparedSessionMutation,
	prepareSessionMutation,
} from "./durable-mutation.ts";
import { AppServerError, type SessionRef } from "./session-runtime-host.ts";

const MAX_HEADER_BYTES = 64 * 1024;
const DEFAULT_LIST_LIMIT = 50;
const MAX_CATALOG_FILES = 100_000;
const MAX_CONCURRENT_CATALOG_SCANS = 32;

interface ScannedSession {
	readonly key: string;
	readonly path: string;
	readonly relativePath: string;
	readonly archived: boolean;
	readonly header?: {
		readonly id: string;
		readonly timestamp: string;
		readonly cwd: string;
		readonly mode: AgentMode;
		readonly cwdOrigin: CwdOrigin;
		readonly scheduled?: { readonly taskId: string; readonly runId: string };
	};
	readonly updatedAt: string;
}

export interface SessionCatalogOptions {
	readonly agentDir: string;
	readonly sessionsRoot?: string;
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
		recoveryNotice: "Session journal could not be opened safely.",
	};
}

async function readHeader(path: string): Promise<{
	id: string;
	timestamp: string;
	cwd: string;
	mode: AgentMode;
	cwdOrigin: CwdOrigin;
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
		const current = await lstat(path);
		if (
			!current.isFile() ||
			current.nlink !== 1 ||
			current.dev !== opened.dev ||
			current.ino !== opened.ino ||
			current.size !== opened.size ||
			current.mtimeMs !== opened.mtimeMs
		) {
			throw new Error("Session journal changed while reading its header");
		}
		return {
			id: value.id,
			timestamp: value.timestamp,
			cwd: value.cwd,
			mode: value.mode === "chat" || value.mode === "code" ? value.mode : "code",
			cwdOrigin:
				value.cwdOrigin === "managed" || value.cwdOrigin === "user-selected" ? value.cwdOrigin : "user-selected",
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

/** Header-only catalog reconstructed from the session roots. */
export class SessionCatalog {
	readonly agentDir: string;
	readonly sessionsRoot: string;
	readonly archiveRoot: string;
	private sessions = new Map<string, SessionRef>();
	private claimedSessionIds = new Set<string>();
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
			const updatedAt = new Date(stats.mtimeMs).toISOString();
			return { key, path, relativePath, archived, header: await readHeader(path), updatedAt };
		} catch {
			let updatedAt = new Date(0).toISOString();
			try {
				updatedAt = new Date((await lstat(path)).mtimeMs).toISOString();
			} catch {
				// Keep the deterministic epoch fallback for a disappearing file.
			}
			return { key, path, relativePath, archived, updatedAt };
		}
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
							cwd: item.header.cwd || null,
							createdAt: item.header.timestamp,
							updatedAt: item.updatedAt,
							state: "idle" as const,
							archived: item.archived,
							...(item.header.scheduled ? { scheduled: item.header.scheduled } : {}),
						}
					: corruptSummary(sessionId, item);
			next.set(sessionId, {
				path: item.path,
				relativePath: item.relativePath,
				summary,
				...(item.header?.scheduled ? { scheduled: item.header.scheduled } : {}),
			});
		}
		this.sessions = next;
	}

	async registerScheduledRun(run: ScheduleRun): Promise<void> {
		if (!run.sessionId || !run.sessionFile) return;
		const sessionId = run.sessionId;
		const sessionFile = run.sessionFile;
		await this.mutate(async () => {
			try {
				const expectedRoot = await realpath(getDefaultSessionDir(run.snapshot.target.cwd, this.agentDir));
				const expectedCwdOrigin = run.snapshot.target.workspace === "task" ? "managed" : "user-selected";
				const path = resolve(sessionFile);
				const canonicalPath = await realpath(path);
				if (!isInside(expectedRoot, canonicalPath)) throw new Error("Session is outside its task directory");
				const header = await readHeader(path);
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
				const updatedAt = new Date((await lstat(path)).mtimeMs).toISOString();
				this.sessions.set(sessionId, {
					path,
					relativePath: relative(this.agentDir, path),
					scheduled: header.scheduled,
					summary: {
						sessionId,
						mode: header.mode,
						cwdOrigin: header.cwdOrigin,
						cwd: header.cwd || null,
						createdAt: header.timestamp,
						updatedAt,
						state: "idle",
						archived: false,
						scheduled: header.scheduled,
					},
				});
				this.claimedSessionIds.add(sessionId);
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

	private mutate<T>(operation: () => Promise<T>): Promise<T> {
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
			if (index < 0) throw new AppServerError("NOT_FOUND", { sessionId: input.afterSessionId });
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
			const requestedName = normalizedSessionName(input.name);
			const mutation: DurableSessionMutation = {
				method: "session/create",
				kind: "session_create",
				requestId: input.requestId,
				params: {
					...(input.mode === undefined ? {} : { mode: input.mode }),
					...(input.cwd === undefined ? {} : { cwd: input.cwd }),
					...(input.name === undefined ? {} : { name: input.name }),
				},
			};
			const existing = this.sessions.get(input.requestId);
			if (existing?.scheduled) {
				throw new AppServerError("REQUEST_ID_REUSED", { requestId: input.requestId });
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
					if (manager.getMode() !== mode || !workspaceMatches || name !== requestedName) {
						throw new AppServerError("REQUEST_ID_REUSED", { requestId: input.requestId });
					}
					const summary = { ...existing.summary, ...(name === undefined ? {} : { name }) };
					return completeSessionMutation(manager, mutation, summary) as SessionSummary;
				} finally {
					manager.close();
				}
			}
			if (this.claimedSessionIds.has(input.requestId)) {
				throw new AppServerError("REQUEST_ID_REUSED", { requestId: input.requestId });
			}

			const workspace = resolveNewSessionWorkspace({
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
		const { name, ...merged } = { ...ref.summary, ...update };
		const normalizedName = normalizedSessionName(name);
		const summary: SessionSummary = {
			...merged,
			...(normalizedName === undefined ? {} : { name: normalizedName }),
			sessionId,
			archived: ref.summary.archived,
		};
		this.sessions.set(sessionId, { ...ref, summary });
		return summary;
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
