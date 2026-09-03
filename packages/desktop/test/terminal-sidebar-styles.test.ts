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
		expect(rule(".workspace-titlebar-actions").right).toBe("20px");
		expect(css).toMatch(/\.tool-tabbar\s*\{[^}]*-webkit-app-region:\s*no-drag/u);
	});

	it("matches the compact rounded sidebar frame", () => {
		const sidebar = rule(".tool-sidebar");
		expect(sidebar.top).toBe("7px");
		expect(sidebar.right).toBe("7px");
		expect(sidebar.bottom).toBe("7px");
		expect(sidebar.borderRadius).toBe("9px");
		expect(rule(".tool-tabbar").height).toBe("36px");
		expect(rule(".tool-tabs-scroll").flex).toBe("0 1 auto");
		expect(rule(".tool-add").position).toBe("relative");
		expect(rule(".tool-add-menu").left).toBe("0px");
		expect(rule(".tool-add-menu").width).toBe("200px");
		expect(rule(".tool-stage").top).toBe("36px");
		expect(rule(".browser-toolbar").height).toBe("42px");
		expect(rule(".browser-address-field").borderRadius).toBe("8px");
		expect(rule(".browser-panel").overflow).toBe("visible");
		expect(rule(".browser-find-panel").top).toBe("-36px");
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

	it("anchors the tool-add menu to the plus trigger button rather than the sidebar right edge", () => {
		expect(rule(".tool-add").position).toBe("relative");
		expect(rule(".tool-add-menu").position).toBe("absolute");
		expect(rule(".tool-add-menu").left).toBe("0px");
		expect(rule(".tool-add-menu").right).toBe("");
	});

	it("keeps the file tree beside the preview until the sidebar reaches its minimum width", () => {
		expect(css).toContain("@container (max-width: 300px)");
		expect(css).not.toContain("@container (max-width: 620px)");
	});
});
