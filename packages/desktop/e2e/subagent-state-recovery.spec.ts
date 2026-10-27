import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";
import type { RecoveryFixture } from "./subagent-state-recovery.types.ts";

declare global {
	interface Window {
		__recoveryFixture: RecoveryFixture;
	}
}

test.use({ channel: "chrome" });
let directory: string;
let server: Server;
let url: string;

test.beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "metis-subagent-recovery-"));
	await build({
		entryPoints: [path.join(__dirname, "subagent-state-recovery.fixture.tsx")],
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
			contents: ["tokens.css", "app.css"]
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
		`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>.recovery-layout{height:100vh;display:flex}.recovery-sidebar{width:260px;flex:none;background:var(--sidebar-bg);padding:18px 8px}.recovery-pane{display:flex;flex:1;min-width:0;min-height:0}.recovery-sidebar .session-row{position:relative}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`,
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
	if (!address || typeof address === "string") throw new Error("Recovery fixture failed to bind");
	url = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	if (directory) await rm(directory, { recursive: true, force: true });
});

for (const recovery of ["same epoch", "new epoch", "visible again"] as const) {
	test(`${recovery} recovers missed completion without losing the draft or scroll`, async ({ page }, testInfo) => {
		const errors: string[] = [];
		page.on("pageerror", (error) => errors.push(error.message));
		await page.setViewportSize({ width: 1200, height: 820 });
		await page.goto(`${url}/?${recovery === "visible again" ? "reduced" : ""}`);
		const composer = page.locator('[id^="agent-composer-"]');
		const status = page.locator(".agent-conversation-state");
		const child = page.getByRole("button", { name: "Recovery worker", exact: true });
		await expect(status).toHaveText("Completed");
		await expect(child).toHaveAttribute("title", "Recovery worker · Completed");
		await composer.fill("Continue the completed worker");
		await composer.press("Enter");
		await expect(status).toHaveText("Running");
		await expect(child).toHaveAttribute("aria-busy", "true");
		await expect(page.locator(".turn-runtime-status")).toBeVisible();
		await composer.fill("Keep this unsent follow-up draft");
		const scroll = page.locator(".transcript-scroll");
		await page.evaluate(() => document.fonts.ready);
		await scroll.hover();
		await page.mouse.wheel(0, -900);
		await expect
			.poll(() => scroll.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight))
			.toBeGreaterThan(48);
		const before = await scroll.evaluate(async (element) => {
			element.scrollTop = 400;
			let previous = "";
			let stable = 0;
			for (let frame = 0; frame < 60 && stable < 4; frame += 1) {
				await new Promise(requestAnimationFrame);
				const geometry = `${element.scrollTop}:${element.scrollHeight}:${element.clientHeight}`;
				stable = geometry === previous ? stable + 1 : 0;
				previous = geometry;
			}
			if (stable < 4) throw new Error("Virtual history did not settle before recovery");
			return element.scrollTop;
		});
		expect(before).toBeGreaterThan(200);
		expect(
			await scroll.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight),
		).toBeGreaterThan(48);
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
		const callsBefore = await page.evaluate(() => ({ ...window.__recoveryFixture.calls }));
		await page.evaluate((mode) => {
			window.__recoveryFixture.rememberNodes();
			if (mode === "visible again") window.__recoveryFixture.setVisible(false);
			else window.__recoveryFixture.disconnect();
			window.__recoveryFixture.completeWithoutEvents();
		}, recovery);
		// No terminal notification is delivered: the stale state must survive until recovery.
		await expect(status).toHaveText("Running");
		await expect(child).toHaveAttribute("aria-busy", "true");
		await page.evaluate((mode) => {
			if (mode === "visible again") window.__recoveryFixture.setVisible(true);
			else window.__recoveryFixture.ready(mode === "new epoch");
		}, recovery);
		await expect(status).toHaveText("Completed");
		await expect(child).toHaveAttribute("title", "Recovery worker · Completed");
		await expect(child).not.toHaveAttribute("aria-busy", "true");
		await expect(composer).toHaveText("Keep this unsent follow-up draft");
		expect(await page.evaluate(() => window.__recoveryFixture.nodesPreserved())).toBe(true);
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
			const filename = testInfo.outputPath("scroll-diagnosis.json");
			await writeFile(filename, JSON.stringify(diagnostic, null, 2));
			await testInfo.attach("scroll-diagnosis", { path: filename, contentType: "application/json" });
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
		const callsAfter = await page.evaluate(() => ({ ...window.__recoveryFixture.calls }));
		expect(callsAfter.catalog).toBeGreaterThan(callsBefore.catalog);
		expect(callsAfter.history).toBeGreaterThan(callsBefore.history);
		expect(callsAfter.sent).toBe(1);
		await scroll.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		await expect(page.getByText("Recovered durable reply", { exact: true })).toBeVisible();
		await expect(page.locator(".turn-runtime-status")).toHaveCount(0);
		await expect(page.getByRole("button", { name: "Stop agent", exact: true })).toHaveCount(0);
		await page.screenshot({ path: testInfo.outputPath("recovered-child-conversation.png"), animations: "disabled" });
		expect(errors).toEqual([]);
	});
}
