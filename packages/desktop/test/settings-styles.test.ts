// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(process.cwd(), "src/renderer/styles/app.css"), "utf8");

describe("Settings visual states", () => {
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
