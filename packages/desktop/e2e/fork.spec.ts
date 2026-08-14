import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
	connectToApp,
	desktopRoot,
	listen,
	packagedExecutable,
	reservePort,
	stopProcess,
	waitForServerReady,
} from "./packaged-app-harness.ts";

test("forks a conversation from an assistant reply and switches to the forked session", async ({}, testInfo) => {
	test.setTimeout(180_000);
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const coreRoot = path.resolve(desktopRoot, "../coding-agent/dist/core");
	const importEsm = Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;
	const sessions = (await importEsm(pathToFileURL(path.join(coreRoot, "session-manager.js")).href)) as unknown as {
		SessionManager: {
			create(cwd: string, sessionDir: string, options: { id: string; mode: "chat"; permissionMode: "full" }): {
				appendSessionInfo(name: string): void;
				close(): void;
			};
		};
		getDefaultSessionDir(cwd: string, agentDir: string): string;
	};
	const trust = (await importEsm(pathToFileURL(path.join(coreRoot, "trust-manager.js")).href)) as unknown as {
		ProjectTrustStore: new (agentDir: string) => { set(cwd: string, trusted: boolean): void };
	};

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-fork-e2e-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "project");
	const userDataDir = path.join(tempRoot, "electron");
	await Promise.all([mkdir(agentDir), mkdir(homeDir), mkdir(projectDir), mkdir(userDataDir)]);
	const sourceId = "81000000-0000-4000-8000-000000000001";
	const sessionManager = sessions.SessionManager.create(
		projectDir,
		sessions.getDefaultSessionDir(projectDir, agentDir),
		{ id: sourceId, mode: "chat", permissionMode: "full" },
	);
	sessionManager.appendSessionInfo("Fork source title");
	sessionManager.close();
	new trust.ProjectTrustStore(agentDir).set(projectDir, true);

	const fakeProvider = createServer(async (request, response) => {
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		let body = "";
		for await (const chunk of request) body += chunk;
		const payload = JSON.parse(body) as { messages?: Array<{ role?: string; content?: unknown }> };
		const transcript = JSON.stringify(payload.messages ?? []);
		response.writeHead(200, { "content-type": "text/event-stream" });
		if (transcript.includes("conversation title generator")) {
			response.end(`data: ${JSON.stringify({
				id: "fork-title",
				object: "chat.completion.chunk",
				created: 1,
				model: "fork-model",
				choices: [{ index: 0, delta: { role: "assistant", content: "Fork source title" }, finish_reason: "stop" }],
			})}\n\ndata: [DONE]\n\n`);
			return;
		}
		response.end(`data: ${JSON.stringify({
			id: "fork-reply",
			object: "chat.completion.chunk",
			created: 1,
			model: "fork-model",
			choices: [{ index: 0, delta: { role: "assistant", content: "fork-reply-done" }, finish_reason: "stop" }],
		})}\n\ndata: [DONE]\n\n`);
	});
	const providerPort = await listen(fakeProvider);
	await Promise.all([
		writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
			fork: {
				baseUrl: `http://127.0.0.1:${providerPort}/v1`,
				apiKey: "fork-key",
				api: "openai-completions",
				models: [{ id: "fork-model", name: "Fork Model", contextWindow: 32_000, maxTokens: 1_024 }],
			},
		} })),
		writeFile(path.join(agentDir, "settings.json"), JSON.stringify({
			defaultProvider: "fork",
			defaultModel: "fork-model",
			retry: { enabled: false },
		})),
	]);

	const debuggingPort = await reservePort();
	const app = spawn(executable, [`--remote-debugging-port=${debuggingPort}`, `--user-data-dir=${userDataDir}`], {
		cwd: projectDir,
		env: {
			...process.env,
			ALL_PROXY: "",
			METIS_CODING_AGENT_DIR: agentDir,
			HOME: homeDir,
			USERPROFILE: homeDir,
			METIS_UPDATE_BASE_URL: "",
			ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
		},
		stdio: "ignore",
	});
	let browser: Browser | undefined;
	let page: Page | undefined;
	try {
		({ browser, page } = await connectToApp(debuggingPort));
		page.setDefaultTimeout(15_000);
		await page.setViewportSize({ width: 1200, height: 800 });
		await waitForServerReady(page);

		// Open the source chat session and wait for an assistant reply.
		await page.locator('.session-button[aria-label="Fork source title"]').click();
		await page.locator(`[data-active-session-id="${sourceId}"]`).waitFor({ state: "visible" });
		const input = page.locator("#composer-input");
		await input.fill("fork me");
		await page.getByRole("button", { name: "Send message", exact: true }).click();
		await expect(page.getByText("fork-reply-done", { exact: true })).toBeVisible({ timeout: 30_000 });

		// The fork button appears below the reply.
		const forkButton = page.getByRole("button", { name: "Fork conversation", exact: true });
		await expect(forkButton).toBeVisible();

		// Clicking it creates a new "fork <title>" session in the sidebar.
		await forkButton.click();
		const forkedSession = page.locator('.session-button[aria-label="fork Fork source title"]');
		await expect(forkedSession).toHaveCount(1, { timeout: 20_000 });

		// The view switches to the forked session.
		await expect(page.locator('[data-active-session-id]').first()).not.toHaveAttribute(
			"data-active-session-id",
			sourceId,
			{ timeout: 20_000 },
		);

		// Switch back to the original session.
		await page.locator('.session-button[aria-label="Fork source title"]').click();
		await page.locator(`[data-active-session-id="${sourceId}"]`).waitFor({ state: "visible" });

		await page.screenshot({ path: testInfo.outputPath("fork-result.png") });
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
	}
});
