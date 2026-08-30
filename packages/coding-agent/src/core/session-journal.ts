import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	constants as fsConstants,
	fstatSync,
	ftruncateSync,
	lstatSync,
	openSync,
	readdirSync,
	readSync,
	realpathSync,
	renameSync,
	rmSync,
} from "node:fs";
import { dirname, join, parse } from "node:path";
import { TextDecoder } from "node:util";
import {
	ensureDirectoryDurablySync,
	ensureRealDirectoryDurablySync,
	syncDirectorySync,
	syncFileSync,
	writeAllSync,
} from "./durable-file.ts";

export type JournalRecovery =
	| { status: "clean" }
	| { status: "tail_repaired"; artifactPath: string; discardedBytes: number }
	| { status: "tail_incomplete"; discardedBytes: number };

export interface SessionJournalReadResult<T> {
	records: T[];
	recovery: JournalRecovery;
}

export interface SessionJournalReadOptions {
	repairTail?: boolean;
	/** Return the complete prefix without mutating an incomplete final record. */
	allowIncompleteTail?: boolean;
}

export interface SessionJournalReplaceOptions {
	/** Retain the previous canonical journal under a durable, tagged backup. */
	backupTag?: string;
}

export interface SessionJournal<T = unknown> {
	append(record: T): void;
	readStrict(options?: SessionJournalReadOptions): SessionJournalReadResult<T>;
	replaceAtomically(records: readonly T[], options?: SessionJournalReplaceOptions): void;
	close(): void;
}

type Serializer<T> = (record: T) => string;
type Reviver = (this: unknown, key: string, value: unknown) => unknown;
type MutationGuard = <R>(mutation: () => R) => R;

export interface SessionJournalHooks {
	syncFile?: (fd: number) => void;
	syncDirectory?: (directory: string) => void;
	rename?: (source: string, destination: string) => void;
}

export interface OpenSessionJournalOptions<T> {
	/** Create the canonical journal with exclusive-create semantics. */
	create?: boolean;
	/** Open without writer fencing, replacement recovery, or tail repair. */
	readOnly?: boolean;
	/** Preserve the exact final path entry instead of resolving a symlink alias. */
	followSymlinkAlias?: boolean;
	/** Records published together with a newly created journal. */
	initialRecords?: readonly T[];
	serializer?: Serializer<T>;
	reviver?: Reviver;
	/** Maximum encoded bytes accepted for one JSONL record. */
	maxRecordBytes?: number;
	/** Validate complete recovery candidates before any artifact is promoted or deleted. */
	validateRecords?: (records: readonly T[]) => void;
	hooks?: SessionJournalHooks;
	/** Optional writer-lease fence around every filesystem mutation. */
	runExclusiveMutation?: MutationGuard;
}

export class CorruptSessionError extends Error {
	readonly filePath: string;
	readonly lineNumber: number;

	constructor(filePath: string, lineNumber: number, message: string, options?: ErrorOptions) {
		super(`${message} (${filePath}:${lineNumber})`, options);
		this.name = "CorruptSessionError";
		this.filePath = filePath;
		this.lineNumber = lineNumber;
	}
}

export class SessionJournalPoisonedError extends Error {
	constructor(filePath: string, cause: unknown) {
		super(`Session journal is poisoned after a failed mutation: ${filePath}`, { cause });
		this.name = "SessionJournalPoisonedError";
	}
}

const defaultSerializer = (record: unknown): string => JSON.stringify(record);
const immediateMutation: MutationGuard = (mutation) => mutation();
const DEFAULT_MAX_RECORD_BYTES = 64 * 1024 * 1024;
const READ_BUFFER_BYTES = 64 * 1024;
const fatalUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function getMaxRecordBytes(value: number | undefined): number {
	const maximum = value ?? DEFAULT_MAX_RECORD_BYTES;
	if (!Number.isSafeInteger(maximum) || maximum < 1) {
		throw new RangeError("maxRecordBytes must be a positive safe integer");
	}
	return maximum;
}

function serializeRecord<T>(record: T, serializer: Serializer<T>, maxRecordBytes: number): string {
	const serialized = serializer(record);
	if (typeof serialized !== "string" || serialized.length === 0 || /[\r\n]/.test(serialized)) {
		throw new TypeError("Session journal serializer must return one non-empty line");
	}
	if (Buffer.byteLength(serialized, "utf8") > maxRecordBytes) {
		throw new RangeError(`Session journal record exceeds ${maxRecordBytes} byte limit`);
	}
	return serialized;
}

function closeQuietly(fd: number | undefined): void {
	if (fd === undefined) return;
	try {
		closeSync(fd);
	} catch {
		// Preserve the mutation error that made cleanup necessary.
	}
}

interface ReplacementArtifact {
	path: string;
	modifiedAt: number;
	size: number;
	retained: boolean;
	device: number;
	inode: number;
}

interface FileIdentity {
	device: number;
	inode: number;
	size: number;
	modifiedAt: number;
}

interface ReadSnapshot {
	fd: number;
	size: number;
}

class SessionJournalIdentityError extends Error {
	constructor(path: string) {
		super(`Session journal identity changed after open: ${path}`);
		this.name = "SessionJournalIdentityError";
	}
}

function inspectReplacementArtifact(path: string, filePath: string): Omit<ReplacementArtifact, "retained"> {
	const stats = lstatSync(path);
	if (!stats.isFile() || stats.nlink !== 1) {
		throw new Error(`Unsafe session replacement artifact for ${filePath}: ${path}`);
	}
	return {
		path,
		modifiedAt: stats.mtimeMs,
		size: stats.size,
		device: stats.dev,
		inode: stats.ino,
	};
}

function assertArtifactUnchanged(artifact: ReplacementArtifact, path = artifact.path): void {
	const current = lstatSync(path);
	if (
		!current.isFile() ||
		current.nlink !== 1 ||
		current.dev !== artifact.device ||
		current.ino !== artifact.inode ||
		current.size !== artifact.size ||
		current.mtimeMs !== artifact.modifiedAt
	) {
		throw new Error(`Session replacement artifact changed during recovery: ${artifact.path}`);
	}
}

function assertPublishedArtifact(
	artifact: ReplacementArtifact,
	filePath: string,
	rename: (source: string, destination: string) => void,
	syncDirectory: (directory: string) => void,
): void {
	try {
		assertArtifactUnchanged(artifact, filePath);
	} catch (error) {
		// Never leave a raced symlink/non-regular artifact at the canonical path,
		// where a later ordinary open could follow it. Preserve the path entry
		// itself for diagnosis without reading or writing through it.
		try {
			const quarantinePath = join(
				dirname(filePath),
				`.${parse(filePath).base}.${Date.now()}-${randomUUID()}.unsafe-replacement`,
			);
			rename(filePath, quarantinePath);
			syncDirectory(dirname(filePath));
		} catch {
			// Preserve the original verification failure.
		}
		throw error;
	}
}

function openRegularFile(path: string, flags: number, mode = 0o600, expected?: FileIdentity): number {
	let before: ReturnType<typeof lstatSync> | undefined;
	try {
		before = lstatSync(path);
		if (!before.isFile() || before.nlink !== 1) {
			throw new Error(`Session journal is not a single-link regular file: ${path}`);
		}
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code !== "ENOENT" || (flags & fsConstants.O_CREAT) === 0) throw error;
	}

	const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
	const nonBlock = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
	const fd = openSync(path, flags | noFollow | nonBlock, mode);
	try {
		const opened = fstatSync(fd);
		const current = lstatSync(path);
		if (
			!opened.isFile() ||
			opened.nlink !== 1 ||
			!current.isFile() ||
			current.nlink !== 1 ||
			(before && (before.dev !== opened.dev || before.ino !== opened.ino)) ||
			opened.dev !== current.dev ||
			opened.ino !== current.ino
		) {
			// A hard-linked journal could be opened through two different paths. Each
			// path would get a different sibling lease while both writers mutate the
			// same inode, so single-link identity is part of the writer invariant.
			throw new Error(`Session journal is not a single-link regular file: ${path}`);
		}
		if (
			expected &&
			(opened.dev !== expected.device ||
				opened.ino !== expected.inode ||
				opened.size !== expected.size ||
				opened.mtimeMs !== expected.modifiedAt)
		) {
			throw new SessionJournalIdentityError(path);
		}
		return fd;
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

function readFileIdentity(path: string, flags: number): FileIdentity {
	let fd: number | undefined;
	try {
		fd = openRegularFile(path, flags);
		const stats = fstatSync(fd);
		return { device: stats.dev, inode: stats.ino, size: stats.size, modifiedAt: stats.mtimeMs };
	} finally {
		closeQuietly(fd);
	}
}

function openReadSnapshot(path: string): { identity: FileIdentity; snapshot: ReadSnapshot } {
	let fd: number | undefined;
	try {
		fd = openRegularFile(path, fsConstants.O_RDONLY);
		const stats = fstatSync(fd);
		return {
			identity: { device: stats.dev, inode: stats.ino, size: stats.size, modifiedAt: stats.mtimeMs },
			snapshot: { fd, size: stats.size },
		};
	} catch (error) {
		closeQuietly(fd);
		throw error;
	}
}

function createJournalFile(path: string, data: string, hooks: SessionJournalHooks | undefined): FileIdentity {
	let fd: number | undefined;
	let identity: FileIdentity | undefined;
	try {
		fd = openRegularFile(path, fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR);
		writeAllSync(fd, Buffer.from(data, "utf8"));
		(hooks?.syncFile ?? syncFileSync)(fd);
		const stats = fstatSync(fd);
		identity = { device: stats.dev, inode: stats.ino, size: stats.size, modifiedAt: stats.mtimeMs };
	} finally {
		closeQuietly(fd);
	}
	try {
		(hooks?.syncDirectory ?? syncDirectorySync)(dirname(path));
	} catch (error) {
		// Creating the directory entry is the publication point. A directory fsync
		// can report failure after that publication; if the exact file we created is
		// still canonical, returning failure would make a retry create a duplicate
		// session while leaving this one visible.
		let published: FileIdentity;
		try {
			published = readFileIdentity(path, fsConstants.O_RDONLY);
		} catch (verificationError) {
			throw new AggregateError([error, verificationError], `Failed to verify created session journal: ${path}`);
		}
		if (
			published.device !== identity.device ||
			published.inode !== identity.inode ||
			published.size !== identity.size ||
			published.modifiedAt !== identity.modifiedAt
		) {
			throw new AggregateError(
				[error, new SessionJournalIdentityError(path)],
				`Created session journal changed while confirming publication: ${path}`,
			);
		}
	}
	return identity;
}

function validateJsonlFile<T = unknown>(
	path: string,
	maxRecordBytes: number,
	allowEmpty = true,
	reviver?: Reviver,
	validateRecords?: (records: readonly T[]) => void,
): CorruptSessionError | undefined {
	const pending: Buffer[] = [];
	const records: T[] | undefined = validateRecords ? [] : undefined;
	let pendingBytes = 0;
	let totalBytes = 0;
	let lineNumber = 1;
	const readBuffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
	let fd: number | undefined;
	try {
		fd = openRegularFile(path, fsConstants.O_RDONLY);
		while (true) {
			const bytesRead = readSync(fd, readBuffer, 0, readBuffer.byteLength, null);
			if (bytesRead === 0) break;
			totalBytes += bytesRead;
			const chunk = readBuffer.subarray(0, bytesRead);
			let segmentStart = 0;
			let lineEnd = chunk.indexOf(0x0a, segmentStart);
			while (lineEnd !== -1) {
				const segment = chunk.subarray(segmentStart, lineEnd);
				const lineBytes = pendingBytes + segment.byteLength;
				if (lineBytes > maxRecordBytes) {
					throw new CorruptSessionError(path, lineNumber, `Journal record exceeds ${maxRecordBytes} byte limit`);
				}
				const line = pendingBytes === 0 ? segment : Buffer.concat([...pending, segment], lineBytes);
				let decoded: string;
				try {
					decoded = fatalUtf8Decoder.decode(line);
				} catch (error) {
					throw new CorruptSessionError(path, lineNumber, "Journal record is not valid UTF-8", { cause: error });
				}
				if (decoded.trim().length === 0) {
					throw new CorruptSessionError(path, lineNumber, "Journal contains an empty complete record");
				}
				try {
					const record = JSON.parse(decoded, reviver) as T;
					records?.push(record);
				} catch (error) {
					throw new CorruptSessionError(path, lineNumber, "Malformed complete journal record", { cause: error });
				}
				pending.length = 0;
				pendingBytes = 0;
				lineNumber++;
				segmentStart = lineEnd + 1;
				lineEnd = chunk.indexOf(0x0a, segmentStart);
			}

			const remainder = chunk.subarray(segmentStart);
			if (remainder.byteLength > 0) {
				const lineBytes = pendingBytes + remainder.byteLength;
				if (lineBytes > maxRecordBytes) {
					throw new CorruptSessionError(path, lineNumber, `Journal record exceeds ${maxRecordBytes} byte limit`);
				}
				pending.push(Buffer.from(remainder));
				pendingBytes = lineBytes;
			}
		}
		if (pendingBytes > 0) {
			throw new CorruptSessionError(path, lineNumber, "Journal has an incomplete final record");
		}
		if (!allowEmpty && totalBytes === 0) {
			throw new CorruptSessionError(path, 1, "Replacement temp is empty");
		}
		if (validateRecords) {
			try {
				validateRecords(records ?? []);
			} catch (error) {
				throw new CorruptSessionError(path, 1, "Journal records failed recovery validation", { cause: error });
			}
		}
		return undefined;
	} catch (error) {
		if (error instanceof CorruptSessionError) return error;
		throw error;
	} finally {
		closeQuietly(fd);
	}
}

function validateReplacementArtifact<T>(
	artifact: ReplacementArtifact,
	maxRecordBytes: number,
	allowEmpty: boolean,
	reviver: Reviver | undefined,
	validateRecords: ((records: readonly T[]) => void) | undefined,
): CorruptSessionError | undefined {
	assertArtifactUnchanged(artifact);
	const error = validateJsonlFile(artifact.path, maxRecordBytes, allowEmpty, reviver, validateRecords);
	assertArtifactUnchanged(artifact);
	return error;
}

function cleanupCommittedArtifacts(
	artifacts: { temporary: ReplacementArtifact[]; backups: ReplacementArtifact[] },
	directory: string,
	syncDirectory: (directory: string) => void,
): void {
	for (const artifact of artifacts.temporary) rmSync(artifact.path, { force: true });
	for (const artifact of artifacts.backups) {
		if (!artifact.retained) rmSync(artifact.path, { force: true });
	}
	syncDirectory(directory);
}

function quarantineInvalidArtifact(
	artifact: ReplacementArtifact,
	filePath: string,
	rename: (source: string, destination: string) => void,
	syncDirectory: (directory: string) => void,
): string {
	assertArtifactUnchanged(artifact);
	const quarantinePath = join(
		dirname(filePath),
		`.${parse(filePath).base}.${Date.now()}-${randomUUID()}.invalid-replacement`,
	);
	rename(artifact.path, quarantinePath);
	assertArtifactUnchanged(artifact, quarantinePath);
	syncDirectory(dirname(filePath));
	return quarantinePath;
}

function copyBackupToCanonical(
	artifact: ReplacementArtifact,
	filePath: string,
	hooks: SessionJournalHooks | undefined,
): void {
	const directory = dirname(filePath);
	const rename = hooks?.rename ?? renameSync;
	const syncDirectory = hooks?.syncDirectory ?? syncDirectorySync;
	const syncFile = hooks?.syncFile ?? syncFileSync;
	const temporaryPath = join(directory, `.${parse(filePath).base}.recovery-copy-${randomUUID()}.replace.tmp`);
	const buffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
	let sourceFd: number | undefined;
	let destinationFd: number | undefined;
	try {
		assertArtifactUnchanged(artifact);
		sourceFd = openRegularFile(artifact.path, fsConstants.O_RDONLY);
		destinationFd = openSync(temporaryPath, "wx", 0o600);
		while (true) {
			const bytesRead = readSync(sourceFd, buffer, 0, buffer.byteLength, null);
			if (bytesRead === 0) break;
			writeAllSync(destinationFd, buffer.subarray(0, bytesRead));
		}
		syncFile(destinationFd);
		closeSync(destinationFd);
		destinationFd = undefined;
		closeSync(sourceFd);
		sourceFd = undefined;
		assertArtifactUnchanged(artifact);
		syncDirectory(directory);
		rename(temporaryPath, filePath);
		syncDirectory(directory);
	} finally {
		closeQuietly(destinationFd);
		closeQuietly(sourceFd);
		rmSync(temporaryPath, { force: true });
	}
}

const REPLACEMENT_TRANSACTION_ID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const REPLACEMENT_TEMP_TRANSACTION = new RegExp(
	`^(?:${REPLACEMENT_TRANSACTION_ID}|recovery-copy-${REPLACEMENT_TRANSACTION_ID})$`,
);
const REPLACEMENT_BACKUP_TRANSACTION = new RegExp(
	`^(?:${REPLACEMENT_TRANSACTION_ID}|keep-[A-Za-z0-9][A-Za-z0-9._-]*\\.${REPLACEMENT_TRANSACTION_ID})$`,
);

function replacementArtifacts(filePath: string): { temporary: ReplacementArtifact[]; backups: ReplacementArtifact[] } {
	const directory = dirname(filePath);
	if (!existsSync(directory)) return { temporary: [], backups: [] };
	const prefix = `.${parse(filePath).base}.`;
	const temporarySuffix = ".replace.tmp";
	const backupSuffix = ".replace.bak";
	const temporary: ReplacementArtifact[] = [];
	const backups: ReplacementArtifact[] = [];
	for (const name of readdirSync(directory)) {
		if (!name.startsWith(prefix)) continue;
		const isTemporary = name.endsWith(temporarySuffix);
		const isBackup = name.endsWith(backupSuffix);
		if (!isTemporary && !isBackup) continue;
		const transaction = name.slice(
			prefix.length,
			name.length - (isTemporary ? temporarySuffix.length : backupSuffix.length),
		);
		if (
			(isTemporary && !REPLACEMENT_TEMP_TRANSACTION.test(transaction)) ||
			(isBackup && !REPLACEMENT_BACKUP_TRANSACTION.test(transaction))
		) {
			continue;
		}
		const path = join(directory, name);
		const artifact: ReplacementArtifact = {
			...inspectReplacementArtifact(path, filePath),
			retained: isBackup && transaction.startsWith("keep-"),
		};
		(isTemporary ? temporary : backups).push(artifact);
	}
	return { temporary, backups };
}

/** Enumerate only artifacts produced by the journal and lease recovery grammars. */
export function getOwnedSessionJournalArtifacts(filePath: string): readonly string[] {
	const resolvedPath = join(dirname(filePath), parse(filePath).base);
	const replacements = replacementArtifacts(resolvedPath);
	const result = [...replacements.temporary, ...replacements.backups].map((artifact) => artifact.path);
	const recoveryDirectory = join(dirname(resolvedPath), ".recovery");
	if (!existsSync(recoveryDirectory)) return result.sort();
	const recoveryStats = lstatSync(recoveryDirectory);
	if (!recoveryStats.isDirectory() || recoveryStats.isSymbolicLink()) {
		throw new Error(`Unsafe session recovery directory: ${recoveryDirectory}`);
	}

	const tailPrefix = `${parse(resolvedPath).name}-`;
	const leasePrefix = `${parse(resolvedPath).base}.`;
	for (const name of readdirSync(recoveryDirectory).sort()) {
		const tailTransaction =
			name.startsWith(tailPrefix) && name.endsWith(".partial")
				? name.slice(tailPrefix.length, -".partial".length)
				: undefined;
		const leaseSuffix = [".reclaim.json", ".force-claim.json", ".lease"].find((suffix) => name.endsWith(suffix));
		const leaseTransaction =
			leaseSuffix && name.startsWith(leasePrefix) ? name.slice(leasePrefix.length, -leaseSuffix.length) : undefined;
		const validTail =
			tailTransaction !== undefined &&
			/^\d+-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(tailTransaction);
		const validLease =
			leaseTransaction !== undefined && /^\d+\.[A-Za-z0-9._-]+$/.test(leaseTransaction) && leaseSuffix !== undefined;
		if (!validTail && !validLease) continue;
		const path = join(recoveryDirectory, name);
		const metadata = lstatSync(path);
		if (leaseSuffix === ".lease") {
			if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
				throw new Error(`Unsafe session lease recovery artifact: ${path}`);
			}
		} else if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
			throw new Error(`Unsafe session recovery artifact: ${path}`);
		}
		result.push(path);
	}
	return result.sort();
}

function latestArtifact(artifacts: ReplacementArtifact[]): ReplacementArtifact | undefined {
	return artifacts.sort((left, right) => right.modifiedAt - left.modifiedAt || right.path.localeCompare(left.path))[0];
}

function recoverInterruptedReplacement<T>(
	filePath: string,
	hooks: SessionJournalHooks | undefined,
	maxRecordBytes: number,
	reviver: Reviver | undefined,
	validateRecords: ((records: readonly T[]) => void) | undefined,
): void {
	const directory = dirname(filePath);
	const rename = hooks?.rename ?? renameSync;
	const syncDirectory = hooks?.syncDirectory ?? syncDirectorySync;
	const artifacts = replacementArtifacts(filePath);
	if (existsSync(filePath)) {
		const transientBackups = artifacts.backups.filter((artifact) => !artifact.retained);
		if (artifacts.temporary.length === 0 && transientBackups.length === 0) return;
		// A corrupt canonical is not evidence that an interrupted replacement
		// committed. Preserve every recovery candidate for an explicit decision.
		if (validateJsonlFile(filePath, maxRecordBytes, true, reviver, validateRecords)) return;
		cleanupCommittedArtifacts(artifacts, directory, syncDirectory);
		return;
	}

	const temporary = latestArtifact([...artifacts.temporary]);
	const temporaryError = temporary
		? validateReplacementArtifact(temporary, maxRecordBytes, false, reviver, validateRecords)
		: undefined;
	if (temporary && !temporaryError) {
		assertArtifactUnchanged(temporary);
		rename(temporary.path, filePath);
		assertPublishedArtifact(temporary, filePath, rename, syncDirectory);
		const publishedError = validateJsonlFile(filePath, maxRecordBytes, true, reviver, validateRecords);
		if (publishedError) throw publishedError;
		cleanupCommittedArtifacts(artifacts, directory, syncDirectory);
		return;
	}

	const backup = [...artifacts.backups]
		.sort((left, right) => right.modifiedAt - left.modifiedAt || right.path.localeCompare(left.path))
		.find((artifact) => !validateReplacementArtifact(artifact, maxRecordBytes, true, reviver, validateRecords));
	if (backup) {
		if (temporary && temporaryError) quarantineInvalidArtifact(temporary, filePath, rename, syncDirectory);
		// Copy rather than consume the last known-good backup. It is removed only
		// after the copied canonical has itself passed strict validation.
		copyBackupToCanonical(backup, filePath, hooks);
		const publishedError = validateJsonlFile(filePath, maxRecordBytes, true, reviver, validateRecords);
		if (publishedError) throw publishedError;
		cleanupCommittedArtifacts(artifacts, directory, syncDirectory);
		return;
	}

	if (temporaryError) throw temporaryError;
	const invalidBackup = latestArtifact([...artifacts.backups]);
	if (invalidBackup) {
		const backupError = validateReplacementArtifact(invalidBackup, maxRecordBytes, true, reviver, validateRecords);
		if (backupError) throw backupError;
	}
}

class FileSessionJournal<T> implements SessionJournal<T> {
	private readonly filePath: string;
	private readonly displayPath: string;
	private identity: FileIdentity;
	private readonly serializer: Serializer<T>;
	private readonly reviver: Reviver | undefined;
	private readonly maxRecordBytes: number;
	private readonly syncFile: (fd: number) => void;
	private readonly syncDirectory: (directory: string) => void;
	private readonly rename: (source: string, destination: string) => void;
	private readonly runExclusiveMutation: MutationGuard;
	private readonly readOnly: boolean;
	private readSnapshot: ReadSnapshot | undefined;
	private closed = false;
	private poisoned = false;
	private poisonCause: unknown;

	constructor(
		filePath: string,
		options: OpenSessionJournalOptions<T>,
		identity: FileIdentity,
		displayPath = filePath,
		readSnapshot?: ReadSnapshot,
	) {
		this.filePath = filePath;
		this.displayPath = displayPath;
		this.identity = identity;
		this.serializer = options.serializer ?? (defaultSerializer as Serializer<T>);
		this.reviver = options.reviver;
		this.maxRecordBytes = getMaxRecordBytes(options.maxRecordBytes);
		this.syncFile = options.hooks?.syncFile ?? syncFileSync;
		this.syncDirectory = options.hooks?.syncDirectory ?? syncDirectorySync;
		this.rename = options.hooks?.rename ?? renameSync;
		this.runExclusiveMutation = options.runExclusiveMutation ?? immediateMutation;
		this.readOnly = options.readOnly ?? false;
		this.readSnapshot = readSnapshot;
	}

	append(record: T): void {
		this.assertUsable();
		this.assertWritable("append");
		this.mutate(() => {
			const data = Buffer.from(`${serializeRecord(record, this.serializer, this.maxRecordBytes)}\n`, "utf8");
			let fd: number | undefined;
			try {
				fd = openRegularFile(this.filePath, fsConstants.O_APPEND | fsConstants.O_WRONLY, 0o600, this.identity);
				writeAllSync(fd, data);
				this.syncFile(fd);
				const stats = fstatSync(fd);
				this.identity = {
					device: stats.dev,
					inode: stats.ino,
					size: stats.size,
					modifiedAt: stats.mtimeMs,
				};
			} finally {
				closeQuietly(fd);
			}
		});
	}

	readStrict(options: SessionJournalReadOptions = {}): SessionJournalReadResult<T> {
		this.assertUsable();
		let records: T[];
		let partial: Buffer;
		let completeEnd: number;
		try {
			({ records, partial, completeEnd } = this.readRecords());
		} catch (error) {
			if (!this.readOnly && (error instanceof CorruptSessionError || error instanceof SessionJournalIdentityError)) {
				this.poisoned = true;
				this.poisonCause = error;
			}
			throw error;
		}
		if (partial.byteLength === 0) return { records, recovery: { status: "clean" } };
		if (options.allowIncompleteTail) {
			if (!this.readOnly) {
				const error = new CorruptSessionError(
					this.displayPath,
					records.length + 1,
					"Journal has an incomplete final record",
				);
				this.poisoned = true;
				this.poisonCause = error;
			}
			return {
				records,
				recovery: { status: "tail_incomplete", discardedBytes: partial.byteLength },
			};
		}
		if (this.readOnly || options.repairTail === false) {
			const error = new CorruptSessionError(
				this.displayPath,
				records.length + 1,
				"Journal has an incomplete final record",
			);
			if (!this.readOnly) {
				this.poisoned = true;
				this.poisonCause = error;
			}
			throw error;
		}

		const artifactPath = this.mutate(() => this.repairTail(partial, completeEnd, records.length + 1));
		return {
			records,
			recovery: { status: "tail_repaired", artifactPath, discardedBytes: partial.byteLength },
		};
	}

	replaceAtomically(records: readonly T[], options: SessionJournalReplaceOptions = {}): void {
		this.assertUsable();
		this.assertWritable("replace records in");
		this.mutate(() => {
			if (options.backupTag !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(options.backupTag)) {
				throw new TypeError("Session journal backupTag contains unsupported characters");
			}
			const lines = records.map((record) => serializeRecord(record, this.serializer, this.maxRecordBytes));
			const data = Buffer.from(lines.length === 0 ? "" : `${lines.join("\n")}\n`, "utf8");
			this.replace(data, options.backupTag);
		});
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		closeQuietly(this.readSnapshot?.fd);
		this.readSnapshot = undefined;
	}

	private assertUsable(): void {
		if (this.closed) throw new Error(`Session journal is closed: ${this.displayPath}`);
		if (this.poisoned) {
			throw new SessionJournalPoisonedError(this.displayPath, this.poisonCause);
		}
	}

	private assertWritable(action: string): void {
		if (this.readOnly) throw new Error(`Cannot ${action} a read-only session journal: ${this.filePath}`);
	}

	private mutate<R>(mutation: () => R): R {
		try {
			return this.runExclusiveMutation(mutation);
		} catch (error) {
			this.poisoned = true;
			this.poisonCause = error;
			throw error;
		}
	}

	private readRecords(): { records: T[]; partial: Buffer; completeEnd: number } {
		const records: T[] = [];
		const pending: Buffer[] = [];
		let pendingBytes = 0;
		let totalBytes = 0;
		let lineNumber = 1;
		const readBuffer = Buffer.allocUnsafe(READ_BUFFER_BYTES);
		const snapshot = this.readSnapshot;
		const fd = snapshot?.fd ?? openRegularFile(this.filePath, fsConstants.O_RDONLY, 0o600, this.identity);
		try {
			while (true) {
				const remaining = snapshot ? snapshot.size - totalBytes : readBuffer.byteLength;
				if (remaining <= 0) break;
				const bytesRead = readSync(
					fd,
					readBuffer,
					0,
					Math.min(readBuffer.byteLength, remaining),
					snapshot ? totalBytes : null,
				);
				if (bytesRead === 0) break;
				totalBytes += bytesRead;
				const chunk = readBuffer.subarray(0, bytesRead);
				let segmentStart = 0;
				let lineEnd = chunk.indexOf(0x0a, segmentStart);
				while (lineEnd !== -1) {
					const segment = chunk.subarray(segmentStart, lineEnd);
					this.assertRecordSize(pendingBytes + segment.byteLength, lineNumber);
					const line =
						pendingBytes === 0 ? segment : Buffer.concat([...pending, segment], pendingBytes + segment.length);
					records.push(this.parseRecord(line, lineNumber));
					pending.length = 0;
					pendingBytes = 0;
					lineNumber++;
					segmentStart = lineEnd + 1;
					lineEnd = chunk.indexOf(0x0a, segmentStart);
				}

				const remainder = chunk.subarray(segmentStart);
				if (remainder.byteLength > 0) {
					this.assertRecordSize(pendingBytes + remainder.byteLength, lineNumber);
					pending.push(Buffer.from(remainder));
					pendingBytes += remainder.byteLength;
				}
			}
		} finally {
			if (!snapshot) closeQuietly(fd);
		}

		return {
			records,
			partial: pendingBytes === 0 ? Buffer.alloc(0) : Buffer.concat(pending, pendingBytes),
			completeEnd: totalBytes - pendingBytes,
		};
	}

	private assertRecordSize(byteLength: number, lineNumber: number): void {
		if (byteLength <= this.maxRecordBytes) return;
		throw new CorruptSessionError(
			this.displayPath,
			lineNumber,
			`Journal record exceeds ${this.maxRecordBytes} byte limit`,
		);
	}

	private parseRecord(bytes: Buffer, lineNumber: number): T {
		let line: string;
		try {
			line = fatalUtf8Decoder.decode(bytes);
		} catch (error) {
			throw new CorruptSessionError(this.displayPath, lineNumber, "Journal record is not valid UTF-8", {
				cause: error,
			});
		}
		if (line.trim().length === 0) {
			throw new CorruptSessionError(this.displayPath, lineNumber, "Journal contains an empty complete record");
		}
		try {
			return JSON.parse(line, this.reviver) as T;
		} catch (error) {
			throw new CorruptSessionError(this.displayPath, lineNumber, "Malformed complete journal record", {
				cause: error,
			});
		}
	}

	private repairTail(partial: Buffer, truncateAt: number, lineNumber: number): string {
		const recoveryDirectory = join(dirname(this.filePath), ".recovery");
		ensureRealDirectoryDurablySync(recoveryDirectory);
		const artifactPath = join(
			recoveryDirectory,
			`${parse(this.filePath).name}-${Date.now()}-${randomUUID()}.partial`,
		);
		let artifactFd: number | undefined;
		try {
			artifactFd = openSync(artifactPath, "wx", 0o600);
			writeAllSync(artifactFd, partial);
			this.syncFile(artifactFd);
			closeSync(artifactFd);
			artifactFd = undefined;
			this.syncDirectory(recoveryDirectory);
		} catch (error) {
			closeQuietly(artifactFd);
			rmSync(artifactPath, { force: true });
			throw new CorruptSessionError(
				this.displayPath,
				lineNumber,
				"Incomplete final record could not be preserved durably",
				{ cause: error },
			);
		}

		let journalFd: number | undefined;
		try {
			journalFd = openRegularFile(this.filePath, fsConstants.O_RDWR, 0o600, this.identity);
			ftruncateSync(journalFd, truncateAt);
			this.syncFile(journalFd);
			const stats = fstatSync(journalFd);
			this.identity = {
				device: stats.dev,
				inode: stats.ino,
				size: stats.size,
				modifiedAt: stats.mtimeMs,
			};
		} catch (error) {
			throw new CorruptSessionError(this.displayPath, lineNumber, "Incomplete final record could not be repaired", {
				cause: error,
			});
		} finally {
			closeQuietly(journalFd);
		}
		return artifactPath;
	}

	private replace(data: Buffer, backupTag: string | undefined): void {
		const directory = dirname(this.filePath);
		ensureDirectoryDurablySync(directory);
		const transaction = randomUUID();
		const filename = parse(this.filePath).base;
		const temporaryPath = join(directory, `.${filename}.${transaction}.replace.tmp`);
		const backupTransaction = backupTag ? `keep-${backupTag}.${transaction}` : transaction;
		const backupPath = join(directory, `.${filename}.${backupTransaction}.replace.bak`);
		let temporaryFd: number | undefined;
		let originalMoved = false;

		try {
			let identityFd: number | undefined;
			try {
				identityFd = openRegularFile(this.filePath, fsConstants.O_RDONLY, 0o600, this.identity);
			} finally {
				closeQuietly(identityFd);
			}
			temporaryFd = openSync(temporaryPath, "wx", 0o600);
			writeAllSync(temporaryFd, data);
			this.syncFile(temporaryFd);
			closeSync(temporaryFd);
			temporaryFd = undefined;
			this.syncDirectory(directory);

			this.rename(this.filePath, backupPath);
			originalMoved = true;
			this.syncDirectory(directory);
			this.rename(temporaryPath, this.filePath);
			this.syncDirectory(directory);
			this.identity = readFileIdentity(this.filePath, fsConstants.O_RDONLY);
			if (!backupTag) {
				rmSync(backupPath, { force: true });
				this.syncDirectory(directory);
			}
		} catch (error) {
			closeQuietly(temporaryFd);
			if (originalMoved && !existsSync(this.filePath) && existsSync(backupPath)) {
				try {
					this.rename(backupPath, this.filePath);
					this.syncDirectory(directory);
				} catch (rollbackError) {
					throw new AggregateError([error, rollbackError], "Session replacement and rollback both failed");
				}
			}
			throw error;
		} finally {
			closeQuietly(temporaryFd);
			rmSync(temporaryPath, { force: true });
		}
	}
}

export function openSessionJournal<T = unknown>(
	filePath: string,
	options: OpenSessionJournalOptions<T> = {},
): SessionJournal<T> {
	let resolvedFilePath = filePath;
	if (!options.create && options.followSymlinkAlias !== false) {
		try {
			// Existing symlink aliases are supported, but all recovery and mutation
			// operates on the canonical journal rather than the alias itself.
			resolvedFilePath = realpathSync(filePath);
		} catch {
			// A missing canonical may still have an interrupted replacement beside it.
		}
	}
	const directory = dirname(resolvedFilePath);
	if (options.initialRecords && !options.create) {
		throw new TypeError("initialRecords requires create: true");
	}
	if (options.create && options.readOnly) {
		throw new TypeError("create and readOnly cannot be used together");
	}
	const maxRecordBytes = getMaxRecordBytes(options.maxRecordBytes);
	const runExclusiveMutation = options.runExclusiveMutation ?? immediateMutation;
	if (options.create) {
		const serializer = options.serializer ?? (defaultSerializer as Serializer<T>);
		const identity = runExclusiveMutation(() => {
			ensureDirectoryDurablySync(directory);
			const lines = (options.initialRecords ?? []).map((record) =>
				serializeRecord(record, serializer, maxRecordBytes),
			);
			return createJournalFile(resolvedFilePath, lines.length === 0 ? "" : `${lines.join("\n")}\n`, options.hooks);
		});
		return new FileSessionJournal(resolvedFilePath, options, identity, filePath);
	}
	if (options.readOnly) {
		const { identity, snapshot } = openReadSnapshot(resolvedFilePath);
		try {
			return new FileSessionJournal(resolvedFilePath, options, identity, filePath, snapshot);
		} catch (error) {
			closeQuietly(snapshot.fd);
			throw error;
		}
	}
	const identity = runExclusiveMutation(() => {
		recoverInterruptedReplacement(
			resolvedFilePath,
			options.hooks,
			maxRecordBytes,
			options.reviver,
			options.validateRecords,
		);
		return readFileIdentity(resolvedFilePath, fsConstants.O_RDWR);
	});
	return new FileSessionJournal(resolvedFilePath, options, identity, filePath);
}
