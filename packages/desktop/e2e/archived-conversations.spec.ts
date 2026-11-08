import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { build } from "esbuild";

test.use({ channel: "chrome" });
let server: Server;
let directory: string;
let url: string;
test.beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "metis-archive-settings-"));
	await build({
		entryPoints: [path.join(__dirname, "archived-conversations.fixture.tsx")],
		bundle: true,
		format: "esm",
		jsx: "automatic",
		platform: "browser",
		target: "es2022",
		outfile: path.join(directory, "fixture.js"),
	});
	await build({
		stdin: {
			contents: ["tokens.css", "app.css"]
				.map(
					(file) => `@import "${path.resolve(__dirname, "../src/renderer/styles", file).replaceAll("\\", "/")}";`,
				)
				.join("\n"),
			loader: "css",
			resolveDir: directory,
		},
		bundle: true,
		loader: { ".woff": "file", ".woff2": "file", ".ttf": "file", ".svg": "file" },
		outfile: path.join(directory, "base.css"),
	});
	await writeFile(
		path.join(directory, "index.html"),
		`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/base.css"><link rel="stylesheet" href="/fixture.css"><style>body{font-family:Inter,-apple-system,sans-serif}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`,
	);
	server = createServer((request, response) => {
		const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
		const file = pathname === "/" ? "index.html" : path.basename(pathname);
		if (!/^(index\.html|(?:fixture|base)\.(?:js|css)|[^/]+\.(?:woff2?|ttf|svg))$/.test(file)) {
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
	if (!address || typeof address === "string") throw new Error("Fixture server did not start");
	url = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	if (directory) await rm(directory, { recursive: true, force: true });
});
async function openArchive(page: Page, query: string) {
	await page.goto(`${url}/?${query}`);
	await expect(page.locator("body")).not.toHaveAttribute("data-archive-reads");
	await page.getByRole("button", { name: "已归档会话", exact: true }).click();
}
async function expectNoOverflow(page: Page) {
	const dimensions = await page.locator(".archived-conversations-panel").evaluate((panel) => ({
		overflow: panel.scrollWidth - panel.clientWidth,
		rows: Array.from(panel.querySelectorAll(".archived-conversation-row")).map(
			(row) => row.scrollWidth - row.clientWidth,
		),
		width: panel.getBoundingClientRect().right,
		viewport: window.innerWidth,
	}));
	expect(dimensions.overflow).toBe(0);
	expect(dimensions.rows.every((width) => width === 0)).toBe(true);
	expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport);
}
for (const theme of ["dark", "light"] as const) {
	test(`archive settings ${theme}: lazy list, paging, delete confirmation and cascade`, async ({ page }, info) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.setViewportSize({ width: 1280, height: 900 });
		await openArchive(page, `theme=${theme}`);
		await expect(page.locator(".archived-conversation-row")).toHaveCount(3);
		await expectNoOverflow(page);
		await page.screenshot({ animations: "disabled", path: info.outputPath(`${theme}-archive-wide.png`) });
		await page.getByRole("button", { name: "下一页", exact: true }).click();
		await expect(page.getByText("第 2 页", { exact: true })).toBeVisible();
		await page.setViewportSize({ width: 620, height: 760 });
		await expectNoOverflow(page);
		await page.screenshot({ animations: "disabled", path: info.outputPath(`${theme}-archive-narrow.png`) });
		await page.getByRole("button", { name: "删除 Metis 图片生成与会话归档体验改进", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "删除归档会话？", exact: true });
		await expect(dialog).toContainText("全部子代理会话");
		await expect(dialog.getByRole("button", { name: "删除会话", exact: true })).toBeVisible();
		await page.screenshot({ animations: "disabled", path: info.outputPath(`${theme}-archive-delete-confirm.png`) });
		await dialog.getByRole("button", { name: "取消", exact: true }).click();
		await expect(
			page.getByRole("button", { name: "删除 Metis 图片生成与会话归档体验改进", exact: true }),
		).toBeFocused();
		await page.getByRole("button", { name: "删除 Metis 图片生成与会话归档体验改进", exact: true }).click();
		await dialog.getByRole("button", { name: "删除会话", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expect(page.getByText("第 1 页", { exact: true })).toBeVisible();
		await page.getByRole("button", { name: "下一页", exact: true }).click();
		await expect(page.locator(".archived-conversation-row")).toHaveCount(1);
		await expect(page.locator(".archived-conversations-panel")).not.toContainText("交互布局与功能验证");
		await expectNoOverflow(page);
		await page.screenshot({ animations: "disabled", path: info.outputPath(`${theme}-archive-cascade-result.png`) });
		expect(errors).toEqual([]);
	});
	test(`archive settings ${theme}: restore sits beside delete and retains separately archived children`, async ({
		page,
	}, info) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await openArchive(page, `theme=${theme}`);
		const restore = page.getByRole("button", { name: "恢复 秋日旅行计划 · 京都与奈良", exact: true });
		const remove = page.getByRole("button", { name: "删除 秋日旅行计划 · 京都与奈良", exact: true });
		const restoreBounds = (await restore.boundingBox())!;
		const deleteBounds = (await remove.boundingBox())!;
		expect(restoreBounds.x + restoreBounds.width).toBeLessThan(deleteBounds.x);
		expect(restoreBounds.y).toBe(deleteBounds.y);
		await expectNoOverflow(page);
		await restore.click();
		await expect(page.getByRole("button", { name: "恢复 行程规划与预算整理", exact: true })).toBeVisible();
		await expect(page.getByRole("button", { name: "恢复 旅行资料检索", exact: true })).toHaveCount(0);
		await expect(restore).toHaveCount(0);
		await expect(page.locator(".archived-conversations-panel")).toBeVisible();
		await page.setViewportSize({ width: 620, height: 760 });
		await expectNoOverflow(page);
		await page.screenshot({ animations: "disabled", path: info.outputPath(`${theme}-archive-restored-root.png`) });
		await page.setViewportSize({ width: 360, height: 760 });
		await expectNoOverflow(page);
		await page.screenshot({ animations: "disabled", path: info.outputPath(`${theme}-archive-small.png`) });
		await page.getByRole("button", { name: "恢复 行程规划与预算整理", exact: true }).click();
		await expect(page.locator("body")).toHaveAttribute("data-restored", "planner");
		await expect(page.getByRole("button", { name: "恢复 行程规划与预算整理", exact: true })).toHaveCount(0);
		await expectNoOverflow(page);
		await page.screenshot({ animations: "disabled", path: info.outputPath(`${theme}-archive-restored-child.png`) });
		// A child whose root is still archived can be restored directly.
		await openArchive(page, `theme=${theme}`);
		await page.getByRole("button", { name: "恢复 旅行资料检索", exact: true }).click();
		await expect(page.locator("body")).toHaveAttribute("data-restored", "researcher");
		await expect(page.getByRole("button", { name: "恢复 秋日旅行计划 · 京都与奈良", exact: true })).toHaveCount(0);
		await expect(page.getByRole("button", { name: "恢复 行程规划与预算整理", exact: true })).toBeVisible();
	});
	test(`archive settings ${theme}: restore errors and busy state preserve rows and prevent competing actions`, async ({
		page,
	}, info) => {
		await page.setViewportSize({ width: 620, height: 760 });
		await openArchive(page, `theme=${theme}&restoreError=1`);
		await page.getByRole("button", { name: "恢复 秋日旅行计划 · 京都与奈良", exact: true }).click();
		await expect(page.getByRole("alert")).toContainText("暂时无法恢复会话");
		await expect(page.locator(".archived-conversation-row")).toHaveCount(3);
		await expectNoOverflow(page);
		await page.screenshot({ animations: "disabled", path: info.outputPath(`${theme}-archive-restore-error.png`) });
		await openArchive(page, `theme=${theme}&restoring=1`);
		await page.getByRole("button", { name: "恢复 秋日旅行计划 · 京都与奈良", exact: true }).click();
		await expect(page.getByRole("button", { name: "恢复 秋日旅行计划 · 京都与奈良", exact: true })).toBeDisabled();
		await expect(page.getByRole("button", { name: "删除 旅行资料检索", exact: true })).toBeDisabled();
		await expect(page.getByRole("button", { name: "刷新", exact: true })).toBeDisabled();
		await expect(page.getByRole("button", { name: "下一页", exact: true })).toBeDisabled();
		await expectNoOverflow(page);
		await page.screenshot({ animations: "disabled", path: info.outputPath(`${theme}-archive-restoring.png`) });
	});

	test(`archive settings ${theme}: empty and failure states remain usable`, async ({ page }, info) => {
		await page.setViewportSize({ width: 620, height: 760 });
		await openArchive(page, `theme=${theme}&state=empty`);
		await expect(page.getByText("暂无已归档会话", { exact: true })).toBeVisible();
		await page.screenshot({ animations: "disabled", path: info.outputPath(`${theme}-archive-empty.png`) });
		await openArchive(page, `theme=${theme}&state=error`);
		await expect(page.getByRole("alert")).toContainText("暂时无法读取归档会话");
		await expectNoOverflow(page);
		await page.screenshot({ animations: "disabled", path: info.outputPath(`${theme}-archive-error.png`) });
		await openArchive(page, `theme=${theme}&deleteError=1`);
		await page.getByRole("button", { name: "删除 秋日旅行计划 · 京都与奈良", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "删除归档会话？", exact: true });
		await dialog.getByRole("button", { name: "删除会话", exact: true }).click();
		await expect(dialog.getByRole("alert")).toContainText("尚未保存的文件");
		await page.screenshot({ animations: "disabled", path: info.outputPath(`${theme}-archive-delete-error.png`) });
		await dialog.getByRole("button", { name: "取消", exact: true }).click();
		await expect(page.locator(".archived-conversation-row")).toHaveCount(3);
		await openArchive(page, `theme=${theme}&state=loading`);
		await expect(page.getByText("正在加载已归档会话…", { exact: true })).toBeVisible();
		await page.screenshot({ animations: "disabled", path: info.outputPath(`${theme}-archive-loading.png`) });
	});
}
