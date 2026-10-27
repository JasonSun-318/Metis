import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { build } from "esbuild";

test.use({ channel: "chrome" });
let server: Server;
let directory: string;
let url: string;

test.beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "metis-conversation-scrollbar-"));
	await build({
		entryPoints: [path.join(__dirname, "conversation-scrollbar.fixture.tsx")],
		bundle: true,
		format: "esm",
		jsx: "automatic",
		platform: "browser",
		target: "es2022",
		outfile: path.join(directory, "fixture.js"),
	});
	await build({
		stdin: {
			contents: ["tokens.css", "app.css", "transcript-navigation.css", "markdown.css", "markdown-embeds.css"]
				.map(
					(file) => `@import "${path.resolve(__dirname, "../src/renderer/styles", file).replaceAll("\\", "/")}";`,
				)
				.join("\n"),
			loader: "css",
			resolveDir: directory,
		},
		bundle: true,
		loader: { ".woff": "file", ".woff2": "file", ".ttf": "file", ".svg": "file" },
		outfile: path.join(directory, "fixture.css"),
	});
	await writeFile(
		path.join(directory, "index.html"),
		`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>body{font-family:Inter,-apple-system,sans-serif}#root{height:100%}.fixture-grid{display:grid;grid-template-columns:minmax(0,1fr);height:100%}.fixture-grid.is-split{grid-template-columns:repeat(2,minmax(0,1fr));gap:1px}.fixture-conversation{height:100%;min-width:0;min-height:0;background:var(--conversation-bg)}.fixture-controls{display:flex;flex:none;align-items:center;gap:6px;flex-wrap:wrap;min-height:44px;padding:6px 12px;border-bottom:1px solid var(--border);font-size:11px}.fixture-controls strong{margin-right:auto}.fixture-controls button{padding:3px 5px;border:1px solid var(--border);border-radius:4px}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`,
	);
	server = createServer((request, response) => {
		const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
		const file = pathname === "/" ? "index.html" : path.basename(pathname);
		if (!/^(index\.html|fixture\.(?:js|css)|[^/]+\.(?:woff2?|ttf|svg))$/.test(file)) {
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

const panel = (page: Page, name = "primary") => page.locator(`[data-pane="${name}"]`);
const scroller = (root: Locator) => root.locator(".transcript-scroll");
const rail = (root: Locator) => root.locator('.conversation-navigation [role="slider"]');
const preview = (root: Locator) => root.locator(".conversation-navigation-preview");

async function open(page: Page, query = "", width = 860, height = 760) {
	await page.setViewportSize({ width, height });
	await page.goto(`${url}/?${query}`);
	await expect(panel(page).locator(".transcript")).toBeVisible();
	await expect
		.poll(() => scroller(panel(page)).evaluate((element) => element.scrollHeight - element.clientHeight))
		.toBeGreaterThan(1000);
	await settle(page);
}

async function settle(page: Page) {
	await page.evaluate(
		() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
	);
}

async function scrollState(root: Locator) {
	return scroller(root).evaluate((element) => ({
		top: element.scrollTop,
		maximum: element.scrollHeight - element.clientHeight,
		height: element.clientHeight,
	}));
}

async function setRatio(root: Locator, ratio: number) {
	await scroller(root).evaluate((element, ratio) => {
		element.scrollTop = (element.scrollHeight - element.clientHeight) * ratio;
		element.dispatchEvent(new Event("scroll"));
	}, ratio);
}

async function nativeScrollbarHidden(root: Locator) {
	return scroller(root).evaluate((element) => {
		const standard = getComputedStyle(element).scrollbarWidth;
		const webkit = getComputedStyle(element, "::-webkit-scrollbar");
		return standard === "none" || webkit.display === "none" || webkit.width === "0px";
	});
}

async function anchor(root: Locator) {
	return scroller(root).evaluate((element) => {
		const viewport = element.getBoundingClientRect();
		const rows = Array.from(element.querySelectorAll<HTMLElement>("[data-user-message]"));
		const row = rows.find((candidate) => {
			const bounds = candidate.getBoundingClientRect();
			return bounds.top >= viewport.top && bounds.top < viewport.bottom;
		});
		if (!row) throw new Error("No visible message anchor");
		return { id: row.dataset.userMessage!, top: row.getBoundingClientRect().top - viewport.top };
	});
}

async function anchorPosition(root: Locator, id: string) {
	return scroller(root).evaluate((element, id) => {
		const row = Array.from(element.querySelectorAll<HTMLElement>("[data-user-message]")).find(
			(candidate) => candidate.dataset.userMessage === id,
		);
		return row ? row.getBoundingClientRect().top - element.getBoundingClientRect().top : null;
	}, id);
}

for (const mode of ["chat", "code"])
	for (const theme of ["dark", "light"]) {
		test(`${mode} ${theme}: right-side idle marks remain equal and hover only previews`, async ({ page }, info) => {
			await open(page, `mode=${mode}&theme=${theme}&count=120&older`);
			const root = panel(page);
			const track = rail(root);
			await expect(track).toBeVisible();
			const [trackBox, transcriptBox] = await Promise.all([
				track.boundingBox(),
				root.locator(".transcript").boundingBox(),
			]);
			if (!trackBox || !transcriptBox) throw new Error("Missing conversation rail geometry");
			expect(trackBox.x).toBeGreaterThan(transcriptBox.x + transcriptBox.width / 2);
			expect(trackBox.x + trackBox.width).toBeLessThanOrEqual(transcriptBox.x + transcriptBox.width + 1);
			expect(await nativeScrollbarHidden(root)).toBe(true);
			const pre = root.locator("pre").first();
			await expect(pre).toHaveCSS("overflow-x", "auto");
			expect(
				await pre.evaluate((element) => {
					const bar = getComputedStyle(element, "::-webkit-scrollbar");
					return (
						element.scrollWidth > element.clientWidth &&
						getComputedStyle(element).scrollbarWidth !== "none" &&
						bar.display !== "none" &&
						bar.height !== "0px"
					);
				}),
			).toBe(true);
			await expect(root.locator(".conversation-navigation-older")).toHaveCount(0);
			await expect(root.getByRole("button", { name: "Earlier messages", exact: true })).toHaveCount(0);
			await setRatio(root, 0.45);
			await page.mouse.move(10, 10);
			await settle(page);
			const idle = await track.locator("[data-navigation-turn]").evaluateAll((marks) =>
				marks.map((mark) => {
					const style = getComputedStyle(mark);
					const channel = style.backgroundColor.match(/[\d.]+/g)?.map(Number) ?? [];
					const luminance =
						channel.length >= 3
							? (0.2126 * channel[0]! + 0.7152 * channel[1]! + 0.0722 * channel[2]!) * (channel[3] ?? 1)
							: 1;
					return { width: mark.getBoundingClientRect().width, intensity: Number(style.opacity) * luminance };
				}),
			);
			expect(idle.length).toBeGreaterThan(8);
			expect(
				Math.max(...idle.map((mark) => mark.width)) - Math.min(...idle.map((mark) => mark.width)),
			).toBeLessThanOrEqual(0.5);
			const opacityVariants = new Set(idle.map((mark) => Math.round(mark.intensity * 100))).size;
			const hasGradientMask = await root
				.locator(".conversation-navigation")
				.evaluate((element) =>
					[element, ...Array.from(element.querySelectorAll("*"))].some((node) =>
						getComputedStyle(node).maskImage.includes("gradient"),
					),
				);
			expect(
				opacityVariants > 3 || hasGradientMask,
				"Idle luminance changes gradually, via mark opacity or a gradient mask",
			).toBe(true);
			const before = (await scrollState(root)).top;
			await page.mouse.move(trackBox.x + trackBox.width / 2, trackBox.y + trackBox.height * 0.6);
			await expect(preview(root)).toBeVisible();
			await expect(preview(root)).toContainText("Question");
			const card = await preview(root).boundingBox();
			if (!card) throw new Error("Missing hover preview");
			expect(card.x + card.width).toBeLessThanOrEqual(trackBox.x + 1);
			expect(card.x).toBeGreaterThanOrEqual(transcriptBox.x + 4);
			expect(card.y).toBeGreaterThanOrEqual(transcriptBox.y + 4);
			expect(card.y + card.height).toBeLessThanOrEqual(transcriptBox.y + transcriptBox.height - 4);
			expect(Math.abs((await scrollState(root)).top - before)).toBeLessThanOrEqual(1);
			await page.screenshot({ path: info.outputPath(`${mode}-${theme}-hover.png`), animations: "disabled" });
		});
	}

test("fifteen real message ticks keep eight-pixel spacing and a centered natural height", async ({ page }, info) => {
	for (const height of [760, 1240]) {
		await open(page, "count=15", 860, height);
		const root = panel(page);
		const track = rail(root);
		const window = root.locator(".conversation-navigation-window");
		await expect(track).toHaveAttribute("aria-valuemax", "15");
		await page.mouse.move(0, 0);
		await expect(preview(root)).toHaveCount(0);
		const marks = track.locator("[data-navigation-turn]");
		await expect(marks).toHaveCount(15);
		const trackBox = await track.boundingBox();
		const frame = await root.locator(".conversation-navigation").boundingBox();
		if (!trackBox || !frame) throw new Error("Missing index geometry");
		expect(trackBox.height).toBeCloseTo(120, 0);
		expect(Math.abs(trackBox.y + trackBox.height / 2 - frame.y - frame.height / 2)).toBeLessThanOrEqual(1);
		const ticks = await marks.evaluateAll((elements) =>
			elements.map((element) => {
				const bounds = element.getBoundingClientRect();
				return {
					id: element.getAttribute("data-navigation-turn"),
					index: Number(element.getAttribute("data-navigation-index")),
					y: bounds.y + bounds.height / 2,
					width: bounds.width,
				};
			}),
		);
		expect(ticks.map((tick) => tick.id)).toEqual(
			Array.from({ length: 15 }, (_, index) => `primary-session-0-user-${index}`),
		);
		expect(ticks.map((tick) => tick.index)).toEqual(Array.from({ length: 15 }, (_, index) => index));
		for (let index = 1; index < ticks.length; index += 1)
			expect(ticks[index]!.y - ticks[index - 1]!.y).toBeCloseTo(8, 1);
		expect(
			Math.max(...ticks.map((tick) => tick.width)) - Math.min(...ticks.map((tick) => tick.width)),
		).toBeLessThanOrEqual(0.5);
		await expect(window).toHaveAttribute("data-fade-top", "false");
		await expect(window).toHaveAttribute("data-fade-bottom", "false");
		await page.screenshot({ path: info.outputPath(`fifteen-message-idle-${height}px.png`), animations: "disabled" });

		const slot = 7;
		const target = await marks.nth(slot).boundingBox();
		if (!target) throw new Error("Missing real message tick");
		await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2);
		await expect(preview(root)).toContainText("Question 8:");
		await expect(preview(root)).toContainText("Answer 8:");
		await expect(track).toHaveAttribute("aria-valuenow", "8");
		for (const [distance, width] of [26, 20, 14, 8, 6].entries()) {
			await expect(marks.nth(slot - distance)).toHaveCSS("width", `${width}px`);
			await expect(marks.nth(slot + distance)).toHaveCSS("width", `${width}px`);
		}
		const peak = await marks.nth(slot).boundingBox();
		if (!peak) throw new Error("Missing expanded tick");
		expect(peak.x).toBeGreaterThanOrEqual(trackBox.x);
		expect(peak.x + peak.width).toBeLessThanOrEqual(trackBox.x + trackBox.width);
		await page.screenshot({ path: info.outputPath(`fifteen-message-hover-${height}px.png`), animations: "disabled" });
		await setRatio(root, 0.35);
		await settle(page);
		const before = (await scrollState(root)).top;
		await track.hover();
		for (const delta of [240, -240]) {
			await page.mouse.wheel(0, delta);
			await settle(page);
			expect(await track.evaluate((element) => element.scrollTop)).toBe(0);
			expect(Math.abs((await scrollState(root)).top - before)).toBeLessThanOrEqual(2);
		}
	}
});

test("primary drag keeps capture beyond the rail and release never becomes a message jump", async ({ page }, info) => {
	await open(page, "count=140");
	const root = panel(page);
	await setRatio(root, 0.25);
	await settle(page);
	const box = await rail(root).boundingBox();
	if (!box) throw new Error("Missing rail");
	const x = box.x + box.width / 2;
	const y = box.y + box.height * 0.35;
	const before = (await scrollState(root)).top;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x, y + box.height * 0.12, { steps: 6 });
	await expect(preview(root)).toBeHidden();
	const inside = (await scrollState(root)).top;
	expect(inside).toBeGreaterThan(before + 100);
	await page.mouse.move(x - 100, y + box.height * 0.25, { steps: 6 });
	const outside = (await scrollState(root)).top;
	expect(outside).toBeGreaterThan(inside + 100);
	await page.mouse.up();
	await settle(page);
	expect(Math.abs((await scrollState(root)).top - outside)).toBeLessThanOrEqual(2);
	await page.screenshot({ path: info.outputPath("continuous-drag-release.png"), animations: "disabled" });
	const secondStart = (await scrollState(root)).top;
	await page.mouse.move(x, y);
	await page.mouse.down({ button: "right" });
	await page.mouse.move(x, y - 80);
	await page.mouse.up({ button: "right" });
	expect(Math.abs((await scrollState(root)).top - secondStart)).toBeLessThanOrEqual(2);
});

test("index wheel stays independent while keyboard previews and document jumps remain distinct", async ({ page }) => {
	await open(page, "mode=code&count=90");
	const root = panel(page);
	const track = rail(root);
	await setRatio(root, 0.3);
	await settle(page);
	const before = (await scrollState(root)).top;
	await track.focus();
	await track.press("Home");
	await track.press("Escape");
	await track.hover();
	await page.mouse.wheel(0, 180);
	await expect.poll(() => track.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
	expect(Math.abs((await scrollState(root)).top - before)).toBeLessThanOrEqual(2);
	const afterWheel = (await scrollState(root)).top;
	await track.focus();
	await track.press("Home");
	await expect(track).toHaveAttribute("aria-valuenow", "1");
	await expect(track.locator('[data-navigation-index="0"]')).toBeInViewport();
	await track.press("ArrowDown");
	await expect(track).toHaveAttribute("aria-valuenow", "2");
	await expect(preview(root)).toContainText("Question 2:");
	expect(Math.abs((await scrollState(root)).top - afterWheel)).toBeLessThanOrEqual(2);
	await track.press("Enter");
	await expect(root.locator('[data-user-message$="-user-1"]')).toBeInViewport();
	await track.press("End");
	await expect(track).toHaveAttribute("aria-valuenow", "90");
	await expect(track.locator('[data-navigation-index="89"]')).toBeInViewport();
	await track.press("Space");
	await expect(root.locator('[data-user-message$="-user-89"]')).toBeInViewport();
	await track.press("Home");
	await track.press("Enter");
	await settle(page);
	const beforePage = (await scrollState(root)).top;
	await track.press("PageDown");
	await expect.poll(async () => (await scrollState(root)).top).toBeGreaterThan(beforePage + 100);
	await track.press("Escape");
	await expect(preview(root)).toBeHidden();
});

test("scrolling the real index reveals hidden messages and edge fades without scrolling the conversation", async ({
	page,
}, info) => {
	await open(page, "count=140");
	const root = panel(page);
	const track = rail(root);
	const window = root.locator(".conversation-navigation-window");
	await setRatio(root, 0.4);
	await settle(page);
	await track.focus();
	await track.press("Home");
	await track.press("Escape");
	await expect(window).toHaveAttribute("data-fade-top", "false");
	await expect(window).toHaveAttribute("data-fade-bottom", "true");
	const topMask = await window.evaluate((element) => getComputedStyle(element).maskImage);
	const before = (await scrollState(root)).top;
	await track.hover();
	await page.mouse.wheel(0, 200);
	await expect.poll(() => track.evaluate((element) => element.scrollTop)).toBeGreaterThan(100);
	await expect(window).toHaveAttribute("data-fade-top", "true");
	await expect(window).toHaveAttribute("data-fade-bottom", "true");
	expect(await window.evaluate((element) => getComputedStyle(element).maskImage)).not.toBe(topMask);
	expect(Math.abs((await scrollState(root)).top - before)).toBeLessThanOrEqual(2);
	const target = await track.evaluate((element) => {
		const viewport = element.getBoundingClientRect();
		const visible = Array.from(element.querySelectorAll<HTMLElement>("[data-navigation-turn]")).filter((mark) => {
			const bounds = mark.getBoundingClientRect();
			return bounds.top > viewport.top + 100 && bounds.bottom < viewport.bottom - 100;
		});
		const mark = visible[Math.floor(visible.length / 2)];
		if (!mark) throw new Error("Missing visible index row");
		const bounds = mark.getBoundingClientRect();
		return {
			id: mark.dataset.navigationTurn!,
			index: Number(mark.dataset.navigationIndex),
			x: bounds.x + bounds.width / 2,
			y: bounds.y + bounds.height / 2,
		};
	});
	await page.mouse.move(target.x, target.y);
	await expect(preview(root)).toContainText(`Question ${target.index + 1}:`);
	await expect(preview(root)).toContainText(`Answer ${target.index + 1}:`);
	const card = await preview(root).boundingBox();
	if (!card) throw new Error("Missing row-aligned preview");
	expect(Math.abs(card.y + card.height / 2 - target.y)).toBeLessThanOrEqual(2);
	await page.screenshot({ path: info.outputPath("real-index-middle-hover.png"), animations: "disabled" });
	await page.mouse.click(target.x, target.y);
	await expect(root.locator(`[data-user-message="${target.id}"]`)).toBeInViewport();
	await track.focus();
	await track.press("End");
	await expect(track.locator('[data-navigation-index="139"]')).toBeInViewport();
	await expect(window).toHaveAttribute("data-fade-top", "true");
	await expect(window).toHaveAttribute("data-fade-bottom", "false");
	await track.press("Escape");
	const afterJump = (await scrollState(root)).top;
	await track.hover();
	await page.mouse.wheel(0, 300);
	await settle(page);
	expect(Math.abs((await scrollState(root)).top - afterJump)).toBeLessThanOrEqual(2);
	await expect(preview(root)).toBeVisible();
	const previewGeometry = await preview(root).evaluate((element) => ({
		scrollLeft: element.scrollLeft,
		scrollWidth: element.scrollWidth,
		clientWidth: element.clientWidth,
		question: element.querySelector("strong")?.textContent,
		answer: element.querySelector(".conversation-navigation-excerpt")?.textContent,
	}));
	await writeFile(info.outputPath("preview-scroll-geometry.json"), JSON.stringify(previewGeometry, null, 2));
	await info.attach("preview-scroll-geometry", {
		body: JSON.stringify(previewGeometry),
		contentType: "application/json",
	});
	expect(previewGeometry.scrollLeft).toBe(0);
	expect(previewGeometry.scrollWidth).toBeLessThanOrEqual(previewGeometry.clientWidth + 1);
	await page.screenshot({ path: info.outputPath("real-index-bottom-fade.png"), animations: "disabled" });
});

test("prepending history preserves the visible tick identity and its index-window position", async ({ page }) => {
	await open(page, "count=100&older&manual-older");
	const root = panel(page);
	const track = rail(root);
	await setRatio(root, 0.4);
	await settle(page);
	await track.focus();
	await track.press("Home");
	await track.press("Escape");
	await track.hover();
	await page.mouse.wheel(0, 80);
	await expect.poll(() => track.evaluate((element) => element.scrollTop)).toBeGreaterThan(40);
	const before = await track.evaluate((element) => {
		const viewport = element.getBoundingClientRect();
		const mark = Array.from(element.querySelectorAll<HTMLElement>("[data-navigation-turn]")).find(
			(candidate) => candidate.getBoundingClientRect().top >= viewport.top + 8,
		);
		if (!mark) throw new Error("Missing index anchor");
		return {
			id: mark.dataset.navigationTurn!,
			index: Number(mark.dataset.navigationIndex),
			top: mark.getBoundingClientRect().top - viewport.top,
		};
	});
	const tick = track.locator(`[data-navigation-turn="${before.id}"]`);
	const handle = await tick.elementHandle();
	if (!handle) throw new Error("Missing stable tick element");
	await root
		.getByRole("button", { name: "Load older messages", exact: true })
		.evaluate((button) => (button as HTMLButtonElement).click());
	await expect(root).toHaveAttribute("data-count", "120");
	await expect(track).toHaveAttribute("aria-valuemax", "120");
	await expect(tick).toHaveAttribute("data-navigation-index", String(before.index + 20));
	await expect
		.poll(() =>
			tick.evaluate(
				(element) =>
					element.getBoundingClientRect().top -
					element.closest(".conversation-navigation-track")!.getBoundingClientRect().top,
			),
		)
		.toBeCloseTo(before.top, 0);
	expect(
		await handle.evaluate(
			(element, id) =>
				element.isConnected &&
				Array.from(
					element
						.closest(".conversation-navigation-track")!
						.querySelectorAll<HTMLElement>("[data-navigation-turn]"),
				).find((candidate) => candidate.dataset.navigationTurn === id) === element,
			before.id,
		),
	).toBe(true);
	await handle.dispose();
});

test("older-history prepends and streaming preserve the current reading anchor", async ({ page }) => {
	await open(page, "count=75&older&manual-older");
	const root = panel(page);
	await setRatio(root, 0.3);
	await settle(page);
	const current = await anchor(root);
	await root.getByRole("button", { name: "Stream chunk", exact: true }).click();
	await settle(page);
	expect(Math.abs((await anchorPosition(root, current.id))! - current.top)).toBeLessThanOrEqual(2);
	await root.getByRole("button", { name: "Append turn", exact: true }).click();
	await settle(page);
	expect(Math.abs((await anchorPosition(root, current.id))! - current.top)).toBeLessThanOrEqual(2);
	await root.getByRole("button", { name: "Load older messages", exact: true }).click();
	await expect(root).toHaveAttribute("data-count", "96");
	await expect.poll(() => anchorPosition(root, current.id)).not.toBeNull();
	await expect
		.poll(async () => Math.abs((await anchorPosition(root, current.id))! - current.top))
		.toBeLessThanOrEqual(2);
	await expect(rail(root)).toHaveAttribute("aria-valuemax", "96");
});

test("dragging to earlier history waits for release and live content cannot pull the drag to the bottom", async ({
	page,
}) => {
	await open(page, "mode=code&count=70&older");
	const root = panel(page);
	await setRatio(root, 0.55);
	await settle(page);
	const box = await rail(root).boundingBox();
	if (!box) throw new Error("Missing rail");
	const x = box.x + box.width / 2;
	const y = box.y + box.height * 0.7;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x, y - box.height * 0.1, { steps: 5 });
	const readingTop = (await scrollState(root)).top;
	await root
		.getByRole("button", { name: "Stream chunk", exact: true })
		.evaluate((button) => (button as HTMLButtonElement).click());
	await settle(page);
	expect(Math.abs((await scrollState(root)).top - readingTop)).toBeLessThanOrEqual(2);
	await page.mouse.move(x - 80, box.y - 40, { steps: 8 });
	await expect.poll(async () => (await scrollState(root)).top).toBeLessThanOrEqual(1);
	await settle(page);
	await expect(root).toHaveAttribute("data-count", "70");
	await expect(root).toHaveAttribute("data-loads", "0");
	await page.mouse.up();
	await expect(root).toHaveAttribute("data-count", "90");
	await expect(root).toHaveAttribute("data-loads", "1");
});

test("a single long turn still scrolls and narrow reduced-motion previews stay inside the transcript", async ({
	page,
}, info) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await open(page, "single&count=1&theme=light&reduced", 380, 240);
	const root = panel(page);
	const track = rail(root);
	await expect(track).toBeVisible();
	await expect(track).toHaveAttribute("aria-valuemax", "1");
	await expect(track.locator("[data-navigation-turn]")).toHaveCount(1);
	await expect(root.locator(".conversation-navigation-window")).toHaveAttribute("data-fade-top", "false");
	await expect(root.locator(".conversation-navigation-window")).toHaveAttribute("data-fade-bottom", "false");
	const box = await track.boundingBox();
	const bounds = await root.locator(".transcript").boundingBox();
	if (!box || !bounds) throw new Error("Missing narrow rail bounds");
	expect(box.height).toBeCloseTo(24, 0);
	await page.mouse.move(box.x + box.width / 2, box.y + 3);
	await expect(preview(root)).toBeVisible();
	const card = await preview(root).boundingBox();
	if (!card) throw new Error("Missing narrow preview");

	expect(card.x).toBeGreaterThanOrEqual(bounds.x + 4);
	expect(card.x + card.width).toBeLessThanOrEqual(box.x + 1);
	expect(card.y).toBeGreaterThanOrEqual(bounds.y + 4);
	expect(card.y + card.height).toBeLessThanOrEqual(bounds.y + bounds.height - 4);
	await setRatio(root, 0.2);
	await settle(page);
	const before = (await scrollState(root)).top;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.3);
	await page.mouse.down();
	await page.mouse.move(box.x - 30, box.y + box.height * 0.6, { steps: 8 });
	await page.mouse.up();
	expect((await scrollState(root)).top).toBeGreaterThan(before + 100);
	await page.screenshot({ path: info.outputPath("single-long-turn-narrow-reduced.png"), animations: "disabled" });
});

test("a pointer can cross the gap into the preview and click its message", async ({ page }) => {
	await open(page, "count=80", 760, 640);
	const root = panel(page);
	const track = rail(root);
	const box = await track.boundingBox();
	if (!box) throw new Error("Missing rail");
	await page.mouse.move(box.x + box.width / 2, box.y + box.height * 0.35);
	await expect(preview(root)).toBeVisible();
	await settle(page);
	const card = await preview(root).boundingBox();
	if (!card) throw new Error("Missing preview");
	const before = (await scrollState(root)).top;
	await page.mouse.move(card.x + card.width - 2, card.y + card.height / 2, { steps: 16 });
	await expect(preview(root)).toBeVisible();
	await preview(root).click();
	await expect(preview(root)).toHaveCount(0);
	await expect.poll(async () => Math.abs((await scrollState(root)).top - before)).toBeGreaterThan(500);
});

test("keyboard focus in a preview survives pointer leave and Escape restores the rail", async ({ page }) => {
	await open(page, "count=80", 760, 640);
	const root = panel(page);
	const track = rail(root);
	await track.focus();
	await track.press("Home");
	await page.keyboard.press("Tab");
	await expect(preview(root)).toBeFocused();
	const box = await track.boundingBox();
	if (!box) throw new Error("Missing rail");
	await page.mouse.move(box.x + box.width / 2, box.y + 4);
	await page.mouse.move(5, 5);
	// Exercise the actual pointer-leave grace timer while the preview owns focus.
	await page.waitForTimeout(160);
	await expect(preview(root)).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(preview(root)).toHaveCount(0);
	await expect(track).toBeFocused();
});

test("keyboard browsing on the slider survives pointer leave and live appends until focus leaves navigation", async ({
	page,
}) => {
	await open(page, "count=140", 760, 640);
	const root = panel(page);
	const track = rail(root);
	await setRatio(root, 0.9);
	await settle(page);
	const documentActive = await track.getAttribute("aria-valuenow");
	expect(Number(documentActive)).toBeGreaterThan(100);
	const documentTop = (await scrollState(root)).top;
	await track.hover();
	await track.focus();
	await track.press("Home");
	await track.press("ArrowDown");
	await expect(track).toHaveAttribute("aria-valuenow", "2");
	await expect(preview(root)).toContainText("Question 2:");
	const indexOffset = await track.evaluate((element) => element.scrollTop);
	await page.mouse.move(5, 5);
	// Exercise the pointer-leave grace timer while the slider retains keyboard focus.
	await page.waitForTimeout(160);
	await expect(track).toBeFocused();
	await expect(track).toHaveAttribute("aria-valuenow", "2");
	await expect(preview(root)).toContainText("Question 2:");
	expect(await track.evaluate((element) => element.scrollTop)).toBe(indexOffset);
	await root
		.getByRole("button", { name: "Append turn", exact: true })
		.evaluate((button) => (button as HTMLButtonElement).click());
	await expect(root).toHaveAttribute("data-count", "141");
	await settle(page);
	await expect(track).toBeFocused();
	await expect(track).toHaveAttribute("aria-valuenow", "2");
	await expect(preview(root)).toContainText("Question 2:");
	expect(await track.evaluate((element) => element.scrollTop)).toBe(indexOffset);
	expect(Math.abs((await scrollState(root)).top - documentTop)).toBeLessThanOrEqual(2);
	await root.getByRole("button", { name: "Switch session", exact: true }).focus();
	await expect(preview(root)).toHaveCount(0);
	await expect(track).toHaveAttribute("aria-valuenow", documentActive!);
	await expect(track.locator(`[data-navigation-index="${Number(documentActive) - 1}"]`)).toBeInViewport();
	expect(await track.evaluate((element) => element.scrollTop)).toBeGreaterThan(indexOffset + 100);
});

test("dense histories virtualize real ticks without losing any keyboard-addressable message", async ({ page }) => {
	test.setTimeout(120_000);
	await open(page, "count=1000", 660, 700);
	const root = panel(page);
	const track = rail(root);
	await expect(track).toHaveAttribute("aria-valuemax", "1000");
	expect(await track.locator("[data-navigation-turn]").count()).toBeLessThanOrEqual(90);
	await track.focus();
	await track.press("Home");
	await expect(track).toHaveAttribute("aria-valuenow", "1");
	for (let index = 2; index <= 1000; index += 1) {
		await track.press("ArrowDown");
		expect(await track.getAttribute("aria-valuenow"), `keyboard message ${index}`).toBe(String(index));
	}
	await expect(preview(root)).toContainText("Question 1000:");
	await expect(track.locator('[data-navigation-index="999"]')).toBeInViewport();
	await expect(track.locator('[data-navigation-index="999"]')).toHaveAttribute(
		"data-navigation-turn",
		"primary-session-0-user-999",
	);
	expect(await track.locator("[data-navigation-turn]").count()).toBeLessThanOrEqual(90);
	await track.press("Enter");
	await expect(root.locator('[data-user-message$="-user-999"]')).toBeInViewport();
});

test("split transcripts keep independent scroll state and session changes cancel an old drag", async ({ page }) => {
	await open(page, "split&mode=code&count=65", 1080, 760);
	const left = panel(page);
	const right = panel(page, "secondary");
	await setRatio(left, 0.2);
	await setRatio(right, 0.6);
	await settle(page);
	const rightBefore = (await scrollState(right)).top;
	const box = await rail(left).boundingBox();
	if (!box) throw new Error("Missing split rail");
	const x = box.x + box.width / 2;
	const y = box.y + box.height * 0.4;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x, y + 70, { steps: 6 });
	expect(Math.abs((await scrollState(right)).top - rightBefore)).toBeLessThanOrEqual(2);
	await left
		.getByRole("button", { name: "Switch session", exact: true })
		.evaluate((button) => (button as HTMLButtonElement).click());
	await expect(left).toHaveAttribute("data-epoch", "1");
	await expect(rail(left)).toHaveAttribute("aria-valuemax", "6");
	await settle(page);
	const fresh = (await scrollState(left)).top;
	await page.mouse.move(x - 50, y - 80);
	await page.mouse.up();
	await settle(page);
	expect(Math.abs((await scrollState(left)).top - fresh)).toBeLessThanOrEqual(2);
	expect(Math.abs((await scrollState(right)).top - rightBefore)).toBeLessThanOrEqual(2);
});

test("Editor keeps its native vertical scrollbar and code blocks keep horizontal scrolling", async ({ page }) => {
	await open(page, "editor&mode=code&count=60", 520, 700);
	const root = panel(page);
	await expect(root.locator(".conversation-navigation")).toHaveCount(0);
	expect(await nativeScrollbarHidden(root)).toBe(false);
	await setRatio(root, 0);
	await settle(page);
	const pre = root.locator("pre").first();
	await expect(pre).toBeAttached();
	await expect(pre).toHaveCSS("white-space", "pre");
	await expect(pre).toHaveCSS("overflow-x", "auto");
	expect(await pre.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
	const current = (await scrollState(root)).top;
	await scroller(root).hover();
	await page.mouse.wheel(0, 240);
	await expect.poll(async () => (await scrollState(root)).top).toBeGreaterThan(current + 100);
});
