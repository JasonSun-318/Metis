import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
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
	readonly cwdOrigin?: "managed" | "user-selected";
	/** A sibling project folder for the session, instead of the shared project. */
	readonly project?: string;
}

interface LaunchedWorkspace {
	readonly app: ChildProcess;
	readonly browser: Browser;
	readonly consoleErrors: string[];
	readonly diagnostics: string[];
	readonly fakeProvider: Server;
	readonly page: Page;
	readonly projectDir: string;
	readonly modelRequests: Awaited<ReturnType<typeof readOpenAiChatRequest>>[];
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
			create(cwd: string, sessionDir: string, options: { id: string; mode: "chat" | "code"; permissionPreset: "full"; cwdOrigin?: "managed" | "user-selected" }): {
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

	const trustStore = new trust.ProjectTrustStore(agentDir);
	for (const seed of options.sessions) {
		const cwd = seed.project === undefined ? projectDir : path.join(tempRoot, seed.project);
		await mkdir(cwd, { recursive: true });
		const manager = sessions.SessionManager.create(
			cwd,
			sessions.getDefaultSessionDir(cwd, agentDir),
			{ id: seed.id, mode: seed.mode, permissionPreset: "full", ...(seed.cwdOrigin ? { cwdOrigin: seed.cwdOrigin } : {}) },
		);
		manager.appendSessionInfo(seed.name);
		manager.close();
		trustStore.set(cwd, true);
	}
	trustStore.set(projectDir, true);

	const modelRequests: Awaited<ReturnType<typeof readOpenAiChatRequest>>[] = [];
	const fakeProvider = createServer(async (request, response) => {
		if (request.method === "GET" && request.url === "/browser-page") {
			response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Sidebar page</title><h1>Browser sidebar page</h1>");
			return;
		}
		if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
			response.writeHead(404).end();
			return;
		}
		modelRequests.push(await readOpenAiChatRequest(request));
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
		extraArguments: process.platform === "darwin" ? ["--use-mock-keychain"] : [],
		env: { METIS_UPDATE_BASE_URL: "", ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
	});
	const { browser, page } = await connectToApp(debuggingPort, app, diagnostics);
	page.setDefaultTimeout(15_000);
	page.on("console", (message) => {
		if (message.type() === "error") consoleErrors.push(message.text());
	});
	await page.setViewportSize({ width: 1200, height: 800 });
	await waitForServerReady(page);
	return { app, browser, consoleErrors, diagnostics, fakeProvider, page, projectDir, modelRequests, tempRoot };
}

async function stopWorkspace(workspace: LaunchedWorkspace): Promise<void> {
	await workspace.browser.close().catch(() => undefined);
	await stopProcess(workspace.app);
	workspace.fakeProvider.closeAllConnections();
	await new Promise<void>((resolve) => workspace.fakeProvider.close(() => resolve()));
	await rm(workspace.tempRoot, { recursive: true, force: true }).catch(() => undefined);
}

/** Opens a tool from the focused session's browser start page. */
async function addTool(page: Page, name: string): Promise<void> {
	if (!await page.locator(".tool-sidebar").isVisible()) {
		await page.locator(".details-sidebar-toggle").click();
	}
	const cards = page.locator(".tool-sidebar-panel:not([hidden]) .tool-sidebar-menu");
	if (!await cards.count()) {
		const startTab = page.locator('.tool-sidebar-tabbar [role="tab"][aria-label="New tab"]').first();
		if (await startTab.count()) await startTab.click();
		else await page.getByRole("button", { name: "New browser tab", exact: true }).click();
	}
	await expect(cards).toBeVisible();
	if (name === "Browser") return;
	await cards.getByRole("button", { name, exact: true }).click();
}

async function rendererFailure(error: unknown, page: Page, diagnostics: readonly string[]): Promise<Error> {
	const bodyText = await page.locator("body").innerText().catch(() => "renderer unavailable");
	return new Error(
		`${error instanceof Error ? error.message : String(error)}\nrenderer body:\n${bodyText}\n${diagnostics.join("").slice(-8_000)}`,
	);
}

async function expectTitlebarControlsAligned(page: Page, fullscreen = false): Promise<void> {
	// Static geometry is measured after the deliberately translated entry/exit chrome settles.
	await page.waitForFunction(() => !document.querySelector('.tool-tabs-scroll[data-tab-motion-animating="true"]'));
	const platform = await page.locator("html").getAttribute("data-platform");
	if (platform === "win32") return;
	const expectedCenter = platform === "darwin" && !fullscreen ? 23 : 19.5;
	const controls = await page.locator(".workspace-titlebar").evaluate((titlebar) => {
		const selectors = [
			".sessions-sidebar-toggle-fixed", ".details-sidebar-toggle", ".tool-tab", ".tool-tab-group-label",
			".session-add-trigger", ".tool-add-trigger", ".tool-tab-select > svg", ".tool-tab-close",
		];
		return Array.from(titlebar.querySelectorAll<HTMLElement>(selectors.join(",")))
			.filter((element) => element.getClientRects().length > 0)
			.map((element) => {
				const rect = element.getBoundingClientRect();
				return { control: element.getAttribute("aria-label") ?? element.getAttribute("class"), center: rect.y + rect.height / 2 };
			});
	});
	expect(controls.length).toBeGreaterThanOrEqual(5);
	for (const { control, center } of controls) {
		expect(Math.abs(center - expectedCenter), `${control}: center ${center}, expected ${expectedCenter}`).toBeLessThanOrEqual(0.5);
	}
	const expectedHeight = platform === "darwin" && !fullscreen ? 46 : 40;
	await expect(page.locator(".workspace-titlebar")).toHaveCSS("height", `${expectedHeight}px`);
	const clearances = await page.locator(".workspace-titlebar").evaluate((titlebar) => {
		const outer = titlebar.getBoundingClientRect();
		return Array.from(titlebar.querySelectorAll<HTMLElement>(".tool-tab"))
			.filter((tab) => tab.getClientRects().length > 0)
			.map((tab) => {
				const rect = tab.getBoundingClientRect();
				return { top: rect.top - outer.top, bottom: outer.bottom - rect.bottom, height: rect.height };
			});
	});
	for (const clearance of clearances) {
		expect(clearance.height).toBe(28);
		expect(Math.abs(clearance.top - clearance.bottom)).toBeLessThanOrEqual(1);
	}
}

async function expectPaneHeadersAligned(page: Page): Promise<void> {
	await expect.poll(() => page.evaluate(() => {
		const cells = Array.from(document.querySelectorAll<HTMLElement>(".workspace-titlebar-cell"));
		const panes = Array.from(document.querySelectorAll<HTMLElement>(".workspace-row"))[0]
			?.querySelectorAll<HTMLElement>(".workspace-pane");
		if (!panes || panes.length !== cells.length) return Infinity;
		return Math.max(0, ...cells.map((cell, index) => {
			const header = cell.getBoundingClientRect();
			const body = panes[index]!.getBoundingClientRect();
			return Math.max(Math.abs(header.x - body.x), Math.abs(header.width - body.width));
		}));
	})).toBeLessThanOrEqual(1);
}

async function dragPaneDivider(page: Page, axis: "column" | "row", delta: number): Promise<void> {
	const divider = page.locator(`.session-workspace-panes .workspace-pane-resizer--${axis}[role="separator"]`).first();
	const box = await divider.boundingBox();
	if (!box) throw new Error(`Missing ${axis} divider bounds`);
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + (axis === "column" ? delta : 0), y + (axis === "row" ? delta : 0), { steps: 8 });
	await page.mouse.up();
}

test("tab menus follow pointer and keyboard anchors without hiding the conversation draft", async ({}, testInfo) => {
	test.setTimeout(90_000);
	const sessionId = "81000000-0000-4000-8000-000000000071";
	const workspace = await launchWorkspace({ sessions: [{ id: sessionId, mode: "chat", name: "Menu Alpha" }] });
	const { page } = workspace;
	try {
		await page.setViewportSize({ width: 1600, height: 1000 });
		await page.getByRole("button", { name: "Menu Alpha", exact: true }).click();
		await expect(page.locator("[data-active-session-id]")).toHaveAttribute("data-active-session-id", sessionId);
		await expect(page.getByText("Session ready", { exact: true })).toBeVisible();
		const tab = page.getByRole("tab", { name: "Menu Alpha", exact: true });
		const editor = page.locator("#composer-input");
		await editor.fill("Unsent text survives the tab menu");
		await expect(editor).toHaveText("Unsent text survives the tab menu");
		const editorHandle = await editor.elementHandle();
		const box = await tab.boundingBox();
		if (!box) throw new Error("Missing tab bounds");
		const point = { x: box.x + 24, y: box.y + box.height / 2 };
		await page.mouse.click(point.x, point.y, { button: "right" });
		const menu = page.locator(".workspace-tab-menu");
		await expect(menu).toBeVisible();
		await expect(menu).toHaveCSS("position", "fixed");
		expect(await menu.evaluate((element) => element.parentElement === document.body)).toBe(true);
		const pointerMenuBox = await menu.boundingBox();
		if (!pointerMenuBox) throw new Error("Missing pointer menu bounds");
		expect(Math.abs(pointerMenuBox.x - point.x)).toBeLessThanOrEqual(1);
		expect(Math.abs(pointerMenuBox.y - point.y)).toBeLessThanOrEqual(1);
		await expect(menu.locator("button:not(:disabled)").first()).toBeFocused();
		await expect(editor).toBeVisible();
		await expect(editor).toHaveText("Unsent text survives the tab menu");
		expect(await editorHandle?.evaluate((element) => element.isConnected)).toBe(true);
		await page.screenshot({ path: testInfo.outputPath("tab-menu-pointer-draft-preserved.png"), animations: "disabled" });
		await page.keyboard.press("Escape");
		await expect(menu).toHaveCount(0);
		await expect(tab).toBeFocused();

		await tab.focus();
		await tab.press("Shift+F10");
		await expect(menu).toBeVisible();
		const keyboardTabBox = await tab.boundingBox();
		const keyboardMenuBox = await menu.boundingBox();
		if (!keyboardTabBox || !keyboardMenuBox) throw new Error("Missing keyboard menu anchor bounds");
		expect(Math.abs(keyboardMenuBox.x - keyboardTabBox.x)).toBeLessThanOrEqual(1);
		expect(Math.abs(keyboardMenuBox.y - keyboardTabBox.y - keyboardTabBox.height - 4)).toBeLessThanOrEqual(1);
		await page.keyboard.press("End");
		await expect(menu.locator('button:not(:disabled)').last()).toBeFocused();
		await page.keyboard.press("Home");
		await expect(menu.locator('button:not(:disabled)').first()).toBeFocused();
		await page.setViewportSize({ width: 900, height: 90 });
		await expect.poll(async () => {
			const bounds = await menu.boundingBox();
			return bounds ? Math.min(bounds.x, bounds.y, 900 - bounds.x - bounds.width, 90 - bounds.y - bounds.height) : -1;
		}).toBeGreaterThanOrEqual(8);
		expect(await menu.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
		await page.screenshot({ path: testInfo.outputPath("tab-menu-constrained-viewport.png"), animations: "disabled" });
		await page.keyboard.press("Escape");
		await expect(menu).toHaveCount(0);
		await expect(tab).toBeFocused();
		await page.setViewportSize({ width: 1600, height: 1000 });
		await expect(editor).toHaveText("Unsent text survives the tab menu");

		await tab.press("Shift+F10");
		await expect(menu).toBeVisible();
		await editor.click();
		await expect(menu).toHaveCount(0);
		await expect(editor).toBeFocused();
		expect(workspace.modelRequests).toHaveLength(0);
		expect(workspace.consoleErrors).toEqual([]);
	} catch (cause) {
		throw await rendererFailure(cause, page, workspace.diagnostics);
	} finally {
		await stopWorkspace(workspace);
	}
});

test("split placeholders, pane dividers and preferred ratios survive a renderer restart", async ({}, testInfo) => {
	test.setTimeout(120_000);
	const alpha = "81000000-0000-4000-8000-000000000081";
	const beta = "81000000-0000-4000-8000-000000000082";
	const gamma = "81000000-0000-4000-8000-000000000083";
	const workspace = await launchWorkspace({ sessions: [
		{ id: alpha, mode: "chat", name: "Resize Alpha" },
		{ id: beta, mode: "chat", name: "Resize Beta" },
		{ id: gamma, mode: "chat", name: "Resize Gamma" },
	] });
	const { page } = workspace;
	const sessionIds = () => page.evaluate(async () => (await (globalThis as unknown as {
		metis: MetisDesktopApi;
	}).metis.listSessions({ includeArchived: true, limit: 200 })).sessions.map((session) => session.sessionId).sort());
	const split = async (name: string, direction: "right" | "down") => {
		await page.getByRole("tab", { name, exact: true }).click({ button: "right" });
		await page.locator(".workspace-tab-menu").getByRole("menuitem", { name: `Split ${direction}`, exact: true }).click();
	};
	const firstColumnWidth = async () => (await page.locator(".workspace-row").first().locator(".workspace-pane").first().boundingBox())!.width;
	const firstRowHeight = async () => (await page.locator(".workspace-row").first().boundingBox())!.height;
	const savedLayout = () => page.evaluate(() => localStorage.getItem("metis.workspace-layout.v1"));
	try {
		await page.setViewportSize({ width: 1800, height: 1100 });
		await page.getByRole("button", { name: "Resize Alpha", exact: true }).click();
		await expect(page.locator('.workspace-tabbar[data-pane-id] [role="tab"]')).toHaveCount(1);
		const originalIds = await sessionIds();
		await split("Resize Alpha", "right");
		await expect(page.locator(".workspace-pane")).toHaveCount(2);
		const source = page.locator(".workspace-pane").first();
		await expect(source.locator(".workspace-empty")).toBeVisible();
		await expect(source.getByRole("button", { name: "Start a new task", exact: true })).toBeVisible();
		await expect(page.getByRole("tab", { name: "Resize Alpha", exact: true })).toHaveCount(1);
		expect(await sessionIds()).toEqual(originalIds);
		expect(workspace.modelRequests).toHaveLength(0);
		await expectPaneHeadersAligned(page);
		await page.screenshot({ path: testInfo.outputPath("sole-tab-split-placeholder.png"), animations: "disabled" });

		// Select a real session into the explicit source placeholder using the existing sidebar route.
		await source.locator(".workspace-empty p").click();
		await page.getByRole("button", { name: "Resize Beta", exact: true }).click();
		await expect(source.locator(".workspace-empty")).toHaveCount(0);
		await expect(page.locator(".workspace-pane")).toHaveCount(2);
		await expect(page.getByRole("tab", { name: "Resize Beta", exact: true })).toBeVisible();
		const equalWidth = await firstColumnWidth();
		await dragPaneDivider(page, "column", 80);
		await expect.poll(firstColumnWidth).toBeGreaterThan(equalWidth + 75);
		const columnDivider = page.locator('.session-workspace-panes .workspace-pane-resizer--column[role="separator"]').first();
		await columnDivider.press("ArrowLeft");
		await expect.poll(firstColumnWidth).toBeLessThan(equalWidth + 70);
		await columnDivider.dblclick();
		await expect.poll(async () => Math.abs(await firstColumnWidth() - equalWidth)).toBeLessThanOrEqual(1);
		for (let index = 0; index < 3; index++) await columnDivider.press("ArrowRight");
		await expect.poll(firstColumnWidth).toBeGreaterThan(equalWidth + 45);
		await expectPaneHeadersAligned(page);

		await page.getByRole("tab", { name: "Resize Alpha", exact: true }).click();
		await page.getByRole("button", { name: "Resize Gamma", exact: true }).click();
		await split("Resize Gamma", "down");
		await expect(page.locator(".workspace-row")).toHaveCount(2);
		await expect(page.locator(".workspace-pane")).toHaveCount(3);
		const equalHeight = await firstRowHeight();
		const rowDivider = page.locator('.session-workspace-panes .workspace-pane-resizer--row[role="separator"]').first();
		await rowDivider.press("ArrowDown");
		await expect.poll(firstRowHeight).toBeGreaterThan(equalHeight + 13);
		await dragPaneDivider(page, "row", 30);
		await expect.poll(firstRowHeight).toBeGreaterThan(equalHeight + 43);
		await rowDivider.dblclick();
		await expect.poll(async () => Math.abs(await firstRowHeight() - equalHeight)).toBeLessThanOrEqual(1);
		await rowDivider.press("ArrowDown");
		await expectPaneHeadersAligned(page);
		const preferredWidth = await firstColumnWidth();
		const preferredHeight = await firstRowHeight();
		await expect.poll(savedLayout).not.toBeNull();
		const saved = await savedLayout();
		await page.screenshot({ path: testInfo.outputPath("uneven-columns-and-rows.png"), animations: "disabled" });

		// A constrained viewport projects minimums without replacing the user's preferred proportions.
		await page.setViewportSize({ width: 1000, height: 700 });
		expect(await savedLayout()).toBe(saved);
		await page.reload();
		await waitForServerReady(page);
		await expect(page.locator(".workspace-pane")).toHaveCount(3);
		for (const name of ["Resize Alpha", "Resize Beta", "Resize Gamma"]) {
			await expect(page.getByRole("tab", { name, exact: true })).toHaveCount(1);
		}
		await expectPaneHeadersAligned(page);
		await page.setViewportSize({ width: 1800, height: 1100 });
		await expect.poll(async () => Math.abs(await firstColumnWidth() - preferredWidth)).toBeLessThanOrEqual(1);
		await expect.poll(async () => Math.abs(await firstRowHeight() - preferredHeight)).toBeLessThanOrEqual(1);
		await expectPaneHeadersAligned(page);
		expect(await sessionIds()).toEqual(originalIds);
		expect(workspace.modelRequests).toHaveLength(0);
		await page.screenshot({ path: testInfo.outputPath("pane-ratios-restored.png"), animations: "disabled" });
		expect(workspace.consoleErrors).toEqual([]);
	} catch (cause) {
		throw await rendererFailure(cause, page, workspace.diagnostics);
	} finally {
		await stopWorkspace(workspace);
	}
});

test("compact tabs and release notes stay usable when the sidebar is clipped and a new task opens", async ({}, testInfo) => {
	test.setTimeout(90_000);
	const sessionId = "81000000-0000-4000-8000-0000000000f1";
	const workspace = await launchWorkspace({ sessions: [{ id: sessionId, mode: "code", name: "Polish Alpha" }] });
	const { page } = workspace;
	try {
		await page.getByRole("button", { name: "Code", exact: true }).click();
		await page.getByRole("button", { name: "Polish Alpha", exact: true }).click();
		const codeIcon = page.getByRole("tab", { name: "Polish Alpha", exact: true }).locator('svg[data-mode="code"]');
		await expect(codeIcon).toBeVisible();
		const codeShape = await codeIcon.innerHTML();
		await expectTitlebarControlsAligned(page);
		await page.getByRole("button", { name: "Hide sessions sidebar", exact: true }).click();
		await expect(page.locator(".session-sidebar")).toHaveCount(0);
		await expectTitlebarControlsAligned(page);
		expect(await page.locator('.workspace-tabbar--titlebar').evaluate((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region'))).toBe("no-drag");
		expect(await page.locator('.workspace-tabbar--titlebar .workspace-tabbar-fill').evaluate((element) => getComputedStyle(element).getPropertyValue('-webkit-app-region'))).toBe("drag");
		await page.getByRole("button", { name: "Show sessions sidebar", exact: true }).click();
		await expect(page.locator(".session-sidebar")).toBeVisible();
		await expect(page.getByRole("tab", { name: "Polish Alpha", exact: true })).toHaveAttribute("aria-selected", "true");
		await addTool(page, "Terminal");
		const terminalId = await page.locator('.terminal-panel[aria-hidden="false"]').getAttribute("id");
		await expectTitlebarControlsAligned(page);
		const sizes = await page.evaluate(() => {
			const chat = document.querySelector<HTMLElement>('.workspace-tabbar[data-pane-id] .tool-tab.is-active')!;
			const tool = document.querySelector<HTMLElement>('.tool-sidebar-tabbar .tool-tab.is-active')!;
			return [chat, tool].map((tab) => ({ height: tab.getBoundingClientRect().height, font: getComputedStyle(tab.querySelector(".tool-tab-select")!).fontSize }));
		});
		expect(sizes[0]).toEqual(sizes[1]);
		await expectTitlebarControlsAligned(page);
		const panelTop = (await page.locator('.terminal-panel[aria-hidden="false"]').boundingBox())!.y;
		await page.screenshot({ path: testInfo.outputPath("titlebar-aligned-windowed.png"), animations: "disabled" });
		if (process.platform === "darwin") {
			// Exercise the renderer's fullscreen layout; native fullscreen is also checked manually.
			await page.evaluate(() => { document.documentElement.dataset.fullscreen = "true"; });
			await expectTitlebarControlsAligned(page, true);
			await expect.poll(async () => (await page.locator('.terminal-panel[aria-hidden="false"]').boundingBox())!.y).toBe(panelTop - 6);
			await page.screenshot({ path: testInfo.outputPath("titlebar-aligned-fullscreen-layout.png"), animations: "disabled" });
			await page.evaluate(() => { delete document.documentElement.dataset.fullscreen; });
			await expectTitlebarControlsAligned(page);
			await expect.poll(async () => (await page.locator('.terminal-panel[aria-hidden="false"]').boundingBox())!.y).toBe(panelTop);
		}
		await page.locator(".details-sidebar-toggle").click();
		await expect(page.locator(".tool-sidebar")).toBeHidden();
		await expectTitlebarControlsAligned(page);
		await page.locator(".details-sidebar-toggle").click();
		await expect(page.locator('.terminal-panel[aria-hidden="false"]')).toBeVisible();
		await expectTitlebarControlsAligned(page);
		await expect(page.locator(".tool-tab-indicator")).toBeHidden();
		await page.setViewportSize({ width: 900, height: 700 });
		await expectTitlebarControlsAligned(page);
		expect((await page.locator('.terminal-panel[aria-hidden="false"]').boundingBox())!.y).toBe(panelTop);
		const bell = page.locator(".release-notes-trigger");
		await bell.click();
		const notes = page.getByRole("dialog", { name: "What's new", exact: true });
		await expect(notes).toBeVisible();
		const box = await notes.boundingBox();
		const sidebar = await page.locator(".session-sidebar").boundingBox();
		if (!box || !sidebar) throw new Error("Missing release notes bounds");
		expect(box.x).toBeGreaterThanOrEqual(8);
		expect(box.x + box.width).toBeLessThanOrEqual(892);
		expect(box.y).toBeGreaterThanOrEqual(8);
		expect(box.y + box.height).toBeLessThanOrEqual(692);
		expect(box.x + box.width).toBeGreaterThan(sidebar.x + sidebar.width);
		expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest(".release-notes-dialog")), { x: box.x + box.width - 16, y: box.y + 20 })).toBe(true);
		await page.screenshot({ path: testInfo.outputPath("release-notes-unclipped.png"), animations: "disabled" });
		await page.keyboard.press("Escape");
		await expect(notes).toHaveCount(0);
		await expect(bell).toBeFocused();
		await page.getByRole("button", { name: "New task", exact: true }).click();
		await expect(page.getByRole("tab", { name: "New task", exact: true }).locator('svg[data-mode="code"]')).toBeVisible();
		await expect(page.locator(".new-task-home")).toHaveCSS("background-color", "rgb(20, 20, 20)");
		expect(await page.locator(".new-task-home").evaluate((home) => getComputedStyle(home).backgroundColor)).toBe(
			await page.locator("main.workspace").evaluate((main) => getComputedStyle(main).backgroundColor),
		);
		await expect(page.locator(".tool-sidebar")).toBeHidden();
		const [homeBox, workspaceBox] = await Promise.all([page.locator(".new-task-home").boundingBox(), page.locator("main.workspace").boundingBox()]);
		if (!homeBox || !workspaceBox) throw new Error("Missing new task layout");
		expect(homeBox.width).toBeGreaterThanOrEqual(workspaceBox.width - 3);
		await page.screenshot({ path: testInfo.outputPath("new-task-full-width.png"), animations: "disabled" });
		await page.getByRole("tab", { name: "Polish Alpha", exact: true }).click();
		await expect(page.locator('.terminal-panel[aria-hidden="false"]')).toHaveAttribute("id", terminalId!);
		await page.getByRole("button", { name: "Chat", exact: true }).click();
		await page.getByRole("button", { name: "New task", exact: true }).click();
		const chatIcon = page.getByRole("tab", { name: "New task", exact: true }).locator('svg[data-mode="chat"]');
		await expect(chatIcon).toBeVisible();
		expect(await chatIcon.innerHTML()).not.toBe(codeShape);
		await page.screenshot({ path: testInfo.outputPath("chat-home-theme-tab-icon.png"), animations: "disabled" });
		expect(workspace.consoleErrors).toEqual([]);
	} catch (cause) {
		throw await rendererFailure(cause, page, workspace.diagnostics);
	} finally { await stopWorkspace(workspace); }
});

test("deleting a Chat project preserves a managed task sharing its workspace", async ({}, testInfo) => {
	test.setTimeout(90_000);
	const managedId = "81000000-0000-4000-8000-0000000000f2";
	const selectedId = "81000000-0000-4000-8000-0000000000f3";
	const sharedProject = path.join("agent", "workspaces", managedId);
	const workspace = await launchWorkspace({ sessions: [
		{ id: managedId, mode: "chat", name: "Original temporary task", project: sharedProject, cwdOrigin: "managed" },
		{ id: selectedId, mode: "chat", name: "Selected Alpha", project: sharedProject },
		{ id: "81000000-0000-4000-8000-0000000000f4", mode: "chat", name: "Selected Beta", project: sharedProject },
	] });
	const { page } = workspace;
	const marker = path.join(workspace.tempRoot, sharedProject, "keep-task-data.txt");
	try {
		await writeFile(marker, "Original task data must survive project deletion");
		await page.getByRole("button", { name: "Group sessions", exact: true }).click();
		await page.getByRole("menu", { name: "Session grouping" }).getByRole("menuitemradio", { name: "Project", exact: true }).click();
		await page.getByRole("button", { name: "Selected Alpha", exact: true }).click();
		const project = page.locator(".project-group").filter({ has: page.getByRole("button", { name: "Selected Alpha", exact: true }) });
		await project.getByRole("button", { name: "Project actions", exact: true }).focus();
		await expect(project.locator(".project-action-buttons")).toHaveCSS("opacity", "1");
		await project.getByRole("button", { name: "Project actions", exact: true }).click();
		await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "Delete Chat project?", exact: true });
		await expect(dialog.getByText("2 Chat sessions", { exact: false })).toBeVisible();
		await expect(dialog.getByRole("button", { name: "Move to Trash", exact: true })).toBeEnabled();
		await page.screenshot({ path: testInfo.outputPath("chat-project-delete-preview.png"), animations: "disabled" });
		await dialog.getByRole("button", { name: "Move to Trash", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Selected Alpha", exact: true })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Selected Beta", exact: true })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Original temporary task", exact: true })).toBeVisible();
		expect(await readFile(marker, "utf8")).toBe("Original task data must survive project deletion");
		const journals = await page.evaluate(async () => (globalThis as unknown as {
			metis: MetisDesktopApi;
		}).metis.listSessions({ includeArchived: true, limit: 200 }));
		expect(journals.sessions.map((session) => session.sessionId)).toEqual([managedId]);
		await page.screenshot({ path: testInfo.outputPath("chat-project-deleted-managed-task-kept.png"), animations: "disabled" });
		expect(workspace.consoleErrors).toEqual([]);
	} catch (cause) {
		throw await rendererFailure(cause, page, workspace.diagnostics);
	} finally { await stopWorkspace(workspace); }
});

test("the latest tools sidebar width survives session switches and a narrow-window renderer restart", async ({}, testInfo) => {
	test.setTimeout(120_000);
	const first = "81000000-0000-4000-8000-0000000000e1";
	const second = "81000000-0000-4000-8000-0000000000e2";
	const workspace = await launchWorkspace({
		sessions: [
			{ id: first, mode: "chat", name: "Width Alpha" },
			{ id: second, mode: "chat", name: "Width Beta" },
		],
	});
	const { page } = workspace;
	try {
		await page.setViewportSize({ width: 1600, height: 1000 });
		await page.getByRole("button", { name: "Width Alpha", exact: true }).click();
		await addTool(page, "Browser");
		const sidebar = page.locator(".tool-sidebar");
		const divider = page.getByRole("separator", { name: "Resize tools sidebar", exact: true });
		await expect(sidebar).toHaveCSS("width", "393px");
		for (let index = 0; index < 8; index++) await divider.press("ArrowLeft");
		await expect(sidebar).toHaveCSS("width", "521px");
		const savedWidth = () => page.evaluate(() => localStorage.getItem("metis.tools-sidebar-width.v3"));
		expect(await savedWidth()).toBe("521");
		const expectAligned = async () => {
			await expect
				.poll(async () => {
					const header = await page.locator(".workspace-titlebar-tools.is-open").boundingBox();
					const body = await sidebar.boundingBox();
					return header && body
						? Math.max(Math.abs(header.x - body.x), Math.abs(header.width - body.width))
						: Infinity;
				})
				.toBeLessThanOrEqual(1);
		};
		await expectAligned();
		await page.getByRole("button", { name: "Width Beta", exact: true }).click();
		await expect(sidebar).toHaveCSS("width", "521px");
		await expectAligned();

		await page.setViewportSize({ width: 1000, height: 800 });
		await expect(sidebar).toHaveCSS("width", "280px");
		expect(await savedWidth()).toBe("521");
		await page.reload();
		await waitForServerReady(page);
		await page.getByRole("button", { name: "Width Beta", exact: true }).click();
		await addTool(page, "Browser");
		await expect(sidebar).toHaveCSS("width", "280px");
		expect(await savedWidth()).toBe("521");
		await expectAligned();
		await page.setViewportSize({ width: 1600, height: 1000 });
		await expect(sidebar).toHaveCSS("width", "521px");
		await expectAligned();
		await page.getByRole("button", { name: "Width Alpha", exact: true }).click();
		await expect(sidebar).toHaveCSS("width", "521px");
		expect(await savedWidth()).toBe("521");
		await page.screenshot({
			path: testInfo.outputPath("tools-width-restored-after-restart.png"),
			animations: "disabled",
		});
		expect(workspace.consoleErrors).toEqual([]);
	} catch (cause) {
		throw await rendererFailure(cause, page, workspace.diagnostics);
	} finally {
		await stopWorkspace(workspace);
	}
});

test("browser-style sidebar opens pages, preserves tools, and keeps sessions independent", async ({}, testInfo) => {
	test.setTimeout(120_000);
	const first = "81000000-0000-4000-8000-0000000000d1";
	const second = "81000000-0000-4000-8000-0000000000d2";
	const workspace = await launchWorkspace({ sessions: [
		{ id: first, mode: "code", name: "Browser Alpha" },
		{ id: second, mode: "code", name: "Browser Beta" },
	] });
	const { page } = workspace;
	try {
		await page.getByRole("button", { name: "Code", exact: true }).click();
		await page.getByRole("button", { name: "Browser Alpha", exact: true }).click();
		await page.locator(".details-sidebar-toggle").click();
		const strip = page.locator(".tool-sidebar-tabbar");
		await expect(strip.getByRole("tab")).toHaveCount(1);
		await expect(page.locator(".tool-sidebar-panel:not([hidden]) .browser-start-page")).toBeVisible();
		await page.setViewportSize({ width: 1600, height: 1075 });
		const divider = page.getByRole("separator", { name: "Resize tools sidebar", exact: true });
		await divider.focus();
		for (let index = 0; index < 26; index++) await divider.press("ArrowLeft");
		const capture = async (name: string) => {
			const header = await page.locator(".workspace-titlebar-tools").boundingBox();
			const sidebar = await page.locator(".tool-sidebar").boundingBox();
			if (!header || !sidebar) throw new Error("Missing sidebar screenshot bounds");
			await page.screenshot({ path: testInfo.outputPath(name), animations: "disabled", clip: {
				x: sidebar.x, y: header.y, width: sidebar.width, height: sidebar.y + sidebar.height - header.y,
			} });
		};
		await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
		await capture("browser-start-dark.png");
		await page.screenshot({ path: testInfo.outputPath("browser-workspace-dark.png"), animations: "disabled" });
		await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
		await capture("browser-start-light.png");
		await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
		await page.getByRole("button", { name: "New browser tab", exact: true }).click();
		await expect(strip.getByRole("tab")).toHaveCount(2);
		const address = workspace.fakeProvider.address();
		if (!address || typeof address === "string") throw new Error("Missing local browser fixture port");
		const url = `http://127.0.0.1:${address.port}/browser-page`;
		const urlInput = page.locator('.browser-panel.is-visible input[aria-label="Browser address"]');
		await expect(urlInput).toBeFocused();
		await urlInput.fill(url);
		await expect(urlInput).toHaveValue(url);
		await urlInput.press("Enter");
		await expect(strip.getByRole("tab", { name: "Sidebar page", exact: true })).toBeVisible();
		await expect.poll(() => workspace.browser.contexts().flatMap((context) => context.pages()).some((candidate) => candidate.url() === url)).toBe(true);
		const embeddedPage = workspace.browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url() === url)!;
		await expect(embeddedPage.locator("h1")).toHaveText("Browser sidebar page");
		await strip.getByRole("tab", { name: "Sidebar page", exact: true }).click({ button: "right" });
		await expect(page.locator(".workspace-tab-menu")).toBeVisible();
		await expect(page.locator(".browser-panel.is-visible .browser-view-preview")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.locator(".workspace-tab-menu")).toHaveCount(0);
		await expect(page.locator(".browser-panel.is-visible .browser-view-preview")).toHaveCount(0);
		await expect(embeddedPage.locator("h1")).toHaveText("Browser sidebar page");
		await addTool(page, "Terminal");
		const terminalId = await page.locator(".tool-sidebar-panel:not([hidden]) .terminal-panel").getAttribute("id");
		await page.getByRole("button", { name: "Hide tools sidebar", exact: true }).click();
		await expect(page.locator(".tool-sidebar")).toBeHidden();
		await page.getByRole("button", { name: "Show tools sidebar", exact: true }).click();
		await expect(page.locator(".tool-sidebar-panel:not([hidden]) .terminal-panel")).toHaveAttribute("id", terminalId!);
		await page.getByRole("button", { name: "Browser Beta", exact: true }).click();
		await expect(strip.getByRole("tab")).toHaveCount(1);
		await expect(strip.getByRole("tab", { name: "New tab", exact: true })).toBeVisible();
		await page.getByRole("button", { name: "Browser Alpha", exact: true }).click();
		await expect(strip.getByRole("tab")).toHaveCount(3);
		await expect(page.locator(".tool-sidebar-panel:not([hidden]) .terminal-panel")).toHaveAttribute("id", terminalId!);
		await page.getByRole("button", { name: "Close Terminal", exact: true }).click();
		await page.getByRole("button", { name: "Close Sidebar page", exact: true }).click();
		const initialBrowser = await page.locator(".browser-panel.is-visible").getAttribute("id");
		await page.getByRole("button", { name: "Close New tab", exact: true }).click();
		await expect(strip.getByRole("tab")).toHaveCount(1);
		await expect(page.locator(".tool-sidebar-panel:not([hidden]) .browser-start-page")).toBeVisible();
		await expect(page.locator(".browser-panel.is-visible")).not.toHaveAttribute("id", initialBrowser!);
		await divider.focus();
		for (let index = 0; index < 34; index++) await divider.press("ArrowRight");
		await capture("browser-start-narrow.png");
		await expect(page.locator(".browser-panel.is-visible .browser-start-recent-page")).toContainText("Sidebar page");
		await page.locator(".browser-panel.is-visible .tool-sidebar-menu").getByRole("button", { name: "Terminal", exact: true }).focus();
		await expect(page.locator(".browser-panel.is-visible .tool-sidebar-menu").getByRole("button", { name: "Terminal", exact: true })).toBeFocused();
		await capture("browser-start-keyboard-focus.png");
		await expect(page.getByRole("button", { name: "New browser tab", exact: true })).toBeInViewport();
		expect(workspace.consoleErrors).toEqual([]);
	} catch (cause) {
		throw await rendererFailure(cause, page, workspace.diagnostics);
	} finally {
		await stopWorkspace(workspace);
	}
});

test("terminal keeps its content in the sidebar while chat tabs split", async () => {
	test.setTimeout(120_000);
	const sessionId = "81000000-0000-4000-8000-0000000000c3";
	const sessionTwo = "81000000-0000-4000-8000-0000000000c4";
	const workspace = await launchWorkspace({
		sessions: [
			{ id: sessionId, mode: "chat", name: "Layout Alpha" },
			{ id: sessionTwo, mode: "chat", name: "Layout Beta" },
		],
	});
	const { consoleErrors, diagnostics, page } = workspace;
	try {
		await page.setViewportSize({ width: 1600, height: 900 });
		await page.locator('.session-button[aria-label="Layout Alpha"]').click();
		await page.locator(`[data-active-session-id="${sessionId}"]`).waitFor({ state: "visible" });

		await addTool(page, "Terminal");
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

		// Only chat tabs split; the sidebar's terminal must survive pane changes.
		await page.locator('.session-button[aria-label="Layout Beta"]').click();
		await page.locator(`[data-active-session-id="${sessionTwo}"]`).waitFor({ state: "visible" });
		await page.locator(".tool-tab", { has: page.getByRole("tab", { name: "Layout Beta", exact: true }) })
			.click({ button: "right" });
		await page.locator(".workspace-tab-menu").getByRole("menuitem", { name: "Split right", exact: true }).click();
		await expect(page.locator(".workspace-pane")).toHaveCount(2);

		expect(await panelHandle?.evaluate((element) => element.isConnected)).toBe(true);
		await page.getByRole("tab", { name: "Layout Alpha", exact: true }).click();
		await page.locator(`[data-active-session-id="${sessionId}"]`).waitFor({ state: "visible" });
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

test("project tab groups collapse from their label and move as one", async () => {
	test.setTimeout(120_000);
	const alphaOne = "81000000-0000-4000-8000-0000000000a1";
	const alphaTwo = "81000000-0000-4000-8000-0000000000a2";
	const beta = "81000000-0000-4000-8000-0000000000b1";
	const workspace = await launchWorkspace({
		sessions: [
			{ id: alphaOne, mode: "chat", name: "Group Alpha One" },
			{ id: alphaTwo, mode: "chat", name: "Group Alpha Two" },
			{ id: beta, mode: "chat", name: "Group Beta", project: "beta-project" },
		],
	});
	const { consoleErrors, diagnostics, page } = workspace;
	const tabNames = () => page.locator('.workspace-tabbar[data-pane-id] [role="tab"]').evaluateAll((tabs) => tabs.map((tab) => tab.getAttribute("aria-label")));
	const label = (name: string) => page.getByRole("button", { name: `${name} tab group`, exact: true });
	try {
		const open = async (name: string, id: string) => {
			await page.locator(`.session-button[aria-label="${name}"]`).click();
			await page.locator(`[data-active-session-id="${id}"]`).waitFor({ state: "visible" });
		};
		await open("Group Alpha One", alphaOne);
		await open("Group Alpha Two", alphaTwo);
		// One project in the pane: no labels.
		await expect(page.locator(".tool-tab-group-label")).toHaveCount(0);

		await open("Group Beta", beta);
		await expect(page.locator(".tool-tab-group-label")).toHaveCount(2);
		await expect.poll(tabNames).toEqual(["Group Alpha One", "Group Alpha Two", "Group Beta"]);
		await expectTitlebarControlsAligned(page);
		if (process.env.METIS_AUDIT_DIR) {
			await mkdir(process.env.METIS_AUDIT_DIR, { recursive: true });
			await page.screenshot({ path: path.join(process.env.METIS_AUDIT_DIR, "tab-groups.png") });
		}

		// Keyboard: the label is a button that toggles its group.
		await label("project").focus();
		await page.keyboard.press("Enter");
		await expect(label("project")).toHaveAttribute("aria-expanded", "false");
		await expect.poll(tabNames).toEqual(["Group Beta"]);
		await expectTitlebarControlsAligned(page);
		if (process.env.METIS_AUDIT_DIR) {
			await page.screenshot({ path: path.join(process.env.METIS_AUDIT_DIR, "tab-groups-collapsed.png") });
		}
		await page.keyboard.press("Space");
		await expect(label("project")).toHaveAttribute("aria-expanded", "true");
		await expect.poll(tabNames).toEqual(["Group Alpha One", "Group Alpha Two", "Group Beta"]);

		// Collapsing the active tab's group moves focus to the nearest tab outside it.
		await page.getByRole("tab", { name: "Group Alpha Two", exact: true }).click();
		await label("project").click();
		await expect(page.getByRole("tab", { name: "Group Beta", exact: true })).toHaveAttribute("aria-selected", "true");
		await page.locator(`[data-active-session-id="${beta}"]`).waitFor({ state: "visible" });
		// Opening a folded session from the sidebar reopens its group.
		await open("Group Alpha One", alphaOne);
		await expect(label("project")).toHaveAttribute("aria-expanded", "true");

		// Dragging a label moves its whole group.
		await label("beta-project").dragTo(label("project"), { targetPosition: { x: 2, y: 8 } });
		await expect.poll(tabNames).toEqual(["Group Beta", "Group Alpha One", "Group Alpha Two"]);
		await expect(page.locator(".tool-tab-group-label")).toHaveCount(2);
		await expectTitlebarControlsAligned(page);
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

		await addTool(page, "Files");
		const readmeRow = page.locator('.file-tree-row-select[title="README.md"]');
		await readmeRow.click();
		await expect(page.getByRole("tab", { name: "README.md", exact: true })).toBeVisible();
		await readmeRow.dblclick();

		await page.locator('.session-button[aria-label="Files Beta"]').click();
		await page.locator(`[data-active-session-id="${betaId}"]`).waitFor({ state: "visible" });

		await page.getByRole("tab", { name: "Files Alpha", exact: true }).click();
		await page.locator(`[data-active-session-id="${alphaId}"]`).waitFor({ state: "visible" });
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
	const ids = Object.fromEntries(
		["a", "b", "c", "d", "e", "f"].map((key, index) => [key, `81000000-0000-4000-8000-0000000000e${index + 2}`]),
	);
	const workspace = await launchWorkspace({
		sessions: [
			{ id: ids.a, mode: "chat", name: "Grid Alpha" },
			{ id: ids.b, mode: "chat", name: "Grid Bravo" },
			{ id: ids.c, mode: "chat", name: "Grid Charlie" },
			{ id: ids.d, mode: "chat", name: "Grid Delta" },
			{ id: ids.e, mode: "chat", name: "Grid Echo" },
			{ id: ids.f, mode: "chat", name: "Grid Foxtrot" },
		],
	});
	const { consoleErrors, diagnostics, page } = workspace;
	try {
		const open = async (name: string, id: string) => {
			await page.locator(`.session-button[aria-label="${name}"]`).click();
			await page.locator(`[data-active-session-id="${id}"]`).waitFor({ state: "visible" });
		};
		await page.setViewportSize({ width: 1600, height: 900 });
		await open("Grid Alpha", ids.a!);

		const openTabMenu = async (name: string) => {
			await page.locator(".tool-tab", { has: page.getByRole("tab", { name, exact: true }) }).first().click({ button: "right" });
		};
		const menuItem = (name: string) =>
			page.locator(".workspace-tab-menu").getByRole("menuitem", { name, exact: true });

		// Only chat tabs split; keep a terminal mounted to prove panels survive.
		await addTool(page, "Terminal");
		const terminalPanel = page.locator(".terminal-panel").first();
		await expect(terminalPanel).toBeVisible();
		const terminalHandle = await terminalPanel.elementHandle();

		await open("Grid Bravo", ids.b!);
		await openTabMenu("Grid Bravo");
		await menuItem("Split right").click();
		await expect(page.locator(".workspace-pane")).toHaveCount(2);

		// At 1600x900 the left and tools sidebars leave room for two columns.
		await open("Grid Charlie", ids.c!);
		await openTabMenu("Grid Charlie");
		await expect(menuItem("Split right")).toBeDisabled();
		await expect(menuItem("Split right")).toHaveAttribute("title", "Not enough room to split");
		await page.keyboard.press("Escape");

		await page.setViewportSize({ width: 2200, height: 900 });
		await page.waitForFunction(
			() => document.querySelector(".session-workspace-panes")!.getBoundingClientRect().width > 1200,
		);
		await openTabMenu("Grid Charlie");
		await menuItem("Split right").click();
		await expect(page.locator(".workspace-row").first().locator(".workspace-pane")).toHaveCount(3);

		for (const [name, id] of [["Grid Delta", ids.d], ["Grid Echo", ids.e], ["Grid Foxtrot", ids.f]] as const) {
			await page.getByRole("tab", { name: "Grid Charlie", exact: true }).click();
			await open(name, id!);
			await openTabMenu(name);
			await menuItem("Split down").click();
		}

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


test("packaged conversation quotes reach the model and restore as source-linked annotations", async ({}, testInfo) => {
	test.setTimeout(90_000);
	const workspace = await launchWorkspace({ sessions: [
		{ id: "92000000-0000-4000-8000-000000000001", mode: "chat", name: "Quote Chat" },
		{ id: "92000000-0000-4000-8000-000000000002", mode: "code", name: "Quote Code" },
	] });
	const { page } = workspace;
	try {
		for (const mode of ["chat", "code"] as const) {
			const label = mode === "chat" ? "Chat" : "Code";
			await page.getByRole("button", { name: label, exact: true }).click();
			await page.getByRole("button", { name: `Quote ${label}`, exact: true }).click();
			await expect(page.locator("[data-active-session-id]")).toHaveAttribute("data-active-session-id", mode === "chat" ? "92000000-0000-4000-8000-000000000001" : "92000000-0000-4000-8000-000000000002");
			const editor = page.locator('.composer-editable-input[contenteditable="true"]:visible');
			await editor.fill(`Start quote fixture in ${mode}`);
			await editor.press("Enter");
			await expect(page.locator(".transcript:visible").getByText("layout-reply", { exact: true }).last()).toBeVisible();
			await expect(page.getByRole("button", { name: "Stop task", exact: true })).toHaveCount(0);
			const activeTitle = await page.locator('.workspace-tabbar[data-pane-id] [role="tab"][aria-selected="true"]').first().getAttribute("aria-label");
			if (!activeTitle) throw new Error("The packaged conversation did not activate a session tab");
			const reply = page.locator(".transcript:visible").getByText("layout-reply", { exact: true }).last();
			const renderedSourceId = await reply.evaluate((element) => element.closest<HTMLElement>("[data-quote-item]")?.dataset.quoteItem);
			if (!renderedSourceId) throw new Error("Packaged reply has no quote source marker");
			await reply.scrollIntoViewIfNeeded();
			const rect = await reply.evaluate((element) => {
				const range = document.createRange(); range.selectNodeContents(element);
				const bounds = range.getBoundingClientRect();
				return { x: bounds.x, y: bounds.y + bounds.height / 2, width: bounds.width };
			});
			await page.mouse.move(rect.x + .2, rect.y); await page.mouse.down();
			await page.mouse.move(rect.x + rect.width - .2, rect.y, { steps: 10 }); await page.mouse.up();
			await expect(page.getByRole("button", { name: "Add to conversation", exact: true })).toBeEnabled();
			const selectedText = await page.evaluate(() => window.getSelection()?.toString() ?? "");
			expect(selectedText.trim().length).toBeGreaterThan(0);
			expect("layout-reply").toContain(selectedText.trim());
			await page.getByRole("button", { name: "Add to conversation", exact: true }).click();
			await expect(page.locator(".composer-conversation-quotes:visible")).toHaveCount(1);
			await expect(editor).toBeFocused();
			const question = `Explain quoted reply in ${mode}`;
			await editor.fill(question); await editor.press("Enter");
			const annotation = page.locator(".message-annotations-trigger:visible");
			await expect(annotation).toHaveText("1 annotations");
			await expect.poll(() => workspace.modelRequests.some((request) => JSON.stringify(request.messages ?? []).includes(question))).toBe(true);
			const request = [...workspace.modelRequests].reverse().find((request) => JSON.stringify(request.messages ?? []).includes(question))!;
			const user = [...(request.messages ?? [])].reverse().find((message) => message.role === "user");
			if (!user) throw new Error("Packaged model request has no user message");
			const content = typeof user.content === "string" ? user.content : Array.isArray(user.content) ? user.content.map((block: { text?: string }) => block.text ?? "").join("\n") : "";
			const block = /<conversation_quotes>\n([^<]*)\n<\/conversation_quotes>/u.exec(content);
			if (!block) throw new Error("Packaged model request lost the conversation quote");
			const quote = JSON.parse(block[1]!).quotes[0];
			expect(quote.sourceRole).toBe("assistant"); expect(quote.selectedText).toBe(selectedText);
			await expect(page.getByRole("button", { name: "Stop task", exact: true })).toHaveCount(0);
			await page.screenshot({ path: testInfo.outputPath(`packaged-annotation-${mode}.png`) });
			await page.reload(); await waitForServerReady(page);
			await page.getByRole("button", { name: label, exact: true }).click();
			await page.locator(".session-button").filter({ hasText: activeTitle }).click();
			await expect(annotation).toHaveText("1 annotations");
			await annotation.click();
			await expect(page.getByRole("dialog", { name: "Conversation annotations", exact: true })).toContainText(selectedText);
			await page.screenshot({ path: testInfo.outputPath(`packaged-annotation-preview-${mode}.png`) });
			await page.getByRole("button", { name: "Go to original message", exact: true }).click();
			await expect(page.locator(`[data-quote-item="${quote.sourceItemId}"], [data-quote-item="${renderedSourceId}"]`).first()).toBeInViewport();
			await expect(page.locator(".transcript-quote-notice")).toHaveCount(0);
		}
		expect(workspace.consoleErrors).toEqual([]);
	} catch (error) { throw await rendererFailure(error, page, workspace.diagnostics); }
	finally { await stopWorkspace(workspace); }
});
