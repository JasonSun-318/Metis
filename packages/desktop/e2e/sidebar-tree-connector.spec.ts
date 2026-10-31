import { createReadStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { build } from "esbuild";

test.use({ channel: "chrome", viewport: { width: 800, height: 640 }, deviceScaleFactor: 1 });
let server: Server;
let directory: string;
let url: string;

interface Rgba {
	readonly width: number;
	readonly height: number;
	readonly data: Uint8Array;
}

interface TreeGeometry {
	readonly rows: readonly { readonly top: number; readonly bottom: number; readonly left: number }[];
	readonly nested: { readonly top: number; readonly bottom: number; readonly left: number } | null;
}

/** Decode with the browser so PNG color modes cannot skew pixel assertions. */
async function decodePng(page: Page, buffer: Buffer): Promise<Rgba> {
	const decoded = await page.evaluate(async (encoded) => {
		const bytes = Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
		const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
		const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
		const context = canvas.getContext("2d");
		if (!context) throw new Error("Missing screenshot decoder context");
		context.drawImage(bitmap, 0, 0);
		bitmap.close();
		return {
			width: canvas.width,
			height: canvas.height,
			data: Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data),
		};
	}, buffer.toString("base64"));
	return { ...decoded, data: Uint8Array.from(decoded.data) };
}

async function treeGeometry(page: Page): Promise<TreeGeometry> {
	return page.evaluate(() => {
		const tree = document.querySelector(".agent-sidebar-tree")!.getBoundingClientRect();
		const relative = (rect: DOMRect) => ({
			top: rect.top - tree.top,
			bottom: rect.bottom - tree.top,
			left: rect.left - tree.left,
		});
		const rows = Array.from(
			document.querySelectorAll<HTMLElement>(".agent-sidebar-tree > .agent-sidebar-entry > .agent-sidebar-node"),
		).map((node) => relative(node.getBoundingClientRect()));
		const nested = document.querySelector<HTMLElement>('[role="treeitem"][aria-label="嵌套子任务"]');
		return { rows, nested: nested ? relative(nested.getBoundingClientRect()) : null };
	});
}

function pixel(image: Rgba, x: number, y: number): readonly [number, number, number] {
	if (x < 0 || y < 0 || x >= image.width || y >= image.height) throw new Error(`Pixel outside screenshot: ${x},${y}`);
	const index = (y * image.width + x) * 4;
	return [image.data[index], image.data[index + 1], image.data[index + 2]];
}

function distance(left: readonly number[], right: readonly number[]): number {
	return Math.max(Math.abs(left[0] - right[0]), Math.abs(left[1] - right[1]), Math.abs(left[2] - right[2]));
}

/**
 * Scans the rendered tree screenshot. The trunk column is pixel x=0 (the node
 * border-left) and a nested child's elbow lives 13px further right (1px border
 * + 12px padding). Line vs background classification compares against colors
 * sampled from the screenshot itself (row 1 trunk and row 3 padding), so the
 * assertions survive theme value tweaks.
 */
async function scanTree(page: Page, evidence: (name: string, extension: string, buffer: Buffer) => Promise<void>) {
	await expect(page.locator(".agent-sidebar-tree")).toBeVisible();
	await page.evaluate(async () => {
		const pending = document
			.getAnimations()
			.filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
			.map((animation) => animation.finished.catch(() => undefined));
		await Promise.all(pending);
	});
	const geometry = await treeGeometry(page);
	const png = await page.locator(".agent-sidebar-tree").screenshot({ animations: "disabled" });
	await evidence("tree-connector", "png", png);
	const image = await decodePng(page, png);
	const [tree] = geometry.rows;
	const last = geometry.rows[2];
	if (geometry.rows.length !== 3 || !tree || !last || tree.left !== 0)
		throw new Error(`Unexpected tree geometry: ${JSON.stringify(geometry)}`);
	const spine = 0;
	const line = pixel(image, spine, Math.round(tree.top + 22));
	const background = pixel(image, 11, Math.round(last.top + 25));
	if (distance(line, background) < 8) throw new Error(`Sampling failed: line ${line} vs background ${background}`);
	const classify = (x: number, y: number) =>
		distance(pixel(image, x, y), line) <= distance(pixel(image, x, y), background) ? "line" : "background";
	return {
		geometry,
		image,
		line,
		background,
		/** Straight part of the elbow's vertical stroke (the 4px rounded corner starts below). */
		lineRuns: (x: number, from: number, to: number) => {
			const classes: string[] = [];
			for (let y = Math.round(from); y <= Math.round(to); y += 1) classes.push(classify(x, y));
			return classes;
		},
	};
}

test.beforeAll(async () => {
	directory = await mkdtemp(path.join(tmpdir(), "metis-tree-connector-"));
	// pdfjs-dist is only needed for file previews, which this fixture never
	// renders; the component graph pulls it in transitively via Transcript.
	const pdfStub = path.join(directory, "pdfjs-stub.js");
	await writeFile(
		pdfStub,
		"export const GlobalWorkerOptions = {};\nexport class TextLayer {}\nexport const getDocument = () => { throw new Error('PDF previews are outside the connector fixture'); };\n",
	);
	await build({
		entryPoints: [path.join(__dirname, "sidebar-tree-connector.fixture.tsx")],
		bundle: true,
		format: "esm",
		jsx: "automatic",
		platform: "browser",
		target: "es2022",
		alias: { "pdfjs-dist": pdfStub },
		outfile: path.join(directory, "fixture.js"),
	});
	await writeFile(
		path.join(directory, "index.html"),
		`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/fixture.css"></head><body><div id="root"></div><script type="module" src="/fixture.js"></script></body></html>`,
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
	if (!address || typeof address === "string") throw new Error("Connector fixture server did not start");
	url = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => {
	if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
	if (directory) await rm(directory, { recursive: true, force: true });
});

test("three same-level subagents keep the trunk continuous into the last elbow with no dangling tail", async ({
	page,
}, info) => {
	await page.goto(url);
	const scan = await scanTree(page, async (name, extension, buffer) => {
		const evidencePath = info.outputPath(`${name}.${extension}`);
		await writeFile(evidencePath, buffer);
		await info.attach(name, { path: evidencePath, contentType: `image/${extension}` });
	});
	const { rows } = scan.geometry;
	const [, middle, last] = rows;
	// Trunk runs from the first row through the last row's straight elbow part
	// (the 4px rounded corner of the elbow starts 13px down).
	for (const y of scan.lineRuns(0, Math.round(middle.top), Math.round(last.top + 12))) expect(y).toBe("line");
	// The elbow's horizontal bar closes the corner at its bottom edge.
	for (const x of [6, 7, 8]) expect(scan.lineRuns(x, last.top + 17, last.top + 17)).toEqual(["line"]);
	// No trunk may hang below the last row's elbow.
	for (const y of scan.lineRuns(0, last.top + 19, last.bottom - 2)) expect(y).toBe("background");
	// The nested child's elbow must also render its own vertical stroke.
	if (!scan.geometry.nested) throw new Error("Fixture lost the nested child");
	const nested = scan.geometry.nested;
	const nestedSpine = Math.round(nested.left);
	expect(nestedSpine).toBe(13);
	for (const y of scan.lineRuns(nestedSpine, nested.top + 2, nested.top + 12)) expect(y).toBe("line");
	for (const y of scan.lineRuns(nestedSpine, nested.top + 19, nested.bottom - 2)) expect(y).toBe("background");
});

test("the last-row elbow keeps its stroke after collapsing and reopening the branch", async ({ page }, info) => {
	await page.goto(url);
	const scan = async () =>
		scanTree(page, async (name, extension, buffer) => {
			const evidencePath = info.outputPath(`${name}.${extension}`);
			await writeFile(evidencePath, buffer);
			await info.attach(name, { path: evidencePath, contentType: `image/${extension}` });
		});
	await scan();
	await page.locator(".agent-root-toggle").click();
	await expect(page.locator(".agent-sidebar-drawer:has(.agent-sidebar-tree)")).toHaveAttribute("data-open", "false");
	await page.locator(".agent-root-toggle").click();
	await expect(page.locator(".agent-sidebar-drawer:has(.agent-sidebar-tree)")).toHaveAttribute("data-open", "true");
	const reopened = await scan();
	const { rows } = reopened.geometry;
	const last = rows[2];
	for (const y of reopened.lineRuns(0, Math.round(rows[1].top), Math.round(last.top + 12))) expect(y).toBe("line");
	for (const y of reopened.lineRuns(0, last.top + 19, last.bottom - 2)) expect(y).toBe("background");
});

for (const theme of ["light", "dark"] as const) {
 test(`tree strokes have uniform brightness without overlapping segments in ${theme}`, async ({page}) => {
 await page.goto(url);
 await page.evaluate((value) => {document.documentElement.dataset.theme=value;}, theme);
 const scan = await scanTree(page, async () => undefined);
 for (const row of scan.geometry.rows) {
 for (const offset of [2,5,9,12]) {
 expect(pixel(scan.image, 0, Math.round(row.top + offset))).toEqual(scan.line);
 }
 }
 });
}
