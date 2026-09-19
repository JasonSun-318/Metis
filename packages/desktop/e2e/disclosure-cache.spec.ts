import { build } from "esbuild";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

test.use({ channel: "chrome" });
let directory: string;
let server: Server;
let url: string;
test.beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "metis-disclosure-"));
	await build({ bundle: true, entryPoints: [path.join(__dirname, "disclosure-cache.fixture.tsx")],
		outfile: path.join(directory, "fixture.js"), format: "esm", jsx: "automatic", platform: "browser", target: "es2022" });
	server = createServer(async (request, response) => {
		const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
		if (pathname === "/") {
			response.setHeader("content-type", "text/html");
			response.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root" style="width:100%"></div><script type="module" src="/fixture.js"></script></body></html>');
		} else if (pathname === "/fixture.js" || pathname === "/fixture.css") {
			response.setHeader("content-type", pathname.endsWith("css") ? "text/css" : "text/javascript");
			response.end(await readFile(path.join(directory, pathname.slice(1))));
		} else response.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture port");
	url = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
	await new Promise<void>((resolve) => server?.close(() => resolve()));
	if (directory) await rm(directory, { recursive: true, force: true });
});

test("answers animate in both directions, support keyboard, and respect reduced motion", async ({ page }) => {
	await page.goto(url);
	const summary = page.locator(".ask-user-answer-summary > summary");
	const drawer = page.locator(".ask-user-answer-summary .transcript-drawer");
	await expect(drawer).toHaveJSProperty("inert", true);
	const sampleToggle = () => summary.evaluate(async (element) => {
		const body = element.nextElementSibling!;
		const heights: number[] = [];
		(element as HTMLElement).click();
		const until = performance.now() + 400;
		while (performance.now() < until) {
			await new Promise(requestAnimationFrame);
			heights.push(body.getBoundingClientRect().height);
		}
		return heights;
	});
	const opening = await sampleToggle();
	const expanded = opening.at(-1)!;
	expect(expanded).toBeGreaterThan(60);
	expect(opening.some((height) => height > 1 && height < expanded - 1)).toBe(true);
	await expect(drawer).toHaveJSProperty("inert", false);
	const closing = await sampleToggle();
	expect(closing.some((height) => height > 1 && height < expanded - 1)).toBe(true);
	expect(closing.at(-1)).toBe(0);
	await expect(drawer).toHaveJSProperty("inert", true);
	await summary.focus();
	await page.keyboard.press("Enter");
	await expect(drawer).toHaveAttribute("data-open", "true");
	await page.goto(`${url}?motion=reduced`);
	await summary.click();
	await expect(drawer).toHaveJSProperty("inert", false);
	expect(await drawer.evaluate((node) => parseFloat(getComputedStyle(node).transitionDuration))).toBeLessThan(0.001);
});

for (const width of [1000, 390]) {
	test(`cache statistics stay secondary and fit at ${width}px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width, height: 700 });
		await page.goto(url);
		const cache = page.locator(".context-usage-cache");
		await expect(cache).toContainText("99%");
		await expect(cache.locator('[role="progressbar"], .context-usage-cache-meter')).toHaveCount(0);
		await page.getByRole("button", { name: "缓存命中率说明" }).focus();
		const tooltip = page.getByRole("tooltip");
		await expect(tooltip).toBeVisible();
		const box = await tooltip.boundingBox();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(width);
		await page.keyboard.press("Escape");
		await expect(tooltip).toBeHidden();
		await page.locator(".ask-user-answer-summary > summary").click();
		await expect(page.locator(".ask-user-answer-summary .transcript-drawer")).toHaveAttribute("data-open", "true");
		await expect.poll(() => page.locator(".ask-user-answer-summary .transcript-drawer").evaluate((node) => node.getBoundingClientRect().height)).toBeGreaterThan(60);
		await page.screenshot({ path: testInfo.outputPath(`cache-drawer-${width}.png`), animations: "disabled" });
	});
}
