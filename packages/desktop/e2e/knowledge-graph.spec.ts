import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { build } from "esbuild";

test.use({ channel: "chrome" });
test.describe.configure({ mode: "serial" });
let server: Server;
let directory: string;
let url: string;

async function settle(page: Page, timeout = 10_000) {
	let previous = "";
	let stable = 0;
	await expect
		.poll(
			async () => {
				const current = await page.locator(".knowledge-node").first().getAttribute("transform");
				stable = current === previous ? stable + 1 : 0;
				previous = current ?? "";
				return stable;
			},
			{ intervals: [200], timeout },
		)
		.toBeGreaterThanOrEqual(2);
}

function errorsOn(page: Page) {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});
	return errors;
}

test.beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "metis-force-graph-"));
	await build({
		entryPoints: [path.join(__dirname, "knowledge-graph.fixture.tsx")],
		bundle: true,
		format: "esm",
		jsx: "automatic",
		platform: "browser",
		target: "es2022",
		outfile: path.join(directory, "fixture.js"),
	});
	await build({
		stdin: {
			contents: ["tokens.css", "app.css", "knowledge.css"]
				.map(
					(file) => `@import "${path.resolve(__dirname, "../src/renderer/styles", file).replaceAll("\\", "/")}";`,
				)
				.join("\n"),
			loader: "css",
			resolveDir: directory,
		},
		bundle: true,
		outfile: path.join(directory, "fixture.css"),
	});
	await writeFile(
		path.join(directory, "index.html"),
		`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>body{padding:12px;font-family:Arial,sans-serif}#root{width:100%;height:100%;max-width:920px;margin:auto;border:1px solid var(--border);border-radius:10px;overflow:hidden}.knowledge-toolbar{justify-content:space-between;font-size:12px}.knowledge-toolbar button{padding:4px}output{display:none}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`,
	);
	server = createServer((request, response) => {
		const name = new URL(request.url ?? "/", "http://localhost").pathname;
		const file = new Map([
			["/", "index.html"],
			["/fixture.js", "fixture.js"],
			["/fixture.css", "fixture.css"],
		]).get(name);
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
	if (!address || typeof address === "string") throw new Error("Fixture server did not start");
	url = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	if (directory) await rm(directory, { force: true, recursive: true });
});

test("native node capture pulls linked notes, avoids accidental opening, and still permits clicking", async ({
	page,
}, info) => {
	const errors = errorsOn(page);
	await page.setViewportSize({ width: 460, height: 780 });
	await page.goto(url);
	await settle(page);
	const node = page.locator('[data-knowledge-path="主题/笔记0.md"]');
	const other = page.locator('[data-knowledge-path="主题/笔记1.md"]');
	const before = await other.getAttribute("transform");
	const box = await node.locator(".knowledge-node-dot").boundingBox();
	if (!box) throw new Error("Missing graph node");
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width / 2 + 110, box.y + box.height / 2 + 50, { steps: 8 });
	await expect.poll(() => other.getAttribute("transform")).not.toBe(before);
	await page.screenshot({ path: info.outputPath("node-drag-dark.png") });
	await page.mouse.up();
	await expect(page.locator("[data-opened-note]")).toHaveText("");
	await settle(page);
	await node.locator(".knowledge-node-dot").click();
	await expect(page.locator("[data-opened-note]")).toHaveText("主题/笔记0.md");
	expect(errors).toEqual([]);
});

test("wheel zoom and background pan remain responsive and refresh preserves positions", async ({ page }) => {
	const errors = errorsOn(page);
	await page.setViewportSize({ width: 520, height: 700 });
	await page.goto(url);
	await settle(page);
	const viewport = page.locator(".knowledge-graph-viewport");
	const node = page.locator(".knowledge-node").first();
	const before = await node.getAttribute("transform");
	const camera = await viewport.getAttribute("transform");
	await page.mouse.move(35, 110);
	await page.mouse.down();
	await page.mouse.move(80, 160, { steps: 8 });
	await page.mouse.up();
	await expect(viewport).not.toHaveAttribute("transform", camera!);
	const panned = await viewport.getAttribute("transform");
	await page.mouse.wheel(0, -100);
	await expect(viewport).not.toHaveAttribute("transform", panned!);
	await page.getByRole("button", { name: "Refresh", exact: true }).click();
	await expect(node).toHaveAttribute("transform", before!);
	expect(errors).toEqual([]);
});

for (const theme of ["dark", "light"]) {
	test(`${theme} fits narrow/tall and wide/short panels with no clipped nodes`, async ({ page }, info) => {
		const errors = errorsOn(page);
		await page.setViewportSize({ width: 304, height: 820 });
		await page.goto(`${url}/?theme=${theme}`);
		await settle(page);
		for (const size of [
			{ width: 304, height: 820 },
			{ width: 960, height: 320 },
		]) {
			await page.setViewportSize(size);
			await page.getByRole("button", { name: "Reset view" }).click();
			const bounds = await page.locator(".knowledge-graph-canvas").boundingBox();
			if (!bounds) throw new Error("Missing canvas");
			const viewBox = await page.locator(".knowledge-graph-canvas").getAttribute("viewBox");
			const [, , width, height] = viewBox!.split(" ").map(Number);
			expect(width).toBeCloseTo(bounds.width);
			expect(height).toBeCloseTo(bounds.height);
			for (const dot of await page.locator(".knowledge-node-dot").all()) {
				const box = await dot.boundingBox();
				if (!box) throw new Error("Missing node bounds");
				expect(box.x).toBeGreaterThanOrEqual(bounds.x);
				expect(box.y).toBeGreaterThanOrEqual(bounds.y);
				expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
				expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height);
			}
			const labels = await page.locator('.knowledge-node text[opacity="1"]').all();
			expect(labels.length).toBeGreaterThan(0);
			const labelBoxes = await Promise.all(labels.map((label) => label.boundingBox()));
			for (let index = 0; index < labelBoxes.length; index++) {
				const box = labelBoxes[index]!;
				expect(box.x).toBeGreaterThanOrEqual(bounds.x);
				expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
				for (const other of labelBoxes.slice(index + 1)) {
					if (!other) throw new Error("Missing label bounds");
					const intersects =
						box.x < other.x + other.width &&
						box.x + box.width > other.x &&
						box.y < other.y + other.height &&
						box.y + box.height > other.y;
					expect(intersects).toBe(false);
				}
			}
			await page.screenshot({ path: info.outputPath(`fit-${theme}-${size.width}x${size.height}.png`) });
		}
		expect(errors).toEqual([]);
	});
}

test("one thousand notes keep controls usable and labels out of the crowded overview", async ({ page }, info) => {
	const errors = errorsOn(page);
	await page.setViewportSize({ width: 520, height: 780 });
	await page.goto(`${url}/?count=1000`);
	await expect(page.locator(".knowledge-node")).toHaveCount(1000);
	await expect(page.locator(".knowledge-node text")).toHaveCount(0);
	// Controls must work while the large simulation is still running.
	await page.getByRole("button", { name: "Zoom in", exact: true }).click({ timeout: 1500 });
	await page.getByRole("button", { name: "Reset view" }).click({ timeout: 1500 });
	await settle(page, 20_000);
	await page.screenshot({ path: info.outputPath("1000-notes.png") });
	expect(errors).toEqual([]);
});
