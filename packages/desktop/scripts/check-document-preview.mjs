// Usage: node packages/desktop/scripts/check-document-preview.mjs sample.pdf sample.pptx
// Exercises real renderers in isolated Chromium, without launching or controlling Metis.
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { build } from "esbuild";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(desktop, "../..");
const [pdf, pptx] = process.argv.slice(2);
assert(pdf && pptx, "Pass a valid PDF and PPTX sample path.");
const directory = await mkdtemp(join(tmpdir(), "metis-preview-"));
const component = (name) => JSON.stringify(join(desktop, "src/renderer/components/preview", name));
const bundle = join(directory, "fixture.js");
await build({
	stdin: {
		contents: `
import React from 'react'; import {createRoot} from 'react-dom/client';
import {PdfViewer} from ${component("PdfViewer.tsx")};
import {PptxViewer} from ${component("PptxViewer.tsx")};
import {PreviewFrame} from ${component("PreviewFrame.tsx")};
import {setLocale} from ${JSON.stringify(join(desktop, "src/renderer/i18n.ts"))};
window.setLocale = setLocale;
const root = createRoot(document.getElementById('root'));
window.openSample = async (kind, source = 'sample.' + kind) => {
 const bytes = new Uint8Array(await (await fetch('/' + source)).arrayBuffer());
 const Viewer = kind === 'pdf' ? PdfViewer : PptxViewer;
 root.render(<PreviewFrame active><Viewer key={kind + performance.now()} bytes={bytes} byteLength={bytes.length}
 fileName={'Very long document 文件名称测试 '.repeat(8) + '.' + kind} onClose={()=>{}} onOpenDefault={()=>{}} onReveal={()=>{}} /></PreviewFrame>);
};
await setLocale('en'); await window.openSample('pdf');
`,
		resolveDir: root,
		loader: "tsx",
	},
	outfile: bundle,
	bundle: true,
	platform: "browser",
	format: "esm",
	jsx: "automatic",
	logLevel: "silent",
});
const html = `<!doctype html><html><head><link rel="stylesheet" href="/app.css"><style>
:root{--app-bg:#171717;--panel:#222;--text:#eee;--text-18:#eee;--text-09:#aaa;--surface-00:#151515;--surface-04:#282828;--surface-08:#333;--border-weak:#444;--overlay-shadow:0 4px 20px #0008}
body{font-family:Arial}#root{width:480px;height:700px;margin-left:auto}option{background:#222;color:white}
</style></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`;
// Mixed page sizes catch "fit the first page" implementations that overflow later pages.
function mixedPdf() {
	const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R 5 0 R 7 0 R] /Count 3 >>"];
	for (const [width, height] of [
		[600, 900],
		[1200, 500],
		[400, 700],
	]) {
		const content = "0.2 0.4 0.8 rg 20 20 200 200 re f";
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << >> /Contents ${objects.length + 2} 0 R >>`,
		);
		objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
	}
	let result = "%PDF-1.4\n";
	const offsets = [0];
	objects.forEach((object, index) => {
		offsets.push(Buffer.byteLength(result));
		result += `${index + 1} 0 obj\n${object}\nendobj\n`;
	});
	const xref = Buffer.byteLength(result);
	result +=
		`xref\n0 ${offsets.length}\n0000000000 65535 f \n` +
		offsets
			.slice(1)
			.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
			.join("");
	return `${result}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
}
const server = createServer(async (req, res) => {
	try {
		const url = new URL(req.url, "http://localhost");
		if (url.pathname === "/") {
			res.setHeader("Content-Type", "text/html");
			res.end(html);
			return;
		}
		const files = {
			"/fixture.js": [bundle, "text/javascript"],
			"/app.css": [join(desktop, "src/renderer/styles/app.css"), "text/css"],
			"/sample.pdf": [resolve(pdf), "application/pdf"],
			"/sample.pptx": [resolve(pptx), "application/octet-stream"],
			"/pdf.worker.min.mjs": [join(desktop, "node_modules/pdfjs-dist/build/pdf.worker.min.mjs"), "text/javascript"],
		};
		if (url.pathname === "/mixed.pdf") {
			res.setHeader("Content-Type", "application/pdf");
			res.end(mixedPdf());
			return;
		}
		const entry = files[url.pathname];
		if (!entry) {
			res.writeHead(404);
			res.end();
			return;
		}
		res.setHeader("Content-Type", entry[1]);
		res.end(await readFile(entry[0]));
	} catch (error) {
		res.writeHead(500);
		res.end(String(error));
	}
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true, channel: process.env.PREVIEW_BROWSER_CHANNEL });
const page = await browser.newPage({ viewport: { width: 1400, height: 900 }, deviceScaleFactor: 2 });
page.setDefaultTimeout(15000);
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
	console.log("Browser ready");
	await page.goto(`http://127.0.0.1:${server.address().port}`);
	const waitRendered = (kind) =>
		page.waitForFunction(
			(kind) =>
				kind === "pdf"
					? document.querySelector(".pdf-page-wrapper canvas")?.width > 0
					: document.querySelector('[data-slide-index="0"]')?.textContent.trim().length > 0,
			kind,
		);
	const checkGeometry = async (kind) => {
		await page.waitForFunction((kind) => {
			const viewport = document.querySelector(kind === "pdf" ? ".pdf-canvas-container" : ".pptx-viewport");
			const first = document.querySelector(kind === "pdf" ? ".pdf-page-wrapper" : '[data-slide-index="0"]');
			return (
				first &&
				first.getBoundingClientRect().width <= viewport.clientWidth &&
				viewport.scrollWidth <= viewport.clientWidth + 1
			);
		}, kind);
		const geometry = await page.evaluate(() => {
			const bar = document.querySelector(".preview-toolbar").getBoundingClientRect();
			const boxes = Array.from(document.querySelectorAll(".preview-toolbar > div"))
				.filter((el) => el.getBoundingClientRect().width && el.getBoundingClientRect().height)
				.map((el) => el.getBoundingClientRect());
			return {
				overflow: boxes.some((b) => b.left < bar.left || b.right > bar.right + 1),
				overlap: boxes.some((a, i) =>
					boxes
						.slice(i + 1)
						.some(
							(b) =>
								Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
								Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1,
						),
				),
			};
		});
		assert.deepEqual(geometry, { overflow: false, overlap: false });
	};
	for (const kind of ["pdf", "pptx"]) {
		console.log("Checking", kind);
		await page.evaluate((kind) => window.openSample(kind), kind);
		await waitRendered(kind);
		for (const locale of ["en", "zh-CN"]) {
			await page.evaluate((locale) => window.setLocale(locale), locale);
			await waitRendered(kind);
			for (const width of [280, 480, 1000]) {
				await page.evaluate((width) => {
					document.getElementById("root").style.width = `${width}px`;
				}, width);
				await checkGeometry(kind);
			}
		}
		await page.evaluate(() => window.setLocale("en"));
		await waitRendered(kind);
		await page.locator("select").selectOption("100");
		await page.evaluate(() => {
			document.getElementById("root").style.width = "280px";
		});
		assert.equal(await page.locator("select").inputValue(), "100");
		await page.locator("select").selectOption(kind === "pdf" ? "width" : "page");
		await checkGeometry(kind);
		await page.getByRole("button", { name: "More preview actions", exact: true }).click();
		await page.waitForFunction(() => !!document.querySelector(".preview-actions-menu:popover-open"));
		const menu = await page.locator(".preview-actions-menu").boundingBox();
		assert(menu && menu.x >= 0 && menu.x + menu.width <= 1400, "More menu must remain inside the viewport");
		await page.keyboard.press("Escape");
		await page.getByRole("button", { name: "Next page", exact: true }).click();
		await page.waitForFunction(() => document.querySelector(".preview-page-info").textContent.startsWith("2 /"));
		const instance = await page.locator(kind === "pdf" ? ".pdf-previewer" : ".pptx-previewer").elementHandle();
		await page.getByRole("button", { name: "Expand preview", exact: true }).click();
		await page.waitForFunction(() => !!document.querySelector("dialog:modal"));
		await page.keyboard.press("Tab");
		assert(
			await page.evaluate(() => document.querySelector("dialog:modal").contains(document.activeElement)),
			"Modal must contain keyboard focus",
		);
		await page.keyboard.press("Escape");
		await page.waitForFunction(() => !document.querySelector("dialog:modal"));
		assert(await instance.evaluate((node) => node.isConnected), "Expanding must preserve the mounted viewer");
		await page.waitForFunction(() => document.querySelector(".preview-page-info").textContent.startsWith("2 /"));
		await page.waitForFunction(
			() =>
				new Promise((resolve) => {
					requestAnimationFrame(() =>
						requestAnimationFrame(() =>
							resolve(document.querySelector(".preview-page-info").textContent.startsWith("2 /")),
						),
					);
				}),
		);
		await page.screenshot({ path: join(directory, `${kind}.png`) });
		console.log(
			`${kind}: real rendering, fit sizes, narrow toolbar, locale, manual zoom, page navigation and expansion passed`,
		);
	}
	await page.evaluate(() => window.openSample("pdf", "mixed.pdf"));
	await page.waitForFunction(
		() =>
			[...document.querySelectorAll(".pdf-page-wrapper canvas")].length === 3 &&
			[...document.querySelectorAll(".pdf-page-wrapper canvas")].every((canvas) => canvas.width > 0),
	);
	await page.waitForFunction(() =>
		[...document.querySelectorAll(".pdf-page-wrapper")].every(
			(page) => page.offsetWidth <= document.querySelector(".pdf-canvas-container").clientWidth,
		),
	);
	await page.locator("select").selectOption("page");
	await page.waitForFunction(() =>
		[...document.querySelectorAll(".pdf-page-wrapper")].every(
			(page) => page.offsetHeight <= document.querySelector(".pdf-canvas-container").clientHeight,
		),
	);
	for (const zoom of ["200", "25", "150", "50", "100"]) await page.locator("select").selectOption(zoom);
	await page.waitForFunction(() => {
		const wrapper = document.querySelector(".pdf-page-wrapper");
		return (
			Math.abs(wrapper.querySelector("canvas").width - wrapper.getBoundingClientRect().width * devicePixelRatio) < 2
		);
	});
	console.log("Mixed portrait/landscape pages and rapid zoom with Retina canvas resolution passed");
	assert.deepEqual(errors, []);
	console.log(`Screenshots: ${directory}`);
} catch (error) {
	console.error("Browser errors:", errors);
	console.error((await page.locator("body").innerText()).slice(0, 1200));
	await page.screenshot({ path: join(directory, "failure.png") });
	console.error("Failure screenshot:", directory);
	throw error;
} finally {
	await browser.close();
	await new Promise((resolve) => server.close(resolve));
}
