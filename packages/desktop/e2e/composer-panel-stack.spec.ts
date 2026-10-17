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
	await writeFile(path.join(fixtureRoot, "index.html"), `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>.fixture-root{display:flex;height:100%;flex-direction:column;font-family:var(--chat-prose-font)}.fixture-controls{display:flex;flex-wrap:wrap;gap:8px;padding:10px;flex:none;border-bottom:1px solid var(--border)}.fixture-controls button{padding:5px 8px;border:1px solid var(--border)}.fixture-pane{display:flex;flex:1;min-height:0;overflow:hidden}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`);
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
	const geometry = await page.locator(".composer-surface").evaluate((surface) => {
		const stack = surface.querySelector<HTMLElement>(".composer-panels")!;
		const form = surface.querySelector<HTMLElement>(".composer")!;
		const boxes = Array.from(stack.children, (element) => {
			const box = element.getBoundingClientRect();
			const panel = element.matches(".queued-turn-list, .ask-user-resume") ? element : element.firstElementChild!;
			return { left: box.left, right: box.right, top: box.top, bottom: box.bottom, radius: getComputedStyle(panel).borderTopLeftRadius, shadow: getComputedStyle(panel).boxShadow, separator: getComputedStyle(element).borderTopWidth };
		});
		return { boxes, radius: getComputedStyle(surface).borderTopLeftRadius, border: getComputedStyle(surface).borderTopWidth, formRadius: getComputedStyle(form).borderTopLeftRadius, formBorder: getComputedStyle(form).borderTopWidth, stackHeight: stack.clientHeight, limit: Number.parseFloat(stack.style.getPropertyValue("--composer-panels-limit")), paneHeight: surface.closest(".conversation-column")!.clientHeight, formBottom: form.getBoundingClientRect().bottom, paneBottom: surface.closest(".fixture-pane")!.getBoundingClientRect().bottom };
	});
	expect(geometry.radius).toBe("21px");
	expect(geometry.border).toBe("1px");
	expect(geometry.formRadius).toBe("0px");
	expect(geometry.formBorder).toBe("0px");
	expect(geometry.stackHeight).toBeLessThanOrEqual(geometry.limit + 1);
	expect(geometry.formBottom).toBeLessThanOrEqual(geometry.paneBottom + 1);
	for (const [index, box] of geometry.boxes.entries()) {
		expect(box.radius).toBe("0px");
		expect(box.shadow).toBe("none");
		expect(Math.abs(box.left - geometry.boxes[0]!.left)).toBeLessThanOrEqual(1);
		expect(Math.abs(box.right - geometry.boxes[0]!.right)).toBeLessThanOrEqual(1);
		if (index > 0) { expect(Math.abs(box.top - geometry.boxes[index - 1]!.bottom)).toBeLessThanOrEqual(1); expect(box.separator).toBe("1px"); }
	}
}

for (const mode of ["chat", "code"]) {
	for (const theme of ["dark", "light"]) {
		test(`${mode} ${theme} keeps one surface through folds, approvals, questions and removals`, async ({ page }, testInfo) => {
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

test("every tasks, goal, queue and request combination has continuous borders", async ({ page }) => {
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
