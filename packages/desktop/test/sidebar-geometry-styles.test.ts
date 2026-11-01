// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(process.cwd(), "src/renderer/styles/app.css"), "utf8");

let parsedRules: CSSStyleRule[] | null = null;
function rule(selector: string): CSSStyleDeclaration {
	if (!parsedRules) {
		const style = document.createElement("style");
		style.textContent = css;
		document.head.replaceChildren(style);
		parsedRules = Array.from(style.sheet?.cssRules ?? []) as CSSStyleRule[];
	}
	const match = parsedRules.find((candidate) => candidate.selectorText === selector);
	if (!match) throw new Error(`Missing CSS rule: ${selector}`);
	return match.style;
}

describe("Sidebar geometry and workspace grid styles", () => {
	it("explicitly assigns workspace to grid column 2 and session sidebar to column 1 to prevent 0px black screen", () => {
		expect(rule(".workspace").gridColumn).toBe("2");
		expect(rule(".session-sidebar").gridColumn).toBe("1");
	});

	it("keeps one fixed left sidebar toggle aligned with the platform title controls", () => {
		const fixedButton = rule(".workspace-titlebar .sessions-sidebar-toggle-fixed");
		expect(fixedButton.top).toBe("calc(var(--titlebar-control-center-y) - 14px)");
		expect(fixedButton.left).toBe("18px");
		expect(
			rule(
				':root[data-platform="darwin"]:not([data-fullscreen="true"]) .workspace-titlebar .sessions-sidebar-toggle-fixed',
			).left,
		).toBe("76px");
		const actionButton = rule(
			".workspace-titlebar .sessions-sidebar-toggle-fixed, .workspace-titlebar .tool-add-trigger, .workspace-titlebar .session-add-trigger",
		);
		expect(actionButton.width).toBe("28px");
		expect(actionButton.height).toBe("28px");

		expect(css).not.toContain("sidebar-titlebar-controls");
	});

	it("uses two Windows titlebar rows and moves the mode switch to the sidebar top", () => {
		expect(rule(':root[data-platform="win32"] #root').paddingTop).toBe("calc(32px + var(--titlebar-height))");
		expect(rule(':root[data-platform="win32"] body::before').height).toBe("32px");

		// Row one is the native overlay and holds only the app mark.
		const brand = rule(".windows-titlebar-brand");
		expect(brand.position).toBe("fixed");
		expect(brand.top).toBe("0px");
		expect(brand.height).toBe("32px");
		expect(css).toMatch(/\.windows-titlebar-brand\s*\{[^}]*-webkit-app-region:\s*drag/u);

		// Row two spans the window and hosts navigation, tabs and tool tabs.
		const row = rule(':root[data-platform="win32"] .workspace-titlebar.windows-titlebar-row');
		expect(row.position).toBe("fixed");
		expect(row.top).toBe("32px");
		expect(row.left).toBe("0px");
		expect(row.right).toBe("0px");
		expect(rule(".windows-titlebar-navigation").position).toBe("absolute");
		expect(rule(".windows-titlebar-navigation").top).toBe("0px");
		expect(rule(".windows-titlebar-navigation button").width).toBe("28px");
		expect(rule(".windows-titlebar-navigation button").height).toBe("28px");
		expect(rule(':root[data-platform="win32"] .windows-titlebar-row .workspace-titlebar-tabs').left).toBe(
			"var(--windows-sidebar-offset, 0px)",
		);
		expect(
			rule(
				':root[data-platform="win32"] .windows-titlebar-row.is-sidebar-collapsed .workspace-titlebar-cell:first-child .workspace-tabbar',
			).paddingLeft,
		).toBe("104px");
		expect(rule(':root[data-platform="win32"] .window-drag-region').height).toBe("6px");
		const sidebar = rule(':root[data-platform="win32"] .session-sidebar');
		expect(sidebar.marginTop).toBe("0px");
		expect(sidebar.borderRadius).toBe("0px");
	});

	it("renders the titlebar as an in-flow drag row hosting the merged tab strip", () => {
		const titlebar = rule(".workspace-titlebar");
		expect(titlebar.height).toBe("var(--titlebar-height)");

		// Shared top-row geometry: compact 40px/19.5px default, 46px/23px on
		// normal macOS so 28px tabs sit 9/9 around the traffic-light center.
		expect(css).toMatch(
			/:root\s*\{[^}]*--titlebar-height:\s*40px;[^}]*--titlebar-control-center-y:\s*19\.5px;[^}]*\}/u,
		);
		expect(css).toMatch(
			/:root\[data-platform="darwin"\]:not\(\[data-fullscreen="true"\]\)\s*\{[^}]*--titlebar-height:\s*46px;[^}]*--titlebar-control-center-y:\s*23px;[^}]*\}/u,
		);
		// No per-element downward centerline patches: strips center naturally.
		expect(css).not.toMatch(/top:\s*calc\(var\(--titlebar-control-center-y\) - 19\.5px\)/u);
		// The sidebar's top chrome spacer tracks the same titlebar height.
		expect(rule(".window-drag-region").height).toBe("calc(var(--titlebar-height) + 7px)");

		expect(titlebar.borderBottom).toBe("1px solid var(--border)");

		const actionButtons = rule(
			".workspace-titlebar .sessions-sidebar-toggle-fixed, .workspace-titlebar .tool-add-trigger, .workspace-titlebar .session-add-trigger",
		);
		expect(actionButtons.width).toBe("28px");
		expect(actionButtons.height).toBe("28px");
		expect(actionButtons.borderRadius).toBe("7px");

		expect(css).toMatch(
			/\.workspace-tabbar--titlebar\s*\{[^}]*border-bottom:\s*none[^}]*-webkit-app-region:\s*no-drag/u,
		);
		expect(css).toMatch(/\.workspace-tabbar-fill\s*\{[^}]*-webkit-app-region:\s*drag/u);
	});

	it("anchors account actions to the full footer and keeps notification content outside its layout", () => {
		expect(rule(".sidebar-footer").position).toBe("relative");
		expect(rule(".sidebar-footer .account-menu").position).toBe("static");
		const menu = rule(".account-menu-popover");
		expect(menu.left).toBe("0px");
		expect(menu.right).toBe("0px");
		expect(menu.width).toBe("auto");
		expect(rule(".release-notes-menu-control").width).toBe("100%");
	});
});
