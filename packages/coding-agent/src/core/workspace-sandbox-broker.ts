import { existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { getDefaultWritePaths, SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { getBundledToolsDir, getPackageDir, isBunBinary } from "../config.ts";
import { spawnProcess, waitForChildProcess } from "../utils/child-process.ts";
import { canonicalizeActionPath, isPathInside } from "../utils/paths.ts";
import { getShellConfig, killProcessTree } from "../utils/shell.ts";
import { parseSandboxRequest, type SandboxErrorCode, type SandboxResponse } from "./workspace-sandbox-protocol.ts";

function send(response: SandboxResponse): boolean {
	return process.stdout.write(`${JSON.stringify(response)}\n`);
}

function bundledHelperPath(kind: "seccomp" | "srt-win"): string {
	const executable = kind === "seccomp" ? "apply-seccomp" : "srt-win.exe";
	const path = join(getPackageDir(), "vendor", "sandbox-runtime", kind, process.arch, executable);
	try {
		if (!statSync(path).isFile()) throw new Error();
	} catch {
		throw new Error(`Bundled sandbox helper is missing: ${kind}/${process.arch}/${executable}`);
	}
	return path;
}

function runtimeReadPaths(): string[] {
	const systemPaths =
		process.platform === "darwin"
			? ["/bin", "/sbin", "/usr", "/System", "/Library/Apple", "/opt/homebrew", "/opt/local"]
			: process.platform === "linux"
				? [
						"/bin",
						"/sbin",
						"/usr",
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

function deniedReadRoots(callerHome: string): string[] {
	if (process.platform !== "win32") return ["/"];
	const roots = new Set<string>();
	for (let code = "A".charCodeAt(0); code <= "Z".charCodeAt(0); code += 1) {
		const root = `${String.fromCharCode(code)}:\\`;
		if (existsSync(root)) roots.add(root);
	}
	if (roots.size === 0) roots.add(dirname(callerHome));
	return [...roots];
}

function runtimeConfig(workspaceRoots: readonly string[], temporaryDir: string): SandboxRuntimeConfig {
	const callerHome = homedir();
	const denyRead = deniedReadRoots(callerHome);
	const allowed = [...workspaceRoots, temporaryDir];
	const denyWrite = getDefaultWritePaths().filter(
		(path) => !path.startsWith("/dev/") && !allowed.some((root) => isPathInside(root, path)),
	);
	return {
		filesystem: {
			denyRead,
			allowRead: [...allowed, ...runtimeReadPaths()],
			allowWrite: allowed,
			denyWrite,
		},
		network: {
			allowedDomains: [],
			deniedDomains: ["*"],
			strictAllowlist: true,
			allowLocalBinding: false,
		},
		...(isBunBinary && process.platform === "linux" ? { seccomp: { applyPath: bundledHelperPath("seccomp") } } : {}),
		...(isBunBinary && process.platform === "win32"
			? { windows: { srtWin: { path: bundledHelperPath("srt-win") } } }
			: {}),
	};
}

function sanitizedMessage(error: unknown, fallback: string): string {
	if (!(error instanceof Error)) return fallback;
	return `${fallback}: ${error.message.split(/\r?\n/, 1)[0]}`.slice(0, 512);
}

export async function runWorkspaceSandboxBroker(): Promise<void> {
	let workspaceRoots: readonly string[] | undefined;
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
				const shell = getShellConfig();
				const wrapped = await SandboxManager.wrapWithSandboxArgv(
					request.command,
					shell.shell,
					undefined,
					controller.signal,
					cwd,
				);
				if (!wrapped.argv[0]) throw new Error("Sandbox runtime returned an empty command");
				const child = spawnProcess(wrapped.argv[0], wrapped.argv.slice(1), {
					cwd,
					detached: process.platform !== "win32",
					env: { ...request.env, ...wrapped.env },
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
					if (!isAbsolute(request.cwd) || request.workspaceRoots.some((root) => !isAbsolute(root))) {
						throw new Error("Sandbox paths must be absolute");
					}
					workspaceRoots = Object.freeze([
						...new Set(request.workspaceRoots.map((root) => canonicalizeActionPath(root, request.cwd))),
					]);
					const cwd = canonicalizeActionPath(request.cwd, request.cwd);
					if (!workspaceRoots.some((root) => isPathInside(root, cwd))) {
						throw new Error("Sandbox cwd is outside the workspace");
					}
					const temporaryDir = process.env.METIS_SANDBOX_TEMP_DIR;
					if (!temporaryDir) throw new Error("Sandbox temporary directory is missing");
					mkdirSync(temporaryDir, { recursive: true });
					process.env.CLAUDE_CODE_TMPDIR = temporaryDir;
					await SandboxManager.initialize(runtimeConfig(workspaceRoots, temporaryDir));
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
