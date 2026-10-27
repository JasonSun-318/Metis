import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { build } from "esbuild";

test.use({ channel: "chrome" });
let directory: string;
let server: Server;
let url: string;
test.beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "metis-composer-selector-icons-"));
	await build({
		entryPoints: [path.join(__dirname, "composer-selector-icons.fixture.tsx")],
		bundle: true,
		format: "esm",
		jsx: "automatic",
		platform: "browser",
		target: "es2022",
		outfile: path.join(directory, "fixture.js"),
	});
	await writeFile(
		path.join(directory, "index.html"),
		'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>body{font-family:var(--chat-prose-font)}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
	);
	server = createServer((request, response) => {
		const file = new Map([
			["/", "index.html"],
			["/fixture.js", "fixture.js"],
			["/fixture.css", "fixture.css"],
		]).get(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
		if (!file) {
			response.writeHead(204).end();
			return;
		}
		response.writeHead(200, {
			"content-type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html",
		});
		createReadStream(path.join(directory, file)).pipe(response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Composer fixture failed to bind");
	url = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	if (directory) await rm(directory, { recursive: true, force: true });
});

const modelTrigger = (page: Page) => page.getByRole("button", { name: "Select model", exact: true });
const providers = (page: Page) => page.getByRole("menu", { name: "Providers", exact: true });
const modelMenu = (page: Page) => page.getByRole("menu", { name: "Models", exact: true });
const permissionTrigger = (page: Page) => page.locator(".permission-selector > .composer-selector-trigger");
const permissionOption = (page: Page, index: number) =>
	page.getByRole("menu", { name: "Permissions", exact: true }).getByRole("menuitemradio").nth(index);
async function assertInViewport(page: Page, selector: string) {
	await page
		.locator(selector)
		.evaluateAll((elements) =>
			Promise.all(
				elements.flatMap((element) =>
					element.getAnimations().map((animation) => animation.finished.catch(() => undefined)),
				),
			),
		);
	const boxes = await page.locator(selector).evaluateAll((elements) =>
		elements.map((element) => {
			const box = element.getBoundingClientRect();
			return {
				className: element.className,
				left: box.left,
				right: box.right,
				top: box.top,
				bottom: box.bottom,
				width: innerWidth,
				height: innerHeight,
			};
		}),
	);
	for (const box of boxes) {
		expect(box.left, JSON.stringify(box)).toBeGreaterThanOrEqual(0);
		expect(box.right).toBeLessThanOrEqual(box.width);
		expect(box.top).toBeGreaterThanOrEqual(0);
		expect(box.bottom).toBeLessThanOrEqual(box.height);
	}
}

test("search-free hierarchy focuses selected items, navigates back and selects numerically once", async ({ page }) => {
	await page.setViewportSize({ width: 1000, height: 700 });
	await page.goto(url);
	await modelTrigger(page).click();
	await expect(providers(page).locator("input")).toHaveCount(0);
	await expect(providers(page).getByRole("menuitemradio")).toHaveCount(19);
	const openai = providers(page).getByRole("menuitemradio", { name: "OpenAI", exact: true });
	await expect(openai).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(providers(page).getByRole("menuitemradio").nth(1)).toBeFocused();
	await page.keyboard.press("ArrowUp");
	await expect(openai).toBeFocused();
	await page.keyboard.press("ArrowRight");
	await expect(modelMenu(page).locator("input")).toHaveCount(0);
	await expect(modelMenu(page).getByRole("menuitemradio")).toHaveCount(30);
	await expect(modelMenu(page).getByRole("menuitemradio").nth(1)).toBeFocused();
	await page.keyboard.press("ArrowLeft");
	await expect(modelMenu(page)).toHaveCount(0);
	await expect(openai).toBeFocused();
	await page.keyboard.press("Enter");
	await page.keyboard.press("Escape");
	await expect(openai).toBeFocused();
	await page.keyboard.press("Enter");
	await page.keyboard.press("3");
	await expect(page.getByTestId("calls")).toContainText('"modelRequests":1');
	await expect(modelTrigger(page)).toBeDisabled();
	await expect(providers(page)).toHaveCount(0);
	await page.getByTestId("finish-model").click();
	await expect(modelTrigger(page)).toBeEnabled();
	await expect(modelTrigger(page)).toContainText("Fixture Model 03");
	await expect(page.getByTestId("calls")).toContainText('"selectedModel":"fixture-3"');
	await modelTrigger(page).click();
	await page.keyboard.press("Escape");
	await expect(modelTrigger(page)).toBeFocused();
	await expect(providers(page)).toHaveCount(0);
});

test("long lists scroll to focused rows, outside dismissal and editor typing remain independent", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 1000, height: 700 });
	await page.goto(url);
	await page.getByTestId("external-open").click();
	await expect(providers(page).getByRole("menuitemradio").first()).toBeFocused();
	await page.keyboard.press("End");
	const lastProvider = providers(page).getByRole("menuitemradio").last();
	await expect(lastProvider).toBeFocused();
	expect(await providers(page).evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
	await page.keyboard.press("Home");
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("End");
	const lastModel = modelMenu(page).getByRole("menuitemradio").last();
	await expect(lastModel).toBeFocused();
	expect(await modelMenu(page).evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
	await assertInViewport(page, ".model-selector-popover, .model-selector-submenu");
	await page.screenshot({ path: info.outputPath("model-long-list.png"), animations: "disabled" });
	const editor = page.getByRole("textbox", { name: "Fixture editor" });
	await editor.focus();
	await page.keyboard.type("3");
	await page.evaluate(() => window.dispatchEvent(new Event("fixture-model-refresh")));
	await expect(editor).toBeFocused();
	await expect(editor).toHaveValue("3");
	await expect(page.getByTestId("calls")).toContainText('"modelRequests":0');
	await page.getByTestId("outside").click();
	await expect(providers(page)).toHaveCount(0);
	await expect(page.getByTestId("outside")).toBeFocused();
	await page.getByTestId("external-open").click();
	await expect(providers(page)).toBeVisible();
	await page.getByTestId("external-close").click();
	await expect(providers(page)).toHaveCount(0);
});

for (const reduced of [false, true]) {
	test(`${reduced ? "reduced" : "normal"} narrow selectors use distinct permission icons and stay within viewport`, async ({
		page,
	}, info) => {
		await page.setViewportSize({ width: 420, height: 650 });
		await page.goto(`${url}/?theme=${reduced ? "light" : "dark"}${reduced ? "&reduced" : ""}`);
		const icons: string[] = [];
		for (const index of [0, 1, 2]) {
			await permissionTrigger(page).click();
			await expect(permissionOption(page, 0)).toContainText(
				"Runs in the workspace sandbox and asks you when approval is needed.",
			);
			await expect(permissionOption(page, 1)).toContainText("The current model reviews risky actions when needed.");
			await expect(permissionOption(page, 2)).toContainText("Runs without a sandbox or tool approvals");
			await assertInViewport(page, ".permission-selector-popover");
			if (index === 2)
				await page.screenshot({
					path: info.outputPath(`permissions-${reduced ? "reduced" : "normal"}-420.png`),
					animations: "disabled",
				});
			if (reduced)
				await expect(page.getByRole("menu", { name: "Permissions", exact: true })).toHaveCSS(
					"animation-name",
					"none",
				);
			await permissionOption(page, index).click();
			icons.push(
				await permissionTrigger(page)
					.locator("svg")
					.first()
					.evaluate((element) => element.innerHTML),
			);
		}
		expect(new Set(icons).size).toBe(3);
		const trash = page.getByRole("button", { name: "Fixture trash preview" }).locator("svg");
		await expect(trash).toHaveCount(1);
		expect(await trash.getAttribute("class")).toContain("reicon");
		expect(await trash.locator("path, polyline, line, rect").count()).toBeGreaterThan(0);
		await modelTrigger(page).click();
		await providers(page).getByRole("menuitemradio", { name: "OpenAI", exact: true }).click();
		await assertInViewport(page, ".model-selector-popover, .model-selector-submenu");
		if (reduced) {
			await expect(providers(page)).toHaveCSS("animation-name", "none");
			await expect(modelMenu(page)).toHaveCSS("animation-name", "none");
		}
		await page.screenshot({
			path: info.outputPath(`selectors-${reduced ? "reduced" : "normal"}-420.png`),
			animations: "disabled",
		});
	});
}

test("missing sandbox disables Ask/Auto and parent constraint retains the selected Full preset", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 620, height: 650 });
	await page.goto(`${url}/?missing-sandbox`);
	await expect(page.locator(".permission-selector-status")).toContainText(
		"Ask and Auto stay disabled instead of running on the host",
	);
	await permissionTrigger(page).click();
	await expect(permissionOption(page, 0)).toBeDisabled();
	await expect(permissionOption(page, 1)).toBeDisabled();
	await expect(permissionOption(page, 2)).toBeEnabled();
	await expect(permissionOption(page, 2)).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(permissionOption(page, 2)).toBeFocused();
	await permissionOption(page, 0).evaluate((element: HTMLButtonElement) => element.click());
	await expect(page.getByTestId("calls")).toContainText('"permissionRequests":0');
	await page.screenshot({ path: info.outputPath("permissions-missing-sandbox.png"), animations: "disabled" });
	await page.keyboard.press("Escape");
	await expect(permissionTrigger(page)).toBeFocused();
	await page.goto(`${url}/?parent`);
	await expect(page.locator(".permission-selector-status")).toContainText(
		"A parent session limits the effective permissions",
	);
	await permissionTrigger(page).click();
	await expect(permissionOption(page, 2)).toHaveAttribute("aria-checked", "true");
	await expect(page.locator(".permission-selector-note")).toContainText(
		"A parent session limits the effective permissions",
	);
	await expect(page.getByTestId("calls")).toContainText('"permissionRequests":0');
});

test("wide viewport uses the real narrow workspace pane as the menu sizing boundary", async ({ page }, info) => {
	await page.setViewportSize({ width: 1000, height: 700 });
	await page.goto(`${url}/?pane`);
	const pane = page.getByTestId("fixture-pane");
	await expect(pane).toHaveCSS("container-type", "inline-size");
	await modelTrigger(page).click();
	await page.keyboard.press("ArrowRight");
	await assertInViewport(page, ".model-selector-popover, .model-selector-submenu");
	const bounds = await page.locator(".model-selector-popover, .model-selector-submenu").evaluateAll((elements) =>
		elements.map((element) => {
			const box = element.getBoundingClientRect();
			const pane = element.closest(".workspace-pane")!.getBoundingClientRect();
			return {
				left: box.left,
				right: box.right,
				top: box.top,
				bottom: box.bottom,
				paneLeft: pane.left,
				paneRight: pane.right,
				paneTop: pane.top,
				paneBottom: pane.bottom,
				paneWidth: pane.width,
				width: box.width,
			};
		}),
	);
	expect(bounds).toHaveLength(2);
	for (const box of bounds) {
		expect(box.paneWidth).toBe(420);
		expect(box.left).toBeGreaterThanOrEqual(box.paneLeft);
		expect(box.right).toBeLessThanOrEqual(box.paneRight);
		expect(box.top).toBeGreaterThanOrEqual(box.paneTop);
		expect(box.bottom).toBeLessThanOrEqual(box.paneBottom);
	}
	await page.screenshot({ path: info.outputPath("selectors-workspace-pane-420.png"), animations: "disabled" });
});

test("Tab and Shift+Tab leave the model menu through real surrounding controls", async ({ page }) => {
	await page.goto(url);
	await modelTrigger(page).click();
	await page.keyboard.press("ArrowRight");
	await page.keyboard.press("Tab");
	await expect(providers(page)).toHaveCount(0);
	await expect(modelMenu(page)).toHaveCount(0);
	await expect(page.getByTestId("after-model")).toBeFocused();
	await page.keyboard.press("Shift+Tab");
	await expect(modelTrigger(page)).toBeFocused();
	await modelTrigger(page).click();
	await page.keyboard.press("Shift+Tab");
	await expect(providers(page)).toHaveCount(0);
	await expect(modelTrigger(page)).toBeFocused();
	await page.keyboard.press("Shift+Tab");
	await expect(page.getByRole("button", { name: "Fixture trash preview", exact: true })).toBeFocused();
});
