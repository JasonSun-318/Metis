import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFile, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const packageDir = join(repoRoot, "packages", "coding-agent");
const distCliPath = join(packageDir, "dist", "cli.js");
const srcCliPath = join(packageDir, "src", "cli.ts");
const defaultNodeProfileDir = join(repoRoot, "profiles-node");
const defaultBunProfileDir = join(repoRoot, "profiles-bun");
const agentDirEnvName = "METIS_CODING_AGENT_DIR";
const startupBenchmarkEnvName = "METIS_STARTUP_BENCHMARK";
const benchmarkTimeoutMs = 30_000;
const buildTimeoutMs = 10 * 60_000;
const benchmarkChildren = new Set();
let shuttingDown = false;

function printHelp() {
	console.log(`Usage:
  node scripts/profile-coding-agent-node.mjs [options]

Profiles coding-agent startup with the runtime selected below:
- npm run profile:tui     -> builds packages/coding-agent and profiles TUI startup with Node
- npm run profile:rpc     -> builds packages/coding-agent and profiles RPC startup with Node
- bun run profile:tui     -> profiles TUI startup from src/cli.ts directly with Bun
- bun run profile:rpc     -> profiles RPC startup from src/cli.ts directly with Bun

Options:
  --mode <name>          tui or rpc (default: tui)
  --runs <n>             Number of measured runs (default: 1)
  --warmup <n>           Number of warmup runs before measurements (default: 0)
  --profile-dir <dir>    CPU profile output directory
                         Default: profiles-node for Node, profiles-bun for Bun
  --label <name>         Profile name prefix (default: <mode>-startup)
  --runtime <name>       node, bun, or auto (default: auto)
  --agent-dir <dir>      Use a specific METIS_CODING_AGENT_DIR for the benchmark run
  --json-output <file>   Write raw measured samples and summaries as JSON
  --isolated-agent-dir   Use a fresh temporary agent dir instead of the normal one
  --minimal-resources    Disable extensions, skills, prompts, themes, and context files
  --no-offline           Do not force METIS_OFFLINE=1
  --skip-build           Reuse the current dist/cli.js without rebuilding first (Node only)
  --cpu-profile          Write CPU profiles for benchmark runs
  --help                 Show this help

Notes:
  - By default the benchmark uses your normal configured agent dir, so global models/auth/settings work.
  - TUI mode measures startup until the interactive UI reaches first usable state.
  - RPC mode measures startup until a real get_state request receives a response, then closes stdin to exit cleanly.
  - CPU profiles are kept in the selected profile directory for later analysis.
  - Offline mode applies to benchmark children. The default Node pre-build may run model generators;
    use --skip-build when profiling must remain strictly offline.
`);
}

function parseIntegerFlag(value, name, minimum = 0) {
	if (!/^\d+$/.test(value)) {
		throw new Error(`Invalid ${name}: ${value}`);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed < minimum) throw new Error(`Invalid ${name}: ${value}`);
	return parsed;
}

function parseRuntime(value) {
	if (value === "auto" || value === "node" || value === "bun") {
		return value;
	}
	throw new Error(`Invalid --runtime: ${value}`);
}

function parseMode(value) {
	if (value === "tui" || value === "rpc") {
		return value;
	}
	throw new Error(`Invalid --mode: ${value}`);
}

function parseArgs(argv) {
	const options = {
		mode: "tui",
		runs: 1,
		warmup: 0,
		profileDir: undefined,
		label: undefined,
		offline: true,
		build: true,
		runtime: "auto",
		agentDir: undefined,
		isolatedAgentDir: false,
		minimalResources: false,
		cpuProfile: false,
		jsonOutput: undefined,
	};

	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];

		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}

		if (arg === "--no-offline") {
			options.offline = false;
			continue;
		}

		if (arg === "--isolated-agent-dir") {
			options.isolatedAgentDir = true;
			continue;
		}

		if (arg === "--minimal-resources") {
			options.minimalResources = true;
			continue;
		}

		if (arg === "--skip-build") {
			options.build = false;
			continue;
		}

		if (arg === "--cpu-profile") {
			options.cpuProfile = true;
			continue;
		}

		if (
			(arg === "--mode" ||
				arg === "--runs" ||
				arg === "--warmup" ||
				arg === "--profile-dir" ||
				arg === "--label" ||
				arg === "--runtime" ||
				arg === "--agent-dir" ||
				arg === "--json-output") &&
			index + 1 >= argv.length
		) {
			throw new Error(`Missing value for ${arg}`);
		}

		if (arg === "--mode") {
			options.mode = parseMode(argv[++index]);
			continue;
		}

		if (arg === "--runs") {
			options.runs = parseIntegerFlag(argv[++index], "--runs", 1);
			continue;
		}

		if (arg === "--warmup") {
			options.warmup = parseIntegerFlag(argv[++index], "--warmup");
			continue;
		}

		if (arg === "--profile-dir") {
			options.profileDir = resolve(argv[++index]);
			continue;
		}

		if (arg === "--label") {
			options.label = argv[++index];
			continue;
		}

		if (arg === "--runtime") {
			options.runtime = parseRuntime(argv[++index]);
			continue;
		}

		if (arg === "--agent-dir") {
			options.agentDir = resolve(argv[++index]);
			continue;
		}

		if (arg === "--json-output") {
			options.jsonOutput = resolve(argv[++index]);
			continue;
		}

		throw new Error(`Unknown option: ${arg}`);
	}

	return options;
}

function detectRuntimeFromPackageManager() {
	const userAgent = process.env.npm_config_user_agent ?? "";
	return userAgent.startsWith("bun/") ? "bun" : "node";
}

function resolveRuntime(requestedRuntime) {
	if (requestedRuntime === "auto") {
		return detectRuntimeFromPackageManager();
	}
	return requestedRuntime;
}

function resolveProfileDir(runtime, requestedProfileDir) {
	if (requestedProfileDir) {
		return requestedProfileDir;
	}
	return runtime === "bun" ? defaultBunProfileDir : defaultNodeProfileDir;
}

function resolveLabel(mode, requestedLabel) {
	return requestedLabel ?? `${mode}-startup`;
}

function formatMs(value) {
	return `${value.toFixed(1)}ms`;
}

function toDisplayPath(path) {
	const relativePath = relative(repoRoot, path);
	if (relativePath !== "" && !relativePath.startsWith("..")) {
		return relativePath.replaceAll("\\", "/");
	}
	return path;
}

function summarize(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const total = sorted.reduce((sum, value) => sum + value, 0);
	const middle = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
	return {
		min: sorted[0],
		max: sorted[sorted.length - 1],
		avg: total / sorted.length,
		median,
	};
}

function parseStartupTimings(stderr) {
	const lines = stderr.split(/\r?\n/);
	const timings = new Map();
	let inBlock = false;

	for (const line of lines) {
		if (line.includes("--- Startup Timings ---")) {
			inBlock = true;
			continue;
		}
		if (!inBlock) {
			continue;
		}
		if (line.includes("------------------------")) {
			break;
		}
		const match = line.match(/^\s+([^:]+):\s+(\d+)ms$/);
		if (!match) {
			continue;
		}
		timings.set(match[1], Number.parseInt(match[2], 10));
	}

	return timings;
}

function summarizeTimingMaps(runs) {
	const valuesByLabel = new Map();
	for (const run of runs) {
		for (const [label, value] of run.timings.entries()) {
			const values = valuesByLabel.get(label);
			if (values) {
				values.push(value);
			} else {
				valuesByLabel.set(label, [value]);
			}
		}
	}

	const summaries = new Map();
	for (const [label, values] of valuesByLabel.entries()) {
		summaries.set(label, summarize(values));
	}
	return summaries;
}

function writeJsonResult(options, runtime, measuredRuns, elapsedSummary, timingSummaries) {
	if (!options.jsonOutput) return;
	mkdirSync(dirname(options.jsonOutput), { recursive: true });
	writeFileSync(
		options.jsonOutput,
		`${JSON.stringify(
			{
				generatedAt: new Date().toISOString(),
				runtime,
				mode: options.mode,
				warmupRuns: options.warmup,
				configuration: {
					offline: options.offline,
					isolatedAgentDir: options.isolatedAgentDir,
					minimalResources: options.minimalResources,
				},
				measuredRuns: measuredRuns.map((run) => ({
					elapsedMs: run.elapsedMs,
					timingsMs: Object.fromEntries(run.timings),
				})),
				summary: {
					elapsedMs: elapsedSummary,
					timingsMs: Object.fromEntries(timingSummaries),
				},
			},
			null,
			2,
		)}\n`,
		"utf8",
	);
}

function toMetricName(label) {
	return `${label.replaceAll(/[^a-zA-Z0-9]+/g, "_").replaceAll(/^_+|_+$/g, "")}_ms`;
}

async function waitForExit(child, errorPrefix) {
	const { code, signal } = await child.exitResult;
	if (signal) throw new Error(`${errorPrefix} exited from signal ${signal}`);
	return code;
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

function observeChild(child) {
	benchmarkChildren.add(child);
	child.exitResult = new Promise((resolvePromise, reject) => {
		child.once("error", (error) => {
			benchmarkChildren.delete(child);
			reject(error);
		});
		child.once("exit", (code, signal) => {
			benchmarkChildren.delete(child);
			resolvePromise({ code: code ?? 0, signal });
		});
	});
	return child;
}

function spawnManaged(executable, args, options) {
	if (shuttingDown) throw new Error("Profiler is shutting down");
	return observeChild(
		spawn(executable, args, {
			...options,
			detached: process.platform !== "win32",
		}),
	);
}

function execFileAsync(file, args) {
	return new Promise((resolvePromise, reject) => {
		execFile(file, args, { encoding: "utf8", maxBuffer: 10 * 1024 * 1024 }, (error, stdout, stderr) => {
			if (error) reject(Object.assign(error, { stdout, stderr }));
			else resolvePromise({ stdout, stderr });
		});
	});
}

async function processTable() {
	if (process.platform === "win32") {
		const script = "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress";
		const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script]);
		const parsed = JSON.parse(stdout || "[]");
		return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
			pid: Number(entry.ProcessId),
			ppid: Number(entry.ParentProcessId),
			pgid: Number(entry.ProcessId),
		}));
	}

	const { stdout } = await execFileAsync("ps", ["-axo", "pid=,ppid=,pgid="]);
	return stdout
		.trim()
		.split(/\r?\n/)
		.map((line) => line.trim().split(/\s+/).map(Number))
		.filter(([pid, ppid, pgid]) => Number.isFinite(pid) && Number.isFinite(ppid) && Number.isFinite(pgid))
		.map(([pid, ppid, pgid]) => ({ pid, ppid, pgid }));
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

async function terminateProcessTree(child) {
	if (!child) return;
	const tree = await processTable()
		.then((table) => collectProcessTree(table, child.pid))
		.catch(() => []);
	const processGroupIds =
		process.platform === "win32" ? [] : Array.from(new Set([child.pid, ...tree.map((entry) => entry.pgid)]));

	if (child.exitCode === null && child.signalCode === null) {
		child.stdin?.end();
		await waitWithTimeout(child.exitResult, 1_000, "graceful benchmark shutdown").catch(() => undefined);
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
		await waitForProcessGroupsToExit(processGroupIds, 250);
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
	await waitWithTimeout(child.exitResult, 1_000, "forced benchmark shutdown").catch(() => undefined);
	benchmarkChildren.delete(child);
}

async function terminateBenchmarkChildren() {
	while (benchmarkChildren.size > 0) {
		await Promise.all(Array.from(benchmarkChildren, (child) => terminateProcessTree(child)));
	}
}

async function runBuild() {
	process.stdout.write("Building packages/tui, packages/ai, packages/agent, and packages/coding-agent...\n");
	const startedAt = performance.now();
	const child = spawnManaged(
		"npm",
		[
			"run",
			"build",
			"--workspace",
			"packages/tui",
			"--workspace",
			"packages/ai",
			"--workspace",
			"packages/agent",
			"--workspace",
			"packages/coding-agent",
		],
		{
			cwd: repoRoot,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
			shell: process.platform === "win32",
		},
	);

	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	try {
		const exitCode = await waitWithTimeout(waitForExit(child, "Build"), buildTimeoutMs, "Build");
		if (exitCode !== 0) {
			if (stdout.trim()) {
				process.stdout.write(`${stdout}${stdout.endsWith("\n") ? "" : "\n"}`);
			}
			if (stderr.trim()) {
				process.stderr.write(`${stderr}${stderr.endsWith("\n") ? "" : "\n"}`);
			}
			throw new Error(`Build failed with exit code ${exitCode}`);
		}
	} finally {
		await terminateProcessTree(child);
	}

	process.stdout.write(`Build completed in ${formatMs(performance.now() - startedAt)}\n`);
}

function getRuntimeCommand(runtime, mode, profileDir, profileName, cpuProfile, minimalResources) {
	const benchmarkArgs = ["--no-session"];
	if (minimalResources) {
		benchmarkArgs.push(
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
		);
	}
	if (mode === "rpc") {
		benchmarkArgs.push("--mode", "rpc");
	}

	if (runtime === "bun") {
		const args = [];
		if (cpuProfile) {
			args.push("--cpu-prof", `--cpu-prof-dir=${profileDir}`, `--cpu-prof-name=${profileName}`);
		}
		args.push(srcCliPath, ...benchmarkArgs);
		return {
			executable: "bun",
			args,
		};
	}

	const args = [];
	if (cpuProfile) {
		args.push("--cpu-prof", `--cpu-prof-dir=${profileDir}`, `--cpu-prof-name=${profileName}`);
	}
	args.push(distCliPath, ...benchmarkArgs);
	return {
		executable: process.execPath,
		args,
	};
}

function createBenchmarkEnv(options, isolatedAgentDir) {
	const env = { ...process.env };
	if (options.agentDir) {
		env[agentDirEnvName] = options.agentDir;
	} else if (isolatedAgentDir) {
		env[agentDirEnvName] = isolatedAgentDir;
	}
	if (options.mode === "tui") {
		env[startupBenchmarkEnvName] = "1";
	}
	if (options.offline) {
		env.METIS_OFFLINE = "1";
	}
	return env;
}

async function runTuiBenchmarkRun({ runtime, runIndex, measuredIndex, options, profileDir }) {
	const runNumber = runIndex + 1;
	const suffix = String(runNumber).padStart(3, "0");
	const profileName = `${options.label}-${suffix}.cpuprofile`;
	const tempRoot = options.isolatedAgentDir ? mkdtempSync(join(tmpdir(), "metis-startup-benchmark-")) : undefined;
	const isolatedAgentDir = tempRoot ? join(tempRoot, "agent") : undefined;
	if (isolatedAgentDir) {
		mkdirSync(isolatedAgentDir, { recursive: true });
	}

	const command = getRuntimeCommand(
		runtime,
		"tui",
		profileDir,
		profileName,
		options.cpuProfile,
		options.minimalResources,
	);
	const startedAt = performance.now();
	const child = spawnManaged(command.executable, command.args, {
		cwd: packageDir,
		env: createBenchmarkEnv(options, isolatedAgentDir),
		stdio: ["inherit", "ignore", "pipe"],
		shell: process.platform === "win32" && runtime === "bun",
	});

	let stderr = "";
	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	try {
		const description = `Benchmark ${measuredIndex === undefined ? `warmup ${runNumber}` : `run ${measuredIndex}`}`;
		const exitCode = await waitWithTimeout(waitForExit(child, description), benchmarkTimeoutMs, description);
		const elapsedMs = performance.now() - startedAt;
		if (exitCode !== 0) {
			throw new Error(stderr.trim() || `Benchmark child exited with code ${exitCode}`);
		}

		const profilePath = options.cpuProfile ? join(profileDir, profileName) : undefined;
		if (profilePath && !existsSync(profilePath)) {
			throw new Error(`CPU profile was not written: ${profilePath}`);
		}

		return { elapsedMs, profilePath, timings: parseStartupTimings(stderr) };
	} finally {
		await terminateProcessTree(child);
		if (tempRoot) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	}
}

function splitJsonLines(buffer, onLine) {
	let remaining = buffer;
	while (true) {
		const newlineIndex = remaining.indexOf("\n");
		if (newlineIndex === -1) {
			return remaining;
		}
		const line = remaining.slice(0, newlineIndex);
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
		remaining = remaining.slice(newlineIndex + 1);
	}
}

async function runRpcBenchmarkRun({ runtime, runIndex, measuredIndex, options, profileDir }) {
	const runNumber = runIndex + 1;
	const suffix = String(runNumber).padStart(3, "0");
	const profileName = `${options.label}-${suffix}.cpuprofile`;
	const tempRoot = options.isolatedAgentDir ? mkdtempSync(join(tmpdir(), "metis-startup-benchmark-")) : undefined;
	const isolatedAgentDir = tempRoot ? join(tempRoot, "agent") : undefined;
	if (isolatedAgentDir) {
		mkdirSync(isolatedAgentDir, { recursive: true });
	}

	const command = getRuntimeCommand(
		runtime,
		"rpc",
		profileDir,
		profileName,
		options.cpuProfile,
		options.minimalResources,
	);
	const startedAt = performance.now();
	const child = spawnManaged(command.executable, command.args, {
		cwd: packageDir,
		env: createBenchmarkEnv(options, isolatedAgentDir),
		stdio: ["pipe", "pipe", "pipe"],
		shell: process.platform === "win32" && runtime === "bun",
	});

	let stdoutBuffer = "";
	let stderr = "";
	let readyElapsedMs;
	let responseError;
	const requestId = `startup-benchmark-${runNumber}`;

	child.stdout.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdoutBuffer = splitJsonLines(stdoutBuffer + chunk, (line) => {
			if (line.trim() === "") {
				return;
			}
			let parsed;
			try {
				parsed = JSON.parse(line);
			} catch (error) {
				responseError = error instanceof Error ? error.message : String(error);
				child.stdin.end();
				return;
			}

			if (parsed?.type !== "response" || parsed.id !== requestId || parsed.command !== "get_state") {
				return;
			}

			if (parsed.success !== true) {
				responseError = typeof parsed.error === "string" ? parsed.error : "get_state failed";
				child.stdin.end();
				return;
			}

			if (readyElapsedMs === undefined) {
				readyElapsedMs = performance.now() - startedAt;
				child.stdin.end();
			}
		});
	});

	child.stderr.setEncoding("utf8");
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	child.stdin.setDefaultEncoding("utf8");
	child.stdin.write(`${JSON.stringify({ id: requestId, type: "get_state" })}\n`);

	try {
		const description = `Benchmark ${measuredIndex === undefined ? `warmup ${runNumber}` : `run ${measuredIndex}`}`;
		const exitCode = await waitWithTimeout(waitForExit(child, description), benchmarkTimeoutMs, description);
		if (responseError) {
			throw new Error(responseError);
		}
		if (readyElapsedMs === undefined) {
			throw new Error(stderr.trim() || "RPC benchmark did not receive get_state response");
		}
		if (exitCode !== 0) {
			throw new Error(stderr.trim() || `Benchmark child exited with code ${exitCode}`);
		}

		const profilePath = options.cpuProfile ? join(profileDir, profileName) : undefined;
		if (profilePath && !existsSync(profilePath)) {
			throw new Error(`CPU profile was not written: ${profilePath}`);
		}

		return { elapsedMs: readyElapsedMs, profilePath, timings: parseStartupTimings(stderr) };
	} finally {
		await terminateProcessTree(child);
		if (tempRoot) {
			rmSync(tempRoot, { recursive: true, force: true });
		}
	}
}

async function runBenchmarkRun(params) {
	if (params.options.mode === "rpc") {
		return await runRpcBenchmarkRun(params);
	}
	return await runTuiBenchmarkRun(params);
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		printHelp();
		return;
	}

	if (options.agentDir && options.isolatedAgentDir) {
		throw new Error("--agent-dir and --isolated-agent-dir cannot be combined");
	}

	if (options.mode === "tui" && (!process.stdin.isTTY || !process.stdout.isTTY)) {
		throw new Error("TUI benchmark must be run from an interactive terminal.");
	}

	const runtime = resolveRuntime(options.runtime);
	options.label = resolveLabel(options.mode, options.label);
	const profileDir = resolveProfileDir(runtime, options.profileDir);

	if (runtime === "node" && options.build) {
		await runBuild();
	}
	if (runtime === "bun") {
		process.stdout.write(
			`Using Bun runtime with ${options.mode === "rpc" ? "packages/coding-agent/src/cli.ts --mode rpc" : "packages/coding-agent/src/cli.ts"}\n`,
		);
	}

	const entryPath = runtime === "bun" ? srcCliPath : distCliPath;
	if (!existsSync(entryPath)) {
		throw new Error(`CLI entrypoint not found: ${entryPath}`);
	}

	mkdirSync(profileDir, { recursive: true });

	const measuredRuns = [];
	const totalRuns = options.warmup + options.runs;
	for (let runIndex = 0; runIndex < totalRuns; runIndex++) {
		const measuredIndex = runIndex >= options.warmup ? runIndex - options.warmup + 1 : undefined;
		const result = await runBenchmarkRun({
			runtime,
			runIndex,
			measuredIndex,
			options,
			profileDir,
		});

		process.stdout.write(
			`[${measuredIndex === undefined ? `warmup ${runIndex + 1}` : `run ${measuredIndex}`}] elapsed=${formatMs(result.elapsedMs)}\n`,
		);

		if (measuredIndex !== undefined) {
			measuredRuns.push(result);
		}
	}

	if (measuredRuns.length === 0) {
		process.stdout.write("\nNo measured runs requested.\n");
		return;
	}

	const elapsedSummary = summarize(measuredRuns.map((run) => run.elapsedMs));
	const timingSummaries = summarizeTimingMaps(measuredRuns);
	writeJsonResult(options, runtime, measuredRuns, elapsedSummary, timingSummaries);
	const maxElapsedRun = measuredRuns.reduce((slowest, run) => (run.elapsedMs > slowest.elapsedMs ? run : slowest));
	if (measuredRuns.length === 1) {
		process.stdout.write("\nResult\n");
		process.stdout.write(`  runtime:          ${runtime}\n`);
		process.stdout.write(`  mode:             ${options.mode}\n`);
		process.stdout.write(`  elapsed:          ${formatMs(measuredRuns[0].elapsedMs)}\n`);
		for (const [label, summary] of timingSummaries.entries()) {
			process.stdout.write(`  ${label}: ${formatMs(summary.median)}\n`);
		}
		if (options.cpuProfile && maxElapsedRun.profilePath) {
			process.stdout.write(`  selected profile: ${toDisplayPath(maxElapsedRun.profilePath)}\n`);
			process.stdout.write(`  profiles dir:     ${toDisplayPath(profileDir)}\n`);
		}
		process.stdout.write(`METRIC startup_time_ms=${measuredRuns[0].elapsedMs.toFixed(1)}\n`);
		for (const [label, summary] of timingSummaries.entries()) {
			process.stdout.write(`METRIC ${toMetricName(label)}=${summary.median.toFixed(1)}\n`);
		}
		return;
	}

	process.stdout.write("\nSummary\n");
	process.stdout.write(`  runtime:          ${runtime}\n`);
	process.stdout.write(`  mode:             ${options.mode}\n`);
	process.stdout.write(`  elapsed min:      ${formatMs(elapsedSummary.min)}\n`);
	process.stdout.write(`  elapsed median:   ${formatMs(elapsedSummary.median)}\n`);
	process.stdout.write(`  elapsed avg:      ${formatMs(elapsedSummary.avg)}\n`);
	process.stdout.write(`  elapsed max:      ${formatMs(elapsedSummary.max)}\n`);
	for (const [label, summary] of timingSummaries.entries()) {
		process.stdout.write(`  ${label} median: ${formatMs(summary.median)}\n`);
	}
	if (options.cpuProfile && maxElapsedRun.profilePath) {
		process.stdout.write(`  selected profile: ${toDisplayPath(maxElapsedRun.profilePath)}\n`);
		process.stdout.write(`  profiles dir:     ${toDisplayPath(profileDir)}\n`);
	}
	process.stdout.write(`METRIC startup_time_ms=${elapsedSummary.median.toFixed(1)}\n`);
	for (const [label, summary] of timingSummaries.entries()) {
		process.stdout.write(`METRIC ${toMetricName(label)}=${summary.median.toFixed(1)}\n`);
	}
}

for (const signal of ["SIGINT", "SIGTERM"]) {
	process.once(signal, () => {
		if (shuttingDown) return;
		shuttingDown = true;
		const exitCode = signal === "SIGINT" ? 130 : 143;
		process.exitCode = exitCode;
		void terminateBenchmarkChildren().finally(() => process.exit(exitCode));
	});
}

main().catch((error) => {
	if (shuttingDown) return;
	const message = error instanceof Error ? error.message : String(error);
	console.error(message);
	process.exitCode = 1;
});
