import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as legacyDiff from "../src/modes/interactive/components/diff.ts";
import * as legacyKeybindingHints from "../src/modes/interactive/components/keybinding-hints.ts";
import * as legacyVisualTruncate from "../src/modes/interactive/components/visual-truncate.ts";
import type { ThemeBg, ThemeColor } from "../src/modes/interactive/theme/theme.ts";
import * as legacyTheme from "../src/modes/interactive/theme/theme.ts";
import * as presentationDiff from "../src/presentation/diff.ts";
import * as presentationKeybindingHints from "../src/presentation/keybinding-hints.ts";
import * as presentationTheme from "../src/presentation/theme.ts";
import * as presentationVisualTruncate from "../src/presentation/visual-truncate.ts";

type RuntimeModule = Record<string, unknown>;

function expectSameRuntimeExports(legacy: RuntimeModule, canonical: RuntimeModule): void {
	const legacyNames = Object.keys(legacy).sort();
	const canonicalNames = Object.keys(canonical).sort();
	expect(legacyNames).toEqual(canonicalNames);
	for (const name of canonicalNames) {
		expect(legacy[name], name).toBe(canonical[name]);
	}
}

describe("presentation boundary", () => {
	beforeEach(() => {
		presentationTheme.initTheme("dark");
		presentationTheme.setRegisteredThemes([]);
	});

	afterEach(() => {
		presentationTheme.initTheme("dark");
		presentationTheme.setRegisteredThemes([]);
	});

	it("keeps theme implementation and proxy identity behind both paths", () => {
		expectSameRuntimeExports(legacyTheme, presentationTheme);
		expect(legacyTheme.Theme).toBe(presentationTheme.Theme);
		expect(legacyTheme.theme).toBe(presentationTheme.theme);
	});

	it("keeps keybinding hint function identity", () => {
		expectSameRuntimeExports(legacyKeybindingHints, presentationKeybindingHints);
		expect(legacyKeybindingHints.keyHint).toBe(presentationKeybindingHints.keyHint);
		expect(legacyKeybindingHints.rawKeyHint).toBe(presentationKeybindingHints.rawKeyHint);
	});

	it("keeps diff function identity", () => {
		expectSameRuntimeExports(legacyDiff, presentationDiff);
		expect(legacyDiff.renderDiff).toBe(presentationDiff.renderDiff);
	});

	it("keeps visual truncation function identity", () => {
		expectSameRuntimeExports(legacyVisualTruncate, presentationVisualTruncate);
		expect(legacyVisualTruncate.truncateToVisualLines).toBe(presentationVisualTruncate.truncateToVisualLines);
	});

	it("shares registered theme state and switching across both paths", () => {
		const customTheme = new presentationTheme.Theme(
			{ accent: "#ff0000", thinkingXhigh: "#00ff00" } as Record<ThemeColor, string | number>,
			{} as Record<ThemeBg, string | number>,
			"truecolor",
			{ name: "presentation-boundary-theme" },
		);

		legacyTheme.setRegisteredThemes([customTheme]);
		expect(presentationTheme.getThemeByName("presentation-boundary-theme")).toBe(customTheme);

		expect(presentationTheme.setTheme("presentation-boundary-theme")).toEqual({ success: true });
		expect(legacyTheme.theme.name).toBe("presentation-boundary-theme");
		expect(legacyTheme.theme.getFgAnsi("accent")).toBe(customTheme.getFgAnsi("accent"));

		const darkAccent = presentationTheme.getThemeByName("dark")?.getFgAnsi("accent");
		const lightAccent = presentationTheme.getThemeByName("light")?.getFgAnsi("accent");
		expect(darkAccent).toBeDefined();
		expect(lightAccent).toBeDefined();
		expect(darkAccent).not.toBe(lightAccent);

		expect(legacyTheme.setTheme("dark")).toEqual({ success: true });
		expect(presentationTheme.theme.getFgAnsi("accent")).toBe(darkAccent);

		expect(presentationTheme.setTheme("light")).toEqual({ success: true });
		expect(legacyTheme.theme.getFgAnsi("accent")).toBe(lightAccent);
	});
});
