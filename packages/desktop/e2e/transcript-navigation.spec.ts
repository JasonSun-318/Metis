import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { build } from "esbuild";

test.use({ channel: "chrome" });
test.describe.configure({ mode: "serial" });
let server: Server;
let directory: string;
let url: string;

test.beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "metis-transcript-"));
	await build({
		entryPoints: [path.join(__dirname, "transcript-navigation.fixture.tsx")],
		bundle: true,
		format: "esm",
		jsx: "automatic",
		platform: "browser",
		target: "es2022",
		outfile: path.join(directory, "fixture.js"),
	});
	await build({
		stdin: {
			contents: ["tokens.css", "app.css", "transcript-navigation.css"]
				.map((file) => `@import "${path.resolve(__dirname, "../src/renderer/styles", file).replaceAll("\\", "/")}";`)
				.join("\n"),
			loader: "css",
			resolveDir: directory,
		},
		bundle: true,
		outfile: path.join(directory, "fixture.css"),
	});
	await writeFile(
		path.join(directory, "index.html"),
		`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>body{font-family:Inter,-apple-system,sans-serif}#root{height:100%}.fixture-workspace{height:100%;display:flex;flex-direction:column}.fixture-workspace>header{display:flex;align-items:center;justify-content:space-between;height:48px;padding:0 28px;border-bottom:1px solid var(--border);font-size:13px}.fixture-workspace>header button{margin-left:12px;color:var(--muted);font-size:11px}.fixture-workspace>footer{width:min(770px,calc(100% - 80px));height:100px;padding:18px;margin:12px auto 18px;border:1px solid var(--border);border-radius:18px;color:var(--muted);font-size:13px}.fixture-workspace>footer span{display:block;margin-top:20px}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`,
	);
	server = createServer((request, response) => {
		const name = new URL(request.url ?? "/", "http://localhost").pathname;
		const file = new Map([
			["/", "index.html"],
			["/fixture.js", "fixture.js"],
			["/fixture.css", "fixture.css"],
		]).get(name);
		if (!file) {
			response.writeHead(204).end();
			return;
		}
		response.writeHead(200, {
			"Content-Type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html",
		});
		createReadStream(path.join(directory, file)).pipe(response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Fixture server did not start");
	url = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	if (directory) await rm(directory, { force: true, recursive: true });
});

function pageErrors(page: Page) {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	return errors;
}

test("Agent rail previews, jumps to virtualized messages, and retains history position", async ({ page }, info) => {
	const errors = pageErrors(page);
	await page.setViewportSize({ width: 1280, height: 840 });
	await page.goto(url);
	const scroll = page.locator(".transcript-scroll");
	const rail = page.getByRole("slider", { name: "会话导航" });
	await expect(rail).toBeVisible();
	await expect(page.locator('[data-user-message="user-120"]')).toBeVisible();
	await expect(page.locator(".message-file-card").last()).toContainText("系统设计说明.md");
	expect(await page.locator("[data-transcript-turn]").count()).toBeLessThan(30);
	const bounds = (await rail.boundingBox())!;
	await page.mouse.move(bounds.x + 15, bounds.y + bounds.height * 0.36);
	const preview = page.locator(".conversation-navigation-preview");
	await expect(preview).toBeVisible();
	await expect(preview).toContainText("知识点");
	await expect.poll(() => preview.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
	const widths = await page
		.locator(".conversation-navigation-ticks span")
		.evaluateAll((marks) => marks.map((mark) => parseFloat((mark as HTMLElement).style.width)));
	expect(Math.max(...widths)).toBeGreaterThan(18);
	expect(Math.min(...widths)).toBe(6);
	await page.screenshot({ path: info.outputPath("agent-navigation-hover.png") });
	await rail.click({ position: { x: 15, y: bounds.height * 0.36 } });
	await expect(preview).not.toBeVisible();
	await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(1000);
	await rail.focus();
	await rail.press("Home");
	await rail.press("Enter");
	await expect(page.locator('[data-user-message="user-0"]')).toBeInViewport();
	await expect(page.locator('[data-user-message="user-0"] .message-file-card')).toHaveCount(2);
	await page.screenshot({ path: info.outputPath("agent-attachment-cards.png") });
	await page.getByRole("button", { name: "更早的消息" }).click();
	await expect(rail).toHaveAttribute("aria-valuemax", "122");
	await expect(page.locator('[data-user-message="user-0"]')).toBeInViewport();
	// A newly appended reply must not pull the reader back to the bottom.
	await page.getByRole("button", { name: "Append reply" }).click();
	await expect(page.locator('[data-user-message="user-0"]')).toBeInViewport();
	await rail.focus();
	await rail.press("End");
	await rail.press("Enter");
	await expect(page.locator('[data-user-message="user-122"]')).toBeInViewport();
	await page.getByRole("button", { name: "Switch session" }).click();
	await expect(rail).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("one mark per turn, keyboard navigation, narrow light layout and Editor exclusion", async ({ page }, info) => {
	const errors = pageErrors(page);
	await page.setViewportSize({ width: 420, height: 720 });
	await page.goto(`${url}?mode=code&theme=light`);
	const rail = page.getByRole("slider", { name: "会话导航" });
	await rail.focus();
	await rail.press("Home");
	for (let index = 0; index < 45; index += 1) await rail.press("ArrowDown");
	await expect(page.locator(".conversation-navigation-preview")).toContainText("第 46 个问题");
	await expect(page.locator(".conversation-navigation-excerpt")).toContainText("第 46 条回答");
	await expect(rail).toHaveAttribute("aria-valuemax", "121");
	await expect(page.locator('[data-navigation-turn="steer-45"]')).toHaveCount(0);
	await page.screenshot({ path: info.outputPath("agent-navigation-narrow.png") });
	await rail.press("Enter");
	await expect(page.locator('[data-user-message="user-45"]')).toBeInViewport();
	await expect
		.poll(() =>
			page
				.locator('[data-user-message="user-45"]')
				.evaluate((element) =>
					Math.abs(
						element.getBoundingClientRect().top -
							element.closest(".transcript-scroll")!.getBoundingClientRect().top -
							56,
					),
				),
		)
		.toBeLessThan(5);
	await rail.press("ArrowDown");
	await rail.press("Escape");
	await expect(page.locator(".conversation-navigation-preview")).toHaveCount(0);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.goto(`${url}?mode=code&surface=editor`);
	await expect(page.locator(".transcript-code")).toBeVisible();
	await expect(rail).toHaveCount(0);
	expect(errors).toEqual([]);
});


test("reference-sized rail keeps one discrete line per question and a question-answer preview", async ({ page }, info) => {
	await page.setViewportSize({ width: 1280, height: 840 });
	await page.goto(`${url}?count=40`);
	const rail = page.getByRole("slider", { name: "会话导航" });
	await expect(rail).toBeVisible();
	await expect(page.locator("[data-navigation-turn]")).toHaveCount(40);
	const bounds = (await rail.boundingBox())!;
	await page.mouse.move(bounds.x + 18, bounds.y + 210);
	const preview = page.locator(".conversation-navigation-preview");
	await expect(preview).toContainText("第 21 个问题");
	await expect(preview).toContainText("第 21 条回答");
	await expect.poll(() => preview.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
	await page.screenshot({ path: info.outputPath("agent-navigation-reference.png") });
	await expect(page.locator('[data-navigation-turn="user-20"]')).toHaveClass("is-current");
	await expect(page.locator('[data-navigation-turn="user-20"]')).toHaveCSS("width", "26px");
	await expect(page.locator('[data-navigation-turn="user-19"]')).toHaveCSS("width", "20px");
	await expect(page.locator('[data-navigation-turn="user-18"]')).toHaveCSS("width", "14px");
	await expect(page.locator('[data-navigation-turn="user-17"]')).toHaveCSS("width", "8px");
	await expect(page.locator('[data-navigation-turn="user-16"]')).toHaveCSS("width", "6px");
});
