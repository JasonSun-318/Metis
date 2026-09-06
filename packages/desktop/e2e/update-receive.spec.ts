import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import {
	connectToApp,
	launchPackagedDesktop,
	reservePort,
	stopProcess,
	waitForServerReady,
} from "./packaged-app-harness.ts";

const executable = process.env.METIS_UPDATE_E2E_APP;

test("packaged older build announces a published update", async ({}, testInfo) => {
	test.skip(!executable, "Set METIS_UPDATE_E2E_APP to an older packaged Metis executable");
	test.setTimeout(90_000);
	expect(existsSync(executable!), `Missing packaged executable: ${executable}`).toBe(true);

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
		executable: executable!,
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
