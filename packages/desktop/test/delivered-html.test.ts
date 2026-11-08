import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DeliveredHtmlPage } from "../src/main/delivered-html.ts";

let temporary: string;
let directory: string;

beforeEach(async () => {
	temporary = await realpath(await mkdtemp(join(tmpdir(), "metis-delivered-html-")));
	directory = join(temporary, "site");
	await mkdir(join(directory, "assets"), { recursive: true });
	await writeFile(join(directory, "网页 demo.HTM"), "<!doctype html><title>Test page</title>");
	await writeFile(join(directory, "assets", "style.css"), "body { color: blue; }");
	await writeFile(join(directory, "assets", "app.mjs"), "export const loaded = true;");
	await writeFile(join(directory, ".private.json"), "private");
	await writeFile(join(directory, "assets", "credentials.json"), "private");
	await writeFile(join(directory, "notes.txt"), "private notes");
	await writeFile(join(temporary, "outside.js"), "outside");
});
afterEach(async () => {
	await rm(temporary, { recursive: true, force: true });
});

describe("delivered HTML file access", () => {
	it("uses the original file URL and permits relative web assets", async () => {
		const path = join(directory, "网页 demo.HTM");
		const page = new DeliveredHtmlPage(path);
		expect(page.url).toBe(pathToFileURL(path).href);
		await expect(page.canRead(new URL(page.url))).resolves.toBe(true);
		await expect(page.canRead(new URL("./assets/style.css?v=1", page.url))).resolves.toBe(true);
		await expect(page.canRead(new URL("./assets/app.mjs", page.url))).resolves.toBe(true);
	});

	it("denies hidden files, unsupported files and paths outside the authorized directory", async () => {
		const page = new DeliveredHtmlPage(join(directory, "网页 demo.HTM"));
		await symlink(join(temporary, "outside.js"), join(directory, "linked.js"));
		const paths = [
			"../outside.js",
			"assets%2fapp.mjs",
			"assets%5capp.mjs",
			".private.json",
			"assets/credentials.json",
			"notes.txt",
			"linked.js",
		];
		for (const path of paths) {
			await expect(page.canRead(new URL(path, page.url)), path).resolves.toBe(false);
		}
		await expect(page.canRead(new URL("https://example.com/allowed.js"))).resolves.toBe(false);
		await expect(page.canRead(new URL("./assets/missing.js", page.url))).resolves.toBe(false);
		expect(() => new DeliveredHtmlPage(join(directory, "notes.txt"))).toThrow();
	});
});
