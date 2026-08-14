// @vitest-environment jsdom
/// <reference lib="dom" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(process.cwd(), "src/renderer/styles/app.css"), "utf8");
const tokens = readFileSync(path.join(process.cwd(), "src/renderer/styles/tokens.css"), "utf8");

function rule(selector: string): CSSStyleDeclaration {
	const style = document.createElement("style");
	style.textContent = css;
	document.head.replaceChildren(style);
	const rules = Array.from(style.sheet?.cssRules ?? []) as CSSStyleRule[];
	const match = rules.find((candidate) => candidate.selectorText === selector);
	if (!match) throw new Error(`Missing CSS rule: ${selector}`);
	return match.style;
}

describe("Project sidebar motion", () => {
	it("routes Chat and Code prose fonts and reduced motion through root preferences", () => {
		expect(css).toContain("font-family: var(--chat-prose-font)");
		expect(css).toContain("font-family: var(--code-prose-font)");
		expect(css).toContain(':root[data-motion="reduced"]');
		expect(css).not.toContain(".turn-answer { color: var(--text-27); font-family: ui-serif");
	});

	it("uses a flat neutral-gray active state and a subtle gray hover shadow", () => {
		const hover = rule(
			".session-row:hover > .session-button:not(:disabled), .session-row:focus-within > .session-button:not(:disabled)",
		);
		expect(hover.background).toBe("var(--surface-09)");
		expect(hover.boxShadow).toBe("var(--shadow)");
		const active = rule('.session-button[aria-current="page"]');
		expect(active.background).toBe("var(--panel-selected)");
		expect(active.boxShadow).toBe("none");
		const activeInteraction = rule(
			'.session-row:hover > .session-button[aria-current="page"], .session-row:focus-within > .session-button[aria-current="page"]',
		);
		expect(activeInteraction.background).toBe("var(--panel-selected)");
		expect(activeInteraction.boxShadow).toBe("none");
		const action = rule(
			'.session-actions > button:hover:not(:disabled), .session-actions > button[aria-expanded="true"]',
		);
		expect(action.background).toBe("var(--surface-18)");
		expect(action.boxShadow).toBe("var(--shadow)");
		expect(rule(".mode-switch-indicator").background).toBe("var(--mode-switch-active)");
		expect(rule(".mode-switch-indicator").boxShadow).toBe("var(--shadow)");
		expect(tokens).toContain("--shadow: 0 1px 4px rgb(150 150 150 / 9%);");
	});

	it("routes visible shadows through the shared surface or overlay theme tokens", () => {
		const values = [...css.matchAll(/box-shadow:\s*([^;}]+)/g)].map((match) => match[1].trim());
		expect(
			values.every((value) => value === "none" || value === "var(--shadow)" || value === "var(--overlay-shadow)"),
		).toBe(true);
		expect(tokens).toContain("--overlay-shadow: 0 12px 28px rgb(0 0 0 / 35%), 0 2px 6px rgb(0 0 0 / 24%);");
	});

	it("matches the nested session grouping menu geometry and neutral palette", () => {
		expect(rule(".session-grouping-label").top).toBe("12px");
		expect(rule(".session-grouping-label").left).toBe("7px");
		expect(rule(".session-grouping-label").height).toBe("24px");
		expect(rule(".session-grouping-control").top).toBe("12px");
		expect(rule(".session-grouping-control").right).toBe("4px");
		expect(rule(".session-grouping-trigger").width).toBe("24px");
		expect(rule(".session-grouping-trigger").height).toBe("24px");
		expect(rule(".session-grouping-menu-primary, .session-grouping-menu-secondary").background).toBe(
			"var(--surface-07)",
		);
		expect(rule(".session-grouping-menu-primary, .session-grouping-menu-secondary").boxShadow).toBe(
			"var(--overlay-shadow)",
		);
		expect(rule(".session-grouping-menu-primary > button").height).toBe("25px");
		expect(rule(".session-grouping-menu-secondary > div > button").minHeight).toBe("24px");
		expect(rule(".session-grouping-menu-last").borderTop).toContain("var(--surface-12)");
		const taskHeading = rule(".loose-tasks h2");
		const scheduledHeading = rule(".scheduled-task-quick-list h2");
		expect(rule(".scheduled-task-quick-list").marginTop).toBe("20px");
		expect(rule(".scheduled-task-quick-open > i").minWidth).toBe("15px");
		expect(rule(".session-button-title i").width).toBe("6px");
		expect(rule(".session-button-title i").height).toBe("6px");
		const runningDot = rule(".session-button-title i.running");
		expect(runningDot.background).toBe("var(--run-running)");
		expect(runningDot.animation).toBe("session-running-pulse 1.4s ease-in-out infinite");
		for (const [state, background] of [
			["completed", "var(--success-dot)"],
			["failed", "var(--run-failed)"],
			["attention", "var(--attention)"],
		] as const) {
			const dot = rule(`.session-button-title i.${state}`);
			expect(dot.background).toBe(background);
			expect(dot.animation).toBe("session-running-pulse 1.4s ease-in-out infinite");
		}
		expect(css).toContain(
			':root[data-motion="reduced"] .session-button-title i.running, :root[data-motion="reduced"] .session-button-title i.completed, :root[data-motion="reduced"] .session-button-title i.failed, :root[data-motion="reduced"] .session-button-title i.attention { animation: none; opacity: 1; transform: none; }',
		);
		expect(scheduledHeading.margin).toBe(taskHeading.margin);
		expect(scheduledHeading.color).toBe(taskHeading.color);
		expect(scheduledHeading.fontSize).toBe(taskHeading.fontSize);
		expect(scheduledHeading.fontWeight).toBe(taskHeading.fontWeight);
	});

	it("keeps text controls neutral when focused", () => {
		expect(rule("button:focus-visible, summary:focus-visible").outline).toContain("var(--focus)");
		expect(rule("input:focus-visible, textarea:focus-visible, select:focus-visible").outline).toBe(
			"1px solid var(--border-strong)",
		);
		expect(rule(".file-search-field:focus-within").borderColor).toBe("var(--border-strong)");
		expect(rule(".browser-address-field:focus-within").borderColor).toBe("var(--border-strong)");
		expect(rule(".workspace-title-editor input:focus").outline).toBe("none");
		expect(rule(".plugins-search:focus-within").borderColor).toBe("var(--border-strong)");
		expect(rule(".plugins-search:focus-within").boxShadow).toBe("none");
		expect(rule(".composer:focus-within").borderColor).toBe("var(--border-strong)");
	});

	it("keeps the update action rectangular and aligned above the account footer", () => {
		const notice = rule(".sidebar-update-notice");
		const button = rule(".sidebar-update-button");
		expect(notice.marginBottom).toBe("6px");
		expect(button.width).toBe("100%");
		expect(button.height).toBe("34px");
		expect(button.borderRadius).toBe("7px");
		expect(button.background).toBe("var(--surface-06)");
		expect(button.border).toContain("var(--border-strong)");
	});

	it("shows profile avatars and matches the session action menu surface", () => {
		expect(rule(".account-mark").overflow).toBe("hidden");
		expect(rule(".account-mark img").objectFit).toBe("cover");
		expect(rule(".account-menu-name").textOverflow).toBe("ellipsis");
		const accountMenu = rule(".account-menu-popover");
		expect(accountMenu.background).toBe("var(--surface-05)");
		expect(accountMenu.border).toContain("var(--border-strong)");
		expect(accountMenu.borderRadius).toBe("12px");
		expect(accountMenu.boxShadow).toBe("var(--overlay-shadow)");
		const hover = rule(".account-menu-item:hover, .account-menu-item:focus-visible");
		expect(hover.background).toBe("var(--surface-07)");
		expect(hover.boxShadow).toBe("");
		expect(hover.outline).toBe("0px");
	});

	it("keeps the workspace title and actions above the native window drag region", () => {
		const title = rule(".workspace-title");
		expect(title.position).toBe("relative");
		expect(title.zIndex).toBe("8");
		expect(css).toMatch(/\.workspace-title\s*\{[^}]*-webkit-app-region:\s*no-drag/u);
	});

	it("reveals row actions on interaction and slides sessions into a collapsed drawer", () => {
		expect(rule(".project-action-buttons").opacity).toBe("0");
		expect(rule(".project-action-buttons").pointerEvents).toBe("none");
		expect(rule(".project-actions").top).toBe("2px");
		expect(rule(".project-actions").right).toBe("2px");
		expect(rule(".project-action-buttons").height).toBe("24px");
		expect(rule(".project-action-buttons").gap).toBe("2px");
		expect(rule(".project-action-buttons > button").width).toBe("24px");
		expect(rule(".project-action-buttons > button").height).toBe("24px");
		expect(rule(".project-action-buttons > button").borderRadius).toBe("6px");
		const projectAction = rule(
			'.project-action-buttons > button:hover:not(:disabled), .project-action-buttons > button[aria-expanded="true"]',
		);
		expect(projectAction.background).toBe("var(--surface-18)");
		expect(projectAction.boxShadow).toBe("var(--shadow)");
		expect(
			rule(
				".project-heading:hover:not(:disabled), .project-heading:has(+ .project-actions:hover):not(:disabled), .project-heading:has(+ .project-actions:focus-within):not(:disabled)",
			).background,
		).toBe("var(--surface-09)");
		expect(rule(".project-group:hover > .project-actions, .project-actions:focus-within").pointerEvents).toBe("auto");
		expect(
			rule(
				".project-heading:hover + .project-actions .project-action-buttons, .project-actions:hover .project-action-buttons, .project-actions:focus-within .project-action-buttons",
			).opacity,
		).toBe("1");
		expect(rule(".project-drawer").transition).toContain("grid-template-rows");
		expect(rule('.project-group[data-open="false"] > .project-drawer').gridTemplateRows).toBe("0fr");
		expect(rule('.project-group[data-open="false"] > .project-drawer > .project-sessions').transform).toContain(
			"translateY(-9px)",
		);
		expect(rule(".session-actions > button").opacity).toBe("0");
		expect(rule(".session-actions").pointerEvents).toBe("none");
		expect(rule(".session-actions > button").pointerEvents).toBe("auto");
		expect(rule(".session-actions").top).toBe("2px");
		expect(rule(".session-actions").right).toBe("2px");
		expect(rule(".session-actions > button").width).toBe("24px");
		expect(rule(".session-actions > button").height).toBe("24px");
		expect(rule(".session-actions > button").borderRadius).toBe("6px");
		expect(rule(".session-row:hover > .session-actions, .session-actions:focus-within").pointerEvents).toBe("auto");
		expect(
			rule(".session-row:hover > .session-actions > button, .session-actions:focus-within > button").opacity,
		).toBe("1");
		expect(rule(".session-action-menu").position).toBe("fixed");
		expect(rule(".project-action-menu").position).toBe("fixed");
		expect(rule('.session-actions[data-open="true"] > button').opacity).toBe("1");
		expect(rule('.project-actions[data-open="true"] .project-action-buttons').opacity).toBe("1");
	});
});
