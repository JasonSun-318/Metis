import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import {
	closeBrowserAgentApp,
	createBrowserAgentEnvironment,
	createBrowserAgentFixture,
	launchBrowserAgentApp,
	parseToolJson,
	removeBrowserAgentEnvironment,
	sendFixturePrompt,
	type BrowserAgentFixture,
	type RunningBrowserAgentApp,
} from "./browser-agent-fixture.ts";
import { appServerPid, packagedExecutable, waitForServerReady } from "./packaged-app-harness.ts";

function openedBrowserId(result: string): string {
	const details = parseToolJson(result);
	if (!Array.isArray(details.tabs) || !details.tabs.at(-1)) throw new Error(`Expected a browser tab: ${result}`);
	return String((details.tabs.at(-1) as Record<string, unknown>).browserId);
}

function configurePendingHandoff(
	fixture: BrowserAgentFixture,
	marker: string,
	reason: "login" | "otp" | "passkey" | "captcha",
	onBrowserId?: (browserId: string) => void,
): void {
	let browserId = "";
	fixture.setScript(marker, ({ step, lastResult, origin }) => {
		if (step === 0) return { tool: "browser_tabs", arguments: { action: "open" } };
		if (step === 1) {
			browserId = openedBrowserId(lastResult);
			onBrowserId?.(browserId);
			return { tool: "browser_navigate", arguments: { browserId, action: "goto", url: `${origin}/handoff/${reason}` } };
		}
		if (step === 2) return { tool: "browser_handoff", arguments: { browserId, reason } };
		return { text: `done:${marker}` };
	});
}

async function waitForDone(app: RunningBrowserAgentApp, marker: string): Promise<void> {
	await expect(app.page.getByText(`done:${marker}`, { exact: true })).toBeVisible({ timeout: 45_000 });
}

test("packaged browser control releases every pending state across cancel, close, interrupt, reload, restart, and crash", async () => {
	test.setTimeout(180_000);
	expect(existsSync(packagedExecutable()), `Package the desktop app first: ${packagedExecutable()}`).toBe(true);
	const fixture = await createBrowserAgentFixture();
	const environment = await createBrowserAgentEnvironment(fixture.providerPort);
	let app: RunningBrowserAgentApp | undefined;
	let closeBrowserId = "";
	let crashBrowserId = "";
	try {
		configurePendingHandoff(fixture, "cancel-handoff", "login");
		configurePendingHandoff(fixture, "close-handoff", "passkey", (browserId) => { closeBrowserId = browserId; });
		configurePendingHandoff(fixture, "interrupt-handoff", "otp");
		configurePendingHandoff(fixture, "reload-handoff", "captcha");
		configurePendingHandoff(fixture, "restart-handoff", "login");
		fixture.setScript("crash-tab", ({ step, lastResult, origin }) => {
			if (step === 0) return { tool: "browser_tabs", arguments: { action: "open" } };
			if (step === 1) {
				crashBrowserId = openedBrowserId(lastResult);
				return { tool: "browser_navigate", arguments: { browserId: crashBrowserId, action: "goto", url: `${origin}/controls` } };
			}
			return { text: "done:crash-tab" };
		});
		fixture.setScript("recover-tab", ({ step, lastResult, origin }) => {
			if (step === 0) return { tool: "browser_tabs", arguments: { action: "open" } };
			if (step === 1) return { tool: "browser_navigate", arguments: { browserId: openedBrowserId(lastResult), action: "goto", url: `${origin}/controls` } };
			return { text: "done:recover-tab" };
		});

		app = await launchBrowserAgentApp(environment);

		await sendFixturePrompt(app.page, "cancel-handoff");
		await expect(app.page.getByRole("alert")).toBeVisible();
		await app.page.getByRole("button", { name: "Cancel", exact: true }).click();
		await waitForDone(app, "cancel-handoff");
		expect(fixture.calls.find((call) => call.marker === "cancel-handoff" && call.name === "browser_handoff")?.result).toContain("user_cancelled");

		await sendFixturePrompt(app.page, "close-handoff");
		await expect(app.page.getByRole("alert")).toBeVisible();
		await app.page.evaluate(async ({ sessionId, browserId }) => {
			await (globalThis as unknown as { metis: MetisDesktopApi }).metis.closeBrowser({ sessionId, browserId });
		}, { sessionId: app.sessionId, browserId: closeBrowserId });
		await waitForDone(app, "close-handoff");
		expect(fixture.calls.find((call) => call.marker === "close-handoff" && call.name === "browser_handoff")?.result).toContain("tab_closed");

		await sendFixturePrompt(app.page, "interrupt-handoff");
		await expect(app.page.getByRole("alert")).toBeVisible();
		await app.page.evaluate(async (sessionId) => {
			await (globalThis as unknown as { metis: MetisDesktopApi }).metis.interruptTurn({ sessionId, requestId: crypto.randomUUID() });
		}, app.sessionId);
		await expect(app.page.getByRole("alert")).toHaveCount(0);
		await expect(app.page.locator("#composer-input")).toHaveAttribute("contenteditable", "true");

		await sendFixturePrompt(app.page, "reload-handoff");
		await expect(app.page.getByRole("alert")).toBeVisible();
		await app.page.reload({ waitUntil: "domcontentloaded" });
		await waitForServerReady(app.page);
		await expect(app.page.getByRole("alert")).toHaveCount(0);
		await expect(app.page.locator("#composer-input")).toHaveAttribute("contenteditable", "true");
		await expect.poll(() => fixture.calls.find((call) => call.marker === "reload-handoff" && call.name === "browser_handoff")?.result).toContain("tab_closed");

		await sendFixturePrompt(app.page, "restart-handoff");
		await expect(app.page.getByRole("alert")).toBeVisible();
		const rootPid = app.app.pid;
		if (!rootPid) throw new Error("Packaged browser fixture did not expose its process id");
		const previousServerPid = appServerPid(rootPid);
		if (!previousServerPid) throw new Error("Packaged browser fixture did not expose App Server");
		process.kill(previousServerPid, "SIGKILL");
		await expect.poll(() => {
			const current = appServerPid(rootPid);
			return current !== undefined && current !== previousServerPid;
		}, { timeout: 30_000 }).toBe(true);
		await waitForServerReady(app.page);
		await expect(app.page.getByRole("alert")).toHaveCount(0);
		await expect(app.page.locator("#composer-input")).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });

		await sendFixturePrompt(app.page, "crash-tab");
		await waitForDone(app, "crash-tab");
		const crashPage = app.browser.contexts().flatMap((context) => context.pages()).find((page) => page.url() === `${fixture.origin}/controls`);
		if (!crashPage) throw new Error("Crash fixture target was not exposed");
		const session = await crashPage.context().newCDPSession(crashPage);
		// The target may die before Chromium replies to Page.crash, so completion is
		// the BrowserManager closing the page, not this intentionally orphaned reply.
		void session.send("Page.crash").catch(() => undefined);
		await expect.poll(() => crashPage.isClosed()).toBe(true);
		await sendFixturePrompt(app.page, "recover-tab");
		await waitForDone(app, "recover-tab");
		await expect.poll(() => app!.browser.contexts().flatMap((context) => context.pages()).some((page) => page.url() === `${fixture.origin}/controls`)).toBe(true);
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n${environment.diagnostics.join("").slice(-12_000)}`);
	} finally {
		if (app) await closeBrowserAgentApp(app);
		await fixture.close();
		await removeBrowserAgentEnvironment(environment);
	}
});
