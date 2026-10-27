// @vitest-environment jsdom
/// <reference lib="dom" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TERMINAL_THEMES } from "../src/renderer/components/TerminalPanel.tsx";

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

describe("Terminal sidebar shell", () => {
	it("uses distinct terminal and editor palettes for light and dark themes", () => {
		expect(TERMINAL_THEMES.dark.background).toBe("#141414");
		expect(TERMINAL_THEMES.light.background).toBe("#fcfcfb");
		expect(TERMINAL_THEMES.light.foreground).toBe("#2e2b27");
		expect(tokens).toContain("--editor-color-scheme: light;");
		expect(tokens).toContain("--editor-bg: #fcfcfb;");
	});

	it("keeps its interactive header outside the window drag region", () => {
		expect(css).toMatch(/\.workspace-titlebar\s*\{[^}]*-webkit-app-region:\s*drag/u);
		expect(css).toMatch(/\.workspace-tabbar\s*\{[^}]*-webkit-app-region:\s*no-drag/u);
	});

	it("renders panes flush without a card frame", () => {
		const pane = rule(".workspace-pane");
		expect(pane.overflow).toBe("hidden");
		expect(rule(".workspace-tabbar").height).toBe("40px");
		// Tabs take their own width so the add button follows the last tab; the fill drags the window.
		expect(rule(".tool-tabs-scroll").flex).toBe("0 1 auto");
		expect(rule(".workspace-tabbar-fill").flex).toBe("1 1 0%");
		expect(rule(".tool-add").position).toBe("relative");
		expect(rule(".tool-add-menu").width).toBe("200px");
		expect(rule(".workspace-pane-body").position).toBe("relative");
		expect(rule(".browser-toolbar").height).toBe("42px");
		expect(rule(".browser-address-field").borderRadius).toBe("8px");
		expect(rule(".browser-panel").overflow).toBe("visible");
		expect(rule(".browser-find-panel").top).toBe("-40px");
		expect(rule(".browser-find-panel").right).toBe("0px");
		expect(rule(".browser-find-panel").height).toBe("78px");
		expect(rule(".browser-more-menu").width).toBe("236px");
		expect(rule(".browser-view-anchor").top).toBe("42px");
	});

	it("keeps every tab the same size and slides one underline under the active tab", () => {
		expect(rule(".tool-tab.is-active").background).toBe("var(--surface-05)");
		// No weight or padding change on selection: the close slot stays reserved.
		expect(rule(".tool-tab.is-active").fontWeight).toBe("");
		expect(rule(".tool-tab-select").paddingRight).toBe("28px");
		expect(css).not.toMatch(/\.tool-tab\.is-active\s+\.tool-tab-select/u);
		expect(css).not.toMatch(/\.tool-tab\.is-active::after/u);
		expect(css).toMatch(/\.tool-tab-indicator\s*\{[^}]*transition:[^}]*transform[^}]*width/u);
		expect(css).toMatch(/\.tool-tab-indicator\s*\{[^}]*background:\s*var\(--tab-group-color, var\(--text-14\)\)/u);
		expect(rule(".workspace-tabbar.is-unfocused .tool-tab.is-active").background).toBe("var(--surface-03)");
		// Overflowing strips scroll: tabs and groups never shrink or overlap.
		expect(rule(".tool-tab").flex).toBe("0 0 auto");
		expect(rule(".tool-tab-group").flex).toBe("0 0 auto");
		expect(rule(".tool-tabs-scroll").overflowX).toBe("auto");
		expect(rule(".tool-tab-group-body").overflow).toBe("hidden");
	});

	it("keeps browser automation status inside the toolbar without resizing the page", () => {
		const bar = rule(".browser-automation-bar");
		expect(bar.position).toBe("absolute");
		expect(bar.top).toBe("0px");
		expect(bar.height).toBe(rule(".browser-toolbar").height);
		expect(rule(".browser-view-anchor").top).toBe("42px");
		expect(css).not.toMatch(/\.browser-panel\.has-control-bar\s+\.browser-view-anchor\s*\{/u);
		expect(rule(".browser-panel.has-control-bar:has(.browser-handoff-bar) .browser-view-anchor").top).toBe("100px");
	});

	it("anchors the tool-add menu to the plus trigger button", () => {
		expect(rule(".tool-add").position).toBe("relative");
		expect(rule(".tool-add-menu").position).toBe("absolute");
		expect(rule(".tool-add-menu").left).toBe("0px");
		expect(rule(".tool-add-menu.is-align-end").right).toBe("0px");
	});

	it("keeps the file tree beside the preview until the sidebar reaches its minimum width", () => {
		expect(css).toContain("@container (max-width: 300px)");
		expect(css).not.toContain("@container (max-width: 620px)");
	});
});
