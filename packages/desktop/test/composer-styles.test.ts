// @vitest-environment jsdom
/// <reference lib="dom" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(process.cwd(), "src/renderer/styles/app.css"), "utf8");

let cachedRules: CSSStyleRule[] | null = null;
function getRules(): CSSStyleRule[] {
	if (cachedRules) return cachedRules;
	const style = document.createElement("style");
	style.textContent = css;
	document.head.replaceChildren(style);
	cachedRules = Array.from(style.sheet?.cssRules ?? []) as CSSStyleRule[];
	return cachedRules;
}

function rule(selector: string): CSSStyleDeclaration {
	const match = getRules().find((candidate) => candidate.selectorText === selector);
	if (!match) throw new Error(`Missing CSS rule: ${selector}`);
	return match.style;
}

describe("Composer visual states", () => {
	it("uses quieter new-task rays in light mode", () => {
		expect(css).toContain(':root[data-theme="dark"] .new-task-side-rays { opacity: .38; }');
		expect(css).toContain(':root[data-theme="light"] .new-task-side-rays { opacity: .16; }');
	});

	it("keeps the composer and disabled chrome visually stationary", () => {
		expect(rule(".composer").transition).not.toContain("transform");
		expect(rule(".composer").borderRadius).toBe("var(--composer-radius)");
		expect(css).not.toContain(".queued-turn-list + .composer");
		expect(rule(".composer:hover").transform).toBe("");
		expect(rule(".composer:focus-within").transform).toBe("");
		expect(rule(".session-sidebar button:disabled").opacity).toBe("1");
		expect(
			rule(".composer .composer-plain-button:disabled, .composer .composer-selector-trigger:disabled").opacity,
		).toBe("1");
	});

	it("uses one compact square stop control for the running state", () => {
		const stop = rule(".composer-stop.button-secondary");
		expect(stop.borderRadius).toBe("9px");
		expect(stop.background).toBe("var(--surface-13)");
	});

	it("uses a separated Plan status control that reveals its exit icon on hover", () => {
		expect(rule(".collaboration-mode-separator").width).toBe("1px");
		expect(rule(".collaboration-mode-separator").height).toBe("14px");
		expect(rule(".collaboration-mode-indicator").background).toBe("transparent");
		expect(rule(".collaboration-mode-indicator").minHeight).toBe("28px");
		expect(rule(".collaboration-mode-exit-icon").opacity).toBe("0");
		expect(
			getRules().some(
				(candidate) =>
					candidate.selectorText?.includes(".collaboration-mode-exit-icon") && candidate.style.opacity === "1",
			),
		).toBe(true);
	});

	it("uses the reference add button and compact menu scale", () => {
		const addButton = rule(".composer-add > .composer-plain-button");
		expect(addButton.background).toBe("transparent");
		expect(addButton.boxShadow).toBe("none");
		const activeAddButton = rule(
			'.composer-add > .composer-plain-button:hover:not(:disabled), .composer-add > .composer-plain-button[aria-expanded="true"]',
		);
		expect(activeAddButton.background).not.toBe("transparent");
		expect(activeAddButton.boxShadow).toBe("");
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

	it("uses a stationary composer over a full-screen New Task ray field", () => {
		expect(rule(".new-task-home").alignItems).toBe("flex-start");

		const rays = rule(".new-task-side-rays");
		expect(rays.position).toBe("absolute");
		expect(rays.pointerEvents).toBe("none");
		expect(rays.zIndex).toBe("0");
		expect(rule(".new-task-side-rays canvas").display).toBe("block");
	});

	it("removes the decorative New Task logo slot", () => {
		expect(css).not.toContain(".new-task-home-heading > svg");
	});

	it("keeps the New Task folder row translucent and separate from the composer", () => {
		expect(css).toContain("background: var(--app-bg-58)");
		expect(rule(".new-task-home .composer").background).toBe("var(--panel)");
	});

	it("uses the compact Metis task list above the composer", () => {
		const slot = rule(".task-list-slot");
		expect(slot.margin).toBe("0px 16px");
		expect(slot.animation).toBe("task-list-enter 200ms cubic-bezier(.16, 1, .3, 1)");
		expect(rule(".task-list-slot.is-closing").animation).toBe(
			"task-list-exit 200ms cubic-bezier(.4, 0, 1, 1) forwards",
		);

		const panel = rule(".task-list-panel");
		expect(panel.display).toBe("grid");
		expect(panel.gridTemplateRows).toBe("36px 1fr");
		expect(panel.transition).toContain("grid-template-rows");
		expect(panel.borderRadius).toBe("12px 12px 0 0");
		expect(panel.borderBottomWidth).toBe("0px");
		expect(panel.background).toBe("var(--panel)");
		expect(panel.marginBottom).toBe("0px");

		const items = rule(".task-list-items");
		expect(items.maxHeight).toBe("150px");
		expect(rule(".task-list-row").height).toBe("30px");
		expect(rule(".task-list-panel.is-collapsed").gridTemplateRows).toBe("36px 0fr");
		expect(rule(".task-list-drawer").overflow).toBe("hidden");
		expect(rule(".task-list-panel.is-collapsed .task-list-drawer").transform).toBe("translateY(5px)");
		expect(css).toContain(".task-list-spinner { animation: browser-spin 900ms linear infinite; }");
		expect(css).toContain(':root[data-motion="reduced"] .task-list-spinner');
		expect(css).toContain(':root[data-motion="reduced"] .task-list-slot');
	});

	it("uses reference-sized Skill and attachment cards", () => {
		expect(rule(".composer-input-line").display).toBe("flex");
		expect(rule(".composer-input-line").alignItems).toBe("baseline");
		expect(rule(".composer-input-line textarea").getPropertyValue("field-sizing")).toBe("content");
		expect(rule(".composer-skill-token").background).toBe("transparent");
		expect(rule(".composer-skill-token").height).toBe("1.5em");
		expect(rule(".composer-skill-token:hover").background).toBe("transparent");
		expect(rule(".composer-image-preview").width).toBe("64px");
		expect(rule(".composer-image-preview").height).toBe("64px");
		expect(rule(".composer-file-card").width).toBe("200px");
		expect(rule(".composer-file-card").height).toBe("64px");
		expect(rule(".composer-file-card-icon").width).toBe("40px");
		expect(rule(".composer-image-preview > button, .composer-file-card > button").background).toBe(
			"var(--button-primary-bg)",
		);
	});

	it("docks a non-collapsible permission approval above the composer", () => {
		const slot = rule(".permission-approval-slot");
		expect(slot.margin).toBe("0px 16px");
		expect(slot.animation).toBe("task-list-enter 200ms cubic-bezier(.16, 1, .3, 1)");

		const panel = rule(".permission-approval-panel");
		expect(panel.borderRadius).toBe("12px 12px 0 0");
		expect(panel.borderBottomWidth).toBe("0px");
		expect(panel.background).toBe("var(--panel)");
		expect(rule(".permission-approval-details > div").gridTemplateColumns).toBe("108px minmax(0, 1fr)");
		expect(rule(".permission-approval-details dd code").whiteSpace).toBe("pre-wrap");
		expect(css).not.toContain("permission-approval-toggle");
		expect(css).toContain(':root[data-motion="reduced"] .permission-approval-slot');
	});

	it("wraps ask-user questions and answer text instead of hiding it", () => {
		expect(rule(".ask-user-header h2").whiteSpace).toBe("normal");
		expect(rule(".ask-user-header h2").maxHeight).toBe("74px");
		expect(rule(".ask-user-header h2").overflowY).toBe("auto");
		expect(rule(".ask-user-header h2").overflowWrap).toBe("anywhere");
		expect(rule(".ask-user-option-copy strong").whiteSpace).toBe("normal");
		expect(rule(".ask-user-option-copy small").whiteSpace).toBe("normal");
	});

	it("uses the shared neutral hover surface for ask-user choices", () => {
		const hover = rule(".ask-user-option:hover:not(:disabled), .ask-user-option:focus");
		expect(hover.background).toBe("var(--surface-11)");
		expect(hover.boxShadow).toBe("");
	});

	it("uses the compact narrow rectangular box and bottom actions for Code mode", () => {
		const codeComposer = rule(".composer-code");
		expect(codeComposer.display).toBe("flex");
		expect(codeComposer.background).toBe("transparent");
		expect(rule(".composer-code .composer-box").borderRadius).toBe("9px");
		expect(rule(".composer-code .composer-box").background).toBe("var(--surface-03)");
		expect(rule(".composer-code .composer-editable-input").fontSize).toBe("var(--code-body-size)");
		expect(rule(".composer-code-submit, .composer-code-stop").borderRadius).toBe("5px");
		expect(rule(".composer-code .composer-actions").display).toBe("flex");
	});
});
