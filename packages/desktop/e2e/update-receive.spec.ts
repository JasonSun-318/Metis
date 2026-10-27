import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import {
	connectToApp,
	launchPackagedDesktop,
	packagedExecutable,
	reservePort,
	stopProcess,
	waitForServerReady,
} from "./packaged-app-harness.ts";

const executable = process.env.METIS_UPDATE_E2E_APP ?? (existsSync(packagedExecutable()) ? packagedExecutable() : undefined);

function isOlderThanCurrent(appPath?: string): boolean {
	if (!appPath) return false;
	if (process.platform === "darwin") {
		const infoPlist = path.resolve(appPath, "../../Info.plist");
		if (existsSync(infoPlist)) {
			const res = spawnSync("/usr/bin/plutil", ["-extract", "CFBundleShortVersionString", "raw", infoPlist], { encoding: "utf8" });
			if (res.status === 0) {
				const ver = res.stdout.trim();
				return ver !== "" && ver < "0.0.5";
			}
		}
	}
	return false;
}

const olderExecutable = process.env.METIS_UPDATE_OLDER_APP ?? (isOlderThanCurrent(executable) ? executable : undefined);

test("packaged older build announces a published update", async ({}, testInfo) => {
	test.skip(!olderExecutable, "Set METIS_UPDATE_OLDER_APP to an older packaged Metis executable (e.g. 0.0.4)");
	test.setTimeout(90_000);
	expect(existsSync(olderExecutable!), `Missing packaged executable: ${olderExecutable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-update-e2e-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "project");
	const userDataDir = path.join(tempRoot, "electron");
	await Promise.all([mkdir(agentDir), mkdir(homeDir), mkdir(projectDir), mkdir(userDataDir)]);

	const debuggingPort = await reservePort();
	const diagnostics: string[] = [];
	const app = launchPackagedDesktop({
		agentDir,
		debuggingPort,
		diagnostics,
		executable: olderExecutable!,
		homeDir,
		projectDir,
		userDataDir,
	});

	let browser: Browser | undefined;
	let page: Page | undefined;
	try {
		({ browser, page } = await connectToApp(debuggingPort));
		page.setDefaultTimeout(15_000);
		await waitForServerReady(page);

		await expect
			.poll(
				() =>
					page!.evaluate(async () => {
						const api = (globalThis as unknown as { metis: MetisDesktopApi }).metis;
						return api.getUpdateState();
					}),
				{ timeout: 20_000 },
			)
			.toEqual({ status: "available", version: "0.0.5" });

		const updateButton = page.getByRole("button", { name: /更新新版本|Update to new version/u });
		await expect(updateButton).toBeVisible();
	} catch (error) {
		const logPath = path.join(homeDir, "Library", "Logs", "Metis", "app-server.log");
		const log = existsSync(logPath) ? await readFile(logPath, "utf8") : "";
		await testInfo.attach("diagnostics", { body: diagnostics.join(""), contentType: "text/plain" });
		if (log) await testInfo.attach("app-server.log", { body: log, contentType: "text/plain" });
		throw error;
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
	}
});

test("packaged build executes manual update check through real IPC", async ({}, testInfo) => {
	test.skip(!executable, "Set METIS_UPDATE_E2E_APP to a packaged Metis executable or run npm run package first");
	test.setTimeout(90_000);
	expect(existsSync(executable!), `Missing packaged executable: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-update-check-e2e-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "project");
	const userDataDir = path.join(tempRoot, "electron");
	await Promise.all([mkdir(agentDir), mkdir(homeDir), mkdir(projectDir), mkdir(userDataDir)]);

	const debuggingPort = await reservePort();
	const diagnostics: string[] = [];
	const app = launchPackagedDesktop({
		agentDir,
		debuggingPort,
		diagnostics,
		executable: executable!,
		homeDir,
		projectDir,
		userDataDir,
	});

	let browser: Browser | undefined;
	let page: Page | undefined;
	try {
		({ browser, page } = await connectToApp(debuggingPort));
		page.setDefaultTimeout(20_000);
		await waitForServerReady(page);

		// 1. Verify preload exposes checkForUpdate function
		const hasCheckForUpdate = await page.evaluate(() => {
			const api = (globalThis as unknown as { metis: MetisDesktopApi }).metis;
			return typeof api?.checkForUpdate === "function";
		});
		expect(hasCheckForUpdate).toBe(true);

		// 2. Open the unified account menu and check for updates from its row.
		const accountTrigger = page.locator(".account-menu-trigger");
		await accountTrigger.click();
		const checkButton = page.locator(".account-update-check");
		await expect(checkButton).toHaveAttribute("role", "menuitem");
		await expect(checkButton).toHaveAttribute("aria-label", /^(获取更新|Get updates)$/u);
		await expect(checkButton).toBeVisible({ timeout: 15_000 });
		await expect(checkButton).toBeEnabled();

		// Observe the complete busy transition, including checks faster than polling.
		await checkButton.evaluate((button) => {
			const observer = new MutationObserver((records) => {
				if (records.some((record) => record.oldValue === "true") || button.getAttribute("aria-busy") === "true") {
					button.dataset.observedBusy = "true";
				}
				if (button.dataset.observedBusy === "true" && button.getAttribute("aria-busy") === "false") {
					observer.disconnect();
				}
			});
			observer.observe(button, { attributes: true, attributeFilter: ["aria-busy"], attributeOldValue: true });
		});
		await checkButton.click();
		await expect(checkButton).toHaveAttribute("data-observed-busy", "true");
		await expect(checkButton).toHaveAttribute("aria-busy", "false", { timeout: 20_000 });

		// 5. Query and record the real IPC result from main updater
		const updateState = await page.evaluate(async () => {
			const api = (globalThis as unknown as { metis: MetisDesktopApi }).metis;
			return api.getUpdateState();
		});

		console.log("[E2E] Packaged manual update check result:", JSON.stringify(updateState));
		await testInfo.attach("manual-update-result", {
			body: JSON.stringify(updateState, null, 2),
			contentType: "application/json",
		});

		// Production acceptance requires a successful remote check. Failure and
		// unsupported-build feedback are covered separately in chat-shell tests.
		expect(["available", "unavailable"]).toContain(updateState.status);
		const toast = page.locator(".system-notice");
		await expect(page.locator(".sidebar-update-notice, .sidebar-update-button")).toHaveCount(0);
		if (updateState.status === "available") {
			if ((await accountTrigger.getAttribute("aria-expanded")) !== "true") await accountTrigger.click();
			await expect(checkButton).toBeVisible();
			await expect(checkButton).toContainText(updateState.version);
			await expect(checkButton).toBeEnabled();
			await expect(toast).not.toBeVisible();
		} else {
			await expect(toast).toHaveText(/^(已是最新版本|Metis is up to date)$/u);
		}
		console.log(
			"[E2E] Successful remote check:",
			updateState.status,
			updateState.status === "unavailable" ? await toast.textContent() : updateState.status,
		);
	} catch (error) {
		const logPath = path.join(homeDir, "Library", "Logs", "Metis", "app-server.log");
		const log = existsSync(logPath) ? await readFile(logPath, "utf8") : "";
		await testInfo.attach("diagnostics", { body: diagnostics.join(""), contentType: "text/plain" });
		if (log) await testInfo.attach("app-server.log", { body: log, contentType: "text/plain" });
		throw error;
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
	}
});
