// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(process.cwd(), "src/renderer/styles/app.css"), "utf8");

let parsedRules: CSSStyleRule[] | null = null;
function rule(selector: string): CSSStyleDeclaration {
	if (!parsedRules) {
		const style = document.createElement("style");
		style.textContent = css;
		document.head.replaceChildren(style);
		parsedRules = Array.from(style.sheet?.cssRules ?? []).filter(
			(candidate): candidate is CSSStyleRule => candidate instanceof CSSStyleRule,
		);
	}
	const match = parsedRules.find(
		(candidate) =>
			candidate.selectorText === selector ||
			candidate.selectorText
				.split(",")
				.map((s) => s.trim())
				.includes(selector),
	);
	if (!match) throw new Error(`Missing CSS rule: ${selector}`);
	return match.style;
}

describe("Interactive Transitions - Phase 1: Thinking Chain & Tool Steps", () => {
	it("defines smooth transitions on tool-step container and carets", () => {
		const toolStep = rule(".tool-step");
		expect(toolStep.transition).toContain("margin-left");
		expect(toolStep.transition).toContain("background-color");

		const caret = rule(".tool-step > summary > svg:first-child");
		expect(caret.transition).toContain("top");
		expect(caret.transition).toContain("left");
	});

	it("defines smooth drawer transitions for tool-step-drawer", () => {
		const drawer = rule(".tool-step-drawer");
		expect(drawer.transition).toContain("grid-template-rows");
		expect(drawer.display).toBe("grid");
		expect(drawer.gridTemplateRows).toBe("0fr");

		const openDrawer = rule(".tool-step[open] .tool-step-drawer");
		expect(openDrawer.gridTemplateRows).toBe("1fr");
	});

	it("supports reduced-motion mode by disabling transitions", () => {
		const reduced = rule(':root[data-motion="reduced"] .tool-step, :root[data-motion="reduced"] .tool-step-drawer');
		expect(reduced.transition).toBe("none");
	});

	it("defines upward growth animation and smooth height transitions on usage bars", () => {
		const usageBar = rule(".usage-bar");
		expect(usageBar.animation).toContain("usage-bar-rise");

		const usageBarItem = rule(".usage-bar > i");
		expect(usageBarItem.transition).toContain("height");

		const tooltip = rule(".usage-tooltip");
		expect(tooltip.transition).toContain("left");
		expect(tooltip.transition).toContain("opacity");
	});
});
