import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";

export const desktopRoot = path.resolve(__dirname, "..");

export function nativePackageArch(): string {
	const machine =
		process.platform === "darwin" &&
		spawnSync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], { encoding: "utf8" }).stdout.trim() === "1"
			? "arm64"
			: process.platform === "win32"
				? (process.env.PROCESSOR_ARCHITEW6432 ?? process.env.PROCESSOR_ARCHITECTURE ?? process.arch)
				: spawnSync("uname", ["-m"], { encoding: "utf8" }).stdout.trim();
	return /^(arm64|aarch64)$/i.test(machine)
		? "arm64"
		: /^(x64|x86_64|amd64)$/i.test(machine)
			? "x64"
			: process.arch;
}

export function packagedExecutable(): string {
	const packageRoot = path.join(desktopRoot, "out", `Metis-${process.platform}-${nativePackageArch()}`);
	if (process.platform === "darwin") return path.join(packageRoot, "Metis.app", "Contents", "MacOS", "Metis");
	if (process.platform === "win32") return path.join(packageRoot, "Metis.exe");
	return path.join(packageRoot, "Metis");
}

export function packagedAsar(): string {
	const packageRoot = path.join(desktopRoot, "out", `Metis-${process.platform}-${nativePackageArch()}`);
	return process.platform === "darwin"
		? path.join(packageRoot, "Metis.app", "Contents", "Resources", "app.asar")
		: path.join(packageRoot, "resources", "app.asar");
}

export interface PackagedDesktopLaunchOptions {
	readonly executable: string;
	readonly debuggingPort: number;
	readonly userDataDir: string;
	readonly projectDir: string;
	readonly agentDir: string;
	readonly homeDir: string;
	readonly diagnostics: string[];
	readonly extraArguments?: readonly string[];
	readonly env?: Record<string, string>;
}

export function launchPackagedDesktop(options: PackagedDesktopLaunchOptions): ChildProcess {
	const child = spawn(options.executable, [
		`--remote-debugging-port=${options.debuggingPort}`,
		`--user-data-dir=${options.userDataDir}`,
		// The packaged directory's chrome-sandbox helper is not setuid root and
		// Ubuntu runners restrict unprivileged user namespaces via AppArmor, so
		// Chromium cannot sandbox itself here. The probe covers Metis's own
		// permission sandbox, not Chromium's.
		...(process.platform === "linux" ? ["--no-sandbox"] : []),
		...(options.extraArguments ?? []),
	], {
		cwd: options.projectDir,
		env: {
			...process.env,
			ALL_PROXY: "",
			METIS_CODING_AGENT_DIR: options.agentDir,
			HOME: options.homeDir,
			HTTP_PROXY: "",
			HTTPS_PROXY: "",
			NO_PROXY: "127.0.0.1,localhost",
			USERPROFILE: options.homeDir,
			...(options.env ?? {}),
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout?.on("data", (chunk) => options.diagnostics.push(String(chunk)));
	child.stderr?.on("data", (chunk) => options.diagnostics.push(String(chunk)));
	return child;
}

export interface OpenAiChatMessage {
	readonly role?: string;
	readonly content?: unknown;
	readonly tool_call_id?: string;
}

export interface OpenAiChatRequest {
	readonly messages?: readonly OpenAiChatMessage[];
}

export async function readOpenAiChatRequest(request: IncomingMessage): Promise<OpenAiChatRequest> {
	let body = "";
	for await (const chunk of request) body += chunk;
	return JSON.parse(body) as OpenAiChatRequest;
}

function writeOpenAiChunk(response: ServerResponse, chunk: object): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
}

export function respondWithToolCall(
	response: ServerResponse,
	input: { readonly callId: string; readonly name: string; readonly arguments: object },
): void {
	writeOpenAiChunk(response, {
		id: input.callId,
		object: "chat.completion.chunk",
		created: 1,
		model: "browser-agent-fixture",
		choices: [{
			index: 0,
			delta: {
				role: "assistant",
				tool_calls: [{
					index: 0,
					id: input.callId,
					type: "function",
					function: { name: input.name, arguments: JSON.stringify(input.arguments) },
				}],
			},
			finish_reason: "tool_calls",
		}],
	});
}

export function respondWithText(response: ServerResponse, text: string): void {
	writeOpenAiChunk(response, {
		id: `fixture-${Date.now()}`,
		object: "chat.completion.chunk",
		created: 1,
		model: "browser-agent-fixture",
		choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: "stop" }],
	});
}

export function messageText(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) return value.map(messageText).join("\n");
	if (!value || typeof value !== "object") return "";
	const record = value as Record<string, unknown>;
	return typeof record.text === "string" ? record.text : messageText(record.content);
}

export function latestToolResult(messages: readonly OpenAiChatMessage[]): string {
	const message = [...messages].reverse().find((candidate) => candidate.role === "tool");
	return messageText(message?.content);
}

export async function writeOfflineProviderConfig(
	agentDir: string,
	port: number,
	options: { readonly providerId?: string; readonly modelId?: string } = {},
): Promise<void> {
	const providerId = options.providerId ?? "permission";
	const modelId = options.modelId ?? "permission-model";
	await Promise.all([
		writeFile(
			path.join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					[providerId]: {
						baseUrl: `http://127.0.0.1:${port}/v1`,
						apiKey: "permission-key",
						api: "openai-completions",
						models: [{ id: modelId, name: "Permission Model", contextWindow: 32_000, maxTokens: 1_024 }],
					},
				},
			}),
		),
		writeFile(
			path.join(agentDir, "settings.json"),
			JSON.stringify({
				defaultProvider: providerId,
				defaultModel: modelId,
				retry: { enabled: false },
			}),
		),
	]);
}

export async function listen(server: Server): Promise<number> {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected a TCP test server");
	return address.port;
}

export async function closeServer(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

export async function reservePort(): Promise<number> {
	const server = createServer();
	const port = await listen(server);
	await closeServer(server);
	return port;
}

interface ProcessInfo {
	readonly pid: number;
	readonly parentPid: number;
	readonly command: string;
}

function processTable(): ProcessInfo[] {
	if (process.platform === "win32") {
		const script =
			"Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress";
		const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" });
		if (result.status !== 0) throw new Error(result.stderr || "Could not inspect the process tree");
		const rows = JSON.parse(result.stdout) as
			| { ProcessId: number; ParentProcessId: number; CommandLine?: string }
			| Array<{ ProcessId: number; ParentProcessId: number; CommandLine?: string }>;
		return (Array.isArray(rows) ? rows : [rows]).map((row) => ({
			pid: row.ProcessId,
			parentPid: row.ParentProcessId,
			command: row.CommandLine ?? "",
		}));
	}

	const result = spawnSync("ps", ["-axo", "pid=,ppid=,command="], { encoding: "utf8" });
	if (result.status !== 0) throw new Error(result.stderr || "Could not inspect the process tree");
	return result.stdout
		.trim()
		.split("\n")
		.map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
		.filter((match): match is RegExpMatchArray => match !== null)
		.map((match) => ({ pid: Number(match[1]), parentPid: Number(match[2]), command: match[3] ?? "" }));
}

function descendantProcesses(rootPid: number): ProcessInfo[] {
	const table = processTable();
	const descendants: ProcessInfo[] = [];
	const parents = [rootPid];
	for (let index = 0; index < parents.length; index += 1) {
		for (const entry of table) {
			if (entry.parentPid !== parents[index]) continue;
			descendants.push(entry);
			parents.push(entry.pid);
		}
	}
	return descendants;
}

export function appServerPid(rootPid: number): number | undefined {
	return descendantProcesses(rootPid).find(
		(entry) => entry.command.includes("--type=utility") && entry.command.includes("node.mojom.NodeService"),
	)?.pid;
}

export async function connectToApp(
	port: number,
	app?: ChildProcess,
	diagnostics?: readonly string[],
): Promise<{ browser: Browser; page: Page }> {
	await expect
		.poll(
			async () => {
				if (app && (app.exitCode !== null || app.signalCode !== null)) {
					throw new Error(
						`Packaged app exited (code=${app.exitCode} signal=${app.signalCode}) before exposing CDP\n${(diagnostics ?? []).join("").slice(-8_000)}`,
					);
				}
				try {
					const response = await fetch(`http://127.0.0.1:${port}/json/list`);
					if (!response.ok) return false;
					const targets = (await response.json()) as Array<{ type?: string }>;
					return targets.some((target) => target.type === "page");
				} catch {
					return false;
				}
			},
			{ timeout: process.platform === "win32" ? 90_000 : 30_000 },
		)
		.toBe(true);
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	const context = browser.contexts()[0];
	if (!context) throw new Error("Packaged app did not expose a browser context");
	const page = context.pages()[0];
	if (!page) throw new Error("Packaged app did not expose a renderer page");
	// CDP pages do not inherit Playwright fixture timeouts; fail stale actions
	// promptly instead of spending the entire native test budget on one locator.
	page.setDefaultTimeout(process.env.CI ? 20_000 : 10_000);
	await page.bringToFront();
	return { browser, page };
}

export async function waitForServerReady(page: Page): Promise<void> {
	await expect
		.poll(() =>
			page.evaluate(async () => {
				const api = (globalThis as unknown as { metis: MetisDesktopApi }).metis;
				return (await api.getServerState()).state;
			}),
		)
		.toBe("ready");
}

export async function createAndRestoreChatSession(
	page: Page,
	cwd: string,
	waitForActive = true,
): Promise<string> {
	const created = await page.evaluate(async (projectCwd) => {
		const api = (globalThis as unknown as { metis: MetisDesktopApi }).metis;
		const result = await api.createSession({ requestId: crypto.randomUUID(), mode: "chat", cwd: projectCwd });
		localStorage.setItem("metis.activeSessionId.chat", result.session.sessionId);
		return result.session;
	}, cwd);
	await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
	if (waitForActive) {
		await page.locator(`[data-active-session-id="${created.sessionId}"]`).waitFor({ state: "visible", timeout: 15_000 });
	}
	return created.sessionId;
}

/** Quit normally before falling back to a forced stop so Chromium flushes profile state. */
export async function quitPackagedApp({ app, browser }: { app: ChildProcess; browser: Browser }): Promise<void> {
	if (app.exitCode === null && app.signalCode === null) {
		const session = await browser.newBrowserCDPSession().catch(() => undefined);
		if (session) {
			void session.send("Browser.close").catch(() => undefined);
			await Promise.race([once(app, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
		}
	}
	await browser.close().catch(() => undefined);
	await stopProcess(app);
}

export async function stopProcess(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	if (process.platform === "win32" && child.pid !== undefined) {
		spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
		await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
		return;
	}
	child.kill("SIGTERM");
	await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
	if (child.exitCode === null && child.signalCode === null) {
		child.kill("SIGKILL");
		// SIGKILL delivery is asynchronous; without this wait a relaunch on the
		// same user-data dir can race the dying process and lose profile state.
		await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
	}
}

export function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
