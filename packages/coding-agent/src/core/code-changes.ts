import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { formatPatch, structuredPatch } from "diff";

const execFileAsync = promisify(execFile);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_FILES = 256;
const MAX_SNAPSHOT_BYTES = 16 * 1024 * 1024;
const MAX_PATCH_BYTES = 16 * 1024;
const MAX_STEP_PATCH_BYTES = 64 * 1024;
const MAX_STEP_FILES = 64;
const MAX_STEP_METADATA_BYTES = 16 * 1024;
// Formatted documents and binary assets do not participate in text-line statistics.
const NON_TEXT_FILE =
	/\.(?:png|jpe?g|gif|webp|avif|heic|ico|icns|rsrc|pdf|pptx?|docx?|xlsx?|zip|gz|bz2|xz|7z|rar|woff2?|ttf|otf|mp[34]|mov|wav|flac|sqlite3?|db|dylib|dll|exe|wasm)$/iu;
const SKIP_DIRECTORIES = new Set([".git", ".metis", ".codegraph", "node_modules", ".venv", ".cache"]);

export interface CodeFileChange {
	readonly path: string;
	readonly kind: "added" | "modified" | "deleted";
	readonly additions?: number;
	readonly deletions?: number;
	readonly diff?: string;
	readonly truncated?: boolean;
	readonly binary?: boolean;
	readonly unavailable?: boolean;
}

export interface TrackedCodeChanges {
	readonly version: 1;
	readonly sequence: number;
	readonly files: readonly CodeFileChange[];
	readonly turnFiles?: readonly CodeFileChange[];
	readonly partial: boolean;
	readonly turn: { readonly additions: number; readonly deletions: number; readonly partial: boolean };
}

export interface CodeChangeScope {
	readonly cwd: string;
	readonly paths: readonly string[];
	readonly scanWorkspace?: boolean;
}

type FileSnapshot = {
	readonly signature: string;
	readonly text?: string | null;
	readonly binary?: boolean;
	readonly directory?: boolean;
};
type Repository = { readonly root: string; readonly head?: string };
type Snapshot = {
	readonly files: Map<string, FileSnapshot>;
	readonly repository?: Repository;
	readonly partial: boolean;
};
const MISSING: FileSnapshot = { signature: "missing", text: null };
const UNAVAILABLE: FileSnapshot = { signature: "unavailable" };

function bytesSnapshot(bytes: Buffer): FileSnapshot {
	const signature = createHash("sha256").update(bytes).digest("hex");
	if (bytes.includes(0)) return { signature, binary: true };
	try {
		return { signature, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
	} catch {
		return { signature, binary: true };
	}
}

async function readLocalFile(path: string): Promise<FileSnapshot> {
	try {
		const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		try {
			const stat = await handle.stat();
			if (stat.isDirectory()) return { signature: "directory", directory: true };
			if (!stat.isFile()) return UNAVAILABLE;
			if (stat.size > MAX_FILE_BYTES) return { signature: `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}` };
			const buffer = Buffer.alloc(Math.min(stat.size + 1, MAX_FILE_BYTES + 1));
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			if (bytesRead > MAX_FILE_BYTES) return UNAVAILABLE;
			return bytesSnapshot(buffer.subarray(0, bytesRead));
		} finally {
			await handle.close();
		}
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? MISSING : UNAVAILABLE;
	}
}

async function git(cwd: string, args: string[], maxBuffer = 4 * 1024 * 1024): Promise<Buffer> {
	const result = await execFileAsync("git", ["--literal-pathspecs", ...args], {
		cwd,
		encoding: "buffer",
		timeout: 3000,
		maxBuffer,
		windowsHide: true,
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
	});
	return result.stdout;
}

async function repositoryAt(cwd: string): Promise<Repository | undefined> {
	try {
		const root = (await git(cwd, ["rev-parse", "--show-toplevel"])).toString("utf8").trim();
		let head: string | undefined;
		try {
			head = (await git(root, ["rev-parse", "--verify", "HEAD"])).toString("utf8").trim();
		} catch {
			// A repository with no commits still has tracked and untracked files.
		}
		return { root, head };
	} catch {
		return undefined;
	}
}

async function dirtyPaths(repository: Repository): Promise<string[]> {
	const { root, head } = repository;
	const [changed, untracked] = await Promise.all([
		git(
			root,
			head
				? ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", head, "--"]
				: ["ls-files", "--cached", "-z"],
		),
		git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
	]);
	return [...new Set([...changed.toString("utf8").split("\0"), ...untracked.toString("utf8").split("\0")])]
		.filter(Boolean)
		.map((path) => resolve(root, path));
}

async function readGitFile(repository: Repository, path: string): Promise<FileSnapshot> {
	if (!repository.head) return MISSING;
	const name = relative(repository.root, path).split("\\").join("/");
	if (name.startsWith("../") || isAbsolute(name)) return UNAVAILABLE;
	try {
		return bytesSnapshot(await git(repository.root, ["show", `${repository.head}:${name}`], MAX_FILE_BYTES));
	} catch (error) {
		const stderr = String((error as { stderr?: unknown }).stderr ?? "");
		return /(?:does not exist in|exists on disk, but not in)/u.test(stderr) ? MISSING : UNAVAILABLE;
	}
}

async function directoryPaths(cwd: string): Promise<{ paths: string[]; partial: boolean }> {
	const paths: string[] = [];
	const directories = [cwd];
	const deadline = Date.now() + 1000;
	let partial = false;
	let visited = 0;
	while (
		directories.length > 0 &&
		paths.length < MAX_SNAPSHOT_FILES &&
		visited < MAX_SNAPSHOT_FILES &&
		Date.now() < deadline
	) {
		const directory = directories.pop()!;
		visited += 1;
		try {
			for (const entry of await readdir(directory, { withFileTypes: true })) {
				if (entry.isDirectory() && !SKIP_DIRECTORIES.has(entry.name)) directories.push(join(directory, entry.name));
				else if (entry.isFile() && !NON_TEXT_FILE.test(entry.name)) paths.push(join(directory, entry.name));
				if (paths.length >= MAX_SNAPSHOT_FILES) break;
			}
		} catch {
			partial = true;
		}
	}
	return { paths, partial: partial || directories.length > 0 || paths.length >= MAX_SNAPSHOT_FILES };
}

async function capture(scope: CodeChangeScope, before?: Snapshot): Promise<Snapshot> {
	const files = new Map<string, FileSnapshot>();
	let repository = before?.repository;
	const paths = [...scope.paths.map((path) => resolve(scope.cwd, path)), ...(before?.files.keys() ?? [])];
	let partial = false;
	for (const target of scope.paths) {
		const path = resolve(scope.cwd, target);
		try {
			if (!(await lstat(path)).isDirectory()) continue;
			const directory = await directoryPaths(path);
			paths.push(...directory.paths);
			partial ||= directory.partial;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") partial = true;
		}
	}
	if (scope.scanWorkspace) {
		repository ??= await repositoryAt(scope.cwd);
		try {
			if (repository) paths.push(...(await dirtyPaths(repository)));
			else {
				const directory = await directoryPaths(scope.cwd);
				paths.push(...directory.paths);
				partial ||= directory.partial;
			}
		} catch {
			partial = true;
		}
	}
	const unique = [...new Set(paths)].filter((path) => !NON_TEXT_FILE.test(path));
	partial ||= unique.length > MAX_SNAPSHOT_FILES;
	let size = 0;
	for (const path of unique.slice(0, MAX_SNAPSHOT_FILES)) {
		const file = await readLocalFile(path);
		size += Buffer.byteLength(file.text ?? "", "utf8");
		if (file.text === undefined && !file.binary && !file.directory) partial = true;
		if (size > MAX_SNAPSHOT_BYTES) {
			partial = true;
			break;
		}
		files.set(path, file);
	}
	return { files, repository, partial };
}

function fileChange(path: string, before: FileSnapshot, after: FileSnapshot, patchBudget: number): CodeFileChange {
	const kind = before.text === null ? "added" : after.text === null ? "deleted" : "modified";
	if (before.text === undefined || after.text === undefined) return { path, kind, unavailable: true };
	const patch = structuredPatch(
		before.text === null ? "/dev/null" : `a/${path}`,
		after.text === null ? "/dev/null" : `b/${path}`,
		before.text ?? "",
		after.text ?? "",
		undefined,
		undefined,
		{ context: 3, timeout: 200 },
	);
	if (!patch) return { path, kind, unavailable: true };
	let additions = 0;
	let deletions = 0;
	for (const hunk of patch.hunks) {
		for (const line of hunk.lines) {
			if (line.startsWith("+")) additions += 1;
			if (line.startsWith("-")) deletions += 1;
		}
	}
	const formatted = formatPatch(patch);
	const bytes = Buffer.from(formatted, "utf8");
	const maximum = Math.max(0, Math.min(MAX_PATCH_BYTES, patchBudget));
	let end = Math.min(bytes.length, maximum);
	while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
	return {
		path,
		kind,
		additions,
		deletions,
		diff: bytes.subarray(0, end).toString("utf8"),
		...(end < bytes.length ? { truncated: true } : {}),
	};
}

// Mutating steps in the same workspace share a lane, including child sessions.
// Reads and all Chat-mode tools keep their existing scheduling.
const mutationLanes = new Map<string, Promise<void>>();
async function inMutationLane<T>(cwd: string, task: () => Promise<T>): Promise<T> {
	const previous = mutationLanes.get(cwd) ?? Promise.resolve();
	let release!: () => void;
	const settled = new Promise<void>((resolvePromise) => {
		release = resolvePromise;
	});
	const tail = previous.then(() => settled);
	mutationLanes.set(cwd, tail);
	await previous;
	try {
		return await task();
	} finally {
		release();
		if (mutationLanes.get(cwd) === tail) mutationLanes.delete(cwd);
	}
}

/** Bounded historical diffs; contents used for the net baseline stay in memory only. */
export class CodeChangeTracker {
	private turnId?: string;
	private sequence = 0;
	private readonly baseline = new Map<string, FileSnapshot>();
	private readonly totals = new Map<string, CodeFileChange>();
	private readonly completed = new Map<string, TrackedCodeChanges>();
	private partial = false;
	private baselineBytes = 0;

	async run<T>(turnId: string, toolCallId: string, scope: CodeChangeScope, execute: () => Promise<T>): Promise<T> {
		return inMutationLane(resolve(scope.cwd), async () => {
			if (this.turnId !== turnId) {
				this.turnId = turnId;
				this.sequence = 0;
				this.baseline.clear();
				this.totals.clear();
				this.baselineBytes = 0;
				this.partial = false;
			}
			const before = await capture(scope);
			try {
				return await execute();
			} finally {
				const after = await capture(scope, before);
				await this.record(toolCallId, scope.cwd, before, after);
			}
		});
	}

	take(toolCallId: string): TrackedCodeChanges | undefined {
		const result = this.completed.get(toolCallId);
		this.completed.delete(toolCallId);
		return result;
	}

	private async record(toolCallId: string, cwd: string, before: Snapshot, after: Snapshot): Promise<void> {
		const files: CodeFileChange[] = [];
		let partial = before.partial || after.partial;
		let observedChanges = false;
		let budget = MAX_STEP_PATCH_BYTES;
		for (const [path, current] of after.files) {
			const previous =
				before.files.get(path) ??
				(before.partial ? UNAVAILABLE : before.repository ? await readGitFile(before.repository, path) : MISSING);
			if (previous.directory || current.directory) continue;
			if (previous.signature === current.signature) continue;
			if (previous.binary || current.binary) {
				if (this.totals.delete(path)) observedChanges = true;
				continue;
			}
			observedChanges = true;
			const name = relative(cwd, path).split("\\").join("/");
			const change = fileChange(name, previous, current, budget);
			if (files.length < MAX_STEP_FILES && Buffer.byteLength(name, "utf8") <= 4096) {
				files.push(change);
				budget -= Buffer.byteLength(change.diff ?? "", "utf8");
			} else partial = true;
			if (!this.baseline.has(path)) {
				this.baselineBytes += Buffer.byteLength(previous.text ?? "", "utf8");
				if (this.baseline.size >= MAX_SNAPSHOT_FILES || this.baselineBytes > MAX_SNAPSHOT_BYTES) {
					this.partial = true;
					continue;
				}
				this.baseline.set(path, previous);
			}
			const initial = this.baseline.get(path)!;
			if (initial.signature === current.signature) this.totals.delete(path);
			else
				this.totals.set(
					path,
					initial.signature === previous.signature ? change : fileChange(name, initial, current, 0),
				);
		}
		this.partial ||= partial;
		// Scan limits describe coverage, not evidence that the command changed
		// files. Keep that uncertainty for later real changes in the turn, but
		// do not turn a partial no-op scan into a synthetic file-change event.
		if (!observedChanges) return;
		// History pages contain many results. Bound the whole serialized preview,
		// including escaped text and filenames, without changing the actual counts.
		while (Buffer.byteLength(JSON.stringify(files), "utf8") > MAX_STEP_METADATA_BYTES) {
			const index = files.findIndex((file) => (file.diff?.length ?? 0) > 0);
			if (index >= 0) {
				const file = files[index]!;
				files[index] = {
					...file,
					diff: file.diff!.slice(0, Math.floor(file.diff!.length / 2)).replace(/[\uD800-\uDBFF]$/u, ""),
					truncated: true,
				};
			} else {
				files.pop();
				partial = true;
			}
		}
		let additions = 0;
		let deletions = 0;
		let incomplete = this.partial;
		const turnFiles: CodeFileChange[] = [];
		let summaryBytes = 0;
		for (const change of this.totals.values()) {
			additions += change.additions ?? 0;
			deletions += change.deletions ?? 0;
			incomplete ||= change.additions === undefined || change.deletions === undefined;
			const { diff: _diff, truncated: _truncated, ...summary } = change;
			summaryBytes += Buffer.byteLength(JSON.stringify(summary), "utf8") + 1;
			// Leave room for the 16 KiB step preview inside the projection's 20 KiB result limit.
			if (turnFiles.length < MAX_STEP_FILES && summaryBytes <= 3 * 1024) turnFiles.push(summary);
			else incomplete = true;
		}
		this.completed.set(toolCallId, {
			version: 1,
			sequence: ++this.sequence,
			files,
			turnFiles,
			partial,
			turn: { additions, deletions, partial: incomplete },
		});
	}
}
