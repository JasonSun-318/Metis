import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { arch, cpus, hostname, platform, release, tmpdir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { SessionManager, getDefaultSessionDir } from "../packages/coding-agent/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const desktopRoot = join(repoRoot, "packages", "desktop");
const baselineDir = join(repoRoot, "profiles-node");
const HISTORY_SESSION_ID = "00000000-0000-4000-8000-000000000301";

function args(argv) {
	const options = { runs: 3, enforce: true, output: undefined };
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (value === "--runs") options.runs = Number(argv[++index]);
		else if (value === "--output") options.output = resolve(argv[++index]);
		else if (value === "--no-enforce") options.enforce = false;
		else if (value === "--help") options.help = true;
		else throw new Error(`Unknown option: ${value}`);
	}
	if (!Number.isSafeInteger(options.runs) || options.runs < 1) throw new Error("--runs must be a positive integer");
	return options;
}

function nativeArch() {
	if (
		process.platform === "darwin" &&
		spawnSync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8" }).stdout.trim() === "1"
	)
		return "arm64";
	const machine = process.platform === "win32" ? process.env.PROCESSOR_ARCHITEW6432 ?? process.arch : process.arch;
	return /^(arm64|aarch64)$/iu.test(machine) ? "arm64" : /^(x64|x86_64|amd64)$/iu.test(machine) ? "x64" : machine;
}

function packagedExecutable() {
	const root = join(desktopRoot, "out", `ArcMind-${process.platform}-${nativeArch()}`);
	if (process.platform === "darwin") return join(root, "ArcMind.app", "Contents", "MacOS", "arcmind");
	if (process.platform === "win32") return join(root, "arcmind.exe");
	return join(root, "arcmind");
}

function median(values) {
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, fraction) {
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
	return sorted[Math.max(0, index)];
}

async function waitFor(read, accept, label, timeoutMs = 20_000) {
	const deadline = performance.now() + timeoutMs;
	let value;
	do {
		value = await read();
		if (accept(value)) return value;
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
	} while (performance.now() < deadline);
	throw new Error(`${label} timed out; last value: ${JSON.stringify(value)}`);
}

async function listen(server) {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected a TCP server");
	return address.port;
}

async function reservePort() {
	const server = createServer();
	const port = await listen(server);
	await new Promise((resolvePromise) => server.close(resolvePromise));
	return port;
}

function processTable() {
	if (process.platform === "win32") {
		const script =
			"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,CommandLine | ConvertTo-Json -Compress";
		const output = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" });
		const parsed = JSON.parse(output.stdout || "[]");
		return (Array.isArray(parsed) ? parsed : [parsed]).map((entry) => ({
			pid: Number(entry.ProcessId),
			ppid: Number(entry.ParentProcessId),
			rssBytes: Number(entry.WorkingSetSize),
			command: entry.CommandLine ?? "",
		}));
	}
	const output = spawnSync("ps", ["-axo", "pid=,ppid=,rss=,command="], { encoding: "utf8" });
	return output.stdout
		.trim()
		.split("\n")
		.map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/u))
		.filter(Boolean)
		.map((match) => ({
			pid: Number(match[1]),
			ppid: Number(match[2]),
			rssBytes: Number(match[3]) * 1024,
			command: match[4] ?? "",
		}));
}

function descendants(rootPid) {
	const table = processTable();
	const parents = [rootPid];
	const found = [];
	for (let index = 0; index < parents.length; index += 1) {
		for (const entry of table) {
			if (entry.ppid !== parents[index]) continue;
			found.push(entry);
			parents.push(entry.pid);
		}
	}
	return found;
}

function appServerProcess(rootPid) {
	return descendants(rootPid).find(
		(entry) => entry.command.includes("--type=utility") && entry.command.includes("node.mojom.NodeService"),
	);
}

async function medianRss(pid) {
	const samples = [];
	for (let index = 0; index < 3; index += 1) {
		const entry = processTable().find((candidate) => candidate.pid === pid);
		if (!entry) throw new Error(`Process ${pid} exited before RSS sampling`);
		samples.push(entry.rssBytes);
		await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
	}
	return { samples, medianBytes: median(samples) };
}

function createHistory(agentDir, cwd) {
	mkdirSync(cwd, { recursive: true });
	const manager = SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir), { id: HISTORY_SESSION_ID });
	let parentId = manager.appendSessionInfo("10,000 item profile");
	const sessionFile = manager.getSessionFile();
	manager.close();
	const timestamp = "2026-07-16T00:00:00.000Z";
	const records = [];
	for (let index = 0; index < 10_000; index += 1) {
		const id = `history-${String(index).padStart(5, "0")}`;
		records.push(
			JSON.stringify({
				type: "message",
				id,
				parentId,
				timestamp,
				message: { role: "user", content: [{ type: "text", text: `History ${index}` }], timestamp: index },
			}),
		);
		parentId = id;
	}
	appendFileSync(sessionFile, `${records.join("\n")}\n`);
}

function sse(model, choices) {
	return `${choices
		.map((choice, index) =>
			`data: ${JSON.stringify({
				id: `chatcmpl-profile-${index}`,
				object: "chat.completion.chunk",
				created: 1,
				model,
				choices: [choice],
			})}\n\n`,
		)
		.join("")}data: [DONE]\n\n`;
}

function deferred() {
	let resolvePromise;
	const promise = new Promise((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: resolvePromise };
}

async function stop(child) {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	await Promise.race([once(child, "exit"), new Promise((resolvePromise) => setTimeout(resolvePromise, 3_000))]);
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

async function connect(port) {
	await waitFor(
		async () => {
			try {
				const response = await fetch(`http://127.0.0.1:${port}/json/list`);
				return response.ok;
			} catch {
				return false;
			}
		},
		Boolean,
		"DevTools endpoint",
	);
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	const page = await waitFor(
		() => browser.contexts().flatMap((context) => context.pages())[0],
		Boolean,
		"packaged renderer target",
	);
	return { browser, page };
}

async function assistantTextLength(page, cwd) {
	return page.evaluate(async (projectCwd) => {
		const api = globalThis.arcMind;
		const listed = await api.listSessions({ limit: 200 });
		const session = listed.sessions.find((candidate) => candidate.cwd === projectCwd);
		if (!session) return -1;
		const page = await api.readItems({ sessionId: session.sessionId, limit: 200 });
		return page.items
			.filter((item) => item.role === "assistant")
			.flatMap((item) => item.content)
			.filter((block) => block.type === "text")
			.reduce((total, block) => total + block.text.length, 0);
	}, cwd);
}

async function oneRun(executable, run) {
	const root = mkdtempSync(join(tmpdir(), `arcmind-desktop-profile-${run}-`));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project-1");
	const otherProjects = [join(root, "project-2"), join(root, "project-3")];
	const historyDir = join(root, "history-project");
	const userDataDir = join(root, "electron");
	for (const directory of [agentDir, projectDir, ...otherProjects, userDataDir]) mkdirSync(directory, { recursive: true });
	createHistory(agentDir, historyDir);

	const gates = [deferred(), deferred()];
	const started = [deferred(), deferred()];
	const receivedAt = [];
	let requestCount = 0;
	const provider = createServer(async (request, response) => {
		for await (const _chunk of request) {
			// Drain request input.
		}
		const index = requestCount++;
		receivedAt[index] = performance.now();
		started[index]?.resolve();
		await gates[index]?.promise;
		response.writeHead(200, { "content-type": "text/event-stream" });
		if (index === 0) {
			response.end(
				sse("profile-model", [
					{ index: 0, delta: { role: "assistant", content: "profile-delta" }, finish_reason: null },
					{ index: 0, delta: {}, finish_reason: "stop" },
				]),
			);
			return;
		}
		const choices = Array.from({ length: 10_000 }, (_, choiceIndex) => ({
			index: 0,
			delta: { ...(choiceIndex === 0 ? { role: "assistant" } : {}), content: "x" },
			finish_reason: null,
		}));
		choices.push({ index: 0, delta: {}, finish_reason: "stop" });
		response.end(sse("profile-model", choices));
	});
	const providerPort = await listen(provider);
	writeFileSync(
		join(agentDir, "models.json"),
		JSON.stringify({
			providers: {
				local: {
					baseUrl: `http://127.0.0.1:${providerPort}/v1`,
					apiKey: "profile-key",
					api: "openai-completions",
					models: [{ id: "profile-model", name: "Profile", contextWindow: 64_000, maxTokens: 16_000 }],
				},
			},
		}),
	);
	writeFileSync(
		join(agentDir, "settings.json"),
		JSON.stringify({ defaultProvider: "local", defaultModel: "profile-model", retry: { enabled: false } }),
	);

	const port = await reservePort();
	const diagnostics = [];
	const launchAt = performance.now();
	const app = spawn(executable, [`--remote-debugging-port=${port}`, `--user-data-dir=${userDataDir}`], {
		cwd: projectDir,
		env: {
			...process.env,
			ARCMIND_CODING_AGENT_DIR: agentDir,
			HTTP_PROXY: "",
			HTTPS_PROXY: "",
			NO_PROXY: "127.0.0.1,localhost",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	app.stdout.on("data", (chunk) => diagnostics.push(String(chunk)));
	app.stderr.on("data", (chunk) => diagnostics.push(String(chunk)));
	let browser;
	try {
		const rootPid = app.pid;
		if (!rootPid) throw new Error("Packaged app has no PID");
		const utilityDetected = waitFor(
			async () => ({ process: appServerProcess(rootPid), at: performance.now() }),
			(value) => Boolean(value.process),
			"App Server process",
		);
		const connected = await connect(port);
		browser = connected.browser;
		const page = connected.page;
		await page.locator(".server-pill").waitFor({ state: "visible" });
		await waitFor(() => page.locator(".server-pill").textContent(), (value) => value === "ready", "App Server ready");
		await page.getByRole("button", { name: "New task" }).waitFor({ state: "visible" });
		const usableAt = performance.now();
		const detected = await utilityDetected;
		const initialUtilityPid = detected.process.pid;

		const zeroSessionRss = await medianRss(initialUtilityPid);
		await page.getByRole("button", { name: "New task" }).click();
		await page.locator("#project-path").fill(projectDir);
		await page.getByRole("button", { name: "Create" }).click();
		await waitFor(() => page.locator("h1").textContent(), (value) => value === projectDir, "first session open");
		const oneSessionRss = await medianRss(initialUtilityPid);
		const firstSessionId = await page.evaluate(async (cwd) => {
			const sessions = await globalThis.arcMind.listSessions({ limit: 200 });
			return sessions.sessions.find((session) => session.cwd === cwd)?.sessionId;
		}, projectDir);
		if (!firstSessionId) throw new Error("First profile session is missing");
		await page.evaluate(async (paths) => {
			for (const cwd of paths) {
				const created = await globalThis.arcMind.createSession({ requestId: crypto.randomUUID(), cwd });
				await globalThis.arcMind.openSession({ sessionId: created.session.sessionId });
			}
		}, otherProjects);
		const threeSessionRss = await medianRss(initialUtilityPid);
		await page.evaluate((sessionId) => localStorage.setItem("arcmind.activeSessionId", sessionId), firstSessionId);
		await page.reload({ waitUntil: "domcontentloaded" });
		await waitFor(() => page.locator("h1").textContent(), (value) => value === projectDir, "restore first session");

		const turnAckMs = await page.evaluate(async (sessionId) => {
			const before = performance.now();
			await globalThis.arcMind.startTurn({ sessionId, requestId: crypto.randomUUID(), text: "profile first delta" });
			return performance.now() - before;
		}, firstSessionId);
		await started[0].promise;
		const firstReleaseAt = performance.now();
		gates[0].resolve();
		await waitFor(
			() => assistantTextLength(page, projectDir),
			(length) => length >= "profile-delta".length,
			"server first delta",
		);
		const serverFirstDeltaMs = performance.now() - firstReleaseAt;
		await waitFor(
			() => page.locator(".message-assistant p").last().textContent(),
			(text) => text === "profile-delta",
			"renderer first delta",
		);
		const firstVisibleDeltaMs = performance.now() - firstReleaseAt;
		await waitFor(
			async () => {
				const sessions = await page.evaluate(() => globalThis.arcMind.listSessions({ limit: 200 }));
				return sessions.sessions.find((session) => session.sessionId === firstSessionId)?.state;
			},
			(state) => state === "idle",
			"first turn completion",
		);

		await page.evaluate(async (sessionId) => {
			await globalThis.arcMind.startTurn({ sessionId, requestId: crypto.randomUUID(), text: "profile 10000 deltas" });
		}, firstSessionId);
		await started[1].promise;
		const streamReleaseAt = performance.now();
		gates[1].resolve();
		await waitFor(
			() => page.locator(".message-assistant p").last().textContent(),
			(text) => text?.length === 10_000,
			"10,000 renderer deltas",
			30_000,
		);
		const tenThousandDeltaMs = performance.now() - streamReleaseAt;
		const streamedDomCount = await page.locator("[data-transcript-item]").count();
		const reloadAt = performance.now();
		await page.reload({ waitUntil: "domcontentloaded" });
		await waitFor(
			() => page.locator(".message-assistant p").last().textContent(),
			(text) => text?.length === 10_000,
			"renderer reload resnapshot",
		);
		const rendererReloadMs = performance.now() - reloadAt;

		const beforeCrashPid = appServerProcess(rootPid)?.pid;
		if (!beforeCrashPid) throw new Error("App Server disappeared before crash sample");
		const crashAt = performance.now();
		process.kill(beforeCrashPid, "SIGKILL");
		const replacement = await waitFor(
			async () => appServerProcess(rootPid),
			(value) => Boolean(value && value.pid !== beforeCrashPid),
			"App Server replacement",
			10_000,
		);
		const crashDetectedMs = performance.now() - crashAt;
		await waitFor(() => page.locator(".server-pill").textContent(), (value) => value === "ready", "crash recovery ready");
		const crashRecoveryMs = performance.now() - crashAt;

		const historyOpen = await page.evaluate(async (sessionId) => {
			const before = performance.now();
			const snapshot = await globalThis.arcMind.openSession({ sessionId });
			return {
				elapsedMs: performance.now() - before,
				initialItems: snapshot.recentItems.length,
				nextBeforeItemId: snapshot.nextBeforeItemId,
			};
		}, HISTORY_SESSION_ID);
		const olderPage = await page.evaluate(async ({ sessionId, beforeItemId }) => {
			const before = performance.now();
			const page = await globalThis.arcMind.readItems({ sessionId, beforeItemId, limit: 200 });
			return { elapsedMs: performance.now() - before, items: page.items.length };
		}, { sessionId: HISTORY_SESSION_ID, beforeItemId: historyOpen.nextBeforeItemId });

		await page.evaluate((sessionId) => localStorage.setItem("arcmind.activeSessionId", sessionId), HISTORY_SESSION_ID);
		await page.reload({ waitUntil: "domcontentloaded" });
		await waitFor(() => page.locator("h1").textContent(), (value) => value === "10,000 item profile", "history UI open");
		const pagingAt = performance.now();
		let pagesLoaded = 1;
		for (;;) {
			const button = page.getByRole("button", { name: "Load older messages" });
			if ((await button.count()) === 0) break;
			const transcriptSpace = page.locator(".transcript-space");
			const heightBefore = await transcriptSpace.evaluate((element) =>
				Number.parseFloat(element.style.height),
			);
			await button.click();
			await waitFor(
				() => transcriptSpace.evaluate((element) => Number.parseFloat(element.style.height)),
				(height) => height > heightBefore,
				"backward page render",
			);
			pagesLoaded += 1;
		}
		const historyPagingMs = performance.now() - pagingAt;
		const scroll = await page.evaluate(
			() =>
				new Promise((resolvePromise) => {
					const target = document.querySelector(".transcript-scroll");
					if (!(target instanceof HTMLElement)) throw new Error("Transcript scroller is missing");
					let frames = 0;
					let startedAt;
					const frame = (now) => {
						startedAt ??= now;
						frames += 1;
						const progress = Math.min(1, (now - startedAt) / 1_000);
						target.scrollTop = (target.scrollHeight - target.clientHeight) * progress;
						if (progress < 1) requestAnimationFrame(frame);
						else resolvePromise({ frames, elapsedMs: now - startedAt });
					};
					requestAnimationFrame(frame);
				}),
		);
		const historyDomCount = await page.locator("[data-transcript-item]").count();

		return {
			launchToUsableMs: usableAt - launchAt,
			appServerSpawnToReadyMs: usableAt - detected.at,
			zeroSessionRss,
			oneSessionRss,
			threeSessionRss,
			turnAckMs,
			providerAcceptedToServerDeltaMs: serverFirstDeltaMs,
			providerAcceptedToVisibleDeltaMs: firstVisibleDeltaMs,
			tenThousandDeltaMs,
			streamedDomCount,
			rendererReloadMs,
			crashDetectedMs,
			crashRecoveryMs,
			replacementAppServerPid: replacement.pid,
			historyOpenMs: historyOpen.elapsedMs,
			historyInitialItems: historyOpen.initialItems,
			historyBackwardPageMs: olderPage.elapsedMs,
			historyBackwardPageItems: olderPage.items,
			historyPagingMs,
			historyPagesLoaded: pagesLoaded,
			historyScrollFps: (scroll.frames * 1_000) / scroll.elapsedMs,
			historyDomCount,
			providerRequests: requestCount,
			providerRequestAtMs: receivedAt.map((time) => time - launchAt),
		};
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n${diagnostics.join("").slice(-8_000)}`);
	} finally {
		for (const gate of gates) gate.resolve();
		await browser?.close().catch(() => undefined);
		await stop(app);
		provider.closeAllConnections();
		await new Promise((resolvePromise) => provider.close(resolvePromise));
		rmSync(root, { recursive: true, force: true });
	}
}

function latestBaseline() {
	if (!existsSync(baselineDir)) return undefined;
	const file = readdirSync(baselineDir)
		.filter((name) => /^desktop-baseline-.*\.json$/u.test(name))
		.sort()
		.at(-1);
	if (!file) return undefined;
	const path = join(baselineDir, file);
	return { path, value: JSON.parse(readFileSync(path, "utf8")) };
}

const options = args(process.argv.slice(2));
if (options.help) {
	process.stdout.write("Usage: node scripts/profile-desktop.mjs [--runs N] [--output FILE] [--no-enforce]\n");
	process.exit(0);
}
const executable = packagedExecutable();
if (!existsSync(executable)) throw new Error(`Package the native desktop app first: ${executable}`);
const runs = [];
for (let run = 1; run <= options.runs; run += 1) {
	process.stdout.write(`Desktop profile run ${run}/${options.runs}\n`);
	runs.push(await oneRun(executable, run));
}
const baseline = latestBaseline();
const metric = (name) => runs.map((run) => run[name]);
const summary = {
	launchToUsableMedianMs: median(metric("launchToUsableMs")),
	appServerSpawnToReadyMedianMs: median(metric("appServerSpawnToReadyMs")),
	turnAckMedianMs: median(metric("turnAckMs")),
	providerAcceptedToServerDeltaP95Ms: percentile(metric("providerAcceptedToServerDeltaMs"), 0.95),
	providerAcceptedToVisibleDeltaP95Ms: percentile(metric("providerAcceptedToVisibleDeltaMs"), 0.95),
	tenThousandDeltaMedianMs: median(metric("tenThousandDeltaMs")),
	rendererReloadMedianMs: median(metric("rendererReloadMs")),
	crashRecoveryP95Ms: percentile(metric("crashRecoveryMs"), 0.95),
	oneSessionRssMedianBytes: median(runs.map((run) => run.oneSessionRss.medianBytes)),
	threeSessionRssMedianBytes: median(runs.map((run) => run.threeSessionRss.medianBytes)),
	historyOpenMedianMs: median(metric("historyOpenMs")),
	historyPagingMedianMs: median(metric("historyPagingMs")),
	historyScrollFpsMinimum: Math.min(...metric("historyScrollFps")),
	historyDomCountMaximum: Math.max(...metric("historyDomCount")),
};
const coldReadyBaseline = baseline?.value?.startup?.summary?.elapsedMs?.median;
const budgets = [
	{
		name: "app-server initialized",
		actual: summary.appServerSpawnToReadyMedianMs,
		limit: typeof coldReadyBaseline === "number" ? coldReadyBaseline * 1.15 : null,
		pass: typeof coldReadyBaseline !== "number" || summary.appServerSpawnToReadyMedianMs <= coldReadyBaseline * 1.15,
	},
	{
		name: "three idle sessions RSS ratio",
		actual: summary.threeSessionRssMedianBytes / summary.oneSessionRssMedianBytes,
		limit: 1.25,
		pass: summary.threeSessionRssMedianBytes <= summary.oneSessionRssMedianBytes * 1.25,
	},
	{
		name: "initial history items",
		actual: Math.max(...metric("historyInitialItems")),
		limit: 200,
		pass: Math.max(...metric("historyInitialItems")) <= 200,
	},
	{
		name: "history scroll FPS",
		actual: summary.historyScrollFpsMinimum,
		limit: 55,
		pass: summary.historyScrollFpsMinimum >= 55,
	},
	{
		name: "first delta server overhead p95 ms",
		actual: summary.providerAcceptedToServerDeltaP95Ms,
		limit: 100,
		pass: summary.providerAcceptedToServerDeltaP95Ms < 100,
	},
	{
		name: "normal crash recovery p95 ms",
		actual: summary.crashRecoveryP95Ms,
		limit: 3_000,
		pass: summary.crashRecoveryP95Ms < 3_000,
	},
	{
		name: "virtualized DOM nodes",
		actual: summary.historyDomCountMaximum,
		limit: 100,
		pass: summary.historyDomCountMaximum < 100,
	},
];
const report = {
	schemaVersion: 1,
	capturedAt: new Date().toISOString(),
	machine: {
		hostname: hostname(),
		platform: platform(),
		release: release(),
		arch: arch(),
		nativePackageArch: nativeArch(),
		node: process.version,
		cpuModel: cpus()[0]?.model,
		cpuCount: cpus().length,
		totalMemoryBytes: totalmem(),
	},
	configuration: { runs: options.runs, packaged: true, executable },
	baseline: baseline ? { path: baseline.path, coldReadyMedianMs: coldReadyBaseline } : null,
	runs,
	summary,
	budgets,
};
mkdirSync(baselineDir, { recursive: true });
const output = options.output ?? join(baselineDir, `desktop-${new Date().toISOString().replace(/[:.]/gu, "-")}.json`);
writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ output, summary, budgets }, null, 2)}\n`);
if (options.enforce && budgets.some((budget) => !budget.pass)) process.exitCode = 1;
