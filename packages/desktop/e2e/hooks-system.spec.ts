import { type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
	connectToApp,
	launchPackagedDesktop,
	listen,
	packagedExecutable,
	readOpenAiChatRequest,
	reservePort,
	respondWithText,
	stopProcess,
	waitForServerReady,
	writeOfflineProviderConfig,
	type OpenAiChatRequest,
} from "./packaged-app-harness.ts";

test.describe("Desktop Declarative Hooks System", () => {
	test.setTimeout(90_000);

	test("creates hook via UI, verifies persistence in hooks.json, and blocks prompt with notification", async ({}, testInfo) => {
		const executable = packagedExecutable();
		expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

		const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-hooks-e2e-"));
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
				respondWithText(response, "Hook E2E Test Title");
				return;
			}
			agentRequests.push(req);
			respondWithText(response, "hello from fake provider");
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
		});

		let browser: Browser | undefined;
		let page: Page | undefined;

		try {
			({ browser, page } = await connectToApp(debuggingPort));
			page.setDefaultTimeout(15_000);
			await page.setViewportSize({ width: 1200, height: 800 });
			await waitForServerReady(page);

			// 1. Navigate to Customize -> Hooks
			await page.getByRole("button", { name: "Customize", exact: true }).click();
			await page.getByRole("tab", { name: "Hooks", exact: true }).click();
			await expect(page.getByText("No Hooks configured yet.")).toBeVisible();

			// 2. Open New Hook Dialog and create a UserPromptSubmit blocking hook.
			// The header and the empty Hooks section both expose a create action.
			await page.locator("button.plugins-new-btn").click();
			await expect(page.getByRole("heading", { name: "New Hook" })).toBeVisible();
			const dialog = page.getByRole("dialog");
			await expect(page.getByRole("button", { name: "Protocol", exact: true })).toHaveCount(0);
			for (const scenario of [
				{ width: 1200, height: 800, theme: "dark" },
				{ width: 720, height: 620, theme: "light" },
			]) {
				await page.setViewportSize({ width: scenario.width, height: scenario.height });
				await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, scenario.theme);
				for (const label of ["Event", "Run mode", "Protocol"]) {
					if (label === "Protocol") await page.getByRole("button", { name: "Advanced options", exact: true }).click();
					const trigger = page.getByRole("button", { name: label, exact: true });
					await trigger.click();
					const menu = page.getByRole("listbox", { name: label, exact: true });
					await expect(menu).toBeVisible();
					await expect.poll(async () => {
						const triggerBox = (await trigger.boundingBox())!;
						const menuBox = (await menu.boundingBox())!;
						const dialogBox = (await dialog.boundingBox())!;
						return {
							aligned: Math.abs(menuBox.x - triggerBox.x) <= 2,
							matchedWidth: Math.abs(menuBox.width - triggerBox.width) <= 2,
							adjacent: Math.min(Math.abs(menuBox.y - triggerBox.y - triggerBox.height - 6), Math.abs(triggerBox.y - menuBox.y - menuBox.height - 6)) <= 2,
							inside: menuBox.x >= dialogBox.x && menuBox.x + menuBox.width <= dialogBox.x + dialogBox.width + 1 && menuBox.y >= dialogBox.y && menuBox.y + menuBox.height <= dialogBox.y + dialogBox.height + 1,
						};
					}).toEqual({ aligned: true, matchedWidth: true, adjacent: true, inside: true });
					await page.screenshot({ animations: "disabled", path: testInfo.outputPath(`hook-${scenario.theme}-${label.replaceAll(" ", "-")}.png`) });
					await page.keyboard.press("Escape");
					await expect(menu).toHaveCount(0);
					await expect(trigger).toBeFocused();
				}
				await page.getByRole("button", { name: "Advanced options", exact: true }).click();
				await expect(page.getByRole("button", { name: "Create", exact: true })).toBeInViewport({ ratio: 1 });
				await expect.poll(() => dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
			}
			await page.setViewportSize({ width: 1200, height: 800 });
			await page.evaluate(() => { document.documentElement.dataset.theme = "dark"; });

			await page.getByLabel("Hook name", { exact: true }).fill("e2e-block-hook");

			// Select Event: UserPromptSubmit
			await page.locator(".hook-menu-select button[aria-label='Event']").click();
			await page.keyboard.press("Home");
			await page.keyboard.press("ArrowDown");
			await page.keyboard.press("Enter");
			await expect(page.locator(".hook-menu-select button[aria-label='Event']")).toHaveText("User prompt submit");
			await expect(page.getByPlaceholder("bash|read|write")).toHaveCount(0);

			// Fill command to execute node and emit block decision
			await page.getByLabel("Command", { exact: true }).fill(process.execPath);
			const argsInput = page.getByLabel("Arguments (one per line)", { exact: true });
			await argsInput.fill(
				"-e\nprocess.stdout.write(JSON.stringify({decision:'block',reason:'Blocked by E2E lifecycle hook'})); process.exit(0);",
			);

			// Save hook
			await page.getByRole("button", { name: "Create", exact: true }).click();

			// 3. Verify hook card appears in the list
			const hookCard = page.locator(".plugins-hook-row");
			await expect(hookCard).toHaveCount(1);
			await expect(hookCard).toContainText("e2e-block-hook");
			await expect(hookCard).toContainText("User prompt submit");

			// 4. Verify canonical persistence on disk in hooks.json
			const hooksFile = path.join(agentDir, "hooks.json");
			expect(existsSync(hooksFile)).toBe(true);
			const onDisk = JSON.parse(await readFile(hooksFile, "utf8")) as {
				hooks: Array<{ id: string; name: string; event: string; command: string }>;
			};
			expect(onDisk.hooks).toHaveLength(1);
			expect(onDisk.hooks[0].name).toBe("e2e-block-hook");
			expect(onDisk.hooks[0].event).toBe("UserPromptSubmit");

			// 5. Navigate to New task and submit a prompt to verify blocking hook execution
			await page.getByRole("button", { name: "New task", exact: true }).click();
			const input = page.locator("#composer-input");
			await expect(input).toBeVisible();
			await input.fill("Hello prompt to be blocked by hook");
			await page.getByRole("button", { name: "Send message", exact: true }).click();

			// 6. Verify toast notification / alert with the block reason
			const toast = page.locator(".toast, [role='alert'], [role='status']").filter({
				hasText: "Blocked by E2E lifecycle hook",
			});
			await expect(toast.first()).toBeVisible({ timeout: 15_000 });

			// 7. Verify the prompt was blocked BEFORE reaching the model provider
			expect(agentRequests).toHaveLength(0);

			// Capture screenshot as evidence
			const screenshotPath = testInfo.outputPath("desktop-hook-blocked.png");
			await page.screenshot({ animations: "disabled", path: screenshotPath });
			const evidencePath = path.resolve(process.cwd(), "../../docs/plans/hook-acceptance-round-2-evidence/desktop-hook-blocked.png");
			if (existsSync(path.dirname(evidencePath))) {
				await page.screenshot({ animations: "disabled", path: evidencePath });
			}

			// Check the localized form used by the reported screenshot as well.
			await page.evaluate(() => { localStorage.setItem("metis.locale.v1", "zh-CN"); });
			await page.reload();
			await waitForServerReady(page);
			await page.getByRole("button", { name: "自定义", exact: true }).click();
			await page.getByRole("tab", { name: "钩子", exact: true }).click();
			await page.locator("button.plugins-new-btn").click();
			await expect(page.getByText("何时触发", { exact: true })).toBeVisible();
			await expect(page.getByText("执行什么", { exact: true })).toBeVisible();
			await page.screenshot({ animations: "disabled", path: testInfo.outputPath("hook-zh-form.png") });
			const scrollBeforeMenu = await page.locator(".hook-editor-body").evaluate((node) => node.scrollTop);
			await page.getByRole("button", { name: "事件", exact: true }).click();
			expect(await page.locator(".hook-editor-body").evaluate((node) => node.scrollTop)).toBe(scrollBeforeMenu);
			await expect(page.getByRole("listbox", { name: "事件", exact: true })).toBeVisible();
			await page.screenshot({ animations: "disabled", path: testInfo.outputPath("hook-zh-event.png") });
		} catch (error) {
			const bodyHtml = await page?.innerHTML("body").catch(() => "failed to get body");
			await writeFile("/tmp/debug-hooks-e2e.txt", JSON.stringify({
				bodyHtml,
				diagnostics,
				hooksFileExists: existsSync(path.join(agentDir, "hooks.json")),
				error: String(error),
			}, null, 2));
			throw error;
		} finally {
			await browser?.close();
			await stopProcess(app);
			fakeProvider.close();
			await rm(tempRoot, { recursive: true, force: true });
		}
	});
});
