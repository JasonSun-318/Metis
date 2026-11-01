import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import {
	createPluginFixtureServer,
	FIXTURE_COMMIT_A,
	FIXTURE_COMMIT_B,
	FIXTURE_MARKET_URL,
	type PluginFixtureServer,
} from "./fixtures/plugin-market-fixture.ts";
import {
	connectToApp,
	createAndRestoreChatSession,
	launchPackagedDesktop,
	listen,
	packagedExecutable,
	readOpenAiChatRequest,
	reservePort,
	respondWithText,
	respondWithToolCall,
	stopProcess,
	waitForServerReady,
	writeOfflineProviderConfig,
	type OpenAiChatRequest,
} from "./packaged-app-harness.ts";

test.describe("Desktop Plugin Marketplaces Lifecycle & Runtime", () => {
	test.setTimeout(180_000);

	let fixtureServer: PluginFixtureServer | undefined;

	test.beforeAll(async () => {
		fixtureServer = await createPluginFixtureServer();
	});

	test.afterAll(async () => {
		await fixtureServer?.close();
	});

	test("Scenario A, B & E: Full marketplace discovery, inspection, installation, runtime execution, UI update A->B, toggle, restart and uninstall", async ({}, testInfo) => {
		const executable = packagedExecutable();
		expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);
		expect(fixtureServer, "Fixture server must be running").toBeDefined();

		// Ensure start at Commit A
		fixtureServer!.setCommit(FIXTURE_COMMIT_A);
		fixtureServer!.setFailDownload(false);
		fixtureServer!.setRateLimited(false);

		const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-plugin-e2e-suite-"));
		const agentDir = path.join(tempRoot, "agent");
		const homeDir = path.join(tempRoot, "home");
		const projectDir = path.join(tempRoot, "project");
		const userDataDir = path.join(tempRoot, "electron");
		await Promise.all([mkdir(agentDir), mkdir(homeDir), mkdir(projectDir), mkdir(userDataDir)]);

		const agentRequests: OpenAiChatRequest[] = [];

		const fakeProvider = createServer(async (request, response) => {
			if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
				response.writeHead(404).end();
				return;
			}
			const req = await readOpenAiChatRequest(request);
			const transcript = JSON.stringify(req.messages ?? []);

			if (transcript.includes("conversation title generator")) {
				respondWithText(response, "Plugin E2E Test Title");
				return;
			}

			agentRequests.push(req);

			const tools = (req as unknown as { tools?: Array<{ function?: { name: string } }> }).tools ?? [];
			const suiteEchoTool = tools.find((t) => t.function?.name?.includes("fixture_suite_echo"));
			const hasToolSearch = tools.some((t) => t.function?.name === "tool_search");

			// If tool result was received in messages, return it back in the assistant answer
			const toolResultMsg = req.messages?.find(
				(m) => m.role === "tool" && String(m.content).includes("FIXTURE_MCP_ECHO_RESULT"),
			);
			if (toolResultMsg) {
				respondWithText(response, `MCP tool executed successfully: ${String(toolResultMsg.content)}`);
				return;
			}

			if (transcript.includes("fixture suite echo")) {
				if (suiteEchoTool) {
					respondWithToolCall(response, {
						callId: `call-suite-echo-${Date.now()}`,
						name: suiteEchoTool.function!.name,
						arguments: { message: "metis-e2e-payload" },
					});
					return;
				}
				if (hasToolSearch) {
					respondWithToolCall(response, {
						callId: `call-search-${Date.now()}`,
						name: "tool_search",
						arguments: { query: "fixture_suite_echo" },
					});
					return;
				}
			}

			respondWithText(response, "Assistant response without tool");
		});

		const providerPort = await listen(fakeProvider);
		await writeOfflineProviderConfig(agentDir, providerPort, {
			providerId: "mock",
			modelId: "mock-model",
		});

		const diagnostics: string[] = [];
		let debuggingPort = await reservePort();
		let app = launchPackagedDesktop({
			executable,
			debuggingPort,
			userDataDir,
			projectDir,
			agentDir,
			homeDir,
			diagnostics,
			env: {
				HTTPS_PROXY: fixtureServer!.proxyUrl,
				NODE_TLS_REJECT_UNAUTHORIZED: "0",
			},
		});

		let browser: Browser | undefined;
		let page: Page | undefined;

		try {
			({ browser, page } = await connectToApp(debuggingPort));
			page.setDefaultTimeout(20_000);
			await page.setViewportSize({ width: 1200, height: 800 });
			await waitForServerReady(page);

			// 1. Navigate to Customize -> Plugins (4th tab)
			await page.getByRole("button", { name: "Customize", exact: true }).click();
			const skillsSearchBounds = await page.locator(".plugins-search").boundingBox();
			const skillsButtonBounds = await page.locator(".plugins-page-actions .plugins-new-trigger").boundingBox();
			await page.getByRole("tab", { name: "Plugins", exact: true }).click();
			await expect(page.locator(".plugins-market-panel")).toBeVisible();
			const marketSearchBounds = await page.locator(".plugins-search").boundingBox();
			expect(marketSearchBounds!.x).toBeCloseTo(skillsSearchBounds!.x, 0);
			expect(marketSearchBounds!.y).toBeCloseTo(skillsSearchBounds!.y, 0);
			await expect(page.locator(".plugins-page-header").getByRole("button", { name: "Add Market", exact: true })).toBeVisible();
			await expect(page.locator(".plugins-sub-tab")).toHaveCount(0);
			const defaultMarket = page.locator(".plugins-source-row").filter({ hasText: "anthropics/claude-plugins-official" });
			await expect(defaultMarket).toBeVisible();
			await expect(defaultMarket.locator("strong")).toHaveText("anthropics/claude-plugins-official");
			const marketButtonBounds = await page.locator(".plugins-page-actions .plugins-new-btn").boundingBox();
			expect(marketButtonBounds!.width).toBeCloseTo(skillsButtonBounds!.width, 1);
			expect(marketButtonBounds!.height).toBeCloseTo(skillsButtonBounds!.height, 1);
			await defaultMarket.locator(".plugins-source-open").hover();
			const rowHover = await defaultMarket.evaluate((el) => getComputedStyle(el).backgroundColor);
			expect(rowHover).not.toBe("rgba(0, 0, 0, 0)");
			await expect(defaultMarket.locator(".plugins-source-open")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
			await defaultMarket.locator(".plugins-market-remove-btn").hover();
			await expect(defaultMarket).toHaveCSS("background-color", rowHover);

			await defaultMarket.locator(".plugins-market-remove-btn").click();
			await expect(page.getByText("No markets added. Add a GitHub market to discover plugins.", { exact: true })).toBeVisible();


			// 2. Add Fixture GitHub Market
			await page.getByRole("button", { name: "Add Market", exact: true }).click();
			const addMarketDialog = page.locator(".plugins-add-market-dialog");
			await expect(addMarketDialog).toBeVisible();
			await addMarketDialog.locator("input[placeholder*='github.com']").fill(FIXTURE_MARKET_URL);
			const addButton = addMarketDialog.getByRole("button", { name: "Add", exact: true });
			const cancelButton = addMarketDialog.getByRole("button", { name: "Cancel", exact: true });
			for (const theme of ["dark", "light"]) {
				await page.evaluate((value) => { document.documentElement.dataset.theme = value; }, theme);
				await addButton.hover();
				await expect(addButton).toHaveCSS("background-color", theme === "dark" ? "rgb(255, 255, 255)" : "rgb(107, 107, 107)");
				await expect(addButton).toHaveCSS("color", theme === "dark" ? "rgb(18, 18, 18)" : "rgb(243, 243, 243)");
				await cancelButton.hover();
				await expect(cancelButton).toHaveCSS("background-color", theme === "dark" ? "rgb(34, 34, 34)" : "rgb(236, 235, 230)");
			}
			await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });
			fixtureServer!.setRateLimited(true);
			await addButton.click();
			await expect(addMarketDialog.getByRole("alert")).toContainText("GitHub request limit reached");
			await expect(addButton).toBeEnabled();
			await addButton.hover();
			await page.screenshot({ path: testInfo.outputPath("market-limit-hover-dark.png") });
			fixtureServer!.setRateLimited(false);
			await addMarketDialog.getByRole("button", { name: "Add", exact: true }).click();
			await expect(addMarketDialog).toHaveCount(0);

			// 3. Verify market loaded and shows fixture plugins
			const suiteRow = page.locator(".plugins-market-row").filter({ hasText: "fixture-suite" });
			await expect(suiteRow).toBeVisible();
			await expect(page.locator(".plugins-market-row").filter({ hasText: "fixture-partial" })).toBeVisible();
			await expect(page.locator(".plugins-market-row").filter({ hasText: "fixture-unsupported" })).toBeVisible();

			// 4. Inspect Fixture Suite Plugin (at Commit A)
			await suiteRow.locator(".plugins-inspect-action-btn").click();

			const inspectDialog = page.locator(".plugins-inspect-dialog");
			await expect(inspectDialog).toBeVisible();
			await expect(inspectDialog.getByRole("heading", { name: "Fixture Suite Plugin" })).toBeVisible();

			// Verify 3 components listed with ready status
			await expect(inspectDialog.locator(".plugins-component-item")).toHaveCount(3);
			await expect(inspectDialog.getByText("fixture-suite-skill", { exact: false })).toBeVisible();
			await expect(inspectDialog.getByText("suite-echo-server", { exact: false })).toBeVisible();
			await expect(inspectDialog.getByText("UserPromptSubmit", { exact: false })).toBeVisible();

			// 5. Install Fixture Suite Plugin
			await inspectDialog.getByRole("button", { name: "Install", exact: true }).click();
			await inspectDialog.getByRole("button", { name: "Done", exact: true }).click();
			await expect(inspectDialog).toHaveCount(0);

			// 6. Verify Installed Tab
			await page.getByRole("button", { name: /Manage plugins/ }).click();
			const installedRow = page.locator(".plugins-installed-row").filter({ hasText: "Fixture Suite Plugin" });
			await expect(installedRow).toBeVisible();
			await expect(installedRow.locator(".badge-enabled")).toBeVisible();
			const originalViewport = page.viewportSize()!;
			for (const width of [1200, 720]) {
				await page.setViewportSize({ width, height: 800 });
				// Read one layout snapshot; resize/reflow can occur between CDP calls.
				const { toggle, manage, row } = await installedRow.evaluate((element) => ({
					toggle: element.querySelector(".plugins-toggle-btn")!.getBoundingClientRect().toJSON(),
					manage: element.querySelector(".plugins-inspect-action-btn")!.getBoundingClientRect().toJSON(),
					row: element.getBoundingClientRect().toJSON(),
				}));
				expect(Math.abs(toggle.y - manage.y), "Card buttons share a top edge").toBeLessThanOrEqual(1);
				expect(toggle.height).toBe(manage.height);
				expect(manage.x - toggle.x - toggle.width, "Card buttons have an 8px gap").toBeGreaterThanOrEqual(8);
				expect(manage.x + manage.width).toBeLessThanOrEqual(row.x + row.width);
				await installedRow.screenshot({ path: testInfo.outputPath(`installed-actions-${width}.png`) });
			}
			await page.setViewportSize(originalViewport);

			// 7. Verify Ownership Badges in Original 3 Tabs
			// Skills tab
			await page.getByRole("tab", { name: "Skills", exact: true }).click();
			const skillRow = page.locator(".plugins-list-row").filter({ hasText: "fixture-suite-skill" });
			await expect(skillRow).toBeVisible();
			await expect(skillRow.locator(".plugins-from-owner-badge")).toBeVisible();
			await expect(skillRow.locator(".plugins-from-owner-badge")).toContainText("Fixture Suite Plugin");

			// MCP tab
			await page.getByRole("tab", { name: "MCP", exact: true }).click();
			const mcpRow = page.locator(".plugins-mcp-row").filter({ hasText: "suite-echo-server" });
			await expect(mcpRow).toBeVisible();
			await expect(mcpRow.locator(".plugins-from-owner-badge")).toBeVisible();
			await expect(mcpRow.locator(".plugins-from-owner-badge")).toContainText("Fixture Suite Plugin");

			// Hooks tab
			await page.getByRole("tab", { name: "Hooks", exact: true }).click();
			const hookRow = page.locator(".plugins-hook-row").filter({ hasText: "User prompt submit" });
			await expect(hookRow).toBeVisible();
			await expect(hookRow.locator(".plugins-from-owner-badge")).toBeVisible();
			await expect(hookRow.locator(".plugins-from-owner-badge")).toContainText("Fixture Suite Plugin");

			// 8. Runtime Execution in Chat Session (Commit A: version 1.0.0)
			await page.getByRole("button", { name: "New task", exact: true }).click();
			const input = page.locator("#composer-input");
			await expect(input).toBeVisible();
			await input.fill("Please run fixture suite echo with metis-e2e-payload");
			await page.getByRole("button", { name: "Send message", exact: true }).click();

			// Handle permission approval dialog for the MCP tool
			const allowOnceBtn = page.getByRole("button", { name: "Allow once", exact: true });
			await expect(allowOnceBtn).toBeVisible({ timeout: 20_000 });
			await allowOnceBtn.click();

			// Verify Assistant response showing v1 MCP tool execution
			await expect(page.getByText("FIXTURE_MCP_ECHO_RESULT:v1:metis-e2e-payload")).toBeVisible({
				timeout: 25_000,
			});

			// Verify v1 hook context was injected into the model request
			const v1Req = agentRequests.find((r) => JSON.stringify(r).includes("FIXTURE_SUITE_HOOK_ACTIVE_CONTEXT_V1"));
			expect(v1Req, "v1 Hook context must be present in model request messages").toBeDefined();

			// 9. Step 2: Real UI Update from Commit A to Commit B
			fixtureServer!.setCommit(FIXTURE_COMMIT_B);

			await page.getByRole("button", { name: "Customize", exact: true }).click();
			await page.getByRole("tab", { name: "Plugins", exact: true }).click();
			await page.getByRole("button", { name: /Manage plugins/ }).click();

			const activePluginRow = page.locator(".plugins-installed-row").filter({ hasText: "Fixture Suite Plugin" });
			await activePluginRow.locator(".plugins-inspect-action-btn").click();

			const detailDialog = page.locator(".plugins-detail-dialog");
			await expect(detailDialog).toBeVisible();
			await detailDialog.getByRole("button", { name: "Check for Updates", exact: true }).click();

			const updateDialog = page.locator(".plugins-update-dialog");
			await expect(updateDialog).toBeVisible();

			// Capture screenshot of update confirmation dialog
			const evidenceDir = path.resolve(process.cwd(), "../../docs/plans/plugin-marketplaces-evidence");
			await mkdir(evidenceDir, { recursive: true }).catch(() => undefined);
			await updateDialog.screenshot({
				animations: "disabled",
				path: path.join(evidenceDir, "plugin-update-dialog-1200x800-dark.png"),
			});

			// Confirm Update
			await updateDialog.getByRole("button", { name: "Update", exact: true }).click();
			await expect(updateDialog).toHaveCount(0);
			await expect(detailDialog).toBeVisible();

			// Detail dialog now shows updated commit B
			await expect(detailDialog.getByText(FIXTURE_COMMIT_B.slice(0, 7))).toBeVisible();
			await detailDialog.locator(".mcp-dialog-close").click();
			await expect(detailDialog).toHaveCount(0);

			// 10. Verify Updated Runtime Execution (Commit B: version 2.0.0)
			await page.getByRole("button", { name: "New task", exact: true }).click();
			await input.fill("Please run fixture suite echo again after update");
			await page.getByRole("button", { name: "Send message", exact: true }).click();

			const allowOnceBtn2 = page.getByRole("button", { name: "Allow once", exact: true });
			await expect(allowOnceBtn2).toBeVisible({ timeout: 20_000 });
			await allowOnceBtn2.click();

			// Verify Assistant response showing v2 MCP tool execution
			await expect(page.getByText("FIXTURE_MCP_ECHO_RESULT:v2:metis-e2e-payload")).toBeVisible({
				timeout: 25_000,
			});

			// Verify v2 hook context was injected
			const v2Req = agentRequests.find((r) => JSON.stringify(r).includes("FIXTURE_SUITE_HOOK_ACTIVE_CONTEXT_V2"));
			expect(v2Req, "v2 Hook context must be present in model request messages").toBeDefined();

			// A real failed download must keep the installed B package and registry unchanged.
			fixtureServer!.setCommit(FIXTURE_COMMIT_A);
			fixtureServer!.setFailDownload(true);
			const registryBeforeFailure = await readFile(path.join(agentDir, "plugins/registry.json"), "utf8");
			await page.getByRole("button", { name: "Customize", exact: true }).click();
			await page.getByRole("tab", { name: "Plugins", exact: true }).click();
			await page.getByRole("button", { name: /Manage plugins/ }).click();
			await activePluginRow.locator(".plugins-inspect-action-btn").click();
			await expect(detailDialog).toBeVisible();
			await detailDialog.getByRole("button", { name: "Check for Updates", exact: true }).click();
			await expect(detailDialog.locator(".mcp-dialog-error")).toBeVisible();
			await expect(detailDialog.getByText(FIXTURE_COMMIT_B.slice(0, 7))).toBeVisible();
			expect(await readFile(path.join(agentDir, "plugins/registry.json"), "utf8")).toBe(registryBeforeFailure);
			await expect(page.locator(".plugins-update-dialog")).toHaveCount(0);
			await detailDialog.locator(".mcp-dialog-close").click();
			fixtureServer!.setCommit(FIXTURE_COMMIT_B);
			fixtureServer!.setFailDownload(false);

			// 12. Disable Plugin & Verify Next Turn Isolation
			await activePluginRow.locator(".plugins-toggle-btn").click();
			await expect(activePluginRow.locator(".badge-disabled")).toBeVisible();

			const reqCountBeforeTurnDisable = agentRequests.length;
			await page.getByRole("button", { name: "New task", exact: true }).click();
			await input.fill("Testing turn after disabling plugin");
			await page.getByRole("button", { name: "Send message", exact: true }).click();

			await expect.poll(() => agentRequests.length).toBeGreaterThan(reqCountBeforeTurnDisable);
			const disabledTurnReq = agentRequests[agentRequests.length - 1];
			const disabledTranscript = JSON.stringify(disabledTurnReq);
			expect(disabledTranscript.includes("FIXTURE_SUITE_HOOK_ACTIVE_CONTEXT")).toBe(false);
			const disabledTools =
				(disabledTurnReq as unknown as { tools?: Array<{ function?: { name: string } }> }).tools ?? [];
			expect(disabledTools.some((t) => t.function?.name?.includes("fixture_suite_echo"))).toBe(false);

			// 13. Enable Plugin back
			await page.getByRole("button", { name: "Customize", exact: true }).click();
			await page.getByRole("tab", { name: "Plugins", exact: true }).click();
			await page.getByRole("button", { name: /Manage plugins/ }).click();
			await activePluginRow.locator(".plugins-toggle-btn").click();
			await expect(activePluginRow.locator(".badge-enabled")).toBeVisible();

			// 14. Restart App & Verify Persistence
			await browser.close();
			await stopProcess(app);

			debuggingPort = await reservePort();
			app = launchPackagedDesktop({
				executable,
				debuggingPort,
				userDataDir,
				projectDir,
				agentDir,
				homeDir,
				diagnostics,
				env: {
					HTTPS_PROXY: fixtureServer!.proxyUrl,
					NODE_TLS_REJECT_UNAUTHORIZED: "0",
				},
			});

			({ browser, page } = await connectToApp(debuggingPort));
			page.setDefaultTimeout(20_000);
			await page.setViewportSize({ width: 1200, height: 800 });
			await waitForServerReady(page);

			// Reopen Customize -> Plugins -> Installed
			await page.getByRole("button", { name: "Customize", exact: true }).click();
			await page.getByRole("tab", { name: "Plugins", exact: true }).click();
			await expect(page.locator(".plugins-source-row").filter({ hasText: "anthropics/claude-plugins-official" })).toHaveCount(0);
			await page.locator(".plugins-source-row").filter({ hasText: "fixture/plugins-market" }).locator(".plugins-market-remove-btn").click();
			await expect(page.locator(".plugins-source-row")).toHaveCount(0);
			await page.getByRole("button", { name: /Manage plugins/ }).click();

			const persistedPlugin = page.locator(".plugins-installed-row").filter({ hasText: "Fixture Suite Plugin" });
			await expect(persistedPlugin).toBeVisible();
			await expect(persistedPlugin.locator(".badge-enabled")).toBeVisible();

			// 15. Uninstall Plugin via Detail Dialog
			const detailDialogAfterRestart = page.locator(".plugins-detail-dialog");
			await persistedPlugin.locator(".plugins-inspect-action-btn").click();
			await expect(detailDialogAfterRestart).toBeVisible();
			await detailDialogAfterRestart.getByRole("button", { name: "Uninstall", exact: true }).click();

			const confirmDialog = page.locator(".plugins-remove-dialog");
			await expect(confirmDialog).toBeVisible();
			await confirmDialog.getByRole("button", { name: "Uninstall", exact: true }).click();
			await expect(confirmDialog).toHaveCount(0);
			await expect(detailDialogAfterRestart).toHaveCount(0);

			await expect(page.locator(".plugins-installed-row").filter({ hasText: "Fixture Suite Plugin" })).toHaveCount(
				0,
			);
			await expect(page.getByText("No plugins installed yet.", { exact: true })).toBeVisible();
		} catch (error) {
			const bodyHtml = await page?.innerHTML("body").catch(() => "failed to get body");
			await writeFile(
				"/tmp/debug-plugins-e2e.txt",
				JSON.stringify(
					{
						bodyHtml,
						diagnostics,
						agentDirExists: existsSync(agentDir),
						error: String(error),
					},
					null,
					2,
				),
			);
			throw error;
		} finally {
			await browser?.close();
			await stopProcess(app);
			fakeProvider.close();
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("Scenario C, D & Visual Verification: Partial compatibility, unsupported, codex, locales, themes and narrow viewport", async ({}, testInfo) => {
		const executable = packagedExecutable();
		expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);
		expect(fixtureServer, "Fixture server must be running").toBeDefined();

		fixtureServer!.setCommit(FIXTURE_COMMIT_A);
		fixtureServer!.setFailDownload(false);

		const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-plugin-e2e-compat-"));
		const agentDir = path.join(tempRoot, "agent");
		const homeDir = path.join(tempRoot, "home");
		const projectDir = path.join(tempRoot, "project");
		const userDataDir = path.join(tempRoot, "electron");
		await Promise.all([mkdir(agentDir), mkdir(homeDir), mkdir(projectDir), mkdir(userDataDir)]);

		const fakeProvider = createServer((_req, response) => {
			respondWithText(response, "hello");
		});
		const providerPort = await listen(fakeProvider);
		await writeOfflineProviderConfig(agentDir, providerPort, {
			providerId: "mock",
			modelId: "mock-model",
		});

		const diagnostics: string[] = [];
		const debuggingPort = await reservePort();
		const app = launchPackagedDesktop({
			executable,
			debuggingPort,
			userDataDir,
			projectDir,
			agentDir,
			homeDir,
			diagnostics,
			env: {
				HTTPS_PROXY: fixtureServer!.proxyUrl,
				NODE_TLS_REJECT_UNAUTHORIZED: "0",
			},
		});

		let browser: Browser | undefined;
		let page: Page | undefined;

		try {
			({ browser, page } = await connectToApp(debuggingPort));
			page.setDefaultTimeout(20_000);
			await page.setViewportSize({ width: 1200, height: 800 });
			await waitForServerReady(page);
			await expect(page.getByRole("button", { name: "Customize", exact: true })).toBeVisible();

			// Switch to Chinese locale
			await page.evaluate(() => {
				localStorage.setItem("metis.locale.v1", "zh-CN");
			});
			await page.reload({ waitUntil: "domcontentloaded" });
			await waitForServerReady(page);
			await expect(page.getByRole("button", { name: "自定义", exact: true })).toBeVisible();

			// 1. Open Customize -> Plugins in Chinese
			await page.getByRole("button", { name: "自定义", exact: true }).click();
			await page.getByRole("tab", { name: "插件", exact: true }).click();
			await expect(page.locator(".plugins-market-panel")).toBeVisible();

			for (const scenario of [{ width: 1200, height: 800, theme: "dark" }, { width: 720, height: 620, theme: "light" }]) {
				await page.setViewportSize({ width: scenario.width, height: scenario.height });
				await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, scenario.theme);
				await expect(page.locator(".plugins-page-header").getByRole("button", { name: "添加市场", exact: true })).toBeVisible();
				expect(await page.locator(".plugins-panel").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
				const marketRow = page.locator(".plugins-source-row").first();
				await expect(marketRow.locator("strong")).toHaveText("anthropics/claude-plugins-official");
				await marketRow.locator(".plugins-source-open").hover();
				await page.screenshot({ path: testInfo.outputPath(`markets-home-${scenario.theme}.png`), animations: "disabled" });
			}
			await page.setViewportSize({ width: 1200, height: 800 });
			await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });

			// Add market in Chinese
			await page.getByRole("button", { name: "添加市场", exact: true }).click();
			const addDialog = page.locator(".plugins-add-market-dialog");
			await expect(addDialog).toBeVisible();
			await addDialog.locator("input[placeholder*='github.com']").fill(FIXTURE_MARKET_URL);
			await addDialog.getByRole("button", { name: "添加", exact: true }).click();
			await expect(addDialog).toHaveCount(0);

			// 2. Scenario D: All-Unsupported plugin inspection
			const unsupportedRow = page.locator(".plugins-market-row").filter({ hasText: "fixture-unsupported" });
			await expect(unsupportedRow).toBeVisible();
			await unsupportedRow.locator(".plugins-inspect-action-btn").click();

			const unsupportedDialog = page.locator(".plugins-inspect-dialog");
			await expect(unsupportedDialog).toBeVisible();
			await expect(unsupportedDialog.locator(".plugins-unsupported-banner")).toBeVisible();
			const cannotInstallBtn = unsupportedDialog.locator("button.button-primary");
			await expect(cannotInstallBtn).toBeVisible();
			await expect(cannotInstallBtn).toBeDisabled();
			await expect(cannotInstallBtn).toHaveText("不可安装");

			// Screenshot: Unsupported plugin dialog in dark theme
			const evidenceDir = path.resolve(process.cwd(), "../../docs/plans/plugin-marketplaces-evidence");
			await mkdir(evidenceDir, { recursive: true }).catch(() => undefined);
			await unsupportedDialog.screenshot({
				animations: "disabled",
				path: path.join(evidenceDir, "plugin-inspect-unsupported-zh-dark.png"),
			});

			await unsupportedDialog.locator(".mcp-dialog-close").click();
			await expect(unsupportedDialog).toHaveCount(0);

			// 3. Scenario D: Partial compatibility plugin inspection & Checkbox Alignment
			const partialRow = page.locator(".plugins-market-row").filter({ hasText: "fixture-partial" });
			await expect(partialRow).toBeVisible();
			await partialRow.locator(".plugins-inspect-action-btn").click();

			const partialDialog = page.locator(".plugins-inspect-dialog");
			await expect(partialDialog).toBeVisible();
			await expect(partialDialog.locator(".plugins-partial-checkbox")).toBeVisible();
			await expect(partialDialog.getByText("partial-echo-server", { exact: false })).toBeVisible();

			// Step 5 of Task 7: Layout bounding box check for checkbox and label
			const label = partialDialog.locator(".plugins-partial-checkbox").first();
			const inputBox = await label.locator('input[type="checkbox"]').boundingBox();
			const textBox = await label.locator("span").boundingBox();
			expect(inputBox).not.toBeNull();
			expect(textBox).not.toBeNull();
			expect(Math.abs(inputBox!.y + inputBox!.height / 2 - textBox!.y - textBox!.height / 2)).toBeLessThan(4);
			expect(textBox!.x).toBeGreaterThan(inputBox!.x + inputBox!.width);

			// Checkbox for partial install
			const partialCheckbox = partialDialog.locator(".plugins-partial-checkbox input[type='checkbox']");
			await expect(partialCheckbox).toBeVisible();
			await expect(partialCheckbox).not.toBeChecked();
			const installBtn = partialDialog.locator("button.button-primary");
			await expect(installBtn).toBeDisabled();
			await partialCheckbox.click();
			await expect(installBtn).toBeEnabled();

			// Unchecking the checkbox disables the button
			await partialCheckbox.click();
			await expect(installBtn).toBeDisabled();

			// Checking the checkbox enables the button back
			await partialCheckbox.click();
			await expect(installBtn).toBeEnabled();

			// 4. Test Viewport & Theme Responsiveness on Inspect Dialog
			for (const scenario of [
				{ width: 1200, height: 800, theme: "dark" },
				{ width: 720, height: 620, theme: "light" },
			]) {
				await page.setViewportSize({ width: scenario.width, height: scenario.height });
				await page.evaluate((t) => {
					document.documentElement.dataset.theme = t;
				}, scenario.theme);

				// Verify dialog fits within viewport and has no horizontal overflow
				const dialogBox = (await partialDialog.boundingBox())!;
				expect(dialogBox.width).toBeLessThanOrEqual(scenario.width);
				expect(dialogBox.height).toBeLessThanOrEqual(scenario.height);

				const hasHorizontalScroll = await partialDialog.evaluate((node) => node.scrollWidth > node.clientWidth);
				expect(hasHorizontalScroll).toBe(false);

				await page.screenshot({
					animations: "disabled",
					path: path.join(
						evidenceDir,
						`plugin-inspect-partial-${scenario.width}x${scenario.height}-${scenario.theme}.png`,
					),
				});
			}

			// Install the partial plugin
			await installBtn.click();
			await partialDialog.getByRole("button", { name: "完成", exact: true }).click();
			await expect(partialDialog).toHaveCount(0);

			// 5. Verify Installed Tab & Detail Dialog Screenshots
			await page.getByRole("button", { name: /管理插件/ }).click();
			const installedPartial = page.locator(".plugins-installed-row").filter({ hasText: "Fixture Partial Plugin" });
			await expect(installedPartial).toBeVisible();

			await installedPartial.locator(".plugins-inspect-action-btn").click();
			const detailDialog = page.locator(".plugins-detail-dialog");
			await expect(detailDialog).toBeVisible();

			for (const scenario of [
				{ width: 1200, height: 800, theme: "dark" },
				{ width: 720, height: 620, theme: "light" },
			]) {
				await page.setViewportSize({ width: scenario.width, height: scenario.height });
				await page.evaluate((t) => {
					document.documentElement.dataset.theme = t;
				}, scenario.theme);
				await page.screenshot({
					animations: "disabled",
					path: path.join(
						evidenceDir,
						`plugin-installed-detail-${scenario.width}x${scenario.height}-${scenario.theme}.png`,
					),
				});
			}
			await detailDialog.locator(".mcp-dialog-close").click();
			await expect(detailDialog).toHaveCount(0);

			// 6. Test Codex Format Plugin Installation (Step 3: Codex local collection with 2 skills)
			if (await page.locator(".plugins-market-back").count()) await page.locator(".plugins-market-back").click();
			await page.locator(".plugins-source-open").filter({ hasText: "fixture/plugins-market" }).click();
			const codexRow = page.locator(".plugins-market-row").filter({ hasText: "fixture-codex" });
			await expect(codexRow).toBeVisible();
			await codexRow.locator(".plugins-inspect-action-btn").click();

			const codexDialog = page.locator(".plugins-inspect-dialog");
			await expect(codexDialog).toBeVisible();
			await expect(codexDialog.locator(".plugins-component-item")).toHaveCount(2);
			await expect(codexDialog.getByText("codex-skill-one", { exact: false })).toBeVisible();
			await expect(codexDialog.getByText("codex-skill-two", { exact: false })).toBeVisible();

			await codexDialog.getByRole("button", { name: "安装", exact: true }).click();
			await codexDialog.getByRole("button", { name: "完成", exact: true }).click();
			await expect(codexDialog).toHaveCount(0);

			// Verify in Skills tab that both Codex skills show owner badge
			await page.getByRole("tab", { name: "技能", exact: true }).click();
			const codexSkill1 = page.locator(".plugins-list-row").filter({ hasText: "codex-skill-one" });
			const codexSkill2 = page.locator(".plugins-list-row").filter({ hasText: "codex-skill-two" });
			await expect(codexSkill1).toBeVisible();
			await expect(codexSkill2).toBeVisible();
			await expect(codexSkill1.locator(".plugins-from-owner-badge")).toContainText("fixture-codex");
			await expect(codexSkill2.locator(".plugins-from-owner-badge")).toContainText("fixture-codex");

			// 7. Test Broken Manifest Plugin (cannot install, shows error)
			await page.getByRole("tab", { name: "插件", exact: true }).click();
			if (await page.locator(".plugins-market-back").count()) await page.locator(".plugins-market-back").click();
			await page.locator(".plugins-source-open").filter({ hasText: "fixture/plugins-market" }).click();
			const brokenRow = page.locator(".plugins-market-row").filter({ hasText: "fixture-broken" });
			await expect(brokenRow).toBeVisible();
			await brokenRow.locator(".plugins-inspect-action-btn").click();

			const brokenDialog = page.locator(".plugins-inspect-dialog");
			await expect(brokenDialog).toBeVisible();
			// Manifest parsing failure: cannot install
			const cannotInstallBroken = brokenDialog.locator("button.button-primary");
			await expect(cannotInstallBroken).toBeVisible();
			await expect(cannotInstallBroken).toBeDisabled();
			await expect(brokenDialog.getByText(/Failed to parse JSON file at/)).toBeVisible();
			await brokenDialog.locator(".mcp-dialog-close").click();
			await expect(brokenDialog).toHaveCount(0);
		} catch (error) {
			const bodyHtml = await page?.innerHTML("body").catch(() => "failed to get body");
			await writeFile(
				"/tmp/debug-plugins-e2e-compat.txt",
				JSON.stringify(
					{
						bodyHtml,
						diagnostics,
						error: String(error),
					},
					null,
					2,
				),
			);
			throw error;
		} finally {
			await browser?.close();
			await stopProcess(app);
			fakeProvider.close();
			await rm(tempRoot, { recursive: true, force: true });
		}
	});

	test("Scenario F: Credential lifecycle & HTTP MCP token configuration", async ({}, testInfo) => {
		const executable = packagedExecutable();
		expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);
		expect(fixtureServer, "Fixture server must be running").toBeDefined();

		const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-plugin-e2e-cred-"));
		const agentDir = path.join(tempRoot, "agent");
		const homeDir = path.join(tempRoot, "home");
		const projectDir = path.join(tempRoot, "project");
		const userDataDir = path.join(tempRoot, "electron");
		await Promise.all([mkdir(agentDir), mkdir(homeDir), mkdir(projectDir), mkdir(userDataDir)]);

		const fakeProvider = createServer(async (request, response) => {
			if (request.method !== "POST") {
				response.writeHead(404).end();
				return;
			}
			const req = await readOpenAiChatRequest(request);
			if (JSON.stringify(req.messages).includes("conversation title generator")) {
				respondWithText(response, "HTTP test");
				return;
			}
			const tools = (req as unknown as { tools?: Array<{ function?: { name: string } }> }).tools ?? [];
			if (req.messages?.some((m) => m.role === "tool" && String(m.content).includes("match:"))) {
				respondWithText(response, "HTTP tool succeeded");
				return;
			}
			const httpTool = tools.find((t) => t.function?.name.includes("fixture_http_tool"));
			if (httpTool) {
				respondWithToolCall(response, {
					callId: `http-${Date.now()}`,
					name: httpTool.function!.name,
					arguments: { message: "test" },
				});
				return;
			}
			if (!req.messages?.some((m) => m.role === "tool") && tools.some((t) => t.function?.name === "tool_search")) {
				respondWithToolCall(response, {
					callId: `search-${Date.now()}`,
					name: "tool_search",
					arguments: { query: "fixture_http_tool" },
				});
				return;
			}
			respondWithText(response, "HTTP tool unavailable");
		});
		const providerPort = await listen(fakeProvider);
		await writeOfflineProviderConfig(agentDir, providerPort, {
			providerId: "mock",
			modelId: "mock-model",
		});

		const diagnostics: string[] = [];
		let debuggingPort = await reservePort();
		let app = launchPackagedDesktop({
			executable,
			debuggingPort,
			userDataDir,
			projectDir,
			agentDir,
			homeDir,
			diagnostics,
			env: {
				HTTPS_PROXY: fixtureServer!.proxyUrl,
				NODE_TLS_REJECT_UNAUTHORIZED: "0",
			},
		});

		let browser: Browser | undefined;
		let page: Page | undefined;

		try {
			({ browser, page } = await connectToApp(debuggingPort));
			page.setDefaultTimeout(20_000);
			await page.setViewportSize({ width: 1200, height: 800 });
			await waitForServerReady(page);

			// 1. Create an active chat session to enable project MCP action controls
			await createAndRestoreChatSession(page, projectDir);
			await waitForServerReady(page);

			// 2. Open Customize -> Plugins -> Add Market
			await page.getByRole("button", { name: "Customize", exact: true }).click();
			await page.getByRole("tab", { name: "Plugins", exact: true }).click();

			await page.getByRole("button", { name: "Add Market", exact: true }).click();
			const addDialog = page.locator(".plugins-add-market-dialog");
			await expect(addDialog).toBeVisible();
			await addDialog.locator("input[placeholder*='github.com']").fill(FIXTURE_MARKET_URL);
			await addDialog.getByRole("button", { name: "Add", exact: true }).click();
			await expect(addDialog).toHaveCount(0);

			// 3. Install fixture-http-token plugin
			const httpRow = page.locator(".plugins-market-row").filter({ hasText: "fixture-http-token" });
			await expect(httpRow).toBeVisible();
			await httpRow.locator(".plugins-inspect-action-btn").click();

			const inspectDialog = page.locator(".plugins-inspect-dialog");
			await expect(inspectDialog).toBeVisible();
			await inspectDialog.getByRole("button", { name: "Install", exact: true }).click();
			await inspectDialog.getByRole("button", { name: "Done", exact: true }).click();
			await expect(inspectDialog).toHaveCount(0);

			// 4. Switch to MCP Tab: click row to open detail page
			await page.getByRole("tab", { name: "MCP", exact: true }).click();
			const mcpRow = page.locator(".plugins-mcp-row").filter({ hasText: "fixture-http-server" });
			await expect(mcpRow).toBeVisible();
			await expect(mcpRow.locator(".plugins-from-owner-badge")).toContainText("Fixture HTTP Token Plugin");

			// Click into detail page
			await mcpRow.click();
			const detailPage = page.locator(".plugins-detail-page[data-plugin-detail='mcp']");
			await expect(detailPage).toBeVisible();

			// Configure Bearer Token via Authentication button
			const authBtn = detailPage.getByRole("button", { name: "Authentication", exact: true });
			await expect(authBtn).toBeVisible();
			await authBtn.click();

			const credDialog = page.locator(".mcp-credential-dialog");
			await expect(credDialog).toBeVisible();

			// Enter bearer token
			const tokenInput = credDialog.locator("input[type='password']").first();
			await tokenInput.fill("fixture-bearer-secret");
			await credDialog.getByRole("button", { name: "Save", exact: true }).click();
			await expect(credDialog).toHaveCount(0);

			const runHttpTool = async (available: boolean) => {
				const before = fixtureServer!.mcpTestServer.toolCallCount();
				const sessionId = await createAndRestoreChatSession(page!, projectDir);
				// Optional MCP startup is asynchronous; authenticate before asking the model to use it.
				await expect
					.poll(
						async () =>
							page!.evaluate(async (id) => {
								const result = await (globalThis as unknown as { metis: MetisDesktopApi }).metis.listMcpServers(
									{ sessionId: id },
								);
								return result.servers.find(
									(server: { originalName?: string }) => server.originalName === "fixture-http-server",
								)?.state;
							}, sessionId),
						{ timeout: 15000 },
					)
					.toBe(available ? "connected" : "auth_required");
				await page!.locator("#composer-input").fill("Run fixture_http_tool");
				await page!.getByRole("button", { name: "Send message", exact: true }).click();
				if (available) {
					await page!.getByRole("button", { name: "Allow once", exact: true }).click();
					await expect(page!.getByText("HTTP tool succeeded", { exact: true })).toBeVisible();
					expect(fixtureServer!.mcpTestServer.toolCallCount()).toBeGreaterThan(before);
				} else {
					await expect(page!.getByText("HTTP tool unavailable", { exact: true })).toBeVisible();
					expect(fixtureServer!.mcpTestServer.toolCallCount()).toBe(before);
				}
			};
			// Successful tools/call proves the fixture's required Authorization header was accepted.
			await runHttpTool(true);
			await browser.close();
			await stopProcess(app);
			debuggingPort = await reservePort();
			app = launchPackagedDesktop({
				executable,
				debuggingPort,
				userDataDir,
				projectDir,
				agentDir,
				homeDir,
				diagnostics,
				env: { HTTPS_PROXY: fixtureServer!.proxyUrl, NODE_TLS_REJECT_UNAUTHORIZED: "0" },
			});
			({ browser, page } = await connectToApp(debuggingPort));
			page.setDefaultTimeout(20_000);
			await waitForServerReady(page);
			// Wait for the previous chat to restore before the helper selects a new session.
			await expect(page.getByText("HTTP tool succeeded", { exact: true })).toBeVisible();
			await runHttpTool(true);
			await page.getByRole("button", { name: "Customize", exact: true }).click();
			await page.getByRole("tab", { name: "MCP", exact: true }).click();
			await page.locator(".plugins-mcp-row").filter({ hasText: "fixture-http-server" }).click();

			// Verify Clear authentication button appears
			const restoredDetailPage = page.locator(".plugins-detail-page[data-plugin-detail='mcp']");
			const clearBtn = restoredDetailPage.getByRole("button", { name: "Clear authentication", exact: true });
			await expect(clearBtn).toBeVisible();

			// Clear authentication to verify clean removal
			await clearBtn.click();
			await expect(clearBtn).toHaveCount(0);

			// Click back to MCP list
			await restoredDetailPage.getByRole("button", { name: "Back to MCP", exact: true }).click();
			await runHttpTool(false);
		} catch (error) {
			const bodyHtml = await page?.innerHTML("body").catch(() => "failed to get body");
			await writeFile(
				"/tmp/debug-plugins-e2e-cred.txt",
				JSON.stringify(
					{
						bodyHtml,
						diagnostics,
						error: String(error),
					},
					null,
					2,
				),
			);
			throw error;
		} finally {
			await browser?.close();
			await stopProcess(app);
			fakeProvider.close();
			await rm(tempRoot, { recursive: true, force: true });
		}
	});
});
