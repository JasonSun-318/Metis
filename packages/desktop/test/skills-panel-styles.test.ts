// @vitest-environment jsdom
/// <reference lib="dom" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(process.cwd(), "src/renderer/styles/app.css"), "utf8");

function rule(selector: string): CSSStyleDeclaration {
	const style = document.createElement("style");
	style.textContent = css;
	document.head.replaceChildren(style);
	const rules = Array.from(style.sheet?.cssRules ?? []) as CSSStyleRule[];
	const match = rules.find((candidate) => candidate.selectorText === selector);
	if (!match) throw new Error(`Missing CSS rule: ${selector}`);
	return match.style;
}

describe("Skills catalog visual contract", () => {
	it("keeps compact rows, a bounded empty illustration, and reduced motion", () => {
		expect(rule(".skills-directory-row, .skills-skill-row").minHeight).toBe("68px");
		const emptyIcon = rule(".skills-empty-state .traced-svg-icon");
		expect(emptyIcon.width).toBe("88px");
		expect(emptyIcon.height).toBe(emptyIcon.width);
		expect(rule(".traced-svg-icon").maskComposite).toBe("exclude");
		expect(css).toContain(".skills-panel-content { width: min(680px, calc(100% - 48px));");
		expect(css).toContain(".skills-loading-row > span, .skills-loading-row i { animation: none; }");
	});
});
