import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { build } from "esbuild";

test.use({ channel: "chrome", contextOptions: { reducedMotion: "no-preference" } });
let server: Server;
let directory: string;
let url: string;

const selectors = {
	task: ".new-task-button",
	customize: ".sidebar-nav-button:has(.animated-nav-icon-customize)",
	schedule: ".sidebar-nav-button:has(.animated-nav-icon-schedule)",
	chat: ".mode-switch button:has(.sidebar-mode-icon-chat)",
	code: ".mode-switch button:has(.sidebar-mode-icon-code)",
};

async function open(page: Page, query = "") {
	await page.setViewportSize({ width: 1040, height: 780 });
	await page.goto(`${url}/?locale=en&grouping=project&${query}`);
	await expect(page.locator(".session-sidebar")).toBeVisible();
	await page.mouse.move(800, 700);
}

async function count(button: Locator) {
	return button.evaluate((element) =>
		Array.from(element.querySelectorAll("svg > path")).reduce(
			(total, part) => total + part.getAnimations().length,
			0,
		),
	);
}

async function sample(button: Locator, fraction: number | null) {
	return button.evaluate(async (element, at) => {
		const svg = element.querySelector("svg")!;
		const paths = Array.from(svg.querySelectorAll<SVGPathElement>(":scope > path"));
		const active = paths.flatMap((part, index) =>
			part.getAnimations().map((animation) => ({ part, index, animation })),
		);
		if (at !== null)
			for (const { animation } of active) {
				const timing = animation.effect!.getTiming();
				animation.pause();
				animation.currentTime = Number(timing.delay) + Number(timing.duration) * at;
			}
		await new Promise(requestAnimationFrame);
		const box = svg.getBoundingClientRect();
		return {
			box: { x: box.x, y: box.y, width: box.width, height: box.height },
			svgTransform: getComputedStyle(svg).transform,
			svgAnimations: svg.getAnimations().length,
			active: active.map(({ index, animation }) => ({
				part: index + 1,
				duration: Number(animation.effect!.getTiming().duration),
				iterations: Number(animation.effect!.getTiming().iterations),
				playState: animation.playState,
			})),
			parts: paths.map((part) => ({
				transform: getComputedStyle(part).transform,
				opacity: Number(getComputedStyle(part).opacity),
			})),
		};
	}, fraction);
}

async function finish(button: Locator) {
	await button.evaluate((element) => {
		for (const path of Array.from(element.querySelectorAll("svg > path"))) {
			for (const animation of path.getAnimations()) animation.finish();
		}
	});
}

function expectStill(before: { x: number; y: number; width: number; height: number }, after: typeof before) {
	for (const coordinate of ["x", "y", "width", "height"] as const) {
		expect(Math.abs(before[coordinate] - after[coordinate])).toBeLessThan(0.25);
	}
}

test.beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "metis-sidebar-icons-"));
	await build({
		entryPoints: [path.join(__dirname, "sidebar-list-motion.fixture.tsx")],
		bundle: true,
		format: "esm",
		jsx: "automatic",
		platform: "browser",
		target: "es2022",
		outfile: path.join(directory, "fixture.js"),
	});
	await writeFile(
		path.join(directory, "index.html"),
		'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>.motion-fixture-controls{padding:40px;overflow:auto;font-size:14px}.motion-fixture-controls h1{font-size:22px}.motion-fixture-actions{display:flex;gap:10px;flex-wrap:wrap}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
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
	if (!address || typeof address === "string") throw new Error("Icon fixture server did not start");
	url = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	if (directory) await rm(directory, { recursive: true, force: true });
});

for (const [kind, moving] of [
	["task", [1, 2]],
	["customize", [1, 2, 3, 4]],
	["schedule", [1, 2, 3]],
	["chat", [2, 3, 4]],
	["code", [1, 2, 3]],
] as const) {
	test(`${kind} holds its official semantic parts until leave and then returns without looping`, async ({
		page,
	}, info) => {
		await open(page);
		const button = page.locator(selectors[kind]);
		await button.hover();
		const start = await sample(button, 0);
		const middle = await sample(button, 0.45);
		expect(middle.active.map((effect) => effect.part)).toEqual([...moving]);
		expect(middle.svgAnimations).toBe(0);
		expect(middle.svgTransform).toBe("none");
		expectStill(start.box, middle.box);
		for (const [index, part] of middle.parts.entries()) {
			if (moving.some((number) => number === index + 1)) {
				expect(
					part.transform !== start.parts[index]!.transform ||
						Math.abs(part.opacity - start.parts[index]!.opacity) > 0.05,
				).toBe(true);
			} else {
				expect(part).toEqual(start.parts[index]);
				expect(part.transform).toBe("none");
			}
		}
		await page
			.locator(".session-sidebar")
			.screenshot({ path: info.outputPath(`${kind}-semantic-parts.png`), animations: "allow" });
		await finish(button);
		const held = await sample(button, null);
		for (const effect of held.active) {
			expect(effect.playState).toBe("finished");
			expect(effect.iterations).toBe(1);
		}
		expectStill(start.box, held.box);
		for (const number of moving) expect(held.parts[number - 1]).not.toEqual(start.parts[number - 1]);
		await page.waitForTimeout(400);
		expect((await sample(button, null)).parts).toEqual(held.parts);
		expect(await count(button)).toBe(moving.length);
		await page
			.locator(".session-sidebar")
			.screenshot({ path: info.outputPath(`${kind}-held.png`), animations: "allow" });
		await page.mouse.move(800, 700);
		await finish(button);
		await expect.poll(() => count(button)).toBe(0);
		const ended = await sample(button, 1);
		expectStill(start.box, ended.box);
		for (const part of ended.parts) expect(part).toEqual({ transform: "none", opacity: 1 });
		expect(await count(button)).toBe(0);
		await page
			.locator(".session-sidebar")
			.screenshot({ path: info.outputPath(`${kind}-after-leave.png`), animations: "allow" });
	});
}

test("quick leave recovers from the live frame and rapid reentry does not jump", async ({ page }) => {
	await open(page);
	const button = page.locator(selectors.task);
	await button.hover();
	await sample(button, 0.4);
	const before = await button.evaluate((element) => {
		const part = element.querySelector<SVGPathElement>("svg > path")!;
		const initial = { transform: getComputedStyle(part).transform, opacity: getComputedStyle(part).opacity };
		const state = window as typeof window & {
			__iconRecovery?: { after?: typeof initial; duration?: number; reentered?: typeof initial };
		};
		state.__iconRecovery = {};
		element.addEventListener(
			"pointerleave",
			() => {
				state.__iconRecovery!.after = {
					transform: getComputedStyle(part).transform,
					opacity: getComputedStyle(part).opacity,
				};
				state.__iconRecovery!.duration = Number(part.getAnimations()[0]?.effect?.getTiming().duration);
			},
			{ once: true },
		);
		return initial;
	});
	await page.mouse.move(800, 700);
	const leaving = await page.evaluate(
		() =>
			(
				window as typeof window & {
					__iconRecovery?: { after?: { transform: string; opacity: string }; duration?: number };
				}
			).__iconRecovery,
	);
	expect(leaving?.after).toEqual(before);
	expect(leaving?.duration).toBe(180);
	await sample(button, 0.4);
	const recovering = await button.evaluate((element) => {
		const part = element.querySelector<SVGPathElement>("svg > path")!;
		const initial = { transform: getComputedStyle(part).transform, opacity: getComputedStyle(part).opacity };
		element.addEventListener(
			"pointerenter",
			() => {
				(window as typeof window & { __iconReentered?: typeof initial }).__iconReentered = {
					transform: getComputedStyle(part).transform,
					opacity: getComputedStyle(part).opacity,
				};
			},
			{ once: true },
		);
		return initial;
	});
	await button.hover();
	expect(await page.evaluate(() => (window as typeof window & { __iconReentered?: unknown }).__iconReentered)).toEqual(
		recovering,
	);
	await page.mouse.move(800, 700);
	await finish(button);
	await expect.poll(() => count(button)).toBe(0);
});

test("keyboard focus-visible triggers once and overlaps hover without stealing focus or scrolling", async ({
	page,
}) => {
	await open(page);
	await page.locator(".project-list").evaluate((element) => {
		element.scrollTop = 100;
	});
	const before = await page.evaluate(() => ({
		x: scrollX,
		y: scrollY,
		list: document.querySelector(".project-list")!.scrollTop,
	}));
	await page.keyboard.press("Tab");
	const chat = page.locator(selectors.chat);
	await expect(chat).toBeFocused();
	expect(await chat.evaluate((element) => element.matches(":focus-visible"))).toBe(true);
	await sample(chat, 0.4);
	const original = await chat.evaluate((element) => {
		const animations = Array.from(element.querySelectorAll("svg > path")).flatMap((part) => part.getAnimations());
		(window as typeof window & { __focusedIconAnimations?: Animation[] }).__focusedIconAnimations = animations;
		return animations.length;
	});
	expect(original).toBe(3);
	await chat.hover();
	expect(
		await chat.evaluate((element) => {
			const previous = (window as typeof window & { __focusedIconAnimations?: Animation[] })
				.__focusedIconAnimations!;
			const current = Array.from(element.querySelectorAll("svg > path")).flatMap((part) => part.getAnimations());
			return (
				current.length === previous.length && current.every((animation, index) => animation === previous[index])
			);
		}),
	).toBe(true);
	await page.mouse.move(800, 700);
	await expect(chat).toBeFocused();
	expect(await count(chat)).toBe(3);
	await page.keyboard.press("Tab");
	await expect(page.locator(selectors.code)).toBeFocused();
	await page.locator(selectors.task).hover();
	await expect(page.locator(selectors.code)).toBeFocused();
	expect(
		await page.evaluate(() => ({ x: scrollX, y: scrollY, list: document.querySelector(".project-list")!.scrollTop })),
	).toEqual(before);
});

for (const policy of ["disabled", "aria-disabled", "app-reduced", "os-reduced"] as const) {
	test(`${policy} cancels a real in-progress icon immediately`, async ({ page }) => {
		await open(page);
		const button = page.locator(selectors.schedule);
		await button.hover();
		await sample(button, 0.45);
		if (policy === "os-reduced") await page.emulateMedia({ reducedMotion: "reduce" });
		else
			await button.evaluate((element, mode) => {
				if (mode === "disabled") (element as HTMLButtonElement).disabled = true;
				else if (mode === "aria-disabled") element.setAttribute("aria-disabled", "true");
				else document.documentElement.dataset.motion = "reduced";
			}, policy);
		await expect.poll(() => count(button)).toBe(0);
		const ended = await sample(button, 1);
		for (const part of ended.parts) expect(part).toEqual({ transform: "none", opacity: 1 });
		await page.mouse.move(800, 700);
		await button.hover();
		expect(await count(button)).toBe(0);
	});
}

test("initial application or OS reduced motion keeps all sidebar icons static", async ({ page }) => {
	for (const system of [false, true]) {
		await page.emulateMedia({ reducedMotion: system ? "reduce" : "no-preference" });
		await open(page, `motion=${system ? "full" : "reduced"}`);
		for (const selector of Object.values(selectors)) {
			const button = page.locator(selector);
			await button.hover();
			expect(await count(button)).toBe(0);
		}
		const folder = page.locator('.project-heading[title="/fixture/Alpha"]');
		await folder.click();
		await expect(folder.locator(".sidebar-folder-icon")).toHaveAttribute("data-expanded", "false");
		expect(
			await folder.locator('svg[data-folder-state="closed"]').evaluate((element) => ({
				opacity: getComputedStyle(element).opacity,
				animations: element.getAnimations().length,
			})),
		).toEqual({ opacity: "1", animations: 0 });
		expect(
			await folder.locator('svg[data-folder-state="open"]').evaluate((element) => ({
				opacity: getComputedStyle(element).opacity,
				animations: element.getAnimations().length,
			})),
		).toEqual({ opacity: "0", animations: 0 });
	}
});

test("project folders crossfade official open and closed layers at 14px while the drawer follows", async ({
	page,
}, info) => {
	await open(page);
	const button = page.locator('.project-heading[title="/fixture/Alpha"]');
	const group = page.locator('.project-group:has(.project-heading[title="/fixture/Alpha"])');
	const drawer = group.locator(":scope > .project-drawer");
	const icon = button.locator(".sidebar-folder-icon");
	const layers = button.locator("svg[data-folder-state]");
	const before = await layers.evaluateAll((elements) =>
		elements.map((element) => ({
			width: element.getAttribute("width"),
			height: element.getAttribute("height"),
			artwork: element.innerHTML,
		})),
	);
	expect(before).toHaveLength(2);
	for (const layer of before) {
		expect(layer.width).toBe("14");
		expect(layer.height).toBe("14");
	}
	expect(before[0]!.artwork).not.toBe(before[1]!.artwork);
	const box = await icon.boundingBox();
	expect(box?.width).toBe(14);
	expect(box?.height).toBe(14);
	await expect(icon).toHaveAttribute("data-expanded", "true");
	const opacity = (state: "open" | "closed") =>
		icon
			.locator(`svg[data-folder-state="${state}"]`)
			.evaluate((element) => Number(getComputedStyle(element).opacity));
	await expect.poll(() => opacity("open")).toBe(1);
	await expect.poll(() => opacity("closed")).toBe(0);
	const expanded = await drawer.evaluate((element) => element.getBoundingClientRect().height);
	expect(expanded).toBeGreaterThan(20);
	await button.click();
	await expect(button).toHaveAttribute("aria-expanded", "false");
	await expect(icon).toHaveAttribute("data-expanded", "false");
	const crossfade = await icon.evaluate(async (element) => {
		const layers = Array.from(element.querySelectorAll("svg[data-folder-state]"));
		const animations = layers.flatMap((layer) => layer.getAnimations());
		for (const animation of animations) {
			animation.pause();
			animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
		}
		await new Promise(requestAnimationFrame);
		const frame = {
			opacities: layers.map((layer) => Number(getComputedStyle(layer).opacity)),
			durations: animations.map((animation) => Number(animation.effect!.getTiming().duration)),
		};
		return frame;
	});
	expect(crossfade.durations.length).toBeGreaterThan(0);
	expect(crossfade.durations).toEqual(expect.arrayContaining([180, 220]));
	for (const opacity of crossfade.opacities) {
		expect(opacity).toBeGreaterThan(0);
		expect(opacity).toBeLessThan(1);
	}
	await page
		.locator(".session-sidebar")
		.screenshot({ path: info.outputPath("compact-folder-midpoint.png"), animations: "allow" });
	await layers.evaluateAll((elements) => {
		for (const element of elements) for (const animation of element.getAnimations()) animation.finish();
	});
	await expect(button).toBeFocused();
	await expect(drawer).toHaveAttribute("inert", "");
	await expect.poll(() => drawer.evaluate((element) => element.getBoundingClientRect().height)).toBe(0);
	await expect.poll(() => opacity("open")).toBe(0);
	await expect.poll(() => opacity("closed")).toBe(1);
	await page
		.locator(".session-sidebar")
		.screenshot({ path: info.outputPath("compact-folder-collapsed.png"), animations: "allow" });
	await button.click();
	await expect(button).toHaveAttribute("aria-expanded", "true");
	await expect(icon).toHaveAttribute("data-expanded", "true");
	await expect(drawer).not.toHaveAttribute("inert", "");
	await expect.poll(() => drawer.evaluate((element) => element.getBoundingClientRect().height)).toBe(expanded);
	await expect.poll(() => opacity("open")).toBe(1);
	await expect.poll(() => opacity("closed")).toBe(0);
	expect(await layers.evaluateAll((elements) => elements.map((element) => element.innerHTML))).toEqual(
		before.map((layer) => layer.artwork),
	);
	expectStill(box!, (await icon.boundingBox())!);
	await page
		.locator(".session-sidebar")
		.screenshot({ path: info.outputPath("compact-folder-expanded.png"), animations: "allow" });
	await button.click();
	await button.click();
	await button.click();
	await button.click();
	await expect(button).toHaveAttribute("aria-expanded", "true");
	await expect(icon).toHaveAttribute("data-expanded", "true");
	await expect.poll(() => opacity("open")).toBe(1);
	await expect.poll(() => opacity("closed")).toBe(0);
	await expect.poll(() => drawer.evaluate((element) => element.getBoundingClientRect().height)).toBe(expanded);
	await expect(button).toBeFocused();
	expectStill(box!, (await icon.boundingBox())!);
});
