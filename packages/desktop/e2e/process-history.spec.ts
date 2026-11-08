import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";

test.use({ channel: "chrome", timezoneId: "UTC" });
let server: Server;
let directory: string;
let url: string;
test.beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "metis-process-ui-"));
	await build({
		entryPoints: [path.join(__dirname, "process-history.fixture.tsx")],
		bundle: true,
		format: "esm",
		jsx: "automatic",
		platform: "browser",
		outfile: path.join(directory, "fixture.js"),
	});
	await build({
		stdin: {
			contents: ["tokens.css", "app.css"]
				.map((file) => `@import "${path.resolve(__dirname, "../src/renderer/styles", file)}";`)
				.join("\n"),
			loader: "css",
			resolveDir: directory,
		},
		bundle: true,
		loader: { ".woff": "file", ".woff2": "file", ".ttf": "file", ".svg": "file" },
		outfile: path.join(directory, "app.css"),
	});
	await writeFile(
		path.join(directory, "index.html"),
		'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/fixture.css"><style>body{background:var(--sidebar);color:var(--text);font-family:system-ui}#root{width:100%}.fixture-toolbar{display:flex;gap:8px;padding:12px}.fixture-toolbar button{font:inherit;font-size:12px}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
	);
	server = createServer((request, response) => {
		const file = path.basename(request.url?.split("?")[0] ?? "") || "index.html";
		response.setHeader(
			"Content-Type",
			file.endsWith("js") ? "text/javascript" : file.endsWith("css") ? "text/css" : "text/html",
		);
		createReadStream(path.join(directory, file))
			.on("error", () => response.destroy())
			.pipe(response);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw Error("Missing fixture port");
	url = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	if (directory) await rm(directory, { recursive: true, force: true });
});

for (const theme of ["dark", "light"])
	test(`process ${theme}: continuous track, pinned history, live output and compact layout`, async ({
		page,
	}, info) => {
		await page.setViewportSize({ width: 420, height: 720 });
		await page.goto(`${url}?theme=${theme}`);
		await expect(page.locator(".process-history-position")).toHaveText("2/2");
		await expect(page.getByRole("tabpanel", { name: "操作记录" })).toBeVisible();
		await expect(page.locator(".process-statusbar output")).toHaveText("命令已完成");
		await expect(page.getByRole("button", { name: "复制输出" })).toHaveCount(0);
		const commandInset = await page.locator(".process-command").evaluate((command) => {
			const panel = command.closest(".process-panel")!;
			return command.getBoundingClientRect().top - panel.getBoundingClientRect().top;
		});
		expect(commandInset).toBeCloseTo(12);
		const controls = (await page.locator(".process-history-controls").boundingBox())!;
		const status = (await page.locator(".process-statusbar").boundingBox())!;
		expect(status.y).toBeGreaterThanOrEqual(controls.y + controls.height);
		const slider = page.getByRole("slider", { name: "操作记录进度" });
		await expect(page.locator(".process-history-date")).toHaveText("10月12日 13:24:56");
		await expect(page.locator(".process-history-date")).not.toBeVisible();
		await expect(page.locator(".process-live")).toHaveText("实时");
		await expect(page.locator(".process-return-live")).toHaveCount(0);
		await expect(page.locator(".process-history-position")).toHaveClass(/sr-only/);
		const fill = page.locator(".process-history-rail > span");
		await expect(fill).toHaveCSS("background-color", "rgb(35, 155, 255)");
		const rect = (await slider.boundingBox())!;
		await page.mouse.click(rect.x + rect.width * 0.25, rect.y + rect.height / 2);
		await expect(page.locator(".process-command")).toContainText("first");
		await expect(page.locator(".process-history-date")).toHaveText("10月11日 12:00:00");
		await expect(page.locator(".process-history-date")).not.toBeVisible();
		await expect(slider).toHaveAttribute("aria-valuetext", /第 1 条命令，共 2 条/);
		const returnButton = (await page.getByRole("button", { name: "返回实时", exact: true }).boundingBox())!;
		expect(returnButton.y + returnButton.height).toBeLessThan(controls.y);
		expect(Math.abs(returnButton.x + returnButton.width / 2 - 210)).toBeLessThan(1);
		await expect(page.locator(".process-live")).toHaveText("实时");
		const rail = (await page.locator(".process-history-rail").boundingBox())!;
		expect((await fill.boundingBox())!.width).toBeGreaterThan(0);
		expect((await fill.boundingBox())!.width).toBeLessThan(rail.width / 2);
		await page.screenshot({
			path: info.outputPath(`process-${theme}-controls.png`),
			clip: { x: 0, y: returnButton.y - 12, width: 420, height: status.y + status.height - returnButton.y + 12 },
		});
		await page.mouse.click(rect.x + rect.width * 0.75, rect.y + rect.height / 2);
		await expect(page.locator(".process-command")).toContainText("second");
		await page.mouse.move(rect.x + rect.width * 0.75, rect.y + rect.height / 2);
		await page.mouse.down();
		await page.mouse.move(rect.x + rect.width * 0.25, rect.y + rect.height / 2, { steps: 20 });
		await expect(page.locator(".process-history-date")).toBeVisible();
		await expect(page.locator(".process-history-date")).toHaveText("10月11日 12:00:00");
		await page.screenshot({ path: info.outputPath(`process-${theme}-drag-date.png`) });
		await page.mouse.up();
		await expect(page.locator(".process-history-date")).not.toBeVisible();
		await expect(page.locator(".process-command")).toContainText("first");
		await slider.press("Home");
		await expect(page.locator(".process-history-position")).toHaveText("1/2");
		await expect(page.locator(".process-history-date")).not.toBeVisible();
		await page.getByRole("button", { name: "New command", exact: true }).click();
		await expect(page.locator(".process-history-position")).toHaveText("1/3");
		await expect(page.locator(".process-command")).toContainText("first");
		await page.screenshot({ path: info.outputPath(`process-${theme}-history.png`) });
		await page.getByRole("button", { name: "返回实时" }).click();
		await expect(page.locator(".process-command")).toContainText("echo live");
		await expect(page.locator(".process-history-position")).toHaveText("3/3");
		await expect(page.locator(".process-history-date")).not.toBeVisible();
		await expect(page.locator(".process-history-date")).toHaveText("11月6日 12:00:00");
		await expect(page.locator(".process-return-live")).toHaveCount(0);
		await expect(page.locator(".process-statusbar output")).toHaveText("运行中");
		const reads = await page.locator("body").getAttribute("data-reads");
		await page.getByRole("button", { name: "More output" }).click();
		await expect(page.locator(".process-output")).toContainText("more");
		expect(await page.locator("body").getAttribute("data-reads")).toBe(reads);
		await page.getByRole("button", { name: "Toggle panel" }).click();
		await page.getByRole("button", { name: "New command", exact: true }).click();
		expect(await page.locator("body").getAttribute("data-reads")).toBe(reads);
		await expect(page.locator(".xterm")).toHaveCount(0);
		await page.getByRole("button", { name: "Toggle panel" }).click();
		await expect(page.locator(".process-history-position")).toHaveText("4/4");
		await page.setViewportSize({ width: 280, height: 720 });
		const bounds = await page
			.locator(".process-history-controls")
			.evaluate((node) => ({ width: node.clientWidth, scroll: node.scrollWidth }));
		expect(bounds.scroll).toBeLessThanOrEqual(bounds.width);
		await page.screenshot({ path: info.outputPath(`process-${theme}-narrow-live.png`) });
		await slider.press("Home");
		await expect(page.locator(".process-history-date")).toHaveText("10月11日 12:00:00");
		const compactReturn = (await page.locator(".process-return-live").boundingBox())!;
		expect(compactReturn.x).toBeGreaterThanOrEqual(0);
		expect(compactReturn.x + compactReturn.width).toBeLessThanOrEqual(280);
		await page.screenshot({ path: info.outputPath(`process-${theme}-narrow-history.png`) });
	});
test("long history renders a single command body", async ({ page }) => {
	await page.goto(`${url}?count=5000`);
	await expect(page.locator(".process-history-position")).toHaveText("5000/5000");
	await expect(page.locator(".xterm")).toHaveCount(1);
	await expect(page.locator(".process-command")).toHaveCount(1);
	expect(await page.locator("body").getAttribute("data-reads")).toBe("1");
	await page.getByRole("slider").press("Home");
	await expect(page.locator(".process-history-position")).toHaveText("1/5000");
	await expect(page.locator(".process-command")).toContainText("first");
});

test("live stays at the right endpoint on a continuous track", async ({ page }) => {
	await page.goto(`${url}?count=11`);
	await expect(page.locator(".process-history-position")).toHaveText("11/11");
	const slider = page.getByRole("slider");
	await expect(slider).toHaveJSProperty("value", "11000");
	await expect(slider).toHaveCSS("background-image", "none");
	await page.getByRole("button", { name: "New command", exact: true }).click();
	await expect(slider).toHaveJSProperty("value", "12000");
	await slider.press("Home");
	await expect(slider).toHaveJSProperty("value", "0");
	await slider.press("ArrowRight");
	await expect(page.locator(".process-history-position")).toHaveText("2/12");
	await slider.press("End");
	await expect(slider).toHaveJSProperty("value", "12000");
	await expect(page.locator(".process-live")).toBeDisabled();
});

test("dragging follows the pointer within a command and across delayed history reads", async ({ page }, info) => {
	await page.setViewportSize({ width: 600, height: 720 });
	await page.goto(`${url}?delay`);
	await expect(page.locator(".process-history-position")).toHaveText("2/2");
	const slider = page.getByRole("slider");
	let rect = (await slider.boundingBox())!;
	const liveWidth = rect.width;
	await page.mouse.click(rect.x + rect.width * 0.18, rect.y + rect.height / 2);
	await expect(page.locator(".process-command")).toContainText("first");
	await expect(page.locator("body")).toHaveAttribute("data-pending-reads", "0");
	const reads = await page.locator("body").getAttribute("data-reads");
	rect = (await slider.boundingBox())!;
	expect(rect.width).toBe(liveWidth);
	const value = () => slider.evaluate((node: HTMLInputElement) => Number(node.value));
	await page.mouse.move(rect.x + 5 + ((rect.width - 10) * (await value())) / 2000, rect.y + rect.height / 2);
	await expect(page.locator(".process-history-date")).not.toBeVisible();
	await page.mouse.down();
	await expect(page.locator(".process-history-date")).toBeVisible();
	const positions: number[] = [];
	const datePositions: number[] = [];
	for (const fraction of [0.26, 0.34, 0.42]) {
		await page.mouse.move(rect.x + 5 + (rect.width - 10) * fraction, rect.y + rect.height / 2);
		positions.push(await value());
		datePositions.push((await page.locator(".process-history-date").boundingBox())!.x);
	}
	expect(positions[1]! - positions[0]!).toBeGreaterThan(100);
	expect(positions[2]! - positions[1]!).toBeGreaterThan(100);
	expect(datePositions[1]! - datePositions[0]!).toBeGreaterThan(20);
	expect(datePositions[2]! - datePositions[1]!).toBeGreaterThan(20);
	expect(await page.locator("body").getAttribute("data-reads")).toBe(reads);
	await page.mouse.move(rect.x + rect.width * 0.65, rect.y + rect.height / 2);
	await expect(page.locator(".process-history-date")).not.toBeVisible();
	await expect(page.locator(".process-history-date")).toHaveText("10月12日 13:24:56");
	await expect(page.locator(".process-history-date")).toBeVisible();
	await page.screenshot({ path: info.outputPath("drag-current-command-time.png") });
	await page.mouse.move(rect.x + rect.width * 0.38, rect.y + rect.height / 2);
	// Releasing outside the control must also hide the date without changing the selected position.
	await page.mouse.move(rect.x + rect.width * 0.38, rect.y - 100);
	await page.mouse.up();
	await expect(page.locator(".process-history-date")).not.toBeVisible();
	const released = await value();
	await expect(page.locator(".process-command")).toContainText("first");
	await expect(page.locator("body")).toHaveAttribute("data-pending-reads", "0");
	expect(await value()).toBe(released);
	await page.screenshot({ path: info.outputPath("continuous-drag-history.png") });
	await page.mouse.click(rect.x + rect.width - 1, rect.y + rect.height / 2);
	await expect(page.locator(".process-live")).toBeDisabled();
	await expect(slider).toHaveJSProperty("value", "2000");
});

for (const theme of ["dark", "light"])
	test(`navigation icons stay compact and centered in ${theme}`, async ({ page }, info) => {
		for (const width of [320, 820]) {
			await page.setViewportSize({ width, height: 720 });
			await page.goto(`${url}?theme=${theme}`);
			await expect(page.locator(".process-history-position")).toHaveText("2/2");
			const rail = (await page.locator(".process-history-rail").boundingBox())!;
			const slider = (await page.getByRole("slider").boundingBox())!;
			expect(Math.abs(rail.y + rail.height / 2 - slider.y - slider.height / 2)).toBeLessThan(0.5);
			for (const label of ["上一条命令", "下一条命令"]) {
				const button = page.getByRole("button", { name: label });
				const hit = (await button.boundingBox())!;
				const icon = (await button.locator("svg").boundingBox())!;
				expect(icon.width).toBe(14);
				expect(icon.height).toBe(14);
				expect(hit.width).toBeGreaterThanOrEqual(28);
				expect(hit.height).toBeGreaterThanOrEqual(28);
				expect(Math.abs(icon.y + icon.height / 2 - rail.y - rail.height / 2)).toBeLessThan(0.5);
			}
			await page.screenshot({
				path: info.outputPath(`controls-${theme}-${width}.png`),
				clip: { x: 0, y: 530, width, height: 140 },
			});
			await page.mouse.move(slider.x + slider.width - 6, slider.y + slider.height / 2);
			await page.mouse.down();
			for (const fraction of [0, 0.5, 1]) {
				await page.mouse.move(slider.x + 6 + (slider.width - 12) * fraction, slider.y + slider.height / 2);
				const date = page.locator(".process-history-date");
				await expect(date).toBeVisible();
				const bubble = (await date.boundingBox())!;
				expect(bubble.x).toBeGreaterThanOrEqual(slider.x);
				expect(bubble.x + bubble.width).toBeLessThanOrEqual(slider.x + slider.width);
				if (fraction === 0.5) {
					expect(Math.abs(bubble.x + bubble.width / 2 - slider.x - slider.width / 2)).toBeLessThan(1);
				}
			}
			await page.mouse.up();
			await expect(page.locator(".process-history-date")).not.toBeVisible();
		}
	});

test("reads each selected command once and reuses the terminal while scrubbing", async ({ page }) => {
	await page.goto(`${url}?count=5000`);
	await expect(page.locator(".process-history-position")).toHaveText("5000/5000");
	const terminal = await page.locator(".process-output .xterm").elementHandle();
	for (let index = 4999; index >= 4995; index--) {
		await page.getByRole("button", { name: "上一条命令" }).click();
		await expect(page.locator(".process-history-position")).toHaveText(`${index}/5000`);
		await expect(page.locator(".process-history-date")).not.toBeVisible();
		await expect(page.locator("body")).toHaveAttribute("data-pending-reads", "0");
	}
	expect(await page.locator("body").getAttribute("data-reads")).toBe("6");
	expect(await terminal!.evaluate((node) => node.isConnected)).toBe(true);
	const output = page.locator(".xterm-accessibility-tree");
	await expect(output).toContainText("4994");
	await page.getByRole("slider").press("Home");
	await expect(output).toContainText("first");
	await expect(output).not.toContainText("second");
	await page.getByRole("button", { name: "下一条命令" }).click();
	await expect(output).toContainText("second");
	await expect(output).not.toContainText("first");
	expect(await terminal!.evaluate((node) => node.isConnected)).toBe(true);
});

test("rapid dragging keeps only one request in flight and settles on the final position", async ({ page }) => {
	await page.setViewportSize({ width: 820, height: 720 });
	await page.goto(`${url}?count=5000&delay=600`);
	await expect(page.locator(".process-history-position")).toHaveText("5000/5000");
	const slider = page.getByRole("slider");
	const rect = (await slider.boundingBox())!;
	await page.mouse.move(rect.x + rect.width - 6, rect.y + rect.height / 2);
	await page.mouse.down();
	await page.mouse.move(rect.x + 6, rect.y + rect.height / 2, { steps: 30 });
	await page.mouse.up();
	const position = Number(await slider.inputValue());
	const selected = Math.floor(position / 1000);
	expect(position).toBeLessThan(100000);
	await expect(page.locator("body")).toHaveAttribute("data-pending-reads", "0");
	await expect(page.locator(".process-history-position")).toHaveText(`${selected + 1}/5000`);
	await expect(page.locator(".xterm-accessibility-tree")).toContainText(selected === 0 ? "first" : String(selected));
	await expect(page.locator("body")).toHaveAttribute("data-peak-pending-reads", "1");
	expect(Number(await page.locator("body").getAttribute("data-reads"))).toBeLessThan(8);
	await expect(page.locator(".xterm")).toHaveCount(1);
	await expect(page.locator(".process-history-date")).not.toBeVisible();
});
