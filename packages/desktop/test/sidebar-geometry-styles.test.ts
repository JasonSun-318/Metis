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

	it("positions left sidebar toggle buttons at top 7px to align with traffic lights centerline (y=22px)", () => {
		const fixedButton = rule(
			':root[data-platform="darwin"]:not([data-fullscreen="true"]) .workspace-titlebar-actions .sessions-sidebar-toggle-fixed',
		);
		expect(fixedButton.top).toBe("7px");
		expect(fixedButton.left).toBe("76px");

		const actionButton = rule(".workspace-titlebar-actions button");
		expect(actionButton.width).toBe("30px");
		expect(actionButton.height).toBe("30px");

		const controls = rule(".sidebar-titlebar-controls");
		expect(controls.top).toBe("0px");
	});
});
