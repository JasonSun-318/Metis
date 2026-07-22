import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { arch, homedir, platform } from "node:os";
import { join } from "node:path";
import {
	getDefaultWritePaths,
	getWindowsSandboxUserStatus,
	installWindowsSandbox,
	resolveSrtWin,
	SandboxManager,
	type SandboxRuntimeConfig,
	type WindowsInstallResult,
	type WindowsSandboxUserStatus,
} from "@anthropic-ai/sandbox-runtime";
import { lock as acquireProperLock } from "proper-lockfile";
import { getPackageDir, isBunBinary } from "../config.ts";
import { waitForChildProcess } from "../utils/child-process.ts";
import { canonicalizeActionPath, isPathInside } from "../utils/paths.ts";
import { killProcessTree, trackDetachedChildPid, untrackDetachedChildPid } from "../utils/shell.ts";
import { getSensitiveFilesystemPaths, type NetworkTarget, type SandboxGrant } from "./permission-policy.ts";
import { executeWindowsSandboxWorker, type WindowsSandboxWorkerLauncher } from "./windows-sandbox-worker.ts";

export const SENSITIVE_ENVIRONMENT_NAMES = [
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AZURE_CLIENT_SECRET",
	"DATABASE_URL",
	"DOCKER_AUTH_CONFIG",
	"GITHUB_TOKEN",
	"GITLAB_TOKEN",
	"GOOGLE_API_KEY",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"KUBECONFIG",
	"NODE_AUTH_TOKEN",
	"NPM_TOKEN",
	"OPENAI_API_KEY",
	"ANTHROPIC_API_KEY",
	"SSH_AUTH_SOCK",
] as const;

const SENSITIVE_ENVIRONMENT_SUFFIXES = [
	"_API_KEY",
	"_ACCESS_TOKEN",
	"_AUTH_TOKEN",
	"_CLIENT_SECRET",
	"_PRIVATE_KEY",
	"_PASSWORD",
] as const;

export function sensitiveEnvironmentNames(environment: NodeJS.ProcessEnv = process.env): string[] {
	const names = new Set<string>(SENSITIVE_ENVIRONMENT_NAMES);
	for (const name of Object.keys(environment)) {
		const normalized = name.toUpperCase();
		if (SENSITIVE_ENVIRONMENT_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) names.add(name);
	}
	return [...names].sort();
}

export interface SandboxManagerAdapter {
	initialize(
		config: SandboxRuntimeConfig,
		ask?: (target: { host: string; port?: number }) => Promise<boolean>,
	): Promise<void>;
	isSupportedPlatform(): boolean;
	checkDependencies(ripgrep?: { command: string; args?: string[] }): { errors: string[]; warnings: string[] };
	wrapWithSandboxArgv(
		command: string,
		shell?: string,
		customConfig?: Partial<SandboxRuntimeConfig>,
		signal?: AbortSignal,
		cwd?: string,
	): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
	cleanupAfterCommand(): void | Promise<void>;
	reset(): Promise<void>;
}

export interface SandboxSpawnInput {
	readonly argv: readonly string[];
	readonly cwd: string;
	readonly env: NodeJS.ProcessEnv;
	readonly signal?: AbortSignal;
	readonly timeout?: number;
	readonly onData: (data: Buffer) => void;
}

export type SandboxSpawn = (input: SandboxSpawnInput) => Promise<{ exitCode: number | null }>;
export type SandboxLock = () => Promise<() => Promise<void>>;

export interface WindowsSandboxAdapter {
	getStatus(): WindowsSandboxUserStatus;
	install(): WindowsInstallResult;
}

export interface SandboxRuntimeCoordinatorOptions {
	agentDir: string;
	manager?: SandboxManagerAdapter;
	spawn?: SandboxSpawn;
	acquireLock?: SandboxLock;
	platform?: NodeJS.Platform;
	requestWindowsSetup?: () => Promise<boolean>;
	windows?: WindowsSandboxAdapter;
	/** Test seam for native-Windows worker launch. */
	windowsWorkerLauncher?: WindowsSandboxWorkerLauncher;
	/** Keep injected Windows adapters on the legacy in-process seam. */
	windowsInProcess?: boolean;
}

export interface SandboxedCommandInput {
	command: string;
	shell: string;
	cwd: string;
	grant: SandboxGrant;
	signal?: AbortSignal;
	timeout?: number;
	onData: (data: Buffer) => void;
}

export interface WrappedSandboxCommand {
	readonly argv: readonly string[];
	readonly env: NodeJS.ProcessEnv;
	readonly signal?: AbortSignal;
}

export type RunWrappedSandboxCommand<T> = (command: WrappedSandboxCommand) => Promise<T>;

let sandboxRuntimeTail: Promise<void> = Promise.resolve();

function compiledVendorAsset(...parts: string[]): string | undefined {
	if (!isBunBinary) return undefined;
	const path = join(getPackageDir(), "vendor", ...parts);
	return existsSync(path) ? path : undefined;
}

export function createDefaultWindowsSandboxAdapter(): WindowsSandboxAdapter {
	const getSrtWin = () => {
		const path = compiledVendorAsset("srt-win", arch(), "srt-win.exe");
		return resolveSrtWin(path ? { path } : undefined);
	};
	return {
		getStatus: () => getWindowsSandboxUserStatus({ srtWin: getSrtWin() }),
		install: () => installWindowsSandbox({ srtWin: getSrtWin() }),
	};
}

function enqueueSandboxRuntime<T>(operation: () => Promise<T>): Promise<T> {
	const result = sandboxRuntimeTail.then(operation, operation);
	sandboxRuntimeTail = result.then(
		() => undefined,
		() => undefined,
	);
	return result;
}

function credentialFilePaths(cwd: string): string[] {
	const home = homedir();
	return [
		join(home, ".ssh", "id_rsa"),
		join(home, ".ssh", "id_ed25519"),
		join(home, ".ssh", "config"),
		join(home, ".aws", "credentials"),
		join(home, ".docker", "config.json"),
		join(home, ".git-credentials"),
		join(home, ".netrc"),
		join(home, ".npmrc"),
		join(home, ".arcmind", "agent", "auth.json"),
		join(cwd, ".env"),
	].map((path) => canonicalizeActionPath(path, cwd));
}

function normalizeHost(host: string): string {
	return host
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "")
		.replace(/\.$/, "");
}

export function networkTargetMatches(
	granted: readonly NetworkTarget[],
	actual: { host: string; port?: number },
): boolean {
	if (actual.port === undefined) return false;
	const host = normalizeHost(actual.host);
	return granted.some((target) => normalizeHost(target.host) === host && target.port === actual.port);
}

export function buildSandboxRuntimeConfig(grant: SandboxGrant, cwd: string): SandboxRuntimeConfig {
	if (grant.fullOnce || grant.sandbox === "none") throw new Error("Full-once execution must bypass SRT");
	const sensitive = getSensitiveFilesystemPaths(cwd);
	const denyReadPaths = grant.denyReadPaths.map((path) => canonicalizeActionPath(path, cwd));
	const explicitReadPaths = grant.readPaths.map((path) => canonicalizeActionPath(path, cwd));
	const readPaths = [
		...new Set([...explicitReadPaths, ...grant.capabilityReadPaths.map((path) => canonicalizeActionPath(path, cwd))]),
	];
	const writePaths = [
		...new Set([
			...grant.writePaths.map((path) => canonicalizeActionPath(path, cwd)),
			...grant.capabilityWritePaths.map((path) => canonicalizeActionPath(path, cwd)),
		]),
	];
	for (const writePath of writePaths) {
		if (sensitive.some((deniedPath) => isPathInside(deniedPath, writePath))) {
			throw new Error("Sensitive writes require explicit Full-once approval");
		}
	}
	const exactReads = new Set(readPaths);
	const effectiveCredentialFiles = credentialFilePaths(cwd).filter(
		(path) => !explicitReadPaths.some((allowedPath) => isPathInside(allowedPath, path)),
	);
	const compiledSrtWin = compiledVendorAsset("srt-win", arch(), "srt-win.exe");
	const compiledSeccomp = compiledVendorAsset("seccomp", arch(), "apply-seccomp");
	return {
		network: {
			allowedDomains: [],
			deniedDomains: [],
			strictAllowlist: false,
			allowLocalBinding: false,
		},
		filesystem: {
			denyRead: [...new Set([...sensitive, ...denyReadPaths])],
			allowRead: [...exactReads],
			allowWrite: [...getDefaultWritePaths(), ...writePaths],
			denyWrite: sensitive,
		},
		credentials: {
			files: effectiveCredentialFiles.map((path) => ({ path, mode: "deny" as const })),
			envVars: sensitiveEnvironmentNames().map((name) => ({ name, mode: "deny" as const })),
			allowPlaintextInject: false,
		},
		enableWeakerNestedSandbox: false,
		enableWeakerNetworkIsolation: false,
		allowAppleEvents: false,
		...(platform() === "win32" && compiledSrtWin ? { windows: { srtWin: { path: compiledSrtWin } } } : {}),
		...(platform() === "linux" && compiledSeccomp ? { seccomp: { applyPath: compiledSeccomp } } : {}),
	};
}

export function quoteSandboxArg(value: string): string {
	return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function sandboxArgvCommand(executable: string, args: readonly string[]): string {
	return [executable, ...args].map(quoteSandboxArg).join(" ");
}

function windowsStatusComplete(status: WindowsSandboxUserStatus): boolean {
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

async function defaultSpawn(input: SandboxSpawnInput): Promise<{ exitCode: number | null }> {
	if (input.signal?.aborted) throw new Error("aborted");
	if (input.argv.length === 0 || !input.argv[0]) throw new Error("SRT returned an empty command");
	const child = spawn(input.argv[0], input.argv.slice(1), {
		cwd: input.cwd,
		env: input.env,
		shell: false,
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
		windowsHide: true,
	});
	if (child.pid) trackDetachedChildPid(child.pid);
	let timedOut = false;
	let timeoutHandle: NodeJS.Timeout | undefined;
	const abort = () => {
		if (child.pid) killProcessTree(child.pid);
	};
	try {
		child.stdout?.on("data", input.onData);
		child.stderr?.on("data", input.onData);
		if (input.signal) input.signal.addEventListener("abort", abort, { once: true });
		if (input.timeout !== undefined) {
			timeoutHandle = setTimeout(() => {
				timedOut = true;
				abort();
			}, input.timeout * 1000);
		}
		const exitCode = await waitForChildProcess(child);
		if (input.signal?.aborted) throw new Error("aborted");
		if (timedOut) throw new Error(`timeout:${input.timeout}`);
		return { exitCode };
	} finally {
		if (child.pid) untrackDetachedChildPid(child.pid);
		if (timeoutHandle) clearTimeout(timeoutHandle);
		if (input.signal) input.signal.removeEventListener("abort", abort);
	}
}

export function createSandboxRuntimeLock(agentDir: string): SandboxLock {
	return async () => {
		mkdirSync(agentDir, { recursive: true });
		const lockfilePath = join(agentDir, "sandbox-runtime.lock");
		try {
			return await acquireProperLock(agentDir, {
				lockfilePath,
				realpath: false,
				stale: 30_000,
				update: 10_000,
				retries: { retries: 8, factor: 1.5, minTimeout: 50, maxTimeout: 500 },
			});
		} catch (error) {
			throw new Error("Another ArcMind process is using the sandbox; wait for it to finish and retry", {
				cause: error,
			});
		}
	};
}

export class SandboxRuntimeCoordinator {
	private readonly agentDir: string;
	private readonly manager: SandboxManagerAdapter;
	private readonly spawnCommand: SandboxSpawn;
	private readonly acquireLock: SandboxLock;
	private readonly platform: NodeJS.Platform;
	private requestWindowsSetup?: () => Promise<boolean>;
	private readonly windows: WindowsSandboxAdapter;
	private readonly windowsWorkerLauncher?: WindowsSandboxWorkerLauncher;
	private readonly useWindowsWorker: boolean;

	constructor(options: SandboxRuntimeCoordinatorOptions) {
		this.agentDir = options.agentDir;
		this.manager = options.manager ?? SandboxManager;
		this.spawnCommand = options.spawn ?? defaultSpawn;
		this.acquireLock = options.acquireLock ?? createSandboxRuntimeLock(options.agentDir);
		this.platform = options.platform ?? process.platform;
		this.requestWindowsSetup = options.requestWindowsSetup;
		this.windows = options.windows ?? createDefaultWindowsSandboxAdapter();
		this.windowsWorkerLauncher = options.windowsWorkerLauncher;
		this.useWindowsWorker =
			this.platform === "win32" &&
			options.windowsInProcess !== true &&
			(options.windowsWorkerLauncher !== undefined ||
				(options.manager === undefined && options.windows === undefined && options.acquireLock === undefined));
	}

	setWindowsSetupRequester(requester?: () => Promise<boolean>): void {
		this.requestWindowsSetup = requester;
	}

	private async ensurePlatformReady(): Promise<void> {
		if (!this.manager.isSupportedPlatform()) throw new Error(`SRT does not support ${this.platform}`);
		if (this.platform !== "win32") return;
		if (windowsStatusComplete(this.windows.getStatus())) return;
		if (!this.requestWindowsSetup || !(await this.requestWindowsSetup())) {
			throw new Error("Windows sandbox setup requires user approval and one UAC prompt");
		}
		const result = this.windows.install();
		if (result.cancelled) throw new Error("Windows sandbox setup was cancelled");
		if (!windowsStatusComplete(result.user)) throw new Error("Windows sandbox setup did not complete");
	}

	execute(input: SandboxedCommandInput): Promise<{ exitCode: number | null }> {
		return this.executeWith(input, async ({ argv, env, signal }) =>
			this.spawnCommand({
				argv,
				cwd: input.cwd,
				env,
				signal,
				timeout: input.timeout,
				onData: input.onData,
			}),
		);
	}

	executeArgv(
		input: Omit<SandboxedCommandInput, "command"> & { executable: string; args: readonly string[] },
	): Promise<{ exitCode: number | null }> {
		return this.execute({ ...input, command: sandboxArgvCommand(input.executable, input.args) });
	}

	executeArgvWith<T>(
		input: Omit<SandboxedCommandInput, "command"> & { executable: string; args: readonly string[] },
		run: RunWrappedSandboxCommand<T>,
	): Promise<T> {
		return this.executeWith({ ...input, command: sandboxArgvCommand(input.executable, input.args) }, run);
	}

	executeWith<T>(input: SandboxedCommandInput, run: RunWrappedSandboxCommand<T>): Promise<T> {
		return enqueueSandboxRuntime(() =>
			this.useWindowsWorker
				? executeWindowsSandboxWorker(input, run, {
						agentDir: this.agentDir,
						requestSetup: this.requestWindowsSetup,
						launcher: this.windowsWorkerLauncher,
					})
				: this.executeSerial(input, run),
		);
	}

	private async executeSerial<T>(input: SandboxedCommandInput, run: RunWrappedSandboxCommand<T>): Promise<T> {
		const release = await this.acquireLock();
		const cleanupErrors: unknown[] = [];
		let operationError: unknown;
		let result: T | undefined;
		let managerTouched = false;
		try {
			await this.ensurePlatformReady();
			// ponytail: SRT is globally stateful (and Windows ACLs share one SID), so serialize all ArcMind sandbox commands; revisit only if upstream adds isolated manager instances.
			managerTouched = true;
			await this.manager.reset();
			const config = buildSandboxRuntimeConfig(input.grant, input.cwd);
			await this.manager.initialize(config, async (target) =>
				networkTargetMatches(input.grant.networkTargets, target),
			);
			const dependencies = this.manager.checkDependencies(config.ripgrep);
			if (dependencies.errors.length > 0) {
				throw new Error(`SRT dependencies are missing: ${dependencies.errors.join("; ")}`);
			}
			const wrapped = await this.manager.wrapWithSandboxArgv(
				input.command,
				input.shell,
				undefined,
				input.signal,
				input.cwd,
			);
			result = await run({ argv: wrapped.argv, env: wrapped.env, signal: input.signal });
		} catch (error) {
			operationError = error;
		} finally {
			if (managerTouched) {
				try {
					await this.manager.cleanupAfterCommand();
				} catch (error) {
					cleanupErrors.push(error);
				}
				try {
					await this.manager.reset();
				} catch (error) {
					cleanupErrors.push(error);
				}
			}
			try {
				await release();
			} catch (error) {
				cleanupErrors.push(error);
			}
		}
		if (operationError !== undefined) {
			if (cleanupErrors.length > 0) {
				throw new AggregateError([operationError, ...cleanupErrors], "Sandbox command and cleanup failed");
			}
			throw operationError;
		}
		if (cleanupErrors.length === 1) throw cleanupErrors[0];
		if (cleanupErrors.length > 1) throw new AggregateError(cleanupErrors, "Sandbox cleanup failed");
		if (result === undefined) throw new Error("Sandbox command completed without a result");
		return result;
	}
}
