import { randomUUID } from "node:crypto";
import {
	type BigIntStats,
	closeSync,
	existsSync,
	fdatasyncSync,
	constants as fsConstants,
	fstatSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export interface DurableWriteOptions {
	mode?: number;
	flag?: "w" | "wx";
}

export interface SingleLinkFileFingerprint {
	dev: string;
	ino: string;
	size: string;
	mtimeNs: string;
	ctimeNs: string;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: undefined;
}

function publishTemporaryPrefix(path: string): string {
	// Keep the entry identifiable without risking NAME_MAX for a long destination.
	return `.${basename(path).slice(0, 80)}.`;
}

function fingerprint(stats: BigIntStats): SingleLinkFileFingerprint {
	return {
		dev: String(stats.dev),
		ino: String(stats.ino),
		size: String(stats.size),
		mtimeNs: String(stats.mtimeNs),
		ctimeNs: String(stats.ctimeNs),
	};
}

function sameFingerprint(left: SingleLinkFileFingerprint, right: SingleLinkFileFingerprint): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function openSingleLinkFileSync(path: string): { fd: number; fingerprint: SingleLinkFileFingerprint } | undefined {
	let before: BigIntStats;
	try {
		before = lstatSync(path, { bigint: true });
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
	if (!before.isFile() || before.nlink !== 1n) {
		throw new Error(`Refusing to read aliased or non-regular file: ${path}`);
	}

	let fd: number;
	try {
		const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
		const nonBlocking = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
		fd = openSync(path, fsConstants.O_RDONLY | noFollow | nonBlocking);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}

	try {
		const opened = fstatSync(fd, { bigint: true });
		const current = lstatSync(path, { bigint: true });
		const beforeFingerprint = fingerprint(before);
		const openedFingerprint = fingerprint(opened);
		const currentFingerprint = fingerprint(current);
		if (
			!opened.isFile() ||
			opened.nlink !== 1n ||
			!current.isFile() ||
			current.nlink !== 1n ||
			!sameFingerprint(beforeFingerprint, openedFingerprint) ||
			!sameFingerprint(openedFingerprint, currentFingerprint)
		) {
			throw new Error(`Refusing to read aliased, replaced, or changing file: ${path}`);
		}
		return { fd, fingerprint: openedFingerprint };
	} catch (error) {
		closeSync(fd);
		throw error;
	}
}

function assertOpenFileUnchanged(path: string, fd: number, expected: SingleLinkFileFingerprint): void {
	const opened = fstatSync(fd, { bigint: true });
	const current = lstatSync(path, { bigint: true });
	if (
		!opened.isFile() ||
		opened.nlink !== 1n ||
		!current.isFile() ||
		current.nlink !== 1n ||
		!sameFingerprint(fingerprint(opened), expected) ||
		!sameFingerprint(fingerprint(current), expected)
	) {
		throw new Error(`Refusing to read aliased, replaced, or changing file: ${path}`);
	}
}

/** Snapshot stable metadata for a single-link regular file without following the final path component. */
export function readSingleLinkFileFingerprintSync(path: string): SingleLinkFileFingerprint | undefined {
	const opened = openSingleLinkFileSync(path);
	if (!opened) return undefined;
	try {
		assertOpenFileUnchanged(path, opened.fd, opened.fingerprint);
		return opened.fingerprint;
	} finally {
		closeSync(opened.fd);
	}
}

/** Read a single-link regular file without following the final path component. */
export function readSingleLinkTextFileSync(path: string, options: { maxBytes?: number } = {}): string | undefined {
	const { maxBytes } = options;
	if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
		throw new TypeError("maxBytes must be a non-negative safe integer");
	}
	const opened = openSingleLinkFileSync(path);
	if (!opened) return undefined;
	try {
		let contents: string;
		if (maxBytes === undefined) {
			contents = readFileSync(opened.fd, "utf8");
		} else {
			if (BigInt(opened.fingerprint.size) > BigInt(maxBytes)) {
				throw new Error(`Refusing to read oversized file: ${path}`);
			}
			const bytes = Buffer.alloc(maxBytes + 1);
			let offset = 0;
			while (offset < bytes.byteLength) {
				const count = readSync(opened.fd, bytes, offset, bytes.byteLength - offset, null);
				if (count === 0) break;
				offset += count;
			}
			if (offset > maxBytes) throw new Error(`Refusing to read oversized file: ${path}`);
			contents = bytes.subarray(0, offset).toString("utf8");
		}
		assertOpenFileUnchanged(path, opened.fd, opened.fingerprint);
		return contents;
	} finally {
		closeSync(opened.fd);
	}
}

/** Write the complete buffer even when the underlying filesystem performs a short write. */
export function writeAllSync(fd: number, data: Uint8Array): void {
	let offset = 0;
	while (offset < data.byteLength) {
		const written = writeSync(fd, data, offset, data.byteLength - offset);
		if (written <= 0) {
			throw new Error("Filesystem returned a zero-length write");
		}
		offset += written;
	}
}

/** Sync file contents before a mutation is acknowledged. */
export function syncFileSync(fd: number): void {
	try {
		fdatasyncSync(fd);
	} catch (error) {
		const code = errorCode(error);
		if (code !== "ENOSYS" && code !== "ENOTSUP" && code !== "EINVAL") throw error;
		fsyncSync(fd);
	}
}

/**
 * Sync directory metadata after create/rename operations.
 *
 * Windows does not expose a portable directory-fsync primitive through Node.
 * The file itself is still synced and rename remains atomic there.
 */
export function syncDirectorySync(directory: string): void {
	let fd: number | undefined;
	try {
		fd = openSync(directory, "r");
		fsyncSync(fd);
	} catch (error) {
		const code = errorCode(error);
		if (
			process.platform !== "win32" ||
			(code !== "EACCES" && code !== "EINVAL" && code !== "EISDIR" && code !== "ENOTSUP" && code !== "EPERM")
		) {
			throw error;
		}
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

/** Create missing directory levels and sync each new parent entry. */
export function ensureDirectoryDurablySync(directory: string, mode = 0o700): void {
	if (existsSync(directory)) return;
	const parent = dirname(directory);
	if (parent !== directory) ensureDirectoryDurablySync(parent, mode);
	try {
		mkdirSync(directory, { mode });
	} catch (error) {
		if (errorCode(error) !== "EEXIST") throw error;
	}
	if (parent !== directory) syncDirectorySync(parent);
}

/** Create a sensitive directory, but never accept the final path as a symlink. */
export function ensureRealDirectoryDurablySync(directory: string, mode = 0o700): void {
	ensureDirectoryDurablySync(directory, mode);
	const stats = lstatSync(directory);
	if (!stats.isDirectory()) throw new Error(`Durable directory path is not a real directory: ${directory}`);
}

/** Create or truncate a file, write it completely, sync it, then sync its directory. */
export function writeFileDurablySync(path: string, data: string | Uint8Array, options: DurableWriteOptions = {}): void {
	const directory = dirname(path);
	ensureDirectoryDurablySync(directory);
	const fd = openSync(path, options.flag ?? "w", options.mode ?? 0o600);
	try {
		writeAllSync(fd, typeof data === "string" ? Buffer.from(data, "utf8") : data);
		syncFileSync(fd);
	} finally {
		closeSync(fd);
	}
	syncDirectorySync(directory);
}

/** Write and sync a sibling temp file, then atomically replace the destination. */
export function replaceFileAtomicallySync(
	path: string,
	data: string | Uint8Array,
	options: Omit<DurableWriteOptions, "flag"> = {},
): void {
	const directory = dirname(path);
	ensureDirectoryDurablySync(directory);
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	try {
		writeFileDurablySync(temporary, data, { flag: "wx", mode: options.mode });
		renameSync(temporary, path);
		syncDirectorySync(directory);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export function cleanupPublishedAliasesSync(path: string): void {
	const directory = dirname(path);
	let destination: ReturnType<typeof lstatSync>;
	try {
		destination = lstatSync(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return;
		throw error;
	}
	if (!destination.isFile() || destination.nlink <= 1) return;
	const prefix = publishTemporaryPrefix(path);
	const suffix = ".publish.tmp";
	let cleaned = false;
	for (const name of readdirSync(directory)) {
		if (!name.startsWith(prefix) || !name.endsWith(suffix)) continue;
		const publishId = name.slice(prefix.length, -suffix.length);
		if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(publishId)) continue;
		const temporary = join(directory, name);
		try {
			const candidate = lstatSync(temporary);
			if (!candidate.isFile() || candidate.dev !== destination.dev || candidate.ino !== destination.ino) continue;
			unlinkSync(temporary);
			cleaned = true;
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
	}
	if (cleaned) syncDirectorySync(directory);
}

/**
 * Publish a fully synced file without ever exposing a partially written destination.
 * A same-directory hard link provides the `wx`-style collision guarantee at publish time.
 */
export function createFileAtomicallySync(
	path: string,
	data: string | Uint8Array,
	options: Omit<DurableWriteOptions, "flag"> = {},
): void {
	const directory = dirname(path);
	ensureDirectoryDurablySync(directory);
	cleanupPublishedAliasesSync(path);
	const temporary = join(directory, `${publishTemporaryPrefix(path)}${randomUUID()}.publish.tmp`);
	let published = false;
	try {
		writeFileDurablySync(temporary, data, { flag: "wx", mode: options.mode });
		linkSync(temporary, path);
		published = true;
		syncDirectorySync(directory);
	} finally {
		rmSync(temporary, { force: true });
		if (published) syncDirectorySync(directory);
	}
}
