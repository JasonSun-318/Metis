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

			// 2. Open New Hook Dialog and create a UserPromptSubmit blocking hook
			await page.getByRole("button", { name: "New Hook", exact: true }).click();
			await expect(page.getByRole("heading", { name: "New Hook" })).toBeVisible();

			await page.getByLabel("Hook name", { exact: true }).fill("e2e-block-hook");

			// Select Event: UserPromptSubmit
			await page.locator(".hook-menu-select button[aria-label='Event']").click();
			await page.getByRole("option", { name: /UserPromptSubmit/ }).click();

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
			await page.screenshot({ path: screenshotPath });
			const evidencePath = path.resolve(process.cwd(), "../../docs/plans/hook-acceptance-round-2-evidence/desktop-hook-blocked.png");
			if (existsSync(path.dirname(evidencePath))) {
				await page.screenshot({ path: evidencePath });
			}
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
