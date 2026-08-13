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
const distAppServerIndex = join(repoRoot, "packages", "app-server", "dist", "index.js");
const startupProfiler = join(repoRoot, "scripts", "profile-coding-agent-node.mjs");
const agentDirEnvName = "METIS_CODING_AGENT_DIR";
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
	const options = {
		runs: 5,
		warmup: 1,
		output: undefined,
		runtimeHost: undefined,
		agentDir: undefined,
		sandbox: false,
		permissionSandbox: false,
		scheduleIdle: false,
		scheduleDue: false,
	};
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		if (arg === "--help" || arg === "-h") {
			options.help = true;
			continue;
		}
		if (["--runs", "--warmup", "--output", "--runtime-host", "--agent-dir"].includes(arg) && index + 1 >= argv.length) {
			throw new Error(`Missing value for ${arg}`);
		}
		if (arg === "--sandbox") options.sandbox = true;
		else if (arg === "--permission-sandbox") options.permissionSandbox = true;
		else if (arg === "--schedule-idle") options.scheduleIdle = true;
		else if (arg === "--schedule-due") options.scheduleDue = true;
		else if (arg === "--runs") options.runs = parseInteger(argv[++index], arg, 1);
		else if (arg === "--warmup") options.warmup = parseInteger(argv[++index], arg);
		else if (arg === "--output") options.output = resolve(argv[++index]);
		else if (arg === "--runtime-host") options.runtimeHost = parseInteger(argv[++index], arg, 1);
		else if (arg === "--agent-dir") options.agentDir = resolve(argv[++index]);
		else throw new Error(`Unknown option: ${arg}`);
	}
	if ([options.sandbox, options.permissionSandbox, options.scheduleIdle, options.scheduleDue].filter(Boolean).length > 1) {
		throw new Error("Choose only one opt-in measurement case");
	}
	return options;
}

function printHelp() {
	process.stdout.write(`Usage: node scripts/profile-app-server-baseline.mjs [options]\n\n`);
	process.stdout.write(`  --runs <n>       Measured cold-ready runs (default: 5)\n`);
	process.stdout.write(`  --warmup <n>     Warm-up runs (default: 1)\n`);
	process.stdout.write(`  --output <file>  JSON result path (default: profiles-node/desktop-baseline-<time>.json)\n`);
	process.stdout.write(`  --sandbox       Measure one isolated workspace-sandbox lifecycle\n`);
	process.stdout.write(`  --permission-sandbox Measure lazy/reused interactive sandbox and exact-rule lookup\n`);
	process.stdout.write(`  --schedule-idle Measure 10,000 idle scheduled tasks for 60 seconds\n`);
	process.stdout.write(`  --schedule-due  Measure 100 fake due scheduled tasks\n`);
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
	return { ...process.env, [agentDirEnvName]: agentDir, METIS_OFFLINE: "1" };
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
		{ cwd: repoRoot, env: { ...process.env, METIS_OFFLINE: "1" } },
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

async function measureWorkspaceSandbox() {
	const codingAgent = await import(pathToFileURL(distIndex).href);
	const root = mkdtempSync(join(tmpdir(), "metis-sandbox-profile-"));
	const cwd = join(root, "workspace");
	const outside = join(root, "outside");
	mkdirSync(cwd);
	mkdirSync(outside);
	const handlesBefore = process._getActiveHandles().length;
	const rssBefore = process.memoryUsage().rss;
	let sandbox;
	try {
		const startupStartedAt = performance.now();
		sandbox = await codingAgent.createWorkspaceSandbox({ cwd, workspaceRoots: [cwd] });
		const startupMs = performance.now() - startupStartedAt;

		const output = [];
		const commandStartedAt = performance.now();
		const commandResult = await sandbox.operations.exec("printf ok", cwd, {
			onData: (chunk) => output.push(chunk),
		});
		const commandMs = performance.now() - commandStartedAt;
		if (commandResult.exitCode !== 0 || Buffer.concat(output).toString() !== "ok") {
			throw new Error("Sandbox command probe failed");
		}

		const outsidePath = join(outside, "blocked.txt");
		const outsideResult = await sandbox.operations.exec(
			`printf blocked > ${JSON.stringify(outsidePath)}`,
			cwd,
			{ onData: () => {} },
		);
		if (outsideResult.exitCode === 0 || existsSync(outsidePath)) {
			throw new Error("Sandbox outside-write probe escaped the workspace");
		}

		const disposeStartedAt = performance.now();
		await sandbox.dispose();
		sandbox = undefined;
		const disposeMs = performance.now() - disposeStartedAt;
		const settleStartedAt = performance.now();
		let activeHandlesAfterDispose = process._getActiveHandles().length;
		while (activeHandlesAfterDispose > handlesBefore && performance.now() - settleStartedAt < 250) {
			await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
			activeHandlesAfterDispose = process._getActiveHandles().length;
		}
		const cleanupSettleMs = performance.now() - settleStartedAt;
		if (activeHandlesAfterDispose > handlesBefore) {
			throw new Error(
				`Sandbox leaked active handles: before=${handlesBefore}, after=${activeHandlesAfterDispose}`,
			);
		}
		process.stdout.write(
			`${JSON.stringify({
				case: "workspace-sandbox",
				startupMs,
				commandMs,
				disposeMs,
				cleanupSettleMs,
				rssDeltaBytes: process.memoryUsage().rss - rssBefore,
				activeHandlesAfterDispose,
			})}\n`,
		);
	} finally {
		await sandbox?.dispose().catch(() => undefined);
		rmSync(root, { recursive: true, force: true });
	}
}

async function measurePermissionSandbox() {
	const codingAgent = await import(pathToFileURL(distIndex).href);
	const root = mkdtempSync(join(tmpdir(), "metis-permission-sandbox-profile-"));
	const agentDir = join(root, "agent");
	const cwd = join(root, "workspace");
	mkdirSync(agentDir);
	mkdirSync(cwd);
	const handlesBefore = process._getActiveHandles().length;
	let brokerCreationCount = 0;
	let hostExecutionCount = 0;
	const openStartedAt = performance.now();
	const boundary = codingAgent.createInteractiveBashBoundary({
		hostOperations: {
			exec: async () => {
				hostExecutionCount += 1;
				throw new Error("Permission sandbox profile unexpectedly used host Bash");
			},
		},
		context: () => ({ cwd, workspaceRoots: [cwd], readOnlyRoots: [], writeRoots: [] }),
		createSandbox: async (input) => {
			brokerCreationCount += 1;
			return codingAgent.createWorkspaceSandbox(input);
		},
	});
	const sessionOpenBeforeBashMs = performance.now() - openStartedAt;
	if (brokerCreationCount !== 0) throw new Error("Interactive sandbox was not lazy");
	try {
		const execute = async (actionId, command) => {
			boundary.bind(actionId, "sandbox");
			const output = [];
			const startedAt = performance.now();
			const result = await boundary.operations.exec(command, cwd, {
				actionId,
				onData: (chunk) => output.push(chunk),
			});
			if (result.exitCode !== 0) throw new Error(`Permission sandbox command failed: ${command}`);
			return { durationMs: performance.now() - startedAt, output: Buffer.concat(output).toString() };
		};
		const first = await execute("profile-first", "printf first");
		const reused = [];
		for (let index = 0; index < 10; index++) reused.push(await execute(`profile-${index}`, `printf ${index}`));
		if (brokerCreationCount !== 1) throw new Error(`Expected one reused broker, observed ${brokerCreationCount}`);

		const rules = new codingAgent.ProjectPermissionRuleStore(agentDir);
		let lastInput;
		for (let index = 0; index < 256; index++) {
			lastInput = {
				projectPath: cwd,
				cwd,
				workspaceRoots: [cwd],
				action: {
					actionId: `rule-${index}`,
					toolName: "bash",
					provenance: "builtin",
					risks: ["shell"],
					paths: [],
					networkTargets: [],
					command: `printf ${index}`,
				},
				args: { command: `printf ${index}` },
				executionTarget: "sandbox",
			};
			rules.remember(lastInput);
		}
		const ruleLookupStartedAt = performance.now();
		if (!rules.match(lastInput)) throw new Error("Exact permission rule lookup missed");
		const ruleLookup256Ms = performance.now() - ruleLookupStartedAt;

		const fullSwitchStartedAt = performance.now();
		await boundary.reset();
		const fullSwitchDisposeMs = performance.now() - fullSwitchStartedAt;
		await boundary.dispose();
		const activeHandlesAfterDispose = await handlesAfterStop(handlesBefore);
		if (activeHandlesAfterDispose > handlesBefore) throw new Error("Permission sandbox leaked active handles");
		if (hostExecutionCount !== 0) throw new Error("Permission sandbox fell back to host execution");
		process.stdout.write(`${JSON.stringify({
			case: "permission-sandbox",
			sessionOpenBeforeBashMs,
			brokerCreationCountBeforeFirst: 0,
			firstSandboxBashMs: first.durationMs,
			reusedSandboxBashMs: reused.map((sample) => sample.durationMs),
			brokerCreationCount,
			ruleLookup256Ms,
			fullSwitchDisposeMs,
			hostExecutionCount,
			activeHandlesAfterDispose,
		})}\n`);
	} finally {
		await boundary.dispose().catch(() => undefined);
		rmSync(root, { recursive: true, force: true });
	}
}

function seedIdleScheduleIndex(agentDir, workspace, taskCount) {
	const createdAt = "2026-07-26T00:00:00.000Z";
	const tasks = Array.from({ length: taskCount }, (_, index) => ({
		id: `t${index.toString(36)}`,
		title: "i",
		instruction: "i",
		schedule: { kind: "daily", time: "23:59" },
		timezone: "UTC",
		target: { kind: "project", cwd: workspace },
		status: "active",
		createdAt,
		updatedAt: createdAt,
		nextRunAt: "2099-01-01T23:59:00.000Z",
		unreadCount: 0,
		nextRunSequence: 1,
	}));
	writeFileSync(join(agentDir, "schedules.json"), `${JSON.stringify({ version: 1, revision: 0, tasks, events: [] })}\n`);
}

function instrumentScheduleStore(manager) {
	const store = manager.store;
	let indexReadCount = 0;
	let runDirectoryScanCount = 0;
	const readIndex = store.readIndex.bind(store);
	const indexFingerprint = store.indexFingerprint.bind(store);
	const runFileNames = store.runFileNames.bind(store);
	store.readIndex = (...args) => {
		indexReadCount += 1;
		return readIndex(...args);
	};
	store.indexFingerprint = (...args) => {
		indexReadCount += 1;
		return indexFingerprint(...args);
	};
	store.runFileNames = (...args) => {
		runDirectoryScanCount += 1;
		return runFileNames(...args);
	};
	return {
		reset() {
			indexReadCount = 0;
			runDirectoryScanCount = 0;
		},
		snapshot: () => ({ indexReadCount, runDirectoryScanCount }),
	};
}

async function waitUntil(predicate, timeoutMs, description) {
	const deadline = performance.now() + timeoutMs;
	while (!predicate()) {
		if (performance.now() >= deadline) throw new Error(`${description} timed out after ${timeoutMs}ms`);
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
	}
}

async function handlesAfterStop(baseline) {
	const deadline = performance.now() + 1_000;
	let current = process._getActiveHandles().length;
	while (current > baseline && performance.now() < deadline) {
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
		current = process._getActiveHandles().length;
	}
	return current;
}

function percentile(values, fraction) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((left, right) => left - right);
	return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
}

async function measureScheduleIdle() {
	if (!existsSync(distAppServerIndex)) throw new Error("Built app-server entrypoint is missing. Run its build first.");
	const [{ ScheduleManager }, { AppServer }] = await Promise.all([
		import(pathToFileURL(distIndex).href),
		import(pathToFileURL(distAppServerIndex).href),
	]);
	const root = mkdtempSync(join(tmpdir(), "metis-schedule-idle-profile-"));
	const agentDir = join(root, "agent");
	const workspace = tmpdir();
	mkdirSync(agentDir);
	seedIdleScheduleIndex(agentDir, workspace, 10_000);
	let executorCalls = 0;
	const manager = ScheduleManager.create({
		agentDir,
		execute: async () => {
			executorCalls += 1;
			throw new Error("Idle profile unexpectedly executed a task");
		},
	});
	const metrics = instrumentScheduleStore(manager);
	const handlesBefore = process._getActiveHandles().length;
	let server;
	try {
		server = await AppServer.create({ agentDir, scheduleManager: manager });
		await waitUntil(() => manager.leaderRelease && !manager.leaderTickRunning, 60_000, "schedule leader startup");
		metrics.reset();
		const rssBefore = process.memoryUsage().rss;
		const cpuBefore = process.cpuUsage();
		const page = await manager.list({ limit: 200 });
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 60_000));
		const cpu = process.cpuUsage(cpuBefore);
		const measured = metrics.snapshot();
		server.beginShutdown();
		await server.waitForShutdown();
		server = undefined;
		const activeHandlesAfterStop = await handlesAfterStop(handlesBefore);
		if (page.tasks.length !== 200) throw new Error("Idle task list did not return the requested page");
		if (measured.indexReadCount > 31) {
			throw new Error(`Idle schedule performed too many index checks: ${measured.indexReadCount}`);
		}
		if (measured.runDirectoryScanCount !== 0) throw new Error("Idle schedule scanned run directories");
		if (executorCalls !== 0) throw new Error("Idle schedule created an executor/runtime");
		if (activeHandlesAfterStop > handlesBefore) throw new Error("Schedule idle profile leaked active handles");
		process.stdout.write(
			`${JSON.stringify({
				case: "schedule-idle",
				idleCpuMs: (cpu.user + cpu.system) / 1_000,
				idleRssDeltaBytes: process.memoryUsage().rss - rssBefore,
				...measured,
				maxConcurrentExecutors: 0,
				p50ClaimMs: null,
				p95ClaimMs: null,
				eventDeliveryP95Ms: null,
				modelRuntimeCreationCount: executorCalls,
				brokerCreationCount: executorCalls,
				activeHandlesAfterStop,
			})}\n`,
		);
	} finally {
		server?.beginShutdown();
		await server?.waitForShutdown().catch(() => undefined);
		await manager.stop().catch(() => undefined);
		rmSync(root, { recursive: true, force: true });
	}
}

async function measureScheduleDue() {
	const { ScheduleManager } = await import(pathToFileURL(distIndex).href);
	const root = mkdtempSync(join(tmpdir(), "metis-schedule-due-profile-"));
	const agentDir = join(root, "agent");
	const workspace = join(root, "workspace");
	mkdirSync(agentDir);
	mkdirSync(workspace);
	let clock = new Date("2026-07-26T00:00:00.000Z");
	let active = 0;
	let maxConcurrentExecutors = 0;
	let dueStartedAt = 0;
	const claimMs = [];
	const completionStartedAt = new Map();
	const eventDeliveryMs = [];
	const claimedRuns = new Set();
	const completedRuns = new Set();
	const pending = [];
	const execute = (claim) =>
		new Promise((resolvePromise) => {
			active += 1;
			maxConcurrentExecutors = Math.max(maxConcurrentExecutors, active);
			claimMs.push(performance.now() - dueStartedAt);
			claimedRuns.add(claim.runId);
			pending.push({ claim, resolvePromise });
			if (pending.length !== 2) return;
			const batch = pending.splice(0);
			setTimeout(() => {
				for (const entry of batch) {
					completionStartedAt.set(entry.claim.runId, performance.now());
					active -= 1;
					entry.resolvePromise({
						runId: entry.claim.runId,
						sessionId: `profile-session-${entry.claim.runId}`,
						sessionFile: join(agentDir, `${entry.claim.runId}.jsonl`),
						result: "ok",
					});
				}
			}, 2);
		});
	const manager = ScheduleManager.create({ agentDir, now: () => clock, execute });
	const handlesBefore = process._getActiveHandles().length;
	try {
		for (let index = 0; index < 100; index += 1) {
			await manager.create({
				id: `profile-task-${String(index).padStart(3, "0")}`,
				instruction: "profile",
				schedule: { kind: "once", date: "2026-07-26", time: "08:01" },
				timezone: "Asia/Shanghai",
				target: { kind: "project", cwd: workspace },
			});
		}
		manager.subscribe((event) => {
			if (event.type !== "schedule/run-updated" || event.run.status !== "succeeded") return;
			const startedAt = completionStartedAt.get(event.run.id);
			if (startedAt !== undefined) eventDeliveryMs.push(performance.now() - startedAt);
			completedRuns.add(event.run.id);
		});
		clock = new Date("2026-07-26T00:01:00.000Z");
		dueStartedAt = performance.now();
		await manager.start();
		await waitUntil(() => completedRuns.size === 100, 120_000, "100 scheduled runs");
		await manager.stop();
		const activeHandlesAfterStop = await handlesAfterStop(handlesBefore);
		if (claimedRuns.size !== 100 || completedRuns.size !== 100) throw new Error("Due profile found duplicate claims");
		if (maxConcurrentExecutors !== 2) {
			throw new Error(`Expected executor concurrency 2, observed ${maxConcurrentExecutors}`);
		}
		if (activeHandlesAfterStop > handlesBefore) throw new Error("Schedule due profile leaked active handles");
		process.stdout.write(
			`${JSON.stringify({
				case: "schedule-due",
				idleCpuMs: null,
				idleRssDeltaBytes: null,
				indexReadCount: null,
				runDirectoryScanCount: null,
				maxConcurrentExecutors,
				p50ClaimMs: percentile(claimMs, 0.5),
				p95ClaimMs: percentile(claimMs, 0.95),
				eventDeliveryP95Ms: percentile(eventDeliveryMs, 0.95),
				activeHandlesAfterStop,
			})}\n`,
		);
	} finally {
		await manager.stop().catch(() => undefined);
		rmSync(root, { recursive: true, force: true });
	}
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
	if (options.sandbox) {
		await measureWorkspaceSandbox();
		return;
	}
	if (options.permissionSandbox) {
		await measurePermissionSandbox();
		return;
	}
	if (options.scheduleIdle) {
		await measureScheduleIdle();
		return;
	}
	if (options.scheduleDue) {
		await measureScheduleDue();
		return;
	}
	if (options.runtimeHost !== undefined) {
		await runRuntimeHost(options.runtimeHost, options.agentDir);
		return;
	}

	const tempRoot = mkdtempSync(join(tmpdir(), "metis-desktop-baseline-"));
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
