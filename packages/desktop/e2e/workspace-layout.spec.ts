import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
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
	readOpenAiChatRequest,
	reservePort,
	respondWithText,
	stopProcess,
	waitForServerReady,
	writeOfflineProviderConfig,
} from "./packaged-app-harness.ts";

interface SeedSession {
	readonly id: string;
	readonly mode: "chat" | "code";
	readonly name: string;
}

interface LaunchedWorkspace {
	readonly app: ChildProcess;
	readonly browser: Browser;
	readonly consoleErrors: string[];
	readonly diagnostics: string[];
	readonly fakeProvider: Server;
	readonly page: Page;
	readonly projectDir: string;
	readonly tempRoot: string;
}

async function launchWorkspace(options: {
	readonly projectFiles?: Readonly<Record<string, string>>;
	readonly sessions: readonly SeedSession[];
}): Promise<LaunchedWorkspace> {
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

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-layout-e2e-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "project");
	const userDataDir = path.join(tempRoot, "electron");
	await Promise.all([mkdir(agentDir), mkdir(homeDir), mkdir(projectDir), mkdir(userDataDir)]);
	for (const [name, contents] of Object.entries(options.projectFiles ?? {})) {
		await writeFile(path.join(projectDir, name), contents);
	}

	for (const seed of options.sessions) {
		const manager = sessions.SessionManager.create(
			projectDir,
			sessions.getDefaultSessionDir(projectDir, agentDir),
			{ id: seed.id, mode: seed.mode, permissionPreset: "full" },
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
		await readOpenAiChatRequest(request);
		respondWithText(response, "layout-reply");
	});
	const providerPort = await listen(fakeProvider);
	await writeOfflineProviderConfig(agentDir, providerPort, { providerId: "audit", modelId: "audit-model" });

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
	page.setDefaultTimeout(15_000);
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	await page.setViewportSize({ width: 1200, height: 800 });
	await waitForServerReady(page);
	return { app, browser, consoleErrors, diagnostics, fakeProvider, page, projectDir, tempRoot };
}

async function stopWorkspace(workspace: LaunchedWorkspace): Promise<void> {
	await workspace.browser.close().catch(() => undefined);
	await stopProcess(workspace.app);
	workspace.fakeProvider.closeAllConnections();
	await new Promise<void>((resolve) => workspace.fakeProvider.close(() => resolve()));
	await rm(workspace.tempRoot, { recursive: true, force: true }).catch(() => undefined);
}

async function rendererFailure(error: unknown, page: Page, diagnostics: readonly string[]): Promise<Error> {
	const bodyText = await page.locator("body").innerText().catch(() => "renderer unavailable");
	return new Error(
		`${error instanceof Error ? error.message : String(error)}\nrenderer body:\n${bodyText}\n${diagnostics.join("").slice(-8_000)}`,
	);
}

test("terminal keeps its content when its tab is split into a second pane", async () => {
	test.setTimeout(120_000);
	const sessionId = "81000000-0000-4000-8000-0000000000c3";
	const workspace = await launchWorkspace({
		sessions: [{ id: sessionId, mode: "chat", name: "Layout Alpha" }],
	});
	const { consoleErrors, diagnostics, page } = workspace;
	try {
		await page.locator('.session-button[aria-label="Layout Alpha"]').click();
		await page.locator(`[data-active-session-id="${sessionId}"]`).waitFor({ state: "visible" });

		await page.locator(".tool-add-trigger").first().click();
		await page.locator(".tool-add-menu").getByRole("menuitem", { name: "Terminal", exact: true }).click();
		await expect(page.getByRole("tab", { name: "Terminal", exact: true })).toBeVisible();

		const panel = page.locator('.terminal-panel[aria-hidden="false"]');
		await expect(panel).toBeVisible();
		const terminalId = (await panel.getAttribute("id"))!.slice("terminal-panel-".length);
		const panelHandle = await panel.elementHandle();
		await expect.poll(async () => page.evaluate(async (id) => {
			try {
				await (globalThis as unknown as { metis: { writeTerminal(input: { terminalId: string; data: string }): Promise<void> } }).metis
					.writeTerminal({ terminalId: id, data: "" });
				return true;
			} catch {
				return false;
			}
		}, terminalId)).toBe(true);
		await page.evaluate(async (id) => {
			await (globalThis as unknown as { metis: { writeTerminal(input: { terminalId: string; data: string }): Promise<void> } }).metis
				.writeTerminal({ terminalId: id, data: "echo p0a-marker\r" });
		}, terminalId);
		await expect(panel.locator(".xterm-rows")).toContainText("p0a-marker");

		await page.locator(".tool-tab", { has: page.getByRole("tab", { name: "Terminal", exact: true }) })
			.click({ button: "right" });
		await page.locator(".workspace-tab-menu").getByRole("menuitem", { name: "Split right", exact: true }).click();
		await expect(page.locator(".workspace-pane")).toHaveCount(2);

		expect(await panelHandle?.evaluate((element) => element.isConnected)).toBe(true);
		await expect(page.getByText("Terminal already exists", { exact: false })).toHaveCount(0);
		await expect(panel.locator(".xterm-rows")).toContainText("p0a-marker");

		if (process.env.METIS_AUDIT_DIR) {
			await mkdir(process.env.METIS_AUDIT_DIR, { recursive: true });
			await page.screenshot({ path: path.join(process.env.METIS_AUDIT_DIR, "split.png") });
		}
		expect(consoleErrors).toEqual([]);
	} catch (error) {
		throw await rendererFailure(error, page, diagnostics);
	} finally {
		await stopWorkspace(workspace);
	}
});

test("a file tab keeps workspace authorization after another session is opened", async () => {
	test.setTimeout(120_000);
	const alphaId = "81000000-0000-4000-8000-0000000000d1";
	const betaId = "81000000-0000-4000-8000-0000000000d2";
	const workspace = await launchWorkspace({
		projectFiles: { "README.md": "metis p0b readme\n" },
		sessions: [
			{ id: alphaId, mode: "code", name: "Files Alpha" },
			{ id: betaId, mode: "code", name: "Files Beta" },
		],
	});
	const { consoleErrors, diagnostics, page, projectDir } = workspace;
	try {
		await page.locator(".mode-switch").getByRole("button", { name: "Code", exact: true }).click();
		await page.locator('.session-button[aria-label="Files Alpha"]').click();
		await page.locator(`[data-active-session-id="${alphaId}"]`).waitFor({ state: "visible" });

		await page.locator(".tool-add-trigger").first().click();
		await page.locator(".tool-add-menu").getByRole("menuitem", { name: "Files", exact: true }).click();
		const readmeRow = page.locator('.file-tree-row-select[title="README.md"]');
		await readmeRow.click();
		await expect(page.getByRole("tab", { name: "README.md", exact: true })).toBeVisible();
		await readmeRow.dblclick();

		await page.locator('.session-button[aria-label="Files Beta"]').click();
		await page.locator(`[data-active-session-id="${betaId}"]`).waitFor({ state: "visible" });

		await page.getByRole("tab", { name: "README.md", exact: true }).click();
		const editor = page.locator(".file-panel.is-visible .cm-content");
		await editor.click();
		await page.keyboard.insertText("p0b-edit\n");
		await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");

		await expect.poll(async () => readFile(path.join(projectDir, "README.md"), "utf8")).toContain("p0b-edit");
		await expect(page.getByText("not authorized", { exact: false })).toHaveCount(0);
		expect(consoleErrors).toEqual([]);
	} catch (error) {
		throw await rendererFailure(error, page, diagnostics);
	} finally {
		await stopWorkspace(workspace);
	}
});
