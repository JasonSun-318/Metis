import crypto from "node:crypto";
import { constants as fsConstants, lstatSync, type Stats } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { ImageContent, TextContent } from "@arcmind/ai";
import { ensureDirectoryDurablySync } from "./durable-file.ts";

export const LARGE_TOOL_OUTPUT_MAX_CHARS = 50_000;
export const TOOL_OUTPUT_PREVIEW_BYTES = 2 * 1024;

export interface PersistedToolOutput {
	truncated: true;
	originalBytes: number;
	previewBytes: number;
	fullOutputPath: string;
}

export interface ExternalizedToolOutput {
	content: (TextContent | ImageContent)[];
	toolOutput: PersistedToolOutput;
}

interface FileIdentity {
	device: number;
	inode: number;
}

interface PinnedOutputDirectory extends FileIdentity {
	handle: FileHandle;
}

interface OpenedOutputFile extends FileIdentity {
	handle: FileHandle;
	path: string;
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error
		? String((error as NodeJS.ErrnoException).code)
		: undefined;
}

function sameIdentity(stats: Stats, identity: FileIdentity): boolean {
	return stats.dev === identity.device && stats.ino === identity.inode;
}

function assertPinnedOutputDirectory(path: string, expected: FileIdentity): void {
	const current = lstatSync(path);
	if (!current.isDirectory() || !sameIdentity(current, expected)) {
		throw new Error(`Tool output directory identity changed: ${path}`);
	}
}

async function openPinnedOutputDirectory(path: string): Promise<PinnedOutputDirectory> {
	ensureDirectoryDurablySync(path);
	const before = lstatSync(path);
	if (!before.isDirectory()) throw new Error(`Tool output path is not a real directory: ${path}`);

	const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
	const directoryOnly = typeof fsConstants.O_DIRECTORY === "number" ? fsConstants.O_DIRECTORY : 0;
	const nonBlocking = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
	const handle = await open(path, fsConstants.O_RDONLY | directoryOnly | noFollow | nonBlocking);
	try {
		const opened = await handle.stat();
		const identity = { device: opened.dev, inode: opened.ino };
		if (!opened.isDirectory() || !sameIdentity(before, identity)) {
			throw new Error(`Tool output directory identity changed: ${path}`);
		}
		assertPinnedOutputDirectory(path, identity);
		return { handle, ...identity };
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
}

async function openVerifiedOutputFile(outputDir: string, directory: PinnedOutputDirectory): Promise<OpenedOutputFile> {
	assertPinnedOutputDirectory(outputDir, directory);
	const path = join(outputDir, `${crypto.randomUUID()}.txt`);
	const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
	const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow;
	const handle = await open(path, flags, 0o600);
	try {
		const opened = await handle.stat();
		const current = lstatSync(path);
		const identity = { device: opened.dev, inode: opened.ino };
		if (
			!opened.isFile() ||
			opened.nlink !== 1 ||
			!current.isFile() ||
			current.nlink !== 1 ||
			!sameIdentity(current, identity)
		) {
			throw new Error(`Tool output path is not a single-link regular file: ${path}`);
		}
		assertPinnedOutputDirectory(outputDir, directory);
		return { handle, path, ...identity };
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
}

async function assertOpenedOutputFile(path: string, openedFile: OpenedOutputFile): Promise<void> {
	const opened = await openedFile.handle.stat();
	const current = lstatSync(path);
	if (
		!opened.isFile() ||
		opened.nlink !== 1 ||
		!sameIdentity(opened, openedFile) ||
		!current.isFile() ||
		current.nlink !== 1 ||
		!sameIdentity(current, openedFile)
	) {
		throw new Error(`Tool output path identity changed: ${path}`);
	}
}

function supportsDataSyncFallback(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	const code = String((error as NodeJS.ErrnoException).code);
	return code === "EINVAL" || code === "ENOSYS" || code === "ENOTSUP";
}

function supportsDirectorySyncFallback(error: unknown): boolean {
	if (process.platform !== "win32") return false;
	const code = errorCode(error);
	return code === "EACCES" || code === "EINVAL" || code === "EISDIR" || code === "ENOTSUP" || code === "EPERM";
}

function firstUtf8Bytes(text: string, maxBytes: number): { text: string; bytes: number } {
	// A bounded UTF-16 slice avoids allocating a Buffer for the complete large result.
	const bytes = Buffer.from(text.slice(0, maxBytes), "utf8");
	const decoder = new StringDecoder("utf8");
	const preview = decoder.write(bytes.subarray(0, maxBytes));
	return { text: preview, bytes: Buffer.byteLength(preview, "utf8") };
}

export async function externalizeLargeToolOutput(
	content: (TextContent | ImageContent)[],
	outputDir: string,
): Promise<ExternalizedToolOutput | undefined> {
	const textBlocks = content.filter((block): block is TextContent => block.type === "text");
	const totalChars = textBlocks.reduce((sum, block) => sum + block.text.length, 0);
	if (totalChars <= LARGE_TOOL_OUTPUT_MAX_CHARS) return undefined;

	const fullText = textBlocks.map((block) => block.text).join("");
	const originalBytes = Buffer.byteLength(fullText, "utf8");
	const outputDirectory = await openPinnedOutputDirectory(outputDir);
	let outputFile: OpenedOutputFile | undefined;
	let outputClosed = false;
	let directoryClosed = false;
	try {
		outputFile = await openVerifiedOutputFile(outputDir, outputDirectory);
		await outputFile.handle.writeFile(fullText, { encoding: "utf8" });
		try {
			await outputFile.handle.datasync();
		} catch (error) {
			if (!supportsDataSyncFallback(error)) throw error;
			await outputFile.handle.sync();
		}
		assertPinnedOutputDirectory(outputDir, outputDirectory);
		await assertOpenedOutputFile(outputFile.path, outputFile);
		try {
			await outputDirectory.handle.sync();
		} catch (error) {
			if (!supportsDirectorySyncFallback(error)) throw error;
		}
		assertPinnedOutputDirectory(outputDir, outputDirectory);
		await assertOpenedOutputFile(outputFile.path, outputFile);
		await outputFile.handle.close();
		outputClosed = true;
		await outputDirectory.handle.close();
		directoryClosed = true;
	} finally {
		if (!outputClosed) await outputFile?.handle.close().catch(() => undefined);
		if (!directoryClosed) await outputDirectory.handle.close().catch(() => undefined);
	}
	if (!outputFile) throw new Error("Tool output file was not created");
	const fullOutputPath = outputFile.path;

	const preview = firstUtf8Bytes(fullText, TOOL_OUTPUT_PREVIEW_BYTES);
	const toolOutput: PersistedToolOutput = {
		truncated: true,
		originalBytes,
		previewBytes: preview.bytes,
		fullOutputPath,
	};
	const notice = [
		"[Tool output truncated: preview only]",
		`Original size: ${toolOutput.originalBytes} bytes`,
		`Preview size: ${toolOutput.previewBytes} bytes`,
		`Full output: ${toolOutput.fullOutputPath}`,
		"",
		preview.text,
	].join("\n");

	let noticeInserted = false;
	const boundedContent = content.flatMap((block): (TextContent | ImageContent)[] => {
		if (block.type === "image") return [block];
		if (noticeInserted) return [];
		noticeInserted = true;
		return [{ type: "text", text: notice }];
	});

	return { content: boundedContent, toolOutput };
}
