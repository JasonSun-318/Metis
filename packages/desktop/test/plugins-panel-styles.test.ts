// @vitest-environment jsdom
/// <reference lib="dom" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(process.cwd(), "src/renderer/styles/app.css"), "utf8");
const style = document.createElement("style");
style.textContent = css;
document.head.append(style);
const rules = Array.from(style.sheet?.cssRules ?? []) as CSSStyleRule[];

function rule(selector: string): CSSStyleDeclaration {
	const match = rules.find((candidate) => candidate.selectorText === selector);
	if (!match) throw new Error(`Missing CSS rule: ${selector}`);
	return match.style;
}

describe("Plugin Center visual contract", () => {
	it("matches the scheduled-task content width and density", () => {
		expect(css).toContain(
			"input:focus-visible, textarea:focus-visible, select:focus-visible { outline: 1px solid var(--border-strong); outline-offset: 1px; }",
		);
		expect(rule(".plugins-catalog-page").overflowY).toBe("auto");
		expect(rule(".plugins-full-list").overflowY).toBe("auto");
		expect(rule(".plugins-full-list:has(.plugins-catalog-message)").borderColor).toBe("transparent");
		expect(rule(".plugins-detail-page").overflowY).toBe("auto");
		expect(css).toContain(
			".plugins-page-header, .plugins-section-switch-row, .plugins-list-controls, .plugins-full-list { width: min(832px, 100%);",
		);
		expect(rule(".plugins-detail-grid").gridTemplateColumns).toBe("minmax(0, 1fr) 320px");
		expect(rule(".plugins-page-header h1, .plugins-detail-header h1").fontSize).toBe("27px");
		expect(rule(".plugins-new-trigger").height).toBe("32px");
		expect(rule(".plugins-new-trigger").minWidth).toBe("112px");
		expect(rule(".plugins-reload").height).toBe("32px");
		expect(rule(".plugins-reload").display).toBe("inline-flex");
		expect(rule(".plugins-section-switch").height).toBe("40px");
		expect(rule(".plugins-search").height).toBe("42px");
		expect(rule(".plugins-list-row").minHeight).toBe("64px");
		expect(rule(".plugins-row-icon").width).toBe("36px");
		expect(rule(".plugins-detail-actions button").minHeight).toBe("34px");
		expect(rule(".plugins-detail-document").fontSize).toBe("13px");
		expect(rule(".plugins-detail-document pre").overflowX).toBe("auto");
		expect(rule(".scheduled-tasks-empty").minHeight).toBe("260px");
		expect(rule(".scheduled-tasks-empty-icon").width).toBe("96px");
		expect(css).toContain(".mcp-dialog { position: relative; width: min(760px, calc(100vw - 48px));");
		expect(rule(".mcp-dialog").borderRadius).toBe("16px");
		expect(rule(".mcp-dialog").background).toBe("var(--surface-04)");
		expect(rule(".mcp-dialog h2").fontSize).toBe("19px");
		expect(rule(".mcp-dialog label").fontSize).toBe("12px");
		expect(rule('.mcp-dialog input:not([type="checkbox"]), .mcp-dialog select, .mcp-dialog textarea').fontSize).toBe(
			"13px",
		);
		expect(rule('.mcp-dialog input:not([type="checkbox"]), .mcp-dialog select').height).toBe("40px");
		expect(rule(".skill-create-methods > button").minHeight).toBe("72px");
		expect(rule(".skill-create-methods strong").fontSize).toBe("14px");
		expect(rule(".skill-create-methods small").fontSize).toBe("12px");
		expect(rule(".skill-create-github").gridTemplateColumns).toBe("");
		expect(rule(".skill-create-folder").height).toBe("34px");
		expect(rule(".skill-upload-dropzone").minHeight).toBe("174px");
		expect(css).toContain("@media (max-width: 920px)");
		expect(css).toContain("grid-template-columns: minmax(0, 1fr)");
		expect(css).not.toContain("green");
	});

	it("ensures checkbox styles in partial notice override mcp-dialog label", () => {
		expect(rule(".mcp-dialog .plugins-partial-checkbox").display).toBe("flex");
		expect(rule(".mcp-dialog .plugins-partial-checkbox").alignItems).toBe("center");
		expect(rule('.mcp-dialog .plugins-partial-checkbox input[type="checkbox"]').flex).toMatch(/(none|0 0 auto)/);
		expect(rule('.mcp-dialog .plugins-partial-checkbox input[type="checkbox"]').width).toBe("14px");
		expect(rule('.mcp-dialog .plugins-partial-checkbox input[type="checkbox"]').height).toBe("14px");
		expect(rule(".plugins-partial-checkbox span").minWidth).toBe("0px");
	});
});
