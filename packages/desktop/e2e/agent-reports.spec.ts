import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { build } from "esbuild";

test.use({ channel: "chrome" });
let server: Server;
let directory: string;
let url: string;

test.beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "metis-agent-reports-"));
	await build({
		entryPoints: [path.join(__dirname, "agent-reports.fixture.tsx")],
		bundle: true,
		format: "esm",
		jsx: "automatic",
		platform: "browser",
		target: "es2022",
		outfile: path.join(directory, "fixture.js"),
	});
	await build({
		stdin: {
			contents: ["tokens.css", "app.css", "agent-conversations.css", "markdown.css", "markdown-embeds.css"]
				.map((file) => `@import "${path.resolve(__dirname, "../src/renderer/styles", file)}";`)
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
		'<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>body{font-family:Inter,-apple-system,sans-serif}#root{height:100%}.fixture-conversation{height:100%;background:var(--conversation-bg)}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>',
	);
	server = createServer((request, response) => {
		const file = path.basename(new URL(request.url ?? "/", "http://localhost").pathname) || "index.html";
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

for (const mode of ["chat", "code"] as const)
	for (const theme of ["dark", "light"] as const)
		test(`${mode} ${theme}: subagent reports remain readable and open the correct conversation`, async ({
			page,
		}, info) => {
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			for (const width of [1000, 360]) {
				await page.setViewportSize({ width, height: 1000 });
				await page.goto(`${url}/?mode=${mode}&theme=${theme}`);
				const reports = page.locator(".agent-report-message");
				await expect(reports).toHaveCount(5);
				const tree = page.locator('[data-agent-report="tree"]');
				const code = await tree.locator("pre").evaluate((pre) => {
					const bubble = pre.closest(".agent-report-body")!;
					const bounds = pre.getBoundingClientRect();
					const parent = bubble.getBoundingClientRect();
					return {
						outside: Math.max(0, bounds.right - parent.right, parent.left - bounds.left),
						bubbleOverflow: bubble.scrollWidth - bubble.clientWidth,
						overflowX: getComputedStyle(pre).overflowX,
						whiteSpace: getComputedStyle(pre).whiteSpace,
						hiddenContent: pre.scrollWidth - pre.clientWidth,
					};
				});
				expect(code.outside).toBe(0);
				expect(code.bubbleOverflow).toBe(0);
				expect(code.overflowX).toBe("auto");
				expect(code.whiteSpace).toBe("pre");
				expect(code.hiddenContent).toBeGreaterThan(0);
				expect(await tree.locator("code").textContent()).toBe(
					await page.locator("main").getAttribute("data-code-tree"),
				);
				await tree.locator("pre").evaluate((pre) => {
					pre.scrollLeft = pre.scrollWidth;
				});
				expect(await tree.locator("pre").evaluate((pre) => pre.scrollLeft)).toBeGreaterThan(0);
				const tailVisible = await tree.locator("pre").evaluate((pre) => {
					const text = pre.querySelector("code")!.firstChild as Text;
					const range = document.createRange();
					range.setStart(text, text.length - "END_OF_TREE".length);
					range.setEnd(text, text.length);
					const tail = range.getBoundingClientRect();
					const bounds = pre.getBoundingClientRect();
					return tail.left >= bounds.left && tail.right <= bounds.right;
				});
				expect(tailVisible).toBe(true);
				const parentSource = page.locator('[data-user-message="instruction"] .message-origin');
				await expect(parentSource).toHaveText("来自主代理");
				await parentSource.getByRole("button").click();
				await expect(page.locator("main")).toHaveAttribute(
					"data-opened",
					"parent:11111111-1111-4111-8111-111111111111",
				);
				await expect(reports.first()).toContainText("来自子代理");
				await expect(reports.first()).toContainText("Trash read-only inventory");
				await expect(reports.first().locator("strong")).toHaveText("没有修改任何文件");
				await expect(page.locator('[data-agent-report="failure"]')).toContainText("子代理执行失败");
				await expect(page.locator(".transcript")).not.toContainText("Hidden intervention receipt");
				await expect(page.locator("[data-user-message]")).toHaveCount(3);
				for (const [reportId, userId] of [
					["short", "user"],
					["emoji", "user-emoji"],
				]) {
					const geometry = await page.locator(`[data-agent-report="${reportId}"]`).evaluate((row, id) => {
						const bubble = row.querySelector<HTMLElement>(".agent-report-body")!;
						const user = document.querySelector<HTMLElement>(
							`[data-user-message="${id}"] > .message-user, [data-user-message="${id}"] > .code-turn-user-bubble`,
						)!;
						const heading = row.querySelector<HTMLElement>(".message-origin")!;
						const appearance = (element: HTMLElement) => {
							const style = getComputedStyle(element);
							const paragraph = getComputedStyle(element.querySelector("p")!);
							const bounds = element.getBoundingClientRect();
							return {
								width: bounds.width,
								height: bounds.height,
								background: style.backgroundColor,
								color: style.color,
								border: style.border,
								radius: style.borderRadius,
								padding: style.padding,
								shadow: style.boxShadow,
								font: paragraph.font,
								letterSpacing: paragraph.letterSpacing,
							};
						};
						return {
							report: appearance(bubble),
							user: appearance(user),
							gap: bubble.getBoundingClientRect().top - heading.getBoundingClientRect().bottom,
							rightAlignment: Math.abs(bubble.getBoundingClientRect().right - row.getBoundingClientRect().right),
							widthRatio: bubble.getBoundingClientRect().width / row.getBoundingClientRect().width,
						};
					}, userId);
					expect(geometry.report).toEqual(geometry.user);
					expect(geometry.gap).toBeGreaterThanOrEqual(4);
					expect(geometry.gap).toBeLessThanOrEqual(10);
					expect(geometry.rightAlignment).toBeLessThanOrEqual(1);
					expect(geometry.widthRatio).toBeLessThan(0.5);
				}
				const bounds = await page.locator(".transcript").evaluate((element) => ({
					overflow: element.scrollWidth - element.clientWidth,
					reports: Array.from(element.querySelectorAll<HTMLElement>(".agent-report-message")).map(
						(report) => report.scrollWidth - report.clientWidth,
					),
				}));
				expect(bounds.overflow).toBe(0);
				expect(bounds.reports).toEqual([0, 0, 0, 0, 0]);
				await reports.first().getByRole("button").click();
				await expect(page.locator("main")).toHaveAttribute(
					"data-opened",
					"22222222-2222-4222-8222-222222222222:Trash read-only inventory",
				);
				await page.screenshot({ path: info.outputPath(`${mode}-${theme}-${width}.png`), animations: "disabled" });
				await tree.scrollIntoViewIfNeeded();
				await tree.locator("pre").evaluate((pre) => {
					pre.scrollLeft = 0;
				});
				await tree.screenshot({
					path: info.outputPath(`${mode}-${theme}-${width}-tree.png`),
					animations: "disabled",
				});
				await parentSource.screenshot({
					path: info.outputPath(`${mode}-${theme}-${width}-parent.png`),
					animations: "disabled",
				});
			}
			expect(errors).toEqual([]);
		});
