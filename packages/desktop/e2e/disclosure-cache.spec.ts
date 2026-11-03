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
	// Drive the toggle from the test side and record the drawer transition lifecycle
	// before the click. Frame-by-frame height sampling is not deterministic: a loaded
	// CI machine can stall the renderer for longer than the whole 280ms transition, so
	// the sampled heights miss every intermediate value.
	const recordTransitions = () =>
		page.evaluate(() => {
			const body = document.querySelector(".ask-user-answer-summary .transcript-drawer");
			if (!body) throw new Error("Missing answer drawer");
			const state = window as typeof window & {
				__drawerTransitions?: Array<{ property: string }>;
				__drawerListeners?: Array<{ target: Element; type: string; listener: EventListener }>;
			};
			state.__drawerTransitions = [];
			state.__drawerListeners = [];
			// Only transitionstart feeds the assertion below; the other lifecycle
			// events recorded data that nothing read.
			const type = "transitionstart";
			const listener: EventListener = (event) => {
				const transition = event as TransitionEvent;
				if (transition.target !== body) return;
				state.__drawerTransitions?.push({ property: transition.propertyName });
			};
			body.addEventListener(type, listener);
			state.__drawerListeners.push({ target: body, type, listener });
		});
	const readTransitions = () =>
		page.evaluate(
			() =>
				(window as typeof window & { __drawerTransitions?: Array<{ property: string }> })
					.__drawerTransitions ?? [],
		);
	const stopRecording = () =>
		page.evaluate(() => {
			const state = window as typeof window & {
				__drawerListeners?: Array<{ target: Element; type: string; listener: EventListener }>;
			};
			for (const entry of state.__drawerListeners ?? []) entry.target.removeEventListener(entry.type, entry.listener);
			state.__drawerListeners = [];
		});
	const waitForDrawerTransition = async () => {
		await expect
			.poll(
				async () =>
					(await readTransitions()).some((entry) => entry.property === "grid-template-rows"),
				{ timeout: 5_000 },
			)
			.toBe(true);
		await drawer.evaluate(async (element) => {
			// Drain the drawer's own transitions; extra passes cover a second property
			// starting on a later frame. A transition that already finished leaves an
			// empty list and resolves immediately.
			for (let pass = 0; pass < 8; pass += 1) {
				const running = element.getAnimations().filter((animation) => animation.playState === "running");
				if (running.length === 0) return;
				await Promise.all(running.map((animation) => animation.finished.catch(() => undefined)));
			}
		});
	};

	await recordTransitions();
	await summary.click();
	await expect(drawer).toHaveJSProperty("inert", false);
	await waitForDrawerTransition();
	expect(await drawer.evaluate((element) => element.getBoundingClientRect().height)).toBeGreaterThan(60);
	await stopRecording();

	await recordTransitions();
	await summary.click();
	await expect(drawer).toHaveJSProperty("inert", true);
	await waitForDrawerTransition();
	expect(await drawer.evaluate((element) => element.getBoundingClientRect().height)).toBe(0);
	await stopRecording();
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
