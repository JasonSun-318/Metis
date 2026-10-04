import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
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

test("terminal keeps its content when its tab is split into a second pane", async () => {
	test.setTimeout(120_000);
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const coreRoot = path.resolve(desktopRoot, "../coding-agent/dist/core");
	const importEsm = Function("specifier", "return import(specifier)") as (specifier: string) => Promise<Record<string, unknown>>;
	const sessions = (await importEsm(pathToFileURL(path.join(coreRoot, "session-manager.js")).href)) as unknown as {
		SessionManager: {
			create(cwd: string, sessionDir: string, options: { id: string; mode: "chat"; permissionPreset: "full" }): {
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

	const sessionId = "81000000-0000-4000-8000-0000000000c3";
	const manager = sessions.SessionManager.create(
		projectDir,
		sessions.getDefaultSessionDir(projectDir, agentDir),
		{ id: sessionId, mode: "chat", permissionPreset: "full" },
	);
	manager.appendSessionInfo("Layout Alpha");
	manager.close();
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
	let browser: Browser | undefined;
	let page: Page | undefined;
	try {
		({ browser, page } = await connectToApp(debuggingPort, app, diagnostics));
		page.setDefaultTimeout(15_000);
		page.on("console", (message) => {
			if (message.type() === "error") consoleErrors.push(message.text());
		});
		await page.setViewportSize({ width: 1200, height: 800 });
		await waitForServerReady(page);

		await page.locator('.session-button[aria-label="Layout Alpha"]').click();
		await page.locator(`[data-active-session-id="${sessionId}"]`).waitFor({ state: "visible" });

		await page.locator(".tool-add-trigger").first().click();
		await page.locator(".tool-add-menu").getByRole("menuitem", { name: "Terminal", exact: true }).click();
		await expect(page.getByRole("tab", { name: "Terminal", exact: true })).toBeVisible();

		const panel = page.locator('.terminal-panel[aria-hidden="false"]');
		await expect(panel).toBeVisible();
		const terminalId = (await panel.getAttribute("id"))!.slice("terminal-panel-".length);
		const panelHandle = await panel.elementHandle();
		await expect.poll(async () => page!.evaluate(async (id) => {
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
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nrenderer body:\n${bodyText}\n${diagnostics.join("").slice(-8_000)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
	}
});
