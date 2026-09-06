// @vitest-environment jsdom
/// <reference lib="dom" />

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(process.cwd(), "src/renderer/styles/app.css"), "utf8");

function getRules(): CSSStyleRule[] {
	const style = document.createElement("style");
	style.textContent = css;
	document.head.replaceChildren(style);
	return Array.from(style.sheet?.cssRules ?? []).filter(
		(candidate): candidate is CSSStyleRule => candidate instanceof CSSStyleRule,
	);
}

function rule(selector: string): CSSStyleDeclaration {
	const match = getRules().find((candidate) => candidate.selectorText === selector);
	if (!match) throw new Error(`Missing CSS rule: ${selector}`);
	return match.style;
}

describe("App text selection", () => {
	it("disables selection in chrome and keeps it for editors and errors", () => {
		expect(rule("html, body, #root").userSelect).toBe("none");
		const selectable = getRules().find(
			(candidate) => candidate.style.userSelect === "text" && candidate.selectorText.includes('[role="alert"]'),
		);
		expect(selectable?.selectorText).toContain("input");
		expect(selectable?.selectorText).toContain('[contenteditable="true"]');
		expect(selectable?.selectorText).toContain(".cm-content");
		expect(selectable?.selectorText).toContain(".toast-error");
		expect(selectable?.selectorText).toContain(".error-copy");
		expect(selectable?.selectorText).toContain(".file-empty-state.is-error");
		expect(selectable?.selectorText).toContain(".preview-error-state");
	});
});
