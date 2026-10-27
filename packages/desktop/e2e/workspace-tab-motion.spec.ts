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

declare global {
	interface Window {
		__tabFixture?: {
			reset(): void;
			setLeft(ids: readonly string[]): void;
			setRight(ids: readonly string[]): void;
			add(side: "left" | "right", id: string, index?: number): void;
			remove(side: "left" | "right", id: string): void;
			setMany(side: "left" | "right", count: number): void;
			setSuspended(suspended: boolean): void;
			setMotion(motion: "full" | "reduced" | "system"): void;
			setWidth(side: "left" | "right", width: number): void;
		};
	}
}

const key = (id: string) => `[data-tab-motion-key="${id}"]`;

interface TabSample {
	readonly left: number;
	readonly duration: number;
	readonly keyframes: Keyframe[];
}

async function open(page: Page, query = "") {
	await page.setViewportSize({ width: 1180, height: 620 });
	await page.goto(`${url}/?${query}`);
	await expect(page.locator('[data-strip="left"]')).toBeVisible();
}

async function settle(page: Page, side: "left" | "right" = "left") {
	await page.waitForFunction(
		(which) =>
			document.querySelector(`[data-strip-scroll="${which}"]`)?.getAttribute("data-tab-motion-animating") !== "true",
		side,
	);
}

async function rectLeft(page: Page, id: string) {
	return page.locator(key(id)).evaluate((element) => element.getBoundingClientRect().left);
}

async function scrollLeft(page: Page, side: "left" | "right" = "left") {
	return page.locator(`[data-strip-scroll="${side}"]`).evaluate((element) => element.scrollLeft);
}

/**
 * Pause the strip's own 180ms animation at an exact time and read the rendered
 * geometry. CSS colour transitions are deliberately ignored.
 */
async function seekTab(page: Page, id: string, time: number): Promise<TabSample | null> {
	return page.evaluate(
		({ id: tabId, time: at }) => {
			const element = document.querySelector<HTMLElement>(`[data-tab-motion-key="${tabId}"]`);
			if (!element) return null;
			const animation = element.getAnimations().find((candidate) => {
				const timing = candidate.effect?.getTiming();
				return (
					Number(timing?.duration ?? 0) >= 160 &&
					Number(timing?.duration ?? 0) <= 200 &&
					(candidate.effect as KeyframeEffect | null)?.target === element
				);
			});
			if (!animation) return null;
			animation.pause();
			animation.currentTime = at;
			void element.offsetWidth;
			return {
				left: element.getBoundingClientRect().left,
				duration: Number(animation.effect?.getTiming().duration ?? 0),
				keyframes: (animation.effect as KeyframeEffect | null)?.getKeyframes() ?? [],
			};
		},
		{ id, time },
	);
}

async function finishTabMotion(page: Page) {
	await page.evaluate(() => {
		for (const animation of document.getAnimations()) {
			const duration = Number(animation.effect?.getTiming().duration ?? 0);
			if (duration < 160 || duration > 200 || animation.playState === "idle") continue;
			try {
				animation.finish();
			} catch {
				// A rapid edit may already have cancelled this animation.
			}
		}
	});
}

async function tabAnimations(page: Page) {
	return page.evaluate(() =>
		document
			.getAnimations()
			.filter((animation) => {
				const target = (animation.effect as KeyframeEffect | null)?.target;
				const duration = Number(animation.effect?.getTiming().duration ?? 0);
				return (
					target instanceof Element &&
					duration >= 160 &&
					duration <= 200 &&
					(target.hasAttribute("data-tab-motion-key") || target.classList.contains("tool-tab-motion-ghost"))
				);
			})
			.map((animation) => ({
				duration: Number(animation.effect?.getTiming().duration ?? 0),
				keyframes: (animation.effect as KeyframeEffect | null)?.getKeyframes() ?? [],
			})),
	);
}

function expectBetween(value: number, low: number, high: number) {
	expect(value, `${value} between ${low} and ${high}`).toBeGreaterThan(low);
	expect(value, `${value} between ${low} and ${high}`).toBeLessThan(high);
}

function assertNoScaleOrWidth(keyframes: readonly Keyframe[]) {
	const serialized = JSON.stringify(keyframes);
	expect(serialized).not.toContain("scale");
	expect(serialized).not.toContain("width");
}

test.beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "metis-tab-motion-"));
	await build({
		entryPoints: [path.join(__dirname, "workspace-tab-motion.fixture.tsx")],
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
		]).get(new URL(request.url ?? "/", "http://localhost").pathname);
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
	if (!address || typeof address === "string") throw new Error("Tab motion fixture server did not start");
	url = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	if (directory) await rm(directory, { recursive: true, force: true });
});

test("removing a middle tab keeps the model immediate and lands start/middle/end", async ({ page }) => {
	await open(page);
	// Tool strips show the underline; reproduce the unfocused cascade as well as
	// the pane header geometry exercised by the other fixture cases.
	await page.locator('[data-strip="left"]').evaluate((element) => {
		element.removeAttribute("data-pane-id");
		element.classList.add("is-unfocused");
	});
	const before = await rectLeft(page, "tab-c");
	await page.evaluate(() => window.__tabFixture?.remove("left", "tab-b"));

	const immediate = await page.evaluate(() => {
		const strip = document.querySelector('[data-strip-scroll="left"]')!;
		const ghost = strip.querySelector<HTMLElement>(".tool-tab-motion-ghost");
		return {
			roles: strip.querySelectorAll('[role="tab"]').length,
			ghosts: strip.querySelectorAll(".tool-tab-motion-ghost").length,
			ghostAriaHidden: ghost?.getAttribute("aria-hidden") ?? null,
			ghostInert: ghost?.hasAttribute("inert") ?? false,
			ghostRole: ghost?.querySelector("[role]") ?? null,
			ghostId: ghost?.querySelector("[id]") ?? null,
			ghostTabIndex: ghost?.querySelector("[tabindex]") ?? null,
			duplicateIds: strip.querySelectorAll("[id]").length,
		};
	});
	expect(immediate.roles).toBe(2);
	expect(immediate.ghosts).toBe(1);
	expect(immediate.ghostAriaHidden).toBe("true");
	expect(immediate.ghostInert).toBe(true);
	expect(immediate.ghostRole).toBeNull();
	expect(immediate.ghostId).toBeNull();
	expect(immediate.ghostTabIndex).toBeNull();
	expect(immediate.duplicateIds).toBe(0);
	const indicator = page.locator('[data-strip-scroll="left"] .tool-tab-indicator');
	const movingIndicator = await indicator.evaluate((element) => {
		const style = getComputedStyle(element);
		return { opacity: style.opacity, transition: style.transitionDuration };
	});
	expect(movingIndicator).toEqual({ opacity: "0", transition: "0s" });

	const start = await seekTab(page, "tab-c", 0);
	const middle = await seekTab(page, "tab-c", 30);
	const end = await seekTab(page, "tab-c", 179);
	expect(start).not.toBeNull();
	expect(middle).not.toBeNull();
	expect(end).not.toBeNull();
	expect(start!.duration).toBe(180);
	expect(Math.abs(start!.left - before)).toBeLessThan(1);
	expect(end!.left).toBeLessThan(before - 20);
	expectBetween(middle!.left, end!.left + 0.5, start!.left - 0.5);
	expect(start!.keyframes[0]).toMatchObject({ transform: expect.stringContaining("translate(") });
	expect(start!.keyframes[1]).toMatchObject({ transform: "translate(0px, 0px)" });
	assertNoScaleOrWidth(start!.keyframes);

	await finishTabMotion(page);
	await settle(page);
	expect(Math.abs((await rectLeft(page, "tab-c")) - end!.left)).toBeLessThan(1.5);
	expect(await page.locator(".tool-tab-motion-ghost").count()).toBe(0);
	const settledIndicator = await indicator.evaluate((element) => ({
		left: element.getBoundingClientRect().left,
		movement: element
			.getAnimations()
			.some(
				(animation) =>
					animation instanceof CSSTransition && ["transform", "width"].includes(animation.transitionProperty),
			),
	}));
	expect(settledIndicator.movement).toBe(false);
	await page.waitForTimeout(100);
	expect(
		Math.abs((await indicator.evaluate((element) => element.getBoundingClientRect().left)) - settledIndicator.left),
	).toBeLessThan(0.5);
});

test("adding a middle tab appears without scaling text and shifts its neighbor", async ({ page }) => {
	await open(page);
	await page.evaluate(() => window.__tabFixture?.setLeft(["tab-a", "tab-c"]));
	await settle(page);
	const before = await rectLeft(page, "tab-c");
	await page.evaluate(() => window.__tabFixture?.add("left", "tab-b", 1));

	const start = await seekTab(page, "tab-c", 0);
	const middle = await seekTab(page, "tab-c", 90);
	const end = await seekTab(page, "tab-c", 179);
	expect(start).not.toBeNull();
	expect(end!.left).toBeGreaterThan(before + 10);
	expectBetween(middle!.left, before + 2, end!.left - 2);
	const appear = await seekTab(page, "tab-b", 0);
	expect(appear).not.toBeNull();
	expect(appear!.keyframes[0]).toMatchObject({ opacity: "0", transform: "translateY(-2px)" });
	expect(appear!.keyframes[1]).toMatchObject({ opacity: "1", transform: "translateY(0px)" });
	const running = await tabAnimations(page);
	expect(running.length).toBeGreaterThan(1);
	for (const animation of running) {
		expect(animation.duration).toBeGreaterThanOrEqual(160);
		expect(animation.duration).toBeLessThanOrEqual(200);
		assertNoScaleOrWidth(animation.keyframes);
	}
	await finishTabMotion(page);
	await settle(page);
	expect(Math.abs((await rectLeft(page, "tab-c")) - end!.left)).toBeLessThan(1.5);
	await expect(page.locator('[data-strip="left"] [role="tab"]')).toHaveCount(3);
});

test("rapid removals retarget from the current visual position", async ({ page }) => {
	await open(page);
	await page.evaluate(() => window.__tabFixture?.setLeft(["tab-a", "tab-b", "tab-c", "tab-d"]));
	await settle(page);
	await page.evaluate(() => window.__tabFixture?.remove("left", "tab-b"));
	const mid = await seekTab(page, "tab-d", 60);
	expect(mid).not.toBeNull();
	const visualBeforeSecondEdit = await rectLeft(page, "tab-d");
	await page.evaluate(() => window.__tabFixture?.remove("left", "tab-c"));
	const visualAfterSecondEdit = await rectLeft(page, "tab-d");
	expect(Math.abs(visualAfterSecondEdit - visualBeforeSecondEdit)).toBeLessThan(1.5);
	const restarted = await seekTab(page, "tab-d", 0);
	expect(restarted).not.toBeNull();
	expect(Math.abs(restarted!.left - mid!.left)).toBeLessThan(1.5);
	expect(restarted!.keyframes[0]).toMatchObject({ transform: expect.stringContaining("translate(") });
	await finishTabMotion(page);
	await settle(page);
	const final = await rectLeft(page, "tab-d");
	expect(final).toBeLessThan(restarted!.left - 50);
	await expect(page.locator('[data-strip="left"] [role="tab"]')).toHaveCount(2);
});

test("closing the last tab clears the strip and its exit chrome", async ({ page }) => {
	await open(page);
	await page.evaluate(() => window.__tabFixture?.setLeft(["solo"]));
	await settle(page);
	await page.evaluate(() => window.__tabFixture?.remove("left", "solo"));
	await expect(page.locator('[data-strip="left"] [role="tab"]')).toHaveCount(0);
	expect(await page.locator(".tool-tab-motion-ghost").count()).toBe(1);
	await finishTabMotion(page);
	await settle(page);
	await expect(page.locator(".tool-tab-motion-ghost")).toHaveCount(0);
	expect(await page.locator('[data-strip="left"] [role="tab"]').count()).toBe(0);
	expect(
		await page
			.locator('[data-strip-scroll="left"]')
			.evaluate((element) => element.getAttribute("data-tab-motion-animating")),
	).toBeNull();
});

test("many overflowing tabs keep the horizontal scroll anchor during a removal", async ({ page }) => {
	await open(page);
	await page.evaluate(() => window.__tabFixture?.setMany("left", 16));
	await settle(page);
	await page.locator('[data-strip-scroll="left"]').evaluate((element) => {
		element.scrollLeft = 140;
	});
	expect(await scrollLeft(page)).toBe(140);
	await page.evaluate(() => window.__tabFixture?.remove("left", "many-2"));
	expect(await scrollLeft(page)).toBe(140);
	await seekTab(page, "many-8", 90);
	expect(await scrollLeft(page)).toBe(140);
	await finishTabMotion(page);
	await settle(page);
	expect(await scrollLeft(page)).toBe(140);
	await expect(page.locator('[data-strip="left"] [role="tab"]')).toHaveCount(15);
});

test("split panes animate only the strip whose tab changed", async ({ page }) => {
	await open(page, "split=1");
	const rightBefore = await rectLeft(page, "tab-x");
	await page.evaluate(() => window.__tabFixture?.remove("left", "tab-b"));
	const leftStart = await seekTab(page, "tab-c", 0);
	const leftEnd = await seekTab(page, "tab-c", 179);
	expect(leftStart).not.toBeNull();
	expect(leftEnd!.left).toBeLessThan(leftStart!.left - 20);
	const rightAnimation = await seekTab(page, "tab-x", 0);
	expect(rightAnimation).toBeNull();
	expect(await rectLeft(page, "tab-x")).toBe(rightBefore);
	expect(
		await page
			.locator('[data-strip-scroll="right"]')
			.evaluate((element) => element.getAttribute("data-tab-motion-animating")),
	).toBeNull();
	await finishTabMotion(page);
	await settle(page);
});

test("application reduced motion applies immediately with no exit chrome", async ({ page }) => {
	await open(page, "motion=reduced");
	const before = await rectLeft(page, "tab-c");
	await page.evaluate(() => window.__tabFixture?.remove("left", "tab-b"));
	expect(await page.locator(".tool-tab-motion-ghost").count()).toBe(0);
	expect(
		await page
			.locator('[data-strip-scroll="left"]')
			.evaluate((element) => element.getAttribute("data-tab-motion-animating")),
	).toBeNull();
	const immediate = await rectLeft(page, "tab-c");
	expect(immediate).toBeLessThan(before - 20);
	await page.waitForTimeout(220);
	expect(await rectLeft(page, "tab-c")).toBe(immediate);
	expect(await tabAnimations(page)).toHaveLength(0);
});

test("OS reduced motion applies even while the root still reports full motion", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await open(page, "motion=full");
	const before = await rectLeft(page, "tab-c");
	await page.evaluate(() => window.__tabFixture?.remove("left", "tab-b"));
	expect(await page.locator(".tool-tab-motion-ghost").count()).toBe(0);
	expect(await rectLeft(page, "tab-c")).toBeLessThan(before - 20);
	expect(await tabAnimations(page)).toHaveLength(0);
});

test("application reduced motion mid-animation cancels exit chrome and movement", async ({ page }) => {
	await open(page);
	await page.evaluate(() => window.__tabFixture?.remove("left", "tab-b"));
	await seekTab(page, "tab-c", 60);
	expect(await page.locator(".tool-tab-motion-ghost").count()).toBe(1);
	await page.evaluate(() => window.__tabFixture?.setMotion("reduced"));
	await expect.poll(() => page.locator(".tool-tab-motion-ghost").count()).toBe(0);
	expect(await tabAnimations(page)).toHaveLength(0);
	expect(
		await page
			.locator('[data-strip-scroll="left"]')
			.evaluate((element) => element.getAttribute("data-tab-motion-animating")),
	).toBeNull();
});

test("OS reduced motion mid-animation cancels the same effects", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await open(page, "motion=full");
	await page.evaluate(() => window.__tabFixture?.remove("left", "tab-b"));
	await seekTab(page, "tab-c", 60);
	expect(await page.locator(".tool-tab-motion-ghost").count()).toBe(1);
	await page.emulateMedia({ reducedMotion: "reduce" });
	await expect.poll(() => page.locator(".tool-tab-motion-ghost").count()).toBe(0);
	expect(await tabAnimations(page)).toHaveLength(0);
});

test("suspended layout gestures suppress tab motion entirely", async ({ page }) => {
	await open(page);
	await page.evaluate(() => window.__tabFixture?.setSuspended(true));
	await page.evaluate(() => window.__tabFixture?.remove("left", "tab-b"));
	expect(await page.locator(".tool-tab-motion-ghost").count()).toBe(0);
	expect(await tabAnimations(page)).toHaveLength(0);
	await expect(page.locator('[data-strip="left"] [role="tab"]')).toHaveCount(2);
});

test("responsive sizing uses each real pane width and keeps visible tab widths equal", async ({ page }, info) => {
	await open(page, "responsive&split=1&motion=reduced");
	await page.setViewportSize({ width: 1600, height: 620 });
	await page.evaluate(() => {
		window.__tabFixture?.setWidth("left", 400);
		window.__tabFixture?.setWidth("right", 760);
	});
	const widths = (side: "left" | "right") =>
		page
			.locator(`[data-strip="${side}"] .tool-tab`)
			.evaluateAll((tabs) => tabs.map((tab) => tab.getBoundingClientRect().width));
	await expect.poll(async () => (await widths("left"))[0]).toBeLessThan(150);
	const narrow = await widths("left");
	const wide = await widths("right");
	for (const values of [narrow, wide]) {
		expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
		for (const width of values) {
			expect(width).toBeGreaterThanOrEqual(104);
			expect(width).toBeLessThanOrEqual(160);
		}
	}
	expect(narrow[0]).toBeLessThan(wide[0]);
	await page.evaluate(() => window.__tabFixture?.setWidth("left", 640));
	await expect.poll(async () => (await widths("left"))[0]).toBeGreaterThan(narrow[0]);
	const resized = await widths("left");
	await page.evaluate(() => window.__tabFixture?.setLeft(["one-very-long-conversation-name", "x", "short"]));
	await expect(page.locator('[data-strip="left"] .tool-tab')).toHaveCount(3);
	await settle(page);
	expect(await widths("left")).toEqual(resized);
	expect(await widths("right")).toEqual(wide);
	await page.screenshot({ path: info.outputPath("responsive-unequal-panes.png"), animations: "disabled" });
});

test("responsive overflow retains keyboard focus and reveals the focused tab after pane resize", async ({ page }) => {
	await open(page, "responsive&motion=reduced");
	await page.evaluate(() => {
		window.__tabFixture?.setWidth("left", 420);
		window.__tabFixture?.setMany("left", 20);
	});
	const host = page.locator('[data-strip-scroll="left"]');
	await expect(page.locator('[data-strip="left"] .tool-tab')).toHaveCount(20);
	await expect.poll(() => host.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(1000);
	const last = page.locator(`${key("many-20")} .tool-tab-select`);
	await last.focus();
	await page.keyboard.press("Tab");
	const close = page.locator(`${key("many-20")} .tool-tab-close`);
	await expect(close).toBeFocused();
	await expect.poll(() => scrollLeft(page)).toBeGreaterThan(1000);
	await page.evaluate(() => window.__tabFixture?.setWidth("left", 600));
	await expect(close).toBeFocused();
	await expect
		.poll(() =>
			close.evaluate((element) => {
				const box = element.getBoundingClientRect();
				const viewport = element.closest(".tool-tabs-scroll")!.getBoundingClientRect();
				return box.left >= viewport.left - 1 && box.right <= viewport.right + 1;
			}),
		)
		.toBe(true);
	const widths = await page
		.locator('[data-strip="left"] .tool-tab')
		.evaluateAll((tabs) => tabs.map((tab) => tab.getBoundingClientRect().width));
	for (const width of widths) expect(width).toBe(104);
});

for (const unstableRef of [false, true]) {
	test(`responsive width changes during add and remove preserve the sampled motion origin and ignore exit ghosts (${unstableRef ? "unstable" : "stable"} ref)`, async ({
		page,
	}) => {
		await open(page, `responsive${unstableRef ? "&unstableRef" : ""}`);
		await expect(page.locator('[data-strip-scroll="left"]')).toHaveAttribute(
			"data-ref-lifecycle",
			unstableRef ? "unstable" : "stable",
		);
		await page.evaluate(() => {
			window.__tabFixture?.setWidth("left", 600);
			window.__tabFixture?.setLeft(["tab-a", "tab-b", "tab-c", "tab-d"]);
		});
		await settle(page);
		const before = await rectLeft(page, "tab-c");
		const oldWidth = await page.locator(key("tab-c")).evaluate((element) => element.getBoundingClientRect().width);
		await page.evaluate(() => window.__tabFixture?.add("left", "inserted", 1));
		const insertedWidth = await page
			.locator(key("tab-c"))
			.evaluate((element) => element.getBoundingClientRect().width);
		expect(insertedWidth).toBeLessThan(oldWidth);
		const start = await seekTab(page, "tab-c", 0);
		expect(start).not.toBeNull();
		expect(Math.abs(start!.left - before)).toBeLessThanOrEqual(1);
		const middle = await seekTab(page, "tab-c", 90);
		expect(middle).not.toBeNull();
		await finishTabMotion(page);
		const origin = await rectLeft(page, "tab-c");
		expectBetween(middle!.left, Math.min(before, origin), Math.max(before, origin));
		await page.evaluate(() => window.__tabFixture?.remove("left", "inserted"));
		await expect(page.locator(".tool-tab-motion-ghost")).toHaveCount(1);
		const outgoingStart = await seekTab(page, "tab-c", 0);
		expect(outgoingStart).not.toBeNull();
		expect(Math.abs(outgoingStart!.left - origin)).toBeLessThanOrEqual(1);
		const outgoingMiddle = await seekTab(page, "tab-c", 90);
		expect(outgoingMiddle).not.toBeNull();
		const duringExit = await page.locator(key("tab-c")).evaluate((element) => element.getBoundingClientRect().width);
		await finishTabMotion(page);
		await settle(page);
		const finalWidth = await page.locator(key("tab-c")).evaluate((element) => element.getBoundingClientRect().width);
		const finalLeft = await rectLeft(page, "tab-c");
		expectBetween(outgoingMiddle!.left, Math.min(origin, finalLeft), Math.max(origin, finalLeft));
		expect(duringExit).toBe(finalWidth);
		expect(finalWidth).toBe(oldWidth);
	});
}
