import {
	chmodSync,
	closeSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmdirSync,
	unlinkSync,
	writeSync,
} from "fs";
import { homedir } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";

/** Sticky bit. An administrator trash directory is unusable without it. */
const STICKY_BIT = 0o1000;
const TRASH_UNENCODED_BYTE = /[A-Za-z0-9\-._~]/;
const MAX_TRASH_NAME_ATTEMPTS = 1000;

/**
 * Move paths into the Freedesktop Trash directory.
 * The home trash is `$XDG_DATA_HOME/Trash`. A file on another mount is renamed into that
 * mount's `.Trash/$uid` or `.Trash-$uid` directory. A failed attempt leaves the original
 * path in place; files are never copied and then unlinked.
 *
 * Returns the first failure message, or undefined when every path was trashed.
 */
export function trashPathsViaXdg(paths: readonly string[]): string | undefined {
	const mounts = loadMountPoints();
	let failure: string | undefined;
	for (const path of paths) {
		if (path.length === 0) {
			failure ??= "Trash path is empty";
			continue;
		}
		try {
			trashOne(resolve(path), mounts);
		} catch (error) {
			failure ??= error instanceof Error ? error.message : String(error);
		}
	}
	return failure;
}

function trashOne(source: string, mounts: readonly string[]): void {
	// Missing files fail before any trash directory is created.
	lstatSync(source);
	const home = homeTrashDirectory();
	if (mountPointFor(existingAncestor(home), mounts) === mountPointFor(source, mounts)) {
		try {
			moveIntoXdgTrash(source, home);
			return;
		} catch (error) {
			// Mount info can lag a bind mount. Retry the on-volume trash only when
			// the kernel reports that the home trash is a different filesystem.
			if (errorCode(error) !== "EXDEV") throw error;
		}
	}
	const directories = volumeTrashDirectories(mountPointFor(source, mounts));
	if (directories.length === 0) throw new Error("XDG trash is not available on this filesystem");
	let failure: unknown;
	for (const directory of directories) {
		try {
			moveIntoXdgTrash(source, directory);
			return;
		} catch (error) {
			// `.Trash/$uid` can be missing-but-uncreatable (mode 01555) or the
			// rename into it can fail. The spec then requires `.Trash-$uid`.
			// Each attempt is a rename; a failure leaves the original in place.
			failure = error;
		}
	}
	throw failure;
}

function homeTrashDirectory(): string {
	const configured = process.env.XDG_DATA_HOME;
	// Relative XDG paths are invalid and ignored.
	if (configured && isAbsolute(configured)) return join(configured, "Trash");
	return join(homedir(), ".local", "share", "Trash");
}

/**
 * Candidate trash directories on `topdir`, in the order the spec requires.
 * `$topdir/.Trash/$uid` comes first when `.Trash` is a sticky real directory and
 * the per-user directory is absent or is a real directory owned by this user.
 * A symlink or foreign `$uid` directory is skipped. `$topdir/.Trash-$uid` is the
 * next candidate, including when the first directory cannot be created or a
 * rename into it fails.
 */
function volumeTrashDirectories(topdir: string): string[] {
	const uid = process.getuid?.();
	if (uid === undefined) return [];
	const directories: string[] = [];
	if (isStickyRealDirectory(join(topdir, ".Trash"))) {
		const userDir = join(topdir, ".Trash", String(uid));
		if (usableVolumeTrash(userDir)) directories.push(userDir);
	}
	const fallback = join(topdir, `.Trash-${uid}`);
	if (usableVolumeTrash(fallback)) directories.push(fallback);
	return directories;
}

function isStickyRealDirectory(directory: string): boolean {
	try {
		const stats = lstatSync(directory);
		return stats.isDirectory() && !stats.isSymbolicLink() && (stats.mode & STICKY_BIT) !== 0;
	} catch {
		return false;
	}
}

function usableVolumeTrash(directory: string): boolean {
	const uid = process.getuid?.();
	try {
		const stats = lstatSync(directory);
		return stats.isDirectory() && !stats.isSymbolicLink() && (uid === undefined || stats.uid === uid);
	} catch (error) {
		return errorCode(error) === "ENOENT";
	}
}

function moveIntoXdgTrash(source: string, trashDir: string): void {
	const filesDir = join(trashDir, "files");
	const infoDir = join(trashDir, "info");
	ensureOwnedRealDirectory(trashDir);
	ensureOwnedRealDirectory(filesDir);
	ensureOwnedRealDirectory(infoDir);
	const base = basename(source) || "item";
	const directory = lstatSync(source).isDirectory();
	for (let attempt = 1; attempt <= MAX_TRASH_NAME_ATTEMPTS; attempt++) {
		const name = attempt === 1 ? base : `${base}.${attempt}`;
		const infoPath = join(infoDir, `${name}.trashinfo`);
		const destPath = join(filesDir, name);
		try {
			writeExclusiveTrashInfo(infoPath, source);
		} catch (error) {
			if (errorCode(error) === "EEXIST") continue;
			throw error;
		}
		let claimed = false;
		try {
			if (directory) mkdirSync(destPath, { mode: 0o700 });
			else createExclusiveFile(destPath);
			claimed = true;
			// rename replaces the empty claim and fails with EEXIST/ENOTEMPTY instead
			// of overwriting a trashed file. The kernel reports EXDEV across mounts.
			renameSync(source, destPath);
			return;
		} catch (error) {
			removeClaim(infoPath, false);
			if (claimed) removeClaim(destPath, directory);
			if (errorCode(error) === "EEXIST" || errorCode(error) === "ENOTEMPTY") continue;
			throw error;
		}
	}
	throw new Error("Could not allocate a unique name in the XDG trash");
}

function ensureOwnedRealDirectory(directory: string): void {
	let create = false;
	try {
		assertOwnedRealDirectory(directory);
	} catch (error) {
		if (errorCode(error) !== "ENOENT") throw error;
		create = true;
	}
	if (create) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		chmodSync(directory, 0o700);
	}
	assertOwnedRealDirectory(directory);
}

function assertOwnedRealDirectory(directory: string): void {
	const stats = lstatSync(directory);
	const uid = process.getuid?.();
	if (!stats.isDirectory() || stats.isSymbolicLink() || (uid !== undefined && stats.uid !== uid)) {
		throw new Error(`Trash directory is not a private directory: ${directory}`);
	}
}

function writeExclusiveTrashInfo(infoPath: string, source: string): void {
	const fd = openSync(infoPath, "wx", 0o600);
	try {
		const data = Buffer.from(formatTrashInfo(source, new Date()), "utf8");
		let offset = 0;
		while (offset < data.length) offset += writeSync(fd, data, offset);
		fsyncSync(fd);
	} catch (error) {
		closeSync(fd);
		removeClaim(infoPath, false);
		throw error;
	}
	closeSync(fd);
}

function createExclusiveFile(path: string): void {
	closeSync(openSync(path, "wx", 0o600));
}

function removeClaim(path: string, directory: boolean): void {
	try {
		if (directory) rmdirSync(path);
		else unlinkSync(path);
	} catch {
		// The claim belongs to this attempt. A cleanup error must not hide the
		// rename or trashinfo write failure, which decides whether the file moved.
	}
}

function formatTrashInfo(source: string, deletedAt: Date): string {
	return `[Trash Info]\nPath=${encodeTrashPath(source)}\nDeletionDate=${formatDeletionDate(deletedAt)}\n`;
}

function formatDeletionDate(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Percent-encode every byte except RFC 3986 unreserved characters and `/`. */
function encodeTrashPath(absolutePath: string): string {
	return absolutePath
		.split("/")
		.map((part, index) => (index === 0 ? "" : encodeTrashComponent(part)))
		.join("/");
}

function encodeTrashComponent(component: string): string {
	let encoded = "";
	for (const byte of Buffer.from(component, "utf8")) {
		const character = String.fromCharCode(byte);
		encoded += TRASH_UNENCODED_BYTE.test(character)
			? character
			: `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
	}
	return encoded;
}

function existingAncestor(path: string): string {
	let current = resolve(path);
	for (;;) {
		try {
			lstatSync(current);
			return current;
		} catch (error) {
			if (errorCode(error) !== "ENOENT") return current;
			const parent = dirname(current);
			if (parent === current) return current;
			current = parent;
		}
	}
}

function loadMountPoints(): string[] {
	try {
		const points: string[] = [];
		for (const line of readFileSync("/proc/self/mountinfo", "utf8").split("\n")) {
			const point = mountPointFromMountInfoLine(line);
			if (point) points.push(point);
		}
		return points.length > 0 ? points : ["/"];
	} catch {
		return ["/"];
	}
}

function mountPointFromMountInfoLine(line: string): string | undefined {
	if (line.length === 0) return undefined;
	const separator = line.indexOf(" - ");
	const fields = (separator === -1 ? line : line.slice(0, separator)).split(" ");
	const mountPoint = fields[4];
	if (!mountPoint) return undefined;
	return unescapeMountField(mountPoint);
}

function unescapeMountField(value: string): string {
	return value.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function mountPointFor(path: string, mounts: readonly string[]): string {
	const absolute = resolve(path);
	let best = "/";
	let bestLength = 0;
	let bestIndex = -1;
	for (let index = 0; index < mounts.length; index++) {
		const point = mounts[index]!;
		if (!isMountPrefix(absolute, point)) continue;
		if (bestIndex === -1 || point.length > bestLength || (point.length === bestLength && index > bestIndex)) {
			best = point;
			bestLength = point.length;
			bestIndex = index;
		}
	}
	return best;
}

function isMountPrefix(path: string, mountPoint: string): boolean {
	if (mountPoint === "/") return path.startsWith("/");
	return path === mountPoint || path.startsWith(`${mountPoint}/`);
}

function errorCode(error: unknown): string | undefined {
	return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}
