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

test("two visible chat panes each run their own live session", async () => {
	test.setTimeout(120_000);
	const alphaId = "81000000-0000-4000-8000-0000000000f1";
	const betaId = "81000000-0000-4000-8000-0000000000f2";
	const workspace = await launchWorkspace({
		sessions: [
			{ id: alphaId, mode: "chat", name: "Live Alpha" },
			{ id: betaId, mode: "chat", name: "Live Beta" },
		],
	});
	const { consoleErrors, diagnostics, page } = workspace;
	try {
		await page.locator('.session-button[aria-label="Live Alpha"]').click();
		await page.locator(`[data-active-session-id="${alphaId}"]`).waitFor({ state: "visible" });
		await page.locator("#composer-input").fill("alpha ping");
		await page.getByRole("button", { name: "Send message", exact: true }).click();
		await expect(page.locator(".transcript-scroll")).toContainText("alpha ping", { timeout: 20_000 });
		await expect(page.locator(".transcript-scroll")).toContainText("layout-reply", { timeout: 20_000 });

		await page.locator('.session-button[aria-label="Live Beta"]').click();
		await page.locator(`[data-active-session-id="${betaId}"]`).waitFor({ state: "visible" });

		// Split Alpha's chat tab into a second pane; the gesture focuses that
		// pane, so Alpha becomes the projected session and Beta stays live in
		// the background pane.
		await page.locator(".tool-tab", { has: page.getByRole("tab", { name: "Live Alpha", exact: true }) })
			.click({ button: "right" });
		await page.locator(".workspace-tab-menu").getByRole("menuitem", { name: "Split right", exact: true }).click();
		await expect(page.locator(".workspace-pane")).toHaveCount(2);
		await page.locator(`[data-active-session-id="${alphaId}"]`).waitFor({ state: "visible" });

		const livePanels = page.locator(".workspace-panel:not([hidden])");
		await expect(livePanels).toHaveCount(2);
		await expect(livePanels.locator(".conversation-column")).toHaveCount(2);
		await expect(page.getByText("This session is not in focus.", { exact: true })).toHaveCount(0);

		const alphaPanel = livePanels.filter({ hasText: "alpha ping" });
		const betaPanel = livePanels.filter({ hasNotText: "alpha ping" });
		const alphaComposer = alphaPanel.locator("#composer-input");
		await expect(alphaComposer).toBeVisible();
		const alphaComposerHandle = await alphaComposer.elementHandle();

		// The background pane submits to its own session through its own
		// session-scoped composer id.
		const betaComposer = betaPanel.locator(`#composer-input-${betaId}`);
		await expect(betaComposer).toBeVisible();
		await betaComposer.fill("beta ping");
		await betaPanel.getByRole("button", { name: "Send message", exact: true }).click();
		await expect(betaPanel.locator(".transcript-scroll")).toContainText("beta ping", { timeout: 20_000 });
		await expect(betaPanel.locator(".transcript-scroll")).toContainText("layout-reply", { timeout: 20_000 });
		await expect(alphaPanel.locator(".transcript-scroll")).not.toContainText("beta ping");

		// Focusing the background pane's session activates its already-live
		// bucket without remounting or blanking the pane.
		await page.getByRole("tab", { name: "Live Beta", exact: true }).click();
		await page.locator(`[data-active-session-id="${betaId}"]`).waitFor({ state: "visible" });
		await expect(betaPanel.locator("#composer-input")).toBeVisible();
		await expect(betaPanel.locator(".transcript-scroll")).toContainText("beta ping");
		await expect(alphaPanel.locator(".transcript-scroll")).toContainText("alpha ping");
		expect(await alphaComposerHandle?.evaluate((element) => element.isConnected)).toBe(true);
		await expect(alphaPanel.locator(`#composer-input-${alphaId}`)).toBeVisible();

		if (process.env.METIS_AUDIT_DIR) {
			await mkdir(process.env.METIS_AUDIT_DIR, { recursive: true });
			await page.screenshot({ path: path.join(process.env.METIS_AUDIT_DIR, "two-live.png") });
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

test("splits panes into a two-row grid and blocks splits beyond the caps", async () => {
	test.setTimeout(120_000);
	const sessionId = "81000000-0000-4000-8000-0000000000e1";
	const workspace = await launchWorkspace({
		sessions: [{ id: sessionId, mode: "chat", name: "Grid Alpha" }],
	});
	const { consoleErrors, diagnostics, page } = workspace;
	try {
		await page.locator('.session-button[aria-label="Grid Alpha"]').click();
		await page.locator(`[data-active-session-id="${sessionId}"]`).waitFor({ state: "visible" });

		const addTool = async (name: string) => {
			// Top-row strips live in the titlebar, one cell per pane — always
			// target the first pane's trigger so added tabs land somewhere deterministic.
			await page.locator(".workspace-titlebar-cell").first().locator(".tool-add-trigger").click();
			await page.locator(".tool-add-menu").getByRole("menuitem", { name, exact: true }).click();
		};
		const openTabMenu = async (name: string) => {
			await page.locator(".tool-tab", { has: page.getByRole("tab", { name, exact: true }) }).first().click({ button: "right" });
		};
		const menuItem = (name: string) =>
			page.locator(".workspace-tab-menu").getByRole("menuitem", { name, exact: true });

		await addTool("Terminal");
		const terminalPanel = page.locator(".terminal-panel").first();
		await expect(terminalPanel).toBeVisible();
		const terminalHandle = await terminalPanel.elementHandle();
		await addTool("Knowledge");
		await addTool("Terminal");
		await addTool("Terminal");

		await openTabMenu("Terminal");
		await menuItem("Split right").click();
		await expect(page.locator(".workspace-pane")).toHaveCount(2);

		// At 1200x800 with the sidebar visible a third column is too narrow.
		await openTabMenu("Knowledge");
		await expect(menuItem("Split right")).toBeDisabled();
		await expect(menuItem("Split right")).toHaveAttribute("title", "Not enough room to split");
		await page.keyboard.press("Escape");

		await page.setViewportSize({ width: 1600, height: 900 });
		await page.waitForFunction(
			() => document.querySelector(".session-workspace-panes")!.getBoundingClientRect().width > 1200,
		);
		await openTabMenu("Knowledge");
		await menuItem("Split right").click();
		await expect(page.locator(".workspace-row").first().locator(".workspace-pane")).toHaveCount(3);

		for (const tab of ["Terminal 2", "Terminal 3"]) {
			await openTabMenu(tab);
			await menuItem("Split down").click();
		}
		await addTool("Terminal");
		await openTabMenu("Terminal 4");
		await menuItem("Split down").click();

		const rows = page.locator(".workspace-row");
		await expect(rows).toHaveCount(2);
		await expect(rows.nth(0).locator(".workspace-pane")).toHaveCount(3);
		await expect(rows.nth(1).locator(".workspace-pane")).toHaveCount(3);

		await openTabMenu("Grid Alpha");
		await expect(menuItem("Split right")).toBeDisabled();
		await expect(menuItem("Split right")).toHaveAttribute("title", "Up to 6 panes");
		await expect(menuItem("Split down")).toBeDisabled();
		await expect(menuItem("Split down")).toHaveAttribute("title", "Up to 6 panes");
		await page.keyboard.press("Escape");

		expect(await terminalHandle?.evaluate((element) => element.isConnected)).toBe(true);

		if (process.env.METIS_AUDIT_DIR) {
			await mkdir(process.env.METIS_AUDIT_DIR, { recursive: true });
			await page.screenshot({ path: path.join(process.env.METIS_AUDIT_DIR, "grid.png") });
		}
		expect(consoleErrors).toEqual([]);
	} catch (error) {
		throw await rendererFailure(error, page, diagnostics);
	} finally {
		await stopWorkspace(workspace);
	}
});
