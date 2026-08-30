// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
	applyGeneralPreferencesToDocument,
	DEFAULT_GENERAL_PREFERENCES,
	GENERAL_PREFERENCES_STORAGE_KEY,
	loadGeneralPreferences,
	resolveReducedMotion,
	saveGeneralPreferences,
} from "../src/renderer/general-preferences.ts";

describe("general preferences", () => {
	beforeEach(() => {
		localStorage.clear();
		document.documentElement.removeAttribute("data-motion");
		document.documentElement.style.removeProperty("--chat-prose-font");
		document.documentElement.style.removeProperty("--code-prose-font");
		document.documentElement.style.removeProperty("--content-font-size");
	});

	it("falls back field-by-field when persisted JSON is missing or invalid", () => {
		expect(loadGeneralPreferences(localStorage)).toEqual(DEFAULT_GENERAL_PREFERENCES);
		localStorage.setItem(
			GENERAL_PREFERENCES_STORAGE_KEY,
			JSON.stringify({ motion: "reduced", chatFont: "unknown", codeFont: "system-serif", contentFontSize: "99px" }),
		);
		expect(loadGeneralPreferences(localStorage)).toEqual({
			motion: "reduced",
			chatFont: "system-sans",
			codeFont: "system-serif",
			contentFontSize: "15px",
		});
		localStorage.setItem(GENERAL_PREFERENCES_STORAGE_KEY, "{");
		expect(loadGeneralPreferences(localStorage)).toEqual(DEFAULT_GENERAL_PREFERENCES);
	});

	it("persists one versioned document", () => {
		const value = {
			motion: "system",
			chatFont: "system-sans",
			codeFont: "anthropic-serif",
			contentFontSize: "20px",
		} as const;
		saveGeneralPreferences(localStorage, value);
		expect(JSON.parse(localStorage.getItem(GENERAL_PREFERENCES_STORAGE_KEY)!)).toEqual(value);
	});

	it("resolves system motion and applies resolved motion, font stacks, and content size", () => {
		expect(resolveReducedMotion("system", { matches: true })).toBe(true);
		expect(resolveReducedMotion("system", { matches: false })).toBe(false);
		expect(resolveReducedMotion("reduced", { matches: false })).toBe(true);
		applyGeneralPreferencesToDocument(
			{ motion: "reduced", chatFont: "anthropic-serif", codeFont: "system-sans", contentFontSize: "20px" },
			{ matches: false },
		);
		expect(document.documentElement.dataset.motion).toBe("reduced");
		expect(document.documentElement.style.getPropertyValue("--chat-prose-font")).toContain("Metis Anthropic Serif");
		expect(document.documentElement.style.getPropertyValue("--code-prose-font")).toContain("-apple-system");
		expect(document.documentElement.style.getPropertyValue("--content-font-size")).toBe("20px");
	});

	it("maps every stored font choice through a closed stack", () => {
		for (const [font, expected] of [
			["anthropic-serif", "Metis Anthropic Serif"],
			["system-serif", "Songti SC"],
			["system-sans", "-apple-system"],
		] as const) {
			applyGeneralPreferencesToDocument(
				{ motion: "system", chatFont: font, codeFont: font, contentFontSize: "15px" },
				{ matches: false },
			);
			expect(document.documentElement.style.getPropertyValue("--chat-prose-font")).toContain(expected);
			expect(document.documentElement.style.getPropertyValue("--code-prose-font")).toContain(expected);
		}
		localStorage.setItem(
			GENERAL_PREFERENCES_STORAGE_KEY,
			JSON.stringify({ chatFont: "url(https://invalid.example/font.woff2)", codeFont: "raw-font" }),
		);
		applyGeneralPreferencesToDocument(loadGeneralPreferences(localStorage), { matches: false });
		expect(document.documentElement.getAttribute("style")).not.toContain("invalid.example");
		expect(document.documentElement.getAttribute("style")).not.toContain("raw-font");
	});
});
