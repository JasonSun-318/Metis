import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { build } from "esbuild";

test.use({ channel: "chrome" });
let directory: string;
let server: Server;
let url: string;
test.beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "metis-sidebar-footer-"));
	await build({
		entryPoints: [path.join(__dirname, "sidebar-footer-controls.fixture.tsx")],
		bundle: true,
		format: "esm",
		jsx: "automatic",
		platform: "browser",
		target: "es2022",
		outfile: path.join(directory, "fixture.js"),
	});
	await writeFile(
		path.join(directory, "index.html"),
		'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>body{font-family:var(--chat-prose-font)}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
	);
	server = createServer((request, response) => {
		const file = new Map([
			["/", "index.html"],
			["/fixture.js", "fixture.js"],
			["/fixture.css", "fixture.css"],
		]).get(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
		if (!file) {
			response.writeHead(204).end();
			return;
		}
		response.writeHead(200, {
			"content-type": file.endsWith(".js") ? "text/javascript" : file.endsWith(".css") ? "text/css" : "text/html",
		});
		createReadStream(path.join(directory, file)).pipe(response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Footer fixture failed to bind");
	url = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	if (directory) await rm(directory, { recursive: true, force: true });
});

const account = (page: Page) => page.getByRole("button", { name: "Fixture User", exact: true });
const menu = (page: Page) => page.getByRole("menu", { name: "Metis menu", exact: true });
const menuRow = (page: Page, name: string) => page.getByRole("menuitem", { name, exact: true });
const rawMenu = (page: Page) => page.locator(".account-menu-popover");
async function settleMenu(page: Page) {
	await rawMenu(page).evaluate((element) =>
		Promise.all(element.getAnimations().map((animation) => animation.finished.catch(() => undefined))),
	);
}
/**
 * Toggles the menu and samples its live CSS transition at a fixed fraction of
 * its own duration. Polling computed opacity races the 140/160ms transitions
 * against CI scheduling, so pause and seek the exported Animation instead; the
 * returned state is read while the transition is still mid-flight.
 */
async function sampleMenuTransition(page: Page) {
	return account(page).evaluate(async (button) => {
		button.focus();
		(button as HTMLButtonElement).click();
		// React commits the toggle after the native event, so wait a frame before
		// reading the freshly mounted/updated popover.
		await new Promise(requestAnimationFrame);
		const element = document.querySelector<HTMLElement>(".account-menu-popover")!;
		// Force a style flush so the transition objects exist before inspection.
		getComputedStyle(element).opacity;
		const animations = element.getAnimations();
		for (const animation of animations) {
			const timing = animation.effect!.getTiming();
			animation.pause();
			animation.currentTime = Number(timing.delay) + Number(timing.duration) / 2;
		}
		// Inert must reject focus during the exit, not only after it settles.
		element.querySelector<HTMLButtonElement>("button")?.focus();
		const state = {
			animationCount: animations.length,
			hasMotionKeyframes: animations
				.flatMap((animation) => (animation.effect as KeyframeEffect).getKeyframes())
				.some((frame) => frame.opacity || frame.transform),
			opacity: Number(getComputedStyle(element).opacity),
			display: getComputedStyle(element).display,
			ariaHidden: element.getAttribute("aria-hidden"),
			inert: element.hasAttribute("inert"),
			focusInside: element.contains(document.activeElement),
		};
		for (const animation of animations) animation.finish();
		return state;
	});
}
async function assertGeometry(page: Page, width: number) {
	const geometry = await rawMenu(page).evaluate((element) => {
		const box = element.getBoundingClientRect();
		const footer = element.closest(".sidebar-footer")!.getBoundingClientRect();
		const sidebar = element.closest(".session-sidebar")!.getBoundingClientRect();
		return {
			width: box.width,
			left: box.left,
			right: box.right,
			gap: footer.top - box.bottom,
			sidebarLeft: sidebar.left,
			sidebarRight: sidebar.right,
			padding: getComputedStyle(element).padding,
			radius: getComputedStyle(element).borderRadius,
			rows: Array.from(element.querySelectorAll('[role="menuitem"]'), (item) => item.getBoundingClientRect().height),
		};
	});
	expect(Math.abs(geometry.width - width)).toBeLessThanOrEqual(1);
	expect(Math.abs(geometry.left - geometry.sidebarLeft)).toBeLessThanOrEqual(1);
	expect(Math.abs(geometry.right - geometry.sidebarRight)).toBeLessThanOrEqual(1);
	expect(geometry.gap).toBe(8);
	expect(geometry.padding).toBe("4px");
	expect(geometry.radius).toBe("8px");
	expect(geometry.rows).toEqual([32, 32, 32]);
}

for (const theme of ["dark", "light"]) {
	for (const width of [232, 302, 400]) {
		test(`${theme} ${width}px unified menu follows live sidebar width`, async ({ page }, info) => {
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			await page.setViewportSize({ width: 900, height: 600 });
			await page.goto(`${url}/?theme=${theme}&width=${width}`);
			await expect(rawMenu(page)).toHaveAttribute("aria-hidden", "true");
			await expect(rawMenu(page)).toHaveAttribute("inert", "");
			await expect(
				page.locator(
					".sidebar-footer > .release-notes-control, .account-menu-footer > .account-update-check, .sidebar-update-notice",
				),
			).toHaveCount(0);
			await account(page).click();
			await expect(menuRow(page, "Settings")).toBeFocused();
			await expect(menu(page).getByRole("menuitem")).toHaveCount(3);
			await settleMenu(page);
			await assertGeometry(page, width);
			await page.getByTestId("outside").hover();
			await menuRow(page, "Notifications").focus();
			const rest = await menuRow(page, "Settings").evaluate((element) => getComputedStyle(element).backgroundColor);
			await menuRow(page, "Settings").hover();
			await expect
				.poll(() => menuRow(page, "Settings").evaluate((element) => getComputedStyle(element).backgroundColor))
				.not.toBe(rest);
			await page.screenshot({ path: info.outputPath(`unified-${theme}-${width}.png`), animations: "disabled" });
			for (const nextWidth of [400, 232, 302]) {
				await page.locator(".session-sidebar").evaluate((element: HTMLElement, next) => {
					element.style.width = `${next}px`;
				}, nextWidth);
				await expect(account(page)).toHaveAttribute("aria-expanded", "true");
				await assertGeometry(page, nextWidth);
			}
			await page.keyboard.press("Escape");
			await expect(rawMenu(page)).toHaveCount(1);
			await expect(rawMenu(page)).toHaveAttribute("aria-hidden", "true");
			await expect(rawMenu(page)).toHaveAttribute("inert", "");
			await expect(account(page)).toBeFocused();
			await account(page).click();
			await menuRow(page, "Settings").click();
			await expect(page.getByTestId("calls")).toContainText('"settings":1,"checks":0,"updates":0');
			const folder = page.getByTestId("folder-toggle");
			const closed = folder.locator('[data-folder-state="closed"]');
			const original = await closed.elementHandle();
			expect(await closed.evaluate((element) => element.innerHTML)).toBe(
				await page
					.getByTestId("reference-folder")
					.locator("svg")
					.evaluate((element) => element.innerHTML),
			);
			await folder.click();
			await expect(folder).toHaveAttribute("aria-expanded", "true");
			expect(await closed.evaluate((element, previous) => element === previous, original)).toBe(true);
			await expect(folder.locator('[data-folder-state="open"]')).toHaveCSS("opacity", "1");
			expect(errors).toEqual([]);
		});
	}
}

test("notification handoff preserves controller, acknowledges displayed history and returns focus", async ({
	page,
}) => {
	await page.goto(url);
	await expect(page.locator(".account-menu-status-dot[data-unread]")).toHaveCount(1);
	await expect(page.locator(".account-menu-item-dot")).toHaveCount(1);
	expect(await page.evaluate(() => localStorage.getItem("metis.release-notes-read-version.v1"))).toBeNull();
	const loads = JSON.parse(await page.getByTestId("calls").innerText()).loads;
	await account(page).click();
	await expect(page.locator(".account-menu-item-dot")).toHaveCount(1);
	expect(await page.evaluate(() => localStorage.getItem("metis.release-notes-read-version.v1"))).toBeNull();
	await page.keyboard.press("Escape");
	await account(page).click();
	expect(JSON.parse(await page.getByTestId("calls").innerText()).loads).toBe(loads);
	await menuRow(page, "Notifications").click();
	await expect(rawMenu(page)).toHaveAttribute("aria-hidden", "true");
	await expect(rawMenu(page)).toHaveAttribute("inert", "");
	await expect(page.getByRole("dialog")).toBeVisible();
	await expect(page.getByText("Isolated release notes fixture.", { exact: false })).toBeVisible();
	await page.keyboard.press("Tab");
	await expect(page.getByRole("dialog").locator(".release-notes-version")).toBeFocused();
	await page.keyboard.press("Tab");
	await expect(page.locator(".release-notes-reader")).toBeFocused();
	await page.keyboard.press("Tab");
	const details = page.getByRole("dialog").getByRole("link", { name: "Fixture details", exact: true });
	await expect(details).toBeFocused();
	await page.evaluate(() => {
		document.addEventListener("keydown", (event) => {
			if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
			const dialog = document.querySelector(".release-notes-dialog");
			dialog?.setAttribute(
				"data-key-defaults",
				`${dialog.getAttribute("data-key-defaults") ?? ""}${event.key}:${event.defaultPrevented};`,
			);
		});
	});
	for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) await page.keyboard.press(key);
	await expect(details).toBeFocused();
	await expect(page.getByRole("dialog")).toHaveAttribute(
		"data-key-defaults",
		"ArrowDown:false;ArrowUp:false;Home:false;End:false;",
	);
	await expect(page.locator(".account-menu-item-dot")).toHaveCount(0);
	await expect(page.locator(".account-menu-status-dot[data-unread]")).toHaveCount(0);
	expect(await page.evaluate(() => localStorage.getItem("metis.release-notes-read-version.v1"))).toBe("0.1.9");
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(account(page)).toBeFocused();
	await account(page).click();
	await menuRow(page, "Notifications").click();
	await page.getByRole("button", { name: "Close release notes", exact: true }).click();
	await expect(account(page)).toBeFocused();
	await page.reload();
	await expect(page.locator(".account-menu-item-dot")).toHaveCount(0);
});

test("known newer update stays unread after displaying older loaded history", async ({ page }) => {
	await page.goto(`${url}/?state=available`);
	await expect(page.locator(".account-menu-status-dot[data-unread]")).toHaveCount(1);
	await account(page).click();
	await menuRow(page, "Notifications").click();
	await expect(page.getByText("Isolated release notes fixture.", { exact: false })).toBeVisible();
	expect(await page.evaluate(() => localStorage.getItem("metis.release-notes-read-version.v1"))).toBe("0.1.9");
	await expect(page.locator(".account-menu-item-dot")).toHaveCount(1);
	await expect(page.locator(".account-menu-status-dot[data-unread]")).toHaveCount(1);
	await page.getByRole("button", { name: "Close release notes", exact: true }).click();
	await expect(account(page)).toBeFocused();
});

test("keyboard navigation skips busy update row and never traps outside focus", async ({ page }) => {
	await page.goto(`${url}/?state=downloading`);
	await account(page).focus();
	await page.keyboard.press("ArrowUp");
	await expect(menuRow(page, "Notifications")).toBeFocused();
	await page.keyboard.press("Home");
	await expect(menuRow(page, "Settings")).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(menuRow(page, "Notifications")).toBeFocused();
	await page.keyboard.press("ArrowDown");
	await expect(menuRow(page, "Settings")).toBeFocused();
	await page.keyboard.press("End");
	await expect(menuRow(page, "Notifications")).toBeFocused();
	await expect(menuRow(page, "Get updates")).toBeDisabled();
	await expect(menuRow(page, "Get updates")).toContainText("42%");
	await page.keyboard.press("Tab");
	await expect(rawMenu(page)).toHaveAttribute("aria-hidden", "true");
	await expect(menu(page)).toHaveCount(0);
	await page.getByTestId("outside").focus();
	await account(page).click();
	await page.getByTestId("outside").click();
	await expect(page.getByTestId("outside")).toBeFocused();
	await expect(rawMenu(page)).toHaveAttribute("aria-hidden", "true");
	await account(page).focus();
	await page.keyboard.press("ArrowDown");
	await expect(menuRow(page, "Settings")).toBeFocused();
	await page.getByTestId("outside").focus();
	await expect(rawMenu(page)).toHaveAttribute("aria-hidden", "true");
	await expect(page.getByTestId("outside")).toBeFocused();
});

test("update row routes available/ready actions and suppresses duplicate busy checks", async ({ page }) => {
	await page.goto(url);
	await account(page).click();
	await menuRow(page, "Get updates").click();
	await expect(page.getByTestId("calls")).toContainText('"checks":1,"updates":0');
	await account(page).click();
	await expect(menuRow(page, "Get updates")).toBeDisabled();
	await menuRow(page, "Get updates").evaluate((element: HTMLButtonElement) => element.click());
	await expect(page.getByTestId("calls")).toContainText('"checks":1,"updates":0');
	for (const state of ["available", "ready"]) {
		await page.getByTestId("outside").click();
		await page.getByRole("combobox", { name: "Update fixture state" }).selectOption(state);
		await account(page).click();
		await expect(menuRow(page, "Get updates")).toBeEnabled();
		await menuRow(page, "Get updates").click();
	}
	await expect(page.getByTestId("calls")).toContainText('"checks":1,"updates":2');
});

for (const reduced of ["app", "os"]) {
	test(`${reduced} reduced motion suppresses menu and folder physical animation`, async ({ page }) => {
		if (reduced === "os") await page.emulateMedia({ reducedMotion: "reduce" });
		await page.goto(`${url}/?width=232${reduced === "app" ? "&reduced" : ""}`);
		await account(page).click();
		await expect(rawMenu(page)).toHaveCSS("animation-name", "none");
		expect(
			await rawMenu(page).evaluate(
				(element) =>
					element
						.getAnimations()
						.filter((animation) =>
							(animation.effect as KeyframeEffect)
								.getKeyframes()
								.some((frame) => frame.transform || frame.translate || frame.opacity),
						).length,
			),
		).toBe(0);
		await page.keyboard.press("Escape");
		await page.getByTestId("folder-toggle").click();
		expect(
			await page
				.getByTestId("folder-toggle")
				.locator("svg")
				.evaluateAll((elements) =>
					elements.map((element) => ({
						animations: element.getAnimations({ subtree: true }).length,
						transition: getComputedStyle(element).transitionProperty,
					})),
				),
		).toEqual([
			{ animations: 0, transition: "none" },
			{ animations: 0, transition: "none" },
		]);
	});
}

test("full motion animates entry and exit while closed rows become inert immediately", async ({ page }) => {
	await page.goto(url);
	const entry = await sampleMenuTransition(page);
	expect(entry.animationCount).toBeGreaterThan(0);
	expect(entry.hasMotionKeyframes).toBe(true);
	expect(entry.opacity).toBeGreaterThan(0);
	expect(entry.opacity).toBeLessThan(1);
	const exit = await sampleMenuTransition(page);
	// Closed rows are inert on the same commit that starts the exit transition.
	expect(exit.ariaHidden).toBe("true");
	expect(exit.inert).toBe(true);
	expect(exit.focusInside).toBe(false);
	expect(exit.display).toBe("grid");
	expect(exit.opacity).toBeGreaterThan(0);
	expect(exit.opacity).toBeLessThan(1);
	await expect(rawMenu(page)).toHaveCSS("display", "none");
	await expect(account(page)).toBeFocused();
});

for (const theme of ["dark", "light"]) {
	for (const width of [1440, 390]) {
		test(`${theme} ${width}px notifications open a centered full release reader`, async ({ page }, info) => {
			const height = width === 390 ? 720 : 1000;
			await page.setViewportSize({ width, height });
			await page.goto(`${url}/?theme=${theme}&long`);
			await account(page).click();
			await menuRow(page, "Notifications").click();
			const dialog = page.getByRole("dialog", { name: "What's new", exact: true });
			const reader = page.locator(".release-notes-reader");
			const versions = page.getByRole("navigation", { name: "Release versions" });
			await expect(dialog).toHaveAttribute("aria-modal", "true");
			await expect(versions.getByRole("button")).toHaveCount(5);
			await expect(reader).toContainText("新增统一权限设置");
			await dialog.evaluate((el) => Promise.all(el.getAnimations().map((animation) => animation.finished)));
			const box = (await dialog.boundingBox())!;
			expect(box.width).toBeGreaterThan(width * .7);
			expect(box.height).toBeGreaterThan(height * .7);
			expect(Math.abs(box.x - (width - box.width) / 2)).toBeLessThan(1);
			expect(Math.abs(box.y - (height - box.height) / 2)).toBeLessThan(1);
			expect(box.x).toBeGreaterThanOrEqual(12);
			expect(box.x + box.width).toBeLessThanOrEqual(width - 12);
			await expect(page.getByRole("button", { name: "Close release notes" })).toBeFocused();
			await page.keyboard.press("Shift+Tab");
			await expect(reader).toBeFocused();
			await page.keyboard.press("Tab");
			await expect(page.getByRole("button", { name: "Close release notes" })).toBeFocused();
			await page.screenshot({ path: info.outputPath(`release-notes-${theme}-${width}.png`) });
			const navBefore = await versions.boundingBox();
			await reader.evaluate((el) => { el.scrollTop = el.scrollHeight; });
			await expect(reader.locator("li").last()).toBeInViewport();
			expect((await versions.boundingBox())!.y).toBe(navBefore!.y);
			expect(await reader.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
			await versions.getByRole("button", { name: "Version 0.0.8", exact: true }).click();
			await expect(reader).toContainText("可以搜索、编辑和撤销长期记忆");
			await expect(reader).not.toContainText("多会话分屏工作区");
			expect(await reader.evaluate((el) => el.scrollTop)).toBe(0);
			await versions.getByRole("button", { name: "Version 0.1.9", exact: true }).click();
			await expect(reader).toContainText("多会话分屏工作区");
			expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
			await page.mouse.click(4, 4);
			await expect(dialog).toHaveCount(0);
			await expect(account(page)).toBeFocused();
		});
	}
}
