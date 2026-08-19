import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import type { Stats } from "node:fs";
import {
	lstat,
	mkdir,
	readdir,
	readFile as readFileBuffer,
	realpath,
	rename,
	rm,
	stat,
	writeFile as writeFileBuffer,
} from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, sep } from "node:path";
import type {
	DesktopOpenWorkspaceFileInput,
	DesktopPreviewFile,
	DesktopWorkspaceEntry,
	DesktopWorkspaceFile,
	DesktopWorkspaceMutationInput,
	DesktopWorkspaceMutationResult,
	DesktopWorkspaceReviewCommit,
	DesktopWorkspaceReviewFile,
	DesktopWorkspaceReviewFileContext,
	DesktopWorkspaceReviewFileDiff,
	DesktopWorkspaceReviewFileInput,
	DesktopWorkspaceReviewFileStatus,
	DesktopWorkspaceReviewInput,
	DesktopWorkspaceReviewRevision,
	DesktopWorkspaceReviewSnapshot,
	DesktopWorkspaceSearchInput,
	DesktopWorkspaceTarget,
	DesktopWriteWorkspaceFileInput,
	DesktopWriteWorkspaceFileResult,
} from "../shared/desktop-api.ts";
import { PREVIEW_MAX_BYTES } from "../shared/desktop-api.ts";

const TEXT_LIMIT = 2 * 1024 * 1024;
const IMAGE_LIMIT = 10 * 1024 * 1024;
const SEARCH_LIMIT = 200;
const STDERR_LIMIT = 8 * 1024;
const SEARCH_INDEX_TTL_MS = 5_000;
const REVIEW_METADATA_LIMIT = 1024 * 1024;
const REVIEW_PATCH_LIMIT = 4 * 1024 * 1024;
const REVIEW_CONTEXT_LIMIT = 4 * 1024 * 1024;
const REVIEW_COMMIT_LIMIT = 20;
const NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";
const FULL_GIT_OBJECT_ID = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/u;

const IMAGE_TYPES = new Map<string, "image/png" | "image/jpeg" | "image/gif" | "image/webp">([
	[".png", "image/png"],
	[".jpg", "image/jpeg"],
	[".jpeg", "image/jpeg"],
	[".gif", "image/gif"],
	[".webp", "image/webp"],
]);

const DOC_BINARY_TYPES = new Map<string, string>([
	[".pdf", "application/pdf"],
	[".docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
	[".doc", "application/msword"],
	[".xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
	[".xls", "application/vnd.ms-excel"],
	[".pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
	[".ppt", "application/vnd.ms-powerpoint"],
]);
const DOC_LIMIT = 50 * 1024 * 1024;

function contentRevision(contents: Uint8Array): string {
	return createHash("sha256").update(contents).digest("hex");
}

interface WorkspaceFileManagerOptions {
	readonly rgCommand: string;
	readonly rgArgsPrefix?: readonly string[];
	readonly openPath: (path: string) => Promise<string>;
	readonly showItemInFolder: (path: string) => void;
	readonly trashItem: (path: string) => Promise<void>;
}

function isInside(root: string, target: string): boolean {
	const child = relative(root, target);
	return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function searchPath(value: string): string | null {
	const normalized = value.replaceAll("\\", "/");
	if (
		normalized.length === 0 ||
		normalized.startsWith("/") ||
		/^[A-Za-z]:\//u.test(normalized) ||
		normalized.split("/").some((part) => part === "" || part === "." || part === "..")
	)
		return null;
	return normalized;
}

class GitCommandError extends Error {
	readonly exitCode: number | null;
	readonly stderr: string;

	constructor(exitCode: number | null, stderr: string) {
		super(stderr.trim() || `git exited with code ${String(exitCode)}`);
		this.name = "GitCommandError";
		this.exitCode = exitCode;
		this.stderr = stderr;
	}
}

class ReviewOutputTooLargeError extends Error {}

interface GitStatusEntry {
	readonly relativePath: string;
	readonly previousRelativePath: string | null;
	readonly status: DesktopWorkspaceReviewFileStatus;
}

interface GitNumstatEntry {
	readonly relativePath: string;
	readonly previousRelativePath: string | null;
	readonly additions: number | null;
	readonly deletions: number | null;
	readonly binary: boolean;
}

function reviewStatus(value: string): DesktopWorkspaceReviewFileStatus {
	if (value === "??") return "untracked";
	if (value.includes("R")) return "renamed";
	if (value.includes("C")) return "copied";
	if (value.includes("D")) return "deleted";
	if (value.includes("A")) return "added";
	return "modified";
}

function parsePorcelainStatus(value: string): readonly GitStatusEntry[] {
	const records = value.split("\0");
	const entries: GitStatusEntry[] = [];
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (!record) continue;
		if (record.length < 4 || record[2] !== " ") throw new Error("Invalid Git status output");
		const code = record.slice(0, 2);
		const relativePath = record.slice(3);
		const renamed = code.includes("R") || code.includes("C");
		const previousRelativePath = renamed ? records[++index] : null;
		if (renamed && !previousRelativePath) throw new Error("Invalid Git rename output");
		entries.push({
			relativePath,
			previousRelativePath: previousRelativePath ?? null,
			status: reviewStatus(code),
		});
	}
	return entries;
}

function parseNameStatus(value: string): readonly GitStatusEntry[] {
	const records = value.split("\0");
	const entries: GitStatusEntry[] = [];
	for (let index = 0; index < records.length; ) {
		const code = records[index++];
		if (!code) continue;
		const status = reviewStatus(code);
		if (status === "renamed" || status === "copied") {
			const previousRelativePath = records[index++];
			const relativePath = records[index++];
			if (!previousRelativePath || !relativePath) throw new Error("Invalid Git rename output");
			entries.push({ relativePath, previousRelativePath, status });
			continue;
		}
		const relativePath = records[index++];
		if (!relativePath) throw new Error("Invalid Git name-status output");
		entries.push({ relativePath, previousRelativePath: null, status });
	}
	return entries;
}

function parseNumstat(value: string): ReadonlyMap<string, GitNumstatEntry> {
	const records = value.split("\0");
	const entries = new Map<string, GitNumstatEntry>();
	for (let index = 0; index < records.length; ) {
		const record = records[index++];
		if (!record) continue;
		const firstTab = record.indexOf("\t");
		const secondTab = record.indexOf("\t", firstTab + 1);
		if (firstTab < 0 || secondTab < 0) throw new Error("Invalid Git numstat output");
		const additionsValue = record.slice(0, firstTab);
		const deletionsValue = record.slice(firstTab + 1, secondTab);
		const inlinePath = record.slice(secondTab + 1);
		const previousRelativePath = inlinePath === "" ? records[index++] : null;
		const relativePath = inlinePath === "" ? records[index++] : inlinePath;
		if (!relativePath || (inlinePath === "" && !previousRelativePath)) {
			throw new Error("Invalid Git numstat path output");
		}
		const binary = additionsValue === "-" || deletionsValue === "-";
		entries.set(relativePath, {
			relativePath,
			previousRelativePath: previousRelativePath ?? null,
			additions: binary ? null : Number.parseInt(additionsValue, 10),
			deletions: binary ? null : Number.parseInt(deletionsValue, 10),
			binary,
		});
	}
	return entries;
}

function parseCommits(value: string): readonly DesktopWorkspaceReviewCommit[] {
	const fields = value.split("\0");
	if (fields.at(-1) === "") fields.pop();
	if (fields.length % 5 !== 0) throw new Error("Invalid Git log output");
	const commits: DesktopWorkspaceReviewCommit[] = [];
	for (let index = 0; index < fields.length; index += 5) {
		const hash = fields[index]!.trimStart();
		if (!FULL_GIT_OBJECT_ID.test(hash)) throw new Error("Invalid Git log object id");
		commits.push({
			hash,
			shortHash: fields[index + 1]!,
			authorName: fields[index + 2]!,
			authoredAt: fields[index + 3]!,
			subject: fields[index + 4]!,
		});
	}
	return commits;
}

function assertReviewRevision(value: DesktopWorkspaceReviewRevision): void {
	if (value !== "working-tree" && !FULL_GIT_OBJECT_ID.test(value)) {
		throw new TypeError("Invalid workspace review revision");
	}
}

function lineCount(contents: Uint8Array): number {
	if (contents.length === 0) return 0;
	let lines = contents.at(-1) === 10 ? 0 : 1;
	for (const value of contents) if (value === 10) lines += 1;
	return lines;
}

function isBinary(contents: Uint8Array): boolean {
	return contents.includes(0);
}

export function resolveDesktopRipgrepPath(input: { readonly appPath: string; readonly isPackaged: boolean }): string {
	const name = process.platform === "win32" ? "rg.exe" : "rg";
	if (!input.isPackaged || (process.platform !== "darwin" && process.platform !== "win32")) return name;
	const unpackedRoot = input.appPath.endsWith("app.asar") ? `${input.appPath}.unpacked` : input.appPath;
	return join(unpackedRoot, ".webpack", "main", "native-tools", name);
}

export class WorkspaceFileManager {
	private readonly roots = new Map<string, string>();
	private readonly searchIndexes = new Map<
		string,
		{
			readonly root: string;
			readonly promise: Promise<readonly string[]>;
			child?: ReturnType<typeof spawn>;
			loadedAt: number;
			invalidated: boolean;
		}
	>();
	private readonly rgCommand: string;
	private readonly rgArgsPrefix: readonly string[];
	private readonly openPath: (path: string) => Promise<string>;
	private readonly showItemInFolder: (path: string) => void;
	private readonly trashItem: (path: string) => Promise<void>;

	constructor(options: WorkspaceFileManagerOptions) {
		this.rgCommand = options.rgCommand;
		this.rgArgsPrefix = options.rgArgsPrefix ?? [];
		this.openPath = options.openPath;
		this.showItemInFolder = options.showItemInFolder;
		this.trashItem = options.trashItem;
	}

	authorize(sessionId: string, cwd: string): void {
		this.invalidateSearchIndex(sessionId);
		this.roots.set(sessionId, cwd);
	}

	revoke(sessionId: string): void {
		this.invalidateSearchIndex(sessionId);
		this.roots.delete(sessionId);
	}

	clear(): void {
		for (const sessionId of this.searchIndexes.keys()) this.invalidateSearchIndex(sessionId);
		this.roots.clear();
	}

	async listDirectory(input: DesktopWorkspaceTarget): Promise<readonly DesktopWorkspaceEntry[]> {
		const { path } = await this.target(input);
		const entries = await readdir(path, { withFileTypes: true });
		return entries
			.flatMap((entry): DesktopWorkspaceEntry[] => {
				const kind = entry.isDirectory()
					? "directory"
					: entry.isFile()
						? "file"
						: entry.isSymbolicLink()
							? "symlink"
							: null;
				if (!kind) return [];
				return [
					{
						name: entry.name,
						relativePath: input.relativePath ? `${input.relativePath}/${entry.name}` : entry.name,
						kind,
					},
				];
			})
			.sort((left, right) => {
				const kindOrder = Number(left.kind !== "directory") - Number(right.kind !== "directory");
				return kindOrder || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
			});
	}

	async search(input: DesktopWorkspaceSearchInput): Promise<readonly string[]> {
		const query = input.query.toLocaleLowerCase();
		const files = await this.indexFiles(input.sessionId);
		const matches: string[] = [];
		for (const path of files) {
			if (!path.toLocaleLowerCase().includes(query)) continue;
			matches.push(path);
			if (matches.length === SEARCH_LIMIT) break;
		}
		return matches;
	}

	async getReview(input: DesktopWorkspaceReviewInput): Promise<DesktopWorkspaceReviewSnapshot> {
		assertReviewRevision(input.revision);
		const authorizedRoot = await this.root(input.sessionId);
		const repositoryRoot = await this.repositoryRoot(authorizedRoot);
		if (repositoryRoot === null) return { kind: "not-repository" };
		const head = await this.readHead(repositoryRoot);
		const [branch, commits, files] = await Promise.all([
			this.readBranch(repositoryRoot),
			head === null ? Promise.resolve([]) : this.readCommits(repositoryRoot),
			input.revision === "working-tree"
				? this.readWorkingTreeFiles(repositoryRoot, head)
				: this.readCommitFiles(repositoryRoot, input.revision),
		]);
		return {
			kind: "review",
			repositoryRoot,
			branch,
			head,
			revision: input.revision,
			files,
			commits,
		};
	}

	async getReviewFileDiff(input: DesktopWorkspaceReviewFileInput): Promise<DesktopWorkspaceReviewFileDiff> {
		assertReviewRevision(input.revision);
		const relativePath = searchPath(input.relativePath);
		if (relativePath === null || relativePath !== input.relativePath) {
			throw new TypeError("Invalid workspace review path");
		}
		const authorizedRoot = await this.root(input.sessionId);
		const repositoryRoot = await this.repositoryRoot(authorizedRoot);
		if (repositoryRoot === null) throw new Error("Workspace is not a Git repository");
		try {
			if (input.revision === "working-tree") {
				return await this.readWorkingTreeDiff(input.sessionId, repositoryRoot, relativePath);
			}
			const patch = await this.runGit(
				repositoryRoot,
				[
					"show",
					"--format=",
					"--no-ext-diff",
					"--no-color",
					"--find-renames",
					"--unified=3",
					input.revision,
					"--",
					relativePath,
				],
				REVIEW_PATCH_LIMIT,
			);
			return this.classifyPatch(patch);
		} catch (cause) {
			if (cause instanceof ReviewOutputTooLargeError) return { kind: "too-large" };
			throw cause;
		}
	}

	async getReviewFileContext(input: DesktopWorkspaceReviewFileInput): Promise<DesktopWorkspaceReviewFileContext> {
		assertReviewRevision(input.revision);
		const relativePath = searchPath(input.relativePath);
		if (relativePath === null || relativePath !== input.relativePath) {
			throw new TypeError("Invalid workspace review path");
		}
		const authorizedRoot = await this.root(input.sessionId);
		const repositoryRoot = await this.repositoryRoot(authorizedRoot);
		if (repositoryRoot === null) throw new Error("Workspace is not a Git repository");
		try {
			if (input.revision === "working-tree") {
				return await this.readWorkingTreeContext(repositoryRoot, relativePath);
			}
			const entry = (await this.readCommitFiles(repositoryRoot, input.revision)).find(
				(candidate) => candidate.relativePath === relativePath,
			);
			if (!entry || !["modified", "renamed", "copied"].includes(entry.status)) {
				throw new Error("Workspace review context is unavailable for this file");
			}
			const oldPath = entry.previousRelativePath ?? entry.relativePath;
			const [oldContents, newContents] = await Promise.all([
				this.runGitBuffer(repositoryRoot, ["show", `${input.revision}^:${oldPath}`], REVIEW_CONTEXT_LIMIT),
				this.runGitBuffer(
					repositoryRoot,
					["show", `${input.revision}:${entry.relativePath}`],
					REVIEW_CONTEXT_LIMIT,
				),
			]);
			return this.reviewContext(
				oldPath,
				oldContents,
				`old:${input.revision}^:${oldPath}`,
				entry.relativePath,
				newContents,
				`new:${input.revision}:${entry.relativePath}`,
			);
		} catch (cause) {
			if (cause instanceof ReviewOutputTooLargeError) return { kind: "unavailable", reason: "too-large" };
			throw cause;
		}
	}

	private async repositoryRoot(authorizedRoot: string): Promise<string | null> {
		let value: string;
		try {
			value = await this.runGit(authorizedRoot, ["rev-parse", "--show-toplevel"], REVIEW_METADATA_LIMIT);
		} catch (cause) {
			if (cause instanceof GitCommandError && /not a git repository/u.test(cause.stderr)) return null;
			throw cause;
		}
		const repositoryRoot = await realpath(value.trim());
		if (!isInside(authorizedRoot, repositoryRoot)) {
			throw new Error("Git repository escapes the authorized workspace root");
		}
		return repositoryRoot;
	}

	private async readHead(repositoryRoot: string): Promise<string | null> {
		const value = await this.runGit(
			repositoryRoot,
			["rev-parse", "--verify", "--quiet", "HEAD"],
			REVIEW_METADATA_LIMIT,
			[0, 1],
		);
		const head = value.trim();
		return head === "" ? null : head;
	}

	private async readBranch(repositoryRoot: string): Promise<string> {
		const value = await this.runGit(
			repositoryRoot,
			["symbolic-ref", "--quiet", "--short", "HEAD"],
			REVIEW_METADATA_LIMIT,
			[0, 1],
		);
		return value.trim() || "HEAD";
	}

	private async readCommits(repositoryRoot: string): Promise<readonly DesktopWorkspaceReviewCommit[]> {
		return parseCommits(
			await this.runGit(
				repositoryRoot,
				["log", `-${REVIEW_COMMIT_LIMIT}`, "--date=iso-strict", "--pretty=format:%H%x00%h%x00%an%x00%aI%x00%s%x00"],
				REVIEW_METADATA_LIMIT,
			),
		);
	}

	private async readWorkingTreeFiles(
		repositoryRoot: string,
		head: string | null,
	): Promise<readonly DesktopWorkspaceReviewFile[]> {
		const [statusValue, numstatValue] = await Promise.all([
			this.runGit(
				repositoryRoot,
				["status", "--porcelain=v1", "-z", "--untracked-files=all"],
				REVIEW_METADATA_LIMIT,
			),
			this.runGit(
				repositoryRoot,
				head === null
					? ["diff", "--cached", "--numstat", "-z", "--find-renames", "--"]
					: ["diff", "--numstat", "-z", "--find-renames", "HEAD", "--"],
				REVIEW_METADATA_LIMIT,
			),
		]);
		const numstats = parseNumstat(numstatValue);
		const statusEntries = parsePorcelainStatus(statusValue);
		const files = new Array<DesktopWorkspaceReviewFile>(statusEntries.length);
		let cursor = 0;
		await Promise.all(
			Array.from({ length: Math.min(4, statusEntries.length) }, async () => {
				while (cursor < statusEntries.length) {
					const index = cursor++;
					const entry = statusEntries[index]!;
					const numstat = numstats.get(entry.relativePath);
					const currentFile =
						entry.status === "untracked" || (head === null && entry.status === "added")
							? await this.inspectWorkingFile(repositoryRoot, entry.relativePath)
							: null;
					files[index] = {
						relativePath: entry.relativePath,
						previousRelativePath: entry.previousRelativePath ?? numstat?.previousRelativePath ?? null,
						status: entry.status,
						additions: currentFile?.additions ?? numstat?.additions ?? null,
						deletions: currentFile?.deletions ?? numstat?.deletions ?? null,
						binary: currentFile?.binary ?? numstat?.binary ?? false,
					};
				}
			}),
		);
		return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
	}

	private async readCommitFiles(
		repositoryRoot: string,
		revision: string,
	): Promise<readonly DesktopWorkspaceReviewFile[]> {
		const [statusValue, numstatValue] = await Promise.all([
			this.runGit(
				repositoryRoot,
				["diff-tree", "--root", "--no-commit-id", "-r", "-z", "-M", "--name-status", revision],
				REVIEW_METADATA_LIMIT,
			),
			this.runGit(
				repositoryRoot,
				["diff-tree", "--root", "--no-commit-id", "-r", "-z", "-M", "--numstat", revision],
				REVIEW_METADATA_LIMIT,
			),
		]);
		const numstats = parseNumstat(numstatValue);
		return parseNameStatus(statusValue)
			.map((entry): DesktopWorkspaceReviewFile => {
				const numstat = numstats.get(entry.relativePath);
				return {
					...entry,
					previousRelativePath: entry.previousRelativePath ?? numstat?.previousRelativePath ?? null,
					additions: numstat?.additions ?? null,
					deletions: numstat?.deletions ?? null,
					binary: numstat?.binary ?? false,
				};
			})
			.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
	}

	private async inspectWorkingFile(
		repositoryRoot: string,
		relativePath: string,
	): Promise<{ readonly additions: number | null; readonly deletions: 0; readonly binary: boolean } | null> {
		const path = join(repositoryRoot, ...relativePath.split("/"));
		let metadata: Stats;
		try {
			metadata = await lstat(path);
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw cause;
		}
		if (!metadata.isFile() || metadata.isSymbolicLink()) return null;
		const canonical = await realpath(path);
		if (!isInside(repositoryRoot, canonical)) throw new Error("Workspace path escapes the authorized root");
		if (metadata.size > TEXT_LIMIT) return { additions: null, deletions: 0, binary: false };
		const contents = await readFileBuffer(canonical);
		const binary = isBinary(contents);
		return { additions: binary ? null : lineCount(contents), deletions: 0, binary };
	}

	private async readWorkingTreeDiff(
		sessionId: string,
		repositoryRoot: string,
		relativePath: string,
	): Promise<DesktopWorkspaceReviewFileDiff> {
		const status = parsePorcelainStatus(
			await this.runGit(
				repositoryRoot,
				["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", relativePath],
				REVIEW_METADATA_LIMIT,
			),
		).find((entry) => entry.relativePath === relativePath);
		const head = await this.readHead(repositoryRoot);
		if (status?.status === "untracked" || (head === null && status?.status === "added")) {
			const entry = await this.existingEntry(sessionId, relativePath);
			if (entry.kind !== "file") throw new Error("Workspace review target is not a file");
			const metadata = await stat(entry.path);
			if (metadata.size > REVIEW_PATCH_LIMIT) return { kind: "too-large" };
			const contents = await readFileBuffer(entry.path);
			if (isBinary(contents)) return { kind: "binary" };
			const patch = await this.runGit(
				repositoryRoot,
				["diff", "--no-index", "--no-color", "--unified=3", "--", NULL_DEVICE, entry.path],
				REVIEW_PATCH_LIMIT,
				[0, 1],
			);
			return { kind: "text", patch };
		}
		const patch = await this.runGit(
			repositoryRoot,
			head === null
				? ["diff", "--cached", "--no-ext-diff", "--no-color", "--unified=3", "--", relativePath]
				: ["diff", "--no-ext-diff", "--no-color", "--find-renames", "--unified=3", "HEAD", "--", relativePath],
			REVIEW_PATCH_LIMIT,
		);
		return this.classifyPatch(patch);
	}

	private async readWorkingTreeContext(
		repositoryRoot: string,
		relativePath: string,
	): Promise<DesktopWorkspaceReviewFileContext> {
		const status = parsePorcelainStatus(
			await this.runGit(
				repositoryRoot,
				["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", relativePath],
				REVIEW_METADATA_LIMIT,
			),
		).find((entry) => entry.relativePath === relativePath);
		if (!status || !["modified", "renamed", "copied"].includes(status.status)) {
			throw new Error("Workspace review context is unavailable for this file");
		}
		const head = await this.readHead(repositoryRoot);
		if (head === null) throw new Error("Workspace review context requires a Git HEAD");
		const path = join(repositoryRoot, ...relativePath.split("/"));
		const metadata = await lstat(path);
		if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error("Workspace review target is not a file");
		if (metadata.size > REVIEW_CONTEXT_LIMIT) return { kind: "unavailable", reason: "too-large" };
		const canonical = await realpath(path);
		if (!isInside(repositoryRoot, canonical)) throw new Error("Workspace path escapes the authorized root");
		const oldPath = status.previousRelativePath ?? relativePath;
		const [oldContents, newContents] = await Promise.all([
			this.runGitBuffer(repositoryRoot, ["show", `${head}:${oldPath}`], REVIEW_CONTEXT_LIMIT),
			readFileBuffer(canonical),
		]);
		return this.reviewContext(
			oldPath,
			oldContents,
			`old:${head}:${oldPath}`,
			relativePath,
			newContents,
			`new:working-tree:${relativePath}:${contentRevision(newContents)}`,
		);
	}

	private reviewContext(
		oldName: string,
		oldContents: Buffer,
		oldCacheKey: string,
		newName: string,
		newContents: Buffer,
		newCacheKey: string,
	): DesktopWorkspaceReviewFileContext {
		if (oldContents.length > REVIEW_CONTEXT_LIMIT || newContents.length > REVIEW_CONTEXT_LIMIT) {
			return { kind: "unavailable", reason: "too-large" };
		}
		if (isBinary(oldContents) || isBinary(newContents)) return { kind: "unavailable", reason: "binary" };
		try {
			const decoder = new TextDecoder("utf-8", { fatal: true });
			return {
				kind: "text",
				oldFile: { name: oldName, contents: decoder.decode(oldContents), cacheKey: oldCacheKey },
				newFile: { name: newName, contents: decoder.decode(newContents), cacheKey: newCacheKey },
			};
		} catch {
			return { kind: "unavailable", reason: "binary" };
		}
	}

	private classifyPatch(patch: string): DesktopWorkspaceReviewFileDiff {
		return patch.includes("Binary files ") || patch.includes("GIT binary patch")
			? { kind: "binary" }
			: { kind: "text", patch };
	}

	private async runGit(
		root: string,
		args: readonly string[],
		maxStdoutBytes: number,
		allowedExitCodes: readonly number[] = [0],
	): Promise<string> {
		return (await this.runGitBuffer(root, args, maxStdoutBytes, allowedExitCodes)).toString("utf8");
	}

	private async runGitBuffer(
		root: string,
		args: readonly string[],
		maxStdoutBytes: number,
		allowedExitCodes: readonly number[] = [0],
	): Promise<Buffer> {
		return await new Promise<Buffer>((resolve, reject) => {
			const child = spawn("git", ["--no-optional-locks", "-C", root, ...args], {
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			const stdout: Buffer[] = [];
			const stderr: Buffer[] = [];
			let stdoutBytes = 0;
			let stderrBytes = 0;
			let exceeded = false;
			let settled = false;
			const finish = (cause?: unknown, value?: Buffer) => {
				if (settled) return;
				settled = true;
				if (cause !== undefined) reject(cause);
				else resolve(value ?? Buffer.alloc(0));
			};
			child.stdout!.on("data", (chunk: Buffer) => {
				stdoutBytes += chunk.length;
				if (stdoutBytes > maxStdoutBytes) {
					exceeded = true;
					child.kill();
					return;
				}
				stdout.push(chunk);
			});
			child.stderr!.on("data", (chunk: Buffer) => {
				if (stderrBytes >= STDERR_LIMIT) return;
				const remaining = STDERR_LIMIT - stderrBytes;
				stderr.push(chunk.subarray(0, remaining));
				stderrBytes += Math.min(chunk.length, remaining);
			});
			child.once("error", finish);
			child.once("close", (code) => {
				if (exceeded) {
					finish(new ReviewOutputTooLargeError("Git review output exceeded its limit"));
					return;
				}
				const errorText = Buffer.concat(stderr).toString("utf8");
				if (code === null || !allowedExitCodes.includes(code)) {
					finish(new GitCommandError(code, errorText));
					return;
				}
				finish(undefined, Buffer.concat(stdout));
			});
		});
	}

	private async indexFiles(sessionId: string): Promise<readonly string[]> {
		const root = await this.root(sessionId);
		const cached = this.searchIndexes.get(sessionId);
		if (cached?.root === root && (cached.loadedAt === 0 || Date.now() - cached.loadedAt < SEARCH_INDEX_TTL_MS)) {
			return await cached.promise;
		}
		this.invalidateSearchIndex(sessionId);
		let entry!: {
			readonly root: string;
			readonly promise: Promise<readonly string[]>;
			child?: ReturnType<typeof spawn>;
			loadedAt: number;
			invalidated: boolean;
		};
		let child!: ReturnType<typeof spawn>;
		const promise = new Promise<readonly string[]>((resolve, reject) => {
			child = spawn(
				this.rgCommand,
				[...this.rgArgsPrefix, "--files", "--hidden", "--null", "--color", "never", "--glob", "!.git/**"],
				{ cwd: root, shell: false, stdio: ["ignore", "pipe", "pipe"] },
			);
			const files: string[] = [];
			let pending = "";
			let stderr = "";
			let settled = false;

			const finish = (cause?: unknown) => {
				if (settled) return;
				settled = true;
				if (cause) reject(cause);
				else resolve(files);
			};
			const accept = (value: string) => {
				const path = searchPath(value);
				if (path) files.push(path);
			};

			child.stdout!.setEncoding("utf8");
			child.stdout!.on("data", (chunk: string) => {
				pending += chunk;
				const values = pending.split("\0");
				pending = values.pop() ?? "";
				for (const value of values) accept(value);
			});
			child.stderr!.setEncoding("utf8");
			child.stderr!.on("data", (chunk: string) => {
				if (stderr.length < STDERR_LIMIT) stderr += chunk.slice(0, STDERR_LIMIT - stderr.length);
			});
			child.once("error", finish);
			child.once("close", (code) => {
				entry.child = undefined;
				if (pending) accept(pending);
				if (entry.invalidated) finish(new Error("Workspace file index was invalidated"));
				else if (code === 0 || code === 1) finish();
				else finish(new Error(stderr.trim() || `ripgrep exited with code ${String(code)}`));
			});
		});
		entry = { root, promise, child, loadedAt: 0, invalidated: false };
		this.searchIndexes.set(sessionId, entry);
		try {
			const files = await promise;
			entry.loadedAt = Date.now();
			return files;
		} catch (cause) {
			if (this.searchIndexes.get(sessionId) === entry) this.searchIndexes.delete(sessionId);
			throw cause;
		}
	}

	private invalidateSearchIndex(sessionId: string): void {
		const entry = this.searchIndexes.get(sessionId);
		if (!entry) return;
		entry.invalidated = true;
		entry.child?.kill();
		this.searchIndexes.delete(sessionId);
	}

	async readFile(input: DesktopWorkspaceTarget): Promise<DesktopWorkspaceFile> {
		const { path } = await this.target(input);
		const metadata = await stat(path);
		if (!metadata.isFile()) throw new Error("Workspace target is not a file");
		const base = { relativePath: input.relativePath, absolutePath: path, byteLength: metadata.size };
		const mediaType = IMAGE_TYPES.get(extname(path).toLocaleLowerCase());
		if (mediaType) {
			if (metadata.size > IMAGE_LIMIT) return { ...base, kind: "unsupported", reason: "too-large" };
			const contents = await readFileBuffer(path);
			return {
				...base,
				kind: "image",
				mediaType,
				dataUrl: `data:${mediaType};base64,${contents.toString("base64")}`,
			};
		}
		const docMediaType = DOC_BINARY_TYPES.get(extname(path).toLocaleLowerCase());
		if (docMediaType) {
			if (metadata.size > DOC_LIMIT) return { ...base, kind: "unsupported", reason: "too-large" };
			const contents = await readFileBuffer(path);
			return {
				...base,
				kind: "binary",
				mediaType: docMediaType,
				dataUrl: `data:${docMediaType};base64,${contents.toString("base64")}`,
				revision: contentRevision(contents),
			};
		}
		if (metadata.size > TEXT_LIMIT) return { ...base, kind: "unsupported", reason: "too-large" };
		const contents = await readFileBuffer(path);
		if (contents.includes(0)) return { ...base, kind: "unsupported", reason: "binary" };
		try {
			return {
				...base,
				kind: "text",
				text: new TextDecoder("utf-8", { fatal: true }).decode(contents),
				revision: contentRevision(contents),
			};
		} catch {
			return { ...base, kind: "unsupported", reason: "binary" };
		}
	}

	async readPreviewBytes(input: DesktopWorkspaceTarget): Promise<DesktopPreviewFile> {
		const { path } = await this.target(input);
		const metadata = await stat(path);
		if (!metadata.isFile()) return { ok: false, reason: "not-found" };
		if (metadata.size > PREVIEW_MAX_BYTES) return { ok: false, reason: "too-large" };
		const contents = await readFileBuffer(path);
		const ext = extname(path).toLocaleLowerCase();
		const mediaType =
			IMAGE_TYPES.get(ext) ||
			DOC_BINARY_TYPES.get(ext) ||
			(ext === ".csv"
				? "text/csv"
				: ext === ".svg"
					? "image/svg+xml"
					: ext === ".md" || ext === ".markdown"
						? "text/markdown"
						: ext === ".txt"
							? "text/plain"
							: ext === ".json"
								? "application/json"
								: "application/octet-stream");
		return {
			ok: true,
			name: basename(path),
			byteLength: metadata.size,
			mediaType,
			bytes: new Uint8Array(contents.buffer, contents.byteOffset, contents.byteLength),
		};
	}

	async writeFile(input: DesktopWriteWorkspaceFileInput): Promise<DesktopWriteWorkspaceFileResult> {
		const { path } = await this.target(input);
		const metadata = await stat(path);
		if (!metadata.isFile()) throw new Error("Workspace target is not a file");
		const contents = Buffer.from(input.text, "utf8");
		if (contents.byteLength > TEXT_LIMIT) throw new Error("Workspace file is too large to save");
		const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
		try {
			await writeFileBuffer(temporary, contents, { flag: "wx", mode: metadata.mode });
			if (contentRevision(await readFileBuffer(path)) !== input.expectedRevision) {
				throw new Error("Workspace file changed on disk");
			}
			await rename(temporary, path);
		} finally {
			await rm(temporary, { force: true });
		}
		return { revision: contentRevision(contents), byteLength: contents.byteLength };
	}

	async openFile(input: DesktopOpenWorkspaceFileInput): Promise<void> {
		const { path } = await this.target(input);
		if (!(await stat(path)).isFile()) throw new Error("Workspace target is not a file");
		if (input.action === "reveal") {
			this.showItemInFolder(path);
			return;
		}
		const error = await this.openPath(path);
		if (error) throw new Error(error);
	}

	async mutateEntry(input: DesktopWorkspaceMutationInput): Promise<DesktopWorkspaceMutationResult> {
		if (input.action === "create") {
			const parent = await this.directory(input.sessionId, input.parentRelativePath);
			const destination = this.childPath(parent.root, parent.path, input.name);
			await this.assertMissing(destination);
			if (input.kind === "directory") await mkdir(destination);
			else await writeFileBuffer(destination, "", { flag: "wx" });
			this.invalidateSearchIndex(input.sessionId);
			return {
				action: "create",
				kind: input.kind,
				relativePath: input.parentRelativePath ? `${input.parentRelativePath}/${input.name}` : input.name,
				absolutePath: await realpath(destination),
			};
		}

		const source = await this.existingEntry(input.sessionId, input.relativePath);
		if (input.action === "trash") {
			await this.trashItem(source.path);
			this.invalidateSearchIndex(input.sessionId);
			return {
				action: "trash",
				kind: source.kind,
				previousRelativePath: source.relativePath,
				previousAbsolutePath: source.absolutePath,
			};
		}

		const parentRelativePath =
			input.action === "rename"
				? input.relativePath.split("/").slice(0, -1).join("/")
				: input.destinationDirectoryRelativePath;
		const destinationDirectory = await this.directory(input.sessionId, parentRelativePath);
		if (source.kind === "directory" && isInside(source.path, destinationDirectory.path)) {
			throw new Error("Workspace directory cannot be moved into itself");
		}
		const destinationName = input.action === "rename" ? input.name : basename(source.path);
		const destination = this.childPath(source.root, destinationDirectory.path, destinationName);
		if (destination === source.path) {
			return {
				action: input.action,
				kind: source.kind,
				previousRelativePath: source.relativePath,
				previousAbsolutePath: source.absolutePath,
				relativePath: source.relativePath,
				absolutePath: source.absolutePath,
			};
		}
		await this.assertMissing(destination);
		await rename(source.path, destination);
		this.invalidateSearchIndex(input.sessionId);
		return {
			action: input.action,
			kind: source.kind,
			previousRelativePath: source.relativePath,
			previousAbsolutePath: source.absolutePath,
			relativePath: parentRelativePath ? `${parentRelativePath}/${destinationName}` : destinationName,
			absolutePath: await realpath(destination),
		};
	}

	private async root(sessionId: string): Promise<string> {
		const authorizedRoot = this.roots.get(sessionId);
		if (!authorizedRoot) throw new Error("Workspace session is not authorized");
		if (!isAbsolute(authorizedRoot)) throw new Error("Workspace root is not absolute");
		const root = await realpath(authorizedRoot);
		if (!(await stat(root)).isDirectory()) throw new Error("Workspace root is not a directory");
		return root;
	}

	private async target(input: DesktopWorkspaceTarget): Promise<{ readonly root: string; readonly path: string }> {
		const root = await this.root(input.sessionId);
		const candidate = input.relativePath ? join(root, ...input.relativePath.split("/")) : root;
		const path = await realpath(candidate);
		if (!isInside(root, path)) throw new Error("Workspace path escapes the authorized root");
		return { root, path };
	}

	private async existingEntry(sessionId: string, relativePath: string) {
		if (!relativePath) throw new Error("Workspace root cannot be changed");
		const root = await this.root(sessionId);
		const candidate = join(root, ...relativePath.split("/"));
		const parent = await realpath(dirname(candidate));
		if (!isInside(root, parent)) throw new Error("Workspace path escapes the authorized root");
		const path = join(parent, basename(candidate));
		const metadata = await lstat(path);
		if (metadata.isSymbolicLink()) throw new Error("Workspace symbolic links are read-only");
		const canonical = await realpath(path);
		if (!isInside(root, canonical)) throw new Error("Workspace path escapes the authorized root");
		const kind = metadata.isDirectory() ? "directory" : metadata.isFile() ? "file" : null;
		if (!kind) throw new Error("Workspace target is not a file or directory");
		return { root, path: canonical, relativePath, absolutePath: canonical, kind } as const;
	}

	private async directory(sessionId: string, relativePath: string) {
		if (!relativePath) {
			const root = await this.root(sessionId);
			return { root, path: root, relativePath: "", absolutePath: root, kind: "directory" as const };
		}
		const target = await this.existingEntry(sessionId, relativePath);
		if (target.kind !== "directory") throw new Error("Workspace destination is not a directory");
		return target;
	}

	private childPath(root: string, parent: string, name: string): string {
		if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\") || name.includes("\0")) {
			throw new Error("Invalid workspace entry name");
		}
		const path = join(parent, name);
		if (!isInside(root, path)) throw new Error("Workspace path escapes the authorized root");
		return path;
	}

	private async assertMissing(path: string): Promise<void> {
		try {
			await lstat(path);
		} catch (cause) {
			if ((cause as NodeJS.ErrnoException).code === "ENOENT") return;
			throw cause;
		}
		throw new Error("Workspace destination already exists");
	}
}
