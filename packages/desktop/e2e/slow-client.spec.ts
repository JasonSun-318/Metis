import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import {
	appServerPid,
	closeServer,
	connectToApp,
	createAndRestoreChatSession,
	desktopRoot,
	launchPackagedDesktop,
	listen,
	packagedExecutable,
	reservePort,
	stopProcess,
	waitForServerReady,
} from "./packaged-app-harness.ts";

async function projectedTextLength(page: Page, sessionId: string): Promise<number> {
	return page.evaluate(async (id) => {
		const api = (globalThis as unknown as { metis: MetisDesktopApi }).metis;
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

function respondTitle(response: ServerResponse): void {
	response.writeHead(200, { "content-type": "text/event-stream" });
	response.end(
		`data: ${JSON.stringify({
			id: "chatcmpl-slow-client-title",
			object: "chat.completion.chunk",
			created: 1,
			model: "slow-client-model",
			choices: [{ index: 0, delta: { role: "assistant", content: "Slow stream title" }, finish_reason: "stop" }],
		})}\n\ndata: [DONE]\n\n`,
	);
}

test("a blocked renderer catches up with 10,000 deltas without losing its app server", async () => {
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const root = await mkdtemp(path.join(tmpdir(), "metis-slow-client-"));
	const agentDir = path.join(root, "agent");
	const homeDir = path.join(root, "home");
	const projectDir = path.join(root, "project");
	const userDataDir = path.join(root, "electron");
	const qaDir = path.join(desktopRoot, "test-results", "design-qa", "sidebar");
	await Promise.all([
		mkdir(agentDir),
		mkdir(homeDir),
		mkdir(projectDir),
		mkdir(userDataDir),
		mkdir(qaDir, { recursive: true }),
	]);

	let releaseStream!: () => void;
	const streamGate = new Promise<void>((resolve) => {
		releaseStream = resolve;
	});
	let providerRequests = 0;
	const provider = createServer(async (request, response) => {
		let transcript = "";
		for await (const chunk of request) {
			// Drain the request before streaming.
			transcript += String(chunk);
		}
		if (transcript.includes("conversation title generator")) {
			respondTitle(response);
			return;
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
	// launchPackagedDesktop centralizes the packaged-app spawn contract, including
	// the justified Linux --no-sandbox flag for CI runners.
	const app = launchPackagedDesktop({
		agentDir,
		debuggingPort: port,
		diagnostics,
		executable,
		homeDir,
		projectDir,
		userDataDir,
	});

	let browser: Browser | undefined;
	let page: Page | undefined;
	let sessionId = "";
	let backgroundSessionId = "";
	let phase = "connect to renderer";
	const consoleErrors: string[] = [];
	try {
		({ browser, page } = await connectToApp(port));
		page.on("console", (message) => {
			if (message.type() === "error") consoleErrors.push(message.text());
		});
		await page.setViewportSize({ width: 1440, height: 900 });
		phase = "wait for App Server";
		await waitForServerReady(page);
		phase = "restore Chat session";
		sessionId = await createAndRestoreChatSession(page, projectDir);
		backgroundSessionId = await page.evaluate(async ({ activeSessionId, cwd }) => {
			const api = (globalThis as unknown as { metis: MetisDesktopApi }).metis;
			await api.renameSession({
				sessionId: activeSessionId,
				requestId: crypto.randomUUID(),
				name: "Streaming fixture",
			});
			const created = await api.createSession({
				requestId: crypto.randomUUID(),
				mode: "chat",
				cwd,
				name: "Background fixture",
			});
			return created.session.sessionId;
		}, { activeSessionId: sessionId, cwd: projectDir });
		await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
		await page.locator(`[data-active-session-id="${sessionId}"]`).waitFor({ state: "visible", timeout: 15_000 });
		const sidebar = page.locator(".session-sidebar");
		await expect(sidebar.getByRole("button", { name: "Streaming fixture", exact: true })).toBeVisible();
		await expect(sidebar.getByRole("button", { name: "Background fixture", exact: true })).toBeVisible();

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
		phase = "verify running session indicator";
		const runningSession = page.locator('.session-button[aria-busy="true"]');
		await expect(runningSession).toHaveCount(1);
		await expect(runningSession.locator(".session-button-title i.running")).toBeVisible();
		await expect(runningSession.locator("small")).toHaveCount(0);
		await page.screenshot({ path: path.join(qaDir, "running-session.png"), animations: "disabled" });
		phase = "switch away from running session";
		await sidebar.getByRole("button", { name: "Background fixture", exact: true }).click();
		await page.locator(`[data-active-session-id="${backgroundSessionId}"]`).waitFor({ state: "visible", timeout: 15_000 });
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

		phase = "verify completed background session indicator";
		const completedSession = sidebar.getByRole("button", { name: "Streaming fixture", exact: true });
		await expect(completedSession.locator(".session-button-title i.completed")).toBeVisible({ timeout: 20_000 });
		await expect(completedSession).not.toHaveAttribute("aria-busy", "true");
		await completedSession.click();
		await page.locator(`[data-active-session-id="${sessionId}"]`).waitFor({ state: "visible", timeout: 15_000 });
		await expect(completedSession.locator(".session-button-title i.completed")).toHaveCount(0);

		phase = "catch up streamed deltas";
		await expect
			.poll(async () => (await page!.locator("[data-transcript-answer]").last().textContent())?.length ?? 0, {
				timeout: 20_000,
			})
			.toBe(10_000);
		phase = "verify recovered renderer";
		expect(await page.locator("[data-transcript-turn]").count()).toBeLessThan(50);
		// Both the active and the keep-mounted background chat panels exist at this
		// point; only the recovered streaming session's transcript has answers.
		const transcriptScroll = page
			.locator(".transcript-scroll")
			.filter({ has: page.locator("[data-transcript-answer]") });
		expect(await transcriptScroll.evaluate((element) => {
			const scroll = element as unknown as { scrollHeight: number; scrollTop: number; clientHeight: number };
			return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
		})).toBeLessThanOrEqual(48);
		expect(appServerPid(rootPid)).toBe(originalServerPid);
		expect(providerRequests).toBe(1);
		await expect(page.locator("#composer-input")).toBeEnabled();
		expect(consoleErrors).toEqual([]);
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
