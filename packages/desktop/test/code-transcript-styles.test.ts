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

describe("Code transcript visual contract", () => {
	it("keeps the dense Code transcript treatment scoped away from Chat", () => {
		expect(tokens).toContain("--code-body-size: clamp(14px");
		expect(css).toContain(
			".transcript-code .transcript-scroll { padding: 15px max(24px, calc((100% - var(--conversation-width)) / 2)) 16px; }",
		);
		expect(rule(".transcript-code .code-transcript-turn").width).toBe("100%");
		expect(rule(".transcript-code :is(.code-turn-answer, .code-turn-status)").fontFamily).toContain("ui-sans-serif");
		expect(rule(".transcript-code .code-command-output").maxHeight).toBe("310px");
		expect(rule(".transcript-code .code-execution-card").borderRadius).toBe("8px");
	});

	it("uses neutral shared surfaces and separated Code Markdown table cells", () => {
		expect(tokens).toContain("--app-bg: #202020");
		expect(tokens).toContain("--panel: #2e2e2e");
		expect(rule(".message-user").background).toBe("var(--surface-00)");
		expect(rule(".transcript-code .code-turn-user > div").background).toBe("var(--surface-06)");
		expect(rule(".transcript-code :is(.code-turn-answer, .code-turn-status) table").borderCollapse).toBe("separate");
		expect(rule(".transcript-code :is(.code-turn-answer, .code-turn-status) table").borderSpacing).toBe("2px");
		expect(rule(".transcript-code :is(.code-turn-answer, .code-turn-status) :is(th, td)").borderWidth).toBe("0px");
	});

	it("keeps Markdown status headings at the compact Code scale", () => {
		expect(rule(".transcript-code :is(.code-turn-answer, .code-turn-status) h2").fontSize).toBe("1.16em");
	});

	it("slides the latest user bubble in from the right and respects reduced motion", () => {
		expect(
			rule(".turn-user.is-entering .message-user, .transcript-code .code-turn-user.is-entering > div").animation,
		).toBe("user-message-enter 180ms cubic-bezier(.16, 1, .3, 1) both");
		expect(css).toContain(
			"@keyframes user-message-enter { from { opacity: 0; transform: translateX(12px); } to { opacity: 1; transform: none; } }",
		);
		expect(css).toContain(
			".turn-user.is-entering .message-user, .transcript-code .code-turn-user.is-entering > div { animation: none; }",
		);
	});

	it("keeps the runtime spinner the same height as its status text", () => {
		expect(rule(".turn-runtime-status").fontSize).toBe("12px");
		expect(rule(".turn-runtime-spinner").getPropertyValue("--uib-size")).toBe("1em");
	});
});
