// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(process.cwd(), "src/renderer/styles/app.css"), "utf8");

describe("Settings visual states", () => {
	it("uses restrained overlays and a flatter content hierarchy", () => {
		expect(css).toContain("background: rgb(0 0 0 / 46%); backdrop-filter: blur(4px)");
		expect(css).toContain(
			".model-provider-grid { display: grid; min-height: 0; align-content: start; gap: 10px; margin-top: 4px; grid-template-columns: repeat(2, minmax(0, 1fr)); }",
		);
		expect(css).toContain(
			".usage-detail-card { border: 0; border-radius: 0; background: transparent; padding: 4px 16px; }",
		);
		expect(css).toContain(".model-provider-card small { color: var(--text-10);");
		expect(css).toContain(".usage-metric-card small { color: var(--text-10);");
		expect(css).toContain(
			".usage-chart-axis { display: flex; justify-content: space-between; color: var(--text-10);",
		);
		expect(css).toContain(".usage-detail-card li small { color: var(--text-09); }");
		expect(css).toContain(".memory-engine-card-desc { margin: 0; color: var(--text-10);");
	});

	it("keeps API key text clear of the reveal control", () => {
		const style = document.createElement("style");
		style.textContent = css;
		document.head.append(style);
		const page = document.createElement("div");
		page.className = "settings-page";
		page.innerHTML =
			'<div class="web-search-api-key-field"><input type="text"><button class="web-search-api-key-reveal"></button></div>';
		document.body.append(page);

		const input = page.querySelector("input")!;
		const reveal = page.querySelector("button")!;
		expect(Number.parseFloat(getComputedStyle(input).paddingRight)).toBeGreaterThan(
			Number.parseFloat(getComputedStyle(reveal).width),
		);
		expect(getComputedStyle(reveal).backgroundColor).not.toBe("transparent");
	});
});
