import { build } from "esbuild";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";

test.use({ channel: "chrome" });
let directory: string;
let server: Server;
let url: string;
test.beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "metis-chain-"));
	await build({ bundle: true, entryPoints: [path.join(__dirname, "chat-execution-chain.fixture.tsx")], outfile: path.join(directory, "fixture.js"), format: "esm", jsx: "automatic", platform: "browser", target: "es2022" });
	await build({ bundle: true, entryPoints: [path.join(__dirname, "../src/renderer/workers/diff-worker.ts")], outfile: path.join(directory, "diff-worker.js"), format: "esm", platform: "browser", target: "es2022", ignoreAnnotations: true });
	server = createServer(async (request, response) => {
		const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
		if (pathname === "/") {
			response.setHeader("content-type", "text/html");
			response.end('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>');
		} else if (pathname === "/workers/diff-worker.ts") {
			response.setHeader("content-type", "text/javascript");
			response.end(await readFile(path.join(directory, "diff-worker.js")));
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

test("streams one line and fully closes the execution drawer", async ({ page }) => {
	await page.goto(url);
	const summary = page.locator(".execution-chain > summary");
	const drawer = page.locator(".execution-chain > .transcript-drawer");
	await expect(summary).toHaveText("正在核对第 0 列。");
	await expect.poll(() => drawer.evaluate((el) => el.getBoundingClientRect().height)).toBe(0);
	const height = await summary.evaluate((el) => el.getBoundingClientRect().height);
	await page.getByRole("button", { name: "追加思考" }).click();
	await expect(summary).toHaveText("正在核对第 1 列。");
	expect(await summary.evaluate((el) => el.getBoundingClientRect().height)).toBe(height);
	await page.getByRole("button", { name: "完成任务" }).click();
	await expect(summary).toHaveText("已运行命令");
	await expect(drawer).toHaveJSProperty("inert", true);
	await expect(page.locator("[data-transcript-answer] table")).toBeVisible();
});

test("limits a long live preview to half the conversation width", async ({ page }) => {
	await page.goto(`${url}?long`);
	const summary = page.locator(".execution-chain > summary");
	const preview = page.locator(".execution-chain-live-preview");
	await expect(preview).toBeVisible();
	const outer = (await summary.boundingBox())!;
	const inner = (await preview.boundingBox())!;
	expect(inner.x).toBe(outer.x);
	expect(inner.width).toBeCloseTo(outer.width / 2, 0);
});

test("thought disclosure slides the same content open and closed with a quiet inline control", async ({ page }, testInfo) => {
	await page.goto(url);
	await page.getByRole("button", { name: "完成任务" }).click();
	await page.locator(".execution-chain > summary").click();
	const drawer = page.locator(".execution-chain > .transcript-drawer");
	await expect.poll(() => drawer.evaluate((el) => Math.abs(el.getBoundingClientRect().height - el.firstElementChild!.scrollHeight))).toBeLessThan(1);
	const preview = page.locator(".thinking-preview").first();
	const button = page.locator(".thinking-show-more").first();
	await expect(button).toBeInViewport();
	await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await expect(button).toHaveCSS("border-top-width", "0px");
	expect((await button.boundingBox())!.height).toBe(22);
	await page.screenshot({ path: testInfo.outputPath("thought-disclosure-collapsed.png") });
	for (const expanding of [true, false]) {
		const heights = await preview.evaluate(async (element) => {
			const content = element.firstElementChild!;
			const before = element.getBoundingClientRect().height;
			element.parentElement!.querySelector<HTMLButtonElement>(".thinking-show-more")!.click();
			await new Promise(requestAnimationFrame);
			await new Promise(requestAnimationFrame);
			const animation = element.getAnimations().find((candidate) =>
				candidate instanceof CSSTransition && candidate.transitionProperty === "max-height");
			if (!animation) throw new Error("Thought height changed without a drawer transition");
			animation.pause();
			animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
			const middle = element.getBoundingClientRect().height;
			animation.finish();
			return { before, middle, full: content.getBoundingClientRect().height, sameContent: content === element.firstElementChild };
		});
		await expect(button).toHaveAttribute("aria-expanded", String(expanding));
		expect(heights.sameContent).toBe(true);
		if (expanding) {
			expect(heights.middle).toBeGreaterThan(heights.before + 1);
			expect(heights.middle).toBeLessThan(heights.full - 1);
			await expect.poll(() => preview.evaluate((el) => el.getBoundingClientRect().height)).toBeCloseTo(heights.full, 0);
			await page.screenshot({ path: testInfo.outputPath("thought-disclosure-expanded.png") });
		} else {
			expect(heights.middle).toBeLessThan(heights.before - 1);
			await expect.poll(() => preview.evaluate((el) => el.getBoundingClientRect().height)).toBeLessThan(heights.middle - 1);
		}
	}
	await button.hover();
	await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
});

test("file controls use compact corners and keep selection actions available", async ({ page }) => {
	await page.goto(`${url}?controls`);
	const radius = (selector: string) => page.locator(selector).evaluate((el) => getComputedStyle(el).borderRadius);
	await expect(page.locator(".transcript-delivered-file-actions")).toBeVisible();
	expect(await radius(".transcript-delivered-file-actions")).toBe("8px");
	await page.getByRole("button", { name: "选择标题" }).click();
	await page.getByRole("button", { name: "请求更改" }).click();
	await expect(page.locator(".file-selection-popover.is-editing")).toBeVisible();
	expect(await radius(".file-selection-popover")).toBe("8px");
	expect(await radius(".selection-send")).toBe("8px");
});

test("Code uses compact expanded tools, highlighted inline diffs and a separate review panel", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 1160, height: 1000 });
	await page.goto(`${url}?code`);
	const execution = page.locator(".code-execution");
	await execution.locator(":scope > summary").click();
	const rows = execution.locator(".code-command > summary");
	await expect(rows).toHaveCount(5);
	await rows.nth(0).click();
	await rows.nth(1).click();
	const diff = execution.locator(".code-file-diff");
	await expect(diff).toBeVisible();
	await expect.poll(() => diff.locator("diffs-container").evaluate((el) => el.shadowRoot?.textContent?.includes("triple") ?? false)).toBe(true);
	await expect(execution.locator(".code-command-input").first()).toContainText("$ ls -la");
	const input = execution.locator(".code-command-input").first();
	expect(await input.evaluate((el) => getComputedStyle(el).borderRadius)).toBe("6px");
	const panel = page.locator(".code-turn-changes");
	const review = panel.locator(".code-turn-review");
	expect((await review.boundingBox())!.height).toBe(20);
	await expect(review).toHaveCSS("border-top-width", "0px");
	await expect(review).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
	await expect(panel.locator("header .code-turn-change-counts")).toHaveCount(1);
	await expect(panel.locator("footer")).toHaveCount(0);
	await expect(panel.locator(".code-turn-file")).toHaveCount(2);
	await expect(panel.locator(".code-turn-more")).toHaveCount(0);
	await expect(panel.locator(".code-file-diff")).toHaveCount(0);
	await page.screenshot({ path: testInfo.outputPath("metis-code-expanded.png") });
	await page.getByRole("button", { name: "查看变更", exact: true }).click();
	await expect(execution).toHaveAttribute("open", "");
	await expect(page.locator(".review-panel")).toBeVisible();
	await panel.locator(".code-turn-file").nth(1).click();
	await expect(page.locator(".review-file-header[aria-expanded=true]")).toContainText("triple.test.mjs");
	await page.screenshot({ path: testInfo.outputPath("metis-code-review.png") });
});

test("Code keeps headers fixed while revealing added and removed lines", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 1160, height: 1000 });
	await page.goto(`${url}?code&modified`);
	await page.locator(".code-execution > summary").click();
	const row = page.locator(".code-command > summary").nth(1);
	const before = await row.boundingBox();
	await row.click();
	const diff = page.locator(".code-file-diff diffs-container");
	await expect.poll(() => diff.evaluate((el) => el.shadowRoot?.querySelectorAll('[data-line-type="change-deletion"][data-line]').length ?? 0)).toBe(1);
	await expect.poll(() => diff.evaluate((el) => el.shadowRoot?.querySelectorAll('[data-line-type="change-addition"][data-line]').length ?? 0)).toBe(1);
	await expect.poll(() => row.boundingBox()).toEqual(before);
	await page.screenshot({ path: testInfo.outputPath("metis-code-modified.png") });
	await row.click();
	await expect.poll(() => page.locator(".code-command").nth(1).locator(".transcript-drawer").evaluate((el) => el.getBoundingClientRect().height)).toBe(0);
	expect(await row.boundingBox()).toEqual(before);
});

test("Code filters binary and resource files from counts and the summary", async ({ page }) => {
	await page.goto(`${url}?code&edge`);
	const panel = page.locator(".code-turn-changes");
	await expect(panel.locator(".code-turn-file")).toHaveCount(1);
	await expect(panel.locator("header")).toContainText("已创建 1 个文件");
	await expect(panel).not.toContainText("二进制");
	await expect(panel).not.toContainText("项目外");
	await expect(panel.locator("header .code-turn-change-counts")).toContainText("+3");
	await expect(panel.locator("footer")).toHaveCount(0);
	await expect(page.locator(".code-execution > summary button")).toHaveCount(0);
});

test("ten files disclose seven remaining rows inside the card without opening review", async ({ page }, testInfo) => {
	await page.goto(`${url}?code&many`);
	const panel = page.locator(".code-turn-changes");
	const drawer = panel.locator(".code-turn-files-drawer");
	await expect(panel.locator(":scope > .code-turn-file")).toHaveCount(3);
	await expect(drawer.locator(".code-turn-file").first()).not.toBeInViewport();
	await expect.poll(() => drawer.evaluate((el) => el.getBoundingClientRect().height)).toBe(0);
	const button = panel.locator(".code-turn-more");
	await expect(button).toHaveText("查看其他 7 个文件变更");
	await page.screenshot({ path: testInfo.outputPath("code-files-collapsed.png") });
	await button.click();
	await expect(button).toHaveAttribute("aria-expanded", "true");
	await expect.poll(() => drawer.evaluate((el) => Math.abs(el.getBoundingClientRect().height - el.firstElementChild!.getBoundingClientRect().height))).toBeLessThan(0.5);
	await expect(drawer.locator(".code-turn-file").last()).toBeInViewport({ ratio: 1 });
	await expect(panel.locator(".code-turn-file:visible")).toHaveCount(10);
	await expect(page.locator(".review-panel")).toHaveCount(0);
	await page.screenshot({ path: testInfo.outputPath("code-files-expanded.png") });
	await button.click();
	await expect.poll(() => drawer.evaluate((el) => el.getBoundingClientRect().height)).toBe(0);
	await expect(drawer).toHaveJSProperty("inert", true);
});

test("review tree keeps the folder icon fixed, swaps states and places labels next to icons", async ({ page }, testInfo) => {
	await page.goto(`${url}?code`);
	await page.locator(".code-turn-review").click();
	await page.getByRole("button", { name: "显示审阅详情" }).click();
	const folder = page.locator(".review-tree button[aria-expanded]").first();
	const icon = folder.locator(".sidebar-folder-icon");
	await expect(icon).toHaveAttribute("data-expanded", "true");
	const geometry = await folder.evaluate((el) => {
		const icon = el.querySelector('.review-tree-icon')!.getBoundingClientRect();
		const label = el.querySelector('.review-tree-label')!.getBoundingClientRect();
		return { width: icon.width, gap: label.left - icon.right };
	});
	expect(geometry.width).toBe(14);
	expect(geometry.gap).toBe(5);
	await expect(icon.locator('[data-folder-state="open"]')).toHaveCSS("opacity", "1");
	await folder.click();
	await expect(icon).toHaveAttribute("data-expanded", "false");
	await expect(icon.locator('[data-folder-state="open"]')).toHaveCSS("opacity", "0");
	await expect(icon.locator('[data-folder-state="closed"]')).toHaveCSS("opacity", "1");
	await folder.click();
	await page.screenshot({ path: testInfo.outputPath("review-tree-alignment.png") });
});

test("runtime shows a rotating ring and inline subdued usage after the status", async ({ page }, testInfo) => {
	await page.goto(url);
	const status = page.locator(".turn-runtime-status");
	await expect(status.locator(".turn-runtime-usage")).toBeVisible();
	await expect(status.locator("details, summary")).toHaveCount(0);
	await expect(status.locator(".turn-runtime-spinner")).toHaveCSS("animation-name", "turn-runtime-spin");
	await expect(status.locator(".turn-runtime-usage")).toHaveCSS("font-variant-numeric", "tabular-nums");
	const label = await status.locator(".turn-runtime-label").boundingBox();
	const usage = await status.locator(".turn-runtime-usage").boundingBox();
	expect(usage!.x).toBeGreaterThan(label!.x + label!.width);
	await page.screenshot({ path: testInfo.outputPath("runtime-inline-usage.png") });
	await page.evaluate(() => document.documentElement.dataset.motion = "reduced");
	await expect(status.locator(".turn-runtime-spinner")).toHaveCSS("animation-name", "none");
});

for (const width of [1000, 390]) test(`independent thoughts and stable command geometry at ${width}px`, async ({ page }) => {
	await page.setViewportSize({ width, height: 1000 });
	await page.goto(url);
	if (width === 390) await page.evaluate(() => document.documentElement.style.setProperty("--content-font-size", "20px"));
	await page.getByRole("button", { name: "完成任务" }).click();
	await page.locator(".execution-chain > summary").click();
	const buttons = page.locator(".thinking-show-more");
	await expect(buttons).toHaveCount(2);
	const second = page.locator(".thinking-preview").nth(1);
	const secondHeight = await second.evaluate((el) => el.getBoundingClientRect().height);
	await buttons.first().click();
	await expect(buttons.first()).toHaveAttribute("aria-expanded", "true");
	await expect(buttons.nth(1)).toHaveAttribute("aria-expanded", "false");
	const first = page.locator(".thinking-preview").first();
	await expect.poll(() => first.evaluate((el) => Math.abs(el.getBoundingClientRect().height - el.firstElementChild!.getBoundingClientRect().height))).toBeLessThan(0.5);
	expect(await second.evaluate((el) => el.getBoundingClientRect().height)).toBe(secondHeight);
	await buttons.first().click();
	await expect.poll(() => first.evaluate((el) => el.getBoundingClientRect().height)).toBe(secondHeight);
	const command = page.locator(".tool-step-command > summary");
	const commandDrawer = page.locator(".tool-step-command > .transcript-drawer");
	await expect.poll(() => commandDrawer.evaluate((el) => el.getBoundingClientRect().height)).toBe(0);
	const before = await command.boundingBox();
	const iconBefore = await command.locator("svg").boundingBox();
	await command.click();
	await expect.poll(() => commandDrawer.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(200);
	expect(await command.boundingBox()).toEqual(before);
	expect(await command.locator("svg").boundingBox()).toEqual(iconBefore);
	await command.click();
	await expect.poll(() => commandDrawer.evaluate((el) => el.getBoundingClientRect().height)).toBe(0);
	await expect(page.locator(".tool-step-details")).not.toBeInViewport();
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
