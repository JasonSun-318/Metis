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

describe("Composer visual states", () => {
	it("keeps the composer and disabled chrome visually stationary", () => {
		expect(rule(".composer").transition).not.toContain("transform");
		expect(rule(".composer:hover").transform).toBe("");
		expect(rule(".composer:focus-within").transform).toBe("");
		expect(rule(".session-sidebar button:disabled").opacity).toBe("1");
		expect(
			rule(".composer .composer-plain-button:disabled, .composer .composer-selector-trigger:disabled").opacity,
		).toBe("1");
	});

	it("uses the reference add button and compact menu scale", () => {
		const addButton = rule(".composer-add > .composer-plain-button");
		expect(addButton.background).toBe("transparent");
		expect(addButton.boxShadow).toBe("none");
		const activeAddButton = rule(
			'.composer-add > .composer-plain-button:hover:not(:disabled), .composer-add > .composer-plain-button[aria-expanded="true"]',
		);
		expect(activeAddButton.background).not.toBe("transparent");
		expect(activeAddButton.boxShadow).not.toBe("none");
		expect(activeAddButton.transform).toBe("none");

		const menu = rule(".composer-add-menu, .composer-skill-menu");
		expect(menu.minWidth).toBe("218px");
		const skillMenu = rule(".composer-skill-menu");
		expect(skillMenu.minWidth).toBe("190px");

		const item = rule(".composer-add-menu button, .composer-skill-menu button");
		expect(item.fontSize).toBe("14px");
		expect(item.gap).toBe("8px");
		expect(item.padding).toBe("0px 8px");
	});

	it("uses a stationary composer and a stable fading New Task dot field", () => {
		expect(rule(".new-task-home").alignItems).toBe("flex-start");

		const dots = rule(".new-task-home::before");
		expect(dots.pointerEvents).toBe("none");
		expect(dots.willChange).toBe("");
		expect(dots.backgroundImage).toContain("radial-gradient(circle at 2px 2px");
		expect(dots.backgroundImage).toContain("1.5px");
		expect(dots.backgroundSize).toBe("21px 21px");
		expect(dots.maskImage).toContain("radial-gradient");
		expect(dots.animationName).toBe("");
		expect(css).not.toContain("new-task-vortex");
	});

	it("removes the decorative New Task logo slot", () => {
		expect(css).not.toContain(".new-task-home-heading > svg");
	});

	it("keeps the New Task folder row translucent and separate from the composer", () => {
		expect(css).toContain("background: rgb(32 32 32 / 58%)");
		expect(rule(".new-task-home .composer").background).toBe("var(--panel)");
	});
});
