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
	});

	it("falls back field-by-field when persisted JSON is missing or invalid", () => {
		expect(loadGeneralPreferences(localStorage)).toEqual(DEFAULT_GENERAL_PREFERENCES);
		localStorage.setItem(
			GENERAL_PREFERENCES_STORAGE_KEY,
			JSON.stringify({ motion: "reduced", chatFont: "unknown", codeFont: "system-serif" }),
		);
		expect(loadGeneralPreferences(localStorage)).toEqual({
			motion: "reduced",
			chatFont: "anthropic-serif",
			codeFont: "system-serif",
		});
		localStorage.setItem(GENERAL_PREFERENCES_STORAGE_KEY, "{");
		expect(loadGeneralPreferences(localStorage)).toEqual(DEFAULT_GENERAL_PREFERENCES);
	});

	it("persists one versioned document", () => {
		const value = { motion: "system", chatFont: "system-sans", codeFont: "anthropic-serif" } as const;
		saveGeneralPreferences(localStorage, value);
		expect(JSON.parse(localStorage.getItem(GENERAL_PREFERENCES_STORAGE_KEY)!)).toEqual(value);
	});

	it("resolves system motion and applies resolved motion plus separate font stacks", () => {
		expect(resolveReducedMotion("system", { matches: true })).toBe(true);
		expect(resolveReducedMotion("system", { matches: false })).toBe(false);
		expect(resolveReducedMotion("reduced", { matches: false })).toBe(true);
		applyGeneralPreferencesToDocument(
			{ motion: "reduced", chatFont: "anthropic-serif", codeFont: "system-sans" },
			{ matches: false },
		);
		expect(document.documentElement.dataset.motion).toBe("reduced");
		expect(document.documentElement.style.getPropertyValue("--chat-prose-font")).toContain("Metis Anthropic Serif");
		expect(document.documentElement.style.getPropertyValue("--code-prose-font")).toContain("-apple-system");
	});
});
