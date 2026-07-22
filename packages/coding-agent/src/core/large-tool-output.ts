import crypto from "node:crypto";
import { constants as fsConstants, lstatSync, type Stats } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
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

interface OpenedSourceFile extends FileIdentity {
	handle: FileHandle;
	path: string;
	size: number;
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

async function openVerifiedSourceFile(path: string): Promise<OpenedSourceFile> {
	const before = lstatSync(path);
	if (!before.isFile() || before.nlink !== 1) {
		throw new Error(`Tool output source is not a single-link regular file: ${path}`);
	}
	const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
	const nonBlocking = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
	const handle = await open(path, fsConstants.O_RDONLY | noFollow | nonBlocking);
	try {
		const opened = await handle.stat();
		const current = lstatSync(path);
		const identity = { device: before.dev, inode: before.ino };
		if (
			!opened.isFile() ||
			opened.nlink !== 1 ||
			!current.isFile() ||
			current.nlink !== 1 ||
			!sameIdentity(opened, identity) ||
			!sameIdentity(current, identity) ||
			opened.size !== before.size ||
			current.size !== before.size
		) {
			throw new Error(`Tool output source identity changed: ${path}`);
		}
		return { handle, path, size: opened.size, device: opened.dev, inode: opened.ino };
	} catch (error) {
		await handle.close().catch(() => undefined);
		throw error;
	}
}

async function assertOpenedSourceFile(source: OpenedSourceFile): Promise<void> {
	const opened = await source.handle.stat();
	const current = lstatSync(source.path);
	if (
		!opened.isFile() ||
		opened.nlink !== 1 ||
		!current.isFile() ||
		current.nlink !== 1 ||
		!sameIdentity(opened, source) ||
		!sameIdentity(current, source) ||
		opened.size !== source.size ||
		current.size !== source.size
	) {
		throw new Error(`Tool output source changed while copying: ${source.path}`);
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

async function syncOutputFile(
	outputDir: string,
	directory: PinnedOutputDirectory,
	outputFile: OpenedOutputFile,
): Promise<void> {
	try {
		await outputFile.handle.datasync();
	} catch (error) {
		if (!supportsDataSyncFallback(error)) throw error;
		await outputFile.handle.sync();
	}
	assertPinnedOutputDirectory(outputDir, directory);
	await assertOpenedOutputFile(outputFile.path, outputFile);
	try {
		await directory.handle.sync();
	} catch (error) {
		if (!supportsDirectorySyncFallback(error)) throw error;
	}
	assertPinnedOutputDirectory(outputDir, directory);
	await assertOpenedOutputFile(outputFile.path, outputFile);
}

function firstUtf8Bytes(text: string, maxBytes: number): { text: string; bytes: number } {
	// A bounded UTF-16 slice avoids allocating a Buffer for the complete large result.
	const bytes = Buffer.from(text.slice(0, maxBytes), "utf8");
	const decoder = new StringDecoder("utf8");
	const preview = decoder.write(bytes.subarray(0, maxBytes));
	return { text: preview, bytes: Buffer.byteLength(preview, "utf8") };
}

export async function isOwnedToolOutputFile(filePath: string, outputDir: string): Promise<boolean> {
	if (dirname(resolve(filePath)) !== resolve(outputDir)) return false;
	let source: OpenedSourceFile | undefined;
	try {
		const directory = await openPinnedOutputDirectory(outputDir);
		try {
			source = await openVerifiedSourceFile(filePath);
			assertPinnedOutputDirectory(outputDir, directory);
			await assertOpenedSourceFile(source);
			assertPinnedOutputDirectory(outputDir, directory);
			return true;
		} finally {
			await source?.handle.close().catch(() => undefined);
			await directory.handle.close().catch(() => undefined);
		}
	} catch {
		return false;
	}
}

export async function persistToolOutputText(text: string, outputDir: string): Promise<string> {
	const directory = await openPinnedOutputDirectory(outputDir);
	let outputFile: OpenedOutputFile | undefined;
	try {
		outputFile = await openVerifiedOutputFile(outputDir, directory);
		await outputFile.handle.writeFile(text, { encoding: "utf8" });
		await syncOutputFile(outputDir, directory, outputFile);
		return outputFile.path;
	} finally {
		await outputFile?.handle.close().catch(() => undefined);
		await directory.handle.close().catch(() => undefined);
	}
}

export async function importToolOutputFile(sourcePath: string, outputDir: string): Promise<string> {
	if (await isOwnedToolOutputFile(sourcePath, outputDir)) return sourcePath;

	const source = await openVerifiedSourceFile(sourcePath);
	const directory = await openPinnedOutputDirectory(outputDir);
	let outputFile: OpenedOutputFile | undefined;
	try {
		outputFile = await openVerifiedOutputFile(outputDir, directory);
		const buffer = Buffer.allocUnsafe(64 * 1024);
		let position = 0;
		while (true) {
			const { bytesRead } = await source.handle.read(buffer, 0, buffer.length, position);
			if (bytesRead === 0) break;
			let offset = 0;
			while (offset < bytesRead) {
				const { bytesWritten } = await outputFile.handle.write(
					buffer,
					offset,
					bytesRead - offset,
					position + offset,
				);
				if (bytesWritten === 0) throw new Error("Tool output copy made no progress");
				offset += bytesWritten;
			}
			position += bytesRead;
		}
		if (position !== source.size) throw new Error("Tool output source size changed while copying");
		await assertOpenedSourceFile(source);
		await syncOutputFile(outputDir, directory, outputFile);
		return outputFile.path;
	} finally {
		await outputFile?.handle.close().catch(() => undefined);
		await directory.handle.close().catch(() => undefined);
		await source.handle.close().catch(() => undefined);
	}
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
	const fullOutputPath = await persistToolOutputText(fullText, outputDir);

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
		"If you need the full output, read the saved file.",
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
