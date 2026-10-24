import { expect, test, type ElectronApplication } from "@playwright/test";
import { createBrowserAgentFixture, elementId } from "./browser-agent-fixture.ts";
import { callSourceBrowser as call, launchSourceBrowser } from "./browser-source-harness.ts";

async function successfulCall(app: ElectronApplication, name: string, args: Record<string, unknown>) {
	const result = await call(app, name, args);
	const diagnostics = result.ok ? [] : await app.evaluate(async () => (await globalThis.metisBrowserSourceReady).diagnostics);
	expect(result.ok, [result.text, ...diagnostics].join("\n")).toBe(true);
	return JSON.parse(result.text);
}

test("current source controls real Chromium with encoded actions and expired-tab recovery before packaging", async ({}, testInfo) => {
	test.setTimeout(90_000);
	const fixture = await createBrowserAgentFixture();
	let source: Awaited<ReturnType<typeof launchSourceBrowser>> | undefined;
	let app: ElectronApplication | undefined;
	try {
		source = await launchSourceBrowser();
		app = source.app;
		const opened = await successfulCall(app, "browser_tabs", { action: "open" });
		const browserId = opened.tabs[0].browserId as string;
		await successfulCall(app, "browser_navigate", { browserId, action: "goto", url: `${fixture.origin}/controls` });
		let observation = await successfulCall(app, "browser_observe", { browserId, mode: "state" });
		const act = async (action: Record<string, unknown>) => {
			const result = await successfulCall(app!, "browser_act", {
				browserId, documentId: observation.documentId, snapshotRevision: observation.revision,
				origin: fixture.origin, intent: "Exercise local fixture control", risk: "ordinary", action: JSON.stringify(action),
			});
			expect(result.browserId).toBe(browserId);
			observation = result;
		};
		const incrementId = elementId(observation.state, "Increment");
		const messageId = elementId(observation.state, "Message");
		const themeId = elementId(observation.state, "Theme");
		await act({ type: "click", target: { elementId: incrementId } });
		const controlled = app.context().pages().find((page) => page.url() === `${fixture.origin}/controls`);
		if (!controlled) throw new Error("Source browser fixture page missing");
		await expect(controlled.locator("#count")).toHaveText("Count: 1");
		const increment = await controlled.locator("#increment").boundingBox();
		if (!increment) throw new Error("Source fixture increment control missing");
		await act({ type: "click", target: { x: increment.x + increment.width / 2, y: increment.y + increment.height / 2 } });
		await expect(controlled.locator("#count")).toHaveText("Count: 2");
		await act({ type: "type", elementId: messageId, text: '{"keep":"as text"}', replace: true });
		await act({ type: "press", key: "Enter" });
		await expect(controlled.locator("#message-status")).toHaveText('Message: {"keep":"as text"}');
		await act({ type: "select", elementId: themeId, value: "dark" });
		await expect(controlled.locator("#theme-status")).toHaveText("Theme: dark");
		observation = await successfulCall(app, "browser_observe", { browserId });
		await act({ type: "click", target: { elementId: elementId(observation.state, "Frame action") } });
		await expect(controlled.frameLocator("iframe").locator("#frame-status")).toHaveText("Frame: complete");
		const capture = await call(app, "browser_observe", { browserId, mode: "both" });
		expect(capture.ok, capture.text).toBe(true);
		expect(capture.imageCount).toBe(1);
		expect(capture.imageBytes).toBeGreaterThan(1_000);
		const screenshot = JSON.parse(capture.text);
		// The screenshot is emitted as separate image content; state text stays bounded.
		expect(screenshot.state).toContain("Count: 2");
		expect(screenshot.screenshot).toBeUndefined();
		const stale = await call(app, "browser_act", {
			browserId, documentId: screenshot.documentId, snapshotRevision: 0,
			origin: fixture.origin, intent: "Reject stale click", risk: "ordinary",
			action: JSON.stringify({ type: "click", target: { elementId: incrementId } }),
		});
		expect(stale.ok).toBe(false);
		expect(JSON.parse(stale.text)).toMatchObject({ status: "stale", reason: "revision_changed" });
		expect(stale.text).toContain("not executed");
		await expect(controlled.locator("#count")).toHaveText("Count: 2");
		const invalid = await call(app, "browser_act", {
			browserId, documentId: screenshot.documentId, snapshotRevision: screenshot.revision,
			origin: fixture.origin, intent: "Reject malformed action", risk: "ordinary", action: "invalid JSON",
		});
		expect(invalid.ok).toBe(false);
		expect(invalid.text.match(/action: must be object/g)).toHaveLength(1);
		for (const invalidFields of [
			{ action: '{"type":"click","target":{}}' },
			{ action: JSON.stringify({ type: "click", target: { elementId: incrementId }, unknown: true }) },
			{ action: '{"type":"click"' },
			{ origin: `${fixture.origin}/path` },
			{ risk: "skip_confirmation" },
			{ snapshotRevision: -1 },
		]) {
			const rejected = await call(app, "browser_act", {
				browserId, documentId: screenshot.documentId, snapshotRevision: screenshot.revision,
				origin: fixture.origin, intent: "Check fixture input validation", risk: "ordinary",
				action: JSON.stringify({ type: "click", target: { elementId: incrementId } }), ...invalidFields,
			});
			expect(rejected.ok, JSON.stringify(invalidFields)).toBe(false);
			expect(rejected.text).toContain("Validation failed");
		}
		await expect(controlled.locator("#count")).toHaveText("Count: 2");
		await controlled.screenshot({ path: testInfo.outputPath("source-browser-controls.png") });
		await successfulCall(app, "browser_tabs", { action: "close", browserId });
		const expired = await call(app, "browser_observe", { browserId });
		expect(expired.ok).toBe(false);
		expect(expired.text).toContain('browser_tabs with {"action":"list"}');
		expect(expired.text).toContain("browser_observe");
		expect((await successfulCall(app, "browser_tabs", { action: "list" })).tabs).toEqual([]);
		const replacement = (await successfulCall(app, "browser_tabs", { action: "open" })).tabs[0].browserId;
		expect(replacement).not.toBe(browserId);
		await successfulCall(app, "browser_navigate", { browserId: replacement, action: "goto", url: `${fixture.origin}/controls` });
		const recoveredObservation = await successfulCall(app, "browser_observe", { browserId: replacement });
		expect(recoveredObservation.state).toContain("Count: 0");
		await successfulCall(app, "browser_act", {
			browserId: replacement, documentId: recoveredObservation.documentId, snapshotRevision: recoveredObservation.revision,
			origin: fixture.origin, intent: "Resume recovered browser control", risk: "ordinary",
			action: JSON.stringify({ type: "click", target: { elementId: elementId(recoveredObservation.state, "Increment") } }),
		});
		const recoveredPage = app.context().pages().find((page) => page.url() === `${fixture.origin}/controls`);
		if (!recoveredPage) throw new Error("Recovered source browser page missing");
		await expect(recoveredPage.locator("#count")).toHaveText("Count: 1");
		await recoveredPage.screenshot({ path: testInfo.outputPath("source-recovered-controls.png") });
		for (const [name, source] of [["Open destination", "visible"], ["Open lower destination", "below-fold"]]) {
			await successfulCall(app, "browser_navigate", { browserId: replacement, action: "goto", url: `${fixture.origin}/navigation` });
			const navigation = await successfulCall(app, "browser_observe", { browserId: replacement });
			await successfulCall(app, "browser_act", {
				browserId: replacement, documentId: navigation.documentId, snapshotRevision: navigation.revision,
				origin: fixture.origin, intent: "Verify actual link navigation", risk: "ordinary",
				action: JSON.stringify({ type: "click", target: { elementId: elementId(navigation.state, name!) } }),
			});
			await expect(recoveredPage).toHaveURL(`${fixture.origin}/navigation-done?from=${source}`);
			await expect(recoveredPage.getByRole("heading", { name: "Navigation complete" })).toBeVisible();
			await recoveredPage.screenshot({ path: testInfo.outputPath(`source-navigation-${source}.png`) });
		}
		const diagnostics = await app.evaluate(async () => (await globalThis.metisBrowserSourceReady).diagnostics);
		expect(diagnostics.join("\n")).toContain("Browser is not running");
		expect(diagnostics.join("\n")).toContain("NOT_FOUND");
	} finally {
		await source?.close();
		await fixture.close();
	}
});
