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
	directory = await mkdtemp(path.join(tmpdir(), "metis-image-settings-"));
	await build({
		entryPoints: [path.join(__dirname, "image-generation-settings.fixture.tsx")],
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
		`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/base.css"><link rel="stylesheet" href="/fixture.css"><style>body{font-family:Inter,-apple-system,sans-serif;overflow:auto}.fixture-settings{max-width:820px;margin:32px auto;padding:0 24px}h1{font-size:20px;margin:0 0 24px}@media(max-width:480px){.fixture-settings{padding:0 16px;margin-top:20px}}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`,
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
async function checkGeometry(page: Page) {
	const geometry = await page.locator(".image-generation-settings-dialog").evaluate((dialog) => {
		const rect = dialog.getBoundingClientRect();
		const footer = dialog.querySelector("footer")!.getBoundingClientRect();
		return {
			left: rect.left,
			right: rect.right,
			bottom: rect.bottom,
			footerBottom: footer.bottom,
			viewportWidth: window.innerWidth,
			viewportHeight: window.innerHeight,
			overflow: dialog.scrollWidth - dialog.clientWidth,
			fieldsOverflow: Array.from(dialog.querySelectorAll("input, .menu-select-trigger")).some(
				(field) =>
					field.getBoundingClientRect().right > rect.right || field.getBoundingClientRect().left < rect.left,
			),
		};
	});
	expect(geometry.left).toBeGreaterThanOrEqual(12);
	expect(geometry.right).toBeLessThanOrEqual(geometry.viewportWidth - 12);
	expect(geometry.bottom).toBeLessThanOrEqual(geometry.viewportHeight);
	expect(geometry.footerBottom).toBeLessThanOrEqual(geometry.bottom);
	expect(geometry.overflow).toBe(0);
	expect(geometry.fieldsOverflow).toBe(false);
}
for (const theme of ["dark", "light"] as const) {
	test(`specialized model cards ${theme}: shared styling, status, editing and narrow layout`, async ({
		page,
	}, info) => {
		test.setTimeout(60_000);
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		for (const state of ["unconfigured", "configured", "invalid"]) {
			for (const width of [1280, 390]) {
				await page.setViewportSize({ width, height: 900 });
				await page.goto(`${url}/?theme=${theme}&state=${state}`);
				await page.mouse.move(0, 0);
				const section = page.getByRole("region", { name: "专用模型", exact: true });
				await expect(section.locator(".model-settings-card")).toHaveCount(2);
				const cardStyle = await page.locator(".model-settings-card").evaluateAll((cards) =>
					cards.map((card) => {
						const style = getComputedStyle(card);
						const box = card.getBoundingClientRect();
						return {
							height: box.height,
							background: style.backgroundColor,
							radius: style.borderRadius,
							padding: style.padding,
							overflow: card.scrollWidth - card.clientWidth,
						};
					}),
				);
				expect(cardStyle).toHaveLength(3);
				for (const style of cardStyle) expect(style).toEqual({ ...cardStyle[2], overflow: 0 });
				const image = section.locator(".image-generation-settings-card");
				const reviewer = section.locator(".reviewer-model-card");
				await expect(section.locator(".model-provider-badge")).toHaveText(
					Array(2).fill(state === "configured" ? "已配置" : state === "invalid" ? "需要处理" : "去配置"),
				);
				const boxes = [await image.boundingBox(), await reviewer.boundingBox()];
				if (width === 390) expect(boxes[1]!.y).toBeGreaterThan(boxes[0]!.y + boxes[0]!.height);
				else expect(boxes[0]!.y).toBeCloseTo(boxes[1]!.y, 0);
				await page.screenshot({ path: info.outputPath(`${theme}-${state}-${width}-cards.png`) });
				await reviewer.click();
				const dialog = page.getByRole("dialog", { name: "审批模型", exact: true });
				await expect(dialog).toBeVisible();
				if (state !== "unconfigured") {
					await expect(dialog.getByLabel("名称", { exact: true })).toHaveValue("工作室的专用审批模型（reviewer）");
					await expect(dialog.getByLabel("API Key", { exact: true })).toHaveValue("");
				}
				await page.keyboard.press("Escape");
				await expect(dialog).toHaveCount(0);
				await expect(reviewer).toBeFocused();
				await reviewer.press("Enter");
				await expect(dialog).toBeVisible();
				await page.keyboard.press("Escape");
				await image.click();
				const imageDialog = page.getByRole("dialog", { name: "生图模型", exact: true });
				await expect(imageDialog).toBeVisible();
				await page.keyboard.press("Escape");
				await expect(imageDialog).toHaveCount(0);
				await expect(image).toBeFocused();
			}
		}
		expect(errors).toEqual([]);
	});
	test(`image model form ${theme}: responsive layout, saving, focus and unsaved drafts`, async ({ page }, info) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto(`${url}/?theme=${theme}`);
		const card = page.locator(".image-generation-settings-card");
		const specialized = page.getByRole("region", { name: "专用模型", exact: true });
		await expect(specialized.locator(".model-settings-card")).toHaveCount(2);
		await expect(card).toContainText("尚未配置生图模型");
		await page.screenshot({ path: info.outputPath(`${theme}-settings-empty.png`) });
		await card.click();
		const dialog = page.getByRole("dialog", { name: "生图模型", exact: true });
		await expect(dialog.getByLabel("名称", { exact: true })).toBeFocused();
		await dialog.getByLabel("名称", { exact: true }).fill("我的创作工作室");
		await dialog.getByLabel("模型 ID", { exact: true }).fill("image-model-custom");
		await dialog.getByLabel("API Key", { exact: true }).fill("fixture-secret");
		await checkGeometry(page);
		await page.screenshot({ path: info.outputPath(`${theme}-settings-form-wide.png`) });
		await dialog.getByLabel("API 格式", { exact: true }).click();
		await page.getByRole("option", { name: "Google Interactions", exact: true }).click();
		await expect(dialog.getByLabel("Base URL", { exact: true })).toHaveValue(
			"https://generativelanguage.googleapis.com/v1beta",
		);
		await dialog.getByLabel("API 格式", { exact: true }).click();
		await page.getByRole("option", { name: "OpenRouter Images", exact: true }).click();
		await expect(dialog.getByLabel("Base URL", { exact: true })).toHaveValue("https://openrouter.ai/api/v1");
		await dialog.getByLabel("模型 ID", { exact: true }).fill("google/gemini-3.1-flash-image");
		await page.setViewportSize({ width: 390, height: 780 });
		await checkGeometry(page);
		await page.screenshot({ path: info.outputPath(`${theme}-settings-form-narrow.png`) });
		await page.setViewportSize({ width: 390, height: 520 });
		await checkGeometry(page);
		await expect(dialog.getByRole("button", { name: "保存生图模型", exact: true })).toBeInViewport();
		await page.screenshot({ path: info.outputPath(`${theme}-settings-form-short.png`) });
		await page.setViewportSize({ width: 390, height: 780 });
		await dialog.getByRole("button", { name: "取消", exact: true }).click();
		await page.getByRole("button", { name: "继续编辑", exact: true }).click();
		await expect(dialog.getByLabel("名称", { exact: true })).toHaveValue("我的创作工作室");
		await dialog.getByRole("button", { name: "保存生图模型", exact: true }).click();
		await expect(dialog).toHaveCount(0);
		await expect(card).toContainText("我的创作工作室");
		await expect(card).toContainText("OpenRouter Images");
		await page.screenshot({ path: info.outputPath(`${theme}-settings-saved.png`) });
		await card.click();
		await expect(dialog.getByLabel("模型 ID", { exact: true })).toHaveValue("google/gemini-3.1-flash-image");
		await expect(dialog.getByLabel("API Key", { exact: true })).toHaveValue("");
		await dialog.getByLabel("API 密钥来源", { exact: true }).click();
		await page.getByRole("option", { name: "Studio API", exact: true }).click();
		await expect(dialog.getByLabel("API Key", { exact: true })).toHaveCount(0);
		await checkGeometry(page);
		await page.screenshot({ path: info.outputPath(`${theme}-settings-provider-key.png`) });
		expect(errors).toEqual([]);
	});
	test(`image model form ${theme}: visible failure retains entries`, async ({ page }, info) => {
		await page.setViewportSize({ width: 390, height: 780 });
		await page.goto(`${url}/?theme=${theme}&error=1`);
		await page.getByRole("button", { name: "生图模型", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "生图模型", exact: true });
		await dialog.getByLabel("名称", { exact: true }).fill("我的创作工作室");
		await dialog.getByLabel("模型 ID", { exact: true }).fill("image-model-custom");
		await dialog.getByLabel("API Key", { exact: true }).fill("fixture-secret");
		await dialog.getByRole("button", { name: "保存生图模型", exact: true }).click();
		await expect(dialog.getByRole("alert")).toContainText("无法保存设置");
		await expect(dialog.getByLabel("名称", { exact: true })).toHaveValue("我的创作工作室");
		await checkGeometry(page);
		await page.screenshot({ path: info.outputPath(`${theme}-settings-error.png`) });
	});
}
