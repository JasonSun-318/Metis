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
			contents: ["tokens.css", "app.css", "transcript-navigation.css", path.resolve(__dirname, "../../../node_modules/@xterm/xterm/css/xterm.css")]
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

test("sent file references stay readable and expandable in Chat and Code", async ({ page }, info) => {
	const errors = pageErrors(page);
	for (const mode of ["chat", "code"]) {
		for (const theme of ["dark", "light"]) {
			await page.setViewportSize({ width: 1000, height: 800 });
			await page.goto(`${url}/?mode=${mode}&theme=${theme}&count=1&references=1`);
			const user = page.locator('[data-user-message="user-0"]');
			const cards = user.locator(".message-file-selection");
			await expect(cards).toHaveCount(2);
			await expect(user.locator(".message-user, .code-turn-user-bubble")).toHaveText("翻译一下 [literal.md:1–8]");
			const quote = cards.first().locator("blockquote");
			const toggle = cards.first().locator("summary");
			await expect(toggle).toContainText("AGENTS.md");
			await expect(toggle).toContainText("第 1–8 行");
			await expect(cards.first().locator("details")).not.toHaveAttribute("open");
			await expect.poll(async () => (await cards.first().locator(".transcript-drawer").boundingBox())?.height).toBe(0);
			await toggle.click();
			await expect(cards.first().locator("details")).toHaveAttribute("open");
			await expect.poll(async () => (await cards.first().locator(".transcript-drawer").boundingBox())?.height ?? 0).toBeGreaterThan(50);
			await expect(quote).toContainText("Default language: Chinese.");
			expect(await quote.evaluate((element) => getComputedStyle(element).userSelect)).toBe("text");
			await page.screenshot({ path: info.outputPath(`sent-references-${mode}-${theme}.png`) });
			await toggle.focus();
			await page.keyboard.press("Enter");
			await expect(cards.first().locator("details")).not.toHaveAttribute("open");
			await expect.poll(async () => (await cards.first().locator(".transcript-drawer").boundingBox())?.height).toBe(0);
		}
	}
	expect(errors).toEqual([]);
});

test("Chat and Code text can be selected and terminal action hints appear on hover and focus", async ({ page }, info) => {
	for (const mode of ["chat", "code"]) {
		await page.setViewportSize({ width: 1280, height: 1000 });
		await page.goto(`${url}/?mode=${mode}&count=1&selection=1&terminal=1`);
		const paragraph = page.getByText("Selection paragraph: selectable conversation content.", { exact: true });
		await expect(paragraph).toBeVisible();
		const user = page.locator(mode === "chat" ? ".message-user p" : ".code-turn-user-bubble p").first();
		for (const content of [user, paragraph, page.getByRole("cell", { name: "Table content", exact: true }), page.locator("pre code")]) {
			await content.scrollIntoViewIfNeeded();
			const rect = await content.evaluate((element) => {
				const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
				let node = walker.nextNode() as Text | null;
				while (node && !node.data.trim()) node = walker.nextNode() as Text | null;
				if (!node) throw new Error("Selection fixture has no text");
				const start = node.data.search(/\S/u);
				const range = document.createRange();
				range.setStart(node, start);
				range.setEnd(node, Math.min(node.data.length, start + 8));
				const box = range.getBoundingClientRect();
				return { x: box.x, y: box.y + box.height / 2, width: box.width };
			});
			await page.mouse.move(rect.x + 1, rect.y);
			await page.mouse.down();
			await page.mouse.move(rect.x + rect.width - 1, rect.y, { steps: 8 });
			await page.mouse.up();
			expect(await page.evaluate(() => window.getSelection()?.toString().trim()), await content.innerText()).toBeTruthy();
		}
		const link = page.getByRole("link", { name: "Selectable link" });
		expect(await link.evaluate((element) => getComputedStyle(element).userSelect)).toBe("text");
		for (const name of ["滚动到底部", "清空终端"]) {
			await page.locator("header").click({ position: { x: 20, y: 20 } });
			await page.locator(".terminal-panel").hover({ position: { x: 20, y: 60 } });
			const button = page.getByRole("button", { name, exact: true });
			await button.hover();
			await expect(page.getByRole("tooltip", { name, exact: true })).toBeVisible();
			await page.screenshot({ path: info.outputPath(`terminal-hint-${mode}-${name === "滚动到底部" ? "scroll" : "clear"}.png`) });
			await page.mouse.move(10, 10);
			await expect(page.getByRole("tooltip", { name, exact: true })).toHaveCount(0);
			await page.locator("header button").first().focus();
			for (let index = 0; index < 12 && !await button.evaluate((element) => element === document.activeElement); index += 1) {
				await page.keyboard.press("Tab");
			}
			await expect(button).toBeFocused();
			await expect(page.getByRole("tooltip", { name, exact: true })).toBeVisible();
			await page.locator("header").click({ position: { x: 20, y: 20 } });
		}
		await page.screenshot({ path: info.outputPath(`selectable-transcript-${mode}.png`) });
	}
});

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
