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
	await build({ bundle: true, outfile: path.join(fixtureRoot, "fixture.css"), stdin: { contents: `@import "${path.resolve(__dirname, "../src/renderer/styles/tokens.css").replaceAll("\\", "/")}";\n@import "${path.resolve(__dirname, "../src/renderer/styles/app.css").replaceAll("\\", "/")}";`, loader: "css", resolveDir: fixtureRoot } });
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

async function assertSurface(page: Page) {
	const geometry = await page.locator(".composer-surface").evaluate(async (surface) => {
		await Promise.all(surface.getAnimations({ subtree: true }).filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity).map((animation) => animation.finished.catch(() => {})));
		const stack = surface.querySelector<HTMLElement>(".composer-panels")!;
		const form = surface.querySelector<HTMLElement>(".composer")!;
		const boxes = Array.from(stack.children, (element) => {
			const box = element.getBoundingClientRect();
			const panel = element.matches(".queued-turn-list, .ask-user-resume, .session-status-panel, .slash-command-menu") ? element : element.firstElementChild!;
			return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, radius: getComputedStyle(panel).borderTopLeftRadius, shadow: getComputedStyle(panel).boxShadow, separator: getComputedStyle(element).borderTopWidth };
		});
		return { boxes, radius: getComputedStyle(surface).borderTopLeftRadius, border: getComputedStyle(surface).borderTopWidth, formLeft: form.getBoundingClientRect().left, formRight: form.getBoundingClientRect().right, formRadius: getComputedStyle(form).borderTopLeftRadius, formBorder: getComputedStyle(form).borderTopWidth, codeMode: form.classList.contains("composer-code"), stackHeight: stack.clientHeight, limit: Number.parseFloat(stack.style.getPropertyValue("--composer-panels-limit")), paneHeight: surface.closest(".conversation-column")!.clientHeight, formBottom: form.getBoundingClientRect().bottom, paneBottom: surface.closest(".fixture-pane")!.getBoundingClientRect().bottom };
	});
	expect(geometry.radius).toBe("0px");
	expect(geometry.border).toBe("0px");
	expect(geometry.formRadius).toBe("21px");
	expect(geometry.formBorder).toBe(geometry.codeMode ? "0px" : "1px");
	expect(geometry.stackHeight).toBeLessThanOrEqual(geometry.limit + 1);
	expect(geometry.formBottom).toBeLessThanOrEqual(geometry.paneBottom + 1);
	for (const [index, box] of geometry.boxes.entries()) {
		expect(box.radius).toBe(index === 0 ? "12px" : "0px");
		expect(box.left - geometry.formLeft).toBeGreaterThanOrEqual(16);
		expect(Math.abs((box.left - geometry.formLeft) - (geometry.formRight - box.right))).toBeLessThanOrEqual(1);
		expect(box.shadow).toBe("none");
		expect(Math.abs(box.left - geometry.boxes[0]!.left)).toBeLessThanOrEqual(1);
		expect(Math.abs(box.right - geometry.boxes[0]!.right)).toBeLessThanOrEqual(1);
		if (index > 0) { expect(Math.abs(box.top - geometry.boxes[index - 1]!.bottom)).toBeLessThanOrEqual(1); }
	}
}

for (const mode of ["chat", "code"]) {
	for (const theme of ["dark", "light"]) {
		test(`${mode} ${theme} keeps inset drawers through folds, approvals, questions and removals`, async ({ page }, testInfo) => {
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page.setViewportSize({ width: 1280, height: 840 });
			await open(page, `mode=${mode}&theme=${theme}`);
			await page.locator("#composer-input").fill("Draft preserved across requests");
			await controls(page).getByRole("button", { name: "Ask", exact: true }).click();
			await expect(page.locator(".ask-user-panel")).toBeVisible();
			await expect(page.locator("#composer-input")).toHaveAttribute("contenteditable", "false");
			await assertSurface(page);
			await expect.poll(() => page.locator(".ask-user-slot").evaluate((request) => {
				const stack = request.closest(".composer-panels")!.getBoundingClientRect();
				const bounds = request.getBoundingClientRect();
				return bounds.top >= stack.top - 1 && bounds.bottom <= stack.bottom + 1;
			})).toBe(true);
			await page.screenshot({ path: testInfo.outputPath(`${mode}-${theme}-expanded.png`), animations: "disabled" });
			await page.getByRole("button", { name: "Collapse questions", exact: true }).click();
			await assertSurface(page);
			await page.getByRole("button", { name: "Continue answering", exact: true }).click();
			await controls(page).getByRole("button", { name: "Approval", exact: true }).click();
			await page.getByRole("button", { name: "Collapse approval", exact: true }).click();
			await expect(page.locator(".permission-approval-body")).toBeHidden();
			await page.getByRole("button", { name: "Collapse queued messages", exact: true }).click();
			await page.getByRole("button", { name: "Collapse goal", exact: true }).click();
			await page.getByRole("button", { name: "Collapse task list", exact: true }).click();
			await assertSurface(page);
			await page.screenshot({ path: testInfo.outputPath(`${mode}-${theme}-collapsed.png`), animations: "disabled" });
			await page.getByRole("button", { name: "Expand approval", exact: true }).click();
			await page.getByRole("button", { name: "Allow once", exact: true }).click();
			await expect(page.locator("#composer-input")).toHaveAttribute("contenteditable", "true");
			await expect(page.locator("#composer-input")).toHaveText("Draft preserved across requests");
			await controls(page).getByRole("button", { name: "Clear all", exact: true }).click();
			await expect(page.locator(".composer-panels")).toBeHidden();
			await expect(page.locator(".composer")).toHaveCSS("border-top-left-radius", "21px");
			expect(errors).toEqual([]);
		});
	}
}

test("long stacks stay inside a short pane and required actions remain reachable", async ({ page }, testInfo) => {
	await page.setViewportSize({ width: 900, height: 640 });
	await open(page, "many&paneHeight=320&request=ask&reduced");
	await assertSurface(page);
	await page.locator(".ask-user-option").last().click();
	await page.getByRole("button", { name: "Confirm and continue", exact: true }).click();
	await expect(page.locator(".ask-user-panel")).toHaveCount(0);
	await controls(page).getByRole("button", { name: "Approval", exact: true }).click();
	await page.getByRole("button", { name: "Reject", exact: false }).click();
	await expect(page.locator(".permission-approval-panel")).toHaveCount(0);
	await controls(page).getByRole("button", { name: "Complete tasks", exact: true }).click();
	await expect(page.locator(".task-list-slot")).toHaveCount(0);
	await assertSurface(page);
	await page.screenshot({ path: testInfo.outputPath("short-pane.png") });
});

test("every tasks, goal, queue and request combination keeps equal drawer widths", async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 840 });
	await open(page, "reduced");
	for (const request of ["Ask", "Approval"]) {
		for (let mask = 0; mask < 8; mask += 1) {
			await controls(page).getByRole("button", { name: "Clear all", exact: true }).click();
			for (const [bit, label] of [[1, "Toggle tasks"], [2, "Toggle goal"], [4, "Toggle queue"]] as const) {
				if (mask & bit) await controls(page).getByRole("button", { name: label, exact: true }).click();
			}
			await controls(page).getByRole("button", { name: request, exact: true }).click();
			await assertSurface(page);
		}
	}
});

test("reviewing earlier panels is not interrupted by an unrelated snapshot update", async ({ page }) => {
	await page.setViewportSize({ width: 1280, height: 840 });
	await open(page, "many&request=ask&reduced");
	const stack = page.locator(".composer-panels");
	await expect.poll(() => stack.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
	await stack.evaluate((element) => { element.scrollTop = 0; });
	await controls(page).getByRole("button", { name: "Refresh snapshot", exact: true }).click();
	await expect(stack).toHaveJSProperty("scrollTop", 0);
	await expect(page.locator("#composer-input")).toBeVisible();
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
	expect(geometry).toEqual({ skipHeight: 32, stepHeight: 32, gap: 8, toggleWidth: 28, toggleHeight: 28 });
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

test("status and slash command drawers retain their controls and match the stack edges", async ({ page }) => {
	await page.setViewportSize({ width: 900, height: 720 });
	await open(page, "reduced");
	await page.locator('[aria-controls="session-status-panel"]').click();
	await expect(page.locator(".session-status-panel")).toContainText("25%");
	await assertSurface(page);
	await expect(page.getByRole("button", { name: "Close status", exact: true })).toHaveCSS("width", "28px");
	await expect(page.getByRole("button", { name: "Close status", exact: true })).toHaveCSS("height", "28px");
	await page.getByRole("button", { name: "Close status", exact: true }).click();
	await expect(page.locator(".session-status-panel")).toHaveCount(0);
	await page.locator("#composer-input").fill("/");
	await expect(page.locator(".slash-command-menu")).toBeVisible();
	await assertSurface(page);
	await page.locator("#composer-input").press("Escape");
	await expect(page.locator(".slash-command-menu")).toHaveCount(0);
});

test("submitted questions slide out before removal instead of becoming invisible immediately", async ({ page }) => {
	await open(page, "request=ask");
	await page.locator(".ask-user-option").first().click();
	const frames = await page.locator(".ask-user-slot").evaluate((slot) => new Promise<number[]>((resolve, reject) => {
		const observer = new MutationObserver(() => {
			if (!slot.classList.contains("is-submitting")) return;
			observer.disconnect();
			const animation = slot.getAnimations().find((candidate) => (candidate as CSSAnimation).animationName === "composer-panel-exit");
			if (!animation) { reject(new Error("Exit animation missing")); return; }
			animation.pause();
			const opacities = [0, 70, 140].map((time) => {
				animation.currentTime = time;
				return Number(getComputedStyle(slot).opacity);
			});
			resolve(opacities);
		});
		observer.observe(slot, { attributes: true, attributeFilter: ["class"] });
		slot.querySelector<HTMLButtonElement>(".ask-user-step")!.click();
	}));
	expect(frames[0]).toBe(1);
	expect(frames[1]).toBeGreaterThan(0);
	expect(frames[1]).toBeLessThan(1);
	expect(frames[2]).toBe(0);
	await expect(page.locator(".ask-user-slot")).toHaveCount(0);
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
