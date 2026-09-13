// @vitest-environment jsdom

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const cssPath = existsSync(path.join(process.cwd(), "src/renderer/styles/app.css"))
	? path.join(process.cwd(), "src/renderer/styles/app.css")
	: path.join(process.cwd(), "packages/desktop/src/renderer/styles/app.css");
const css = readFileSync(cssPath, "utf8");

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

describe("Interactive Transitions", () => {
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

	it("hides vertical scrollbar while preserving scrollability in settings", () => {
		const scroll = rule(".settings-page-scroll");
		expect(scroll.overflowY).toBe("auto");
		expect(scroll.scrollbarWidth).toBe("none");
	});

	it("defines spring zoom entrance for modal dialogs and smooth notices", () => {
		const backdrop = rule(".modal-backdrop");
		expect(backdrop.animation).toContain("modal-fade-in");

		const dialog = rule(".interaction-dialog");
		expect(dialog.animation).toContain("modal-card-in");

		const notice = rule(".system-notice");
		expect(notice.animation).toContain("system-notice-in");
	});

	it("defines smooth meter transitions for context ring and pop-in for attachments", () => {
		const ringMeter = rule(".context-usage-ring-meter");
		expect(ringMeter.transition).toContain("stroke-dashoffset");

		const pill = rule(".composer-code .composer-file-card");
		expect(pill.animation).toContain("pill-pop-in");

		const slashMenu = rule(".slash-command-menu");
		expect(slashMenu.animation).toContain("slash-drawer-in");
	});

	it("defines smooth transitions for file tree carets and session button hovers", () => {
		const caret = rule(".file-tree-caret");
		expect(caret.transition).toContain("transform");

		const sessionBtn = rule(".session-button");
		expect(sessionBtn.transition).toContain("background-color");
	});
});
