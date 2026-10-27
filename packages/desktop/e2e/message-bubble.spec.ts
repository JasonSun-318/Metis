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

test.beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "metis-message-bubble-"));
	await build({
		entryPoints: [path.join(__dirname, "message-bubble.fixture.tsx")],
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
		`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"><style>body{font-family:Inter,-apple-system,sans-serif}#root{height:100%}.fixture-grid{display:grid;grid-template-columns:repeat(var(--fixture-columns),minmax(0,1fr));gap:12px;padding:12px;height:100%}.fixture-conversation{min-width:0;height:100%;border:1px solid var(--border);background:var(--conversation-bg)}.fixture-header{flex:none;padding:10px 24px;border-bottom:1px solid var(--border);font-size:12px}</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`,
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

async function bubbleGeometry(page: Page) {
	return page.locator(".fixture-conversation").evaluateAll((panels) =>
		panels.map((panel) => {
			const bubbles = Array.from(panel.querySelectorAll<HTMLElement>(".message-user, .code-turn-user-bubble"));
			const long = bubbles[0]!;
			const short = bubbles[1]!;
			const paragraph = long.querySelector("p")!;
			const range = document.createRange();
			// Preserved line-end whitespace may hang outside the content box by design.
			// Measure visible characters, so padding is tested without mistaking whitespace for ink.
			const rects: DOMRect[] = [];
			const text = paragraph.firstChild as Text;
			for (let index = 0; index < text.length; index += 1) {
				if (/\s/.test(text.data[index]!)) continue;
				range.setStart(text, index);
				range.setEnd(text, index + 1);
				rects.push(...Array.from(range.getClientRects()));
			}
			const style = getComputedStyle(long);
			const bounds = long.getBoundingClientRect();
			const rightEdge = bounds.right - Number.parseFloat(style.paddingRight);
			const leftEdge = bounds.left + Number.parseFloat(style.paddingLeft);
			const row = long.parentElement!.getBoundingClientRect();
			const shortBounds = short.getBoundingClientRect();
			const pre = panel.querySelector<HTMLElement>("pre")!;
			const turns = panel.querySelectorAll<HTMLElement>(".transcript-turn, .code-transcript-turn");
			return {
				owner: panel.getAttribute("data-owner"),
				turnOverlap: turns[0]!.getBoundingClientRect().bottom - turns[1]!.getBoundingClientRect().top,
				text: paragraph.textContent,
				source: panel.getAttribute("data-source-text"),
				whiteSpace: getComputedStyle(paragraph).whiteSpace,
				overflow: long.scrollWidth - long.clientWidth,
				textOverflow: Math.max(0, ...rects.map((rect) => Math.max(rect.right - rightEdge, leftEdge - rect.left))),
				rightAlignment: Math.abs(bounds.right - row.right),
				shortRightAlignment: Math.abs(shortBounds.right - short.parentElement!.getBoundingClientRect().right),
				shortWidth: shortBounds.width,
				rowWidth: row.width,
				code: pre.textContent?.trimEnd(),
				codeSource: panel.getAttribute("data-code-line"),
				codeWhiteSpace: getComputedStyle(pre).whiteSpace,
				codeOverflowX: getComputedStyle(pre).overflowX,
				codeOverflow: pre.scrollWidth - pre.clientWidth,
				codeFont: getComputedStyle(pre.querySelector("code")!).fontFamily,
			};
		}),
	);
}

for (const mode of ["chat", "code"] as const)
	for (const theme of ["dark", "light"] as const) {
		test(`${mode} ${theme}: user text stays within main and agent bubbles while panes shrink`, async ({
			page,
		}, info) => {
			test.setTimeout(60_000);
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(error.message));
			const owners = mode === "code" ? ["main", "agent", "detail"] : ["main", "agent"];
			const viewportWidth = (width: number) => width * owners.length + 12 * (owners.length + 1);
			for (const font of [13, 20]) {
				await page.setViewportSize({ width: viewportWidth(900), height: 900 });
				await page.goto(`${url}/?mode=${mode}&theme=${theme}&font=${font}`);
				await expect(page.locator(".message-user, .code-turn-user-bubble")).toHaveCount(owners.length * 2);
				for (const width of [900, 520, 360, 320]) {
					await page.setViewportSize({ width: viewportWidth(width), height: 900 });
					await expect
						.poll(async () =>
							(await bubbleGeometry(page)).map((value) => ({
								owner: value.owner,
								overflow: value.overflow,
								textOverflow: Math.round(value.textOverflow),
							})),
						)
						.toEqual(owners.map((owner) => ({ owner, overflow: 0, textOverflow: 0 })));
					await expect
						.poll(async () => Math.max(...(await bubbleGeometry(page)).map((value) => value.turnOverlap)))
						.toBeLessThanOrEqual(1);
					for (const value of await bubbleGeometry(page)) {
						expect(value.text, `${value.owner}, ${width}px`).toBe(value.source);
						expect(value.whiteSpace).toBe("pre-wrap");
						expect(value.rightAlignment).toBeLessThanOrEqual(1);
						expect(value.shortRightAlignment).toBeLessThanOrEqual(1);
						expect(value.shortWidth).toBeLessThan(value.rowWidth / 2);
						expect(value.code).toBe(value.codeSource);
						expect(value.codeWhiteSpace).toBe("pre");
						expect(value.codeOverflowX).toBe("auto");
						expect(value.codeOverflow).toBeGreaterThan(0);
						expect(value.codeFont).toContain("monospace");
					}
					if (width === 360) {
						for (const owner of owners) {
							const panel = page.locator(`[data-owner="${owner}"]`);
							const user = panel.locator("[data-user-message]").first();
							await user.hover();
							await user.locator(".turn-copy-button").click();
							await expect(panel).toHaveAttribute(
								"data-copied-text",
								(await panel.getAttribute("data-source-text"))!,
							);
						}
					}
					if (font === 20 && width === 360)
						await page.screenshot({
							path: info.outputPath(`${mode}-${theme}-360px.png`),
							animations: "disabled",
						});
				}
			}
			expect(errors).toEqual([]);
		});
	}
