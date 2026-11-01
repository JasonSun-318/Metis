import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { getPackageDir, isBunBinary } from "../config.ts";
import { spawnProcess } from "../utils/child-process.ts";
import { canonicalizeActionPath, isPathInside, pathsIntersect } from "../utils/paths.ts";
import { killProcessTree } from "../utils/shell.ts";
import type { BashOperations } from "./tools/bash.ts";
import {
	createSandboxHealthReport,
	readinessRecoveryActions,
	selfTestRecoveryActions,
	skippedSandboxChecks,
	type WorkspaceSandboxCheck,
	type WorkspaceSandboxCheckId,
	type WorkspaceSandboxHealthReport,
	workspaceSandboxHealth,
} from "./workspace-sandbox-health.ts";

export type {
	WorkspaceSandboxCheck,
	WorkspaceSandboxCheckId,
	WorkspaceSandboxCheckReason,
	WorkspaceSandboxCheckStatus,
	WorkspaceSandboxHealthCode,
	WorkspaceSandboxHealthMode,
	WorkspaceSandboxHealthReport,
	WorkspaceSandboxHealthStatus,
	WorkspaceSandboxRecoveryAction,
} from "./workspace-sandbox-health.ts";

import {
	normalizeSandboxNetworkEndpoints,
	parseSandboxResponse,
	type SandboxErrorCode,
	type SandboxRequest,
	type SandboxResponse,
} from "./workspace-sandbox-protocol.ts";

const CONTROL_TIMEOUT_MS = 5_000;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 2_147_483_647;

export class WorkspaceSandboxError extends Error {
	readonly code: SandboxErrorCode;

	constructor(code: SandboxErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorkspaceSandboxError";
		this.code = code;
	}
}

export interface WorkspaceSandbox {
	readonly operations: BashOperations;
	dispose(): Promise<void>;
	forceDispose(): void;
}

export const WorkspaceSandbox = Object.freeze({
	health: (): Promise<WorkspaceSandboxHealthReport> => workspaceSandboxHealth(),
	selfTest: (): Promise<WorkspaceSandboxHealthReport> => workspaceSandboxSelfTest(),
});

type PendingCommand = {
	id: string;
	onData: (data: Buffer) => void;
	resolve: (result: { exitCode: number | null }) => void;
	reject: (error: Error) => void;
	settled: boolean;
	cancellationError?: Error;
	timeoutHandle?: NodeJS.Timeout;
	signal?: AbortSignal;
	onAbort?: () => void;
};

function brokerEntry(): string {
	const sibling = fileURLToPath(new URL("./workspace-sandbox-broker.js", import.meta.url));
	return existsSync(sibling) ? sibling : join(getPackageDir(), "dist", "core", "workspace-sandbox-broker.js");
}

function brokerWorkerEntry(): URL {
	return new URL("./workspace-sandbox-worker.js", import.meta.url);
}

function minimalEnvironment(temporaryDir: string, preferred?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const source = { ...process.env, ...preferred };
	const environment: NodeJS.ProcessEnv = {};
	for (const key of [
		"PATH",
		"Path",
		"HOME",
		"USERPROFILE",
		"LOCALAPPDATA",
		"APPDATA",
		"LANG",
		"LC_ALL",
		"LC_CTYPE",
		"TZ",
		"SystemRoot",
		"WINDIR",
		"ComSpec",
		"PATHEXT",
		"ProgramFiles",
		"ProgramFiles(x86)",
		"ProgramData",
		"METIS_WORK_DIR",
		"METIS_ATTACHMENTS_DIR",
		"OFFICECLI_SKIP_UPDATE",
		"OFFICECLI_NO_AUTO_INSTALL",
		"OFFICECLI_NO_AUTO_RESIDENT",
	]) {
		if (source[key] !== undefined) environment[key] = source[key];
	}
	const commandTemporaryDir = source.METIS_WORK_DIR ?? temporaryDir;
	environment.TMPDIR = commandTemporaryDir;
	environment.TMP = commandTemporaryDir;
	environment.TEMP = commandTemporaryDir;
	environment.METIS_SANDBOX_TEMP_DIR = temporaryDir;
	return environment;
}

function controlTimeout<T>(promise: Promise<T>, message: string, timeoutMs = CONTROL_TIMEOUT_MS): Promise<T> {
	return new Promise((resolve, reject) => {
		const handle = setTimeout(() => reject(new WorkspaceSandboxError("SANDBOX_CLOSED", message)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(handle);
				resolve(value);
			},
			(error) => {
				clearTimeout(handle);
				reject(error);
			},
		);
	});
}

class SandboxBroker {
	private readonly child: ChildProcess | Worker;
	private readonly temporaryDir: string;
	private readonly readyPromise: Promise<void>;
	private readyResolve!: () => void;
	private readyReject!: (error: Error) => void;
	private readonly closedPromise: Promise<void>;
	private closedResolve!: () => void;
	private closedReject!: (error: Error) => void;
	private readonly processClosedPromise: Promise<void>;
	private processClosedResolve!: () => void;
	private stdoutBuffer = "";
	private readonly decoder = new StringDecoder("utf8");
	private pending?: PendingCommand;
	private ready = false;
	private closing = false;
	private dead = false;
	private closeTask?: Promise<void>;
	private hostAbort?: () => void;
	private hostSignal?: AbortSignal;

	private constructor(child: ChildProcess | Worker, temporaryDir: string) {
		this.child = child;
		this.temporaryDir = temporaryDir;
		this.readyPromise = new Promise((resolve, reject) => {
			this.readyResolve = resolve;
			this.readyReject = reject;
		});
		this.closedPromise = new Promise((resolve, reject) => {
			this.closedResolve = resolve;
			this.closedReject = reject;
		});
		void this.closedPromise.catch(() => {});
		this.processClosedPromise = new Promise((resolve) => {
			this.processClosedResolve = resolve;
		});
		child.stdout?.on("data", (chunk: Buffer) => this.onStdout(chunk));
		child.stderr?.on("data", () => {});
		child.once("error", (error) => this.fail("SANDBOX_UNAVAILABLE", "Could not start sandbox broker", error));
		child.once("exit", (code) => {
			if (!this.dead && !(this.closing && code === 0)) {
				this.fail("SANDBOX_CLOSED", "Sandbox broker exited unexpectedly");
			}
		});
		if (child instanceof Worker) child.once("exit", () => this.processClosedResolve());
		else child.once("close", () => this.processClosedResolve());
	}

	static async start(input: {
		cwd: string;
		workspaceRoots: readonly string[];
		readOnlyRoots?: readonly string[];
		writeRoots?: readonly string[];
		protectedRoots?: readonly string[];
		writeProtectedRoots?: readonly string[];
		networkEndpoints?: readonly { readonly hostname: string; readonly port: number }[];
		shellPath?: string;
		workspaceReadOnly?: boolean;
		signal?: AbortSignal;
	}): Promise<SandboxBroker> {
		if (input.signal?.aborted) throw new Error("aborted");
		const allRoots = [
			...input.workspaceRoots,
			...(input.readOnlyRoots ?? []),
			...(input.writeRoots ?? []),
			...(input.protectedRoots ?? []),
			...(input.writeProtectedRoots ?? []),
		];
		if (
			!isAbsolute(input.cwd) ||
			input.cwd.includes("\0") ||
			input.workspaceRoots.length === 0 ||
			allRoots.some((root) => !root || !isAbsolute(root) || root.includes("\0"))
		) {
			throw new TypeError("Workspace sandbox paths must be absolute and non-empty");
		}
		const cwd = canonicalizeActionPath(input.cwd, input.cwd);
		const normalizeRoots = (roots: readonly string[]) => [
			...new Set(roots.map((root) => canonicalizeActionPath(root, root))),
		];
		const workspaceRoots = normalizeRoots(input.workspaceRoots);
		const readOnlyRoots = normalizeRoots(input.readOnlyRoots ?? []);
		const writeRoots = normalizeRoots(input.writeRoots ?? []);
		const protectedRoots = normalizeRoots(input.protectedRoots ?? []);
		const writeProtectedRoots = normalizeRoots(input.writeProtectedRoots ?? []);
		const networkEndpoints = normalizeSandboxNetworkEndpoints(input.networkEndpoints ?? []);
		for (const protectedRoot of protectedRoots) {
			if ([...workspaceRoots, ...writeRoots].some((root) => pathsIntersect(root, protectedRoot))) {
				throw new TypeError("Workspace sandbox write roots overlap a protected root");
			}
			if (readOnlyRoots.some((root) => isPathInside(root, protectedRoot))) {
				throw new TypeError("Workspace sandbox read roots expose a protected root");
			}
		}
		for (const protectedRoot of writeProtectedRoots) {
			// A broader granted directory may contain protected metadata. The
			// broker's denyWrite exclusions remain authoritative for those children.
			if (writeRoots.some((root) => isPathInside(protectedRoot, root))) {
				throw new TypeError("Workspace sandbox write roots overlap a protected root");
			}
		}
		if (!workspaceRoots.some((root) => isPathInside(root, cwd))) {
			throw new TypeError("Workspace sandbox cwd must be inside a workspace root");
		}
		let shellPath: string | undefined;
		if (input.shellPath !== undefined) {
			if (!input.shellPath || !isAbsolute(input.shellPath) || input.shellPath.includes("\0")) {
				throw new TypeError("Workspace sandbox shell path must be absolute");
			}
			shellPath = canonicalizeActionPath(input.shellPath, input.shellPath);
			if (!statSync(shellPath).isFile()) throw new TypeError("Workspace sandbox shell path must be a file");
		}

		const temporaryDir = canonicalizeActionPath(mkdtempSync(join(tmpdir(), "metis-sandbox-")), input.cwd);
		const environment = minimalEnvironment(temporaryDir);
		// ponytail: Electron disables RunAsNode, so use a per-run Worker; bundle Node only if native crash containment is required.
		const child =
			typeof process.versions.electron === "string" && !isBunBinary
				? new Worker(brokerWorkerEntry(), {
						execArgv: [],
						env: environment,
						stdin: true,
						stdout: true,
						stderr: true,
					})
				: (() => {
						const target = isBunBinary
							? { command: process.execPath, args: ["--internal-workspace-sandbox-broker"] }
							: { command: process.execPath, args: [brokerEntry()] };
						return spawnProcess(target.command, target.args, {
							detached: process.platform !== "win32",
							env: environment,
							stdio: ["pipe", "pipe", "pipe"],
							windowsHide: true,
						});
					})();
		const broker = new SandboxBroker(child, temporaryDir);
		if (input.signal) {
			broker.hostAbort = () => broker.fail("SANDBOX_CLOSED", "Sandbox execution was aborted");
			broker.hostSignal = input.signal;
			input.signal.addEventListener("abort", broker.hostAbort, { once: true });
		}
		try {
			broker.send({
				type: "init",
				cwd,
				workspaceRoots,
				readOnlyRoots,
				writeRoots,
				protectedRoots,
				writeProtectedRoots,
				networkEndpoints,
				...(shellPath ? { shellPath } : {}),
				...(input.workspaceReadOnly === true ? { workspaceReadOnly: true } : {}),
			});
			// Windows performs native egress checks before readiness; installed startup can exceed five seconds.
			await controlTimeout(
				broker.readyPromise,
				"Sandbox initialization timed out",
				process.platform === "win32" ? 30_000 : CONTROL_TIMEOUT_MS,
			);
			return broker;
		} catch (error) {
			broker.detachHostAbort();
			broker.terminate();
			rmSync(temporaryDir, { recursive: true, force: true });
			throw error;
		}
	}

	async exec(
		command: string,
		cwd: string,
		options: Parameters<BashOperations["exec"]>[2],
	): Promise<{ exitCode: number | null }> {
		if (this.dead || this.closing || !this.ready) {
			throw new WorkspaceSandboxError("SANDBOX_CLOSED", "Workspace sandbox is closed");
		}
		if (this.pending)
			throw new WorkspaceSandboxError("SANDBOX_PROTOCOL", "Workspace sandbox command already running");
		if (options.signal?.aborted) throw new Error("aborted");
		const canonicalCwd = canonicalizeActionPath(cwd, cwd);
		const timeoutMs = options.timeout === undefined ? undefined : options.timeout * 1000;
		if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS)) {
			throw new Error("Invalid timeout: must be a positive finite number of seconds");
		}

		return new Promise((resolve, reject) => {
			const pending: PendingCommand = {
				id: options.actionId ?? randomUUID(),
				onData: options.onData,
				resolve,
				reject,
				settled: false,
				signal: options.signal,
			};
			if (options.signal) {
				pending.onAbort = () => this.cancelPending(pending, new Error("aborted"));
				options.signal.addEventListener("abort", pending.onAbort, { once: true });
			}
			if (timeoutMs !== undefined) {
				pending.timeoutHandle = setTimeout(
					() => this.cancelPending(pending, new Error(`timeout:${options.timeout}`)),
					timeoutMs,
				);
			}
			this.pending = pending;
			try {
				this.send({
					type: "exec",
					id: pending.id,
					command,
					cwd: canonicalCwd,
					...(timeoutMs === undefined ? {} : { timeoutMs }),
					env: minimalEnvironment(this.temporaryDir, options.env) as Record<string, string>,
				});
			} catch (error) {
				this.pending = undefined;
				this.cleanupPending(pending, true);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	close(): Promise<void> {
		this.closeTask ??= this.closeOnce();
		return this.closeTask;
	}

	forceClose(): void {
		if (this.dead) {
			rmSync(this.temporaryDir, { recursive: true, force: true });
			return;
		}
		this.dead = true;
		this.closing = true;
		const error = new WorkspaceSandboxError("SANDBOX_CLOSED", "Workspace sandbox was force-disposed");
		if (!this.ready) this.readyReject(error);
		if (this.pending && !this.pending.settled) {
			this.pending.settled = true;
			this.pending.reject(error);
			this.cleanupPending(this.pending, true);
		}
		this.closedReject(error);
		this.detachHostAbort();
		this.terminate();
		rmSync(this.temporaryDir, { recursive: true, force: true });
	}

	private async closeOnce(): Promise<void> {
		if (this.dead) {
			rmSync(this.temporaryDir, { recursive: true, force: true });
			return;
		}
		this.closing = true;
		if (this.pending && !this.pending.settled) {
			this.pending.settled = true;
			this.pending.reject(new WorkspaceSandboxError("SANDBOX_CLOSED", "Workspace sandbox was disposed"));
			this.cleanupPending(this.pending, false);
		}
		try {
			this.send({ type: "close" });
			await controlTimeout(this.closedPromise, "Sandbox shutdown timed out");
			this.child.stdin?.end();
			await controlTimeout(this.processClosedPromise, "Sandbox broker did not close after shutdown");
			this.child.unref();
		} catch (error) {
			this.terminate();
			throw error;
		} finally {
			this.dead = true;
			this.detachHostAbort();
			rmSync(this.temporaryDir, { recursive: true, force: true });
		}
	}

	private send(request: SandboxRequest): void {
		if (!this.child.stdin?.writable || !this.child.stdin.write(`${JSON.stringify(request)}\n`)) {
			if (!this.child.stdin?.writable) {
				throw new WorkspaceSandboxError("SANDBOX_CLOSED", "Sandbox broker input is closed");
			}
		}
	}

	private onStdout(chunk: Buffer): void {
		if (this.dead) return;
		this.stdoutBuffer += this.decoder.write(chunk);
		if (Buffer.byteLength(this.stdoutBuffer, "utf8") > MAX_LINE_BYTES && !this.stdoutBuffer.includes("\n")) {
			this.fail("SANDBOX_PROTOCOL", "Sandbox broker emitted an oversized message");
			return;
		}
		let newline = this.stdoutBuffer.indexOf("\n");
		while (newline !== -1) {
			const line = this.stdoutBuffer.slice(0, newline);
			this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
			try {
				this.onResponse(parseSandboxResponse(line));
			} catch (error) {
				this.fail("SANDBOX_PROTOCOL", "Sandbox broker emitted an invalid message", error);
				return;
			}
			newline = this.stdoutBuffer.indexOf("\n");
		}
	}

	private onResponse(response: SandboxResponse): void {
		if (response.type === "ready") {
			if (this.ready || this.closing) throw new Error("Duplicate sandbox ready response");
			this.ready = true;
			this.readyResolve();
			return;
		}
		if (response.type === "closed") {
			if (!this.closing) throw new Error("Unexpected sandbox closed response");
			this.closedResolve();
			return;
		}
		if (response.type === "error" && response.id === undefined) {
			const error = new WorkspaceSandboxError(response.code, response.message);
			if (!this.ready) this.readyReject(error);
			else this.fail(response.code, response.message, error);
			return;
		}
		if (!this.ready || (response.type === "error" && response.id === undefined)) {
			throw new Error("Sandbox response arrived before initialization");
		}
		const pending = this.pending;
		if (!pending || !("id" in response) || response.id !== pending.id) {
			throw new Error("Sandbox response id does not match the active command");
		}
		if (response.type === "data") {
			if (!pending.settled && !pending.cancellationError) {
				try {
					pending.onData(Buffer.from(response.data, "base64"));
				} catch (error) {
					this.cancelPending(pending, error instanceof Error ? error : new Error(String(error)));
				}
			}
			return;
		}
		this.pending = undefined;
		this.cleanupPending(pending, true);
		if (pending.settled) return;
		pending.settled = true;
		if (pending.cancellationError) pending.reject(pending.cancellationError);
		else if (response.type === "result") pending.resolve({ exitCode: response.exitCode });
		else pending.reject(new WorkspaceSandboxError(response.code, response.message));
	}

	private cancelPending(pending: PendingCommand, error: Error): void {
		if (pending.settled || pending.cancellationError) return;
		pending.cancellationError = error;
		this.cleanupPending(pending, false);
		try {
			this.send({ type: "cancel", id: pending.id });
			pending.timeoutHandle = setTimeout(
				() => this.fail("SANDBOX_CLOSED", "Sandbox cancellation timed out"),
				CONTROL_TIMEOUT_MS,
			);
		} catch (cause) {
			this.fail("SANDBOX_CLOSED", "Sandbox cancellation failed", cause);
		}
	}

	private cleanupPending(pending: PendingCommand, terminal: boolean): void {
		if (pending.timeoutHandle) clearTimeout(pending.timeoutHandle);
		if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
		if (terminal && this.pending === pending) this.pending = undefined;
	}

	private fail(code: SandboxErrorCode, message: string, cause?: unknown): void {
		if (this.dead) return;
		this.dead = true;
		const error = new WorkspaceSandboxError(code, message, cause === undefined ? undefined : { cause });
		if (!this.ready) this.readyReject(error);
		if (this.pending && !this.pending.settled) {
			this.pending.settled = true;
			this.pending.reject(this.pending.cancellationError ?? error);
			this.cleanupPending(this.pending, true);
		}
		this.closedReject(error);
		this.detachHostAbort();
		this.terminate();
		rmSync(this.temporaryDir, { recursive: true, force: true });
	}

	private detachHostAbort(): void {
		if (this.hostSignal && this.hostAbort) this.hostSignal.removeEventListener("abort", this.hostAbort);
		this.hostAbort = undefined;
		this.hostSignal = undefined;
	}

	private terminate(): void {
		if (this.child instanceof Worker) void this.child.terminate().catch(() => undefined);
		else if (this.child.pid) killProcessTree(this.child.pid);
		this.child.stdin?.destroy();
	}
}

export async function createWorkspaceSandbox(input: {
	cwd: string;
	workspaceRoots: readonly string[];
	readOnlyRoots?: readonly string[];
	writeRoots?: readonly string[];
	protectedRoots?: readonly string[];
	writeProtectedRoots?: readonly string[];
	networkEndpoints?: readonly { readonly hostname: string; readonly port: number }[];
	shellPath?: string;
	workspaceReadOnly?: boolean;
	signal?: AbortSignal;
}): Promise<WorkspaceSandbox> {
	const broker = await SandboxBroker.start(input);
	let disposed = false;
	return {
		operations: { exec: (command, cwd, options) => broker.exec(command, cwd, options) },
		dispose: async () => {
			if (disposed) return;
			disposed = true;
			await broker.close();
		},
		forceDispose: () => {
			disposed = true;
			broker.forceClose();
		},
	};
}

const SELF_TEST_TIMEOUT_SECONDS = 8;
const SELF_TEST_CHECKS: readonly WorkspaceSandboxCheckId[] = [
	"sandbox-startup",
	"filesystem-permitted",
	"filesystem-denied",
	"network-denied",
];

export interface WorkspaceSandboxNetworkTarget {
	readonly port: number;
	hits(): number;
	close(): Promise<void>;
}

export interface WorkspaceSandboxSelfTestDependencies {
	readonly readiness: () => Promise<WorkspaceSandboxHealthReport>;
	readonly createSandbox?: typeof createWorkspaceSandbox;
	readonly createFixture?: (prefix: string) => string;
	readonly removeFixture?: (path: string) => void;
	readonly createNetworkTarget?: () => Promise<WorkspaceSandboxNetworkTarget>;
	readonly now?: () => Date;
	readonly platform?: NodeJS.Platform;
}

interface ProbeResult {
	readonly exitCode: number | null;
	readonly output: string;
	readonly threw: boolean;
}

async function executeSandboxProbe(sandbox: WorkspaceSandbox, cwd: string, command: string): Promise<ProbeResult> {
	let output = "";
	try {
		const result = await sandbox.operations.exec(command, cwd, {
			onData: (data) => {
				output += data.toString("utf8");
			},
			timeout: SELF_TEST_TIMEOUT_SECONDS,
		});
		return { exitCode: result.exitCode, output, threw: false };
	} catch {
		return { exitCode: null, output, threw: true };
	}
}

function createFixtureDirectory(prefix: string): string {
	return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

function removeFixtureDirectory(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

/**
 * A loopback-only probe target. It never contacts an external service and only
 * proves that sandboxed processes cannot reach a host listener outside the
 * runtime's exact-endpoint proxy.
 */
async function createLoopbackNetworkTarget(): Promise<WorkspaceSandboxNetworkTarget> {
	let hits = 0;
	const server: Server = createServer((_request, response) => {
		hits += 1;
		response.end("metis-sandbox-network-probe");
	});
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("Sandbox network probe could not bind a loopback port");
	}
	return {
		port: address.port,
		hits: () => hits,
		close: async () => {
			server.closeAllConnections?.();
			await new Promise<void>((resolve) => {
				server.close(() => resolve());
			});
		},
	};
}

export function createWorkspaceSandboxSelfTest(
	dependencies: WorkspaceSandboxSelfTestDependencies,
): () => Promise<WorkspaceSandboxHealthReport> {
	return async () => {
		const platform = dependencies.platform ?? process.platform;
		const checkedAt = (dependencies.now ?? (() => new Date()))().toISOString();
		let readiness: WorkspaceSandboxHealthReport;
		try {
			readiness = await dependencies.readiness();
		} catch {
			readiness = createSandboxHealthReport({
				status: "misconfigured",
				code: "probe-failed",
				mode: "readiness",
				platform,
				checkedAt,
				checks: [{ id: "dependencies", status: "failed", reason: "probe-failed" }],
				recoveryActions: readinessRecoveryActions("probe-failed", platform),
			});
		}
		if (readiness.status !== "healthy") {
			return createSandboxHealthReport({
				status: readiness.status,
				code: readiness.code,
				mode: "self-test",
				platform,
				checkedAt,
				checks: [...readiness.checks, ...skippedSandboxChecks(SELF_TEST_CHECKS, "readiness-failed")],
				recoveryActions: readiness.recoveryActions,
				details: readiness.details,
			});
		}

		const createSandbox = dependencies.createSandbox ?? createWorkspaceSandbox;
		const createFixture = dependencies.createFixture ?? createFixtureDirectory;
		const removeFixture = dependencies.removeFixture ?? removeFixtureDirectory;
		const createNetworkTarget = dependencies.createNetworkTarget ?? createLoopbackNetworkTarget;
		const checks: WorkspaceSandboxCheck[] = [...readiness.checks];
		let workspace: string | undefined;
		let outside: string | undefined;
		let sandbox: WorkspaceSandbox | undefined;
		let networkTarget: WorkspaceSandboxNetworkTarget | undefined;
		let sandboxUsable = false;
		try {
			try {
				workspace = createFixture("metis-sandbox-selftest-");
				sandbox = await createSandbox({ cwd: workspace, workspaceRoots: [workspace] });
				sandboxUsable = true;
				checks.push({ id: "sandbox-startup", status: "passed" });
			} catch {
				checks.push({ id: "sandbox-startup", status: "failed", reason: "sandbox-start-failed" });
				checks.push(...skippedSandboxChecks(SELF_TEST_CHECKS.slice(1), "sandbox-unavailable"));
			}

			if (sandbox && workspace) {
				const permitted = await executeSandboxProbe(
					sandbox,
					workspace,
					"printf 'metis-sandbox-probe' > allowed.txt && cat allowed.txt",
				);
				if (permitted.threw) {
					sandboxUsable = false;
					checks.push({ id: "filesystem-permitted", status: "failed", reason: "probe-failed" });
				} else if (permitted.exitCode === 0 && permitted.output.includes("metis-sandbox-probe")) {
					checks.push({ id: "filesystem-permitted", status: "passed" });
				} else {
					checks.push({ id: "filesystem-permitted", status: "failed", reason: "workspace-write-failed" });
				}
			} else if (!checks.some((candidate) => candidate.id === "filesystem-permitted")) {
				checks.push({ id: "filesystem-permitted", status: "skipped", reason: "sandbox-unavailable" });
			}

			if (sandbox && workspace && sandboxUsable) {
				const secret = randomUUID();
				try {
					outside = createFixture("metis-sandbox-selftest-outside-");
					writeFileSync(join(outside, "secret.txt"), secret, { mode: 0o600 });
					const denied = await executeSandboxProbe(
						sandbox,
						workspace,
						`cat '${join(outside, "secret.txt").replaceAll("'", "'\\''")}'`,
					);
					if (denied.threw) {
						sandboxUsable = false;
						checks.push({ id: "filesystem-denied", status: "failed", reason: "probe-failed" });
					} else if (denied.exitCode !== 0 && !denied.output.includes(secret)) {
						checks.push({ id: "filesystem-denied", status: "passed" });
					} else {
						checks.push({ id: "filesystem-denied", status: "failed", reason: "outside-read-not-denied" });
					}
				} catch {
					checks.push({ id: "filesystem-denied", status: "failed", reason: "probe-failed" });
				}
			} else if (!checks.some((candidate) => candidate.id === "filesystem-denied")) {
				checks.push({ id: "filesystem-denied", status: "skipped", reason: "sandbox-unavailable" });
			}

			if (sandbox && workspace && sandboxUsable) {
				try {
					networkTarget = await createNetworkTarget();
					const network = await executeSandboxProbe(
						sandbox,
						workspace,
						`curl -q --silent --show-error --fail --connect-timeout 3 --max-time 5 'http://127.0.0.1:${networkTarget.port}/'`,
					);
					if (network.threw || network.exitCode === null) {
						checks.push({ id: "network-denied", status: "failed", reason: "probe-failed" });
					} else if (
						network.exitCode === 127 ||
						/command not found|not recognized as an internal or external command/iu.test(network.output)
					) {
						checks.push({ id: "network-denied", status: "skipped", reason: "network-probe-unavailable" });
					} else if (network.exitCode === 0 || networkTarget.hits() > 0) {
						checks.push({ id: "network-denied", status: "failed", reason: "network-not-denied" });
					} else if (
						// curl 5/6/7 are proxy/host resolution or connection failures.
						// The runtime proxy rejects blocked endpoints with HTTP 403, which
						// curl --fail reports as 22. Any other failure is not proof of denial.
						[5, 6, 7].includes(network.exitCode) ||
						(network.exitCode === 22 && /\b403\b/u.test(network.output))
					) {
						checks.push({ id: "network-denied", status: "passed" });
					} else {
						checks.push({ id: "network-denied", status: "failed", reason: "probe-failed" });
					}
				} catch {
					checks.push({ id: "network-denied", status: "skipped", reason: "network-probe-unavailable" });
				}
			} else if (!checks.some((candidate) => candidate.id === "network-denied")) {
				checks.push({ id: "network-denied", status: "skipped", reason: "sandbox-unavailable" });
			}
		} finally {
			if (sandbox) await sandbox.dispose().catch(() => undefined);
			if (networkTarget) await networkTarget.close().catch(() => undefined);
			if (outside) removeFixture(outside);
			if (workspace) removeFixture(workspace);
		}

		const failed = checks.some((candidate) => candidate.status === "failed");
		const incomplete = checks.some(
			(candidate) => candidate.status === "skipped" && candidate.reason !== "not-applicable",
		);
		return createSandboxHealthReport({
			status: failed ? "misconfigured" : "healthy",
			code: failed ? "self-test-failed" : incomplete ? "self-test-incomplete" : "ready",
			mode: "self-test",
			platform,
			checkedAt,
			checks,
			recoveryActions: selfTestRecoveryActions(checks, platform),
		});
	};
}

export const workspaceSandboxSelfTest = createWorkspaceSandboxSelfTest({
	readiness: workspaceSandboxHealth,
});
