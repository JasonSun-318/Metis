import { writeFile } from "node:fs/promises";
import type { BrowserAction, BrowserObservation } from "@metis/app-protocol";
import { expect, test } from "@playwright/test";
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
	type BrowserScriptInstruction,
	type RunningBrowserAgentApp,
} from "./browser-agent-fixture.ts";

// Explicit opt-in: the public site's availability and UI are outside our control.
for (const site of ["GitHub", "Wikipedia"] as const) {
	test(`packaged Metis controls ${site}'s live interface`, async ({}, testInfo) => {
		test.skip(process.env.METIS_BROWSER_LIVE_TEST !== "1", "Requires the packaged app and internet access");
		test.setTimeout(180_000);
		const fixture = await createBrowserAgentFixture();
		const environment = await createBrowserAgentEnvironment(fixture.providerPort);
		let app: RunningBrowserAgentApp | undefined;
		let sequence = 0;
		const networkFailures: Array<{ url: string; error: string }> = [];
		const instructions: BrowserScriptInstruction[] = [];
		let waiting: ((instruction: BrowserScriptInstruction) => void) | undefined;
		const enqueue = (instruction: BrowserScriptInstruction) => {
			if (waiting) {
				const deliver = waiting;
				waiting = undefined;
				deliver(instruction);
			} else instructions.push(instruction);
		};
		try {
			app = await launchBrowserAgentApp(environment);
			const running = app;
			fixture.setScript(
				"live-site-flow",
				() =>
					new Promise<BrowserScriptInstruction>((resolve) => {
						const queued = instructions.shift();
						if (queued) resolve(queued);
						else waiting = resolve;
					}),
			);
			// One continuous agent turn preserves the webpage's keyboard focus and menus.
			await sendFixturePrompt(running.page, "live-site-flow");
			// Only the provider response is scripted. Every tool traverses the real
			// chat, app-server, permission, desktop host and embedded browser paths.
			const call = async (tool: string, args: object) => {
				sequence += 1;
				const index = fixture.calls.length;
				enqueue({ tool, arguments: args });
				await expect.poll(() => fixture.calls[index]?.result, { timeout: 30_000 }).toBeTruthy();
				const trace = fixture.calls[index]!;
				expect(trace.result, `${tool} did not return`).toBeTruthy();
				const result = trace.result!;
				expect(result).not.toContain("[Tool output truncated: preview only]");
				expect(result.length).toBeLessThan(50_000);
				await writeFile(testInfo.outputPath(`tool-${sequence}.txt`), result);
				return parseToolJson(result);
			};
			const opened = await call("browser_tabs", { action: "open" });
			const browserId = String((opened.tabs as Array<{ browserId: string }>).at(-1)!.browserId);
			const url =
				site === "GitHub"
					? "https://github.com/microsoft/vscode/issues"
					: "https://en.wikipedia.org/wiki/Web_browser";
			await call("browser_navigate", { browserId, action: "goto", url });
			const showTools = running.page.getByRole("button", { name: "Show tools sidebar", exact: true });
			if (await showTools.isVisible()) await showTools.click();
			await running.page
				.getByRole("tab", { name: site === "GitHub" ? /Issues · microsoft\/vscode/u : /Web browser/u })
				.click();
			const panel = running.page.locator(`#browser-panel-${browserId}`);
			await expect(panel).toBeVisible();
			const website = running.browser
				.contexts()
				.flatMap((context) => context.pages())
				.find((page) => page.url() === url);
			if (!website) throw new Error("Live site embedded browser missing");
			website.on("requestfailed", (request) =>
				networkFailures.push({ url: request.url(), error: request.failure()?.errorText ?? "failed" }),
			);
			website.on("response", (response) => {
				if (response.status() >= 400)
					networkFailures.push({ url: response.url(), error: String(response.status()) });
			});
			const observe = async () => {
				let latest = (await call("browser_observe", { browserId })) as unknown as BrowserObservation;
				let state = latest.state;
				let resets = 0;
				for (let count = 0; latest.statePage?.nextCursor; count++) {
					expect(count).toBeLessThan(64);
					const cursor = latest.statePage.nextCursor;
					latest = (await call("browser_observe", { browserId, cursor })) as unknown as BrowserObservation;
					if (latest.cursorReset) {
						expect(++resets).toBeLessThan(4);
						state = latest.state;
					} else {
						expect(latest.revision).toBe(cursor.revision);
						expect(latest.documentId).toBe(cursor.documentId);
						expect(latest.statePage?.offset).toBe(state.length);
						state += latest.state;
					}
				}
				return { ...latest, state };
			};
			const act = async (choose: (state: string) => BrowserAction) => {
				for (let attempt = 0; attempt < 3; attempt++) {
					const latest = await observe();
					const { observation, ...scope } = observationInput(JSON.stringify(latest));
					const result = await call("browser_act", {
						...scope,
						intent: "Browse public reference pages",
						risk: "ordinary",
						action: choose(String(observation.state)),
					});
					if (result.status !== "stale") return result;
					// Never bypass a hit-test refusal. Only refresh a changed observation.
					expect(["revision_changed", "document_changed"]).toContain(result.reason);
				}
				throw new Error("Live page did not stabilize after three observations");
			};
			const observation = await observe();
			await writeFile(testInfo.outputPath("initial-state.json"), JSON.stringify(observation, null, 2));
			if (site === "Wikipedia") {
				await website.screenshot({ path: testInfo.outputPath("wikipedia-initial.png") });
				await act((state) => ({ type: "click", target: { elementId: elementId(state, "Search") } }));
				await act((state) => ({
					type: "type",
					elementId: elementId(state, "Search Wikipedia"),
					text: "temporary query",
					replace: true,
				}));
				await act(() => ({ type: "press", key: "ControlOrMeta+A" }));
				await act(() => ({ type: "press", key: "Backspace" }));
				await expect(website.getByRole("combobox", { name: "Search Wikipedia" })).toHaveValue("");
				await act((state) => ({
					type: "type",
					elementId: elementId(state, "Search Wikipedia"),
					text: "Chromium (web browser)",
					replace: true,
				}));
				await expect(website.getByRole("combobox", { name: "Search Wikipedia" })).toHaveValue(
					"Chromium (web browser)",
				);
				await act(() => ({ type: "press", key: "Enter" }));
				await expect(website).toHaveURL(/\/wiki\/Chromium_\(web_browser\)/u);
				await expect(website.getByRole("heading", { name: "Chromium (web browser)", exact: true })).toBeVisible();
				await website.screenshot({ path: testInfo.outputPath("wikipedia-search-result.png") });
				await call("browser_navigate", { browserId, action: "back" });
				await expect(website).toHaveURL(url);
				await call("browser_navigate", { browserId, action: "forward" });
				await expect(website).toHaveURL(/\/wiki\/Chromium_\(web_browser\)/u);
				await call("browser_navigate", { browserId, action: "back" });
				await expect(website).toHaveURL(url);
				await act((state) => ({ type: "click", target: { elementId: elementId(state, "Appearance") } }));
				const menu = await observe();
				await writeFile(testInfo.outputPath("wikipedia-menu-state.json"), JSON.stringify(menu, null, 2));
				await website.screenshot({ path: testInfo.outputPath("wikipedia-menu.png") });
				expect(String(menu.state)).toContain('radio "Dark"');
				await act((state) => ({ type: "click", target: { elementId: elementId(state, "Dark") } }));
				const appearance = await observe();
				expect(String(appearance.state)).toMatch(/radio "Dark" \[[^\n]*checked=true/u);
				await act(() => ({ type: "press", key: "Escape" }));
				await act((state) => ({ type: "click", target: { elementId: elementId(state, "Firefox") } }));
				await expect(website).toHaveURL("https://en.wikipedia.org/wiki/Firefox");
				await expect(website.getByRole("heading", { name: "Firefox", exact: true })).toBeVisible();
				await call("browser_observe", { browserId, mode: "both" });
				expect(fixture.requests.some((request) => request.includes("data:image/jpeg;base64,"))).toBe(true);
				await website.screenshot({ path: testInfo.outputPath("wikipedia-final.png") });
				await running.page.screenshot({ path: testInfo.outputPath("metis-wikipedia.png") });
				return;
			}
			expect(String(observation.state)).toContain("Issues");
			await act((state) => ({
				type: "type",
				elementId: elementId(state, "Search issues"),
				text: "is:issue is:open terminal",
				replace: true,
			}));
			await expect(website.getByRole("combobox", { name: "Search issues" })).toHaveValue(
				"is:issue is:open terminal",
			);
			await act(() => ({ type: "press", key: "Enter" }));
			await expect(website).toHaveURL(/q=.*terminal/u);
			const searched = await observe();
			if (String(searched.state).includes("Failed to load issues")) {
				testInfo.annotations.push({
					type: "site-recovery",
					description: "GitHub's issue search failed to load; recover through browser reload",
				});
				await call("browser_navigate", { browserId, action: "reload" });
			}
			await expect(website.getByRole("button", { name: "Filter by labels", exact: true })).toBeVisible();
			await act((state) => ({ type: "click", target: { elementId: elementId(state, "Filter by labels") } }));
			const menu = await observe();
			await writeFile(testInfo.outputPath("github-label-menu-state.json"), JSON.stringify(menu, null, 2));
			await website.screenshot({ path: testInfo.outputPath("github-label-menu.png") });
			await running.page.screenshot({ path: testInfo.outputPath("metis-github.png") });
		} finally {
			enqueue({ text: "done:live-site-flow" });
			if (app)
				await expect(app.page.getByText("done:live-site-flow", { exact: true }))
					.toBeVisible({ timeout: 5_000 })
					.catch(() => undefined);
			await writeFile(testInfo.outputPath("network-failures.json"), JSON.stringify(networkFailures, null, 2));
			await writeFile(testInfo.outputPath("tool-trace.json"), JSON.stringify(fixture.calls, null, 2));
			await writeFile(testInfo.outputPath("app-diagnostics.log"), environment.diagnostics.join(""));
			if (app) await closeBrowserAgentApp(app);
			await fixture.close();
			await removeBrowserAgentEnvironment(environment);
		}
	});
}
