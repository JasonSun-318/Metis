// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(process.cwd(), "src/renderer/styles/app.css"), "utf8");
let parsedRules: CSSRuleList | undefined;

function rules(): CSSRuleList {
	if (parsedRules) return parsedRules;
	const style = document.createElement("style");
	style.textContent = css;
	document.head.append(style);
	if (!style.sheet) throw new Error("Expected parsed application styles");
	parsedRules = style.sheet.cssRules;
	return parsedRules;
}

function rule(selector: string, scope = rules()): CSSStyleDeclaration {
	const match = Array.from(scope).find(
		(candidate): candidate is CSSStyleRule => "selectorText" in candidate && candidate.selectorText === selector,
	);
	if (!match) throw new Error(`Missing CSS rule: ${selector}`);
	return match.style;
}

describe("Browser chrome geometry and interaction styles", () => {
	it("uses compact rounded rectangles without wrapping navigation in a pill", () => {
		const field = rule(".browser-address-field");
		expect(field.height).toBe("32px");
		expect(field.borderRadius).toBe("8px");
		expect(field.minWidth).toBe("0px");
		for (const selector of [
			".browser-toolbar-button",
			".browser-address-open",
			".browser-profile-select .menu-select-trigger",
		]) {
			const button = rule(selector);
			expect(button.width).toBe("28px");
			expect(button.height).toBe("28px");
			expect(button.borderRadius).toBe("6px");
		}
		const navigation = rule(".browser-navigation");
		expect(navigation.gap).toBe("2px");
		expect(navigation.background).toBe("");
		expect(navigation.borderRadius).toBe("");
	});

	it("preserves narrow-pane controls without expanding the address field's minimum width", () => {
		const narrow = Array.from(rules())
			.filter(
				(candidate): candidate is CSSGroupingRule =>
					"cssRules" in candidate && candidate.cssText.startsWith("@container (max-width: 380px)"),
			)
			.find((candidate) =>
				Array.from(candidate.cssRules).some(
					(child) => "selectorText" in child && child.selectorText === ".browser-toolbar-button",
				),
			);
		if (!narrow) throw new Error("Missing narrow browser-pane container styles");
		for (const selector of [".browser-toolbar-button", ".browser-profile-select .menu-select-trigger"]) {
			expect(rule(selector, narrow.cssRules).width).toBe("24px");
			expect(rule(selector, narrow.cssRules).height).toBe("24px");
		}
		expect(rule(".browser-address-open", narrow.cssRules).width).toBe("22px");
		expect(rule(".browser-address-open", narrow.cssRules).height).toBe("22px");
		expect(rule(".browser-address-form").minWidth).toBe("0px");
		expect(rule(".browser-address-field input").minWidth).toBe("0px");
	});

	it("makes keyboard focus visible through contrast while retaining flat controls", () => {
		const focus = rule(
			".browser-profile-select .menu-select-trigger:focus-visible:not(:disabled), .browser-toolbar-button:focus-visible:not(:disabled), .browser-address-open:focus-visible:not(:disabled), .browser-download-actions button:focus-visible:not(:disabled), .browser-find-query button:focus-visible:not(:disabled), .browser-find-controls button:focus-visible:not(:disabled)",
		);
		expect(focus.background).toBe("var(--surface-10)");
		expect(focus.color).toBe("var(--text-strong)");
		expect(focus.boxShadow).toBe("");
		expect(focus.outline).toBe("");
		const addressFocus = rule(".browser-address-field:focus-within");
		expect(addressFocus.borderColor).toBe("var(--border-strong)");
		expect(addressFocus.background).toBe("var(--surface-07)");
	});

	it("keeps browser controls static and disabled controls visually quiet", () => {
		const disabled = rule(".browser-toolbar-button:disabled");
		expect(disabled.cursor).toBe("default");
		expect(disabled.color).toBe("var(--text-01)");
		expect(rule(".browser-address-open:disabled").cursor).toBe("default");
		for (const selector of [".browser-toolbar-button", ".browser-address-open"]) {
			expect(rule(selector).animation).toBe("");
		}
	});
});
