import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { build } from "esbuild";

declare global {
	interface Window {
		__filePanelFixture: {
		setVisible(value: boolean): void;
		setMounted(value: boolean): void;
		setWidth(value: number): void;
		calls: { clipboard: string[]; opens: string[]; saves: number; mutations: string[]; errors: string[] };
		};
	}
}
test.use({ channel: "chrome" });
let directory: string;
let server: Server;
let url: string;
test.beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "metis-file-controls-"));
	await build({
		entryPoints: [path.join(__dirname, "file-panel-controls.fixture.tsx")],
		bundle: true,
		format: "esm",
		jsx: "automatic",
		platform: "browser",
		target: "es2022",
		outfile: path.join(directory, "fixture.js"),
	});
	await writeFile(
		path.join(directory, "index.html"),
		'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
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
	if (!address || typeof address === "string") throw new Error("File controls fixture failed to bind");
	url = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	if (directory) await rm(directory, { recursive: true, force: true });
});

async function open(page: Page, query = "") {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.setViewportSize({ width: 1200, height: 760 });
	await page.goto(`${url}/?${query}`);
	await expect(page.getByRole("button", { name: "Copy contents", exact: true })).toBeVisible();
	await expect(page.locator('.file-tree-row-select[title="notes"]')).toBeVisible();
	return errors;
}
async function assertIconName(row: Locator, editing = false) {
	const box = await row.evaluate((element, edit) => {
		const icon = element.querySelector<HTMLElement>(".file-tree-row-icon")!;
		const glyph = Array.from(icon.querySelectorAll<SVGSVGElement>("svg")).find(
			(candidate) => Number(getComputedStyle(candidate).opacity) > 0,
		)!;
		const name = element.querySelector<HTMLElement>(edit ? ".file-tree-name-input" : ".file-tree-row-name")!;
		const iconBox = icon.getBoundingClientRect();
		const nameBox = name.getBoundingClientRect();
		return {
			width: iconBox.width,
			height: iconBox.height,
			glyphWidth: glyph.getBoundingClientRect().width,
			gap: nameBox.left - iconBox.right,
			nameWidth: nameBox.width,
			align: getComputedStyle(name).textAlign,
			direction: getComputedStyle(name).direction,
		};
	}, editing);
	expect(box.width).toBe(14);
	expect(box.height).toBe(14);
	expect(box.glyphWidth).toBe(14);
	expect(box.gap).toBe(6);
	expect(box.nameWidth).toBeGreaterThan(0);
	expect(box.direction).toBe("ltr");
	expect(["left", "start"]).toContain(box.align);
}

test("folder, expanded folder and file keep 14px icons and 6px name gaps at narrow and wide tree widths", async ({
	page,
}, info) => {
	const errors = await open(page);
	const folder = page.locator('.file-tree-row-select[title="notes"]');
	const file = page.locator('.file-tree-row-select[title="README.md"]');
	await assertIconName(folder);
	await assertIconName(file);
	await folder.click();
	await expect(page.locator('.file-tree-row-select[title="notes/child.md"]')).toBeVisible();
	await assertIconName(folder);
	await assertIconName(page.locator('.file-tree-row-select[title="notes/child.md"]'));
	const resizer = page.locator(".file-tree-resizer");
	await resizer.focus();
	for (let index = 0; index < 5; index += 1) await resizer.press("ArrowRight");
	await expect(resizer).toHaveAttribute("aria-valuenow", "140");
	await assertIconName(folder);
	await assertIconName(file);
	for (let index = 0; index < 15; index += 1) await resizer.press("ArrowLeft");
	await expect(resizer).toHaveAttribute("aria-valuenow", "380");
	await assertIconName(folder);
	await assertIconName(file);
	await file.click({ button: "right" });
	await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
	await expect(page.getByRole("textbox", { name: "Name", exact: true })).toBeFocused();
	await assertIconName(page.locator(".file-tree-row-select.is-editing"), true);
	await page.getByRole("textbox", { name: "Name", exact: true }).press("Escape");
	await page.screenshot({ path: info.outputPath("file-tree-controls.png"), animations: "disabled" });
	expect(errors).toEqual([]);
});

test("disabled save has a rendered hint; hover/focus hints dismiss without capturing pointer or changing actions", async ({
	page,
}) => {
	const errors = await open(page);
	const save = page.getByRole("button", { name: "Save file", exact: true });
	await expect(save).toBeDisabled();
	await save.locator("..").hover();
	const tooltip = page.getByRole("tooltip");
	await expect(tooltip).toBeVisible();
	await expect(tooltip).toContainText(/Save/);
	await expect(tooltip).toHaveCSS("pointer-events", "none");
	await page.mouse.move(0, 600);
	await expect(tooltip).toHaveCount(0);
	const copy = page.getByRole("button", { name: "Copy contents", exact: true });
	await copy.focus();
	await expect(tooltip).toBeVisible();
	await expect(tooltip).toHaveText("Copy contents");
	await expect(copy).toBeFocused();
	await copy.press("Escape");
	await expect(tooltip).toHaveCount(0);
	await copy.hover();
	await expect(tooltip).toBeVisible();
	await copy.click();
	await expect(tooltip).toHaveCount(0);
	expect(await page.evaluate(() => window.__filePanelFixture.calls.clipboard)).toEqual([
		"# File controls fixture\n\nOnly in-memory files are used.\n",
	]);
	await page.getByRole("button", { name: "Open file actions", exact: true }).click();
	await expect(page.getByRole("menu", { name: "Open file actions" })).toBeVisible();
	await expect(tooltip).toHaveCount(0);
	await page.getByRole("menuitem", { name: "Reveal in file manager", exact: true }).click();
	expect(await page.evaluate(() => window.__filePanelFixture.calls.opens)).toEqual(["reveal"]);
	for (const [label, hint] of [
		["Copy path", "Copy path"],
		["Show preview", "Preview"],
		["Open file actions", "Open file actions"],
		["Hide workspace tree", "Hide workspace tree"],
	]) {
		await page.getByRole("button", { name: label, exact: true }).hover();
		await expect(tooltip).toHaveText(hint);
	}
	await page.getByRole("button", { name: "Show preview", exact: true }).click();
	await expect(page.getByRole("button", { name: "View source", exact: true })).toBeVisible();
	await page.getByRole("button", { name: "View source", exact: true }).hover();
	await expect(tooltip).toHaveText("Source");
	await page.getByRole("button", { name: "View source", exact: true }).click();
	expect(errors).toEqual([]);
});

test("toolbar hints use the active Chinese locale", async ({ page }) => {
	await page.setViewportSize({ width: 1100, height: 700 });
	await page.goto(`${url}/?locale=zh-CN&reduced`);
	const copy = page.getByRole("button", { name: "复制路径", exact: true });
	await copy.hover();
	await expect(page.getByRole("tooltip")).toHaveText("复制路径");
	await copy.press("Escape");
	await expect(page.getByRole("tooltip")).toHaveCount(0);
});

test("hints clamp to the viewport and close on scrolling, blur, hidden panel and unmount", async ({ page }, info) => {
	const errors = await open(page, "width=500&reduced");
	await page.setViewportSize({ width: 500, height: 600 });
	const toggle = page.getByRole("button", { name: "Hide workspace tree", exact: true });
	await toggle.hover();
	const tooltip = page.getByRole("tooltip");
	await expect(tooltip).toBeVisible();
	const box = await tooltip.boundingBox();
	expect(box).not.toBeNull();
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(500);
	await page.screenshot({ path: info.outputPath("file-toolbar-edge-tooltip.png"), animations: "disabled" });
	await page.locator(".file-tree-scroll").dispatchEvent("scroll");
	await expect(tooltip).toHaveCount(0);
	const copy = page.getByRole("button", { name: "Copy path", exact: true });
	await copy.focus();
	await expect(tooltip).toBeVisible();
	await page.getByRole("searchbox", { name: "Filter files" }).focus();
	await expect(tooltip).toHaveCount(0);
	await copy.hover();
	await expect(tooltip).toBeVisible();
	await page.evaluate(() => window.__filePanelFixture.setVisible(false));
	await expect(tooltip).toHaveCount(0);
	await page.mouse.move(0, 580);
	await page.evaluate(() => window.__filePanelFixture.setVisible(true));
	await copy.hover();
	await expect(tooltip).toBeVisible();
	await page.evaluate(() => window.__filePanelFixture.setMounted(false));
	await expect(tooltip).toHaveCount(0);
	expect(errors).toEqual([]);
});
