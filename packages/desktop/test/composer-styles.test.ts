// @vitest-environment jsdom
/// <reference lib="dom" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(process.cwd(), "src/renderer/styles/app.css"), "utf8").replace(
	'@import "./composer-panels.css";',
	readFileSync(path.join(process.cwd(), "src/renderer/styles/composer-panels.css"), "utf8"),
);

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
	it("uses a quiet home surface with dark and light theme support", () => {
		const home = rule(".new-task-home");
		expect(home.background).toBe("var(--home-bg)");
		expect(home.getPropertyValue("--home-bg")).toBe("var(--app-bg)");
		expect(home.getPropertyValue("--home-panel")).toBe("var(--panel)");
		expect(home.getPropertyValue("--home-hover")).toBe("var(--panel-hover)");
		expect(home.getPropertyValue("--home-border")).toBe("var(--border)");
		expect(css).not.toContain(".new-task-home-backdrop");
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

		const menu = rule(".composer-add-menu, .composer-skill-menu, .session-action-menu");
		expect(menu.minWidth).toBe("200px");
		const skillMenu = rule(".composer-skill-menu");
		expect(skillMenu.minWidth).toBe("180px");

		const item = rule(".composer-add-menu button, .composer-skill-menu button, .session-action-menu button");
		expect(item.fontSize).toBe("12px");
		expect(item.gap).toBe("8px");
		expect(item.padding).toBe("0px 8px");
	});

	it("allows normal scrolling when home content grows", () => {
		expect(rule(".new-task-home").overflow).toBe("hidden");
		const scroll = rule(".new-task-home-scroll");
		expect(scroll.overflowY).toBe("auto");
		expect(scroll.scrollbarWidth).toBe("none");
		expect(css).toMatch(/\.new-task-home-scroll\s*\{[^}]*-ms-overflow-style:\s*none/);
		const hiddenScrollbar = rule(".new-task-home-scroll::-webkit-scrollbar");
		expect(hiddenScrollbar.display).toBe("none");
		expect(hiddenScrollbar.width).toBe("0px");
		expect(hiddenScrollbar.height).toBe("0px");
	});

	it("removes the decorative New Task logo slot", () => {
		expect(css).not.toContain(".new-task-home-heading > svg");
	});

	it("preserves a separate workspace bar below the composer", () => {
		expect(rule(".new-task-home .composer").borderBottom).toBe("1px solid var(--home-border)");
		expect(rule(".new-task-home-project-control").minHeight).toBe("38px");
		expect(rule(".new-task-home .home-project-picker").height).toBe("38px");
		expect(rule(".new-task-home .home-project-picker button:focus-visible").outline).toBe("2px solid var(--focus)");
	});

	it("keeps a readable centered welcome and lightweight shortcuts in normal flow", () => {
		expect(css).toMatch(/\.new-task-home-content\s*\{[^}]*width:\s*min\(680px,\s*100%\)/);
		expect(rule(".new-task-home-content").justifyContent).toBe("center");
		expect(rule(".new-task-home-hero-main").position).toBe("relative");
		expect(rule(".new-task-home-heading h1").fontFamily).toContain("Songti SC");
		expect(rule(".new-task-home-heading h1").fontFamily).toContain("serif");
		expect(rule(".new-task-home-heading h1").fontWeight).toBe("400");
		expect(rule(".new-task-home-heading h1").whiteSpace).not.toBe("nowrap");
		expect(rule(".new-task-home-heading").textAlign).toBe("center");
		expect(rule(".new-task-starter-grid").flexWrap).toBe("wrap");
		expect(css).not.toContain("--home-sticky-top");
		expect(css).not.toContain(".new-task-home-discovery");
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

	it("shows permission approval as a composer panel", () => {
		const slot = rule(".permission-approval-slot");
		expect(slot.margin).toBe("0px 16px");
		const panel = rule(".permission-approval-panel");
		expect(panel.borderBottom).toBe("0px");
		expect(panel.borderRadius).toBe("12px 12px 0 0");
		expect(panel.background).toBe("var(--panel)");
		expect(css).not.toContain(".permission-approval-panel { width: min(620px, 100%);");
		expect(rule(".permission-approval-details > div").gridTemplateColumns).toBe("108px minmax(0, 1fr)");
		expect(rule(".permission-approval-details dd code").whiteSpace).toBe("pre-wrap");
		expect(
			rule(".permission-approval-panel .permission-approval-body > footer button:hover:not(:disabled)").background,
		).toBe("var(--button-primary-bg-hover)");
		expect(
			rule(".permission-approval-panel .permission-approval-body > footer .button-secondary:hover:not(:disabled)")
				.background,
		).toBe("var(--surface-10)");
		expect(rule(".goal-bar-body[hidden], .permission-approval-body[hidden], .queued-turn-body[hidden]").display).toBe(
			"none",
		);
		expect(css).toContain(".permission-approval-slot");
	});

	it("keeps long questions in a single content scroller with readable choices", () => {
		expect(rule(".ask-user-content").overflowY).toBe("auto");
		expect(rule(".ask-user-content h2").whiteSpace).toBe("normal");
		expect(rule(".ask-user-content h2").overflowWrap).toBe("anywhere");
		expect(rule(".ask-user-content h2").maxHeight).toBe("");
		expect(rule(".ask-user-option-copy strong").whiteSpace).toBe("normal");
		expect(rule(".ask-user-option-copy small").whiteSpace).toBe("normal");
	});

	it("distinguishes selected choices from focus and keeps unchecked controls visible", () => {
		expect(rule(".ask-user-option:hover:not(:disabled)").background).toBe("var(--panel-hover)");
		expect(rule(".ask-user-option:focus-visible").outline).toContain("2px");
		expect(css).not.toContain("var(KEEP_WHITE)");
		expect(rule(".ask-user-checkbox").border).toContain("1px solid");
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

	it("shows the composer placeholder only via the data-empty attribute, not the :empty selector", () => {
		expect(css).not.toMatch(/\.composer-editable-input:empty::before/);
		expect(css).toMatch(
			/\.composer\s+\.composer-editable-input\[data-empty="true"\]::before\s*\{[^}]*content:\s*attr\(data-placeholder\)/,
		);
		expect(css).toMatch(/\.composer-code\s+\.composer-editable-input\[data-empty="true"\]::before/);
	});
});
