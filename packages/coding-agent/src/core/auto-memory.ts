import { chmodSync } from "node:fs";
import { join } from "node:path";
import { canonicalizePathForCreation, resolvePath } from "../utils/paths.ts";
import { ensureRealDirectoryDurablySync, readSingleLinkFilePrefixSync } from "./durable-file.ts";
import { ingestGlobalMarkdownOnce } from "./memory/memory-ingest.ts";
import { memoryProjectIdentity } from "./memory/memory-project.ts";
import { writeGlobalProjection } from "./memory/memory-projection.ts";
import { openMemoryStore } from "./memory/memory-store.ts";

export const AUTO_MEMORY_MAX_LINES = 200;
export const AUTO_MEMORY_MAX_BYTES = 25 * 1024;
const initializations = new Map<string, Promise<void>>();

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
	return join(canonicalizePathForCreation(resolvePath(agentDir)), "memory");
}

export function getMemorySqlitePath(agentDir: string): string {
	return join(getAutoMemoryRoot(agentDir), "memory.sqlite");
}

export function getGlobalMemoryDirectory(agentDir: string): string {
	return join(getAutoMemoryRoot(agentDir), "global");
}

export function getProjectMemoryDirectory(agentDir: string, projectKey: string): string {
	return join(getAutoMemoryRoot(agentDir), "projects", projectKey);
}

export function getAutoMemoryPaths(agentDir: string, cwd: string): AutoMemorySnapshot {
	const globalDir = getGlobalMemoryDirectory(agentDir);
	const projectDir = getProjectMemoryDirectory(agentDir, memoryProjectIdentity(cwd).projectKey);
	return {
		global: emptyIndex(globalDir, join(globalDir, "MEMORY.md")),
		project: emptyIndex(projectDir, join(projectDir, "project.md")),
	};
}

export function loadAutoMemory(agentDir: string, cwd: string): AutoMemorySnapshot {
	const paths = getAutoMemoryPaths(agentDir, cwd);
	return {
		global: loadIndex(paths.global),
		project: loadIndex(paths.project),
	};
}

export async function ensureAutoMemoryLayout(agentDir: string): Promise<void> {
	const memoryDir = getAutoMemoryRoot(agentDir);
	ensureRealDirectoryDurablySync(memoryDir, 0o700);
	ensureRealDirectoryDurablySync(getGlobalMemoryDirectory(agentDir), 0o700);
	ensureRealDirectoryDurablySync(join(memoryDir, "projects"), 0o700);
	chmodSync(memoryDir, 0o700);
	const store = openMemoryStore(getMemorySqlitePath(agentDir));
	store.close();
}

export function initializeAutoMemory(agentDir: string): Promise<void> {
	const memoryDir = getAutoMemoryRoot(agentDir);
	const existing = initializations.get(memoryDir);
	if (existing) return existing;

	const initialization = Promise.resolve()
		.then(async () => {
			await ensureAutoMemoryLayout(agentDir);
			const store = openMemoryStore(getMemorySqlitePath(agentDir));
			try {
				store.recoverInterruptedHealth(new Date().toISOString());
			} finally {
				store.close();
			}
		})
		.then(() => ingestGlobalMarkdownOnce(agentDir))
		.then(async () => {
			const store = openMemoryStore(getMemorySqlitePath(agentDir));
			try {
				await writeGlobalProjection(agentDir, store);
			} finally {
				store.close();
			}
		})
		.catch((error) => {
			initializations.delete(memoryDir);
			throw error;
		});
	initializations.set(memoryDir, initialization);
	return initialization;
}

/** @deprecated Compatibility entrypoint without startup recovery. */
export async function ensureModeScopedMemoryLayout(agentDir: string): Promise<void> {
	await ensureAutoMemoryLayout(agentDir);
	await ingestGlobalMarkdownOnce(agentDir);
	const store = openMemoryStore(getMemorySqlitePath(agentDir));
	try {
		await writeGlobalProjection(agentDir, store);
	} finally {
		store.close();
	}
}

function emptyIndex(directory: string, indexPath: string): AutoMemoryIndex {
	return { directory, indexPath, content: "", exists: false, truncated: false };
}

function loadIndex(index: AutoMemoryIndex): AutoMemoryIndex {
	try {
		const source = readSingleLinkFilePrefixSync(index.indexPath, AUTO_MEMORY_MAX_BYTES);
		if (!source) return index;
		const truncatedByBytes = source.truncated;
		let byteLimited = decodeUtf8Prefix(source.bytes, truncatedByBytes);
		if (truncatedByBytes) {
			const lastLineBreak = byteLimited.lastIndexOf("\n");
			byteLimited = lastLineBreak < 0 ? "" : byteLimited.slice(0, lastLineBreak);
		}
		const lines = byteLimited.split(/\r?\n/);
		return {
			...index,
			content: lines.slice(0, AUTO_MEMORY_MAX_LINES).join("\n"),
			exists: true,
			truncated: truncatedByBytes || lines.length > AUTO_MEMORY_MAX_LINES,
		};
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" ? index : { ...index, error: error instanceof Error ? error.message : String(error) };
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
