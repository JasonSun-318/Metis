import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import { PermissionProvider } from "./fixtures/permission-provider.ts";
import {
	connectToApp,
	desktopRoot,
	launchPackagedDesktop,
	packagedExecutable,
	reservePort,
	stopProcess,
	waitForServerReady,
} from "./packaged-app-harness.ts";

test.describe.configure({ timeout: 180_000 });

test("packaged sandbox health allows a workspace write and denies a protected-root write", async () => {
	const executable = packagedExecutable();
	expect(existsSync(executable), `Package the desktop app first: ${executable}`).toBe(true);

	const tempRoot = await mkdtemp(path.join(tmpdir(), "metis-permission-perf-"));
	const agentDir = path.join(tempRoot, "agent");
	const homeDir = path.join(tempRoot, "home");
	const projectDir = path.join(tempRoot, "project");
	const userDataDir = path.join(tempRoot, "electron");
	await Promise.all([mkdir(agentDir), mkdir(homeDir), mkdir(projectDir), mkdir(userDataDir)]);
	await writeFile(path.join(projectDir, "README.md"), "ok");
	await mkdir(path.join(projectDir, ".git"));
	await writeFile(path.join(projectDir, ".git", "HEAD"), "ref: refs/heads/main");

	const importEsm = Function("specifier", "return import(specifier)") as (
		specifier: string,
	) => Promise<{ ProjectTrustStore: new (dir: string) => { set(cwd: string, trusted: boolean): void } }>;
	const trust = await importEsm(
		pathToFileURL(path.join(desktopRoot, "../coding-agent/dist/core/trust-manager.js")).href,
	);
	new trust.ProjectTrustStore(agentDir).set(projectDir, true);

	const allowedFile = path.join(projectDir, "allowed.txt");
	const protectedFile = path.join(projectDir, ".git", "HEAD");
	const provider = new PermissionProvider({
		tools: (marker) => {
			if (marker.includes("case-perf-allow")) {
				return { name: "write", arguments: { path: allowedFile, content: "sandbox-ok" } };
			}
			if (marker.includes("case-perf-deny")) {
				return { name: "write", arguments: { path: protectedFile, content: "tamper" } };
			}
			return undefined;
		},
	});
	const providerPort = await provider.listen();
	await provider.writeAgentConfig(agentDir, providerPort);

	const diagnostics: string[] = [];
	let app: ReturnType<typeof launchPackagedDesktop> | undefined;
	let browser: Browser | undefined;
	let page: Page | undefined;
	try {
		const debuggingPort = await reservePort();
		app = launchPackagedDesktop({
			executable,
			debuggingPort,
			userDataDir,
			projectDir,
			agentDir,
			homeDir,
			diagnostics,
		});
		({ browser, page } = await connectToApp(debuggingPort));
		page.setDefaultTimeout(20_000);
		await waitForServerReady(page);
		const sessionId = await page.evaluate(async (cwd) => {
			const api = (globalThis as unknown as { metis: MetisDesktopApi }).metis;
			const result = await api.createSession({
				requestId: crypto.randomUUID(),
				mode: "chat",
				cwd,
				permissionPreset: "auto",
			});
			localStorage.setItem("metis.activeSessionId.chat", result.session.sessionId);
			return result.session.sessionId;
		}, projectDir);
		await page.reload({ waitUntil: "domcontentloaded", timeout: 15_000 });
		await page.locator(`[data-active-session-id="${sessionId}"]`).waitFor({ state: "visible" });

		const health = await page.evaluate(async (id) => {
			const api = (globalThis as unknown as { metis: MetisDesktopApi }).metis;
			return (await api.openSession({ sessionId: id })).sandboxHealth;
		}, sessionId);
		expect(health, `sandbox must be healthy, got ${health}`).toBe("healthy");

		await page.locator("#composer-input").fill("case-perf-allow");
		await page.getByRole("button", { name: "Send message", exact: true }).click();
		await expect(page.getByText("done:case-perf-allow", { exact: true })).toBeVisible({ timeout: 45_000 });
		expect(await readFile(allowedFile, "utf8")).toBe("sandbox-ok");
		await expect(page.locator(".permission-approval-panel")).toHaveCount(0);
		expect(provider.reviewCount).toBe(0);

		await expect(page.locator("#composer-input")).toHaveAttribute("contenteditable", "true");
		await page.locator("#composer-input").fill("case-perf-deny");
		await page.getByRole("button", { name: "Send message", exact: true }).click();
		await expect(page.getByText("done:case-perf-deny", { exact: true })).toBeVisible({ timeout: 45_000 });
		expect(await readFile(protectedFile, "utf8")).toBe("ref: refs/heads/main");
		expect(health).toBe("healthy");
	} finally {
		await browser?.close().catch(() => undefined);
		if (app) await stopProcess(app);
		await provider.close();
		await rm(tempRoot, { recursive: true, force: true });
	}
});
