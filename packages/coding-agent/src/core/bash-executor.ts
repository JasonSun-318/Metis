/**
 * Bash command execution with streaming support and cancellation.
 *
 * This module provides a unified bash execution implementation used by:
 * - AgentSession.executeBash() for interactive and RPC modes
 * - Direct calls from modes that need bash execution
 */

import { randomBytes } from "node:crypto";
import {
	closeSync,
	createWriteStream,
	constants as fsConstants,
	fstatSync,
	lstatSync,
	openSync,
	type WriteStream,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { finished } from "node:stream/promises";
import { stripAnsi } from "../utils/ansi.ts";
import { sanitizeBinaryOutput } from "../utils/shell.ts";
import { ensureRealDirectoryDurablySync, syncDirectorySync, syncFileSync } from "./durable-file.ts";
import type { BashOperations } from "./tools/bash.ts";
import { DEFAULT_MAX_BYTES, truncateTail } from "./tools/truncate.ts";

export interface BashExecutorOptions {
	/** Exact one-action permission grant consumed by the execution backend. */
	actionId?: string;
	/** Callback for streaming output chunks (already sanitized) */
	onChunk?: (chunk: string) => void;
	/** AbortSignal for cancellation */
	signal?: AbortSignal;
	/** Directory for complete output files when truncation occurs */
	outputDir?: string;
}

export interface BashResult {
	/** Combined stdout + stderr output (sanitized, possibly truncated) */
	output: string;
	/** Process exit code (undefined if killed/cancelled) */
	exitCode: number | undefined;
	/** Whether the command was cancelled via signal */
	cancelled: boolean;
	/** Whether the output was truncated */
	truncated: boolean;
	/** Path to temp file containing full output (if output exceeded truncation threshold) */
	fullOutputPath?: string;
}

/**
 * Execute a bash command using custom BashOperations.
 * Used for remote execution (SSH, containers, etc.).
 */
export async function executeBashWithOperations(
	command: string,
	cwd: string,
	operations: BashOperations,
	options?: BashExecutorOptions,
): Promise<BashResult> {
	const outputChunks: string[] = [];
	let outputBytes = 0;
	const maxOutputBytes = DEFAULT_MAX_BYTES * 2;

	let tempFilePath: string | undefined;
	let tempFileStream: WriteStream | undefined;
	let tempFileFd: number | undefined;
	let tempFileIdentity: { dev: number; ino: number } | undefined;
	let tempFileError: Error | undefined;
	let totalBytes = 0;
	const outputDir = options?.outputDir ?? tmpdir();
	ensureRealDirectoryDurablySync(outputDir);

	const ensureTempFile = () => {
		if (tempFilePath) {
			return;
		}
		const id = randomBytes(8).toString("hex");
		const path = join(outputDir, `metis-bash-${id}.log`);
		const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
		const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | noFollow, 0o600);
		try {
			const opened = fstatSync(fd);
			const current = lstatSync(path);
			if (
				!opened.isFile() ||
				opened.nlink !== 1 ||
				!current.isFile() ||
				current.nlink !== 1 ||
				opened.dev !== current.dev ||
				opened.ino !== current.ino
			) {
				throw new Error(`Bash output path is not a single-link regular file: ${path}`);
			}
			tempFilePath = path;
			tempFileFd = fd;
			tempFileIdentity = { dev: opened.dev, ino: opened.ino };
			tempFileStream = createWriteStream(path, { fd, autoClose: false });
			tempFileStream.on("error", (error) => {
				tempFileError ??= error;
			});
		} catch (error) {
			tempFilePath = undefined;
			tempFileFd = undefined;
			tempFileIdentity = undefined;
			tempFileStream = undefined;
			closeSync(fd);
			throw error;
		}
		for (const chunk of outputChunks) {
			tempFileStream.write(chunk);
		}
	};

	const closeTempFile = async () => {
		if (!tempFileStream) return;
		const stream = tempFileStream;
		tempFileStream = undefined;
		const fd = tempFileFd;
		const path = tempFilePath;
		const identity = tempFileIdentity;
		if (fd === undefined || !path || !identity) throw new Error("Bash output file was not opened safely");
		try {
			if (tempFileError) throw tempFileError;
			const completion = finished(stream);
			stream.end();
			await completion;
			syncFileSync(fd);
			const opened = fstatSync(fd);
			const current = lstatSync(path);
			if (
				!opened.isFile() ||
				opened.nlink !== 1 ||
				!current.isFile() ||
				current.nlink !== 1 ||
				opened.dev !== identity.dev ||
				opened.ino !== identity.ino ||
				current.dev !== identity.dev ||
				current.ino !== identity.ino
			) {
				throw new Error(`Bash output file identity changed: ${path}`);
			}
		} finally {
			closeSync(fd);
			tempFileFd = undefined;
		}
		syncDirectorySync(dirname(path));
	};

	const decoder = new TextDecoder();

	const onData = (data: Buffer) => {
		totalBytes += data.length;

		// Sanitize: strip ANSI, replace binary garbage, normalize newlines
		const text = sanitizeBinaryOutput(stripAnsi(decoder.decode(data, { stream: true }))).replace(/\r/g, "");

		// Start writing to temp file if exceeds threshold
		if (totalBytes > DEFAULT_MAX_BYTES) {
			ensureTempFile();
		}

		if (tempFileStream) {
			tempFileStream.write(text);
		}

		// Keep rolling buffer
		outputChunks.push(text);
		outputBytes += text.length;
		while (outputBytes > maxOutputBytes && outputChunks.length > 1) {
			const removed = outputChunks.shift()!;
			outputBytes -= removed.length;
		}

		// Stream to callback
		if (options?.onChunk) {
			options.onChunk(text);
		}
	};

	try {
		const result = await operations.exec(command, cwd, {
			actionId: options?.actionId,
			onData,
			signal: options?.signal,
		});

		const fullOutput = outputChunks.join("");
		const truncationResult = truncateTail(fullOutput);
		if (truncationResult.truncated) {
			ensureTempFile();
		}
		await closeTempFile();
		const cancelled = options?.signal?.aborted ?? false;

		return {
			output: truncationResult.truncated ? truncationResult.content : fullOutput,
			exitCode: cancelled ? undefined : (result.exitCode ?? undefined),
			cancelled,
			truncated: truncationResult.truncated,
			fullOutputPath: tempFilePath,
		};
	} catch (err) {
		// Check if it was an abort
		if (options?.signal?.aborted) {
			const fullOutput = outputChunks.join("");
			const truncationResult = truncateTail(fullOutput);
			if (truncationResult.truncated) {
				ensureTempFile();
			}
			await closeTempFile();
			return {
				output: truncationResult.truncated ? truncationResult.content : fullOutput,
				exitCode: undefined,
				cancelled: true,
				truncated: truncationResult.truncated,
				fullOutputPath: tempFilePath,
			};
		}

		await closeTempFile();

		throw err;
	}
}
