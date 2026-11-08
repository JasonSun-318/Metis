import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron, expect, test } from "@playwright/test";
import { build } from "esbuild";

test.use({ channel: "chrome" });
let server: Server;
let directory: string;
let url: string;
test.beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "metis-image-conversation-"));
	await build({
		entryPoints: [path.join(__dirname, "image-generation-conversation.fixture.tsx")],
		bundle: true,
		format: "esm",
		jsx: "automatic",
		platform: "browser",
		target: "es2022",
		outfile: path.join(directory, "fixture.js"),
	});
	await build({
		stdin: {
			contents: ["tokens.css", "app.css", "markdown.css", "generated-images.css"]
				.map((file) => `@import "${path.resolve(__dirname, "../src/renderer/styles", file)}";`)
				.join("\n"),
			loader: "css",
			resolveDir: directory,
		},
		bundle: true,
		loader: { ".woff": "file", ".woff2": "file", ".ttf": "file", ".svg": "file" },
		outfile: path.join(directory, "fixture.css"),
	});
	await writeFile(
		path.join(directory, "index.html"),
		`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"><style>body{overflow:auto;font-family:Inter,-apple-system,sans-serif;background:var(--conversation-bg);color:var(--text)}#root{max-width:900px;margin:0 auto}.fixture-toolbar{display:flex;align-items:center;gap:16px;padding:16px 24px;border-bottom:1px solid var(--border);font-size:12px;color:var(--text-muted)}.fixture-toolbar button{background:var(--surface-02);color:var(--text);border:1px solid var(--border);border-radius:8px;padding:6px 12px}main.transcript-turn,.transcript-code main.code-transcript-turn{position:relative;padding:28px 24px;display:block}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`,
	);
	server = createServer((request, response) => {
		const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
		const file = pathname === "/" ? "index.html" : path.basename(pathname);
		if (!/^(index\.html|fixture\.(?:js|css)|[^/]+\.(?:woff2?|ttf|svg))$/.test(file)) {
			response.writeHead(204).end();
			return;
		}
		response.writeHead(200, {
			"Content-Type": file.endsWith(".js")
				? "text/javascript"
				: file.endsWith(".css")
					? "text/css"
					: file.endsWith(".html")
						? "text/html"
						: "application/octet-stream",
		});
		createReadStream(path.join(directory, file))
			.on("error", () => response.destroy())
			.pipe(response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Fixture did not start");
	url = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	if (directory) await rm(directory, { recursive: true, force: true });
});

for (const mode of ["chat", "code"])
	for (const theme of ["dark", "light"]) {
		test(`${mode} ${theme}: generation stays in place and images fit wide and narrow conversations`, async ({
			page,
		}, info) => {
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			for (const width of [1100, 360]) {
				await page.setViewportSize({ width, height: 950 });
				await page.goto(`${url}?mode=${mode}&theme=${theme}&count=4`);
				await expect(page.locator(".generated-image-placeholder")).toHaveCount(4);
				await expect(page.locator(".generated-image-caption")).toHaveCount(0);
				const initial = await page.locator(".generated-image-grid").boundingBox();
				await expect(page.locator(".generated-images")).not.toContainText("%");
				await expect(page.locator(".execution-chain,.code-execution")).toHaveCount(0);
				await page.screenshot({ path: info.outputPath(`${mode}-${theme}-${width}-loading.png`) });
				await page.getByRole("button", { name: "Complete" }).click();
				await expect(page.locator(".generated-image-tile img")).toHaveCount(4);
				await expect
					.poll(() =>
						page
							.locator(".generated-image-tile img")
							.first()
							.evaluate((node) => (node as HTMLImageElement).naturalWidth),
					)
					.toBe(768);
				await expect(page.locator(".generated-image-placeholder")).toHaveCount(0);
				await expect(page.locator(".generated-image-caption")).toHaveCount(0);
				const completed = await page.locator(".generated-image-grid").boundingBox();
				expect(completed?.y).toBeCloseTo(initial!.y, 0);
				expect(completed!.width).toBeGreaterThanOrEqual(initial!.width);
				expect(completed!.height).toBeGreaterThanOrEqual(initial!.height);
				const ordering = await page.locator("main").evaluate((main) => {
					const children = Array.from(main.children);
					const gallery = children.findIndex((node) => node.matches(".generated-images"));
					return {
						before: children
							.slice(0, gallery)
							.map((node) => node.textContent)
							.join(""),
						after: children
							.slice(gallery + 1)
							.map((node) => node.textContent)
							.join(""),
						overflow: main.scrollWidth - main.clientWidth,
					};
				});
				expect(ordering.before).toContain("柔和的色调");
				expect(ordering.after).toContain("画面已完成");
				expect(ordering.overflow).toBe(0);
				await page.screenshot({ path: info.outputPath(`${mode}-${theme}-${width}-completed.png`) });
			}
			expect(errors).toEqual([]);
		});
	}

test("image modal supports original image, keyboard navigation, zoom, save, reveal, edit and close", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 1100, height: 900 });
	await page.goto(`${url}?state=completed&count=2`);
	const first = page.locator(".generated-image-tile").first();
	await expect.poll(() => first.locator("img").evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(768);
	await first.click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog.locator(".generated-image-viewport img")).toHaveAttribute("src", /^blob:/);
	await expect
		.poll(() =>
			dialog.locator(".generated-image-viewport img").evaluate((node) => (node as HTMLImageElement).naturalWidth),
		)
		.toBe(1200);
	await page.keyboard.press("ArrowRight");
	await expect(dialog.locator(".generated-image-filename")).toHaveText("mountain-2.png");
	await dialog.getByRole("button", { name: "放大", exact: true }).click();
	await expect(dialog.getByRole("button", { name: "适应窗口" })).toHaveText("125%");
	await dialog.getByRole("button", { name: "适应窗口" }).click();
	await expect(dialog.getByRole("button", { name: "适应窗口" })).toHaveText("100%");
	const download = page.waitForEvent("download");
	await dialog.getByRole("link", { name: "保存图片" }).click();
	expect((await download).suggestedFilename()).toBe("mountain-2.png");
	await dialog.getByRole("button", { name: "在文件夹中显示" }).click();
	await expect(page.locator("[data-action]")).toHaveAttribute("data-action", "reveal:0000000000000002");
	await page.screenshot({ path: info.outputPath("image-modal-wide.png") });
	await page.setViewportSize({ width: 360, height: 800 });
	await expect.poll(() => dialog.evaluate((node) => node.scrollWidth - node.clientWidth)).toBe(0);
	await page.screenshot({ path: info.outputPath("image-modal-narrow.png") });
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(first).toBeFocused();
	await first.click();
	await page.getByRole("button", { name: "继续编辑图片" }).click();
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.locator("[data-action]")).toHaveAttribute("data-action", "edit:0000000000000001");
	await first.click();
	await page.getByRole("dialog").click({ position: { x: 1, y: 1 } });
	await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("unconfigured is a tool error with a configuration action and partial results remain usable", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 700, height: 700 });
	await page.goto(`${url}?state=unconfigured&theme=light`);
	await expect(page.locator("[data-generation-status=unconfigured]")).toBeVisible();
	await expect(page.getByRole("alert")).toContainText("未配置生图模型");
	await expect(page.locator("[data-transcript-answer]")).toHaveCount(0);
	await page.getByRole("button", { name: "配置生图模型" }).click();
	await expect(page.locator("[data-action]")).toHaveAttribute("data-action", "configure");
	await page.screenshot({ path: info.outputPath("unconfigured.png") });
	await page.goto(`${url}?state=partial&count=4&theme=light`);
	await expect(page.locator(".generated-image-tile img")).toHaveCount(1);
	await expect(page.locator("[data-generation-status=partial]")).toBeVisible();
	await expect(page.getByRole("alert")).toHaveText("部分图片未能生成");
	await page.screenshot({ path: info.outputPath("partial-image.png") });
	for (const state of ["failed", "cancelled"]) {
		await page.goto(`${url}?state=${state}`);
		await expect(page.locator(`[data-generation-status=${state}]`)).toBeVisible();
		await expect(page.locator(".generated-image-placeholder")).toHaveCount(0);
	}
});

test("compact placeholders expand to fit the actual image ratio and progressive results remain usable", async ({
	page,
}, info) => {
	for (const width of [900, 360]) {
		await page.setViewportSize({ width, height: 850 });
		for (const [name, ratio, expectedRatio] of [
			["landscape", "16:9", 16 / 9],
			["portrait", "9:16", 9 / 16],
			["square", "1:1", 1],
		] as const) {
			await page.goto(`${url}?count=1&ratio=${ratio}`);
			const pending = await page.locator(".generated-image-placeholder").boundingBox();
			expect(pending!.width).toBeLessThanOrEqual(180);
			expect(pending!.width / pending!.height).toBeCloseTo(1, 2);
			await page.screenshot({ path: info.outputPath(`single-${name}-${width}-loading.png`) });
			await page.getByRole("button", { name: "Complete" }).click();
			await expect
				.poll(() =>
					page.locator(".generated-image-tile img").evaluate((node) => (node as HTMLImageElement).naturalWidth),
				)
				.toBeGreaterThan(0);
			const image = await page.locator(".generated-image-tile").boundingBox();
			expect(image!.width / image!.height).toBeCloseTo(expectedRatio, 2);
			expect(image!.width).toBeLessThanOrEqual(Math.min(560, width - 48));
			expect(image!.height).toBeLessThanOrEqual(421);
			expect(image!.y).toBeCloseTo(pending!.y, 0);
			await page.screenshot({ path: info.outputPath(`single-${name}-${width}-completed.png`) });
		}
	}
	await page.goto(`${url}?state=completed&ratio=16:9&outputRatio=9:16`);
	const actualImage = await page.locator(".generated-image-tile").boundingBox();
	expect(actualImage!.width / actualImage!.height).toBeCloseTo(9 / 16, 2);
	await page.setViewportSize({ width: 900, height: 850 });
	await page.goto(`${url}?count=4&state=progress`);
	await expect(page.locator(".generated-image-tile img")).toHaveCount(1);
	await expect(page.locator(".generated-image-placeholder")).toHaveCount(3);
	await page.screenshot({ path: info.outputPath("progressive-generation.png") });
	await page.getByRole("button", { name: "Complete" }).click();
	await expect(page.locator(".generated-image-tile img")).toHaveCount(4);
	await expect(page.locator(".generated-image-placeholder")).toHaveCount(0);
});

test("a synchronous preview failure stays in the image and leaves the conversation usable after reload", async ({
	page,
}) => {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.goto(`${url}?state=completed&previewError&ratio=9:16`);
	for (let attempt = 0; attempt < 2; attempt++) {
		await expect(page.locator(".generated-image-preview-state")).toContainText("Preview transport failed");
		await expect(page.locator("main")).toContainText("画面已完成");
		await page.locator(".generated-image-tile").click();
		await expect(page.getByRole("dialog").locator("output")).toContainText("Preview transport failed");
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toHaveCount(0);
		if (attempt === 0) await page.reload();
	}
	expect(errors).toEqual([]);
});

test("thumbnails load near the viewport and release when scrolled away", async ({ page }) => {
	await page.setViewportSize({ width: 900, height: 700 });
	await page.goto(`${url}?state=completed&belowFold`);
	await expect(page.locator(".generated-image-tile")).toHaveCount(1);
	await expect(page.locator(".generated-image-tile img")).toHaveCount(0);
	expect(await page.locator("body").getAttribute("data-reads")).toBeNull();
	await page.locator(".generated-image-tile").scrollIntoViewIfNeeded();
	await expect(page.locator(".generated-image-tile img")).toHaveCount(1);
	const reads = await page.locator("body").getAttribute("data-reads");
	await page.locator(".fixture-toolbar").scrollIntoViewIfNeeded();
	await expect(page.locator(".generated-image-tile img")).toHaveCount(0);
	expect(await page.locator("body").getAttribute("data-reads")).toBe(reads);
});

for (const mode of ["chat", "code"])
	test(`virtualized workspace ${mode} loads completed image`, async ({ page }, info) => {
		await page.setViewportSize({ width: 1200, height: 950 });
		await page.goto(`${url}?mode=${mode}&state=completed&workspace&ratio=3:4`);
		await expect(page.locator(".generated-image-tile")).toBeVisible();
		await expect(page.locator(".generated-image-tile img")).toHaveCount(1);
		await page.screenshot({ path: info.outputPath("workspace-image.png") });
	});

// biome-ignore lint/correctness/noEmptyPattern: Playwright requires destructured fixture arguments even when no fixture is used.
test("Electron decodes the generated thumbnail", async ({}, info) => {
	const main = path.join(directory, "electron-preview.cjs");
	await writeFile(
		main,
		`const {app,BrowserWindow}=require("electron"); app.whenReady().then(()=>{const w=new BrowserWindow({width:1200,height:950});w.loadURL(${JSON.stringify(`${url}?state=completed&workspace&ratio=3:4`)});});`,
	);
	const app = await _electron.launch({ args: [main] });
	try {
		const page = await app.firstWindow();
		await expect(page.locator(".generated-image-tile img")).toHaveCount(1);
		await page.screenshot({ path: info.outputPath("electron-preview.png") });
	} finally {
		await app.close();
	}
});

test("an image preview can be retried without reloading the conversation", async ({ page }) => {
	await page.goto(`${url}?state=completed&retryError`);
	await expect(page.locator(".generated-image-preview-state")).toContainText("Preview transport failed");
	await page.locator(".generated-image-retry").click();
	await expect(page.locator(".generated-image-tile img")).toHaveCount(1);
	await expect(page.locator(".generated-image-retry")).toHaveCount(0);
});
