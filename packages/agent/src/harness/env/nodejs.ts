import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import {
	access,
	appendFile,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import {
	type ExecutionEnv,
	ExecutionError,
	err,
	FileError,
	type FileInfo,
	type FileKind,
	ok,
	type Result,
	toError,
} from "../types.ts";

const MAX_TIMEOUT_MS = 2_147_483_647;
const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MS / 1000;
const MAX_CAPTURED_OUTPUT_BYTES = 64 * 1024 * 1024;
const CLOSE_GRACE_MS = 250;

function resolveTimeoutMs(timeout: number | undefined): Result<number | undefined, ExecutionError> {
	if (timeout === undefined) return ok(undefined);
	if (!Number.isFinite(timeout) || timeout <= 0) {
		return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
	}

	const timeoutMs = timeout * 1000;
	if (timeoutMs > MAX_TIMEOUT_MS) {
		return err(new ExecutionError("timeout", `Invalid timeout: maximum is ${MAX_TIMEOUT_SECONDS} seconds`));
	}
	return ok(timeoutMs);
}

function resolvePath(cwd: string, path: string): string {
	return isAbsolute(path) ? path : resolve(cwd, path);
}

function fileKindFromStats(stats: {
	isFile(): boolean;
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}): FileKind | undefined {
	if (stats.isFile()) return "file";
	if (stats.isDirectory()) return "directory";
	if (stats.isSymbolicLink()) return "symlink";
	return undefined;
}

function fileInfoFromStats(
	path: string,
	stats: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean; size: number; mtimeMs: number },
): Result<FileInfo, FileError> {
	const kind = fileKindFromStats(stats);
	if (!kind) return err(new FileError("invalid", "Unsupported file type", path));
	return ok({
		name: path.replace(/\/+$/, "").split("/").pop() ?? path,
		path,
		kind,
		size: stats.size,
		mtimeMs: stats.mtimeMs,
	});
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}

function toFileError(error: unknown, path?: string): FileError {
	if (error instanceof FileError) return error;
	const cause = toError(error);
	if (isNodeError(error)) {
		const message = error.message;
		switch (error.code) {
			case "ABORT_ERR":
				return new FileError("aborted", message, path, cause);
			case "ENOENT":
				return new FileError("not_found", message, path, cause);
			case "EACCES":
			case "EPERM":
				return new FileError("permission_denied", message, path, cause);
			case "ENOTDIR":
				return new FileError("not_directory", message, path, cause);
			case "EISDIR":
				return new FileError("is_directory", message, path, cause);
			case "EINVAL":
				return new FileError("invalid", message, path, cause);
		}
	}
	return new FileError("unknown", cause.message, path, cause);
}

function abortResult<TValue>(signal: AbortSignal | undefined, path?: string): Result<TValue, FileError> | undefined {
	return signal?.aborted ? err(new FileError("aborted", "aborted", path)) : undefined;
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function runCommand(
	command: string,
	args: string[],
	timeoutMs: number,
): Promise<{ stdout: string; status: number | null }> {
	return await new Promise((resolve) => {
		let stdout = "";
		let capturedBytes = 0;
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(command, args, {
				stdio: ["ignore", "pipe", "ignore"],
				windowsHide: true,
			});
		} catch {
			resolve({ stdout: "", status: null });
			return;
		}
		const finish = (status: number | null) => {
			if (settled) return;
			settled = true;
			if (timeout !== undefined) clearTimeout(timeout);
			child.stdout?.off("data", onData);
			child.off("close", finish);
			child.stdout?.destroy();
			child.unref();
			resolve({ stdout: status === null ? "" : stdout, status });
			stdout = "";
		};
		const fail = () => {
			if (settled) return;
			if (child.pid) killProcessTree(child.pid);
			finish(null);
		};
		const onData = (chunk: string) => {
			if (settled) return;
			capturedBytes += Buffer.byteLength(chunk, "utf8");
			if (capturedBytes > MAX_CAPTURED_OUTPUT_BYTES) {
				fail();
				return;
			}
			stdout += chunk;
		};
		timeout = setTimeout(fail, timeoutMs);
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", onData);
		child.stdout?.on("error", fail);
		child.on("error", fail);
		child.on("close", finish);
	});
}

async function findBashOnPath(): Promise<string | null> {
	const result =
		process.platform === "win32"
			? await runCommand("where", ["bash.exe"], 5000)
			: await runCommand("which", ["bash"], 5000);
	if (result.status !== 0 || !result.stdout) return null;
	const firstMatch = result.stdout.trim().split(/\r?\n/)[0];
	return firstMatch && (await pathExists(firstMatch)) ? firstMatch : null;
}

interface ShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

function isLegacyWslBashPath(path: string): boolean {
	const normalized = path.replace(/\//g, "\\").toLowerCase();
	return /^[a-z]:\\windows\\(?:system32|sysnative)\\bash\.exe$/.test(normalized);
}

function getBashShellConfig(shell: string): ShellConfig {
	return isLegacyWslBashPath(shell) ? { shell, args: ["-s"], commandTransport: "stdin" } : { shell, args: ["-c"] };
}

async function getShellConfig(customShellPath?: string): Promise<Result<ShellConfig, ExecutionError>> {
	if (customShellPath) {
		if (await pathExists(customShellPath)) {
			return ok(getBashShellConfig(customShellPath));
		}
		return err(new ExecutionError("shell_unavailable", `Custom shell path not found: ${customShellPath}`));
	}
	if (process.platform === "win32") {
		const candidates: string[] = [];
		const programFiles = process.env.ProgramFiles;
		if (programFiles) candidates.push(`${programFiles}\\Git\\bin\\bash.exe`);
		const programFilesX86 = process.env["ProgramFiles(x86)"];
		if (programFilesX86) candidates.push(`${programFilesX86}\\Git\\bin\\bash.exe`);
		for (const candidate of candidates) {
			if (await pathExists(candidate)) {
				return ok(getBashShellConfig(candidate));
			}
		}
		const bashOnPath = await findBashOnPath();
		if (bashOnPath) {
			return ok(getBashShellConfig(bashOnPath));
		}
		return err(new ExecutionError("shell_unavailable", "No bash shell found"));
	}

	if (await pathExists("/bin/bash")) {
		return ok(getBashShellConfig("/bin/bash"));
	}
	const bashOnPath = await findBashOnPath();
	if (bashOnPath) {
		return ok(getBashShellConfig(bashOnPath));
	}
	return ok({ shell: "sh", args: ["-c"] });
}

function getShellEnv(baseEnv?: NodeJS.ProcessEnv, extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
	return {
		...process.env,
		...baseEnv,
		...extraEnv,
	};
}

function killProcessTree(pid: number): void {
	if (process.platform === "win32") {
		try {
			const taskkill = spawn("taskkill", ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				detached: true,
				windowsHide: true,
			});
			taskkill.on("error", () => {
				// taskkill may be unavailable or fail asynchronously; the caller handles the close grace.
			});
			taskkill.unref();
		} catch {
			// Ignore errors.
		}
		return;
	}

	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Process already dead.
		}
	}
}

export class NodeExecutionEnv implements ExecutionEnv {
	cwd: string;
	private shellPath?: string;
	private shellEnv?: NodeJS.ProcessEnv;

	constructor(options: { cwd: string; shellPath?: string; shellEnv?: NodeJS.ProcessEnv }) {
		this.cwd = options.cwd;
		this.shellPath = options.shellPath;
		this.shellEnv = options.shellEnv;
	}

	async absolutePath(path: string): Promise<Result<string, FileError>> {
		return ok(resolvePath(this.cwd, path));
	}

	async joinPath(parts: string[]): Promise<Result<string, FileError>> {
		return ok(join(...parts));
	}

	async exec(
		command: string,
		options?: {
			cwd?: string;
			env?: Record<string, string>;
			timeout?: number;
			abortSignal?: AbortSignal;
			onStdout?: (chunk: string) => void;
			onStderr?: (chunk: string) => void;
		},
	): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		if (options?.abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
		const timeoutMsResult = resolveTimeoutMs(options?.timeout);
		if (!timeoutMsResult.ok) return err(timeoutMsResult.error);
		const timeoutMs = timeoutMsResult.value;

		const cwd = options?.cwd ? resolvePath(this.cwd, options.cwd) : this.cwd;
		const shellConfig = await getShellConfig(this.shellPath);
		if (!shellConfig.ok) return shellConfig;

		const abortSignal = options?.abortSignal;

		return await new Promise((resolvePromise) => {
			let stdout = "";
			let stderr = "";
			let capturedBytes = 0;
			let settled = false;
			let timedOut = false;
			let callbackError: ExecutionError | undefined;
			let overflowError: ExecutionError | undefined;
			let child: ReturnType<typeof spawn> | undefined;
			let timeoutId: ReturnType<typeof setTimeout> | undefined;
			let closeGraceId: ReturnType<typeof setTimeout> | undefined;
			let terminationStarted = false;

			const failureResult = ():
				| Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>
				| undefined => {
				if (callbackError) return err(callbackError);
				if (overflowError) return err(overflowError);
				if (timedOut) return err(new ExecutionError("timeout", `timeout:${options?.timeout}`));
				if (abortSignal?.aborted) return err(new ExecutionError("aborted", "aborted"));
				return undefined;
			};

			const settle = (result: Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>) => {
				if (settled) return;
				settled = true;
				if (timeoutId !== undefined) {
					clearTimeout(timeoutId);
					timeoutId = undefined;
				}
				if (closeGraceId !== undefined) {
					clearTimeout(closeGraceId);
					closeGraceId = undefined;
				}
				abortSignal?.removeEventListener("abort", onAbort);
				child?.off("close", onClose);
				child?.stdout?.off("data", onStdoutData);
				child?.stderr?.off("data", onStderrData);
				try {
					child?.stdin?.destroy();
					child?.stdout?.destroy();
					child?.stderr?.destroy();
					child?.unref();
				} catch {
					// Stream teardown is best-effort.
				}
				resolvePromise(result);
				stdout = "";
				stderr = "";
			};

			const terminate = () => {
				if (settled) return;
				if (!terminationStarted) {
					terminationStarted = true;
					if (child?.pid !== undefined) {
						killProcessTree(child.pid);
					}
				}
				if (closeGraceId !== undefined) return;
				// A killed process can fail to emit "close"; settle within a bounded grace instead of hanging.
				closeGraceId = setTimeout(() => {
					closeGraceId = undefined;
					if (settled) return;
					const failure = failureResult();
					settle(failure ?? err(new ExecutionError("unknown", "process did not close after termination")));
				}, CLOSE_GRACE_MS);
			};

			const onAbort = () => {
				terminate();
			};

			const reportCallbackError = (error: unknown) => {
				if (settled || callbackError) return;
				const cause = toError(error);
				callbackError = new ExecutionError("callback_error", cause.message, cause);
				terminate();
			};

			const captureChunk = (stream: "stdout" | "stderr", chunk: string) => {
				if (settled || callbackError || overflowError || timedOut || abortSignal?.aborted) return;
				const chunkBytes = Buffer.byteLength(chunk, "utf8");
				if (capturedBytes + chunkBytes > MAX_CAPTURED_OUTPUT_BYTES) {
					overflowError = new ExecutionError(
						"unknown",
						`Execution output exceeded the ${MAX_CAPTURED_OUTPUT_BYTES}-byte (64 MiB) capture limit; process terminated`,
					);
					terminate();
					return;
				}
				capturedBytes += chunkBytes;
				if (stream === "stdout") {
					stdout += chunk;
					try {
						options?.onStdout?.(chunk);
					} catch (error) {
						reportCallbackError(error);
					}
				} else {
					stderr += chunk;
					try {
						options?.onStderr?.(chunk);
					} catch (error) {
						reportCallbackError(error);
					}
				}
			};

			const onStdoutData = (chunk: string) => {
				captureChunk("stdout", chunk);
			};
			const onStderrData = (chunk: string) => {
				captureChunk("stderr", chunk);
			};

			const onClose = (code: number | null) => {
				const failure = failureResult();
				if (failure) {
					settle(failure);
					return;
				}
				settle(ok({ stdout, stderr, exitCode: code ?? 0 }));
			};

			try {
				const commandFromStdin = shellConfig.value.commandTransport === "stdin";
				child = spawn(
					shellConfig.value.shell,
					commandFromStdin ? shellConfig.value.args : [...shellConfig.value.args, command],
					{
						cwd,
						detached: process.platform !== "win32",
						env: getShellEnv(this.shellEnv, options?.env),
						stdio: [commandFromStdin ? "pipe" : "ignore", "pipe", "pipe"],
						windowsHide: true,
					},
				);
				if (commandFromStdin) {
					child.stdin?.on("error", () => {});
					child.stdin?.end(command);
				}
			} catch (error) {
				const cause = toError(error);
				settle(err(new ExecutionError("spawn_error", cause.message, cause)));
				return;
			}

			timeoutId =
				timeoutMs !== undefined
					? setTimeout(() => {
							timedOut = true;
							terminate();
						}, timeoutMs)
					: undefined;

			if (abortSignal) {
				if (abortSignal.aborted) {
					onAbort();
				} else {
					abortSignal.addEventListener("abort", onAbort, { once: true });
				}
			}

			child.stdout?.setEncoding("utf8");
			child.stderr?.setEncoding("utf8");
			child.stdout?.on("data", onStdoutData);
			child.stderr?.on("data", onStderrData);

			// Keep late stream errors observable without turning them into uncaught exceptions.
			const onStreamError = (error: Error) => {
				if (settled) return;
				const failure = failureResult();
				terminate();
				settle(failure ?? err(new ExecutionError("spawn_error", error.message, error)));
			};
			child.stdout?.on("error", onStreamError);
			child.stderr?.on("error", onStreamError);

			child.on("error", (error) => {
				if (settled) return;
				settle(err(new ExecutionError("spawn_error", error.message, error)));
			});

			child.on("close", onClose);
		});
	}

	async readTextFile(path: string, abortSignal?: AbortSignal): Promise<Result<string, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<string>(abortSignal, resolved);
		if (aborted) return aborted;
		try {
			return ok(await readFile(resolved, { encoding: "utf8", signal: abortSignal }));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async readTextLines(
		path: string,
		options?: { maxLines?: number; abortSignal?: AbortSignal },
	): Promise<Result<string[], FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<string[]>(options?.abortSignal, resolved);
		if (aborted) return aborted;
		if (options?.maxLines !== undefined && options.maxLines <= 0) return ok([]);
		let stream: ReturnType<typeof createReadStream> | undefined;
		let lineReader: ReturnType<typeof createInterface> | undefined;
		try {
			stream = createReadStream(resolved, { encoding: "utf8", signal: options?.abortSignal });
			lineReader = createInterface({ input: stream, crlfDelay: Infinity });
			const lines: string[] = [];
			for await (const line of lineReader) {
				const loopAbort = abortResult<string[]>(options?.abortSignal, resolved);
				if (loopAbort) return loopAbort;
				lines.push(line);
				if (options?.maxLines !== undefined && lines.length >= options.maxLines) break;
			}
			const afterReadAbort = abortResult<string[]>(options?.abortSignal, resolved);
			if (afterReadAbort) return afterReadAbort;
			return ok(lines);
		} catch (error) {
			return err(toFileError(error, resolved));
		} finally {
			lineReader?.close();
			stream?.destroy();
		}
	}

	async readBinaryFile(path: string, abortSignal?: AbortSignal): Promise<Result<Uint8Array, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<Uint8Array>(abortSignal, resolved);
		if (aborted) return aborted;
		try {
			return ok(await readFile(resolved, { signal: abortSignal }));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async writeFile(
		path: string,
		content: string | Uint8Array,
		abortSignal?: AbortSignal,
	): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<void>(abortSignal, resolved);
		if (aborted) return aborted;
		try {
			await mkdir(resolve(resolved, ".."), { recursive: true });
			const afterMkdirAbort = abortResult<void>(abortSignal, resolved);
			if (afterMkdirAbort) return afterMkdirAbort;
			await writeFile(resolved, content, { signal: abortSignal });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async appendFile(path: string, content: string | Uint8Array): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			await mkdir(resolve(resolved, ".."), { recursive: true });
			await appendFile(resolved, content);
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async fileInfo(path: string): Promise<Result<FileInfo, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			return fileInfoFromStats(resolved, await lstat(resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async listDir(path: string, abortSignal?: AbortSignal): Promise<Result<FileInfo[], FileError>> {
		const resolved = resolvePath(this.cwd, path);
		const aborted = abortResult<FileInfo[]>(abortSignal, resolved);
		if (aborted) return aborted;
		try {
			const entries = await readdir(resolved, { withFileTypes: true });
			const infos: FileInfo[] = [];
			for (const entry of entries) {
				const loopAbort = abortResult<FileInfo[]>(abortSignal, resolved);
				if (loopAbort) return loopAbort;
				const entryPath = resolve(resolved, entry.name);
				try {
					const info = fileInfoFromStats(entryPath, await lstat(entryPath));
					if (info.ok) infos.push(info.value);
				} catch (error) {
					return err(toFileError(error, entryPath));
				}
			}
			return ok(infos);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async canonicalPath(path: string): Promise<Result<string, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			return ok(await realpath(resolved));
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async exists(path: string): Promise<Result<boolean, FileError>> {
		const result = await this.fileInfo(path);
		if (result.ok) return ok(true);
		if (result.error.code === "not_found") return ok(false);
		return err(result.error);
	}

	async createDir(path: string, options?: { recursive?: boolean }): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			await mkdir(resolved, { recursive: options?.recursive ?? true });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async remove(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<Result<void, FileError>> {
		const resolved = resolvePath(this.cwd, path);
		try {
			await rm(resolved, { recursive: options?.recursive ?? false, force: options?.force ?? false });
			return ok(undefined);
		} catch (error) {
			return err(toFileError(error, resolved));
		}
	}

	async createTempDir(prefix: string = "tmp-"): Promise<Result<string, FileError>> {
		try {
			return ok(await mkdtemp(join(tmpdir(), prefix)));
		} catch (error) {
			return err(toFileError(error));
		}
	}

	async createTempFile(options?: { prefix?: string; suffix?: string }): Promise<Result<string, FileError>> {
		const dir = await this.createTempDir("tmp-");
		if (!dir.ok) return dir;
		const filePath = join(dir.value, `${options?.prefix ?? ""}${randomUUID()}${options?.suffix ?? ""}`);
		try {
			await writeFile(filePath, "");
			return ok(filePath);
		} catch (error) {
			return err(toFileError(error, filePath));
		}
	}

	async cleanup(): Promise<void> {
		// nothing to clean up for the local node implementation
	}
}
