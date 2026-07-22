import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { isBunBinary } from "../config.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../utils/shell.ts";
import type { SandboxGrant } from "./permission-policy.ts";
import type { RunWrappedSandboxCommand, SandboxedCommandInput } from "./sandbox-runtime.ts";

const INTERNAL_WORKER_FLAG = "--internal-windows-sandbox-worker";
const MAX_FRAME_BYTES = 1024 * 1024;
const STARTUP_WATCHDOG_MS = 60_000;
const SETUP_WATCHDOG_MS = 5 * 60_000;
const CLEANUP_WATCHDOG_MS = 5_000;

type HostFrame =
	| {
			type: "start";
			requestId: string;
			agentDir: string;
			command: string;
			shell: string;
			cwd: string;
			grant: SandboxGrant;
	  }
	| { type: "setup_decision"; requestId: string; approved: boolean }
	| { type: "finish"; requestId: string }
	| { type: "abort"; requestId: string };

type WorkerFrame =
	| { type: "setup_required"; requestId: string }
	| { type: "wrapped"; requestId: string; argv: string[]; env: NodeJS.ProcessEnv }
	| { type: "finished"; requestId: string }
	| {
			type: "error";
			requestId: string;
			phase: "setup" | "initialize" | "wrap" | "cleanup" | "protocol";
			message: string;
	  };

export type WindowsSandboxWorkerProcess = ChildProcessWithoutNullStreams;
export type WindowsSandboxWorkerLauncher = () => WindowsSandboxWorkerProcess;

export interface WindowsSandboxWorkerLaunch {
	readonly command: string;
	readonly args: readonly string[];
	readonly env: NodeJS.ProcessEnv;
}

function plainRecord(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null ? (value as Record<string, unknown>) : undefined;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(record).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validGrant(value: unknown): value is SandboxGrant {
	const grant = plainRecord(value);
	if (
		!grant ||
		!exactKeys(grant, [
			"actionId",
			"sandbox",
			"denyReadPaths",
			"capabilityReadPaths",
			"capabilityWritePaths",
			"readPaths",
			"writePaths",
			"networkTargets",
			"fullOnce",
		])
	) {
		return false;
	}
	if (typeof grant.actionId !== "string" || grant.actionId.length === 0) return false;
	if (!new Set(["none", "read-only", "workspace-write", "exact"]).has(String(grant.sandbox))) return false;
	if (typeof grant.fullOnce !== "boolean") return false;
	if (!Array.isArray(grant.denyReadPaths) || !grant.denyReadPaths.every((path) => typeof path === "string"))
		return false;
	if (
		!Array.isArray(grant.capabilityReadPaths) ||
		!grant.capabilityReadPaths.every((path) => typeof path === "string")
	) {
		return false;
	}
	if (
		!Array.isArray(grant.capabilityWritePaths) ||
		!grant.capabilityWritePaths.every((path) => typeof path === "string")
	) {
		return false;
	}
	if (!Array.isArray(grant.readPaths) || !grant.readPaths.every((path) => typeof path === "string")) return false;
	if (!Array.isArray(grant.writePaths) || !grant.writePaths.every((path) => typeof path === "string")) return false;
	if (!Array.isArray(grant.networkTargets)) return false;
	return grant.networkTargets.every((value) => {
		const target = plainRecord(value);
		return (
			target !== undefined &&
			exactKeys(target, ["host", "port"]) &&
			typeof target.host === "string" &&
			Number.isInteger(target.port)
		);
	});
}

function parseHostFrame(line: string): HostFrame {
	const record = plainRecord(JSON.parse(line));
	if (!record || typeof record.type !== "string" || typeof record.requestId !== "string" || !record.requestId) {
		throw new Error("Invalid host frame");
	}
	if (record.type === "start") {
		if (!exactKeys(record, ["type", "requestId", "agentDir", "command", "shell", "cwd", "grant"])) {
			throw new Error("Invalid start frame");
		}
		if (
			typeof record.agentDir !== "string" ||
			!isAbsolute(record.agentDir) ||
			typeof record.cwd !== "string" ||
			!isAbsolute(record.cwd) ||
			typeof record.command !== "string" ||
			typeof record.shell !== "string" ||
			!validGrant(record.grant)
		) {
			throw new Error("Invalid start frame");
		}
		return record as unknown as HostFrame;
	}
	if (record.type === "setup_decision") {
		if (!exactKeys(record, ["type", "requestId", "approved"]) || typeof record.approved !== "boolean") {
			throw new Error("Invalid setup decision frame");
		}
		return record as unknown as HostFrame;
	}
	if (record.type === "finish" || record.type === "abort") {
		if (!exactKeys(record, ["type", "requestId"])) throw new Error(`Invalid ${record.type} frame`);
		return record as unknown as HostFrame;
	}
	throw new Error("Unknown host frame");
}

function parseWorkerFrame(line: string): WorkerFrame {
	const record = plainRecord(JSON.parse(line));
	if (!record || typeof record.type !== "string" || typeof record.requestId !== "string" || !record.requestId) {
		throw new Error("Invalid worker frame");
	}
	if (record.type === "setup_required" || record.type === "finished") {
		if (!exactKeys(record, ["type", "requestId"])) throw new Error(`Invalid ${record.type} frame`);
		return record as WorkerFrame;
	}
	if (record.type === "wrapped") {
		if (!exactKeys(record, ["type", "requestId", "argv", "env"])) throw new Error("Invalid wrapped frame");
		if (
			!Array.isArray(record.argv) ||
			record.argv.length === 0 ||
			!record.argv.every((value) => typeof value === "string")
		) {
			throw new Error("Invalid wrapped argv");
		}
		const env = plainRecord(record.env);
		if (!env || !Object.values(env).every((value) => typeof value === "string"))
			throw new Error("Invalid wrapped env");
		return record as unknown as WorkerFrame;
	}
	if (record.type === "error") {
		if (!exactKeys(record, ["type", "requestId", "phase", "message"])) throw new Error("Invalid error frame");
		if (
			!new Set(["setup", "initialize", "wrap", "cleanup", "protocol"]).has(String(record.phase)) ||
			typeof record.message !== "string"
		) {
			throw new Error("Invalid error frame");
		}
		return record as WorkerFrame;
	}
	throw new Error("Unknown worker frame");
}

function writeFrame(stream: NodeJS.WritableStream, frame: HostFrame | WorkerFrame): void {
	const line = `${JSON.stringify(frame)}\n`;
	if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) throw new Error("Sandbox worker protocol frame is too large");
	stream.write(line);
}

function attachFrameReader(
	stream: NodeJS.ReadableStream,
	parse: (line: string) => HostFrame | WorkerFrame,
	onFrame: (frame: HostFrame | WorkerFrame) => void,
	onError: (error: Error) => void,
): () => void {
	let buffer = Buffer.alloc(0);
	const onData = (chunk: Buffer | string) => {
		buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
		if (buffer.byteLength > MAX_FRAME_BYTES) {
			onError(new Error("Sandbox worker protocol frame is too large"));
			return;
		}
		for (;;) {
			const newline = buffer.indexOf(0x0a);
			if (newline < 0) break;
			const line = buffer.subarray(0, newline).toString("utf8");
			buffer = buffer.subarray(newline + 1);
			if (!line) continue;
			try {
				onFrame(parse(line));
			} catch (error) {
				onError(error instanceof Error ? error : new Error(String(error)));
			}
		}
	};
	stream.on("data", onData);
	return () => stream.removeListener("data", onData);
}

export function resolveWindowsSandboxWorkerLaunch(
	input: {
		readonly execPath?: string;
		readonly cliPath?: string;
		readonly compiledBinary?: boolean;
		readonly electron?: boolean;
		readonly env?: NodeJS.ProcessEnv;
	} = {},
): WindowsSandboxWorkerLaunch {
	const execPath = input.execPath ?? process.execPath;
	const compiledBinary = input.compiledBinary ?? isBunBinary;
	const cliPath = input.cliPath ?? fileURLToPath(new URL("../cli.js", import.meta.url));
	return {
		command: execPath,
		args: compiledBinary ? [INTERNAL_WORKER_FLAG] : [cliPath, INTERNAL_WORKER_FLAG],
		env: {
			...(input.env ?? process.env),
			...((input.electron ?? process.versions.electron !== undefined) ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
		},
	};
}

export function launchWindowsSandboxWorker(): WindowsSandboxWorkerProcess {
	const launch = resolveWindowsSandboxWorkerLaunch();
	return spawn(launch.command, launch.args, {
		env: launch.env,
		windowsHide: true,
		shell: false,
		stdio: ["pipe", "pipe", "pipe"],
	});
}

function watchdog<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(message)), milliseconds);
		void promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

export async function executeWindowsSandboxWorker<T>(
	input: SandboxedCommandInput,
	run: RunWrappedSandboxCommand<T>,
	options: {
		readonly agentDir: string;
		readonly requestSetup?: () => Promise<boolean>;
		readonly launcher?: WindowsSandboxWorkerLauncher;
	},
): Promise<T> {
	if (input.signal?.aborted) throw input.signal.reason ?? new Error("Operation aborted");
	const requestId = randomUUID();
	const worker = (options.launcher ?? launchWindowsSandboxWorker)();
	if (worker.pid) trackDetachedChildPid(worker.pid);
	let settled = false;
	const queued: WorkerFrame[] = [];
	let waiter:
		| {
				readonly expected: ReadonlySet<WorkerFrame["type"]>;
				resolve(frame: WorkerFrame): void;
				reject(error: Error): void;
		  }
		| undefined;
	const fail = (error: Error) => {
		if (settled) return;
		settled = true;
		waiter?.reject(error);
	};
	const detachReader = attachFrameReader(
		worker.stdout,
		parseWorkerFrame,
		(frame) => {
			const value = frame as WorkerFrame;
			if (value.requestId !== requestId) return fail(new Error("Sandbox worker request ID mismatch"));
			if (waiter) {
				if (!waiter.expected.has(value.type))
					return fail(new Error(`Unexpected sandbox worker frame: ${value.type}`));
				const current = waiter;
				waiter = undefined;
				current.resolve(value);
				return;
			}
			if (queued.length > 0) return fail(new Error("Duplicate sandbox worker frame"));
			queued.push(value);
		},
		fail,
	);
	const exited = new Promise<never>((_resolve, reject) => {
		worker.once("error", (error) => reject(new Error(`Windows sandbox worker failed: ${error.message}`)));
		worker.once("exit", (code, signal) =>
			reject(new Error(`Windows sandbox worker exited before completion (${code ?? signal ?? "unknown"})`)),
		);
	});
	void exited.catch(fail);
	const nextFrame = (expected: readonly WorkerFrame["type"][]): Promise<WorkerFrame> => {
		if (settled) return Promise.reject(new Error("Windows sandbox worker is unavailable"));
		const existing = queued.shift();
		if (existing) {
			return expected.includes(existing.type)
				? Promise.resolve(existing)
				: Promise.reject(new Error(`Unexpected sandbox worker frame: ${existing.type}`));
		}
		return new Promise((resolve, reject) => {
			waiter = { expected: new Set(expected), resolve, reject };
		});
	};
	const terminate = () => {
		if (worker.pid) killProcessTree(worker.pid);
	};
	const linked = new AbortController();
	const aborted = new Promise<never>((_resolve, reject) => {
		linked.signal.addEventListener(
			"abort",
			() => reject(linked.signal.reason instanceof Error ? linked.signal.reason : new Error("Operation aborted")),
			{ once: true },
		);
	});
	void aborted.catch(() => undefined);
	const abort = () => {
		if (!linked.signal.aborted) linked.abort(input.signal?.reason ?? new Error("Operation aborted"));
		try {
			writeFrame(worker.stdin, { type: "abort", requestId });
		} catch {
			terminate();
		}
	};
	input.signal?.addEventListener("abort", abort, { once: true });
	let commandError: unknown;
	let result: T | undefined;
	try {
		writeFrame(worker.stdin, {
			type: "start",
			requestId,
			agentDir: options.agentDir,
			command: input.command,
			shell: input.shell,
			cwd: input.cwd,
			grant: input.grant,
		});
		let frame = await Promise.race([
			watchdog(
				nextFrame(["setup_required", "wrapped", "error"]),
				STARTUP_WATCHDOG_MS,
				"Windows sandbox worker timed out during setup or wrapping",
			),
			exited,
			aborted,
		]);
		if (frame.type === "setup_required") {
			const approved = options.requestSetup ? await Promise.race([options.requestSetup(), exited, aborted]) : false;
			writeFrame(worker.stdin, { type: "setup_decision", requestId, approved });
			frame = await Promise.race([
				watchdog(
					nextFrame(["wrapped", "error"]),
					approved ? SETUP_WATCHDOG_MS : STARTUP_WATCHDOG_MS,
					approved
						? "Windows sandbox worker timed out during approved provisioning"
						: "Windows sandbox setup denial did not settle",
				),
				exited,
				aborted,
			]);
		}
		if (frame.type === "error") throw new Error(`Windows sandbox ${frame.phase} failed: ${frame.message}`);
		if (frame.type !== "wrapped") throw new Error(`Unexpected sandbox worker frame: ${frame.type}`);
		const runPromise = run({ argv: frame.argv, env: frame.env, signal: linked.signal });
		try {
			result = await Promise.race([runPromise, exited, aborted]);
		} catch (error) {
			commandError = error;
		}
		if (!settled) {
			if (!input.signal?.aborted) writeFrame(worker.stdin, { type: "finish", requestId });
			const finished = await Promise.race([
				watchdog(
					nextFrame(["finished", "error"]),
					CLEANUP_WATCHDOG_MS,
					"Windows sandbox worker timed out during cleanup",
				),
				exited,
			]);
			if (finished.type === "error") {
				const cleanupError = new Error(`Windows sandbox ${finished.phase} failed: ${finished.message}`);
				if (commandError !== undefined)
					throw new AggregateError([commandError, cleanupError], "Command and sandbox cleanup failed");
				throw cleanupError;
			}
		}
		if (input.signal?.aborted) throw input.signal.reason ?? new Error("Operation aborted");
		if (commandError !== undefined) throw commandError;
		if (result === undefined) throw new Error("Sandbox command completed without a result");
		return result;
	} catch (error) {
		if (!linked.signal.aborted) linked.abort(error);
		terminate();
		throw error;
	} finally {
		settled = true;
		detachReader();
		input.signal?.removeEventListener("abort", abort);
		worker.stdin.destroy();
		if (worker.pid) untrackDetachedChildPid(worker.pid);
	}
}

function workerErrorMessage(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return Buffer.from(message, "utf8").subarray(0, 4096).toString("utf8") || "Unknown worker error";
}

function windowsStatusComplete(status: {
	provisioned: boolean;
	groupExists: boolean;
	inBuiltinUsers: boolean;
	inSandboxGroup: boolean;
	hiddenFromLogon: boolean;
	credPresent: boolean;
	markerVersion?: number;
}): boolean {
	return (
		status.provisioned &&
		status.groupExists &&
		status.inBuiltinUsers &&
		status.inSandboxGroup &&
		status.hiddenFromLogon &&
		status.credPresent &&
		(status.markerVersion ?? 0) > 0
	);
}

export async function runWindowsSandboxWorker(): Promise<void> {
	let requestId = "protocol";
	let state: "initial" | "starting" | "setup" | "wrapped" | "finishing" | "done" = "initial";
	let setupDecision: ((approved: boolean) => void) | undefined;
	let finish: ((aborted: boolean) => void) | undefined;
	const abortController = new AbortController();
	const send = (frame: WorkerFrame) => writeFrame(process.stdout, frame);
	const protocolError = (message: string) => {
		send({ type: "error", requestId, phase: "protocol", message });
		abortController.abort(new Error(message));
		finish?.(true);
	};
	const detach = attachFrameReader(
		process.stdin,
		parseHostFrame,
		(frame) => {
			const value = frame as HostFrame;
			if (state === "initial" && value.type === "start") {
				requestId = value.requestId;
				state = "starting";
				void handleStart(value);
				return;
			}
			if (value.requestId !== requestId) return protocolError("Sandbox worker request ID mismatch");
			if (state === "setup" && value.type === "setup_decision") {
				state = "starting";
				setupDecision?.(value.approved);
				setupDecision = undefined;
				return;
			}
			if (state === "wrapped" && value.type === "finish") {
				state = "finishing";
				finish?.(false);
				finish = undefined;
				return;
			}
			if (value.type === "abort" && state !== "done") {
				if (state === "wrapped") state = "finishing";
				abortController.abort(new Error("Operation aborted"));
				setupDecision?.(false);
				finish?.(true);
				setupDecision = undefined;
				finish = undefined;
				return;
			}
			protocolError(`Unexpected host frame ${value.type} in ${state}`);
		},
		(error) => protocolError(workerErrorMessage(error)),
	);
	process.stdin.once("end", () => {
		abortController.abort(new Error("Host disconnected"));
		setupDecision?.(false);
		finish?.(true);
	});

	async function handleStart(start: Extract<HostFrame, { type: "start" }>): Promise<void> {
		let release: (() => Promise<void>) | undefined;
		let managerTouched = false;
		let phase: Extract<WorkerFrame, { type: "error" }>["phase"] = "setup";
		let primaryError: unknown;
		let reachedWrapped = false;
		try {
			const runtime = await import("./sandbox-runtime.ts");
			release = await runtime.createSandboxRuntimeLock(start.agentDir)();
			const windows = runtime.createDefaultWindowsSandboxAdapter();
			if (!windowsStatusComplete(windows.getStatus())) {
				state = "setup";
				send({ type: "setup_required", requestId });
				const approved = await new Promise<boolean>((resolve) => {
					setupDecision = resolve;
				});
				if (!approved) throw new Error("Windows sandbox setup was denied");
				const installed = windows.install();
				if (installed.cancelled || !windowsStatusComplete(installed.user)) {
					throw new Error(
						installed.cancelled
							? "Windows sandbox setup was cancelled"
							: "Windows sandbox setup did not complete",
					);
				}
			}
			phase = "initialize";
			managerTouched = true;
			await SandboxManager.reset();
			const config = runtime.buildSandboxRuntimeConfig(start.grant, start.cwd);
			await SandboxManager.initialize(config, async (target) =>
				runtime.networkTargetMatches(start.grant.networkTargets, target),
			);
			const dependencies = SandboxManager.checkDependencies(config.ripgrep);
			if (dependencies.errors.length > 0) {
				throw new Error(`SRT dependencies are missing: ${dependencies.errors.join("; ")}`);
			}
			phase = "wrap";
			const wrapped = await SandboxManager.wrapWithSandboxArgv(
				start.command,
				start.shell,
				undefined,
				abortController.signal,
				start.cwd,
			);
			if (!wrapped.argv[0]) throw new Error("SRT returned an empty command");
			state = "wrapped";
			reachedWrapped = true;
			send({ type: "wrapped", requestId, argv: wrapped.argv, env: wrapped.env });
			await new Promise<boolean>((resolve) => {
				finish = resolve;
			});
		} catch (error) {
			primaryError = error;
		} finally {
			const cleanupErrors: unknown[] = [];
			if (managerTouched) {
				try {
					await SandboxManager.cleanupAfterCommand();
				} catch (error) {
					cleanupErrors.push(error);
				}
				try {
					await SandboxManager.reset();
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
			if (release) {
				try {
					await release();
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
			state = "done";
			if (primaryError !== undefined) {
				send({ type: "error", requestId, phase, message: workerErrorMessage(primaryError) });
			} else if (cleanupErrors.length > 0) {
				send({
					type: "error",
					requestId,
					phase: "cleanup",
					message: cleanupErrors.map(workerErrorMessage).join("; "),
				});
			} else if (reachedWrapped) {
				send({ type: "finished", requestId });
			}
			detach();
			process.stdin.pause();
		}
	}
}

export const windowsSandboxWorkerTestHelpers = {
	INTERNAL_WORKER_FLAG,
	MAX_FRAME_BYTES,
	parseHostFrame,
	parseWorkerFrame,
};
