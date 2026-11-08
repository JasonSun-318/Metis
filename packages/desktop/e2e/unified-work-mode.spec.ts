import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";

test.use({ channel: "chrome" });
let directory: string;
let server: Server;
let url: string;
test.beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "metis-work-mode-"));
	await build({
		loader: { ".svg": "dataurl", ".woff": "dataurl", ".woff2": "dataurl", ".ttf": "dataurl" },
		bundle: true,
		entryPoints: [path.join(__dirname, "unified-work-mode.fixture.tsx")],
		outfile: path.join(directory, "fixture.js"),
		format: "esm",
		jsx: "automatic",
		platform: "browser",
		target: "es2022",
	});
	await build({
		bundle: true,
		entryPoints: [path.join(__dirname, "../src/renderer/workers/diff-worker.ts")],
		outfile: path.join(directory, "diff-worker.js"),
		format: "esm",
		platform: "browser",
		target: "es2022",
		ignoreAnnotations: true,
	});
	server = createServer(async (request, response) => {
		const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
		if (pathname === "/") {
			response.setHeader("content-type", "text/html");
			response.end(
				'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
			);
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
	if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	if (directory) await rm(directory, { recursive: true, force: true });
});

for (const theme of ["dark", "light"]) {
	test(`unified work mode ${theme}`, async ({ page }, info) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto(`${url}?theme=${theme}`);
		await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
		await expect(page.locator(".session-row")).toHaveCount(2);
		await expect(page.locator(".conversation-column:visible")).toHaveAttribute("data-mode", "chat");
		await expect(page.getByText("report.md", { exact: true })).toHaveCount(0);
		const editor = page.locator("#composer-input");
		await editor.fill("这份草稿在切换后仍然保留");
		await page.getByRole("button", { name: "代码", exact: true }).click();
		await expect(page.locator(".conversation-column:visible")).toHaveAttribute("data-mode", "code");
		await expect(editor).toHaveText("这份草稿在切换后仍然保留");
		await expect(page.locator(".session-row")).toHaveCount(2);
		await expect(page.getByRole("button", { name: "定时任务", exact: true })).toBeVisible();
		await expect(page.getByText("report.md", { exact: true }).first()).toBeVisible();
		await page.screenshot({ path: info.outputPath(`${theme}-code.png`) });
		await page.getByRole("button", { name: "Metis User", exact: true }).click();
		await page.getByRole("menuitem", { name: "设置", exact: true }).click();
		await page.getByRole("button", { name: "通用", exact: true }).click();
		const modes = page.getByRole("group", { name: "工作模式", exact: true });
		await expect(modes.getByRole("button", { name: "代码开发" })).toHaveAttribute("aria-pressed", "true");
		await modes.getByRole("button", { name: "日常工作" }).click();
		await expect(page.locator(".mode-switch")).toHaveAttribute("data-mode", "chat");
		await page.screenshot({ path: info.outputPath(`${theme}-settings.png`) });
		await page.setViewportSize({ width: 760, height: 740 });
		expect(await modes.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
		await page.screenshot({ path: info.outputPath(`${theme}-settings-narrow.png`) });
		await page.getByRole("button", { name: "返回应用", exact: true }).click();
		await expect(editor).toHaveText("这份草稿在切换后仍然保留");
		await expect(page.getByText("report.md", { exact: true })).toHaveCount(0);
		await page.getByRole("button", { name: "代码", exact: true }).click();
		await page.getByRole("button", { name: "新建任务", exact: true }).click();
		await page.locator("#composer-input").fill("不选文件夹也可以开始");
		await page.getByRole("button", { name: "发送消息", exact: true }).click();
		await expect.poll(() => page.locator("body").getAttribute("data-created")).toBeTruthy();
		const created = JSON.parse((await page.locator("body").getAttribute("data-created"))!);
		expect(created.mode).toBe("chat");
		expect(created.cwd).toBeUndefined();
		await expect(page.locator(".conversation-column:visible")).toHaveAttribute("data-mode", "code");
		expect(errors).toEqual([]);
	});
}
