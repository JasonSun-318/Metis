import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, cpus, hostname, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const packageDir = join(repoRoot, "packages", "coding-agent");
const distRpcEntry = join(packageDir, "dist", "rpc-entry.js");
const distIndex = join(packageDir, "dist", "index.js");
const startupProfiler = join(repoRoot, "scripts", "profile-coding-agent-node.mjs");
const agentDirEnvName = "ARCMIND_CODING_AGENT_DIR";
const minimalResourceArgs = [
	"--no-extensions",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--no-context-files",
];
const liveChildren = new Set();
let shuttingDown = false;

function parseInteger(value, flag, minimum = 0) {
	if (!/^\d+$/.test(value)) throw new Error(`Invalid ${flag}: ${value}`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`Invalid ${flag}: ${value}`);
	return parsed;
}

function parseArgs(argv) {
	const options = { runs: 5, warmup: 1, output: undefined, runtimeHost: undefined, agentDir: undefined };
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}
		if (["--runs", "--warmup", "--output", "--runtime-host", "--agent-dir"].includes(arg) && index + 1 >= argv.length) {
			throw new Error(`Missing value for ${arg}`);
		}
		if (arg === "--runs") options.runs = parseInteger(argv[++index], arg, 1);
		else if (arg === "--warmup") options.warmup = parseInteger(argv[++index], arg);
		else if (arg === "--output") options.output = resolve(argv[++index]);
		else if (arg === "--runtime-host") options.runtimeHost = parseInteger(argv[++index], arg, 1);
		else if (arg === "--agent-dir") options.agentDir = resolve(argv[++index]);
		else throw new Error(`Unknown option: ${arg}`);
	}
	return options;
}

function printHelp() {
	process.stdout.write(`Usage: node scripts/profile-app-server-baseline.mjs [options]\n\n`);
	process.stdout.write(`  --runs <n>       Measured cold-ready runs (default: 5)\n`);
	process.stdout.write(`  --warmup <n>     Warm-up runs (default: 1)\n`);
	process.stdout.write(`  --output <file>  JSON result path (default: profiles-node/desktop-baseline-<time>.json)\n`);
}

function execFileAsync(file, args) {
	return new Promise((resolvePromise, reject) => {
		execFile(file, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(Object.assign(error, { stdout, stderr }));
			else resolvePromise({ stdout, stderr });
		});
	});
}

function observeChild(child) {
	liveChildren.add(child);
	child.exitResult = new Promise((resolvePromise, reject) => {
		child.once("error", (error) => {
			liveChildren.delete(child);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			liveChildren.delete(child);
			resolvePromise({ code: code ?? 0, signal });
		});
	});
	return child;
}

function spawnManaged(executable, args, options = {}) {
	if (shuttingDown) throw new Error("Profiler is shutting down");
	return observeChild(
		spawn(executable, args, {
			...options,
			detached: process.platform !== "win32",
			stdio: options.stdio ?? ["pipe", "pipe", "pipe"],
		}),
	);
}

async function waitWithTimeout(promise, timeoutMs, description) {
	let timeout;
	try {
		return await Promise.race([
			promise,
			new Promise((_, reject) => {
				timeout = setTimeout(() => reject(new Error(`${description} timed out after ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		clearTimeout(timeout);
	}
}

async function terminateProcessTree(child) {
	if (!child) return;
	const tree = await processTable()
		.then((table) => collectProcessTree(table, child.pid))
		.catch(() => []);
	const processGroupIds =
		process.platform === "win32" ? [] : Array.from(new Set([child.pid, ...tree.map((entry) => entry.pgid)]));
	const wasRunning = child.exitCode === null && child.signalCode === null;
	if (wasRunning) {
		child.stdin?.end();
		await waitWithTimeout(child.exitResult, 2_000, "graceful child shutdown").catch(() => undefined);
	}

	if (process.platform === "win32") {
		if (child.exitCode === null && child.signalCode === null) {
			await execFileAsync("taskkill", ["/pid", String(child.pid), "/T", "/F"]).catch(() => undefined);
		}
		for (const processInfo of tree.reverse()) {
			if (processInfo.pid === child.pid) continue;
			await execFileAsync("taskkill", ["/pid", String(processInfo.pid), "/T", "/F"]).catch(() => undefined);
		}
	} else {
		for (const processGroupId of processGroupIds) {
			if (!processGroupExists(processGroupId)) continue;
			try {
				process.kill(-processGroupId, "SIGTERM");
			} catch {
				// Process group may have exited between checks.
			}
		}
		await waitForProcessGroupsToExit(processGroupIds, 500);
		for (const processGroupId of processGroupIds) {
			if (!processGroupExists(processGroupId)) continue;
			try {
				process.kill(-processGroupId, "SIGKILL");
			} catch {
				// Process group may have exited between checks.
			}
		}
		await waitForProcessGroupsToExit(processGroupIds, 1_000);
	}
	await waitWithTimeout(child.exitResult, 2_000, "forced child shutdown").catch(() => undefined);
	liveChildren.delete(child);
}

function processGroupExists(processGroupId) {
	try {
		process.kill(-processGroupId, 0);
		return true;
	} catch (error) {
		return error?.code === "EPERM";
	}
}

async function waitForProcessGroupsToExit(processGroupIds, timeoutMs) {
	const deadline = Date.now() + timeoutMs;
	while (processGroupIds.some((id) => processGroupExists(id)) && Date.now() < deadline) {
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
	}
}

async function terminateAllChildren() {
	while (liveChildren.size > 0) {
		await Promise.all(Array.from(liveChildren, (child) => terminateProcessTree(child)));
	}
}

function attachJsonLineWaiter(child, predicate) {
	let buffer = "";
	let stderr = "";
	child.stderr?.setEncoding("utf8");
	child.stderr?.on("data", (chunk) => {
		stderr += chunk;
	});
	child.stdout?.setEncoding("utf8");

	return waitWithTimeout(
		new Promise((resolvePromise, reject) => {
			child.stdout?.on("data", (chunk) => {
				buffer += chunk;
				while (true) {
					const newline = buffer.indexOf("\n");
					if (newline < 0) break;
					const line = buffer.slice(0, newline).trim();
					buffer = buffer.slice(newline + 1);
					if (!line) continue;
					try {
						const value = JSON.parse(line);
						if (predicate(value)) resolvePromise(value);
					} catch {
						// Non-protocol stdout is retained only for diagnostics.
					}
				}
			});
			child.exitResult.then(({ code, signal }) => {
				reject(new Error(`Child exited before readiness (code=${code}, signal=${signal ?? "none"})\n${stderr}`));
			}, reject);
		}),
		30_000,
		"child readiness",
	);
}

async function processTable() {
	if (process.platform === "win32") {
		const script =
			"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress";
		const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script]);
		const parsed = JSON.parse(stdout || "[]");
		return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
			pid: Number(entry.ProcessId),
			ppid: Number(entry.ParentProcessId),
			pgid: Number(entry.ProcessId),
			rssBytes: Number(entry.WorkingSetSize),
		}));
	}

	const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,pgid=,rss="]);
	return stdout
		.trim()
		.split(/\r?\n/)
		.map((line) => line.trim().split(/\s+/).map(Number))
		.filter(
			([pid, ppid, pgid, rssKiB]) =>
				Number.isFinite(pid) && Number.isFinite(ppid) && Number.isFinite(pgid) && Number.isFinite(rssKiB),
		)
		.map(([pid, ppid, pgid, rssKiB]) => ({ pid, ppid, pgid, rssBytes: rssKiB * 1024 }));
}

function collectProcessTree(table, rootPid) {
	const byParent = new Map();
	for (const processInfo of table) {
		const children = byParent.get(processInfo.ppid) ?? [];
		children.push(processInfo.pid);
		byParent.set(processInfo.ppid, children);
	}
	const wanted = new Set([rootPid]);
	const queue = [rootPid];
	while (queue.length > 0) {
		for (const childPid of byParent.get(queue.shift()) ?? []) {
			if (wanted.has(childPid)) continue;
			wanted.add(childPid);
			queue.push(childPid);
		}
	}
	return table.filter((entry) => wanted.has(entry.pid));
}

async function sampleProcessTreeRss(rootPid) {
	const table = await processTable();
	if (!table.some((entry) => entry.pid === rootPid)) {
		throw new Error(`Process ${rootPid} exited before RSS sampling`);
	}
	const processes = collectProcessTree(table, rootPid);
	return {
		rootPid,
		processCount: processes.length,
		rssBytes: processes.reduce((sum, entry) => sum + entry.rssBytes, 0),
		processes,
	};
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

async function sampleChildren(children, rounds = 3) {
	const samples = [];
	for (let round = 0; round < rounds; round++) {
		const trees = await Promise.all(children.map((child) => sampleProcessTreeRss(child.pid)));
		samples.push({ round: round + 1, totalRssBytes: trees.reduce((sum, tree) => sum + tree.rssBytes, 0), trees });
		if (round + 1 < rounds) await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
	}
	return { samples, medianRssBytes: median(samples.map((sample) => sample.totalRssBytes)) };
}

function isolatedEnv(agentDir) {
	return { ...process.env, [agentDirEnvName]: agentDir, ARCMIND_OFFLINE: "1" };
}

async function startRpc(agentDir) {
	const startedAt = performance.now();
	const child = spawnManaged(process.execPath, [distRpcEntry, "--no-session", ...minimalResourceArgs], {
		cwd: packageDir,
		env: isolatedEnv(agentDir),
	});
	try {
		const requestId = `desktop-baseline-${child.pid}`;
		const ready = attachJsonLineWaiter(
			child,
			(value) => value?.type === "response" && value.id === requestId && value.command === "get_state" && value.success,
		);
		child.stdin.write(`${JSON.stringify({ id: requestId, type: "get_state" })}\n`);
		await ready;
		return { child, readyMs: performance.now() - startedAt };
	} catch (error) {
		await terminateProcessTree(child);
		throw error;
	}
}

async function startRuntimeHost(runtimeCount, agentDir) {
	const child = spawnManaged(
		process.execPath,
		[scriptPath, "--runtime-host", String(runtimeCount), "--agent-dir", agentDir],
		{ cwd: repoRoot, env: isolatedEnv(agentDir) },
	);
	try {
		const ready = await attachJsonLineWaiter(
			child,
			(value) => value?.type === "runtime_host_ready" && value.runtimeCount === runtimeCount,
		);
		return { child, ready };
	} catch (error) {
		await terminateProcessTree(child);
		throw error;
	}
}

async function measureRpcProcesses(count, root) {
	const started = [];
	try {
		for (let index = 0; index < count; index++) {
			const agentDir = join(root, `rpc-agent-${index + 1}`);
			mkdirSync(agentDir, { recursive: true });
			started.push(await startRpc(agentDir));
		}
		return {
			readyMs: started.map((item) => item.readyMs),
			...(await sampleChildren(started.map((item) => item.child))),
		};
	} finally {
		await Promise.all(started.map((item) => terminateProcessTree(item.child)));
	}
}

async function measureRuntimeHost(runtimeCount, root) {
	const agentDir = join(root, `runtime-host-${runtimeCount}`);
	mkdirSync(agentDir, { recursive: true });
	const { child, ready } = await startRuntimeHost(runtimeCount, agentDir);
	try {
		return { hostReportedRssBytes: ready.processRssBytes, ...(await sampleChildren([child])) };
	} finally {
		await terminateProcessTree(child);
	}
}

async function measureStartup(options, root) {
	const jsonOutput = join(root, "startup.json");
	const child = spawnManaged(
		process.execPath,
		[
			startupProfiler,
			"--mode",
			"rpc",
			"--runs",
			String(options.runs),
			"--warmup",
			String(options.warmup),
			"--isolated-agent-dir",
			"--minimal-resources",
			"--skip-build",
			"--json-output",
			jsonOutput,
		],
		{ cwd: repoRoot, env: { ...process.env, ARCMIND_OFFLINE: "1" } },
	);
	let stderr = "";
	child.stdout.resume();
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});
	try {
		const result = await waitWithTimeout(child.exitResult, 120_000, "startup benchmark");
		if (result.code !== 0 || result.signal) {
			throw new Error(`Startup benchmark failed (code=${result.code}, signal=${result.signal ?? "none"})\n${stderr}`);
		}
		return JSON.parse(readFileSync(jsonOutput, "utf8"));
	} finally {
		await terminateProcessTree(child);
	}
}

async function runRuntimeHost(runtimeCount, agentDir) {
	if (!agentDir) throw new Error("--runtime-host requires --agent-dir");
	const codingAgent = await import(pathToFileURL(distIndex).href);
	const runtimes = [];
	const root = dirname(agentDir);
	for (let index = 0; index < runtimeCount; index++) {
		const cwd = join(root, `project-${index + 1}`);
		mkdirSync(cwd, { recursive: true });
		const authStorage = codingAgent.AuthStorage.inMemory();
		const createRuntime = async ({ cwd: runtimeCwd, sessionManager, sessionStartEvent }) => {
			const services = await codingAgent.createAgentSessionServices({
				cwd: runtimeCwd,
				agentDir,
				authStorage,
				resourceLoaderOptions: {
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
				},
			});
			return {
				...(await codingAgent.createAgentSessionFromServices({ services, sessionManager, sessionStartEvent })),
				services,
				diagnostics: services.diagnostics,
			};
		};
		runtimes.push(
			await codingAgent.createAgentSessionRuntime(createRuntime, {
				cwd,
				agentDir,
				sessionManager: codingAgent.SessionManager.inMemory(cwd),
			}),
		);
	}
	process.stdout.write(
		`${JSON.stringify({ type: "runtime_host_ready", runtimeCount, processRssBytes: process.memoryUsage().rss })}\n`,
	);
	await new Promise((resolvePromise) => {
		process.stdin.resume();
		process.stdin.once("end", resolvePromise);
	});
	for (const runtime of runtimes.reverse()) await runtime.dispose();
}

function formatMiB(bytes) {
	return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}
	if (!existsSync(distRpcEntry) || !existsSync(distIndex)) {
		throw new Error("Built coding-agent entrypoints are missing. Run npm run build first.");
	}
	if (options.runtimeHost !== undefined) {
		await runRuntimeHost(options.runtimeHost, options.agentDir);
		return;
	}

	const tempRoot = mkdtempSync(join(tmpdir(), "arcmind-desktop-baseline-"));
	try {
		const startup = await measureStartup(options, tempRoot);
		const oneRpcProcess = await measureRpcProcesses(1, join(tempRoot, "one-rpc"));
		const threeRpcProcesses = await measureRpcProcesses(3, join(tempRoot, "three-rpc"));
		const oneRuntime = await measureRuntimeHost(1, join(tempRoot, "one-runtime"));
		const threeRuntimes = await measureRuntimeHost(3, join(tempRoot, "three-runtimes"));
		const machineCpus = cpus();
		const result = {
			schemaVersion: 1,
			capturedAt: new Date().toISOString(),
			machine: {
				hostname: hostname(),
				platform: platform(),
				release: release(),
				arch: arch(),
				node: process.version,
				cpuModel: machineCpus[0]?.model,
				cpuCount: machineCpus.length,
				totalMemoryBytes: totalmem(),
			},
			configuration: { measuredRuns: options.runs, warmupRuns: options.warmup, offline: true },
			startup,
			idleRss: { oneRpcProcess, threeRpcProcesses, oneRuntime, threeRuntimes },
			comparison: {
				threeRpcProcessesBytes: threeRpcProcesses.medianRssBytes,
				threeInProcessRuntimesBytes: threeRuntimes.medianRssBytes,
				aggregateRssDeltaBytes: threeRpcProcesses.medianRssBytes - threeRuntimes.medianRssBytes,
			},
			measurement: {
				metric: "aggregate-process-tree-rss",
				note: "Aggregate RSS double-counts shared pages across processes; use it only for same-machine comparisons.",
			},
		};
		const timestamp = result.capturedAt.replaceAll(/[:.]/g, "-");
		const output = options.output ?? join(repoRoot, "profiles-node", `desktop-baseline-${timestamp}.json`);
		mkdirSync(dirname(output), { recursive: true });
		writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`, "utf8");

		process.stdout.write(`Desktop baseline written to ${output}\n`);
		process.stdout.write(`RPC cold-ready median: ${startup.summary.elapsedMs.median.toFixed(1)}ms\n`);
		process.stdout.write(`One idle RPC process: ${formatMiB(oneRpcProcess.medianRssBytes)}\n`);
		process.stdout.write(`Three idle RPC processes: ${formatMiB(threeRpcProcesses.medianRssBytes)}\n`);
		process.stdout.write(`One idle in-process runtime: ${formatMiB(oneRuntime.medianRssBytes)}\n`);
		process.stdout.write(`Three idle in-process runtimes: ${formatMiB(threeRuntimes.medianRssBytes)}\n`);
	} finally {
		rmSync(tempRoot, { recursive: true, force: true });
	}
}

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.once(signal, () => {
		if (shuttingDown) return;
		shuttingDown = true;
		const exitCode = signal === "SIGINT" ? 130 : 143;
		process.exitCode = exitCode;
		void terminateAllChildren().finally(() => process.exit(exitCode));
	});
}

main().catch((error) => {
	if (shuttingDown) return;
	process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
	process.exitCode = 1;
});
