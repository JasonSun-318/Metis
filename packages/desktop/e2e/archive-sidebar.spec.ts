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
	directory = await mkdtemp(path.join(tmpdir(), "metis-archive-sidebar-"));
	await build({
		bundle: true,
		entryPoints: [path.join(__dirname, "archive-sidebar.fixture.tsx")],
		outfile: path.join(directory, "fixture.js"),
		format: "esm",
		jsx: "automatic",
		platform: "browser",
		target: "es2022",
	});
	server = createServer(async (request, response) => {
		const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
		if (pathname === "/") {
			response.setHeader("content-type", "text/html");
			response.end(
				'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
			);
		} else if (pathname === "/fixture.js" || pathname === "/fixture.css") {
			response.setHeader("content-type", pathname.endsWith("css") ? "text/css" : "text/javascript");
			response.end(await readFile(path.join(directory, pathname.slice(1))));
		} else response.writeHead(404).end();
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing port");
	url = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
	await new Promise<void>((resolve) => server?.close(() => resolve()));
	if (directory) await rm(directory, { recursive: true, force: true });
});
for (const theme of ["dark", "light"])
	for (const narrow of [false, true])
		test(`${theme}, ${narrow ? "narrow" : "wide"}: child highlights include actions and align with root`, async ({
			page,
		}, info) => {
			await page.setViewportSize({ width: narrow ? 560 : 900, height: 700 });
			await page.goto(`${url}?theme=${theme}${narrow ? "&narrow" : ""}`);
			const root = page.locator(".session-button");
			await expect(page.getByRole("treeitem")).toHaveCount(3);
			for (const name of ["资料研究", "整理引用", "撰写总结"]) {
				const open = page.getByRole("button", { name, exact: true });
				const row = open.locator("..");
				const actions = page.getByRole("button", { name: `${name} 的操作` });
				await open.hover();
				await expect(row).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
				await expect(open).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
				await actions.hover();
				await expect(row).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
				await expect
					.poll(async () => {
						const rootBounds = (await root.boundingBox())!;
						const bounds = (await row.boundingBox())!;
						return Math.abs(bounds.x + bounds.width - rootBounds.x - rootBounds.width);
					})
					.toBeLessThan(0.5);
				const rowBounds = (await row.boundingBox())!;
				const rootBounds = (await root.boundingBox())!;
				const actionBounds = (await actions.boundingBox())!;
				expect(rowBounds.height).toBe(rootBounds.height);
				expect(rowBounds.x).toBeGreaterThan(rootBounds.x);
				const parentRow =
					name === "整理引用" ? page.getByRole("button", { name: "资料研究", exact: true }).locator("..") : root;
				const parentBounds = (await parentRow.boundingBox())!;
				const gap = rowBounds.y - parentBounds.y - parentBounds.height;
				expect(gap).toBeGreaterThanOrEqual(2);
				if (name !== "撰写总结") expect(gap).toBeLessThanOrEqual(4);
				if (name === "整理引用") expect(rowBounds.x).toBeGreaterThan(parentBounds.x);
				if (name === "撰写总结")
					expect(rowBounds.x).toBe(
						(await page.getByRole("button", { name: "资料研究", exact: true }).boundingBox())!.x,
					);
				expect(actionBounds.x).toBeGreaterThanOrEqual(rowBounds.x);
				expect(actionBounds.x + actionBounds.width).toBeLessThanOrEqual(rowBounds.x + rowBounds.width);
				expect(actionBounds.y).toBeGreaterThanOrEqual(rowBounds.y);
				expect(actionBounds.y + actionBounds.height).toBeLessThanOrEqual(rowBounds.y + rowBounds.height);
				await page.screenshot({ animations: "disabled", path: info.outputPath(`${name}-hover.png`) });
				await open.click();
				await root.focus();
				await page.locator(".workspace-titlebar").hover();
				await expect(open).toHaveAttribute("aria-current", "page");
				await expect(row).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
				await expect(
					page.locator('.agent-sidebar-node:not([aria-selected="true"]) > .agent-sidebar-row').first(),
				).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
				await page.screenshot({ animations: "disabled", path: info.outputPath(`${name}-selected.png`) });
				await actions.click();
				await expect(page.getByRole("menuitem")).toHaveCount(3);
				await expect(page.locator(".workspace-titlebar")).toContainText(name);
				await page.keyboard.press("Escape");
				await expect(actions).toBeFocused();
				await page.keyboard.press("Enter");
				await expect(page.getByRole("menuitem", { name: "重命名" })).toBeFocused();
				await page.keyboard.press("ArrowDown");
				await expect(page.getByRole("menuitem", { name: "归档" })).toBeFocused();
				await page.keyboard.press("Escape");
				await expect(actions).toBeFocused();
			}
		});
for (const theme of ["dark", "light"])
	test(`${theme}: child menus preserve tree, rename focus and subtree removal`, async ({ page }, info) => {
		await page.setViewportSize({ width: 900, height: 700 });
		await page.goto(`${url}?theme=${theme}`);
		await expect(page.getByRole("treeitem")).toHaveCount(3);
		await page.getByRole("button", { name: "资料研究", exact: true }).click();
		const trigger = page.getByRole("button", { name: "资料研究 的操作" });
		await trigger.click();
		await expect(page.getByRole("menuitem")).toHaveCount(3);
		await page.screenshot({ animations: "disabled", path: info.outputPath(`${theme}-child-menu.png`) });
		await page.getByRole("menuitem", { name: "重命名" }).click();
		await expect(page.getByRole("dialog")).toBeVisible();
		await page.screenshot({ animations: "disabled", path: info.outputPath(`${theme}-rename.png`) });
		await page.getByRole("textbox", { name: "会话名称" }).fill("研究与校对");
		await page.getByRole("button", { name: "重命名", exact: true }).click();
		await expect(page.getByRole("dialog")).toHaveCount(0);
		await expect(page.locator(".workspace-titlebar")).toContainText("研究与校对");
		await expect(page.getByRole("button", { name: "研究与校对 的操作" })).toBeFocused();
		await page.getByRole("button", { name: "研究与校对 的操作" }).click();
		await page.getByRole("menuitem", { name: "归档" }).click();
		await expect(page.getByRole("treeitem")).toHaveCount(1);
		await expect(page.getByRole("treeitem", { name: "整理引用" })).toHaveCount(0);
		await expect(page.locator(".workspace-titlebar")).toContainText("主会话");
		await page.getByRole("button", { name: "季度研究报告 的操作" }).click();
		await expect(page.getByRole("menuitem", { name: "归档" })).toBeEnabled();
		await page.getByRole("menuitem", { name: "归档" }).click();
		await expect(page.getByText("会话已归档")).toBeVisible();
	});
test("narrow child deletion confirms and archive errors stay actionable", async ({ page }, info) => {
	await page.setViewportSize({ width: 560, height: 650 });
	await page.goto(`${url}?narrow&theme=light`);
	await page.getByRole("button", { name: "资料研究 的操作" }).click();
	await page.getByRole("menuitem", { name: "删除" }).click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await expect(dialog.getByText(/全部子任务/)).toBeVisible();
	const bounds = await dialog.boundingBox();
	expect(bounds!.x).toBeGreaterThanOrEqual(0);
	expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(560);
	await page.screenshot({ animations: "disabled", path: info.outputPath("narrow-delete-confirm.png") });
	await dialog.getByRole("button", { name: "删除", exact: true }).click();
	await expect(page.getByRole("treeitem")).toHaveCount(1);
	await page.goto(`${url}?error`);
	await page.getByRole("button", { name: "资料研究 的操作" }).click();
	await page.getByRole("menuitem", { name: "归档" }).click();
	await expect(page.getByRole("alert")).toHaveText("归档失败，请重试");
	await expect(page.getByRole("menuitem", { name: "归档" })).toBeEnabled();
	await expect(page.getByRole("treeitem")).toHaveCount(3);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("menu")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "资料研究 的操作" })).toBeFocused();
	await page.goto(`${url}?running`);
	await page.getByRole("button", { name: "资料研究 的操作" }).click();
	await expect(page.getByRole("menuitem", { name: "归档" })).toBeDisabled();
});
