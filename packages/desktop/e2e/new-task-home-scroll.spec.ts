import { build } from "esbuild";
import { createReadStream, existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page, type TestInfo } from "@playwright/test";

test.use({ channel: "chrome" });

const fixturePath = path.join(__dirname, "new-task-home-scroll.fixture.tsx");
const desktopRoot = path.resolve(path.dirname(fixturePath), "..");

interface FixtureServer {
	readonly server: Server;
	readonly url: string;
}

interface RectSnapshot {
	top: number;
	bottom: number;
	left: number;
	width: number;
	height: number;
}

interface HomeSnapshot {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
	headingText: string;
	heading: RectSnapshot;
	headingLineHeight: number;
	composer: RectSnapshot;
	discovery: RectSnapshot;
	recentSection: RectSnapshot | null;
	cards: readonly RectSnapshot[];
}

async function buildFixture(outputDir: string): Promise<string> {
	const outputFile = path.join(outputDir, "new-task-home-scroll.js");
	await build({
		bundle: true,
		entryPoints: [fixturePath],
		format: "esm",
		jsx: "automatic",
		loader: { ".css": "empty" },
		outfile: outputFile,
		platform: "browser",
		sourcemap: false,
		target: "es2022",
	});
	const cssOutput = path.join(outputDir, "new-task-home-scroll.css");
	await build({
		bundle: true,
		minify: false,
		outfile: cssOutput,
		platform: "browser",
		stdin: {
			contents: `@import "${path.resolve(desktopRoot, "src/renderer/styles/tokens.css").replaceAll("\\", "/")}";\n@import "${path.resolve(desktopRoot, "src/renderer/styles/app.css").replaceAll("\\", "/")}";`,
			loader: "css",
			resolveDir: outputDir,
			sourcefile: "bundle-input.css",
		},
	});
	const generatedCss = path.join(outputDir, "new-task-home-scroll.css");
	if (!existsSync(generatedCss)) throw new Error(`Fixture CSS was not generated: ${generatedCss}`);
	return outputFile;
}

async function startFixtureServer(outputDir: string, scriptPath: string): Promise<FixtureServer> {
	const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/new-task-home-scroll.css"><style>html,body,#root{display:flex;flex:1;min-height:0}#root{width:100%;padding-left:296px;}</style></head><body><div id="root"></div>
<script type="module" src="/${path.basename(scriptPath)}"></script></body></html>`;
	await writeFile(path.join(outputDir, "index.html"), html);
	const server = createServer((request, response) => {
		const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
		const file = pathname === "/" ? "index.html" : pathname.slice(1);
		const filePath = path.join(outputDir, file);
		if (pathname === "/favicon.ico") {
			response.writeHead(204).end();
			return;
		}
		if (!filePath.startsWith(`${outputDir}${path.sep}`) || !existsSync(filePath)) {
			response.writeHead(404).end();
			return;
		}
		const contentType = file.endsWith(".css") ? "text/css" : file.endsWith(".js") ? "text/javascript" : "text/html";
		response.writeHead(200, { "content-type": contentType });
		createReadStream(filePath).pipe(response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Fixture server did not bind to TCP");
	return { server, url: `http://127.0.0.1:${address.port}` };
}

async function snapshot(page: Page): Promise<HomeSnapshot> {
	return page.evaluate(() => {
		const rect = (element: Element | null): RectSnapshot => {
			const box = element?.getBoundingClientRect();
			if (!box) throw new Error("Expected home geometry element");
			return { top: box.top, bottom: box.bottom, left: box.left, width: box.width, height: box.height };
		};
		const scroll = document.querySelector<HTMLElement>(".new-task-home-scroll");
		if (!scroll) throw new Error("Home scroll container is missing");
		const recentSection = document.querySelector(".new-task-recent-projects");
		return {
			scrollTop: scroll.scrollTop,
			scrollHeight: scroll.scrollHeight,
			clientHeight: scroll.clientHeight,
			headingText: document.querySelector(".new-task-home-heading h1")?.textContent?.trim() ?? "",
			heading: rect(document.querySelector(".new-task-home-heading h1")),
			headingLineHeight: Number.parseFloat(
				getComputedStyle(document.querySelector(".new-task-home-heading h1") as HTMLElement).lineHeight,
			),
			composer: rect(document.querySelector(".new-task-home-composer")),
			discovery: rect(document.querySelector(".new-task-home-discovery")),
			recentSection: recentSection ? rect(recentSection) : null,
			cards: Array.from(document.querySelectorAll(".new-task-starter"), (card) => rect(card)),
		};
	});
}

async function scrollAndSnapshot(page: Page, value: number): Promise<HomeSnapshot> {
		await page.evaluate((next) => {
			const scroll = document.querySelector<HTMLElement>(".new-task-home-scroll");
			if (!scroll) throw new Error("Home scroll container is missing");
			scroll.scrollTo({ top: next, behavior: "auto" });
		}, value);
		await page.waitForTimeout(20);
		return snapshot(page);
}

async function waitForHome(page: Page, expectedCards: number): Promise<void> {
	await expect(page.locator(".new-task-home")).toBeVisible();
	await expect(page.locator(".new-task-starter")).toHaveCount(expectedCards);
	await expect(page.locator("#composer-input")).toBeVisible();
	await page.evaluate(() => document.fonts.ready);
	await page.waitForTimeout(50);
}

async function writeGeometryAttachment(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
	await testInfo.attach(name, { body: JSON.stringify(value, null, 2), contentType: "application/json" });
}

function monitorPageErrors(page: Page): string[] {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.stack ?? error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	return errors;
}

async function runGeometryCase(page: Page, testInfo: TestInfo, fixtureUrl: string, mode: "chat" | "code", viewport: { width: number; height: number }) {
	const errors = monitorPageErrors(page);
	await page.setViewportSize(viewport);
	const baseline = process.env.METIS_HOME_SCROLL_BASELINE === "1" ? "&baseline=old" : "";
	await page.goto(`${fixtureUrl}/?mode=${mode}${baseline}`, { waitUntil: "load" });
	await waitForHome(page, mode === "chat" ? 9 : 6);

	const initial = await snapshot(page);
	const maximumScroll = Math.max(0, initial.scrollHeight - initial.clientHeight);
	const follow = await scrollAndSnapshot(page, Math.min(maximumScroll, 16));
	const middle = await scrollAndSnapshot(page, Math.round(maximumScroll * 0.35));
	const stickyScroll = Math.min(maximumScroll, Math.max(follow.scrollTop + 80, Math.round(maximumScroll * 0.6)));
	const sticky = await scrollAndSnapshot(page, stickyScroll);
	const bottom = await scrollAndSnapshot(page, maximumScroll);
	const firstContentTop = mode === "code" ? bottom.recentSection?.top : bottom.cards[0]?.top;

	if (process.env.METIS_HOME_SCROLL_LOG === "1") {
		console.log(`[home geometry] ${mode} ${viewport.width}x${viewport.height}`, JSON.stringify({
			scrollHeight: initial.scrollHeight,
			composerTops: [initial.composer.top, follow.composer.top, middle.composer.top, sticky.composer.top, bottom.composer.top],
			composerBottom: bottom.composer.bottom,
			contentGap: firstContentTop === undefined ? null : firstContentTop - bottom.composer.bottom,
			cardBounds: [bottom.cards[0]?.top, bottom.cards.at(-1)?.bottom],
			discovery: { top: initial.discovery.top, bottom: initial.discovery.bottom, height: initial.discovery.height },
		}));
	}
	await writeGeometryAttachment(testInfo, `${mode}-${viewport.width}x${viewport.height}-geometry`, { initial, follow, middle, sticky, bottom });
	await scrollAndSnapshot(page, 0);
	await page.screenshot({ path: testInfo.outputPath(`${mode}-${viewport.width}x${viewport.height}-initial.png`), fullPage: false });
	await scrollAndSnapshot(page, stickyScroll);
	await page.screenshot({ path: testInfo.outputPath(`${mode}-${viewport.width}x${viewport.height}-sticky.png`), fullPage: false });
	await scrollAndSnapshot(page, maximumScroll);
	if (errors.length > 0) await writeGeometryAttachment(testInfo, `${mode}-${viewport.width}x${viewport.height}-errors`, errors);
	await page.screenshot({ path: testInfo.outputPath(`${mode}-${viewport.width}x${viewport.height}-bottom.png`), fullPage: false });

	expect(initial.cards).toHaveLength(mode === "chat" ? 9 : 6);
	expect(initial.headingText).toContain("QA User");
	expect(initial.headingText).not.toContain("{{name}}");
	expect(initial.scrollHeight).toBeGreaterThan(initial.clientHeight);
	expect(initial.cards[0]?.top ?? Number.NEGATIVE_INFINITY).toBeGreaterThanOrEqual(viewport.height - 1);
	expect(initial.heading.top).toBeGreaterThan(viewport.width >= 1280 ? 100 : 64);
	expect(initial.headingLineHeight).toBeGreaterThan(0);
	expect(initial.heading.height).toBeLessThanOrEqual(initial.headingLineHeight * 1.15);
	expect(initial.discovery.height).toBeGreaterThanOrEqual(47);
	expect(initial.discovery.bottom).toBeGreaterThanOrEqual(viewport.height - 2);
	expect(Math.abs((initial.composer.top - follow.composer.top) - follow.scrollTop)).toBeLessThanOrEqual(1);
	expect(follow.composer.top).toBeLessThan(initial.composer.top - 4);
	expect(middle.composer.top).toBeLessThan(initial.composer.top - 8);
	expect(sticky.composer.top).toBeLessThan(initial.composer.top - 20);
	expect(Math.abs(bottom.composer.top - sticky.composer.top)).toBeLessThan(3);
	expect(bottom.cards[0]?.top ?? Number.POSITIVE_INFINITY).toBeLessThan(sticky.cards[0]?.top ?? Number.NEGATIVE_INFINITY);
	expect(bottom.cards.at(-1)?.bottom ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(viewport.height - 28);
	expect(firstContentTop).toBeDefined();
	expect((firstContentTop ?? Number.POSITIVE_INFINITY) - bottom.composer.bottom).toBeGreaterThanOrEqual(28);
	expect((firstContentTop ?? Number.NEGATIVE_INFINITY) - bottom.composer.bottom).toBeLessThanOrEqual(36);
	if (viewport.width >= 1280) {
		const lastCard = bottom.cards.at(-1);
		if (!lastCard) throw new Error("Expected a final starter card");
		expect(Math.abs(lastCard.bottom - (viewport.height - 32))).toBeLessThanOrEqual(1);
		expect(Math.abs((sticky.composer.top + sticky.composer.bottom) / 2 - viewport.height / 2)).toBeLessThanOrEqual(120);
		for (const card of bottom.cards) {
			expect(card.top).toBeGreaterThanOrEqual(bottom.composer.bottom - 1);
			expect(card.bottom).toBeLessThanOrEqual(viewport.height - 28);
		}
	}
	expect(errors).toEqual([]);
}

test.describe.configure({ mode: "serial", timeout: 60_000 });

test.describe("new task home sticky composer geometry", () => {
	let fixtureRoot: string;
	let fixture: FixtureServer;

	test.beforeAll(async () => {
		fixtureRoot = await mkdtemp(path.join(tmpdir(), "metis-new-task-home-e2e-"));
		const scriptPath = await buildFixture(fixtureRoot);
		fixture = await startFixtureServer(fixtureRoot, scriptPath);
	});

	test.afterAll(async () => {
		if (fixture) await new Promise<void>((resolve) => fixture.server.close(() => resolve()));
		if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true });
	});

	for (const mode of ["chat", "code"] as const) {
		for (const viewport of [{ width: 1280, height: 840 }, { width: 900, height: 640 }] as const) {
			test(`${mode} ${viewport.width}x${viewport.height} keeps the composer pinned after it reaches its dock`, async ({ page }, testInfo) => {
				await runGeometryCase(page, testInfo, fixture.url, mode, viewport);
			});
		}
	}

	test("starter prefill returns to the top and honors reduced motion", async ({ page }, testInfo) => {
		await page.setViewportSize({ width: 900, height: 640 });
		await page.goto(`${fixture.url}/?mode=chat&motion=reduced`, { waitUntil: "load" });
		await waitForHome(page, 9);
		await scrollAndSnapshot(page, 400);
		await page.locator('[data-starter-id="slides"]').click();
		await expect.poll(() => page.locator("#composer-input").textContent()).toMatch(/\S/u);
		await expect.poll(async () => (await snapshot(page)).scrollTop).toBeLessThan(2);
		await writeGeometryAttachment(testInfo, "reduced-motion-prefill", await snapshot(page));
	});

	test("keyboard focus keeps the last narrow card visible below the pinned composer", async ({ page }) => {
		await page.setViewportSize({ width: 900, height: 640 });
		await page.goto(`${fixture.url}/?mode=code&motion=reduced`, { waitUntil: "load" });
		await waitForHome(page, 6);
		await scrollAndSnapshot(page, 0);
		await page.locator(".new-task-starter").last().focus();
		await page.waitForTimeout(20);
		const focused = await snapshot(page);
		const lastCard = focused.cards.at(-1);
		if (!lastCard) throw new Error("Expected a final starter card");
		expect(lastCard.bottom).toBeLessThanOrEqual(640 + 1);
		expect(lastCard.top).toBeGreaterThanOrEqual(focused.composer.bottom - 1);
	});

	test("multiline input remeasures the sticky home and keeps narrow cards reachable", async ({ page }, testInfo) => {
		const errors = monitorPageErrors(page);
		await page.setViewportSize({ width: 900, height: 640 });
		await page.goto(`${fixture.url}/?mode=chat&motion=reduced`, { waitUntil: "load" });
		await waitForHome(page, 9);
		const initial = await snapshot(page);
		await page.locator("#composer-input").fill(Array.from({ length: 12 }, (_, index) => `line ${index + 1}: outline the next useful step`).join("\n"));
		await page.waitForTimeout(80);
		const expanded = await snapshot(page);
		expect(expanded.composer.height).toBeGreaterThan(initial.composer.height + 10);
		await page.locator(".new-task-home-discovery").click();
		await page.waitForTimeout(30);
		const explored = await scrollAndSnapshot(page, Math.max(0, expanded.scrollHeight - expanded.clientHeight));
		const lastCard = explored.cards.at(-1);
		if (!lastCard) throw new Error("Expected a final starter card");
		expect(explored.composer.bottom).toBeLessThanOrEqual(640);
		expect(lastCard.bottom).toBeLessThanOrEqual(640 + 1);
		const top = await scrollAndSnapshot(page, 0);
		expect(top.scrollTop).toBeLessThan(2);
		await writeGeometryAttachment(testInfo, "multiline-input-geometry", { initial, expanded, explored, top });
		expect(errors).toEqual([]);
	});
});
