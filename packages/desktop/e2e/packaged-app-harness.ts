import { type ChildProcess, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { chromium, expect, type Browser, type Page } from "@playwright/test";
import type { ArcMindDesktopApi } from "../src/shared/desktop-api.ts";

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
	const packageRoot = path.join(desktopRoot, "out", `ArcMind-${process.platform}-${nativePackageArch()}`);
	if (process.platform === "darwin") return path.join(packageRoot, "ArcMind.app", "Contents", "MacOS", "arcmind");
	if (process.platform === "win32") return path.join(packageRoot, "arcmind.exe");
	return path.join(packageRoot, "arcmind");
}

export function packagedAsar(): string {
	const packageRoot = path.join(desktopRoot, "out", `ArcMind-${process.platform}-${nativePackageArch()}`);
	return process.platform === "darwin"
		? path.join(packageRoot, "ArcMind.app", "Contents", "Resources", "app.asar")
		: path.join(packageRoot, "resources", "app.asar");
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

export async function connectToApp(port: number): Promise<{ browser: Browser; page: Page }> {
	await expect
		.poll(
			async () => {
				try {
					const response = await fetch(`http://127.0.0.1:${port}/json/list`);
					if (!response.ok) return false;
					const targets = (await response.json()) as Array<{ type?: string }>;
					return targets.some((target) => target.type === "page");
				} catch {
					return false;
				}
			},
			{ timeout: 15_000 },
		)
		.toBe(true);
	const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
	const context = browser.contexts()[0];
	if (!context) throw new Error("Packaged app did not expose a browser context");
	const page = context.pages()[0];
	if (!page) throw new Error("Packaged app did not expose a renderer page");
	return { browser, page };
}

export async function waitForServerReady(page: Page): Promise<void> {
	await expect
		.poll(() =>
			page.evaluate(async () => {
				const api = (globalThis as unknown as { arcMind: ArcMindDesktopApi }).arcMind;
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
		const api = (globalThis as unknown as { arcMind: ArcMindDesktopApi }).arcMind;
		const result = await api.createSession({ requestId: crypto.randomUUID(), mode: "chat", cwd: projectCwd });
		localStorage.setItem("arcmind.activeSessionId.chat", result.session.sessionId);
		return result.session;
	}, cwd);
	await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
	if (waitForActive) {
		await page.locator(`[data-active-session-id="${created.sessionId}"]`).waitFor({ state: "visible", timeout: 15_000 });
	}
	return created.sessionId;
}

export async function stopProcess(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.kill("SIGTERM");
	await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
	if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

export function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
