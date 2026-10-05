import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
	connectToApp,
	desktopRoot,
	launchPackagedDesktop,
	listen,
	packagedExecutable,
	reservePort,
	stopProcess,
	waitForServerReady,
	writeOfflineProviderConfig,
} from "./packaged-app-harness.ts";

const ALPHA_ID = "81000000-0000-4000-8000-0000000000e1";
const BETA_ID = "81000000-0000-4000-8000-0000000000e2";
const DELTA_COUNT = 400;

function writeChunk(response: ServerResponse, delta: object, finishReason: string | null = null): void {
	response.write(`data: ${JSON.stringify({
		id: "stream-reply",
		object: "chat.completion.chunk",
		created: 1,
		model: "stream-model",
		choices: [{ index: 0, delta, finish_reason: finishReason }],
	})}\n\n`);
}

async function launchWorkspace(): Promise<{
	app: ChildProcess;
	browser: Browser;
	consoleErrors: string[];
	diagnostics: string[];
	fakeProvider: Server;
	page: Page;
	tempRoot: string;
}> {
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const coreRoot = path.resolve(desktopRoot, "../coding-agent/dist/core");
	const importEsm = Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;
	const sessions = (await importEsm(pathToFileURL(path.join(coreRoot, "session-manager.js")).href)) as unknown as {
		SessionManager: {
			create(cwd: string, sessionDir: string, options: { id: string; mode: "chat" | "code"; permissionPreset: "full" }): {
				appendSessionInfo(name: string): void;
				close(): void;
			};
		};
		getDefaultSessionDir(cwd: string, agentDir: string): string;
	};
	const trust = (await importEsm(pathToFileURL(path.join(coreRoot, "trust-manager.js")).href)) as unknown as {
		ProjectTrustStore: new (agentDir: string) => { set(cwd: string, trusted: boolean): void };
	};

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-perf-e2e-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "project");
	const userDataDir = path.join(tempRoot, "electron");
	await Promise.all([mkdir(agentDir), mkdir(homeDir), mkdir(projectDir), mkdir(userDataDir)]);

	for (const seed of [
		{ id: ALPHA_ID, name: "Perf Alpha" },
		{ id: BETA_ID, name: "Perf Beta" },
	]) {
		const manager = sessions.SessionManager.create(
			projectDir,
			sessions.getDefaultSessionDir(projectDir, agentDir),
			{ id: seed.id, mode: "chat", permissionPreset: "full" },
		);
		manager.appendSessionInfo(seed.name);
		manager.close();
	}
	new trust.ProjectTrustStore(agentDir).set(projectDir, true);

	const fakeProvider = createServer(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		let body = "";
		for await (const chunk of request) body += chunk;
		const payload = JSON.parse(body) as { messages?: unknown };
		const transcript = JSON.stringify(payload.messages ?? []);
		if (transcript.includes("conversation title generator")) {
			response.writeHead(200, { "content-type": "text/event-stream" });
			response.end(`data: ${JSON.stringify({
				id: "stream-title",
				object: "chat.completion.chunk",
				created: 1,
				model: "stream-model",
				choices: [{ index: 0, delta: { role: "assistant", content: "Stream title" }, finish_reason: "stop" }],
			})}\n\ndata: [DONE]\n\n`);
			return;
		}
		response.writeHead(200, { "content-type": "text/event-stream" });
		for (let index = 0; index < DELTA_COUNT; index += 1) {
			writeChunk(response, { role: "assistant", content: `w${index} ` });
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		writeChunk(response, { content: "stream-end" }, "stop");
		response.write("data: [DONE]\n\n");
		response.end();
	});
	const providerPort = await listen(fakeProvider);
	await writeOfflineProviderConfig(agentDir, providerPort, { providerId: "stream", modelId: "stream-model" });

	const debuggingPort = await reservePort();
	const diagnostics: string[] = [];
	const consoleErrors: string[] = [];
	const app = launchPackagedDesktop({
		executable,
		debuggingPort,
		userDataDir,
		projectDir,
		agentDir,
		homeDir,
		diagnostics,
		env: { METIS_UPDATE_BASE_URL: "", ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
	});
	const { browser, page } = await connectToApp(debuggingPort, app, diagnostics);
	// The CDP target appears before the app's initial navigation commits, so a
	// reload issued immediately can abort the in-flight load. Settle first.
	await page.waitForLoadState("domcontentloaded");
	page.setDefaultTimeout(20_000);
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	// The renderer is already loaded by the time CDP attaches, so the observer
	// is installed through addInitScript plus a reload: it must exist before
	// the app scripts run to catch every long task on this load.
	await page.addInitScript(() => {
		const recorded: { startTime: number; duration: number }[] = [];
		Object.defineProperty(globalThis, "__longtasks", { value: recorded });
		new PerformanceObserver((list) => {
			for (const entry of list.getEntries()) {
				recorded.push({ startTime: entry.startTime, duration: entry.duration });
			}
		}).observe({ entryTypes: ["longtask"] });
	});
	await page.reload({ waitUntil: "domcontentloaded" });
	await page.setViewportSize({ width: 1200, height: 800 });
	await waitForServerReady(page);
	return { app, browser, consoleErrors, diagnostics, fakeProvider, page, tempRoot };
}

// Observed on Apple Silicon (packaged app): 2 streaming-window long tasks,
// max 75 ms, versus 216 ms of baseline session-open noise — so 50 ms would be
// flaky. The 200 ms gate is headroom for slower Electron/CI hosts.
const LONG_TASK_GATE_MS = 200;

test("two visible sessions stream concurrently without long tasks", async () => {
	test.setTimeout(120_000);
	const workspace = await launchWorkspace();
	const { consoleErrors, diagnostics, fakeProvider, page } = workspace;
	try {
		await page.locator('.session-button[aria-label="Perf Alpha"]').click();
		await page.locator(`[data-active-session-id="${ALPHA_ID}"]`).waitFor({ state: "visible" });

		// Let startup and session-open work settle into the baseline window.
		await page.waitForTimeout(1_500);
		const streamingStart = await page.evaluate(() => performance.now());

		await page.locator("#composer-input").fill("go alpha");
		await page.getByRole("button", { name: "Send message", exact: true }).click();

		await page.locator('.session-button[aria-label="Perf Beta"]').click();
		await page.locator(`[data-active-session-id="${BETA_ID}"]`).waitFor({ state: "visible" });
		await page.locator("#composer-input").fill("go beta");
		await page.getByRole("button", { name: "Send message", exact: true }).click();

		// Split Alpha's chat tab while both streams are still running; the
		// gesture focuses that pane so Alpha becomes the projected session and
		// Beta keeps streaming in the background pane.
		await page.locator(".tool-tab", { has: page.getByRole("tab", { name: "Perf Alpha", exact: true }) })
			.click({ button: "right" });
		await page.locator(".workspace-tab-menu").getByRole("menuitem", { name: "Split right", exact: true }).click();
		await expect(page.locator(".workspace-pane")).toHaveCount(2);

		const livePanels = page.locator(".workspace-panel:not([hidden])");
		await expect(livePanels).toHaveCount(2);
		const alphaPanel = livePanels.filter({ hasText: "go alpha" });
		const betaPanel = livePanels.filter({ hasText: "go beta" });
		await expect(alphaPanel).toHaveCount(1);
		await expect(betaPanel).toHaveCount(1);

		// Both transcripts must grow to completion while visible together.
		await expect(alphaPanel.locator(".transcript-scroll")).toContainText(`w${DELTA_COUNT - 1}`, { timeout: 30_000 });
		await expect(alphaPanel.locator(".transcript-scroll")).toContainText("stream-end", { timeout: 30_000 });
		await expect(betaPanel.locator(".transcript-scroll")).toContainText(`w${DELTA_COUNT - 1}`, { timeout: 30_000 });
		await expect(betaPanel.locator(".transcript-scroll")).toContainText("stream-end", { timeout: 30_000 });

		const measurement = await page.evaluate((mark) => {
			const entries = (globalThis as unknown as { __longtasks: { startTime: number; duration: number }[] }).__longtasks;
			const baseline = entries.filter((entry) => entry.startTime < mark);
			const streaming = entries.filter((entry) => entry.startTime >= mark);
			return {
				baselineMax: Math.max(0, ...baseline.map((entry) => entry.duration)),
				streamingCount: streaming.length,
				streamingMax: Math.max(0, ...streaming.map((entry) => entry.duration)),
			};
		}, streamingStart);
		console.log(
			`[longtask] baseline max ${measurement.baselineMax.toFixed(1)}ms; ` +
				`streaming window: ${measurement.streamingCount} task(s), max ${measurement.streamingMax.toFixed(1)}ms`,
		);
		expect(
			measurement.streamingMax,
			`streaming-window long task exceeded ${LONG_TASK_GATE_MS}ms ` +
				`(baseline max ${measurement.baselineMax.toFixed(1)}ms, ` +
				`${measurement.streamingCount} task(s) in window)`,
		).toBeLessThan(LONG_TASK_GATE_MS);

		if (process.env.METIS_AUDIT_DIR) {
			await mkdir(process.env.METIS_AUDIT_DIR, { recursive: true });
			await page.screenshot({ path: path.join(process.env.METIS_AUDIT_DIR, "stream-perf.png") });
		}
		expect(consoleErrors).toEqual([]);
	} catch (error) {
		const bodyText = await page.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nrenderer body:\n${bodyText}\n${diagnostics.join("").slice(-8_000)}`,
		);
	} finally {
		fakeProvider.closeAllConnections();
		await new Promise<void>((resolve) => fakeProvider.close(() => resolve()));
		await workspace.browser.close().catch(() => undefined);
		await stopProcess(workspace.app);
		await rm(workspace.tempRoot, { recursive: true, force: true }).catch(() => undefined);
	}
});
