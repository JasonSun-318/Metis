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

const ALPHA_ID = "81000000-0000-4000-8000-0000000000a1";
const BETA_ID = "81000000-0000-4000-8000-0000000000b1";

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

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-stream-e2e-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "project");
	const userDataDir = path.join(tempRoot, "electron");
	await Promise.all([mkdir(agentDir), mkdir(homeDir), mkdir(projectDir), mkdir(userDataDir)]);

	for (const seed of [
		{ id: ALPHA_ID, name: "Stream A" },
		{ id: BETA_ID, name: "Stream B" },
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
		for (let index = 0; index < 300; index += 1) {
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
	page.setDefaultTimeout(20_000);
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	await page.setViewportSize({ width: 1200, height: 800 });
	await waitForServerReady(page);
	return { app, browser, consoleErrors, diagnostics, fakeProvider, page, tempRoot };
}

test("a session keeps streaming intact across background switches and reopen", async () => {
	test.setTimeout(120_000);
	const workspace = await launchWorkspace();
	const { consoleErrors, diagnostics, fakeProvider, page } = workspace;
	try {
		await page.locator('.session-button[aria-label="Stream B"]').click();
		await page.locator(`[data-active-session-id="${BETA_ID}"]`).waitFor({ state: "visible" });

		await page.locator("#composer-input").fill("go");
		await page.getByRole("button", { name: "Send message", exact: true }).click();
		await expect(page.locator(".transcript-scroll")).toContainText("w20 ", { timeout: 20_000 });

		await page.locator('.session-button[aria-label="Stream A"]').click();
		await page.locator(`[data-active-session-id="${ALPHA_ID}"]`).waitFor({ state: "visible" });
		await page.waitForTimeout(1_000);

		await page.locator('.session-button[aria-label="Stream B"]').click();
		await page.locator(`[data-active-session-id="${BETA_ID}"]`).waitFor({ state: "visible" });
		await expect(page.locator(".transcript-scroll")).toContainText("stream-end", { timeout: 30_000 });

		const transcriptText = (await page.locator(".transcript-scroll").innerText()).replace(/\s+/g, " ");
		const expected = `${Array.from({ length: 300 }, (_, index) => `w${index}`).join(" ")} stream-end`;
		expect(transcriptText).toContain(expected);

		if (process.env.METIS_AUDIT_DIR) {
			await mkdir(process.env.METIS_AUDIT_DIR, { recursive: true });
			await page.screenshot({ path: path.join(process.env.METIS_AUDIT_DIR, "stream.png") });
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
