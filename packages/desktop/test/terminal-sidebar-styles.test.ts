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
		expect(rule(".tool-tabs-scroll").flex).toBe("1 1 0%");
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

	it("visually raises the active tool tab above the sidebar header", () => {
		const activeTab = rule(".tool-tab.is-active");
		expect(activeTab.background).toBe("var(--surface-05)");
		expect(activeTab.boxShadow).toBe("var(--shadow)");
	});

	it("anchors the tool-add menu to the plus trigger button", () => {
		expect(rule(".tool-add").position).toBe("relative");
		expect(rule(".tool-add-menu").position).toBe("absolute");
		expect(rule(".tool-add-menu").right).toBe("0px");
	});

	it("keeps the file tree beside the preview until the sidebar reaches its minimum width", () => {
		expect(css).toContain("@container (max-width: 300px)");
		expect(css).not.toContain("@container (max-width: 620px)");
	});
});
