import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
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
			contents: [
				"tokens.css",
				"app.css",
				"transcript-navigation.css",
				"conversation-interactions.css",
				path.resolve(__dirname, "../../../node_modules/@xterm/xterm/css/xterm.css"),
			]
				.map(
					(file) => `@import "${path.resolve(__dirname, "../src/renderer/styles", file).replaceAll("\\", "/")}";`,
				)
				.join("\n"),
			loader: "css",
			resolveDir: directory,
		},
		bundle: true,
		outfile: path.join(directory, "fixture.css"),
	});
	await writeFile(
		path.join(directory, "index.html"),
		`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>body{font-family:Inter,-apple-system,sans-serif}#root{height:100%}.fixture-workspace{height:100%;display:flex;flex-direction:column}.fixture-workspace>header{display:flex;align-items:center;justify-content:space-between;height:48px;padding:0 28px;border-bottom:1px solid var(--border);font-size:13px}.fixture-workspace>header button{margin-left:12px;color:var(--muted);font-size:11px}.fixture-workspace>footer{width:min(770px,calc(100% - 80px));height:100px;padding:18px;margin:12px auto 18px;border:1px solid var(--border);border-radius:18px;color:var(--muted);font-size:13px}.fixture-workspace>footer span{display:block;margin-top:20px}.fixture-quote-composer{width:min(770px,calc(100% - 48px));margin:12px auto 18px;flex:none}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`,
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

async function hoverNavigationMark(page: Page, mark: Locator) {
	// Each visible index row retains the corresponding message identity while the index scrolls.
	const bounds = await mark.boundingBox();
	if (!bounds) throw new Error("Navigation mark has no bounds");
	const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
	await page.mouse.move(point.x, point.y);
	return point;
}

async function selectQuote(page: Page, target: Locator, text: string) {
	await target.scrollIntoViewIfNeeded();
	// A click collapses an existing selection before a fresh drag (rather than dragging its text).
	await target.click({ position: { x: 4, y: 4 } });
	const rect = await target.evaluate((element, text) => {
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		let node: Text | null;
		while ((node = walker.nextNode() as Text | null)) {
			const start = node.data.indexOf(text);
			if (start < 0) continue;
			const range = document.createRange();
			range.setStart(node, start);
			range.setEnd(node, start + text.length);
			const bounds = range.getBoundingClientRect();
			return { x: bounds.x, y: bounds.y + bounds.height / 2, width: bounds.width };
		}
		throw new Error("Quote fixture text missing");
	}, text);
	await page.mouse.move(rect.x + 0.2, rect.y);
	await page.mouse.down();
	await page.mouse.move(rect.x + rect.width - 0.2, rect.y, { steps: 12 });
	await page.mouse.up();
	await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe(text);
	await expect(page.locator(".conversation-selection-popover")).toBeVisible();
}

test("conversation selections become compact annotations and survive reload in both modes and themes", async ({
	page,
}, info) => {
	test.setTimeout(90_000);
	const errors = pageErrors(page);
	for (const mode of ["chat", "code"])
		for (const theme of ["dark", "light"]) {
			await page.setViewportSize({ width: 1000, height: 840 });
			await page.goto(`${url}/?mode=${mode}&theme=${theme}&count=2&selection=1&quotes=1`);
			const selected = "selectable conversation content.";
			const paragraph = page
				.getByText("Selection paragraph: selectable conversation content.", { exact: true })
				.last();
			await selectQuote(page, paragraph, selected);
			await page.getByRole("button", { name: "添加到会话", exact: true }).click();
			const editor = page.locator('[contenteditable="true"]');
			await expect(editor).toBeFocused();
			await expect(page.locator(".composer-conversation-quotes summary")).toContainText("1 段对话引用");
			await editor.fill("详细解释引用的内容");
			const userText = "请整理产品资料中的知识点";
			await selectQuote(page, page.locator('[data-quote-item="user-1"]'), userText);
			await page.getByRole("button", { name: "添加到会话", exact: true }).click();
			await expect(editor).toHaveText("详细解释引用的内容");
			await expect(page.locator(".composer-conversation-quotes summary")).toContainText("2 段对话引用");
			await page.locator(".composer-conversation-quotes summary").click();
			await page.getByRole("button", { name: "移除对话引用", exact: true }).first().click();
			await expect(page.locator(".composer-conversation-quotes summary")).toContainText("1 段对话引用");
			await selectQuote(page, paragraph, selected);
			await page.getByRole("button", { name: "添加到会话", exact: true }).click();
			await editor.press("Enter");
			const sent = page.locator('[data-user-message^="sent-"]');
			const trigger = sent.locator(".message-annotations-trigger");
			await expect(trigger).toHaveText("2 条注释");
			await expect(trigger).toBeInViewport();
			await expect(page.locator(".composer-conversation-quotes")).toHaveCount(0);
			const submission = await page.evaluate(
				() =>
					(
						globalThis as typeof globalThis & {
							quoteSubmission: {
								text: string;
								conversationQuotes: { sourceItemId: string; sourceRole: string; selectedText: string }[];
							};
						}
					).quoteSubmission,
			);
			expect(submission.text).toBe("详细解释引用的内容");
			expect(submission.conversationQuotes).toEqual([
				{ sourceItemId: "user-1", sourceRole: "user", selectedText: userText },
				{ sourceItemId: "answer-1", sourceRole: "assistant", selectedText: selected },
			]);
			const bubble = sent.locator(".message-user, .code-turn-user-bubble");
			expect((await trigger.boundingBox())!.y).toBeGreaterThanOrEqual(
				(await bubble.boundingBox())!.y + (await bubble.boundingBox())!.height,
			);
			await page.screenshot({ path: info.outputPath(`annotations-${mode}-${theme}.png`) });
			await trigger.click();
			const popup = page.getByRole("dialog", { name: "对话注释", exact: true });
			await expect(popup).toContainText(selected);
			await expect(popup).toContainText("来自 Metis");
			await page.screenshot({ path: info.outputPath(`annotation-preview-${mode}-${theme}.png`) });
			await popup
				.locator("section")
				.filter({ hasText: selected })
				.getByRole("button", { name: "跳转到原消息" })
				.click();
			await expect(popup).toHaveCount(0);
			await expect(page.locator('[data-quote-item="answer-1"]').first()).toBeInViewport();
			await trigger.scrollIntoViewIfNeeded();
			await trigger.focus();
			await trigger.press("Enter");
			await expect(popup).toBeVisible();
			await page.keyboard.press("Escape");
			await expect(popup).toHaveCount(0);
			await expect(trigger).toBeFocused();
			await page.reload();
			await expect(trigger).toHaveText("2 条注释");
			await page.setViewportSize({ width: 420, height: 720 });
			await trigger.click();
			await expect(popup).toContainText(selected);
			const bounds = (await popup.boundingBox())!;
			expect(bounds.x).toBeGreaterThanOrEqual(7);
			expect(bounds.x + bounds.width).toBeLessThanOrEqual(413);
			expect(bounds.y).toBeGreaterThanOrEqual(7);
			expect(bounds.y + bounds.height).toBeLessThanOrEqual(713);
			await page.keyboard.press("Escape");
		}
	expect(errors).toEqual([]);
});

test("quote drafts stay in their session and selections in code remain usable", async ({ page }) => {
	await page.setViewportSize({ width: 1000, height: 840 });
	await page.goto(`${url}/?mode=code&theme=dark&count=1&selection=1&quotes=1`);
	await selectQuote(page, page.locator("pre code"), "const selectable = true;");
	await page.getByRole("button", { name: "添加到会话", exact: true }).click();
	await expect(page.locator(".composer-conversation-quotes")).toHaveCount(1);
	await page.getByRole("button", { name: "Switch session" }).click();
	await expect(page.locator(".composer-conversation-quotes")).toHaveCount(0);
	await expect(page.locator(".conversation-selection-popover")).toHaveCount(0);
	await page.getByRole("button", { name: "Switch session" }).click();
	await expect(page.locator(".composer-conversation-quotes")).toHaveCount(1);
});

test("a quote waits for a streaming reply to finish before it can be added", async ({ page }) => {
	await page.setViewportSize({ width: 1000, height: 840 });
	await page.goto(`${url}/?mode=chat&theme=dark&count=1&selection=1&quotes=1&streaming=1`);
	await selectQuote(
		page,
		page.getByText("Selection paragraph: selectable conversation content.", { exact: true }),
		"selectable conversation content.",
	);
	await expect(page.getByRole("button", { name: "添加到会话", exact: true })).toBeDisabled();
	await expect(page.locator(".conversation-selection-notice")).toHaveText("回复完成后即可引用");
	await page.getByRole("button", { name: "Finish reply" }).click();
	await selectQuote(
		page,
		page.getByText("Selection paragraph: selectable conversation content.", { exact: true }),
		"selectable conversation content.",
	);
	await expect(page.getByRole("button", { name: "添加到会话", exact: true })).toBeEnabled();
	await page.getByRole("button", { name: "添加到会话", exact: true }).click();
	await expect(page.locator(".composer-conversation-quotes")).toHaveCount(1);
});

test("annotation source navigation resolves live aliases while loading older virtualized history", async ({ page }) => {
	await page.setViewportSize({ width: 1000, height: 840 });
	await page.goto(`${url}/?mode=chat&theme=dark&count=70&quoteHistory=1&quotes=1`);
	const trigger = page.locator('[data-user-message="user-69"] .message-annotations-trigger');
	await trigger.click();
	await page.getByRole("button", { name: "跳转到原消息" }).click();
	await expect(page.locator('[data-quote-item="answer--1"]')).toBeInViewport();
	await expect(page.locator(".transcript-quote-notice")).toHaveCount(0);
});

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
			await expect
				.poll(async () => (await cards.first().locator(".transcript-drawer").boundingBox())?.height)
				.toBe(0);
			await toggle.click();
			await expect(cards.first().locator("details")).toHaveAttribute("open");
			await expect
				.poll(async () => (await cards.first().locator(".transcript-drawer").boundingBox())?.height ?? 0)
				.toBeGreaterThan(50);
			await expect(quote).toContainText("Default language: Chinese.");
			expect(await quote.evaluate((element) => getComputedStyle(element).userSelect)).toBe("text");
			await page.screenshot({ path: info.outputPath(`sent-references-${mode}-${theme}.png`) });
			await toggle.focus();
			await page.keyboard.press("Enter");
			await expect(cards.first().locator("details")).not.toHaveAttribute("open");
			await expect
				.poll(async () => (await cards.first().locator(".transcript-drawer").boundingBox())?.height)
				.toBe(0);
		}
	}
	expect(errors).toEqual([]);
});

test("Chat and Code text can be selected and terminal action hints appear on hover and focus", async ({
	page,
}, info) => {
	for (const mode of ["chat", "code"]) {
		await page.setViewportSize({ width: 1280, height: 1000 });
		await page.goto(`${url}/?mode=${mode}&count=1&selection=1&terminal=1`);
		const paragraph = page.getByText("Selection paragraph: selectable conversation content.", { exact: true });
		await expect(paragraph).toBeVisible();
		const user = page.locator(mode === "chat" ? ".message-user p" : ".code-turn-user-bubble p").first();
		for (const content of [
			user,
			paragraph,
			page.getByRole("cell", { name: "Table content", exact: true }),
			page.locator("pre code"),
		]) {
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
			expect(
				await page.evaluate(() => window.getSelection()?.toString().trim()),
				await content.innerText(),
			).toBeTruthy();
		}
		const link = page.getByRole("link", { name: "Selectable link" });
		expect(await link.evaluate((element) => getComputedStyle(element).userSelect)).toBe("text");
		for (const name of ["滚动到底部", "清空终端"]) {
			await page.locator("header").click({ position: { x: 20, y: 20 } });
			await page.locator(".terminal-panel").hover({ position: { x: 20, y: 60 } });
			const button = page.getByRole("button", { name, exact: true });
			await button.hover();
			await expect(page.getByRole("tooltip", { name, exact: true })).toBeVisible();
			await page.screenshot({
				path: info.outputPath(`terminal-hint-${mode}-${name === "滚动到底部" ? "scroll" : "clear"}.png`),
			});
			await page.mouse.move(10, 10);
			await expect(page.getByRole("tooltip", { name, exact: true })).toHaveCount(0);
			await page.locator("header button").first().focus();
			for (
				let index = 0;
				index < 12 && !(await button.evaluate((element) => element === document.activeElement));
				index += 1
			) {
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
	const marks = page.locator("[data-navigation-turn]");
	const mark = marks.nth(Math.floor((await marks.count()) * 0.36));
	const selectedPoint = await hoverNavigationMark(page, mark);
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
	await page.mouse.click(selectedPoint.x, selectedPoint.y);
	await expect(preview).not.toBeVisible();
	await expect.poll(() => scroll.evaluate((element) => element.scrollTop)).toBeGreaterThan(1000);
	await rail.focus();
	await rail.press("Home");
	await rail.press("Enter");
	await expect(page.locator('[data-user-message="user-0"]')).toBeInViewport();
	await expect(page.locator('[data-user-message="user-0"] .message-file-card')).toHaveCount(2);
	await page.screenshot({ path: info.outputPath("agent-attachment-cards.png") });
	await expect(page.locator(".conversation-navigation-older")).toHaveCount(0);
	const anchor = page.locator('[data-user-message="user-0"]');
	const anchorOffset = await anchor.evaluate(
		(element) =>
			element.getBoundingClientRect().top - element.closest(".transcript-scroll")!.getBoundingClientRect().top,
	);
	// PageUp pages the conversation; wheel input is reserved for browsing index rows.
	await rail.focus();
	await rail.press("PageUp");
	await expect(rail).toHaveAttribute("aria-valuemax", "122");
	await expect(anchor).toBeInViewport();
	await expect
		.poll(() =>
			anchor.evaluate(
				(element, offset) =>
					Math.abs(
						element.getBoundingClientRect().top -
							element.closest(".transcript-scroll")!.getBoundingClientRect().top -
							offset,
					),
				anchorOffset,
			),
		)
		.toBeLessThan(5);
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

test("message lookup preserves turn boundaries, keyboard navigation, narrow light layout and Editor exclusion", async ({
	page,
}, info) => {
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
	await expect(rail).toHaveAttribute("aria-valuenow", "46");
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
	await expect(page.locator('[data-user-message="steer-45"]')).toHaveCount(1);
	await rail.press("ArrowDown");
	await expect(rail).toHaveAttribute("aria-valuenow", "47");
	await expect(page.locator(".conversation-navigation-preview")).toContainText("第 47 个问题");
	await rail.press("Escape");
	await expect(page.locator(".conversation-navigation-preview")).toHaveCount(0);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
	await page.goto(`${url}?mode=code&surface=editor`);
	await expect(page.locator(".transcript-code")).toBeVisible();
	await expect(rail).toHaveCount(0);
	expect(errors).toEqual([]);
});

test("reference-sized index keeps one real tick per turn and precise keyboard question-answer lookup", async ({
	page,
}, info) => {
	await page.setViewportSize({ width: 1280, height: 840 });
	await page.goto(`${url}?count=40`);
	const rail = page.getByRole("slider", { name: "会话导航" });
	await expect(rail).toBeVisible();
	await expect(rail).toHaveAttribute("aria-valuemax", "40");
	await expect(page.locator("[data-navigation-turn]")).toHaveCount(40);
	await rail.focus();
	await rail.press("Home");
	for (let index = 0; index < 20; index += 1) await rail.press("ArrowDown");
	const preview = page.locator(".conversation-navigation-preview");
	await expect(preview).toContainText("第 21 个问题");
	await expect(preview).toContainText("第 21 条回答");
	await expect.poll(() => preview.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
	await page.screenshot({ path: info.outputPath("agent-navigation-reference.png") });
	const current = page.locator("[data-navigation-turn].is-current");
	await expect(current).toHaveAttribute("data-navigation-turn", "user-20");
	const slot = Number(await current.getAttribute("data-navigation-index"));
	for (const [distance, width] of [26, 20, 14, 8, 6].entries()) {
		await expect(page.locator(`[data-navigation-index="${slot - distance}"]`)).toHaveCSS("width", `${width}px`);
	}
});

for (const mode of ["chat", "code"] as const) {
	test(`${mode} shows a compact return-to-bottom control while reading an active conversation`, async ({ page }, info) => {
		await page.setViewportSize({ width: 1280, height: 840 });
		await page.goto(`${url}?mode=${mode}&running=1&count=30`);
		const scroll = page.locator(".transcript-scroll");
		const button = page.getByRole("button", { name: "滚动到底部", exact: true });
		await expect.poll(() => scroll.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(2);
		await expect(button).toBeHidden();
		await scroll.hover();
		await page.mouse.wheel(0, -700);
		await expect(button).toBeVisible();
		await expect(button).toHaveCSS("height", "30px");
		await expect(button).toHaveCSS("position", "absolute");
		await page.screenshot({ path: info.outputPath(`${mode}-return-to-bottom.png`) });
		await page.getByRole("button", { name: "Append reply" }).click();
		await expect.poll(() => scroll.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeGreaterThan(100);
		await button.click();
		await expect.poll(() => scroll.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(2);
		await expect(button).toBeHidden();
		await page.getByRole("button", { name: "Append reply" }).click();
		await expect.poll(() => scroll.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(2);
	});

	test(`accepted ${mode} messages return to the latest item without taking later scroll ownership`, async ({ page }) => {
		await page.setViewportSize({ width: 1280, height: 840 });
		await page.goto(`${url}?mode=${mode}&quotes=1&submission=1&count=30`);
		const rail = page.getByRole("slider", { name: "会话导航" });
		const editor = page.locator("[contenteditable=true]");
		const scroll = page.locator(".transcript-scroll");
		await rail.focus();
		await rail.press("Home");
		await rail.press("Enter");
		await expect(page.locator('[data-user-message="user-0"]')).toBeInViewport();
		const top = await scroll.evaluate((element) => element.scrollTop);
		await editor.fill("fail");
		await editor.press("Enter");
		await expect(editor).toHaveText("fail");
		expect(await scroll.evaluate((element) => element.scrollTop)).toBe(top);
		await editor.fill("queue");
		await editor.press("Enter");
		await expect(editor).toBeEmpty();
		expect(await scroll.evaluate((element) => element.scrollTop)).toBe(top);
		await editor.fill("Show my accepted message");
		await editor.press("Enter");
		const sent = page.locator('[data-user-message^="sent-"]');
		await expect(sent).toBeInViewport();
		await expect.poll(() => scroll.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
		await expect(sent.locator(mode === "chat" ? ".message-user" : ".code-turn-user-bubble")).toHaveCSS("animation-duration", "0.26s");
		await rail.focus();
		await rail.press("Home");
		await rail.press("Enter");
		await expect(page.locator('[data-user-message="user-0"]')).toBeInViewport();
		await page.getByRole("button", { name: "Append reply" }).click();
		await expect(page.locator('[data-user-message="user-0"]')).toBeInViewport();
	});

	test(`${mode} plan and task cards have compact measured spacing and full header hit areas`, async ({ page }, info) => {
		await page.setViewportSize({ width: 1280, height: 900 });
		await page.goto(`${url}?mode=${mode}&cards=1&count=0`);
		const tasks = page.locator(".conversation-tasks");
		const heading = tasks.locator("button");
		await expect(heading).toHaveAttribute("aria-expanded", "false");
		const taskBox = (await tasks.boundingBox())!;
		const headingBox = (await heading.boundingBox())!;
		expect(headingBox.width).toBeGreaterThan(taskBox.width - 3);
		expect(headingBox.height).toBeGreaterThan(taskBox.height - 3);
		await tasks.click({ position: { x: 7, y: 7 } });
		await expect(heading).toHaveAttribute("aria-expanded", "true");
		await expect(heading).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		await heading.focus();
		await heading.press("Space");
		await expect(heading).toHaveAttribute("aria-expanded", "false");
		await heading.press("Enter");
		await expect(heading).toHaveAttribute("aria-expanded", "true");
		await heading.press("Space");
		await expect.poll(() => tasks.locator(".transcript-drawer").evaluate((element) => element.getBoundingClientRect().height)).toBeLessThan(1);
		const plan = page.locator(".plan-card");
		await expect(plan.locator(".markdown, summary")).toHaveCount(0);
		await expect(page.locator("[data-transcript-turn]")).toHaveCount(2);
		const geometry = await plan.evaluate((card) => {
			const row = card.closest<HTMLElement>("[data-index]")!;
			const previous = row.previousElementSibling!;
			const next = row.nextElementSibling!;
			const lastTool = previous.querySelector(".code-execution > summary, .execution-chain > summary")!;
			const answer = next.querySelector("[data-transcript-answer]")!;
			return {
				before: card.getBoundingClientRect().top - lastTool.getBoundingClientRect().bottom,
				after: answer.getBoundingClientRect().top - card.getBoundingClientRect().bottom,
				width: card.getBoundingClientRect().width - previous.getBoundingClientRect().width,
				height: card.getBoundingClientRect().height,
			};
		});
		expect(Math.abs(geometry.before - 10)).toBeLessThanOrEqual(1);
		expect(Math.abs(geometry.after - 10)).toBeLessThanOrEqual(1);
		expect(geometry.width).toBe(0);
		expect(geometry.height).toBeLessThan(130);
		const actions = plan.locator(".plan-card-actions button");
		await expect(actions).toHaveText(["取消计划", "修改计划", "开始执行"]);
		expect(await actions.nth(2).evaluate((button) => getComputedStyle(button).backgroundColor)).not.toBe(await actions.nth(0).evaluate((button) => getComputedStyle(button).backgroundColor));
		await page.screenshot({ path: info.outputPath(`compact-plan-${mode}.png`) });
		const execution = page.locator(".code-execution, .execution-chain");
		await execution.locator(":scope > summary").click();
		await expect.poll(async () => {
			const cardBounds = (await plan.boundingBox())!;
			const toolBounds = (await execution.boundingBox())!;
			return Math.abs(cardBounds.y - toolBounds.y - toolBounds.height - 10);
		}).toBeLessThanOrEqual(1);
		await execution.locator(":scope > summary").click();
		await page.setViewportSize({ width: 420, height: 800 });
		await page.evaluate(() => { document.documentElement.dataset.theme = "light"; document.documentElement.dataset.motion = "reduced"; });
		await expect(plan.locator('[data-plan-action="start"]')).toBeInViewport();
		await expect(plan.locator(".plan-card-title")).toHaveCSS("color", "rgb(37, 35, 32)");
		expect(await plan.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
		await heading.focus();
		await heading.press("Enter");
		await expect(heading).toHaveAttribute("aria-expanded", "true");
		await expect(tasks.locator("li")).toBeVisible();
		await expect.poll(async () => {
			const cardBounds = (await plan.boundingBox())!;
			const summaryBounds = (await execution.locator(":scope > summary").boundingBox())!;
			return Math.abs(cardBounds.y - summaryBounds.y - summaryBounds.height - 10);
		}).toBeLessThanOrEqual(1);
		await page.screenshot({ path: info.outputPath(`compact-plan-${mode}-narrow-light.png`) });
	});
}
