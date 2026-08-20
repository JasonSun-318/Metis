import { chmodSync, closeSync, existsSync, lstatSync, openSync, readSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import lockfile from "proper-lockfile";
import { canonicalizePathForCreation, encodePathForStorage, resolvePath } from "../utils/paths.ts";
import type { AgentMode } from "./agent-mode.ts";
import {
	ensureRealDirectoryDurablySync,
	readSingleLinkTextFileSync,
	replaceFileAtomicallySync,
	syncDirectorySync,
} from "./durable-file.ts";
import { ingestMarkdownIfEmpty } from "./memory/memory-ingest.ts";

export const AUTO_MEMORY_MAX_LINES = 200;
export const AUTO_MEMORY_MAX_BYTES = 25 * 1024;
const MODE_SCOPED_MEMORY_MARKER = ".mode-scoped-project-memory-v1";
const MODE_SCOPED_MEMORY_MARKER_CONTENT = "mode-scoped-project-memory-v1\n";
const migrations = new Map<string, Promise<void>>();

export interface AutoMemoryIndex {
	directory: string;
	indexPath: string;
	content: string;
	exists: boolean;
	truncated: boolean;
	error?: string;
}

export interface AutoMemorySnapshot {
	global: AutoMemoryIndex;
	project: AutoMemoryIndex;
}

export function getAutoMemoryRoot(agentDir: string): string {
	return join(resolvePath(agentDir), "memory");
}

export function getMemorySqlitePath(agentDir: string): string {
	return join(getAutoMemoryRoot(agentDir), "memory.sqlite");
}

export function getAutoMemoryPaths(agentDir: string, cwd: string, mode: AgentMode): AutoMemorySnapshot {
	const memoryDir = getAutoMemoryRoot(agentDir);
	const projectDir = join(memoryDir, "projects", encodePathForStorage(canonicalizePathForCreation(cwd)), mode);
	return {
		global: emptyIndex(memoryDir, join(memoryDir, "MEMORY.md")),
		project: emptyIndex(projectDir, join(projectDir, "project.md")),
	};
}

export function loadAutoMemory(agentDir: string, cwd: string, mode: AgentMode): AutoMemorySnapshot {
	const paths = getAutoMemoryPaths(agentDir, cwd, mode);
	return {
		global: loadIndex(paths.global),
		project: loadIndex(paths.project),
	};
}

/** Remove the obsolete cwd-shared project memory layout exactly once, then ingest Markdown if needed. */
export function ensureModeScopedMemoryLayout(agentDir: string): Promise<void> {
	const memoryDir = getAutoMemoryRoot(agentDir);
	const existing = migrations.get(memoryDir);
	if (existing) return existing;

	const migration = migrateModeScopedMemory(memoryDir)
		.then(() => ingestMarkdownIfEmpty(agentDir))
		.catch((error) => {
			migrations.delete(memoryDir);
			throw error;
		});
	migrations.set(memoryDir, migration);
	return migration;
}

async function migrateModeScopedMemory(memoryDir: string): Promise<void> {
	ensureRealDirectoryDurablySync(memoryDir, 0o700);
	chmodSync(memoryDir, 0o700);
	const release = await lockfile.lock(memoryDir, {
		realpath: false,
		stale: 15_000,
		retries: {
			retries: 8,
			factor: 1.5,
			minTimeout: 20,
			maxTimeout: 250,
			randomize: true,
		},
	});
	try {
		const marker = join(memoryDir, MODE_SCOPED_MEMORY_MARKER);
		const markerContent = readSingleLinkTextFileSync(marker, { maxBytes: 128 });
		const projectsDir = join(memoryDir, "projects");
		if (markerContent !== undefined) {
			if (markerContent !== MODE_SCOPED_MEMORY_MARKER_CONTENT) {
				throw new Error(`Invalid mode-scoped memory marker: ${marker}`);
			}
			ensureRealDirectoryDurablySync(projectsDir, 0o700);
			chmodSync(projectsDir, 0o700);
			return;
		}

		assertRemovableDirectory(projectsDir);
		assertRemovableFile(join(memoryDir, "dream-history.jsonl"));
		rmSync(projectsDir, { recursive: true, force: true });
		rmSync(join(memoryDir, "dream-history.jsonl"), { force: true });
		syncDirectorySync(memoryDir);
		ensureRealDirectoryDurablySync(projectsDir, 0o700);
		chmodSync(projectsDir, 0o700);
		replaceFileAtomicallySync(marker, MODE_SCOPED_MEMORY_MARKER_CONTENT, {
			mode: 0o600,
		});
	} finally {
		await release();
	}
}

function assertRemovableDirectory(path: string): void {
	if (!existsSync(path)) return;
	if (!lstatSync(path).isDirectory()) throw new Error(`Refusing to replace non-directory memory path: ${path}`);
}

function assertRemovableFile(path: string): void {
	if (!existsSync(path)) return;
	const stats = lstatSync(path);
	if (!stats.isFile() || stats.nlink !== 1) throw new Error(`Refusing to remove aliased memory history: ${path}`);
}

function emptyIndex(directory: string, indexPath: string): AutoMemoryIndex {
	return { directory, indexPath, content: "", exists: false, truncated: false };
}

function loadIndex(index: AutoMemoryIndex): AutoMemoryIndex {
	let fd: number | undefined;
	try {
		const size = statSync(index.indexPath).size;
		fd = openSync(index.indexPath, "r");
		const buffer = Buffer.alloc(Math.min(size, AUTO_MEMORY_MAX_BYTES));
		const bytesRead = buffer.length > 0 ? readSync(fd, buffer, 0, buffer.length, 0) : 0;
		const byteLimited = decodeUtf8Prefix(buffer.subarray(0, bytesRead), size > bytesRead);
		const lines = byteLimited.split(/\r?\n/);
		return {
			...index,
			content: lines.slice(0, AUTO_MEMORY_MAX_LINES).join("\n"),
			exists: true,
			truncated: size > bytesRead || lines.length > AUTO_MEMORY_MAX_LINES,
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" ? index : { ...index, error: error instanceof Error ? error.message : String(error) };
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function decodeUtf8Prefix(buffer: Buffer, truncated: boolean): string {
	if (!truncated) return buffer.toString("utf8");
	for (let end = buffer.length; end >= Math.max(0, buffer.length - 3); end--) {
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, end));
		} catch {
			// The byte limit may split one UTF-8 character; at most three bytes need dropping.
		}
	}
	return buffer.toString("utf8");
}
