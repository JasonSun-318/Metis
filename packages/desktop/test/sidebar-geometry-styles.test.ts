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
		const fixedButton = rule(".workspace-titlebar-actions .sessions-sidebar-toggle-fixed");
		expect(fixedButton.top).toBe("7px");
		expect(fixedButton.left).toBe("18px");
		expect(
			rule(
				':root[data-platform="darwin"]:not([data-fullscreen="true"]) .workspace-titlebar-actions .sessions-sidebar-toggle-fixed',
			).left,
		).toBe("76px");
		const actionButton = rule(".workspace-titlebar-actions button");
		expect(actionButton.width).toBe("30px");
		expect(actionButton.height).toBe("30px");

		expect(css).not.toContain("sidebar-titlebar-controls");
	});

	it("uses a compact Windows navigation bar and moves the mode switch to the sidebar top", () => {
		expect(rule(':root[data-platform="win32"] #root').paddingTop).toBe("32px");
		expect(rule(':root[data-platform="win32"] body::before').height).toBe("32px");
		expect(rule(".windows-titlebar-navigation").top).toBe("0px");
		expect(rule(".windows-titlebar-navigation").height).toBe("32px");
		expect(rule(".windows-titlebar-navigation button").width).toBe("28px");
		expect(rule(".windows-titlebar-navigation button").height).toBe("28px");
		expect(rule(':root[data-platform="win32"] .window-drag-region').height).toBe("6px");
		const sidebar = rule(':root[data-platform="win32"] .session-sidebar');
		expect(sidebar.marginTop).toBe("0px");
		expect(sidebar.borderRadius).toBe("0 0 9px 9px");
	});

	it("unifies titlebar actions and right sidebar toggle to top 7px and right 20px", () => {
		const actions = rule(".workspace-titlebar-actions");
		expect(actions.top).toBe("7px");
		expect(actions.right).toBe("20px");

		const actionButtons = rule(".workspace-titlebar-actions button");
		expect(actionButtons.width).toBe("30px");
		expect(actionButtons.height).toBe("30px");
		expect(actionButtons.borderRadius).toBe("7px");
	});

	it("keeps the release bell and tools toggle in one right-aligned group", () => {
		const end = rule(".workspace-titlebar-end");
		expect(end.position).toBe("relative");
		expect(end.display).toBe("flex");
		expect(end.marginLeft).toBe("auto");

		const popover = rule(".release-notes-popover");
		expect(popover.top).toBe("36px");
		expect(popover.right).toBe("0px");
		expect(popover.maxHeight).toContain("480px");
		expect(popover.boxShadow).toBe("var(--overlay-shadow)");
	});
});
