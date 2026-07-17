import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
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

async function projectedTextLength(page: Page, cwd: string): Promise<number> {
	return page.evaluate(async (projectCwd) => {
		const api = (globalThis as unknown as { arcMind: ArcMindDesktopApi }).arcMind;
		const listed = await api.listSessions({ limit: 200 });
		const session = listed.sessions.find((candidate) => candidate.cwd === projectCwd);
		if (!session) return -1;
		const items = await api.readItems({ sessionId: session.sessionId, limit: 200 });
		return items.items
			.flatMap((item) => item.content)
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("").length;
	}, cwd);
}

test("a blocked renderer catches up with 10,000 deltas without losing its app server", async () => {
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const root = await mkdtemp(path.join(tmpdir(), "arcmind-slow-client-"));
	const agentDir = path.join(root, "agent");
	const projectDir = path.join(root, "project");
	const userDataDir = path.join(root, "electron");
	await Promise.all([mkdir(agentDir), mkdir(projectDir), mkdir(userDataDir)]);

	let releaseStream!: () => void;
	const streamGate = new Promise<void>((resolve) => {
		releaseStream = resolve;
	});
	let providerRequests = 0;
	let providerStarted!: () => void;
	const providerReady = new Promise<void>((resolve) => {
		providerStarted = resolve;
	});
	const provider = createServer(async (request, response) => {
		for await (const _chunk of request) {
			// Drain the request before streaming.
		}
		providerRequests += 1;
		providerStarted();
		await streamGate;
		const chunks = Array.from({ length: 10_000 }, (_, index) =>
			`data: ${JSON.stringify({
				id: "chatcmpl-slow-client",
				object: "chat.completion.chunk",
				created: 1,
				model: "slow-client-model",
				choices: [
					{
						index: 0,
						delta: { ...(index === 0 ? { role: "assistant" } : {}), content: "x" },
						finish_reason: null,
					},
				],
			})}\n\n`,
		).join("");
		response.writeHead(200, { "content-type": "text/event-stream" });
		response.end(
			`${chunks}data: ${JSON.stringify({
				id: "chatcmpl-slow-client",
				object: "chat.completion.chunk",
				created: 1,
				model: "slow-client-model",
				choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
			})}\n\ndata: [DONE]\n\n`,
		);
	});
	const providerPort = await listen(provider);
	await Promise.all([
		writeFile(
			path.join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					local: {
						baseUrl: `http://127.0.0.1:${providerPort}/v1`,
						apiKey: "test-key",
						api: "openai-completions",
						models: [
							{ id: "slow-client-model", name: "Slow client", contextWindow: 32_000, maxTokens: 16_000 },
						],
					},
				},
			}),
		),
		writeFile(
			path.join(agentDir, "settings.json"),
			JSON.stringify({ defaultProvider: "local", defaultModel: "slow-client-model", retry: { enabled: false } }),
		),
	]);

	const port = await reservePort();
	const diagnostics: string[] = [];
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
	app.stdout?.on("data", (chunk) => diagnostics.push(String(chunk)));
	app.stderr?.on("data", (chunk) => diagnostics.push(String(chunk)));

	let browser: Browser | undefined;
	let page: Page | undefined;
	try {
		({ browser, page } = await connectToApp(port));
		await expect(page.locator(".server-pill")).toHaveText("ready");
		await page.getByRole("button", { name: "New task" }).click();
		await page.locator("#project-path").fill(projectDir);
		await page.getByRole("button", { name: "Create" }).click();
		await expect(page.getByRole("heading", { level: 1 })).toHaveText(projectDir);

		const rootPid = app.pid;
		if (!rootPid) throw new Error("Packaged app has no process id");
		const originalServerPid = appServerPid(rootPid);
		if (!originalServerPid) throw new Error("Packaged App Server is missing");

		await page.locator("#composer-input").fill("stream many deltas");
		await page.getByRole("button", { name: "Send" }).click();
		await providerReady;
		const blockingStarted = new Promise<void>((resolve) => {
			page!.on("console", (message) => {
				if (message.text() === "slow-client-blocking") resolve();
			});
		});
		const blocked = page.evaluate(() => {
			console.log("slow-client-blocking");
			const until = performance.now() + 1_000;
			while (performance.now() < until) {
				// Deliberately block this renderer while the App Server continues.
			}
		});
		await blockingStarted;
		releaseStream();
		await blocked;

		await expect
			.poll(async () => (await page!.locator(".message-assistant p").last().textContent())?.length ?? 0, {
				timeout: 20_000,
			})
			.toBe(10_000);
		expect(await page.locator("[data-transcript-item]").count()).toBeLessThan(50);
		expect(appServerPid(rootPid)).toBe(originalServerPid);
		expect(providerRequests).toBe(1);
		await expect(page.locator("#composer-input")).toBeEnabled();
	} catch (error) {
		const body = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		const projectionLength = page ? await projectedTextLength(page, projectDir).catch(() => -2) : -3;
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nserver projection length=${projectionLength}\nrenderer body:\n${body}\n${diagnostics.join("").slice(-8_000)}`,
		);
	} finally {
		releaseStream();
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await closeServer(provider);
		await rm(root, { recursive: true, force: true });
	}
});
