import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import {
	connectToApp,
	packagedExecutable,
	reservePort,
	stopProcess,
	waitForServerReady,
} from "./packaged-app-harness.ts";

test("packaged agent types settings CRUD reaches the user registry", async ({}, testInfo) => {
	test.setTimeout(90_000);
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-agent-types-e2e-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "project");
	const userDataDir = path.join(tempRoot, "electron");
	await Promise.all([mkdir(agentDir), mkdir(homeDir), mkdir(projectDir), mkdir(userDataDir)]);

	const debuggingPort = await reservePort();
	const executableArgs = [`--remote-debugging-port=${debuggingPort}`, `--user-data-dir=${userDataDir}`];
	const { spawn } = await import("node:child_process");
	const app = spawn(executable, executableArgs, {
		cwd: projectDir,
		env: {
			...process.env,
			ALL_PROXY: "",
			METIS_CODING_AGENT_DIR: agentDir,
			HOME: homeDir,
			HTTP_PROXY: "",
			HTTPS_PROXY: "",
			NO_PROXY: "127.0.0.1,localhost",
			USERPROFILE: homeDir,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const diagnostics: string[] = [];
	app.stdout?.on("data", (chunk) => diagnostics.push(String(chunk)));
	app.stderr?.on("data", (chunk) => diagnostics.push(String(chunk)));

	let browser: Browser | undefined;
	let page: Page | undefined;
	let phase = "connecting";
	try {
		({ browser, page } = await connectToApp(debuggingPort));
		page.setDefaultTimeout(10_000);
		await page.setViewportSize({ width: 1100, height: 760 });
		await waitForServerReady(page);

		phase = "opening the agent types settings page";
		await page.locator(".account-menu-trigger").click();
		await page.getByRole("menuitem", { name: "Settings", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
		await expect(dialog).toBeVisible();
		await dialog.getByRole("button", { name: "Agent types", exact: true }).click();

		phase = "listing built-in roles read-only";
		const pageBody = dialog.locator(".settings-page-scroll");
		await expect(pageBody.getByText("Built-in agent types", { exact: true })).toBeVisible();
		await expect(pageBody.locator(".agent-types-card[data-builtin=\"true\"]")).toHaveCount(4);
		await expect(pageBody.locator(".agent-types-card[data-builtin=\"true\"]").first()).toContainText("default");
		await expect(pageBody.getByRole("button", { name: "Delete default", exact: true })).toHaveCount(0);
		await expect(pageBody.getByText("No custom agent types yet")).toBeVisible();

		phase = "creating a custom agent type";
		await pageBody.getByRole("button", { name: "New agent type", exact: true }).click();
		await pageBody.getByLabel("Display name", { exact: true }).fill("E2E Auditor");
		await pageBody.getByLabel("Type id", { exact: true }).fill("e2e-auditor");
		await pageBody.getByLabel("Description", { exact: true }).fill("Read-only auditor created by e2e.");
		await pageBody.getByLabel("read", { exact: true }).check();
		await pageBody.getByLabel("System prompt").fill("Cite file paths for every claim.");
		await pageBody.getByRole("button", { name: "Save", exact: true }).click();

		await expect(pageBody.locator(".agent-types-card[data-builtin=\"false\"]")).toHaveCount(1);
		await expect(pageBody.locator(".agent-types-card[data-builtin=\"false\"]").first()).toContainText("E2E Auditor");
		const registryFile = path.join(agentDir, "agent-types.json");
		const registry = JSON.parse(await readFile(registryFile, "utf8")) as {
			version: number;
			types: Array<{ id: string; displayName: string; systemPrompt: string }>;
		};
		expect(registry.version).toBe(1);
		expect(registry.types).toHaveLength(1);
		expect(registry.types[0]).toMatchObject({ id: "e2e-auditor", displayName: "E2E Auditor" });
		expect(registry.types[0]?.systemPrompt).toContain("Cite file paths");

		phase = "editing the custom agent type";
		await pageBody.getByRole("button", { name: "Edit E2E Auditor", exact: true }).click();
		const descriptionInput = pageBody.getByLabel("Description", { exact: true });
		await expect(descriptionInput).toHaveValue("Read-only auditor created by e2e.");
		await descriptionInput.fill("Updated by e2e.");
		await pageBody.getByRole("button", { name: "Save", exact: true }).click();
		await expect(pageBody.locator(".agent-types-card[data-builtin=\"false\"]").first()).toContainText("Updated by e2e.");

		phase = "deleting the custom agent type";
		page.once("dialog", (dialog) => void dialog.accept());
		await pageBody.getByRole("button", { name: "Delete E2E Auditor", exact: true }).click();
		await expect(pageBody.getByText("No custom agent types yet")).toBeVisible();
		const cleared = JSON.parse(await readFile(registryFile, "utf8")) as { types: unknown[] };
		expect(cleared.types).toHaveLength(0);

		await dialog.locator(".settings-page-scroll").evaluate((element) => element.scrollTo(0, 0));
	} catch (error) {
		const bodyText = await page?.locator("body").innerText().catch(() => "renderer unavailable");
		throw new Error(
			`${error instanceof Error ? error.message : String(error)}\nphase=${phase}\nrenderer body:\n${bodyText ?? "unavailable"}\n${diagnostics.join("").slice(-8_000)}`,
		);
	} finally {
		await browser?.close().catch(() => undefined);
		await stopProcess(app);
		await rm(tempRoot, { recursive: true, force: true });
	}
});
