import { closeSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { encodePathForStorage, resolvePath } from "../utils/paths.ts";

export const AUTO_MEMORY_MAX_LINES = 200;
export const AUTO_MEMORY_MAX_BYTES = 25 * 1024;

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

export function getAutoMemoryPaths(agentDir: string, cwd: string): AutoMemorySnapshot {
	const memoryDir = getAutoMemoryRoot(agentDir);
	const projectDir = join(memoryDir, "projects", encodePathForStorage(cwd));
	return {
		global: emptyIndex(memoryDir, join(memoryDir, "MEMORY.md")),
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
