import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { build } from "esbuild";
import type { AgentQueueFixture, QueueChild } from "./agent-queued-messages.types.ts";

declare global {
	interface Window {
		__agentQueueFixture: AgentQueueFixture;
	}
}
test.use({ channel: "chrome" });
let directory: string;
let server: Server;
let url: string;
const pane = (page: Page, key: QueueChild) => page.locator(`[data-child="${key}"]`);
const composer = (page: Page, key: QueueChild) => pane(page, key).locator('[id^="agent-composer-"]');
const rows = (page: Page, key: QueueChild) => pane(page, key).locator(".queued-turn-row");

test.beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "metis-agent-queue-"));
	await build({
		entryPoints: [path.join(__dirname, "agent-queued-messages.fixture.tsx")],
		bundle: true,
		format: "esm",
		jsx: "automatic",
		loader: { ".css": "empty" },
		platform: "browser",
		target: "es2022",
		outfile: path.join(directory, "fixture.js"),
	});
	await build({
		bundle: true,
		outfile: path.join(directory, "fixture.css"),
		stdin: {
			contents: ["tokens.css", "app.css", "permission-approval.css"]
				.map(
					(file) => `@import "${path.resolve(__dirname, "../src/renderer/styles", file).replaceAll("\\", "/")}";`,
				)
				.join("\n"),
			loader: "css",
			resolveDir: directory,
		},
	});
	await writeFile(
		path.join(directory, "index.html"),
		`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>.queue-fixture-layout{height:100vh;display:flex}.queue-fixture-pane{display:flex;flex:1;min-width:0;min-height:0;border-right:1px solid var(--border)}.queue-fixture-notice{position:fixed;top:4px;left:30%;max-width:40%;z-index:50;background:var(--panel);font-size:12px;padding:8px}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`,
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
	if (!address || typeof address === "string") throw new Error("Queue fixture failed to bind");
	url = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	if (directory) await rm(directory, { recursive: true, force: true });
});
async function open(page: Page, reduced = false) {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	await page.setViewportSize({ width: 1500, height: 860 });
	await page.goto(`${url}/?${reduced ? "reduced" : ""}`);
	await expect(composer(page, "a")).toBeVisible();
	await expect(pane(page, "a").locator(".agent-conversation-state")).toHaveText("Running");
	await expect(pane(page, "b").locator(".agent-conversation-state")).toHaveText("Running");
	await expect(pane(page, "a").getByRole("combobox", { name: "Message timing" })).toHaveCount(0);
	return errors;
}
async function send(page: Page, key: QueueChild, text: string) {
	await composer(page, key).fill(text);
	await expect(pane(page, key).getByRole("button", { name: "Queue message", exact: true })).toBeEnabled();
	await composer(page, key).press("Enter");
	await expect(rows(page, key)).toContainText([text]);
}

async function scrollIntoEarlierHistory(page: Page, key: QueueChild) {
	const scroll = pane(page, key).locator(".transcript-scroll");
	await page.evaluate(() => document.fonts.ready);
	await scroll.hover();
	await page.mouse.wheel(0, -900);
	await expect
		.poll(() => scroll.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight))
		.toBeGreaterThan(48);
	const before = await scroll.evaluate(async (element) => {
		element.scrollTop = 400;
		// Let the real virtualizer measure newly visible rows before recording
		// the baseline; its estimate-to-measure adjustment is not a queue jump.
		let previous = "";
		let stable = 0;
		for (let frame = 0; frame < 60 && stable < 4; frame += 1) {
			await new Promise(requestAnimationFrame);
			const geometry = `${element.scrollTop}:${element.scrollHeight}:${element.clientHeight}`;
			stable = geometry === previous ? stable + 1 : 0;
			previous = geometry;
		}
		if (stable < 4) throw new Error("Virtual history did not settle before queue action");
		return element.scrollTop;
	});
	expect(before).toBeGreaterThan(200);
	expect(
		await scroll.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
	).toBeGreaterThan(48);
	return { scroll, before };
}

test("running Enter queues once; rapid Guide consumes once and preserves draft, focus and scroll", async ({
	page,
}, info) => {
	const errors = await open(page);
	await send(page, "a", "Check the queue once");
	await expect(pane(page, "a").locator(".transcript").getByText("Check the queue once", { exact: true })).toHaveCount(
		0,
	);
	await expect(rows(page, "b")).toHaveCount(0);
	await composer(page, "a").fill("Keep the unsent draft");
	const { scroll, before } = await scrollIntoEarlierHistory(page, "a");
	const diagnosticBefore = await scroll.evaluate((element) => {
		const geometry = (anchorId?: string) => {
			const viewport = element.getBoundingClientRect();
			const rows = Array.from(element.querySelectorAll<HTMLElement>("[data-transcript-turn]")).map((row) => {
				const rect = row.getBoundingClientRect();
				return { id: row.dataset.transcriptTurn!, y: rect.top - viewport.top, height: rect.height };
			});
			const visible = rows.filter((row) => row.y + row.height > 0 && row.y < element.clientHeight);
			return {
				time: performance.now(),
				scrollTop: element.scrollTop,
				scrollHeight: element.scrollHeight,
				clientHeight: element.clientHeight,
				fonts: document.fonts.status,
				firstVisible: visible[0],
				readingAnchor: visible.find((row) => row.y >= 0) ?? visible[0],
				anchor: rows.find((row) => row.id === anchorId),
				visible,
			};
		};
		const before = geometry();
		const state = {
			before,
			frames: [] as ReturnType<typeof geometry>[],
			capture: () => geometry(before.readingAnchor?.id),
		};
		Reflect.set(window, "__scrollDiagnosis", state);
		const until = performance.now() + 650;
		const sample = () => {
			state.frames.push(state.capture());
			if (performance.now() < until) requestAnimationFrame(sample);
		};
		sample();
		return before;
	});
	const readingAnchor = diagnosticBefore.readingAnchor;
	expect(readingAnchor).toBeDefined();
	const anchor = scroll.locator(`[data-transcript-turn="${readingAnchor!.id}"]`);
	await page.evaluate(() => {
		window.__agentQueueFixture.remember("a");
		window.__agentQueueFixture.holdGuide();
	});
	await rows(page, "a")
		.getByRole("button", { name: "Guide with queued message" })
		.evaluate((button: HTMLButtonElement) => {
			button.click();
			button.click();
		});
	await expect.poll(() => page.evaluate(() => window.__agentQueueFixture.calls.guides.length)).toBe(1);
	await expect(rows(page, "a").getByRole("button", { name: "Guide with queued message" })).toBeDisabled();
	await page.evaluate(() => window.__agentQueueFixture.releaseGuide());
	await expect(rows(page, "a")).toHaveCount(0);
	await expect(composer(page, "a")).toHaveText("Keep the unsent draft");
	await expect(composer(page, "a")).toBeFocused();
	expect(await page.evaluate(() => window.__agentQueueFixture.nodesPreserved("a"))).toBe(true);
	try {
		await expect
			.poll(() => scroll.evaluate((element, previous) => Math.abs(element.scrollTop - previous), before))
			.toBeLessThanOrEqual(2);
		await expect(anchor).toHaveCount(1);
		await expect
			.poll(() =>
				anchor.evaluate(
					(element, previous) =>
						Math.abs(
							element.getBoundingClientRect().top -
								element.closest(".transcript-scroll")!.getBoundingClientRect().top -
								previous,
						),
					readingAnchor!.y,
				),
			)
			.toBeLessThanOrEqual(2);
	} finally {
		const diagnostic = await page.evaluate(() => {
			const state = Reflect.get(window, "__scrollDiagnosis");
			return { before: state.before, frames: state.frames, after: state.capture() };
		});
		const filename = info.outputPath("scroll-diagnosis.json");
		await writeFile(filename, JSON.stringify(diagnostic, null, 2));
		await info.attach("scroll-diagnosis", { path: filename, contentType: "application/json" });
		console.log(
			"SCROLL_DIAG",
			JSON.stringify({
				scrollBefore: diagnosticBefore.scrollTop,
				scrollAfter: diagnostic.after.scrollTop,
				anchorBefore: readingAnchor,
				anchorAfter: diagnostic.after.anchor,
			}),
		);
	}
	const calls = await page.evaluate(() => window.__agentQueueFixture.calls);
	expect(calls.messages).toHaveLength(1);
	expect(calls.messages[0].delivery).toBe("queue");
	expect(calls.guides).toHaveLength(1);
	expect(calls.guides[0].delivery).toBe("steer");
	expect(calls.guides[0].expectedRevision).toBe(`${calls.guides[0].queueItemId}-revision`);
	expect(calls.consumed).toEqual([calls.guides[0].queueItemId]);
	await page.evaluate(() => window.__agentQueueFixture.complete("a"));
	await expect(pane(page, "a").locator(".agent-conversation-state")).toHaveText("Completed");
	await scroll.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	await expect(pane(page, "a").getByText("Worker A durable reply", { exact: true })).toBeVisible();
	await expect(pane(page, "a").locator(".turn-runtime-status")).toHaveCount(0);
	await expect(pane(page, "b").locator(".agent-conversation-state")).toHaveText("Running");
	await expect(rows(page, "a")).toHaveCount(0);
	expect(await page.evaluate(() => window.__agentQueueFixture.calls.consumed.length)).toBe(1);
	await page.screenshot({ path: info.outputPath("guided-child-queue.png"), animations: "disabled" });
	expect(errors).toEqual([]);
});

test("failed Guide keeps the durable queue and draft available for a successful retry", async ({ page }) => {
	const errors = await open(page);
	await send(page, "a", "Retain me after failed Guide");
	await composer(page, "a").fill("Draft during failure");
	await page.evaluate(() => window.__agentQueueFixture.failNextGuide());
	await rows(page, "a").getByRole("button", { name: "Guide with queued message" }).click();
	await expect(pane(page, "a").getByRole("alert")).toBeVisible();
	await expect(rows(page, "a")).toContainText(["Retain me after failed Guide"]);
	await expect(composer(page, "a")).toHaveText("Draft during failure");
	await expect(rows(page, "a").getByRole("button", { name: "Guide with queued message" })).toBeEnabled();
	expect(await page.evaluate(() => window.__agentQueueFixture.calls.consumed)).toEqual([]);
	await rows(page, "a").getByRole("button", { name: "Guide with queued message" }).click();
	await expect(rows(page, "a")).toHaveCount(0);
	const calls = await page.evaluate(() => window.__agentQueueFixture.calls);
	expect(calls.guides).toHaveLength(2);
	expect(calls.consumed).toHaveLength(1);
	expect(calls.errors).toHaveLength(1);
	expect(errors).toEqual([]);
});

test("Edit returns text with attachment disclosure; Delete removes only the selected child queue", async ({ page }) => {
	const errors = await open(page, true);
	await page.evaluate(() => {
		window.__agentQueueFixture.seedQueue("a", "Edit this queued text", true);
		window.__agentQueueFixture.seedQueue("b", "Worker B stays queued");
	});
	await expect(rows(page, "a")).toContainText(["Edit this queued text"]);
	await expect(rows(page, "a")).toContainText(["fixture.txt"]);
	await composer(page, "a").fill("Existing draft");
	await rows(page, "a").getByRole("button", { name: "Edit queued message" }).click();
	await expect(rows(page, "a")).toHaveCount(0);
	await expect(composer(page, "a")).toContainText("Existing draft");
	await expect(composer(page, "a")).toContainText("Edit this queued text");
	await expect(page.getByTestId("queue-notice")).toContainText("Add its attachments again before sending.");
	await expect(pane(page, "a").locator(".composer-attachments")).toHaveCount(0);
	await page.evaluate(() => window.__agentQueueFixture.seedQueue("a", "Delete this queued text"));
	await expect(rows(page, "a")).toContainText(["Delete this queued text"]);
	await rows(page, "a").getByRole("button", { name: "Delete queued message" }).click();
	await expect(rows(page, "a")).toHaveCount(0);
	await expect(rows(page, "b")).toContainText(["Worker B stays queued"]);
	const calls = await page.evaluate(() => window.__agentQueueFixture.calls);
	expect(calls.deleted).toHaveLength(2);
	for (const call of calls.deleted) expect(call.expectedRevision).toBe(`${call.queueItemId}-revision`);
	expect(calls.deleted[0].agentId).toBe(calls.deleted[1].agentId);
	expect(calls.messages).toHaveLength(0);
	expect(calls.consumed).toHaveLength(0);
	expect(errors).toEqual([]);
});

for (const changedEpoch of [false, true]) {
	test(`${changedEpoch ? "changed" : "same"} epoch restores queue changes without mixing the two children`, async ({
		page,
	}) => {
		const errors = await open(page);
		await page.evaluate(() => {
			window.__agentQueueFixture.seedQueue("a", "A original");
			window.__agentQueueFixture.seedQueue("b", "B original");
		});
		await expect(rows(page, "a")).toContainText(["A original"]);
		await expect(rows(page, "b")).toContainText(["B original"]);
		await composer(page, "a").fill("Draft across reconnect");
		const { scroll, before } = await scrollIntoEarlierHistory(page, "a");
		await page.evaluate(() => {
			window.__agentQueueFixture.remember("a");
			window.__agentQueueFixture.disconnect();
			window.__agentQueueFixture.seedQueue("a", "A added while disconnected", false, false);
		});
		await expect(rows(page, "a")).toHaveCount(1);
		const reads = await page.evaluate(() => ({ ...window.__agentQueueFixture.calls.queueReads }));
		await page.evaluate((changed) => window.__agentQueueFixture.ready(changed), changedEpoch);
		await expect(rows(page, "a")).toHaveCount(2);
		await expect(rows(page, "a")).toContainText(["A original", "A added while disconnected"]);
		await expect(rows(page, "b")).toHaveCount(1);
		await expect(rows(page, "b")).toContainText(["B original"]);
		await expect(composer(page, "a")).toHaveText("Draft across reconnect");
		expect(await page.evaluate(() => window.__agentQueueFixture.nodesPreserved("a"))).toBe(true);
		await expect
			.poll(() => scroll.evaluate((element, previous) => Math.abs(element.scrollTop - previous), before))
			.toBeLessThanOrEqual(2);
		const after = await page.evaluate(() => window.__agentQueueFixture.calls.queueReads);
		expect(after.a).toBeGreaterThan(reads.a);
		expect(after.b).toBeGreaterThan(reads.b);
		expect(errors).toEqual([]);
	});
}

for (const kind of ["ask_user", "session_permission_approval"] as const) {
	test(`${kind} disables all queue actions only in the requesting child`, async ({ page }) => {
		const errors = await open(page, kind === "session_permission_approval");
		await page.evaluate(() => {
			window.__agentQueueFixture.seedQueue("a", "A blocked message");
			window.__agentQueueFixture.seedQueue("b", "B independent message");
		});
		await expect(rows(page, "a")).toHaveCount(1);
		await expect(rows(page, "b")).toHaveCount(1);
		await composer(page, "a").fill("Keep pending-request draft");
		await page.evaluate((pending) => window.__agentQueueFixture.block("a", pending), kind);
		for (const label of ["Guide with queued message", "Edit queued message", "Delete queued message"]) {
			await expect(rows(page, "a").getByRole("button", { name: label })).toBeDisabled();
			await expect(rows(page, "b").getByRole("button", { name: label })).toBeEnabled();
		}
		await expect(composer(page, "a")).toHaveAttribute("contenteditable", "false");
		await expect(composer(page, "b")).toHaveAttribute("contenteditable", "true");
		await rows(page, "a")
			.locator("button")
			.evaluateAll((buttons) => {
				for (const button of buttons) (button as HTMLButtonElement).click();
			});
		const calls = await page.evaluate(() => window.__agentQueueFixture.calls);
		expect(calls.guides).toHaveLength(0);
		expect(calls.deleted).toHaveLength(0);
		expect(calls.messages).toHaveLength(0);
		await page.evaluate(() => window.__agentQueueFixture.block("a", null));
		await expect(rows(page, "a").getByRole("button", { name: "Guide with queued message" })).toBeEnabled();
		await expect(composer(page, "a")).toHaveText("Keep pending-request draft");
		expect(errors).toEqual([]);
	});
}

test("an idle child with no backlog sends auto instead of creating a queued copy", async ({ page }) => {
	const errors = await open(page);
	await page.evaluate(() => window.__agentQueueFixture.setRunning("a", false));
	await expect(pane(page, "a").locator(".agent-conversation-state")).toHaveText("Completed");
	await composer(page, "a").fill("Start an idle child normally");
	await expect(pane(page, "a").getByRole("button", { name: "Send message", exact: true })).toBeEnabled();
	await composer(page, "a").press("Enter");
	await expect(pane(page, "a").locator(".agent-conversation-state")).toHaveText("Running");
	await expect(rows(page, "a")).toHaveCount(0);
	const calls = await page.evaluate(() => window.__agentQueueFixture.calls);
	expect(calls.messages).toHaveLength(1);
	expect(calls.messages[0].delivery).toBe("auto");
	expect(calls.guides).toHaveLength(0);
	expect(errors).toEqual([]);
});
