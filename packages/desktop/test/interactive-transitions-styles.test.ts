// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(process.cwd(), "src/renderer/styles/app.css"), "utf8");

function rule(selector: string): CSSStyleDeclaration {
	const style = document.createElement("style");
	style.textContent = css;
	document.head.replaceChildren(style);
	const matchingRules = Array.from(style.sheet?.cssRules ?? []).filter(
		(candidate): candidate is CSSStyleRule =>
			candidate instanceof CSSStyleRule &&
			(candidate.selectorText === selector ||
				candidate.selectorText
					.split(",")
					.map((s) => s.trim())
					.includes(selector)),
	);
	if (matchingRules.length === 0) throw new Error(`Missing CSS rule: ${selector}`);
	const target = document.createElement("div");
	for (const candidate of matchingRules) {
		for (let i = 0; i < candidate.style.length; i++) {
			const prop = candidate.style[i]!;
			target.style.setProperty(prop, candidate.style.getPropertyValue(prop));
		}
	}
	return target.style;
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

	it("defines smooth entrance and exit animations for settings dialog", () => {
		const backdrop = rule(".settings-backdrop");
		expect(backdrop.animation).toContain("settings-fade-in");

		const closingBackdrop = rule(".settings-backdrop.is-closing");
		expect(closingBackdrop.animation).toContain("settings-fade-out");

		const page = rule(".settings-page-mount");
		expect(page.animation).toContain("settings-page-in");
	});

	it("defines spring zoom entrance for modal dialogs and smooth toast float", () => {
		const backdrop = rule(".modal-backdrop");
		expect(backdrop.animation).toContain("modal-fade-in");

		const dialog = rule(".interaction-dialog");
		expect(dialog.animation).toContain("modal-card-in");

		const toast = rule(".toast");
		expect(toast.animation).toContain("toast-slide-in");
	});

	it("defines smooth meter transitions for context ring and pop-in for attachments", () => {
		const ringMeter = rule(".context-usage-ring-meter");
		expect(ringMeter.transition).toContain("stroke-dashoffset");

		const pill = rule(".composer-code .composer-file-card");
		expect(pill.animation).toContain("pill-pop-in");

		const slashMenu = rule(".slash-command-menu");
		expect(slashMenu.animation).toContain("slash-drawer-in");
	});
});
