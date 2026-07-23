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
	createAndRestoreChatSession,
	listen,
	packagedExecutable,
	reservePort,
	stopProcess,
	waitForServerReady,
} from "./packaged-app-harness.ts";

async function projectedTextLength(page: Page, sessionId: string): Promise<number> {
	return page.evaluate(async (id) => {
		const api = (globalThis as unknown as { arcMind: ArcMindDesktopApi }).arcMind;
		const items = await api.readItems({ sessionId: id, limit: 200 });
		return items.items
			.flatMap((item) => item.content)
			.filter((block) => block.type === "text")
			.map((block) => block.text)
			.join("").length;
	}, sessionId);
}

async function diagnosticWithin<T>(promise: Promise<T>, fallback: T, timeoutMs = 2_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<T>((resolve) => {
				timer = setTimeout(() => resolve(fallback), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
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
	const provider = createServer(async (request, response) => {
		for await (const _chunk of request) {
			// Drain the request before streaming.
		}
		providerRequests += 1;
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
	let sessionId = "";
	let phase = "connect to renderer";
	try {
		({ browser, page } = await connectToApp(port));
		phase = "wait for App Server";
		await waitForServerReady(page);
		phase = "restore Chat session";
		sessionId = await createAndRestoreChatSession(page, projectDir);

		phase = "inspect process tree";
		const rootPid = app.pid;
		if (!rootPid) throw new Error("Packaged app has no process id");
		const originalServerPid = appServerPid(rootPid);
		if (!originalServerPid) throw new Error("Packaged App Server is missing");

		phase = "submit prompt";
		await page.locator("#composer-input").fill("stream many deltas", { timeout: 10_000 });
		await page.getByRole("button", { name: "Send" }).click({ timeout: 10_000 });
		phase = "wait for provider request";
		await expect.poll(() => providerRequests, { timeout: 10_000 }).toBe(1);
		phase = "block renderer";
		const blockingStarted = page.waitForEvent("console", {
			predicate: (message) => message.text() === "slow-client-blocking",
			timeout: 10_000,
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

		phase = "catch up streamed deltas";
		await expect
			.poll(async () => (await page!.locator("[data-transcript-answer]").last().textContent())?.length ?? 0, {
				timeout: 20_000,
			})
			.toBe(10_000);
		phase = "verify recovered renderer";
		expect(await page.locator("[data-transcript-turn]").count()).toBeLessThan(50);
		expect(await page.locator(".transcript-scroll").evaluate((element) => {
			const scroll = element as unknown as { scrollHeight: number; scrollTop: number; clientHeight: number };
			return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
		})).toBeLessThanOrEqual(48);
		expect(appServerPid(rootPid)).toBe(originalServerPid);
		expect(providerRequests).toBe(1);
		await expect(page.locator("#composer-input")).toBeEnabled();
	} catch (error) {
		const body = page
			? await diagnosticWithin(page.locator("body").innerText().catch(() => "renderer unavailable"), "renderer diagnostic timed out")
			: "renderer unavailable";
		const projectionLength = page && sessionId
			? await diagnosticWithin(projectedTextLength(page, sessionId).catch(() => -2), -4)
			: -3;
		throw new Error(
			`phase=${phase}\n${error instanceof Error ? error.message : String(error)}\nserver projection length=${projectionLength}\nrenderer body:\n${body}\n${diagnostics.join("").slice(-8_000)}`,
		);
	} finally {
		releaseStream();
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await closeServer(provider);
		await rm(root, { recursive: true, force: true });
	}
});
