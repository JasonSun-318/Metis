import { build } from "esbuild";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

test.use({ channel: "chrome" });

const fixturePath = path.join(__dirname, "new-task-home-scroll.fixture.tsx");
const desktopRoot = path.resolve(path.dirname(fixturePath), "..");

interface FixtureServer {
	readonly server: Server;
	readonly url: string;
}

interface RectSnapshot {
	top: number;
	bottom: number;
	left: number;
	width: number;
	height: number;
}

interface HomeSnapshot {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
	headingText: string;
	heading: RectSnapshot;
	composer: RectSnapshot;
	workspace: RectSnapshot;
	shortcuts: readonly RectSnapshot[];
}

async function buildFixture(outputDir: string): Promise<string> {
	const outputFile = path.join(outputDir, "new-task-home-scroll.js");
	await build({
		bundle: true,
		entryPoints: [fixturePath],
		format: "esm",
		jsx: "automatic",
		loader: { ".css": "empty" },
		outfile: outputFile,
		platform: "browser",
		sourcemap: false,
		target: "es2022",
	});
	const cssOutput = path.join(outputDir, "new-task-home-scroll.css");
	await build({
		bundle: true,
		minify: false,
		outfile: cssOutput,
		platform: "browser",
		stdin: {
			contents: `@import "${path.resolve(desktopRoot, "src/renderer/styles/tokens.css").replaceAll("\\", "/")}";\n@import "${path.resolve(desktopRoot, "src/renderer/styles/app.css").replaceAll("\\", "/")}";`,
			loader: "css",
			resolveDir: outputDir,
			sourcefile: "bundle-input.css",
		},
	});
	const generatedCss = path.join(outputDir, "new-task-home-scroll.css");
	if (!existsSync(generatedCss)) throw new Error(`Fixture CSS was not generated: ${generatedCss}`);
	return outputFile;
}

async function startFixtureServer(outputDir: string, scriptPath: string): Promise<FixtureServer> {
	const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/new-task-home-scroll.css"><style>html,body,#root{display:flex;flex:1;min-height:0}#root{width:100%;padding-left:296px;}</style></head><body><div id="root"></div>
<script type="module" src="/${path.basename(scriptPath)}"></script></body></html>`;
	await writeFile(path.join(outputDir, "index.html"), html);
	const server = createServer((request, response) => {
		const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
		const file = pathname === "/" ? "index.html" : pathname.slice(1);
		const filePath = path.join(outputDir, file);
		if (pathname === "/favicon.ico") {
			response.writeHead(204).end();
			return;
		}
		if (!filePath.startsWith(`${outputDir}${path.sep}`) || !existsSync(filePath)) {
			response.writeHead(404).end();
			return;
		}
		const contentType = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html";
		response.writeHead(200, { "content-type": contentType });
		createReadStream(filePath).pipe(response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Fixture server did not bind to TCP");
	return { server, url: `http://127.0.0.1:${address.port}` };
}

async function snapshot(page: Page): Promise<HomeSnapshot> {
	return page.evaluate(() => {
		const rect = (element: Element | null): RectSnapshot => {
			const box = element?.getBoundingClientRect();
			if (!box) throw new Error("Expected home geometry element");
			return { top: box.top, bottom: box.bottom, left: box.left, width: box.width, height: box.height };
		};
		const scroll = document.querySelector<HTMLElement>(".new-task-home-scroll")!;
		return {
			scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight,
			headingText: document.querySelector(".new-task-home-heading h1")?.textContent?.trim() ?? "",
			heading: rect(document.querySelector(".new-task-home-heading h1")),
			composer: rect(document.querySelector(".new-task-home-composer")),
			workspace: rect(document.querySelector(".new-task-home-project-control")),
			shortcuts: Array.from(document.querySelectorAll(".new-task-starter-grid > button"), (button) => rect(button)),
		};
	});
}

async function waitForHome(page: Page): Promise<void> {
	await expect(page.locator(".new-task-home")).toBeVisible();
	await expect(page.locator(".new-task-starter")).toHaveCount(4);
	await expect(page.locator("#composer-input")).toBeVisible();
	await page.evaluate(() => document.fonts.ready);
}

function monitorPageErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
	page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
	return errors;
}

async function assertWithinViewport(page: Page, locator: string): Promise<void> {
	const box = await page.locator(locator).boundingBox();
	const size = page.viewportSize()!;
	if (!box) throw new Error(`Missing visible control ${locator}`);
	expect(box.x).toBeGreaterThanOrEqual(0);
	expect(box.y).toBeGreaterThanOrEqual(0);
	expect(box.x + box.width).toBeLessThanOrEqual(size.width + 1);
	expect(box.y + box.height).toBeLessThanOrEqual(size.height + 1);
}

test.describe.configure({ mode: "serial", timeout: 60_000 });
test.describe("new task home workspace and compact layout", () => {
	let fixtureRoot: string;
	let fixture: FixtureServer;
	test.beforeAll(async () => {
		fixtureRoot = await mkdtemp(path.join(tmpdir(), "metis-new-task-home-e2e-"));
		fixture = await startFixtureServer(fixtureRoot, await buildFixture(fixtureRoot));
	});
	test.afterAll(async () => {
		if (fixture) await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
		if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
	});

	for (const mode of ["chat", "code"] as const) {
		for (const viewport of [{ width: 1280, height: 840 }, { width: 900, height: 640 }] as const) {
			test(`${mode} ${viewport.width}x${viewport.height} shows the workspace and task shortcuts in the first screen`, async ({ page }, testInfo) => {
				const errors = monitorPageErrors(page);
				await page.setViewportSize(viewport);
				await page.goto(`${fixture.url}/?mode=${mode}`, { waitUntil: "load" });
				await waitForHome(page);
				await expect(page.locator(".new-task-home")).toHaveCSS("background-color", "rgb(20, 20, 20)");
				await expect(page.locator(".new-task-home-composer")).toHaveCSS("background-color", "rgb(24, 24, 24)");
				const layout = await snapshot(page);
				expect(layout.headingText).toContain("QA User");
				expect(layout.headingText).not.toContain("{{name}}");
				expect(layout.heading.top).toBeGreaterThanOrEqual(24);
				expect(layout.composer.top - layout.heading.bottom).toBeGreaterThanOrEqual(26);
				expect(layout.composer.top - layout.heading.bottom).toBeLessThanOrEqual(30);
				expect(layout.composer.width).toBeLessThanOrEqual(681);
				expect(layout.workspace.height).toBeGreaterThanOrEqual(36);
				expect(layout.workspace.bottom).toBeLessThanOrEqual(layout.composer.bottom);
				expect(layout.shortcuts).toHaveLength(5);
				for (const shortcut of layout.shortcuts) expect(shortcut.bottom).toBeLessThanOrEqual(viewport.height - 8);
				await assertWithinViewport(page, ".home-project-picker-browse");
				await assertWithinViewport(page, ".composer-send");
				expect(await page.locator(".new-task-home-scroll").evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
				await testInfo.attach("home-layout", { body: JSON.stringify(layout, null, 2), contentType: "application/json" });
				await page.screenshot({ path: testInfo.outputPath(`${mode}-${viewport.width}x${viewport.height}-initial.png`), animations: "disabled" });
				await page.locator(".home-project-picker-browse").click();
				await expect(page.locator(".home-project-picker-browse")).toHaveAttribute("title", "/tmp/metis-home-qa");
				await page.locator(".new-task-more-trigger").click();
				await expect(page.locator(".new-task-starter")).toHaveCount(mode === "chat" ? 9 : 6);
				await page.screenshot({ path: testInfo.outputPath(`${mode}-${viewport.width}x${viewport.height}-more.png`), animations: "disabled" });
				await page.locator(".new-task-more-trigger").click();
				await expect(page.locator(".new-task-starter")).toHaveCount(4);
				if (viewport.width >= 1280) {
					await page.evaluate(() => { document.documentElement.dataset.theme = "light"; });
					await expect(page.locator(".new-task-home")).toHaveCSS("background-color", "rgb(250, 249, 246)");
					await expect(page.locator(".new-task-home-composer")).toHaveCSS("background-color", "rgb(252, 252, 250)");
					await page.screenshot({ path: testInfo.outputPath(`${mode}-${viewport.width}x${viewport.height}-light.png`), animations: "disabled" });
				}
				expect(errors).toEqual([]);
			});
		}
	}

	test("Code requires a workspace and retains its draft when a directory is chosen", async ({ page }) => {
		const errors = monitorPageErrors(page);
		await page.setViewportSize({ width: 900, height: 640 });
		await page.goto(`${fixture.url}/?mode=code&folder=none`, { waitUntil: "load" });
		await waitForHome(page);
		await page.locator("#composer-input").fill("Implement my feature");
		await expect(page.locator(".composer-send")).toBeDisabled();
		await page.locator(".home-project-picker-browse").click();
		await expect(page.locator(".composer-send")).toBeEnabled();
		await expect(page.locator("#composer-input")).toHaveText("Implement my feature");
		await page.locator(".composer-send").click();
		await expect(page.locator("output[data-submission-count]")).toHaveAttribute("data-submission-count", "1");
		expect(errors).toEqual([]);
	});

	test("additional tasks prefill without submitting and collapse back to the shortcuts", async ({ page }) => {
		await page.setViewportSize({ width: 900, height: 640 });
		await page.goto(`${fixture.url}/?mode=chat&motion=reduced`, { waitUntil: "load" });
		await waitForHome(page);
		await page.locator("#composer-input").fill("My draft");
		await page.locator(".new-task-more-trigger").click();
		await expect(page.locator("#composer-input")).toHaveText("My draft");
		await page.locator('[data-starter-id="document"]').click();
		await expect(page.locator("#composer-input")).toContainText("整理");
		await expect(page.locator("#composer-input")).toBeFocused();
		await expect(page.locator(".new-task-more-trigger")).toHaveAttribute("aria-expanded", "false");
		await expect(page.locator("output[data-submission-count]")).toHaveAttribute("data-submission-count", "0");
	});

	test("keyboard users can reach every additional task and close it with Escape", async ({ page }, testInfo) => {
		await page.setViewportSize({ width: 900, height: 640 });
		await page.goto(`${fixture.url}/?mode=code&motion=reduced`, { waitUntil: "load" });
		await waitForHome(page);
		await page.locator(".new-task-more-trigger").click();
		await page.keyboard.press("Tab");
		await expect(page.locator('[data-starter-id="test"]')).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(page.locator('[data-starter-id="performance"]')).toBeFocused();
		await assertWithinViewport(page, '[data-starter-id="performance"]');
		await expect(page.locator('[data-starter-id="performance"]')).toHaveCSS("outline-style", "solid");
		await page.screenshot({ path: testInfo.outputPath("code-keyboard-focus.png"), animations: "disabled" });
		await page.keyboard.press("Escape");
		await expect(page.locator(".new-task-more-trigger")).toBeFocused();
		await expect(page.locator(".new-task-more-trigger")).toHaveAttribute("aria-expanded", "false");
	});

	test("multiline text keeps workspace selection reachable and preserves the text", async ({ page }, testInfo) => {
		const errors = monitorPageErrors(page);
		await page.setViewportSize({ width: 900, height: 640 });
		await page.goto(`${fixture.url}/?mode=chat&motion=reduced`, { waitUntil: "load" });
		await waitForHome(page);
		const initial = await snapshot(page);
		const text = Array.from({ length: 12 }, (_, index) => `line ${index + 1}: outline the next useful step`).join("\n");
		await page.locator("#composer-input").fill(text);
		await expect.poll(async () => (await snapshot(page)).composer.height).toBeGreaterThan(initial.composer.height + 10);
		await page.locator(".home-project-picker-browse").scrollIntoViewIfNeeded();
		await assertWithinViewport(page, ".home-project-picker-browse");
		await page.locator(".home-project-picker-browse").click();
		await expect.poll(() => page.locator("#composer-input").innerText()).toBe(text);
		await expect(page.locator("output[data-submission-count]")).toHaveAttribute("data-submission-count", "0");
		await page.screenshot({ path: testInfo.outputPath("chat-multiline-workspace.png"), animations: "disabled" });
		expect(errors).toEqual([]);
	});

	test("English home follows the compact reference proportions in a short window", async ({ page }, testInfo) => {
		await page.setViewportSize({ width: 1200, height: 515 });
		await page.goto(`${fixture.url}/?mode=chat&locale=en`, { waitUntil: "load" });
		await waitForHome(page);
		await expect(page.locator(".new-task-home")).toHaveCSS("font-family", /ui-sans-serif/u);
		const layout = await snapshot(page);
		expect(new Set(layout.shortcuts.map((button) => Math.round(button.top))).size).toBe(1);
		await assertWithinViewport(page, ".home-project-picker-browse");
		await assertWithinViewport(page, ".new-task-more-trigger");
		await page.screenshot({ path: testInfo.outputPath("chat-english-reference-size.png"), animations: "disabled" });
	});
});
