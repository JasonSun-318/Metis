import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import type { MetisDesktopApi } from "../src/shared/desktop-api.ts";
import { launchPermissionApp } from "./fixtures/permission-app.ts";
import { createPluginFixtureServer, FIXTURE_MARKET_URL } from "./fixtures/plugin-market-fixture.ts";

test.describe.configure({ timeout: 240_000 });

// These are packaged-app layout and persistence checks; all data stays in the fixture HOME.
test("many providers stay in a bounded collection and the catalog supports search and keyboard close", async ({}, testInfo) => {
	const app = await launchPermissionApp({ preset: "auto", tools: () => undefined });
	try {
		await app.page.evaluate(async (baseUrl) => {
			const api = (globalThis as unknown as { metis: MetisDesktopApi }).metis;
			for (let index = 0; index < 24; index += 1) {
				await api.updateModelSettings({
					requestId: crypto.randomUUID(),
					mutation: {
						type: "save_provider", provider: `layout-${index}`, name: `Layout ${String(index).padStart(2, "0")}`,
						baseUrl, api: "openai-completions", credential: { action: "set", value: "fixture-key" },
						models: [{ modelId: "layout-model", name: "Layout", contextWindow: 32000, maxOutputTokens: 1024, reasoningMode: "off", imageInput: false }],
					},
				});
			}
		}, app.providerBaseUrl);
		await app.openSettings("Model");
		const page = app.page;
		const region = page.locator(".model-provider-list-region");
		await expect(region.locator(".model-provider-card")).toHaveCount(25);
		await region.scrollIntoViewIfNeeded();
		const dimensions = await region.evaluate((element) => ({ height: element.clientHeight, content: element.scrollHeight }));
		expect(dimensions.height).toBeLessThanOrEqual(360);
		expect(dimensions.content).toBeGreaterThan(dimensions.height);
		const toolbar = page.locator(".model-provider-toolbar");
		const before = await toolbar.boundingBox();
		await region.evaluate((element) => { element.scrollTop = element.scrollHeight; });
		expect((await toolbar.boundingBox())!.y).toBeCloseTo(before!.y, 0);
		await page.getByRole("searchbox", { name: "Search providers", exact: true }).fill("Layout 23");
		await expect(region.locator(".model-provider-card")).toHaveCount(1);
		await expect(region).toContainText("Layout 23");
		const add = page.getByRole("button", { name: "Add provider", exact: true });
		await add.click();
		const catalog = page.getByRole("dialog", { name: "Add provider", exact: true });
		await expect(catalog).toBeVisible();
		await expect(catalog.locator(".model-provider-card")).toHaveCount(8);
		await catalog.getByRole("button", { name: "Next page", exact: true }).click();
		await expect(catalog).toContainText("Page 2");
		await catalog.getByRole("searchbox", { name: "Search providers", exact: true }).fill("Anthropic");
		await expect(catalog.locator(".model-provider-card")).toHaveCount(1);
		for (const width of [1200, 820]) {
			await page.setViewportSize({ width, height: 760 });
			expect(await catalog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
			await expect(catalog.locator(".model-provider-catalog-footer")).toBeInViewport();
		}
		await page.screenshot({ path: testInfo.outputPath("provider-catalog-narrow.png") });
		await page.keyboard.press("Escape");
		await expect(catalog).toHaveCount(0);
		await expect(add).toBeFocused();
	} finally { await app.close(); }
});

test("large plugin catalogs keep pagination visible and restore detail position", async ({}, testInfo) => {
	const market = await createPluginFixtureServer(60);
	let app: Awaited<ReturnType<typeof launchPermissionApp>> | undefined;
	try {
		app = await launchPermissionApp({ preset: "auto", tools: () => undefined, env: { HTTPS_PROXY: market.proxyUrl, NODE_TLS_REJECT_UNAUTHORIZED: "0" } });
		const page = app.page;
		await page.setViewportSize({ width: 1200, height: 800 });
		await page.getByRole("button", { name: "Customize", exact: true }).click();
		await page.getByRole("tab", { name: "Plugins", exact: true }).click();
		await page.getByRole("button", { name: "Add Market", exact: true }).click();
		const addDialog = page.locator(".plugins-add-market-dialog");
		await addDialog.locator("input[placeholder*='github.com']").fill(FIXTURE_MARKET_URL);
		await addDialog.getByRole("button", { name: "Add", exact: true }).click();
		await expect(addDialog).toHaveCount(0);
		await expect(page.locator(".plugins-market-row")).toHaveCount(20);
		const list = page.locator(".plugins-full-list");
		const footer = page.getByRole("navigation", { name: "Pagination", exact: true });
		for (const width of [1200, 820]) {
			await page.setViewportSize({ width, height: 760 });
			await expect(footer).toBeInViewport();
			await expect(page.locator(".plugins-list-controls")).toBeInViewport();
			const bounds = await list.boundingBox();
			expect(bounds!.height).toBeLessThan(600);
			expect(await page.locator(".plugins-market-panel").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
		}
		const searchBounds = await page.locator(".plugins-search").boundingBox();
		const filterBounds = await page.getByRole("button", {name: "Filter by install state"}).boundingBox();
		expect(filterBounds!.y).toBeCloseTo(searchBounds!.y, 0);
		expect(filterBounds!.height).toBeCloseTo(searchBounds!.height, 0);
		await footer.getByRole("button", {name: "Go to page"}).click();
		await expect(page.getByRole("option", {name: "Page 2 of 4"})).toBeVisible();
		await page.screenshot({path: testInfo.outputPath("plugin-page-menu.png")});
		await page.getByRole("option", {name: "Page 2 of 4"}).click();
		await expect(page.locator(".plugins-market-row")).toHaveCount(20);
		await expect(footer).toContainText("Page 2");
		await list.evaluate((element) => { element.scrollTop = 130; });
		const firstVisible = page.locator(".plugins-market-row").nth(4);
		await firstVisible.getByRole("button", { name: "Inspect", exact: true }).click();
		const dialog = page.locator(".plugins-inspect-dialog");
		await expect(dialog).toBeVisible();
		await dialog.locator(".mcp-dialog-close").click();
		await expect(dialog).toHaveCount(0);
		await expect(footer).toContainText("Page 2");
		expect(await list.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
		await page.locator(".plugins-search input").fill("catalog-plugin-059");
		await expect(page.locator(".plugins-market-row")).toHaveCount(1);
		await expect(footer).toHaveCount(0);
		expect((await list.boundingBox())!.height).toBeLessThan(100);
		await expect(page.locator(".plugins-market-row")).toContainText("catalog-plugin-059");
		await page.screenshot({ path: testInfo.outputPath("plugin-catalog-narrow.png") });
		await page.getByRole("button", {name: "Markets", exact: true}).click();
		await expect(footer).toHaveCount(0);
		const sources = page.locator(".plugins-market-sources");
		expect((await sources.boundingBox())!.height).toBeLessThan(200);
		await page.screenshot({path: testInfo.outputPath("plugin-market-home.png")});
	} finally { await app?.close(); await market.close(); }
});

test("remembered permission management defaults to all projects and revokes the selected owner only", async ({}, testInfo) => {
	let otherProject = "";
	const app = await launchPermissionApp({
		preset: "ask",
		tools: (marker) => marker.startsWith("case-multi-grant")
			? { name: "bash", arguments: { command: "printf fixture > remembered.txt" } }
			: undefined,
		seed: async ({ tempRoot }) => {
			otherProject = path.join(tempRoot, "other-project");
			await mkdir(otherProject);
		},
	});
	try {
		await app.submit("case-multi-grant-first");
		await expect(app.approval).toBeVisible();
		await app.chooseApprovalOption("Remember for this project");
		await app.waitDone("case-multi-grant-first");
		const second = await app.page.evaluate(async (cwd) => {
			const api = (globalThis as unknown as { metis: MetisDesktopApi }).metis;
			return api.createSession({ requestId: crypto.randomUUID(), mode: "chat", cwd, permissionPreset: "ask" });
		}, otherProject);
		await app.openSession(second.session.sessionId);
		await app.submit("case-multi-grant-second");
		await expect(app.approval).toBeVisible();
		await app.chooseApprovalOption("Remember for this project");
		await app.waitDone("case-multi-grant-second");
		await app.openSettings("Permissions");
		await app.page.getByRole("button", { name: "Manage remembered permissions" }).click();
		const dialog = app.page.getByRole("dialog", { name: "Remembered permissions", exact: true });
		await expect(dialog.getByRole("button", { name: "Project", exact: true })).toContainText("All projects");
		await expect(dialog.getByRole("button", { name: /^Revoke/ })).toHaveCount(2);
		await dialog.getByRole("button", { name: "Project", exact: true }).click();
		await expect(dialog.getByRole("option").filter({hasText: "other-project"})).toBeVisible();
		const projectOption = dialog.getByRole("option").filter({hasText: "other-project"});
		const titleBounds = await projectOption.locator(".menu-select-option-copy > span").boundingBox();
		const pathBounds = await projectOption.locator("small").boundingBox();
		expect(pathBounds!.y).toBeGreaterThanOrEqual(titleBounds!.y + titleBounds!.height);
		await app.page.screenshot({path: testInfo.outputPath("remembered-project-menu.png")});
		await app.page.keyboard.press("Escape");
		await expect(dialog).toBeVisible();
		await expect(dialog.getByRole("button", {name: "Project", exact: true})).toBeFocused();
		await dialog.getByRole("button", { name: "Project", exact: true }).click();
		await dialog.getByRole("option").filter({hasText: "other-project"}).click();
		await expect(dialog.getByRole("button", { name: /^Revoke/ })).toHaveCount(1);
		await dialog.getByRole("button", { name: /^Revoke/ }).click();
		await expect(dialog.getByRole("button", { name: /^Revoke/ })).toHaveCount(0);
		const remaining = await app.page.evaluate(async () => {
			return (globalThis as unknown as { metis: MetisDesktopApi }).metis.listRememberedPermissionRules();
		});
		expect(remaining.groups).toHaveLength(1);
		expect(remaining.groups[0]!.projectPath).toBe(app.projectDir);
		expect(remaining.groups[0]!.rules).toHaveLength(1);
	} finally { await app.close(); }
});
