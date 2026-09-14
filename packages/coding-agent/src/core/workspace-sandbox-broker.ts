import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, isAbsolute, win32 } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import {
	getDefaultWritePaths,
	type NetworkHostPattern,
	SandboxManager,
	type SandboxRuntimeConfig,
} from "@anthropic-ai/sandbox-runtime";
import { getBundledToolsDir, isBunBinary } from "../config.ts";
import { spawnProcess, waitForChildProcess } from "../utils/child-process.ts";
import { canonicalizeActionPath, isPathInside, pathsIntersect } from "../utils/paths.ts";
import { getShellConfig, killProcessTree } from "../utils/shell.ts";
import { bundledSandboxHelperPath } from "./workspace-sandbox-health.ts";
import {
	parseSandboxRequest,
	type SandboxErrorCode,
	type SandboxNetworkEndpoint,
	type SandboxResponse,
} from "./workspace-sandbox-protocol.ts";

function send(response: SandboxResponse): boolean {
	return process.stdout.write(`${JSON.stringify(response)}\n`);
}

function runtimeReadPaths(): string[] {
	const systemPaths =
		process.platform === "darwin"
			? [
					"/bin",
					"/sbin",
					"/usr/bin",
					"/usr/sbin",
					"/usr/lib",
					"/usr/libexec",
					"/usr/share",
					"/System",
					"/Library/Apple",
					"/opt/homebrew/bin",
					"/opt/homebrew/sbin",
					"/opt/homebrew/lib",
					"/opt/homebrew/Cellar",
					"/opt/homebrew/opt",
					"/opt/homebrew/share",
					"/usr/local/bin",
					"/usr/local/sbin",
					"/usr/local/lib",
					"/usr/local/Cellar",
					"/usr/local/opt",
					"/usr/local/share",
					"/opt/local/bin",
					"/opt/local/sbin",
					"/opt/local/lib",
					"/opt/local/Library",
					"/opt/local/share",
				]
			: process.platform === "linux"
				? [
						"/bin",
						"/sbin",
						"/usr/bin",
						"/usr/sbin",
						"/usr/lib",
						"/usr/lib64",
						"/usr/libexec",
						"/usr/share",
						"/usr/local/bin",
						"/usr/local/sbin",
						"/usr/local/lib",
						"/usr/local/lib64",
						"/usr/local/share",
						"/lib",
						"/lib64",
						"/etc/alternatives",
						"/etc/ld.so.cache",
						"/etc/ld.so.conf",
						"/etc/ld.so.conf.d",
						"/etc/ld.so.preload",
						"/etc/localtime",
						"/etc/nsswitch.conf",
						"/etc/passwd",
						"/etc/group",
						"/proc/self",
						"/proc/thread-self",
					]
				: [process.env.SystemRoot, process.env.WINDIR, process.env.ProgramFiles, process.env["ProgramFiles(x86)"]];
	const devicePaths =
		process.platform === "win32" ? [] : ["/dev/null", "/dev/zero", "/dev/random", "/dev/urandom", "/dev/fd"];
	const pathEntries = (process.env.PATH ?? "")
		.split(delimiter)
		.filter((path) => isAbsolute(path) && ["bin", "sbin"].includes(basename(path).toLowerCase()));
	const bundledTools = getBundledToolsDir();
	const readable = new Set<string>();
	for (const path of [...systemPaths, ...devicePaths, ...pathEntries, bundledTools]) {
		if (!path) continue;
		if (path === "/" || !existsSync(path)) continue;
		try {
			readable.add(realpathSync(path));
		} catch {
			// Ignore disappearing optional runtimes.
		}
	}
	return [...readable];
}

function deniedReadRoots(platform: NodeJS.Platform): string[] {
	// Windows runs commands as a separate local account. That account already
	// cannot read the caller's private files, while stamping a drive root would
	// require administrator rights and would override narrower workspace grants.
	return platform === "win32" ? [] : ["/"];
}

function isInsideWindowsHome(callerHome: string, candidate: string): boolean {
	const relative = win32.relative(win32.resolve(callerHome), win32.resolve(candidate));
	return (
		relative === "" || (!relative.startsWith(`..${win32.sep}`) && relative !== ".." && !win32.isAbsolute(relative))
	);
}

export interface SandboxRuntimeConfigInput {
	readonly workspaceRoots: readonly string[];
	readonly readOnlyRoots: readonly string[];
	readonly writeRoots: readonly string[];
	readonly protectedRoots: readonly string[];
	readonly writeProtectedRoots: readonly string[];
	readonly temporaryDir: string;
	readonly runtimeReads: readonly string[];
	readonly shellPath?: string;
	readonly workspaceReadOnly?: boolean;
}

function canonicalNetworkHost(host: string): string | undefined {
	if (!host || /[*@/?#\\\s%]/u.test(host)) return undefined;
	try {
		const authority = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
		return new URL(`https://${authority}`).hostname
			.replace(/^\[|\]$/gu, "")
			.replace(/\.$/u, "")
			.toLowerCase();
	} catch {
		return undefined;
	}
}

export function exactNetworkGrantAllows(
	endpoints: readonly SandboxNetworkEndpoint[],
	target: NetworkHostPattern,
): boolean {
	const hostname = canonicalNetworkHost(target.host);
	return Boolean(
		hostname &&
			Number.isInteger(target.port) &&
			endpoints.some((endpoint) => endpoint.hostname === hostname && endpoint.port === target.port),
	);
}

export function createSandboxRuntimeConfig(
	input: SandboxRuntimeConfigInput,
	platform: NodeJS.Platform = process.platform,
	callerHome: string = homedir(),
): SandboxRuntimeConfig {
	const denyRead = deniedReadRoots(platform);
	const runtimeReads =
		platform === "win32"
			? input.runtimeReads.filter((path) => isInsideWindowsHome(callerHome, path))
			: input.runtimeReads;
	const shellRead =
		input.shellPath && (platform !== "win32" || isInsideWindowsHome(callerHome, input.shellPath))
			? [input.shellPath]
			: [];
	const allowedWrite = [
		...new Set([...(input.workspaceReadOnly ? [] : input.workspaceRoots), ...input.writeRoots, input.temporaryDir]),
	];
	const allowedRead = [
		...new Set([...input.workspaceRoots, ...allowedWrite, ...input.readOnlyRoots, ...runtimeReads, ...shellRead]),
	];
	const denyWrite = [
		...new Set([
			...getDefaultWritePaths().filter(
				(path) => !path.startsWith("/dev/") && !allowedWrite.some((root) => pathsIntersect(root, path)),
			),
			...input.protectedRoots,
			...input.writeProtectedRoots,
		]),
	];
	return {
		filesystem: {
			denyRead,
			allowRead: allowedRead,
			allowWrite: allowedWrite,
			denyWrite,
		},
		network: {
			allowedDomains: [],
			deniedDomains: [],
			strictAllowlist: false,
			allowLocalBinding: false,
		},
		...(isBunBinary && process.platform === "linux"
			? { seccomp: { applyPath: bundledSandboxHelperPath("seccomp") } }
			: {}),
		// srt-win is staged for every Windows runtime (bundled in the desktop
		// package via dist/vendor/sandbox-runtime), so enable it on all of them.
		...(process.platform === "win32" ? { windows: { srtWin: { path: bundledSandboxHelperPath("srt-win") } } } : {}),
	};
}

function sanitizedMessage(error: unknown, fallback: string): string {
	if (!(error instanceof Error)) return fallback;
	return `${fallback}: ${error.message.split(/\r?\n/, 1)[0]}`.slice(0, 512);
}

export async function runWorkspaceSandboxBroker(): Promise<void> {
	let workspaceRoots: readonly string[] | undefined;
	let explicitWriteRoots: readonly string[] = [];
	let networkEndpoints: readonly SandboxNetworkEndpoint[] = [];
	let shellPath: string | undefined;
	let initializationStarted = false;
	let active:
		| {
				id: string;
				controller: AbortController;
				pid?: number;
				promise: Promise<void>;
		  }
		| undefined;
	let closing = false;

	const fail = async (code: SandboxErrorCode, message: string, id?: string) => {
		send({ type: "error", ...(id ? { id } : {}), code, message });
		if (!id) await close();
	};

	const close = async () => {
		if (closing) return;
		closing = true;
		if (active) {
			active.controller.abort();
			if (active.pid) killProcessTree(active.pid);
			await active.promise.catch(() => {});
		}
		await SandboxManager.reset().catch(() => {});
	};

	const startExec = (request: Extract<ReturnType<typeof parseSandboxRequest>, { type: "exec" }>) => {
		if (!workspaceRoots || closing) {
			void fail("SANDBOX_CLOSED", "Sandbox broker is not ready", request.id);
			return;
		}
		if (active) {
			void fail("SANDBOX_PROTOCOL", "Sandbox broker accepts only one command at a time", request.id);
			return;
		}
		const cwd = canonicalizeActionPath(request.cwd, request.cwd);
		if (!workspaceRoots.some((root) => isPathInside(root, cwd))) {
			void fail("SANDBOX_PROTOCOL", "Sandbox command cwd is outside the workspace", request.id);
			return;
		}
		const managedWorkDir = request.env.METIS_WORK_DIR;
		if (managedWorkDir) {
			if (!isAbsolute(managedWorkDir)) {
				void fail("SANDBOX_PROTOCOL", "Metis work directory must be absolute", request.id);
				return;
			}
			const canonicalWorkDir = canonicalizeActionPath(managedWorkDir, cwd);
			if (!explicitWriteRoots.some((root) => isPathInside(root, canonicalWorkDir))) {
				void fail("SANDBOX_PROTOCOL", "Metis work directory is outside explicit write roots", request.id);
				return;
			}
			request.env.METIS_WORK_DIR = canonicalWorkDir;
		}

		const controller = new AbortController();
		const state = {
			id: request.id,
			controller,
			promise: Promise.resolve() as Promise<void>,
			pid: undefined as number | undefined,
		};
		active = state;
		state.promise = (async () => {
			let timeoutHandle: NodeJS.Timeout | undefined;
			try {
				const shell = getShellConfig(shellPath);
				const previousSandboxTemporaryDir = process.env.CLAUDE_CODE_TMPDIR;
				if (managedWorkDir) process.env.CLAUDE_CODE_TMPDIR = request.env.METIS_WORK_DIR;
				let wrapped: Awaited<ReturnType<typeof SandboxManager.wrapWithSandboxArgv>>;
				try {
					wrapped = await SandboxManager.wrapWithSandboxArgv(
						request.command,
						shell.shell,
						undefined,
						controller.signal,
						cwd,
					);
				} finally {
					if (managedWorkDir) {
						if (previousSandboxTemporaryDir === undefined) delete process.env.CLAUDE_CODE_TMPDIR;
						else process.env.CLAUDE_CODE_TMPDIR = previousSandboxTemporaryDir;
					}
				}
				if (!wrapped.argv[0]) throw new Error("Sandbox runtime returned an empty command");
				if (process.platform === "win32") {
					// srt-win creates a fresh child environment; spawn's env only reaches the broker.
					const separator = wrapped.argv.indexOf("--");
					if (separator < 0) throw new Error("Sandbox runtime returned no child command separator");
					const toolEnvironment = Object.entries(request.env).filter(([name]) =>
						/^(?:PATH|METIS_(?:WORK_DIR|ATTACHMENTS_DIR)|OFFICECLI_(?:SKIP_UPDATE|NO_AUTO_INSTALL|NO_AUTO_RESIDENT))$/iu.test(
							name,
						),
					);
					wrapped.argv.splice(
						separator,
						0,
						...toolEnvironment.flatMap(([name, value]) => ["--env", `${name}=${value}`]),
					);
				}
				const child = spawnProcess(wrapped.argv[0], wrapped.argv.slice(1), {
					cwd,
					detached: process.platform !== "win32",
					env: {
						...wrapped.env,
						...request.env,
						...(request.env.METIS_WORK_DIR
							? {
									TMPDIR: request.env.METIS_WORK_DIR,
									TMP: request.env.METIS_WORK_DIR,
									TEMP: request.env.METIS_WORK_DIR,
								}
							: {}),
					},
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
				});
				state.pid = child.pid;
				let paused = false;
				const forward = (data: Buffer) => {
					if (send({ type: "data", id: request.id, data: data.toString("base64") }) || paused) return;
					paused = true;
					child.stdout?.pause();
					child.stderr?.pause();
					process.stdout.once("drain", () => {
						paused = false;
						child.stdout?.resume();
						child.stderr?.resume();
					});
				};
				child.stdout?.on("data", forward);
				child.stderr?.on("data", forward);
				if (request.timeoutMs !== undefined) {
					timeoutHandle = setTimeout(() => {
						controller.abort();
						if (state.pid) killProcessTree(state.pid);
					}, request.timeoutMs);
				}
				controller.signal.addEventListener(
					"abort",
					() => {
						if (state.pid) killProcessTree(state.pid);
					},
					{ once: true },
				);
				const exitCode = await waitForChildProcess(child);
				send({ type: "result", id: request.id, exitCode });
			} catch {
				send({
					type: "error",
					id: request.id,
					code: "SANDBOX_CLOSED",
					message: "Sandbox command failed",
				});
			} finally {
				if (timeoutHandle) clearTimeout(timeoutHandle);
				if (active === state) active = undefined;
			}
		})();
	};

	const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
	lines.on("line", (line) => {
		void (async () => {
			let request: ReturnType<typeof parseSandboxRequest>;
			try {
				request = parseSandboxRequest(line);
			} catch {
				await fail("SANDBOX_PROTOCOL", "Invalid sandbox protocol message");
				lines.close();
				return;
			}
			if (request.type === "init") {
				if (initializationStarted || closing) {
					await fail("SANDBOX_PROTOCOL", "Sandbox broker was initialized more than once");
					lines.close();
					return;
				}
				initializationStarted = true;
				try {
					if (
						!isAbsolute(request.cwd) ||
						[
							...request.workspaceRoots,
							...request.readOnlyRoots,
							...request.writeRoots,
							...request.protectedRoots,
							...request.writeProtectedRoots,
						].some((root) => !isAbsolute(root))
					) {
						throw new Error("Sandbox paths must be absolute");
					}
					const canonicalRoots = (roots: readonly string[]) =>
						Object.freeze([...new Set(roots.map((root) => canonicalizeActionPath(root, request.cwd)))]);
					workspaceRoots = canonicalRoots(request.workspaceRoots);
					const readOnlyRoots = canonicalRoots(request.readOnlyRoots);
					explicitWriteRoots = canonicalRoots(request.writeRoots);
					const protectedRoots = canonicalRoots(request.protectedRoots);
					const writeProtectedRoots = canonicalRoots(request.writeProtectedRoots);
					networkEndpoints = Object.freeze(
						request.networkEndpoints.map((endpoint) => Object.freeze({ ...endpoint })),
					);
					const cwd = canonicalizeActionPath(request.cwd, request.cwd);
					if (!workspaceRoots.some((root) => isPathInside(root, cwd))) {
						throw new Error("Sandbox cwd is outside the workspace");
					}
					if (request.shellPath !== undefined) {
						if (!isAbsolute(request.shellPath)) throw new Error("Sandbox shell path must be absolute");
						shellPath = canonicalizeActionPath(request.shellPath, request.shellPath);
						if (!statSync(shellPath).isFile()) throw new Error("Sandbox shell path must be a file");
					}
					for (const protectedRoot of protectedRoots) {
						if ([...workspaceRoots, ...explicitWriteRoots].some((root) => pathsIntersect(root, protectedRoot))) {
							throw new Error("Sandbox write roots overlap a protected root");
						}
						if (readOnlyRoots.some((root) => isPathInside(root, protectedRoot))) {
							throw new Error("Sandbox read roots expose a protected root");
						}
					}
					for (const protectedRoot of writeProtectedRoots) {
						if (explicitWriteRoots.some((root) => pathsIntersect(root, protectedRoot))) {
							throw new Error("Sandbox write roots overlap a protected root");
						}
					}
					const runtimeReads = runtimeReadPaths();
					for (const protectedRoot of protectedRoots) {
						if (
							[...runtimeReads, ...(shellPath ? [shellPath] : [])].some((root) =>
								pathsIntersect(root, protectedRoot),
							)
						) {
							throw new Error("Sandbox runtime paths overlap a protected root");
						}
					}
					const temporaryDir = process.env.METIS_SANDBOX_TEMP_DIR;
					if (!temporaryDir) throw new Error("Sandbox temporary directory is missing");
					mkdirSync(temporaryDir, { recursive: true });
					process.env.CLAUDE_CODE_TMPDIR = temporaryDir;
					await SandboxManager.initialize(
						createSandboxRuntimeConfig({
							workspaceRoots,
							readOnlyRoots,
							writeRoots: explicitWriteRoots,
							protectedRoots,
							writeProtectedRoots,
							temporaryDir,
							runtimeReads,
							...(shellPath ? { shellPath } : {}),
							workspaceReadOnly: request.workspaceReadOnly === true,
						}),
						(target) => Promise.resolve(exactNetworkGrantAllows(networkEndpoints, target)),
					);
					send({ type: "ready" });
				} catch (error) {
					workspaceRoots = undefined;
					await fail("SANDBOX_UNAVAILABLE", sanitizedMessage(error, "Sandbox initialization failed"));
					lines.close();
				}
				return;
			}
			if (!workspaceRoots) {
				await fail("SANDBOX_PROTOCOL", "Sandbox broker must be initialized first");
				lines.close();
				return;
			}
			switch (request.type) {
				case "exec":
					startExec(request);
					break;
				case "cancel":
					if (active?.id === request.id) {
						active.controller.abort();
						if (active.pid) killProcessTree(active.pid);
					}
					break;
				case "close":
					await close();
					send({ type: "closed" });
					lines.close();
					break;
			}
		})();
	});

	await new Promise<void>((resolve) => lines.once("close", resolve));
	await close();
}

if (!isBunBinary && process.argv[1] === fileURLToPath(import.meta.url)) {
	await runWorkspaceSandboxBroker();
}
