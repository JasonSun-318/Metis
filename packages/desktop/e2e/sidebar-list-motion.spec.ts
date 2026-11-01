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

interface MotionFrame {
	readonly points: Record<string, number | null>;
	readonly scrollTop: number;
}

interface DrawerFrame {
	readonly heights: Record<string, number>;
}

declare global {
	interface Window {
		__sidebarMotionTrace?: { frames: MotionFrame[]; done: boolean };
		__sidebarDrawerTrace?: { frames: DrawerFrame[]; done: boolean };
	}
}

const item = (id: string) => `[data-sidebar-motion-key="session:${id}"]`;
const alpha = '.project-group:has(.project-heading[title="/fixture/Alpha"])';
const agentRoot = `${item("a1")} .session-agent-group`;
const agentTreeDrawer = `${agentRoot} > .agent-sidebar-drawer:has(.agent-sidebar-tree)`;
const agentSummaryDrawer = `${agentRoot} > .agent-sidebar-drawer:has(.agent-sidebar-summary)`;
const nestedAgentDrawer = `${agentRoot} [role="treeitem"][aria-label="资料整理"] > .agent-sidebar-drawer`;
const rootAgentToggle = `${agentRoot} .agent-root-toggle`;
const nestedAgentToggle = `${agentRoot} [role="treeitem"][aria-label="资料整理"] > .agent-sidebar-row .agent-sidebar-toggle`;

async function open(page: Page, query = "") {
	await page.setViewportSize({ width: 1040, height: 780 });
	await page.goto(`${url}/?${query}`);
	await expect(page.locator(".sidebar-list-motion")).toBeVisible();
}

async function settle(page: Page) {
	await page.waitForFunction(
		() => document.querySelector(".sidebar-list-motion")?.getAttribute("data-animating") !== "true",
	);
}

async function startTrace(page: Page, selectors: Record<string, string>) {
	await page.evaluate((targets) => {
		const trace = { frames: [] as MotionFrame[], done: false };
		window.__sidebarMotionTrace = trace;
		const until = performance.now() + 650;
		const sample = () => {
			trace.frames.push({
				points: Object.fromEntries(
					Object.entries(targets).map(([name, selector]) => [
						name,
						document.querySelector(selector)?.getBoundingClientRect().top ?? null,
					]),
				),
				scrollTop: document.querySelector(".project-list")?.scrollTop ?? 0,
			});
			if (performance.now() < until) requestAnimationFrame(sample);
			else trace.done = true;
		};
		sample();
	}, selectors);
}

async function frames(page: Page): Promise<MotionFrame[]> {
	await page.waitForFunction(() => window.__sidebarMotionTrace?.done === true);
	await settle(page);
	return page.evaluate(() => window.__sidebarMotionTrace?.frames ?? []);
}

function expectTravel(trace: readonly MotionFrame[], key: string) {
	const positions = trace.map((frame) => frame.points[key]).filter((value): value is number => value !== null);
	expect(positions.length).toBeGreaterThan(2);
	expect(Math.abs(positions[0] - positions[positions.length - 1])).toBeGreaterThan(5);
	expect(new Set(positions.map((value) => Math.round(value * 10))).size).toBeGreaterThan(2);
}

async function startDrawerTrace(
	page: Page,
	selectors = { tree: agentTreeDrawer, summary: agentSummaryDrawer, nested: nestedAgentDrawer },
) {
	await page.evaluate((selectors) => {
		const trace = { frames: [] as DrawerFrame[], done: false };
		window.__sidebarDrawerTrace = trace;
		const until = performance.now() + 650;
		const sample = () => {
			trace.frames.push({
				heights: Object.fromEntries(
					Object.entries(selectors).map(([key, selector]) => [
						key,
						document.querySelector(selector)?.getBoundingClientRect().height ?? 0,
					]),
				),
			});
			if (performance.now() < until) requestAnimationFrame(sample);
			else trace.done = true;
		};
		sample();
	}, selectors);
}

async function drawerFrames(page: Page): Promise<DrawerFrame[]> {
	await page.waitForFunction(() => window.__sidebarDrawerTrace?.done === true);
	return page.evaluate(() => window.__sidebarDrawerTrace?.frames ?? []);
}

async function drawerHeight(page: Page, selector: string) {
	return page.locator(selector).evaluate((element) => element.getBoundingClientRect().height);
}

function expectHeightTransition(trace: readonly DrawerFrame[], key: string) {
	const heights = trace.map((frame) => frame.heights[key]);
	expect(Math.abs(heights[0] - heights[heights.length - 1])).toBeGreaterThan(5);
	expect(new Set(heights.map((height) => Math.round(height * 10))).size).toBeGreaterThan(2);
}

test.beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "metis-sidebar-motion-"));
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
		`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>.motion-fixture-controls{display:flex;flex-direction:column;gap:20px;padding:40px;overflow:auto;font-size:14px}.motion-fixture-controls h1{font-size:22px;font-weight:500}.motion-fixture-controls p{color:var(--muted);line-height:1.7}.motion-fixture-controls label{display:flex;align-items:center;gap:12px}.motion-fixture-controls select,.motion-fixture-actions button{border:1px solid var(--border-strong);border-radius:7px;padding:8px 12px;background:var(--panel)}.motion-fixture-actions{display:flex;flex-wrap:wrap;gap:10px}.motion-fixture-controls output{color:var(--muted)}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`,
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
	if (!address || typeof address === "string") throw new Error("Motion fixture server did not start");
	url = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	if (directory) await rm(directory, { recursive: true, force: true });
});

test("unread sessions travel between groups, keep focus and remove the final empty section", async ({ page }) => {
	await open(page);
	await startTrace(page, { a1: item("a1"), a2: item("a2") });
	await page.locator(`${item("a1")} .session-button`).evaluate((button: HTMLButtonElement) => {
		button.focus();
		button.click();
	});
	const trace = await frames(page);
	expectTravel(trace, "a1");
	await expect(page.locator(`${item("a1")} .session-button`)).toBeFocused();
	await expect(page.getByTestId("selected-session")).toHaveAttribute("data-session-id", "a1");
	await expect(page.locator(`${item("a1")}`).locator("xpath=ancestor::section[1]")).toContainText("已读");
	await page.locator(`${item("a2")} .session-button`).click({ force: true });
	await settle(page);
	await expect(page.locator(".session-section-heading")).not.toContainText(["未读"]);
	await expect(page.locator(".session-button")).toHaveCount(28);
	await expect(page.locator(`${item("a2")} .session-button`)).toBeFocused();
});

test("status groups preserve focus while outcomes move and unread changes stay in place", async ({ page }, info) => {
	await open(page, "grouping=status&locale=en");
	await expect(page.locator(".session-section-heading")).toHaveCount(5);
	const pending = page.locator(`${item("a1")} .session-button`);
	const pendingSection = await pending.locator("xpath=ancestor::section[1]").getAttribute("data-sidebar-motion-key");
	await pending.click();
	await settle(page);
	expect(await pending.locator("xpath=ancestor::section[1]").getAttribute("data-sidebar-motion-key")).toBe(
		pendingSection,
	);
	const active = page.locator(`${item("a2")} .session-button`);
	await active.focus();
	await page.screenshot({ path: info.outputPath("status-groups-dark.png") });
	await startTrace(page, { session: item("a2"), problem: item("b1") });
	await page.getByTestId("finish-a2").evaluate((button: HTMLButtonElement) => button.click());
	expectTravel(await frames(page), "session");
	await expect(active).toBeFocused();
	await expect(page.locator(".session-section-heading")).toHaveCount(4);
	const completedSection = await active.locator("xpath=ancestor::section[1]").getAttribute("data-sidebar-motion-key");
	expect(completedSection).not.toBe(pendingSection);
	expect(
		await page.locator(item("b2")).locator("xpath=ancestor::section[1]").getAttribute("data-sidebar-motion-key"),
	).toBe(completedSection);
	await startTrace(page, { session: item("b2") });
	await page.getByTestId("start-b2").evaluate((button: HTMLButtonElement) => button.click());
	expectTravel(await frames(page), "session");
	await expect(active).toBeFocused();
	await expect(page.locator(".session-button")).toHaveCount(28);
});

test("status transitions honor reduced motion and keep a scrolled list anchored", async ({ page }) => {
	await open(page, "grouping=status&motion=reduced&theme=light");
	const active = page.locator(`${item("a2")} .session-button`);
	await active.focus();
	await page.locator(".project-list").evaluate((element) => {
		element.scrollTop = 120;
	});
	await page.getByTestId("finish-a2").evaluate((button: HTMLButtonElement) => button.click());
	await settle(page);
	await expect(active).toBeFocused();
	expect(await page.locator(".project-list").evaluate((element) => element.scrollTop)).toBe(120);
	expect(
		await page.locator(".sidebar-list-motion").evaluate(
			(element) =>
				element.getAnimations({ subtree: true }).filter((animation) => {
					const target = (animation.effect as KeyframeEffect | null)?.target;
					return (
						target instanceof Element &&
						(target.hasAttribute("data-sidebar-motion-key") || target.hasAttribute("data-sidebar-motion-exit"))
					);
				}).length,
		),
	).toBe(0);
});

test("grouping uses one keyboard-accessible menu inside the viewport", async ({ page }) => {
	await open(page, "grouping=status&locale=en");
	const trigger = page.locator(".session-grouping-trigger");
	await trigger.click();
	const menu = page.getByRole("menu");
	await expect(menu).toHaveCount(1);
	await expect(menu.getByRole("menuitemradio")).toHaveCount(5);
	await expect(menu.locator('[aria-checked="true"]')).toHaveText("Status");
	await expect(menu.locator('[aria-checked="true"]')).toBeFocused();
	const box = await menu.boundingBox();
	expect(box).not.toBeNull();
	expect(box!.x).toBeGreaterThanOrEqual(0);
	expect(box!.y).toBeGreaterThanOrEqual(0);
	expect(box!.x + box!.width).toBeLessThanOrEqual(1040);
	expect(box!.y + box!.height).toBeLessThanOrEqual(780);
	await page.keyboard.press("End");
	await expect(menu.getByRole("menuitemradio", { name: "None", exact: true })).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(menu).toHaveCount(0);
	await expect(trigger).toBeFocused();
	await trigger.click();
	await page.keyboard.press("Escape");
	await expect(trigger).toBeFocused();
});

test("starting and ending runs animate the existing updated-time order", async ({ page }) => {
	await open(page, "grouping=none");
	await startTrace(page, { beta: item("b2") });
	await page.getByTestId("start-b2").click();
	expectTravel(await frames(page), "beta");
	await expect(page.locator('.sidebar-list-motion [data-sidebar-motion-key^="session:"]').first()).toHaveAttribute(
		"data-sidebar-motion-key",
		"session:b2",
	);
	await page.getByTestId("start-a2").click();
	await settle(page);
	await startTrace(page, { beta: item("b2") });
	await page.getByTestId("finish-b2").click();
	expectTravel(await frames(page), "beta");
	await expect(page.locator('.sidebar-list-motion [data-sidebar-motion-key^="session:"]').first()).toHaveAttribute(
		"data-sidebar-motion-key",
		"session:b2",
	);
});

test("project headers and unchanged children move together without double displacement", async ({ page }, info) => {
	await open(page, "grouping=project");
	await startTrace(page, { project: alpha, first: item("a1"), second: item("a2") });
	await page.getByTestId("start-b2").click();
	const trace = await frames(page);
	expectTravel(trace, "project");
	for (const child of ["first", "second"]) {
		const offsets = trace.map((frame) => (frame.points[child] ?? 0) - (frame.points.project ?? 0));
		expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThan(1.5);
	}
	await expect(page.locator(".project-group").first().locator(".project-heading")).toHaveText("Beta");
	await page.screenshot({ path: info.outputPath("project-reorder-settled.png") });
});

test("rapid cross-group clicks continue from the visible position and retain the latest focus", async ({ page }) => {
	await open(page);
	await startTrace(page, { a1: item("a1") });
	const jump = await page.evaluate(async () => {
		const find = (id: string) =>
			document.querySelector<HTMLElement>(`[data-sidebar-motion-key="session:${id}"] .session-button`)!;
		find("a1").focus({ preventScroll: true });
		find("a1").click();
		for (let count = 0; count < 4; count++) await new Promise(requestAnimationFrame);
		const before = find("a1").getBoundingClientRect().top;
		find("a2").focus({ preventScroll: true });
		find("a2").click();
		await new Promise(requestAnimationFrame);
		return Math.abs(find("a1").getBoundingClientRect().top - before);
	});
	expect(jump).toBeLessThan(20);
	// Once the final unread section disappears, a1 can finish at its original
	// screen position; verify that its out-and-back path still has real motion.
	const positions = (await frames(page))
		.map((frame) => frame.points.a1)
		.filter((value): value is number => value !== null);
	expect(Math.max(...positions) - Math.min(...positions)).toBeGreaterThan(5);
	expect(new Set(positions.map((value) => Math.round(value * 10))).size).toBeGreaterThan(2);
	await expect(page.getByTestId("selected-session")).toHaveAttribute("data-session-id", "a2");
	await expect(page.locator(`${item("a2")} .session-button`)).toBeFocused();
	await expect(page.locator(".session-button")).toHaveCount(28);
});

test("background project reorder keeps focus on a moved existing session", async ({ page }) => {
	await open(page, "grouping=project");
	const focused = page.locator(`${item("a1")} .session-button`);
	await focused.focus();
	await page.getByTestId("start-b2").evaluate((button: HTMLButtonElement) => button.click());
	await settle(page);
	await expect(focused).toBeFocused();
	await expect(page.locator(".project-group").first().locator(".project-heading")).toHaveText("Beta");
});

test("an open project menu follows its anchor through a background reorder", async ({ page }) => {
	await open(page, "grouping=project");
	const trigger = page.locator(`${alpha} .project-action-buttons > button[aria-haspopup="menu"]`);
	await trigger.click({ force: true });
	const menu = page.locator(".project-action-menu");
	await expect(menu).toBeVisible();
	const before = await menu.boundingBox();
	await page.getByTestId("start-b2").evaluate((button: HTMLButtonElement) => button.click());
	await settle(page);
	await expect(menu).toBeVisible();
	await expect.poll(async () => (await menu.boundingBox())?.y).toBeGreaterThan((before?.y ?? 0) + 30);
});

test("keeps scroll through reorder and does not undo scrolling during the animation", async ({ page }) => {
	await open(page, "grouping=none");
	await page.locator(".project-list").evaluate((element) => {
		element.scrollTop = 120;
	});
	await page.getByTestId("start-b2").click();
	expect(await page.locator(".project-list").evaluate((element) => element.scrollTop)).toBe(120);
	await page.evaluate(async () => {
		for (let count = 0; count < 3; count++) await new Promise(requestAnimationFrame);
		document.querySelector(".project-list")!.scrollTop = 160;
	});
	await settle(page);
	expect(await page.locator(".project-list").evaluate((element) => element.scrollTop)).toBe(160);
});

test("reduced motion applies immediately and cancels an in-progress reorder", async ({ page }) => {
	await open(page, "grouping=none&motion=reduced");
	await page.getByTestId("start-b2").click();
	await expect(page.locator(".sidebar-list-motion")).not.toHaveAttribute("data-animating", "true");
	await page.getByTestId("toggle-motion").click();
	await page.getByTestId("start-a2").click();
	await page.waitForFunction(
		() => document.querySelector(".sidebar-list-motion")?.getAttribute("data-animating") === "true",
	);
	await page.getByTestId("toggle-motion").click();
	await settle(page);
	const effects = await page.evaluate(
		() =>
			document.getAnimations().filter((animation) => {
				const target = (animation.effect as KeyframeEffect | null)?.target;
				return target instanceof Element && target.hasAttribute("data-sidebar-motion-key");
			}).length,
	);
	expect(effects).toBe(0);
	await expect(page.locator(".session-button")).toHaveCount(28);
});

test("system reduced motion works when the application has no explicit motion override", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await open(page, "grouping=none&motion=system");
	await page.getByTestId("start-b2").click();
	await expect(page.locator(".sidebar-list-motion")).not.toHaveAttribute("data-animating", "true");
	await expect(page.locator('.sidebar-list-motion [data-sidebar-motion-key^="session:"]').first()).toHaveAttribute(
		"data-sidebar-motion-key",
		"session:b2",
	);
});

test("content updates keep an in-flight move continuous and child additions expand in place", async ({ page }) => {
	await open(page, "grouping=none&agents=1");
	await startTrace(page, { beta: item("b2"), alpha: alpha });
	await page.getByTestId("start-b2").click();
	await page.evaluate(async () => {
		for (let count = 0; count < 2; count++) await new Promise(requestAnimationFrame);
	});
	const continuity = await page.evaluate(
		async ({ selector, updateSelector }) => {
			const element = document.querySelector(selector)!;
			const update = document.querySelector<HTMLButtonElement>(updateSelector)!;
			const started = performance.now();
			while (
				element.getAnimations().some((animation) => animation.startTime === null) &&
				performance.now() - started < 100
			) {
				await new Promise(requestAnimationFrame);
			}
			const originals = element.getAnimations();
			const before = originals.map((animation) => ({
				start: animation.startTime,
				current: animation.currentTime,
			}));
			update.click();
			await new Promise(requestAnimationFrame);
			const after = element.getAnimations().map((animation) => ({
				start: animation.startTime,
				current: animation.currentTime,
			}));
			return {
				before,
				after,
				sameAnimations: element.getAnimations().every((animation, index) => animation === originals[index]),
			};
		},
		{ selector: item("b2"), updateSelector: '[data-testid="content-update"]' },
	);
	expect(continuity.after).toHaveLength(continuity.before.length);
	expect(continuity.before).toHaveLength(1);
	expect(continuity.sameAnimations).toBe(true);
	expect(continuity.after[0]?.start).toBe(continuity.before[0]?.start);
	expect(Number(continuity.after[0]?.current)).toBeGreaterThan(Number(continuity.before[0]?.current));
	await frames(page);
	await page.getByTestId("start-b2").click();
	await startTrace(page, { beta: item("b2") });
	await page.getByTestId("add-child").click();
	await expect(page.locator(`${agentRoot} .agent-sidebar-open`)).toHaveCount(4);
	await page.getByTestId("add-child").click();
	await expect(page.locator(`${agentRoot} .agent-sidebar-open`)).toHaveCount(5);
	await expect(page.locator(`${agentRoot} [aria-label="新增子任务"]`)).toBeVisible();
	await expect(page.locator(`${agentRoot} [aria-label="新增孙任务"]`)).toBeVisible();
});

test("an open nested subtree keeps its navigation state while the whole project moves", async ({ page }) => {
	await open(page, "grouping=project&agents=1");
	const nested = page.locator(nestedAgentToggle);
	await nested.click();
	await expect(page.locator(nestedAgentDrawer)).toHaveAttribute("data-open", "false");
	const focused = page.locator(`${item("a1")} .session-button`);
	await focused.focus();
	const scroll = page.locator(".project-list");
	await scroll.evaluate((element) => {
		element.scrollTop = 40;
	});
	await startTrace(page, { project: alpha, nested: nestedAgentDrawer });
	await page.getByTestId("start-b2").evaluate((button: HTMLButtonElement) => button.click());
	expectTravel(await frames(page), "project");
	await expect(page.locator(nestedAgentDrawer)).toHaveAttribute("data-open", "false");
	await expect(focused).toBeFocused();
	expect(await scroll.evaluate((element) => element.scrollTop)).toBe(40);
	// Also cover an expanded subtree whose selected descendant owns focus.
	await nested.click();
	const grandchild = page.locator(`${nestedAgentDrawer} .agent-sidebar-open`);
	await grandchild.click();
	await expect(grandchild).toHaveAttribute("aria-current", "page");
	await scroll.evaluate((element) => {
		element.scrollTop = 40;
	});
	await startTrace(page, { project: alpha, nested: nestedAgentDrawer });
	await page.getByTestId("start-a1").evaluate((button: HTMLButtonElement) => button.click());
	const expandedTrace = await frames(page);
	expectTravel(expandedTrace, "project");
	for (const frame of expandedTrace) expect(frame.points.nested).not.toBeNull();
	const offsets = expandedTrace.map((frame) => frame.points.nested! - frame.points.project!);
	expect(Math.max(...offsets) - Math.min(...offsets)).toBeLessThan(1.5);
	await expect(page.locator(nestedAgentDrawer)).toHaveAttribute("data-open", "true");
	await expect(grandchild).toHaveAttribute("aria-current", "page");
	await expect(grandchild).toBeFocused();
	expect(await scroll.evaluate((element) => element.scrollTop)).toBe(40);
});

test("content updates preserve entering header and exiting remnant opacity animations", async ({ page }) => {
	await open(page, "grouping=status&locale=en");
	const inspect = async (action: string, entering: boolean) =>
		page.evaluate(
			async ({ actionSelector, enteringHeader }) => {
				const root = document.querySelector(".sidebar-list-motion")!;
				document.querySelector<HTMLButtonElement>(actionSelector)!.click();
				const selector = enteringHeader
					? '[data-sidebar-motion-key="chat:status:running:header"]'
					: '[data-sidebar-motion-exit][aria-hidden="true"]';
				// Wait for the animation clock to start rather than assuming a fixed
				// frame count: under CI load the second frame can still be time 0.
				const deadline = performance.now() + 1_000;
				let header: HTMLElement | null = null;
				let animation: Animation | undefined;
				while (performance.now() < deadline) {
					header ??= root.querySelector<HTMLElement>(selector);
					animation = header
						?.getAnimations()
						.find((effect) =>
							(effect.effect as KeyframeEffect).getKeyframes().some((keyframe) => keyframe.opacity !== undefined),
						);
					if (animation && animation.startTime !== null) break;
					await new Promise(requestAnimationFrame);
				}
				if (!header) throw new Error("Expected a real entering header or exiting remnant");
				if (!animation || animation.startTime === null) throw new Error("Expected a real running opacity animation");
				// Pause and seek the real animation so a slow frame cannot finish it
				// between the content update and the continuity assertions.
				const timing = animation.effect!.getTiming();
				animation.pause();
				animation.currentTime = Number(timing.delay) + Number(timing.duration) * 0.25;
				const before = {
					time: Number(animation.currentTime),
					start: animation.startTime,
					opacity: Number(getComputedStyle(header).opacity),
				};
				document.querySelector<HTMLButtonElement>('[data-testid="content-update"]')!.click();
				await new Promise(requestAnimationFrame);
				animation.currentTime = Number(timing.delay) + Number(timing.duration) * 0.5;
				const result = {
					before,
					after: {
						time: Number(animation.currentTime),
						start: animation.startTime,
						opacity: Number(getComputedStyle(header).opacity),
					},
					sameNode: header === root.querySelector(selector),
					sameAnimation: header.getAnimations().includes(animation),
					connected: header.isConnected,
				};
				animation.finish();
				return result;
			},
			{ actionSelector: `[data-testid="${action}"]`, enteringHeader: entering },
		);
	const exit = await inspect("finish-a2", false);
	expect(exit.sameNode).toBe(true);
	expect(exit.sameAnimation).toBe(true);
	expect(exit.connected).toBe(true);
	expect(exit.before.opacity).toBeGreaterThan(0);
	expect(exit.before.opacity).toBeLessThan(1);
	expect(exit.after.opacity).toBeLessThanOrEqual(exit.before.opacity);
	expect(exit.after.start).toBe(exit.before.start);
	expect(exit.after.time).toBeGreaterThan(exit.before.time);
	await settle(page);
	const enter = await inspect("start-b2", true);
	expect(enter.sameNode).toBe(true);
	expect(enter.sameAnimation).toBe(true);
	expect(enter.connected).toBe(true);
	expect(enter.before.opacity).toBeGreaterThan(0);
	expect(enter.before.opacity).toBeLessThan(1);
	expect(enter.after.opacity).toBeGreaterThanOrEqual(enter.before.opacity);
	expect(enter.after.start).toBe(enter.before.start);
	expect(enter.after.time).toBeGreaterThan(enter.before.time);
});

test("the first and second child expand the branch and displace following sessions through intermediate frames", async ({
	page,
}, info) => {
	await open(page, "grouping=none&agents=1&initialAgents=empty&added=siblings");
	await expect(page.locator(`${agentRoot} .agent-sidebar-open`)).toHaveCount(0);
	const originalRoot = await page.locator(item("a1")).elementHandle();
	const originalFollower = await page.locator(item("a2")).elementHandle();
	for (const count of [1, 2]) {
		await startDrawerTrace(page);
		await startTrace(page, { follower: item("a2") });
		await page.getByTestId("add-child").evaluate((button: HTMLButtonElement) => button.click());
		await expect(page.locator(`${agentRoot} .agent-sidebar-open`)).toHaveCount(count);
		const heights = await drawerFrames(page);
		const travel = await frames(page);
		const framePath = info.outputPath(`child-${count}-frames.json`);
		await writeFile(framePath, JSON.stringify({ heights, travel }, null, 2));
		await info.attach(`child-${count}-frames`, { path: framePath, contentType: "application/json" });
		expectHeightTransition(heights, "tree");
		expectTravel(travel, "follower");
		expect(await page.locator(item("a1")).evaluate((element, original) => element === original, originalRoot)).toBe(
			true,
		);
		expect(
			await page.locator(item("a2")).evaluate((element, original) => element === original, originalFollower),
		).toBe(true);
	}
	await settle(page);
	await page.screenshot({ path: info.outputPath("first-second-child-settled.png"), animations: "disabled" });
});

test("a selected expanded grandchild retains focus and navigation across unread status groups", async ({ page }) => {
	await open(page, "grouping=unread&agents=1");
	const grandchild = page.locator(`${nestedAgentDrawer} .agent-sidebar-open`);
	await grandchild.click();
	await page.locator(agentTreeDrawer).evaluate((element) =>
		Promise.all(
			element
				.getAnimations({ subtree: true })
				.filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
				.map((animation) => animation.finished.catch(() => undefined)),
		),
	);
	const visibleTreeHeight = await drawerHeight(page, agentTreeDrawer);
	expect(visibleTreeHeight).toBeGreaterThan(80);
	const beforeSection = await page
		.locator(item("a1"))
		.locator("xpath=ancestor::section[1]")
		.getAttribute("data-sidebar-motion-key");
	const scroll = page.locator(".project-list");
	await scroll.evaluate((element) => {
		element.scrollTop = 40;
	});
	const originalUnrelated = await page.locator(item("b1")).elementHandle();
	await startDrawerTrace(page);
	await startTrace(page, { root: item("a1"), child: nestedAgentDrawer });
	await page.getByTestId("start-a1").evaluate((button: HTMLButtonElement) => button.click());
	const trace = await frames(page);
	const heightTrace = await drawerFrames(page);
	expect(Math.min(...heightTrace.map((frame) => frame.heights.tree))).toBeGreaterThanOrEqual(visibleTreeHeight - 1.5);
	expectTravel(trace, "root");
	await expect(page.locator(rootAgentToggle)).toHaveAttribute("aria-expanded", "true");
	await expect(page.locator(nestedAgentDrawer)).toHaveAttribute("data-open", "true");
	await expect(grandchild).toHaveAttribute("aria-current", "page");
	await expect(grandchild).toBeFocused();
	await expect(page.getByTestId("selected-agent")).toContainText("引用核对");
	expect(
		await page.locator(item("a1")).locator("xpath=ancestor::section[1]").getAttribute("data-sidebar-motion-key"),
	).not.toBe(beforeSection);
	expect(await scroll.evaluate((element) => element.scrollTop)).toBe(40);
	expect(await page.locator(item("b1")).evaluate((element, original) => element === original, originalUnrelated)).toBe(
		true,
	);
});

test("agent hover rows stay separated while nested and root drawers close and reverse smoothly", async ({
	page,
}, info) => {
	await open(page, "grouping=none&agents=1");
	const buttons = page.locator(`${agentRoot} .agent-sidebar-open`);
	await expect(buttons).toHaveCount(3);
	await buttons.nth(1).hover();
	const gaps = await buttons.evaluateAll((elements) =>
		elements
			.slice(1)
			.map((element, index) => element.getBoundingClientRect().top - elements[index].getBoundingClientRect().bottom),
	);
	for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(4);
	await buttons.filter({ hasText: "引用核对" }).click();
	await expect(page.getByTestId("selected-agent")).toContainText("引用核对");
	await startDrawerTrace(page);
	await page.locator(nestedAgentToggle).click();
	const nestedClose = await drawerFrames(page);
	expectHeightTransition(nestedClose, "nested");
	await expect(page.locator(nestedAgentDrawer)).toHaveAttribute("data-open", "false");
	await expect(page.locator(nestedAgentDrawer)).toHaveAttribute("aria-hidden", "true");
	expect(await page.locator(nestedAgentDrawer).evaluate((element) => element.hasAttribute("inert"))).toBe(true);
	expect(await drawerHeight(page, nestedAgentDrawer)).toBeLessThan(0.5);
	await expect(page.locator(`${nestedAgentDrawer} .agent-sidebar-open`)).toHaveCount(1);
	await page.locator(nestedAgentToggle).click();
	await expect.poll(() => drawerHeight(page, nestedAgentDrawer)).toBeGreaterThan(20);
	await startDrawerTrace(page);
	await page.locator(rootAgentToggle).click();
	const rootClose = await drawerFrames(page);
	expectHeightTransition(rootClose, "tree");
	expectHeightTransition(rootClose, "summary");
	await expect(page.locator(agentTreeDrawer)).toHaveAttribute("aria-hidden", "true");
	expect(await page.locator(agentTreeDrawer).evaluate((element) => element.hasAttribute("inert"))).toBe(true);
	expect(await drawerHeight(page, agentTreeDrawer)).toBeLessThan(0.5);
	await expect(buttons).toHaveCount(3);
	// A frame-spaced reversal stays within one real drawer DOM, including its summary.
	await page.evaluate(async (selector) => {
		const toggle = document.querySelector<HTMLButtonElement>(selector)!;
		toggle.click();
		for (let count = 0; count < 3; count++) await new Promise(requestAnimationFrame);
		toggle.click();
		for (let count = 0; count < 2; count++) await new Promise(requestAnimationFrame);
		toggle.click();
	}, rootAgentToggle);
	await expect(page.locator(rootAgentToggle)).toHaveAttribute("aria-expanded", "true");
	await expect.poll(() => drawerHeight(page, agentTreeDrawer)).toBeGreaterThan(80);
	await expect.poll(() => drawerHeight(page, agentSummaryDrawer)).toBeLessThan(0.5);
	await expect(buttons).toHaveCount(3);
	await page.screenshot({ path: info.outputPath("agent-drawers-open.png") });
});

test("agent drawers respect explicit, system and live reduced-motion changes", async ({ page }) => {
	for (const preference of ["reduced", "system"]) {
		await page.emulateMedia({ reducedMotion: preference === "system" ? "reduce" : "no-preference" });
		await open(page, `grouping=none&agents=1&motion=${preference}`);
		await page.getByTestId("reset").click();
		await expect(page.locator(`${agentRoot} .agent-sidebar-open`)).toHaveCount(3);
		await page.locator(rootAgentToggle).click();
		expect(await drawerHeight(page, agentTreeDrawer)).toBeLessThan(0.5);
		await expect(page.locator(agentTreeDrawer)).toHaveAttribute("aria-hidden", "true");
		expect(await page.locator(agentTreeDrawer).evaluate((element) => element.hasAttribute("inert"))).toBe(true);
		await page.locator(rootAgentToggle).click();
		await page.locator(nestedAgentToggle).click();
		expect(await drawerHeight(page, nestedAgentDrawer)).toBeLessThan(0.5);
		await expect(page.locator(`${nestedAgentDrawer} .agent-sidebar-open`)).toHaveCount(1);
	}
	await page.emulateMedia({ reducedMotion: "no-preference" });
	await open(page, "grouping=none&agents=1");
	await page.getByTestId("reset").click();
	await expect(page.locator(`${agentRoot} .agent-sidebar-open`)).toHaveCount(3);
	await page.locator(rootAgentToggle).click();
	await page.getByTestId("toggle-motion").click();
	expect(await drawerHeight(page, agentTreeDrawer)).toBeLessThan(0.5);
	await expect(page.locator(agentTreeDrawer)).toHaveAttribute("aria-hidden", "true");
});

test("left sidebar, tool shell, knowledge pane and its open titlebar share each theme's surface", async ({ page }) => {
	for (const theme of ["dark", "light"]) {
		await open(page, `grouping=none&agents=1&theme=${theme}`);
		const colors = await page.evaluate(() => {
			const color = (selector: string) => getComputedStyle(document.querySelector(selector)!).backgroundColor;
			return {
				left: color(".session-sidebar"),
				tools: color(".tool-sidebar"),
				knowledge: color(".knowledge-panel"),
				titlebar: color(".workspace-titlebar-tools.is-open"),
				conversation: color(".conversation-column"),
			};
		});
		expect(colors.left).toBe(colors.tools);
		expect(colors.left).toBe(colors.knowledge);
		expect(colors.left).toBe(colors.titlebar);
		expect(colors.conversation).not.toBe(colors.left);
		expect(colors.conversation).toBe(theme === "dark" ? "rgb(20, 20, 20)" : "rgb(250, 249, 246)");
	}
});
