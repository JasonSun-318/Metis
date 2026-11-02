import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
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

function tabs(result: string) {
	const value = parseToolJson(result);
	if (!Array.isArray(value.tabs)) throw new Error(`Expected browser tabs: ${result}`);
	return value.tabs as Array<Record<string, unknown>>;
}

function profileBrowser(result: string, profileId: string): string {
	const tab = tabs(result).find((candidate) => candidate.profileId === profileId);
	if (!tab) throw new Error(`Profile ${profileId} had no browser tab: ${result}`);
	return String(tab.browserId);
}

function p95(values: readonly number[]): number {
	if (values.length === 0) throw new Error("No browser-tool durations were captured");
	const ordered = [...values].sort((left, right) => left - right);
	return ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)]!;
}

const PERFORMANCE_WARMUPS = 5;
const PERFORMANCE_OBSERVATIONS = 35;
const PERFORMANCE_ACTIONS = 100;

interface BrowserProgressMeasurement {
	readonly startedAt: number;
	count: number;
	lastTitle: string;
}

async function waitForDone(app: RunningBrowserAgentApp, marker: string): Promise<void> {
	await expect(app.page.getByText(`done:${marker}`, { exact: true })).toBeVisible({ timeout: 60_000 });
}

test("visible browser keeps its viewport stable, actually navigates links, and marks stale clicks as errors", async ({}, testInfo) => {
	test.setTimeout(90_000);
	const fixture = await createBrowserAgentFixture();
	const environment = await createBrowserAgentEnvironment(fixture.providerPort);
	let app: RunningBrowserAgentApp | undefined;
	let browserId = "";
	let oldObservation = "";
	try {
		fixture.setScript("navigation-setup", ({ step, lastResult, origin }) => {
			if (step === 0) return { tool: "browser_tabs", arguments: { action: "open" } };
			if (step === 1) {
				browserId = String(tabs(lastResult).at(-1)!.browserId);
				return { tool: "browser_navigate", arguments: { browserId, action: "goto", url: `${origin}/navigation` } };
			}
			return { text: "done:navigation-setup" };
		});
		fixture.setScript("stable-viewport", ({ step, lastResult }) => {
			if (step === 0 || step % 2 === 0 && step < 8) return { tool: "browser_observe", arguments: { browserId } };
			if (step < 8) {
				const { observation, ...scope } = observationInput(lastResult);
				return { tool: "browser_act", arguments: { ...scope, intent: "Keep fixture viewport stable", risk: "ordinary",
					action: { type: "hover", target: { elementId: elementId(observation.state, "Open destination") } } } };
			}
			return { text: "done:stable-viewport" };
		});
		for (const [marker, name, source] of [
			["navigate-visible", "Open destination", "visible"],
			["navigate-below-fold", "Open lower destination", "below-fold"],
		]) {
			fixture.setScript(marker!, ({ step, lastResult, origin }) => {
				if (step === 0) return { tool: "browser_navigate", arguments: { browserId, action: "goto", url: `${origin}/navigation` } };
				if (step === 1) return { tool: "browser_observe", arguments: { browserId } };
				if (step === 2) {
					oldObservation = lastResult;
					const { observation, ...scope } = observationInput(lastResult);
					return { tool: "browser_act", arguments: { ...scope, intent: "Open the fixture destination", risk: "ordinary",
						action: JSON.stringify({ type: "click", target: { elementId: elementId(observation.state, name!) } }) } };
				}
				expect(parseToolJson(lastResult).url).toBe(`${origin}/navigation-done?from=${source}`);
				return { text: `done:${marker}` };
			});
		}
		fixture.setScript("visible-stale", ({ step }) => {
			if (step === 0) {
				const { observation, ...scope } = observationInput(oldObservation);
				return { tool: "browser_act", arguments: { ...scope, intent: "Reject a previous document click", risk: "ordinary",
					action: { type: "click", target: { elementId: elementId(observation.state, "Open destination") } } } };
			}
			return { text: "done:visible-stale" };
		});
		app = await launchBrowserAgentApp(environment);
		await sendFixturePrompt(app.page, "navigation-setup");
		await waitForDone(app, "navigation-setup");
		const showTools = app.page.getByRole("button", { name: "Show tools sidebar", exact: true });
		if (await showTools.isVisible()) await showTools.click();
		await app.page.getByRole("tab", { name: "Metis browser fixture", exact: true }).click();
		const panel = app.page.locator(`#browser-panel-${browserId}`);
		await expect(panel).toBeVisible();
		await expect(panel.getByRole("status", { name: "Browser automation active" })).toHaveCount(0);
		const target = app.browser.contexts().flatMap((context) => context.pages()).find((page) => page.url() === `${fixture.origin}/navigation`);
		if (!target) throw new Error("Visible navigation fixture missing");
		const cdp = await target.context().newCDPSession(target);
		await cdp.send("Page.enable");
		let resizeEvents = 0;
		cdp.on("Page.frameResized", () => { resizeEvents += 1; });
		await app.page.evaluate((id) => {
			const panel = document.getElementById(`browser-panel-${id}`)!;
			const anchor = panel.querySelector(".browser-view-anchor")!;
			const state = window as typeof window & { __navigationGeometry: Array<{ active: boolean; bounds: number[] }> };
			state.__navigationGeometry = [];
			const sample = () => {
				const rect = anchor.getBoundingClientRect();
				// BrowserPanel.tsx renders the active bar as <output>, which carries the
				// implicit status role without an explicit role attribute, so match the
				// element instead of a [role=status] CSS selector.
				state.__navigationGeometry.push({ active: Boolean(panel.querySelector("output.browser-automation-bar")), bounds: [rect.x, rect.y, rect.width, rect.height] });
			};
			sample();
			new MutationObserver(sample).observe(panel, { attributes: true, childList: true, subtree: true });
			new ResizeObserver(sample).observe(anchor);
		}, browserId);
		await sendFixturePrompt(app.page, "stable-viewport");
		await waitForDone(app, "stable-viewport");
		await expect(panel.getByRole("status", { name: "Browser automation active" })).toHaveCount(0);
		const samples = await app.page.evaluate(() => (window as typeof window & { __navigationGeometry: Array<{ active: boolean; bounds: number[] }> }).__navigationGeometry);
		expect(samples.some((sample) => sample.active)).toBe(true);
		expect(samples.every((sample) => JSON.stringify(sample.bounds) === JSON.stringify(samples[0]!.bounds))).toBe(true);
		expect(resizeEvents).toBe(0);
		for (const [marker, source] of [["navigate-visible", "visible"], ["navigate-below-fold", "below-fold"]]) {
			await sendFixturePrompt(app.page, marker!);
			await waitForDone(app, marker!);
			await expect(target).toHaveURL(`${fixture.origin}/navigation-done?from=${source}`);
			await expect(target.getByRole("heading", { name: "Navigation complete" })).toBeVisible();
			await expect(panel.getByRole("textbox", { name: "Browser address" })).toHaveValue(`${fixture.origin}/navigation-done?from=${source}`);
			await app.page.screenshot({ path: testInfo.outputPath(`packaged-navigation-${source}.png`) });
		}
		await sendFixturePrompt(app.page, "visible-stale");
		await waitForDone(app, "visible-stale");
		const staleCall = fixture.calls.find((call) => call.marker === "visible-stale")!;
		expect(staleCall.result).toContain("not executed");
		await expect(target).toHaveURL(`${fixture.origin}/navigation-done?from=below-fold`);
		expect(await app.page.locator(".tool-step-output-error").filter({ hasText: "not executed" }).count()).toBe(1);
		const sessionRoot = path.join(environment.agentDir, "sessions");
		const sessionFiles = (await readdir(sessionRoot, { recursive: true })).filter((file) => file.endsWith(".jsonl"));
		const messages = (await Promise.all(sessionFiles.map((file) => readFile(path.join(sessionRoot, file), "utf8"))))
			.flatMap((text) => text.trim().split("\n").map((line) => JSON.parse(line).message));
		expect(messages.find((message) => message?.role === "toolResult" && message.toolCallId === staleCall.callId)?.isError).toBe(true);
		await app.page.screenshot({ path: testInfo.outputPath("packaged-stale-click-error.png") });
	} finally {
		if (app) await closeBrowserAgentApp(app);
		await fixture.close();
		await removeBrowserAgentEnvironment(environment);
	}
});

test("packaged agent accepts encoded actions and recovers an expired browser ID", async ({}, testInfo) => {
	test.setTimeout(90_000);
	const fixture = await createBrowserAgentFixture();
	const environment = await createBrowserAgentEnvironment(fixture.providerPort);
	let app: RunningBrowserAgentApp | undefined;
	let browserId = "";
	let recoveredId = "";
	let recoveryPhase = "close";
	let messageId = "";
	try {
		fixture.setScript("encoded-control", ({ step, lastResult, origin }) => {
			if (step === 0) return { tool: "browser_tabs", arguments: { action: "open" } };
			if (step === 1) {
				browserId = String(tabs(lastResult).at(-1)!.browserId);
				return { tool: "browser_navigate", arguments: { browserId, action: "goto", url: `${origin}/controls` } };
			}
			if (step === 2) return { tool: "browser_observe", arguments: { browserId, mode: "state" } };
			if (step <= 5) {
				const { observation, ...scope } = observationInput(lastResult);
				if (step === 3) messageId = elementId(observation.state, "Message");
				const action = step === 3 ? { type: "click", target: { elementId: elementId(observation.state, "Increment") } }
					: step === 4 ? { type: "type", elementId: messageId, text: '{"keep":"as text"}', replace: true }
					: { type: "press", key: "Enter" };
				return { tool: "browser_act", arguments: { ...scope, intent: "Exercise encoded fixture action", risk: "ordinary", action: JSON.stringify(action) } };
			}
			return { text: "done:encoded-control" };
		});
		fixture.setScript("expired-tab-recovery", ({ lastResult, origin }) => {
			if (recoveryPhase === "close") {
				recoveryPhase = "expired";
				return { tool: "browser_tabs", arguments: { action: "close", browserId } };
			}
			if (recoveryPhase === "expired") {
				recoveryPhase = "list";
				return { tool: "browser_observe", arguments: { browserId } };
			}
			if (recoveryPhase === "list") {
				expect(lastResult).toContain('browser_tabs with {"action":"list"}');
				recoveryPhase = "choose";
				return { tool: "browser_tabs", arguments: { action: "list" } };
			}
			if (recoveryPhase === "choose") {
				const current = tabs(lastResult).at(-1);
				if (!current) {
					recoveryPhase = "opened";
					return { tool: "browser_tabs", arguments: { action: "open" } };
				}
				recoveredId = String(current.browserId);
				recoveryPhase = "observe";
				return { tool: "browser_navigate", arguments: { browserId: recoveredId, action: "goto", url: `${origin}/controls` } };
			}
			if (recoveryPhase === "opened") {
				recoveredId = String(tabs(lastResult).at(-1)!.browserId);
				recoveryPhase = "observe";
				return { tool: "browser_navigate", arguments: { browserId: recoveredId, action: "goto", url: `${origin}/controls` } };
			}
			if (recoveryPhase === "observe") {
				recoveryPhase = "click";
				return { tool: "browser_observe", arguments: { browserId: recoveredId, mode: "state" } };
			}
			if (recoveryPhase === "click") {
				const { observation, ...scope } = observationInput(lastResult);
				recoveryPhase = "done";
				return { tool: "browser_act", arguments: { ...scope, intent: "Resume fixture control", risk: "ordinary",
					action: JSON.stringify({ type: "click", target: { elementId: elementId(observation.state, "Increment") } }) } };
			}
			return { text: "done:expired-tab-recovery" };
		});
		app = await launchBrowserAgentApp(environment);
		await sendFixturePrompt(app.page, "encoded-control");
		await waitForDone(app, "encoded-control");
		const controlled = app.browser.contexts().flatMap((context) => context.pages()).find((page) => page.url() === `${fixture.origin}/controls`);
		if (!controlled) throw new Error("Encoded-action page missing");
		await expect(controlled.locator("#count")).toHaveText("Count: 1");
		await expect(controlled.locator("#message-status")).toHaveText('Message: {"keep":"as text"}');
		await controlled.screenshot({ path: testInfo.outputPath("packaged-encoded-actions.png") });
		expect(fixture.calls.filter((call) => call.marker === "encoded-control" && call.name === "browser_act")).toHaveLength(3);
		await sendFixturePrompt(app.page, "expired-tab-recovery");
		await waitForDone(app, "expired-tab-recovery");
		expect(recoveredId).not.toBe(browserId);
		const recovered = app.browser.contexts().flatMap((context) => context.pages()).find((page) => page.url() === `${fixture.origin}/controls`);
		if (!recovered) throw new Error("Recovered browser page missing");
		await expect(recovered.locator("#count")).toHaveText("Count: 1");
		await recovered.screenshot({ path: testInfo.outputPath("packaged-recovered-controls.png") });
		const oldObserve = fixture.calls.filter((call) => call.marker === "expired-tab-recovery" && call.name === "browser_observe")[0];
		expect(oldObserve?.result).toContain('browser_tabs with {"action":"list"}');
	} finally {
		if (app) await closeBrowserAgentApp(app);
		await fixture.close();
		await removeBrowserAgentEnvironment(environment);
	}
});

test("packaged agent controls accessible pages, frames, screenshots, popups, stale state, caps, and budgets", async () => {
	test.setTimeout(360_000);
	expect(existsSync(packagedExecutable()), `Package the desktop app first: ${packagedExecutable()}`).toBe(true);
	const fixture = await createBrowserAgentFixture();
	const environment = await createBrowserAgentEnvironment(fixture.providerPort);
	let app: RunningBrowserAgentApp | undefined;
	let mainBrowserId = "";
	let currentObservation = "";
	let controlState = "";
	let staleObservation = "";
	let performanceState = "";
	let popupActResult = "";
	let popupObservation = "";
	let popupSourceId = "";
	let stateBurst: Promise<void> = Promise.resolve();
	try {
		fixture.setScript("ordinary-control", async ({ step, lastResult, origin }) => {
			if (step === 0) return { tool: "browser_tabs", arguments: { action: "open" } };
			if (step === 1) {
				mainBrowserId = String(tabs(lastResult)[0]?.browserId);
				return { tool: "browser_navigate", arguments: { browserId: mainBrowserId, action: "goto", url: `${origin}/controls` } };
			}
			if (step === 2) return { tool: "browser_observe", arguments: { browserId: mainBrowserId, mode: "both" } };
			if (step >= 3 && step <= 6) currentObservation = lastResult;
			if (step === 3) controlState = lastResult;
			if (step === 3) {
				const input = observationInput(currentObservation);
				return { tool: "browser_act", arguments: { ...input, observation: undefined, intent: "Increment fixture counter", risk: "ordinary", action: { type: "click", target: { elementId: elementId(parseToolJson(controlState).state, "Increment") } } } };
			}
			if (step === 4) {
				const input = observationInput(currentObservation);
				return { tool: "browser_act", arguments: { ...input, observation: undefined, intent: "Enter fixture message", risk: "ordinary", action: { type: "type", elementId: elementId(parseToolJson(controlState).state, "Message"), text: "typed-marker-e2e", replace: true } } };
			}
			if (step === 5) {
				const input = observationInput(currentObservation);
				return { tool: "browser_act", arguments: { ...input, observation: undefined, intent: "Commit fixture message", risk: "ordinary", action: { type: "press", key: "Enter" } } };
			}
			if (step === 6) {
				const input = observationInput(currentObservation);
				return { tool: "browser_act", arguments: { ...input, observation: undefined, intent: "Choose dark fixture theme", risk: "ordinary", action: { type: "select", elementId: elementId(parseToolJson(controlState).state, "Theme"), value: "dark" } } };
			}
			if (step === 7) {
				return { tool: "browser_tabs", arguments: { action: "open" } };
			}
			if (step === 8) {
				const popupSource = tabs(lastResult).find((candidate) => candidate.browserId !== mainBrowserId);
				if (!popupSource) throw new Error(`Popup source tab was not opened: ${lastResult}`);
				popupSourceId = String(popupSource.browserId);
				return { tool: "browser_navigate", arguments: { browserId: popupSourceId, action: "goto", url: `${origin}/popup-fixture` } };
			}
			if (step === 9) {
				popupObservation = lastResult;
				const input = observationInput(lastResult);
				return { tool: "browser_act", arguments: { ...input, observation: undefined, intent: "Open mock OAuth popup", risk: "ordinary", action: { type: "click", target: { elementId: elementId(input.observation.state, "Open OAuth popup") } } } };
			}
			if (step === 10) {
				popupActResult = lastResult;
				return { tool: "browser_tabs", arguments: { action: "list" } };
			}
			if (step === 11) {
				const popup = tabs(lastResult).find((candidate) => String(candidate.url).includes("/oauth"));
				if (!popup) throw new Error(`OAuth popup was not adopted. observation=${popupObservation} act=${popupActResult} tabs=${lastResult}`);
				return { tool: "browser_observe", arguments: { browserId: String(popup.browserId), mode: "state" } };
			}
			if (step === 12) {
				const input = observationInput(lastResult);
				return { tool: "browser_act", arguments: { ...input, observation: undefined, intent: "Authorize mock OAuth", risk: "ordinary", action: { type: "click", target: { elementId: elementId(input.observation.state, "Authorize") } } } };
			}
			if (step === 13) return { tool: "browser_tabs", arguments: { action: "list" } };
			if (step === 14) return { tool: "browser_observe", arguments: { browserId: popupSourceId, mode: "state" } };
			if (step === 15) return { tool: "browser_tabs", arguments: { action: "close", browserId: popupSourceId } };
			if (step === 16) {
				return { tool: "browser_observe", arguments: { browserId: mainBrowserId, mode: "state" } };
			}
			if (step === 17) {
				controlState = lastResult;
				const input = observationInput(lastResult);
				return { tool: "browser_act", arguments: { ...input, observation: undefined, intent: "Scroll fixture", risk: "ordinary", action: { type: "scroll", direction: "down", pages: 1, elementId: elementId(input.observation.state, "Bottom action") } } };
			}
			if (step === 18) {
				const input = observationInput(lastResult);
				return { tool: "browser_act", arguments: { ...input, observation: undefined, intent: "Use bottom fixture action", risk: "ordinary", action: { type: "click", target: { elementId: elementId(observationInput(controlState).observation.state, "Bottom action") } } } };
			}
			if (step === 19) return { tool: "browser_observe", arguments: { browserId: mainBrowserId, mode: "state" } };
			if (step === 20) {
				const input = observationInput(lastResult);
				return { tool: "browser_act", arguments: { ...input, observation: undefined, intent: "Use cross-origin frame action", risk: "ordinary", action: { type: "click", target: { elementId: elementId(input.observation.state, "Frame action") } } } };
			}
			if (step === 21) return { tool: "browser_tabs", arguments: { action: "list" } };
			return { text: "done:ordinary-control" };
		});

		fixture.setScript("performance-cycle", async ({ step, lastResult }) => {
			if (step < PERFORMANCE_OBSERVATIONS) {
				// Finish the title burst before the final observation used by the
				// first click, so this latency sample does not request a stale action.
				if (step === PERFORMANCE_OBSERVATIONS - 1) await stateBurst;
				return { tool: "browser_observe", arguments: { browserId: mainBrowserId, mode: "state" } };
			}
			if (step < PERFORMANCE_OBSERVATIONS + PERFORMANCE_ACTIONS) {
				if (step === PERFORMANCE_OBSERVATIONS) performanceState = lastResult;
				const input = observationInput(lastResult);
				return { tool: "browser_act", arguments: { ...input, observation: undefined, intent: "Measure local fixture action", risk: "ordinary", action: { type: "click", target: { elementId: elementId(observationInput(performanceState).observation.state, "Increment") } } } };
			}
			return { text: "done:performance-cycle" };
		});

		fixture.setScript("stale-observe", ({ step, lastResult, origin }) => {
			if (step === 0) return { tool: "browser_navigate", arguments: { browserId: mainBrowserId, action: "goto", url: `${origin}/stale?v=1` } };
			if (step === 1) staleObservation = lastResult;
			return { text: "done:stale-observe" };
		});
		fixture.setScript("stale-act", ({ step }) => {
			if (step === 0) {
				const input = observationInput(staleObservation);
				return { tool: "browser_act", arguments: { ...input, observation: undefined, intent: "Exercise stale protection", risk: "ordinary", action: { type: "click", target: { elementId: elementId(input.observation.state, "Stale action") } } } };
			}
			return { text: "done:stale-act" };
		});

		let capCount = 0;
		let attemptedOverflow = false;
		fixture.setScript("tab-cap", ({ step, lastResult }) => {
			if (step === 0) return { tool: "browser_tabs", arguments: { action: "list" } };
			if (lastResult.startsWith("{")) capCount = tabs(lastResult).length;
			if (capCount < 16) return { tool: "browser_tabs", arguments: { action: "open" } };
			if (!attemptedOverflow) {
				attemptedOverflow = true;
				return { tool: "browser_tabs", arguments: { action: "open" } };
			}
			if (step > 1 && !lastResult.startsWith("{")) return { tool: "browser_tabs", arguments: { action: "list" } };
			return { text: "done:tab-cap" };
		});

		app = await launchBrowserAgentApp(environment);
		await sendFixturePrompt(app.page, "ordinary-control");
		await waitForDone(app, "ordinary-control");
		await expect.poll(() => fixture.calls.find((call) => call.marker === "ordinary-control" && call.name === "browser_observe")?.result).toBeTruthy();
		const ordinaryRequests = fixture.requests.filter((request) => request.includes("ordinary-control"));
		expect(ordinaryRequests.some((request) => request.includes("data:image/jpeg;base64"))).toBe(true);
		expect(Math.max(...ordinaryRequests.map((request) => Buffer.byteLength(request, "utf8")))).toBeLessThan(8 * 1024 * 1024);
		const embedded = app.browser.contexts().flatMap((context) => context.pages()).find((page) => page.url() === `${fixture.origin}/controls`);
		if (!embedded) throw new Error("Controlled fixture target was not exposed");
		await expect(embedded.locator("#count")).toHaveText("Count: 1");
		await expect(embedded.locator("#message-status")).toHaveText("Message: typed-marker-e2e");
		await expect(embedded.locator("#theme-status")).toHaveText("Theme: dark");
		await expect(embedded.locator("#bottom-status")).toHaveText("Bottom: complete");
		await expect(embedded.locator("iframe").contentFrame().locator("#frame-status")).toHaveText("Frame: complete");
		expect(
			fixture.calls.some(
				(call) => call.marker === "ordinary-control" && call.name === "browser_observe" && call.result?.includes("OAuth: complete"),
			),
		).toBe(true);
		expect(fixture.calls.filter((call) => call.marker === "ordinary-control" && call.name === "browser_tabs").at(-1)?.result).toContain(mainBrowserId);

		await app.page.evaluate((browserId) => {
			const state = window as typeof window & { __browserProgress?: BrowserProgressMeasurement };
			const progress = { startedAt: performance.now(), count: 0, lastTitle: "" };
			state.__browserProgress = progress;
			(globalThis as unknown as { metis: MetisDesktopApi }).metis.subscribeBrowser((event) => {
				if (event.type === "state" && event.state.browserId === browserId) {
					progress.count += 1;
					progress.lastTitle = event.state.title;
				} else if (event.type === "activity" && event.browserId === browserId) {
					progress.count += 1;
				}
			});
		}, mainBrowserId);
		stateBurst = embedded.evaluate(
			() =>
				new Promise<void>((resolve) => {
					let index = 0;
					const timer = setInterval(() => {
						document.title = `Browser control burst ${index}`;
						index += 1;
						if (index < 200) return;
						clearInterval(timer);
						resolve();
					}, 5);
				}),
		);
		await sendFixturePrompt(app.page, "performance-cycle");
		await stateBurst;
		await expect.poll(() => app!.page.evaluate(
			() => (window as typeof window & { __browserProgress?: BrowserProgressMeasurement }).__browserProgress?.lastTitle,
		)).toBe("Browser control burst 199");
		const burstProgress = await app.page.evaluate(() => {
			const progress = (window as typeof window & { __browserProgress?: BrowserProgressMeasurement }).__browserProgress!;
			return { count: progress.count, elapsed: performance.now() - progress.startedAt };
		});
		// Measure the complete stimulus through its final delivered state: IPC can bunch
		// arrivals inside an arbitrary sliding window. The emitter's strict 20/s spacing
		// is checked with fake timers in browser-manager.test.ts; one initial event is allowed here.
		expect(burstProgress.count).toBeLessThanOrEqual(Math.ceil(burstProgress.elapsed * 20 / 1_000) + 1);
		await waitForDone(app, "performance-cycle");
		const performanceCalls = fixture.calls.filter((call) => call.marker === "performance-cycle");
		expect(performanceCalls.every((call) => call.completedAt !== undefined)).toBe(true);
		expect(Math.max(...performanceCalls.map((call) => Buffer.byteLength(call.result ?? "", "utf8")))).toBeLessThan(
			256 * 1024,
		);
		const observationDurations = performanceCalls
			.filter((call) => call.name === "browser_observe" && call.completedAt)
			.map((call) => call.completedAt! - call.issuedAt);
		const actionDurations = performanceCalls
			.filter((call) => call.name === "browser_act" && call.completedAt)
			.map((call) => call.completedAt! - call.issuedAt);
		expect(observationDurations).toHaveLength(PERFORMANCE_OBSERVATIONS);
		expect(actionDurations).toHaveLength(PERFORMANCE_ACTIONS);
		expect(p95(observationDurations.slice(PERFORMANCE_WARMUPS))).toBeLessThan(1_000);
		expect(p95(actionDurations.slice(PERFORMANCE_WARMUPS))).toBeLessThan(1_500);
		await expect(embedded.locator("#count")).toHaveText("Count: 101");

		await sendFixturePrompt(app.page, "stale-observe");
		await waitForDone(app, "stale-observe");
		const stalePage = app.browser.contexts().flatMap((context) => context.pages()).find((page) => page.url().includes("/stale?v=1"));
		if (!stalePage) throw new Error("Stale-state target was not exposed");
		await stalePage.goto(`${fixture.origin}/stale?v=2`);
		await sendFixturePrompt(app.page, "stale-act");
		await waitForDone(app, "stale-act");
		const staleResult = fixture.calls.find((call) => call.marker === "stale-act")?.result ?? "";
		expect(staleResult).toContain("stale");
		expect(fixture.staleActionCount()).toBe(0);

		await sendFixturePrompt(app.page, "tab-cap");
		await waitForDone(app, "tab-cap");
		const capResults = fixture.calls.filter((call) => call.marker === "tab-cap");
		expect(capResults.some((call) => call.result === "OVERLOADED")).toBe(true);
		expect(tabs(capResults.at(-1)?.result ?? "")).toHaveLength(16);
		expect(stalePage.isClosed()).toBe(false);
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : String(error)}\ntrace=${JSON.stringify(fixture.calls, null, 2).slice(-24_000)}\n${environment.diagnostics.join("").slice(-12_000)}`);
	} finally {
		if (app) await closeBrowserAgentApp(app);
		await fixture.close();
		await removeBrowserAgentEnvironment(environment);
	}
});

test("packaged profiles isolate cookies and persist them across restart", async () => {
	test.setTimeout(120_000);
	const importedProfileId = "20000000-0000-4000-8000-000000000001";
	const defaultProfileId = "00000000-0000-4000-8000-000000000001";
	const fixture: BrowserAgentFixture = await createBrowserAgentFixture();
	const environment = await createBrowserAgentEnvironment(fixture.providerPort, [{
		profileId: importedProfileId,
		name: "Chrome – Work",
		sourceProfileId: "Profile 1",
	}]);
	let app: RunningBrowserAgentApp | undefined;
	let defaultBrowserId = "";
	let workBrowserId = "";
	try {
		fixture.setScript("profile-seed", ({ step, lastResult, origin }) => {
			if (step === 0) return { tool: "browser_tabs", arguments: { action: "open", profileId: defaultProfileId } };
			if (step === 1) {
				defaultBrowserId = profileBrowser(lastResult, defaultProfileId);
				return { tool: "browser_navigate", arguments: { browserId: defaultBrowserId, action: "goto", url: `${origin}/set-cookie?value=default` } };
			}
			if (step === 2) return { tool: "browser_tabs", arguments: { action: "open", profileId: importedProfileId } };
			if (step === 3) {
				workBrowserId = profileBrowser(lastResult, importedProfileId);
				return { tool: "browser_navigate", arguments: { browserId: workBrowserId, action: "goto", url: `${origin}/set-cookie?value=work` } };
			}
			return { text: "done:profile-seed" };
		});
		fixture.setScript("profile-check", ({ step, lastResult, origin }) => {
			if (step === 0) return { tool: "browser_tabs", arguments: { action: "open", profileId: defaultProfileId } };
			if (step === 1) {
				defaultBrowserId = profileBrowser(lastResult, defaultProfileId);
				return { tool: "browser_navigate", arguments: { browserId: defaultBrowserId, action: "goto", url: `${origin}/cookie` } };
			}
			if (step === 2) {
				expect(lastResult).toContain("profile=default");
				return { tool: "browser_tabs", arguments: { action: "open", profileId: importedProfileId } };
			}
			if (step === 3) {
				workBrowserId = profileBrowser(lastResult, importedProfileId);
				return { tool: "browser_navigate", arguments: { browserId: workBrowserId, action: "goto", url: `${origin}/cookie` } };
			}
			if (step === 4) {
				expect(lastResult).toContain("profile=work");
				expect(lastResult).not.toContain("profile=default");
			}
			return { text: "done:profile-check" };
		});

		app = await launchBrowserAgentApp(environment);
		await sendFixturePrompt(app.page, "profile-seed");
		await waitForDone(app, "profile-seed");
		await closeBrowserAgentApp(app);
		app = undefined;
		app = await launchBrowserAgentApp(environment, { createSession: false });
		await sendFixturePrompt(app.page, "profile-check");
		await waitForDone(app, "profile-check");
	} catch (error) {
		throw new Error(`${error instanceof Error ? error.message : String(error)}\n${environment.diagnostics.join("").slice(-12_000)}`);
	} finally {
		if (app) await closeBrowserAgentApp(app);
		await fixture.close();
		await removeBrowserAgentEnvironment(environment);
	}
});
