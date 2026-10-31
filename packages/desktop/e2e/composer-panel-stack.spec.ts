import { build } from "esbuild";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

test.use({ channel: "chrome" });
let fixtureRoot: string;
let server: Server;
let fixtureUrl: string;

test.beforeAll(async () => {
	fixtureRoot = await mkdtemp(path.join(tmpdir(), "metis-composer-panels-e2e-"));
	await build({ bundle: true, entryPoints: [path.join(__dirname, "composer-panel-stack.fixture.tsx")], format: "esm", jsx: "automatic", loader: { ".css": "empty" }, outfile: path.join(fixtureRoot, "fixture.js"), platform: "browser", target: "es2022" });
	await build({ bundle: true, outfile: path.join(fixtureRoot, "fixture.css"), stdin: { contents: `@import "${path.resolve(__dirname, "../src/renderer/styles/tokens.css").replaceAll("\\", "/")}";\n@import "${path.resolve(__dirname, "../src/renderer/styles/app.css").replaceAll("\\", "/")}";\n@import "${path.resolve(__dirname, "../src/renderer/styles/permission-approval.css").replaceAll("\\", "/")}";\n@import "${path.resolve(__dirname, "../src/renderer/styles/conversation-interactions.css").replaceAll("\\", "/")}";\n@import "${path.resolve(__dirname, "../src/renderer/styles/transcript-navigation.css").replaceAll("\\", "/")}";`, loader: "css", resolveDir: fixtureRoot } });
	await writeFile(path.join(fixtureRoot, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>.fixture-root{display:flex;height:100%;flex-direction:column;font-family:Inter,ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif}.fixture-controls{display:flex;flex-wrap:wrap;gap:8px;padding:10px;flex:none;border-bottom:1px solid var(--border)}.fixture-controls button{padding:5px 8px;border:1px solid var(--border)}.fixture-pane{display:flex;flex:1;min-height:0;overflow:hidden}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`);
	server = createServer((request, response) => {
		const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
		if (pathname === "/favicon.ico") { response.writeHead(204).end(); return; }
		const filename = pathname === "/" ? "index.html" : pathname.slice(1);
		const filePath = path.join(fixtureRoot, filename);
		if (!filePath.startsWith(`${fixtureRoot}${path.sep}`) || !existsSync(filePath)) { response.writeHead(404).end(); return; }
		response.writeHead(200, { "content-type": filename.endsWith(".js") ? "text/javascript" : filename.endsWith(".css") ? "text/css" : "text/html" });
		createReadStream(filePath).pipe(response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Fixture server failed to bind");
	fixtureUrl = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
});

function controls(page: Page) { return page.getByRole("navigation", { name: "Fixture controls" }); }
async function open(page: Page, query: string) {
	await page.goto(`${fixtureUrl}/?${query}`);
	await expect(page.locator("#composer-input")).toBeVisible();
	await page.evaluate(() => document.fonts.ready);
}

async function geometry(page: Page) {
	return page.locator(".composer-surface").evaluate((surface) => {
		const input = surface.querySelector(".composer-code .composer-box") ?? surface.querySelector(".composer")!;
		const box = input.getBoundingClientRect();
		const stack = surface.querySelector(".composer-panels")!.getBoundingClientRect();
		const pane = surface.closest(".conversation-column")!.getBoundingClientRect();
		return { left: box.left, right: box.right, top: box.top, stackLeft: stack.left, stackRight: stack.right, gap: box.top - stack.bottom, height: stack.height, stackTop: stack.top, paneTop: pane.top };
	});
}
async function assertFloating(page: Page) {
	const box = await geometry(page);
	for (const panel of await page.locator(".composer-panels :is(.goal-bar-panel, .queued-turn-list, .slash-command-menu, .session-status-panel):visible").all()) {
		const bounds = (await panel.boundingBox())!;
		expect(Math.abs(bounds.x - box.left)).toBeLessThan(1);
		expect(Math.abs(bounds.x + bounds.width - box.right)).toBeLessThan(1);
	}
	expect(Math.abs(box.left - box.stackLeft)).toBeLessThan(1);
	expect(Math.abs(box.right - box.stackRight)).toBeLessThan(1);
	expect(box.gap).toBeCloseTo(8, 0);
	expect(box.height).toBeLessThanOrEqual(281);
	expect(box.stackTop).toBeGreaterThanOrEqual(box.paneTop);
}
for (const mode of ["chat", "code"]) {
	for (const theme of ["dark", "light"]) {
		test(`${mode} ${theme}: goal chip aligns with the draft and completed goals free composer space`, async ({ page }, testInfo) => {
			await open(page, `mode=${mode}&theme=${theme}&reduced`);
			await controls(page).getByRole("button", { name: "Toggle queue", exact: true }).click();
			await page.locator("#composer-input").fill("/goal");
			await page.getByRole("option").filter({ hasText: "/goal" }).click();
			await page.locator("#composer-input").pressSequentially("test goal");
			const chip = page.locator(".composer-goal-token");
			await expect(chip).toBeVisible();
			const geometry = await chip.evaluate((token) => {
				const name = token.querySelector(".composer-token-name")!;
				const label = document.createRange();
				label.selectNodeContents(name);
				const text = document.createRange();
				const draft = Array.from(token.parentElement!.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent?.includes("test goal"))!;
				text.selectNodeContents(draft);
				const a = label.getBoundingClientRect();
				const b = text.getBoundingClientRect();
				return { delta: Math.abs((a.top + a.bottom - b.top - b.bottom) / 2), shadow: getComputedStyle(token).boxShadow };
			});
			expect(geometry.delta).toBeLessThanOrEqual(2);
			expect(geometry.shadow).not.toBe("none");
			await page.screenshot({ path: testInfo.outputPath("goal-chip.png") });
			await controls(page).getByRole("button", { name: "Complete goal", exact: true }).click();
			await expect(page.locator(".goal-bar-panel")).toHaveCount(0);
			await expect.poll(() => page.locator(".conversation-column").evaluate((element) => element.style.getPropertyValue("--composer-persistent-height"))).toBe("0px");
		});
		test(`${mode} ${theme}: compact floating panels retain state and do not move the conversation`, async ({ page }, testInfo) => {
			await page.setViewportSize({ width: 1100, height: 820 });
			await open(page, `mode=${mode}&theme=${theme}&many&reduced`);
			const input = page.locator("#composer-input");
			const persistent = page.locator(".composer-panels-content");
			await assertFloating(page);
			expect((await page.locator(".goal-bar-panel").boundingBox())!.height).toBeLessThanOrEqual(64);
			expect((await page.locator(".queued-turn-list").boundingBox())!.height).toBeLessThanOrEqual(174);
			await expect(page.getByRole("button", { name: /Collapse (goal|queued)/ })).toHaveCount(0);
			const queue = page.locator(".queued-turn-body");
			await queue.evaluate((element) => { element.scrollTop = 80; });
			const originalScroll = await queue.evaluate((element) => element.scrollTop);
			const before = await geometry(page);
			const transcriptBefore = await page.locator(".transcript").boundingBox();
			await page.screenshot({ path: testInfo.outputPath("goal-queue.png") });
			await input.fill("/");
			await expect(persistent).toBeHidden();
			await expect(persistent).toHaveAttribute("inert", "");
			await expect(page.locator(".slash-command-menu")).toBeVisible();
			await assertFloating(page);
			expect((await geometry(page)).top).toBe(before.top);
			expect(await page.locator(".transcript").boundingBox()).toEqual(transcriptBefore);
			await page.screenshot({ path: testInfo.outputPath("slash.png") });
			await page.keyboard.press("Escape");
			await expect(persistent).toBeVisible();
			expect(await queue.evaluate((element) => element.scrollTop)).toBe(originalScroll);
			await expect(input).toHaveText("/");
			await page.locator(".context-usage-ring").click();
			await expect(page.locator(".session-status-panel")).toBeVisible();
			await expect(persistent).toBeHidden();
			await assertFloating(page);
			await page.screenshot({ path: testInfo.outputPath("context.png") });
			await page.keyboard.press("Escape");
			await expect(persistent).toBeVisible();
			await expect(page.locator(".session-status-panel")).toHaveCount(0);
			expect(await page.evaluate(() => (window as unknown as { composerFixtureCalls: { sent: number; deleted: number } }).composerFixtureCalls)).toMatchObject({ sent: 0, deleted: 0 });
		});
	}
	test(`${mode}: slash menu reopens after changing a dismissed draft`, async ({ page }) => {
		await open(page, `mode=${mode}&reduced`);
		const input = page.locator("#composer-input");
		const menu = page.getByRole("listbox", { name: "Slash commands" });
		await input.fill("/");
		await expect(menu).toBeVisible();
		for (let attempt = 0; attempt < 2; attempt++) {
			await input.press("Escape");
			await expect(menu).toHaveCount(0);
			await expect(input).toHaveText("/");
			await input.press("Backspace");
			await input.press("/");
			await expect(menu).toBeVisible();
		}
		await input.press("Escape");
		await input.press("s");
		await expect(menu).toBeVisible();
		await input.press("Backspace");
		await expect(menu).toBeVisible();
	});
}
test("short narrow pane keeps the last keyboard choice and queued actions reachable", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 520, height: 520 });
	await open(page, "mode=code&many&reduced&paneHeight=330");
	await assertFloating(page);
	const queue = page.locator(".queued-turn-body");
	await queue.evaluate((element) => { element.scrollTop = element.scrollHeight; });
	await expect(page.getByRole("group", { name: "Queued message 12", exact: true }).getByRole("button", { name: "Guide with queued message" })).toBeVisible();
	await page.locator("#composer-input").fill("/");
	for (let index = 0; index < 6; index++) await page.keyboard.press("ArrowDown");
	const menu = page.locator(".slash-command-menu");
	const selected = menu.locator('[aria-selected="true"]');
	await expect(selected).toContainText("/mcp");
	const menuBox = (await menu.boundingBox())!;
	const optionBox = (await selected.boundingBox())!;
	expect(optionBox.y).toBeGreaterThanOrEqual(menuBox.y);
	expect(optionBox.y + optionBox.height).toBeLessThanOrEqual(menuBox.y + menuBox.height);
	await assertFloating(page);
	await page.screenshot({ path: testInfo.outputPath("narrow.png") });
	await page.keyboard.press("Escape");
	await expect(page.locator(".queued-turn-list")).toBeVisible();
});
test("full motion animates exit and survives rapid reopen", async ({ page }) => {
	await open(page, "mode=code");
	const input = page.locator("#composer-input");
	await input.fill("/");
	await expect(page.locator(".slash-command-menu")).toBeVisible();
	await input.press("Escape");
	const exiting = page.locator(".composer-transient-panel.is-closing");
	await expect(exiting).toHaveAttribute("inert", "");
	await expect(exiting).toHaveAttribute("aria-hidden", "true");
	await expect(exiting).toHaveCount(0);
	await input.fill("/st");
	await expect(page.locator(".slash-command-menu")).toContainText("/status");
	await input.press("Enter");
	await expect(page.locator(".session-status-panel")).toBeVisible();
	await page.getByRole("button", { name: "Close status", exact: true }).click();
	await page.locator(".context-usage-ring").click();
	await expect(page.locator(".session-status-panel")).toBeVisible();
	await page.waitForTimeout(240);
	await expect(page.locator(".session-status-panel")).toBeVisible();
	await page.getByRole("button", { name: "Close status", exact: true }).click();
	await expect(page.locator(".composer-panels-content")).toBeVisible();
});

test("questions allow free navigation, immediate custom answers and one complete submission", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 900, height: 720 });
	await open(page, "multi&request=ask&reduced");
	const next = page.getByRole("button", { name: "Next question", exact: true });
	const previous = page.getByRole("button", { name: "Previous question", exact: true });
	await next.click();
	await page.getByRole("checkbox", { name: "Desktop", exact: true }).click();
	await page.getByRole("textbox", { name: "Something else", exact: true }).fill("Linux 也需要支持");
	await next.click();
	await page.getByRole("radio", { name: "None", exact: false }).click();
	await page.getByRole("button", { name: "Confirm and continue", exact: true }).click();
	await expect(page.getByRole("alert")).toHaveText("Answer question 1 before submitting.");
	await expect(previous).toBeDisabled();
	await page.getByRole("textbox", { name: "Something else", exact: true }).fill("保存到当前项目 / Keep it local");
	await next.click();
	await expect(page.getByRole("textbox", { name: "Something else", exact: true })).toHaveValue("Linux 也需要支持");
	await expect(page.getByRole("checkbox", { name: "Desktop", exact: true })).toBeChecked();
	const geometry = await page.locator(".ask-user-actions").evaluate((footer) => {
		const skip = footer.querySelector(".ask-user-skip")!.getBoundingClientRect();
		const step = footer.querySelector(".ask-user-step")!.getBoundingClientRect();
		const toggle = footer.querySelector(".composer-panel-toggle")!.getBoundingClientRect();
		return { skipHeight: skip.height, stepHeight: step.height, gap: step.left - skip.right, toggleWidth: toggle.width, toggleHeight: toggle.height };
	});
	expect(geometry).toEqual({ skipHeight: 28, stepHeight: 28, gap: 4, toggleWidth: 28, toggleHeight: 28 });
	await page.screenshot({ path: testInfo.outputPath("custom-question.png") });
	await next.click();
	await page.getByRole("button", { name: "Confirm and continue", exact: true }).click();
	await expect(page.locator(".ask-user-panel")).toHaveCount(0);
	const responses = await page.evaluate(() => (window as unknown as { composerFixtureResponses: unknown[] }).composerFixtureResponses);
	expect(responses).toHaveLength(1);
	expect(responses[0]).toMatchObject({ kind: "ask_user", cancelled: false, answers: [
		{ customAnswer: "保存到当前项目 / Keep it local", choiceIds: [] },
		{ customAnswer: "Linux 也需要支持", choiceIds: ["desktop"] },
		{ choiceIds: ["none"] },
	] });
});

for (const mode of ["chat", "code"]) {
	test(`${mode} keeps user and assistant base sizes aligned for serif and sans at 13, 15 and 20px`, async ({ page }, testInfo) => {
		await page.setViewportSize({ width: 960, height: 800 });
		let userFont: string | undefined;
		for (const font of ["sans", "serif"]) {
			for (const size of [13, 15, 20]) {
				await open(page, `mode=${mode}&typography&font=${font}&size=${size}&reduced`);
				const user = page.locator(mode === "code" ? ".code-turn-user-bubble p" : ".message-user p");
				const assistant = page.locator(mode === "code" ? ".code-turn-answer p" : ".turn-answer p").first();
				await expect(user).toContainText("检查中文与 English");
				await expect(assistant).toContainText("检查中文与 English");
				await expect(user).toHaveCSS("font-size", `${size}px`);
				await expect(assistant).toHaveCSS("font-size", `${size}px`);
				await expect(user).toHaveCSS("line-height", `${Number((size * 1.55).toFixed(2))}px`);
				await expect(assistant).toHaveCSS("line-height", `${Number((size * 1.55).toFixed(2))}px`);
				const family = await user.evaluate((node) => getComputedStyle(node).fontFamily);
				userFont ??= family;
				expect(family).toBe(userFont);
				await expect(assistant).toHaveCSS("font-family", font === "serif" ? /Metis Anthropic Serif/ : /sans-serif/);
				await expect(page.locator(mode === "code" ? ".code-turn-answer code" : ".turn-answer code")).toHaveCSS("font-family", /monospace/);
				if (size === 15) await page.screenshot({ path: testInfo.outputPath(`${mode}-${font}-${size}.png`) });
			}
		}
	});
}
