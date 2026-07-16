import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { ArcMindDesktopApi } from "../src/shared/desktop-api.ts";
import {
	appServerPid,
	closeServer,
	connectToApp,
	listen,
	packagedExecutable,
	reservePort,
	stopProcess,
} from "./packaged-app-harness.ts";

class ControlledCompletion {
	private response?: ServerResponse;
	private connected = false;
	private sentText = false;

	attach(response: ServerResponse): void {
		this.response = response;
		this.connected = true;
		response.writeHead(200, {
			"cache-control": "no-cache",
			connection: "keep-alive",
			"content-type": "text/event-stream",
		});
		response.flushHeaders();
	}

	get isStarted(): boolean {
		return this.connected;
	}

	write(text: string): void {
		this.send({
			id: "chatcmpl-gate-d",
			object: "chat.completion.chunk",
			created: 1,
			model: "gate-d-model",
			choices: [
				{
					index: 0,
					delta: { ...(this.sentText ? {} : { role: "assistant" }), content: text },
					finish_reason: null,
				},
			],
		});
		this.sentText = true;
	}

	finish(): void {
		this.send({
			id: "chatcmpl-gate-d",
			object: "chat.completion.chunk",
			created: 1,
			model: "gate-d-model",
			choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
		});
		this.response?.end("data: [DONE]\n\n");
	}

	private send(value: unknown): void {
		if (!this.response) throw new Error("Completion request has not started");
		this.response.write(`data: ${JSON.stringify(value)}\n\n`);
	}
}

async function serverProjectionText(page: Page, cwd: string): Promise<string> {
	return page.evaluate(async (projectCwd) => {
		const api = (globalThis as unknown as { arcMind: ArcMindDesktopApi }).arcMind;
		const listed = await api.listSessions({ limit: 200 });
		const session = listed.sessions.find((candidate) => candidate.cwd === projectCwd);
		if (!session) return "";
		const page = await api.readItems({ sessionId: session.sessionId, limit: 200 });
		return page.items
			.flatMap((item) => item.content)
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("");
	}, cwd);
}

test("packaged projection client recovers across renderer and app-server restarts", async () => {
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "arcmind-gate-d-"));
	const agentDir = path.join(tempRoot, "agent");
	const projectDir = path.join(tempRoot, "project");
	const userDataDir = path.join(tempRoot, "electron");
	await Promise.all([mkdir(agentDir), mkdir(projectDir), mkdir(userDataDir)]);

	const completions = [new ControlledCompletion(), new ControlledCompletion()];
	let requestCount = 0;
	const fakeProvider = createServer(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		for await (const _chunk of request) {
			// Drain the complete request before starting the SSE response, matching real HTTP servers.
		}
		const completion = completions[requestCount];
		requestCount += 1;
		if (!completion) {
			response.writeHead(500).end("Unexpected completion request");
			return;
		}
		completion.attach(response);
	});
	const providerPort = await listen(fakeProvider);
	await Promise.all([
		writeFile(
			path.join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					"gate-d": {
						baseUrl: `http://127.0.0.1:${providerPort}/v1`,
						apiKey: "gate-d-test-key",
						api: "openai-completions",
						models: [{ id: "gate-d-model", name: "Gate D Model", contextWindow: 32_000, maxTokens: 1_024 }],
					},
				},
			}),
		),
		writeFile(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "gate-d", defaultModel: "gate-d-model", retry: { enabled: false } }),
		),
	]);

	const debuggingPort = await reservePort();
	const diagnostics: string[] = [];
	const app = spawn(executable, [`--remote-debugging-port=${debuggingPort}`, `--user-data-dir=${userDataDir}`], {
		cwd: projectDir,
		env: {
			...process.env,
			ALL_PROXY: "",
			ARCMIND_CODING_AGENT_DIR: agentDir,
			HTTP_PROXY: "",
			HTTPS_PROXY: "",
			NO_PROXY: "127.0.0.1,localhost",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	let spawnError: Error | undefined;
	app.once("error", (error) => {
		spawnError = error;
	});
	app.stdout?.on("data", (chunk) => diagnostics.push(String(chunk)));
	app.stderr?.on("data", (chunk) => diagnostics.push(String(chunk)));

	let browser: Browser | undefined;
	let page: Page | undefined;
	let phase = "connecting to the packaged app";
	const rendererErrors: string[] = [];
	try {
		const connected = await connectToApp(debuggingPort);
		browser = connected.browser;
		page = connected.page;
		page.on("console", (message) => {
			if (message.type() === "error") rendererErrors.push(message.text());
		});
		page.on("pageerror", (error) => rendererErrors.push(error.message));

		phase = "creating a session";
		await expect(page.locator(".app-shell")).toBeVisible();
		await expect(page.locator(".server-pill")).toHaveText("ready");
		await page.locator("#project-path").fill(projectDir);
		await page.getByRole("button", { name: "New" }).click();
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(projectDir);
		await expect(page.locator("#composer-input")).toBeEnabled();

		const rootPid = app.pid;
		if (!rootPid) throw new Error("Packaged app has no process id");
		await expect.poll(() => appServerPid(rootPid)).not.toBeUndefined();
		const serverPidBeforeReload = appServerPid(rootPid)!;

		phase = "waiting for the first streamed delta";
		await page.locator("#composer-input").fill("renderer reload turn");
		await page.getByRole("button", { name: "Send" }).click();
		await expect.poll(() => completions[0]!.isStarted).toBe(true);
		completions[0]!.write("renderer-before-");
		phase = "waiting for the first app-server projection delta";
		await expect.poll(() => serverProjectionText(page!, projectDir)).toContain("renderer-before-");
		phase = "waiting for the first renderer delta";
		await expect(page.getByText("renderer-before-", { exact: true })).toBeVisible();

		phase = "reloading the renderer mid-turn";
		await page.reload({ waitUntil: "domcontentloaded" });
		await expect(page.locator(".app-shell")).toBeVisible();
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(projectDir);
		await expect(page.getByText("renderer-before-", { exact: true })).toBeVisible();
		expect(appServerPid(rootPid)).toBe(serverPidBeforeReload);

		phase = "completing the turn after renderer reload";
		completions[0]!.write("renderer-after");
		completions[0]!.finish();
		await expect(page.getByText("renderer-before-renderer-after", { exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "Send" })).toBeVisible();

		phase = "waiting for the second streamed delta";
		await page.locator("#composer-input").fill("app server crash turn");
		await page.getByRole("button", { name: "Send" }).click();
		await expect.poll(() => completions[1]!.isStarted).toBe(true);
		completions[1]!.write("server-before-crash");
		await expect(page.getByText("server-before-crash", { exact: true })).toBeVisible();

		phase = "restarting the app-server mid-turn";
		const crashedServerPid = appServerPid(rootPid);
		if (!crashedServerPid) throw new Error("Could not find the app-server utility process");
		process.kill(crashedServerPid, "SIGKILL");
		await expect.poll(() => appServerPid(rootPid), { timeout: 10_000 }).not.toBe(crashedServerPid);
		await expect(page.locator(".server-pill")).toHaveText("ready");
		await expect(page.locator(".recovery-banner")).toContainText("last turn was interrupted");
		await expect(page.locator("#composer-input")).toBeEnabled();

		expect(requestCount).toBe(2);
		expect(rendererErrors, rendererErrors.join("\n")).toEqual([]);
	} catch (error) {
		const processState = `app pid=${app.pid ?? "none"} exit=${app.exitCode ?? "running"} signal=${app.signalCode ?? "none"} spawnError=${spawnError?.message ?? "none"}`;
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase} requests=${requestCount}\n${processState}\nrenderer errors:\n${rendererErrors.join("\n") || "none"}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await closeServer(fakeProvider);
		await rm(tempRoot, { recursive: true, force: true });
	}
});
