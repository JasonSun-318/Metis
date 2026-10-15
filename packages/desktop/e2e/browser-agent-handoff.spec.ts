import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { expect, test, type TestInfo } from "@playwright/test";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import {
	closeBrowserAgentApp,
	createBrowserAgentEnvironment,
	createBrowserAgentFixture,
	elementId,
	launchBrowserAgentApp,
	observationInput,
	parseToolJson,
	removeBrowserAgentEnvironment,
	sendFixturePrompt,
	type BrowserAgentFixture,
	type RunningBrowserAgentApp,
} from "./browser-agent-fixture.ts";
import { packagedExecutable } from "./packaged-app-harness.ts";

function openedBrowserId(result: string): string {
	const details = parseToolJson(result);
	if (!Array.isArray(details.tabs) || !details.tabs.at(-1)) throw new Error(`Expected a browser tab: ${result}`);
	return String((details.tabs.at(-1) as Record<string, unknown>).browserId);
}

function configureHandoff(
	fixture: BrowserAgentFixture,
	marker: string,
	reason: "login" | "otp" | "passkey" | "device_approval" | "captcha",
): void {
	let browserId = "";
	fixture.setScript(marker, ({ step, lastResult, origin }) => {
		if (step === 0) return { tool: "browser_tabs", arguments: { action: "open" } };
		if (step === 1) {
			browserId = openedBrowserId(lastResult);
			return { tool: "browser_navigate", arguments: { browserId, action: "goto", url: `${origin}/handoff/${reason}` } };
		}
		if (step === 2) return { tool: "browser_handoff", arguments: { browserId, reason } };
		return { text: `done:${marker}` };
	});
}

async function waitForDone(app: RunningBrowserAgentApp, marker: string): Promise<void> {
	await expect(app.page.getByText(`done:${marker}`, { exact: true })).toBeVisible({ timeout: 45_000 });
}

async function fixturePage(app: RunningBrowserAgentApp, url: string) {
	await expect.poll(() => app.browser.contexts().flatMap((context) => context.pages()).some((page) => page.url() === url)).toBe(true);
	const page = app.browser.contexts().flatMap((context) => context.pages()).find((candidate) => candidate.url() === url);
	if (!page) throw new Error(`Embedded fixture page was not exposed: ${url}`);
	return page;
}

async function textFilesUnder(root: string): Promise<string> {
	const entries = await readdir(root, { recursive: true, withFileTypes: true });
	const chunks: string[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		const fullPath = path.join(entry.parentPath, entry.name);
		if (entry.name.endsWith(".log") || entry.name.endsWith(".json") || entry.name.endsWith(".jsonl")) {
			chunks.push(await readFile(fullPath, "utf8").catch(() => ""));
		}
	}
	return chunks.join("\n");
}

async function captureHandoffQa(app: RunningBrowserAgentApp, testInfo: TestInfo): Promise<void> {
	await app.page.screenshot({ animations: "disabled", path: testInfo.outputPath("handoff-dark-1280x840.png") });
	await app.page.getByRole("button", { name: "Metis User", exact: true }).click();
	await app.page.getByRole("menuitem", { name: "Settings", exact: true }).click();
	const settings = app.page.getByRole("dialog", { name: "Settings", exact: true });
	await settings.getByRole("button", { name: "General", exact: true }).click();
	await settings.getByRole("group", { name: "Appearance", exact: true }).getByRole("button", { name: "Light", exact: true }).click();
	await expect(app.page.locator("html")).toHaveAttribute("data-theme", "light");
	await settings.getByRole("button", { name: "Back to app", exact: true }).click();
	await expect(app.page.getByRole("alert", { name: "Your action is needed", exact: true })).toBeVisible();
	await app.page.emulateMedia({ reducedMotion: "reduce" });
	await app.page.screenshot({ animations: "disabled", path: testInfo.outputPath("handoff-light-1280x840.png") });
	const resizer = app.page.getByRole("separator", { name: "Resize tools sidebar", exact: true });
	for (let index = 0; index < 10; index += 1) await resizer.press("ArrowRight");
	await app.page.screenshot({ animations: "disabled", path: testInfo.outputPath("handoff-narrow-1280x840.png") });
	for (let index = 0; index < 10; index += 1) await resizer.press("ArrowLeft");
}

test("packaged login and human verification stay in explicit, secret-free handoff", async ({}, testInfo) => {
	test.setTimeout(150_000);
	expect(existsSync(packagedExecutable()), `Package the desktop app first: ${packagedExecutable()}`).toBe(true);
	const fixture = await createBrowserAgentFixture();
	const environment = await createBrowserAgentEnvironment(fixture.providerPort);
	let app: RunningBrowserAgentApp | undefined;
	const secret = "user-only-secret-7f91";
	try {
		configureHandoff(fixture, "handoff-login", "login");
		configureHandoff(fixture, "handoff-otp", "otp");
		configureHandoff(fixture, "handoff-passkey", "passkey");
		configureHandoff(fixture, "handoff-device", "device_approval");
		configureHandoff(fixture, "handoff-captcha", "captcha");
		app = await launchBrowserAgentApp(environment);

		await sendFixturePrompt(app.page, "handoff-login");
		const handoff = app.page.getByRole("alert", { name: "Your action is needed", exact: true });
		await expect(handoff).toContainText("Sign in on this page, then continue when you are done.");
		await expect(app.page.getByRole("textbox", { name: "Browser address", exact: true })).toBeDisabled();
		await expect.poll(() => app!.page.evaluate(() => document.activeElement?.textContent?.includes("Your action is needed") ?? false)).toBe(true);
		await app.page.keyboard.press("Escape");
		await expect(handoff).toBeVisible();
		await captureHandoffQa(app, testInfo);
		const loginPage = await fixturePage(app, `${fixture.origin}/handoff/login`);
		await loginPage.getByLabel("Password", { exact: true }).fill(secret);
		await loginPage.getByRole("button", { name: "Complete login", exact: true }).click();
		await expect(loginPage.locator("#handoff-status")).toHaveText("Challenge: complete");
		await app.page.getByRole("button", { name: "Done, continue", exact: true }).click();
		await waitForDone(app, "handoff-login");
		const loginResult = fixture.calls.find((call) => call.marker === "handoff-login" && call.name === "browser_handoff")?.result ?? "";
		expect(loginResult).toContain("Challenge: complete");
		expect(loginResult).not.toContain(secret);

		for (const [marker, reason] of [
			["handoff-otp", "otp"],
			["handoff-passkey", "passkey"],
			["handoff-device", "device_approval"],
			["handoff-captcha", "captcha"],
		] as const) {
			await sendFixturePrompt(app.page, marker);
			await expect(app.page.getByRole("alert", { name: "Your action is needed", exact: true })).toBeVisible();
			const challenge = await fixturePage(app, `${fixture.origin}/handoff/${reason}`);
			await challenge.getByRole("button", { name: `Complete ${reason}`, exact: true }).click();
			await app.page.getByRole("button", { name: "Done, continue", exact: true }).click();
			await waitForDone(app, marker);
		}

		expect(fixture.requests.join("\n")).not.toContain(secret);
		expect(environment.diagnostics.join("\n")).not.toContain(secret);
		expect(await textFilesUnder(environment.agentDir)).not.toContain(secret);
		expect(await textFilesUnder(path.join(environment.userDataDir, "logs")).catch(() => "")).not.toContain(secret);
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : String(error)}\ntrace=${JSON.stringify(fixture.calls, null, 2).slice(-16_000)}\n${environment.diagnostics.join("").slice(-12_000)}`);
	} finally {
		if (app) await closeBrowserAgentApp(app);
		await fixture.close();
		await removeBrowserAgentEnvironment(environment);
	}
});

test("packaged confirmation rejects safely, approves once, and Take control enters the same handoff", async ({}, testInfo) => {
	test.setTimeout(120_000);
	const fixture = await createBrowserAgentFixture();
	const environment = await createBrowserAgentEnvironment(fixture.providerPort);
	let app: RunningBrowserAgentApp | undefined;
	const configureDelete = (marker: string) => {
		let browserId = "";
		fixture.setScript(marker, ({ step, lastResult, origin }) => {
			if (step === 0) return { tool: "browser_tabs", arguments: { action: "open" } };
			if (step === 1) {
				browserId = openedBrowserId(lastResult);
				return { tool: "browser_navigate", arguments: { browserId, action: "goto", url: `${origin}/destructive` } };
			}
			if (step === 2) {
				const input = observationInput(lastResult);
				return { tool: "browser_act", arguments: {
					...input,
					observation: undefined,
					intent: "Delete the local fixture record",
					risk: "destructive",
					action: { type: "click", target: { elementId: elementId(input.observation.state, "Delete fixture record") } },
				} };
			}
			return { text: `done:${marker}` };
		});
	};
	try {
		configureDelete("delete-reject");
		configureDelete("delete-allow");
		let takeoverBrowserId = "";
		fixture.setScript("take-control-race", ({ step, lastResult, origin }) => {
			if (step === 0) return { tool: "browser_tabs", arguments: { action: "open" } };
			if (step === 1) {
				takeoverBrowserId = openedBrowserId(lastResult);
				return { tool: "browser_navigate", arguments: { browserId: takeoverBrowserId, action: "goto", url: `${origin}/slow` } };
			}
			return { text: "done:take-control-race" };
		});

		app = await launchBrowserAgentApp(environment);
		await sendFixturePrompt(app.page, "delete-reject");
		const confirmation = app.page.getByRole("dialog", { name: "Allow browser action?", exact: true });
		await expect(confirmation).toContainText(`Site: ${fixture.origin}`);
		await expect(confirmation).toContainText("Risk: destructive");
		await expect(confirmation).toContainText("Intent: Delete the local fixture record");
		await expect(confirmation).toContainText("Target: Delete fixture record");
		await confirmation.getByRole("button", { name: "Reject", exact: true }).click();
		await waitForDone(app, "delete-reject");
		expect(fixture.deleteCount()).toBe(0);

		await sendFixturePrompt(app.page, "delete-allow");
		const approval = app.page.getByRole("dialog", { name: "Allow browser action?", exact: true });
		await approval.getByRole("button", { name: "Allow once", exact: true }).click();
		await waitForDone(app, "delete-allow");
		expect(fixture.deleteCount()).toBe(1);
		await expect.poll(() => fixture.deleteCount()).toBe(1);

		const showTools = app.page.getByRole("button", { name: "Show tools sidebar", exact: true });
		if (await showTools.isVisible()) await showTools.click();
		await expect(app.page.getByRole("button", { name: "Hide tools sidebar", exact: true })).toBeVisible();
		await app.page.evaluate(() => {
			const state = window as typeof window & { __browserHandoffRequests?: number };
			state.__browserHandoffRequests = 0;
			(globalThis as unknown as { metis: MetisDesktopApi }).metis.subscribeBrowser((event) => {
				if (event.type === "handoff" && event.status === "requested") state.__browserHandoffRequests! += 1;
			});
		});
		await sendFixturePrompt(app.page, "take-control-race");
		// Agent-created tabs stay in the background; select the controlled tab explicitly.
		await app.page.getByRole("tab", { name: "New tab", exact: true }).click();
		const activity = app.page.getByRole("status", { name: "Browser automation active", exact: true });
		await expect(activity).toContainText("Metis is controlling this page");
		await app.page.screenshot({ animations: "disabled", path: testInfo.outputPath("agent-activity-dark-1280x840.png") });
		const takeControl = activity.getByRole("button", { name: "Take control", exact: true });
		await takeControl.click();
		await expect(app.page.getByRole("alert")).toBeVisible();
		await expect.poll(() => app!.page.evaluate(() => (window as typeof window & { __browserHandoffRequests?: number }).__browserHandoffRequests)).toBe(1);
		await app.page.getByRole("button", { name: "Cancel", exact: true }).click();
		await waitForDone(app, "take-control-race");
		const takeoverResult = fixture.calls.find((call) => call.marker === "take-control-race" && call.name === "browser_navigate")?.result ?? "";
		expect(takeoverResult).toContain("user_cancelled");
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : String(error)}\ntrace=${JSON.stringify(fixture.calls, null, 2).slice(-16_000)}\n${environment.diagnostics.join("").slice(-12_000)}`);
	} finally {
		if (app) await closeBrowserAgentApp(app);
		await fixture.close();
		await removeBrowserAgentEnvironment(environment);
	}
});
