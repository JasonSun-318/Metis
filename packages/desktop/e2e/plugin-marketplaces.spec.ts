import { type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
	createPluginFixtureServer,
	FIXTURE_MARKET_REPO,
	FIXTURE_MARKET_URL,
	type PluginFixtureServer,
} from "./fixtures/plugin-market-fixture.ts";
import {
	connectToApp,
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

	test("Scenario A, B & E: Full marketplace discovery, inspection, installation, runtime execution, toggle, restart and uninstall", async ({}, testInfo) => {
		const executable = packagedExecutable();
		expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);
		expect(fixtureServer, "Fixture server must be running").toBeDefined();

		const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-plugin-e2e-suite-"));
		const agentDir = path.join(tempRoot, "agent");
		const homeDir = path.join(tempRoot, "home");
		const projectDir = path.join(tempRoot, "project");
		const userDataDir = path.join(tempRoot, "electron");
		await Promise.all([mkdir(agentDir), mkdir(homeDir), mkdir(projectDir), mkdir(userDataDir)]);

		const agentRequests: OpenAiChatRequest[] = [];
		let toolSearchExecuted = false;
		let toolCallExecuted = false;

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

			// If tool result was received in messages
			const hasToolResult = req.messages?.some((m) => m.role === "tool" && String(m.content).includes("FIXTURE_MCP_ECHO_RESULT"));
			if (hasToolResult) {
				respondWithText(response, "MCP tool executed successfully: FIXTURE_MCP_ECHO_RESULT:metis-e2e-payload");
				return;
			}

			// Check if model request has tool definitions for fixture_suite_echo
			const tools = (req as unknown as { tools?: Array<{ function?: { name: string } }> }).tools ?? [];
			const hasSuiteEchoTool = tools.some((t) => t.function?.name?.includes("fixture_suite_echo"));
			const hasToolSearch = tools.some((t) => t.function?.name === "tool_search");

			if (hasSuiteEchoTool && !toolCallExecuted) {
				toolCallExecuted = true;
				const toolDef = tools.find((t) => t.function?.name?.includes("fixture_suite_echo"))!;
				respondWithToolCall(response, {
					callId: "call-suite-echo-1",
					name: toolDef.function!.name,
					arguments: { message: "metis-e2e-payload" },
				});
				return;
			}

			if (hasToolSearch && !toolSearchExecuted && !toolCallExecuted) {
				toolSearchExecuted = true;
				respondWithToolCall(response, {
					callId: "call-search-1",
					name: "tool_search",
					arguments: { query: "fixture_suite_echo" },
				});
				return;
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
			await page.getByRole("tab", { name: "Plugins", exact: true }).click();
			await expect(page.locator(".plugins-market-panel")).toBeVisible();

			// 2. Add Fixture GitHub Market
			await page.getByRole("button", { name: "Add Market", exact: true }).click();
			const addMarketDialog = page.locator(".plugins-add-market-dialog");
			await expect(addMarketDialog).toBeVisible();
			await addMarketDialog.locator("input[placeholder*='github.com']").fill(FIXTURE_MARKET_URL);
			await addMarketDialog.getByRole("button", { name: "Add", exact: true }).click();
			await expect(addMarketDialog).toHaveCount(0);

			// 3. Verify market loaded and shows fixture plugins
			const suiteRow = page.locator(".plugins-market-row").filter({ hasText: "fixture-suite" });
			await expect(suiteRow).toBeVisible();
			await expect(page.locator(".plugins-market-row").filter({ hasText: "fixture-partial" })).toBeVisible();
			await expect(page.locator(".plugins-market-row").filter({ hasText: "fixture-unsupported" })).toBeVisible();

			// 4. Inspect Fixture Suite Plugin
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
			await page.locator(".plugins-sub-tab").filter({ hasText: "Installed" }).click();
			const installedRow = page.locator(".plugins-installed-row").filter({ hasText: "Fixture Suite Plugin" });
			await expect(installedRow).toBeVisible();
			await expect(installedRow.locator(".badge-enabled")).toBeVisible();

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

			// 8. Runtime Execution in Same Chat Session (Scenario A & E)
			await page.getByRole("button", { name: "New task", exact: true }).click();
			const input = page.locator("#composer-input");
			await expect(input).toBeVisible();
			await input.fill("Please run fixture suite echo with metis-e2e-payload");
			await page.getByRole("button", { name: "Send message", exact: true }).click();

			// Handle permission approval dialog for the MCP tool
			const allowOnceBtn = page.getByRole("button", { name: "Allow once", exact: true });
			await expect(allowOnceBtn).toBeVisible({ timeout: 20_000 });
			await allowOnceBtn.click();

			// Verify Assistant response showing successful MCP tool execution
			await expect(page.getByText("FIXTURE_MCP_ECHO_RESULT:metis-e2e-payload")).toBeVisible({
				timeout: 25_000,
			});

			// Verify hook context was injected into the request
			const lastPrimaryReq = agentRequests.find((r) => JSON.stringify(r).includes("FIXTURE_SUITE_HOOK_ACTIVE_CONTEXT"));
			expect(lastPrimaryReq, "Hook context must be present in model request messages").toBeDefined();

			// 9. Scenario B: Disable Plugin & Verify Next Turn
			await page.getByRole("button", { name: "Customize", exact: true }).click();
			await page.getByRole("tab", { name: "Plugins", exact: true }).click();
			await page.locator(".plugins-sub-tab").filter({ hasText: "Installed" }).click();

			const activePluginRow = page.locator(".plugins-installed-row").filter({ hasText: "Fixture Suite Plugin" });
			await activePluginRow.locator(".plugins-toggle-btn").click();
			await expect(activePluginRow.locator(".badge-disabled")).toBeVisible();

			// Send turn 2 and assert plugin capabilities absent
			const reqCountBeforeTurn2 = agentRequests.length;
			await page.getByRole("button", { name: "New task", exact: true }).click();
			await input.fill("Testing second turn after disabling plugin");
			await page.getByRole("button", { name: "Send message", exact: true }).click();

			await expect.poll(() => agentRequests.length).toBeGreaterThan(reqCountBeforeTurn2);
			const turn2Req = agentRequests[agentRequests.length - 1];
			const turn2Transcript = JSON.stringify(turn2Req);
			expect(turn2Transcript.includes("FIXTURE_SUITE_HOOK_ACTIVE_CONTEXT")).toBe(false);
			const turn2Tools = (turn2Req as unknown as { tools?: Array<{ function?: { name: string } }> }).tools ?? [];
			expect(turn2Tools.some((t) => t.function?.name?.includes("fixture_suite_echo"))).toBe(false);

			// 10. Enable plugin back
			await page.getByRole("button", { name: "Customize", exact: true }).click();
			await page.getByRole("tab", { name: "Plugins", exact: true }).click();
			await page.locator(".plugins-sub-tab").filter({ hasText: "Installed" }).click();
			await activePluginRow.locator(".plugins-toggle-btn").click();
			await expect(activePluginRow.locator(".badge-enabled")).toBeVisible();

			// 11. Restart App & Verify Persistence
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
			await page.locator(".plugins-sub-tab").filter({ hasText: "Installed" }).click();

			const persistedPlugin = page.locator(".plugins-installed-row").filter({ hasText: "Fixture Suite Plugin" });
			await expect(persistedPlugin).toBeVisible();
			await expect(persistedPlugin.locator(".badge-enabled")).toBeVisible();

			// 12. Uninstall Plugin via Detail Dialog
			await persistedPlugin.locator(".plugins-inspect-action-btn").click();
			const detailDialog = page.locator(".plugins-detail-dialog");
			await expect(detailDialog).toBeVisible();
			await detailDialog.getByRole("button", { name: "Uninstall", exact: true }).click();

			const confirmDialog = page.locator(".plugins-remove-dialog");
			await expect(confirmDialog).toBeVisible();
			await confirmDialog.getByRole("button", { name: "Uninstall", exact: true }).click();
			await expect(confirmDialog).toHaveCount(0);
			await expect(detailDialog).toHaveCount(0);

			await expect(page.locator(".plugins-installed-row").filter({ hasText: "Fixture Suite Plugin" })).toHaveCount(0);
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

	test("Scenario C, D & Visual Verification: Partial compatibility, unsupported, locales, themes and narrow viewport", async ({}, testInfo) => {
		const executable = packagedExecutable();
		expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);
		expect(fixtureServer, "Fixture server must be running").toBeDefined();

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

			// Switch to Chinese locale
			await page.evaluate(() => { localStorage.setItem("metis.locale.v1", "zh-CN"); });
			await page.reload();
			await waitForServerReady(page);

			// 1. Open Customize -> Plugins in Chinese
			await page.getByRole("button", { name: "自定义", exact: true }).click();
			await page.getByRole("tab", { name: "插件", exact: true }).click();
			await expect(page.locator(".plugins-market-panel")).toBeVisible();

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
			await unsupportedDialog.screenshot({ animations: "disabled", path: path.join(evidenceDir, "plugin-inspect-unsupported-zh-dark.png") });

			await unsupportedDialog.locator(".mcp-dialog-close").click();
			await expect(unsupportedDialog).toHaveCount(0);

			// 3. Scenario D: Partial compatibility plugin inspection
			const partialRow = page.locator(".plugins-market-row").filter({ hasText: "fixture-partial" });
			await expect(partialRow).toBeVisible();
			await partialRow.locator(".plugins-inspect-action-btn").click();

			const partialDialog = page.locator(".plugins-inspect-dialog");
			await expect(partialDialog).toBeVisible();
			await expect(partialDialog.locator(".plugins-partial-checkbox")).toBeVisible();
			await expect(partialDialog.getByText("partial-echo-server", { exact: false })).toBeVisible();

			// Checkbox for partial install
			const partialCheckbox = partialDialog.locator(".plugins-partial-checkbox input[type='checkbox']");
			await expect(partialCheckbox).toBeVisible();
			await expect(partialCheckbox).toBeChecked();
			const installBtn = partialDialog.locator("button.button-primary");
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
				await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, scenario.theme);

				// Verify dialog fits within viewport and has no horizontal overflow
				const dialogBox = (await partialDialog.boundingBox())!;
				expect(dialogBox.width).toBeLessThanOrEqual(scenario.width);
				expect(dialogBox.height).toBeLessThanOrEqual(scenario.height);

				const hasHorizontalScroll = await partialDialog.evaluate((node) => node.scrollWidth > node.clientWidth);
				expect(hasHorizontalScroll).toBe(false);

				await page.screenshot({
					animations: "disabled",
					path: path.join(evidenceDir, `plugin-inspect-partial-${scenario.width}x${scenario.height}-${scenario.theme}.png`),
				});
			}

			// Install the partial plugin
			await installBtn.click();
			await partialDialog.getByRole("button", { name: "完成", exact: true }).click();
			await expect(partialDialog).toHaveCount(0);

			// 5. Verify Installed Tab
			await page.locator(".plugins-sub-tab").filter({ hasText: "已安装" }).click();
			const installedPartial = page.locator(".plugins-installed-row").filter({ hasText: "Fixture Partial Plugin" });
			await expect(installedPartial).toBeVisible();

			// Click into details to capture screenshots of installed detail view
			await installedPartial.locator(".plugins-inspect-action-btn").click();
			const detailDialog = page.locator(".plugins-detail-dialog");
			await expect(detailDialog).toBeVisible();

			for (const scenario of [
				{ width: 1200, height: 800, theme: "dark" },
				{ width: 720, height: 620, theme: "light" },
			]) {
				await page.setViewportSize({ width: scenario.width, height: scenario.height });
				await page.evaluate((t) => { document.documentElement.dataset.theme = t; }, scenario.theme);
				await page.screenshot({
					animations: "disabled",
					path: path.join(evidenceDir, `plugin-installed-detail-${scenario.width}x${scenario.height}-${scenario.theme}.png`),
				});
			}
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
});
