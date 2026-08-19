import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const desktopRoot = join(import.meta.dirname, "..");

describe("pdf.js packaging", () => {
	it("copies worker, cmaps, and standard fonts in the renderer webpack config", () => {
		const config = readFileSync(join(desktopRoot, "webpack.renderer.config.ts"), "utf8");
		expect(config).toContain("pdf.worker.min.mjs");
		expect(config).toContain("pdfjs-dist/cmaps");
		expect(config).toContain("pdfjs-dist/standard_fonts");
		expect(config).not.toContain("cdn.jsdelivr.net");
	});
});
