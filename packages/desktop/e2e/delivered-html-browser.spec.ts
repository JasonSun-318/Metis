import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, test } from "@playwright/test";
import { launchPermissionApp } from "./fixtures/permission-app.ts";

const html = `<!doctype html>
<meta charset="utf-8">
<title>Delivered browser demo</title>
<link rel="stylesheet" href="./assets/style.css">
<img src="./assets/mark.svg" alt="Relative image">
<div id="motion"></div>
<button>Run interaction</button>
<output></output>
<a href="./assets/details.htm">Read details</a>
<script src="./assets/app.js" defer></script>
<script id="outside" src="../outside/outside.js" onerror="this.dataset.result = 'blocked'" onload="this.dataset.result = 'loaded'"></script>
<script id="module" type="module" src="./assets/module.mjs" onerror="this.dataset.result = 'blocked'" onload="this.dataset.result = 'loaded'"></script>`;

for (const mode of ["chat", "code"] as const) {
	test(`${mode}: delivered HTML runs as an interactive browser page`, async () => {
		test.setTimeout(90_000);
		const app = await launchPermissionApp({
			mode,
			preset: "full",
			locale: "en",
			seed: async ({ projectDir, outsideDir }) => {
				const assets = path.join(projectDir, "assets");
				await mkdir(assets);
				await Promise.all([
					writeFile(path.join(projectDir, "demo page.html"), html),
					writeFile(path.join(projectDir, "notes.txt"), "Text preview stays in place"),
					writeFile(
						path.join(assets, "style.css"),
						"#motion { color: rgb(10, 20, 30); animation: pulse 1s infinite } @keyframes pulse { to { opacity: .2 } }",
					),
					writeFile(
						path.join(assets, "mark.svg"),
						'<svg xmlns="http://www.w3.org/2000/svg" width="13" height="8"><rect width="13" height="8"/></svg>',
					),
					writeFile(path.join(assets, "details.htm"), "<title>Relative page</title><h1>Relative page</h1>"),
					writeFile(path.join(assets, "module.mjs"), "export const loaded = true;"),
					writeFile(path.join(assets, "data.json"), '{"text":"JSON loaded"}'),
					writeFile(path.join(outsideDir, "outside.js"), "window.outsideFileLoaded = true;"),
					writeFile(
						path.join(assets, "app.js"),
						`const button = document.querySelector("button");
button.addEventListener("click", () => {
  document.querySelector("output").textContent = "Relative script handled the click";
});
button.dataset.ready = "true";
fetch("./assets/data.json").then(
  () => { document.body.dataset.fileFetch = "loaded"; },
  () => { document.body.dataset.fileFetch = "blocked"; },
);`,
					),
				]);
			},
			tools: (marker, { projectDir }) => ({
				name: "deliver_file",
				arguments: { path: path.join(projectDir, marker === "case-html" ? "demo page.html" : "notes.txt") },
			}),
		});
		try {
			await app.submit("case-html");
			await app.waitDone("case-html");
			const card = app.page.locator(".transcript-delivered-file-card").filter({ hasText: "demo page" });
			await expect(card.getByRole("button", { name: "Open in browser", exact: true })).toBeVisible();
			await card.locator("strong").click();
			const expectedUrl = pathToFileURL(path.join(app.projectDir, "demo page.html")).href;
			const address = app.page.getByRole("textbox", { name: "Browser address", exact: true });
			await expect(address).toHaveValue(expectedUrl);
			const localPages = () =>
				app.page
					.context()
					.browser()
					?.contexts()
					.flatMap((context) => context.pages())
					.filter((page) => page.url() === expectedUrl) ?? [];
			await expect.poll(() => localPages().length).toBe(1);
			const [browserPage] = localPages();
			if (!browserPage) throw new Error("Metis did not create a browser page for the delivered file");
			await expect(browserPage).toHaveTitle("Delivered browser demo");
			expect(
				await browserPage.evaluate(() => ({
					topLevel: window.top === window,
					hasAppBridge: "metis" in window,
					hasNode: "require" in window,
				})),
			).toEqual({ topLevel: true, hasAppBridge: false, hasNode: false });
			const motion = browserPage.locator("#motion");
			await expect(motion).toHaveCSS("color", "rgb(10, 20, 30)");
			await expect
				.poll(() => motion.evaluate((element) => Number(element.getAnimations()[0]?.currentTime ?? 0)))
				.toBeGreaterThan(50);
			await expect
				.poll(() =>
					browserPage
						.getByRole("img", { name: "Relative image" })
						.evaluate((img) => (img as HTMLImageElement).naturalWidth),
				)
				.toBe(13);
			const button = browserPage.getByRole("button", { name: "Run interaction" });
			await expect(button).toHaveAttribute("data-ready", "true");
			await button.click();
			await expect(browserPage.locator("output")).toHaveText("Relative script handled the click");
			await expect(browserPage.locator("#outside")).toHaveAttribute("data-result", "blocked");
			// Keep Chromium's normal file origin restrictions in the packaged app.
			await expect(browserPage.locator("#module")).toHaveAttribute("data-result", "blocked");
			await expect(browserPage.locator("body")).toHaveAttribute("data-file-fetch", "blocked");

			await browserPage.getByRole("link", { name: "Read details" }).click();
			await expect(browserPage.getByRole("heading", { name: "Relative page" })).toBeVisible();
			await expect(address).toHaveValue(pathToFileURL(path.join(app.projectDir, "assets", "details.htm")).href);
			await app.page.getByRole("button", { name: "Back", exact: true }).click();
			await expect(browserPage).toHaveTitle("Delivered browser demo");

			await app.page.getByRole("button", { name: "Source code", exact: true }).click();
			await expect(app.page.locator(".preview-html-source")).toContainText('<script src="./assets/app.js"');
			await expect(app.page.locator("iframe.preview-html-frame")).toHaveCount(0);
			await card.getByRole("button", { name: "Open in browser", exact: true }).click();
			await expect(app.page.locator(".browser-view-anchor")).toBeVisible();
			expect(localPages()).toEqual([browserPage]);

			await app.submit("case-text");
			await app.waitDone("case-text");
			await app.page
				.locator(".transcript-delivered-file-card")
				.filter({ hasText: "notes" })
				.getByRole("button", { name: "Preview", exact: true })
				.click();
			await expect(app.page.locator(".universal-previewer:visible")).toContainText("Text preview stays in place");
		} finally {
			await app.close();
		}
	});
}
