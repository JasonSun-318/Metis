import type { Keybinding } from "@metis/tui";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { ToolDefinition as HostToolDefinition } from "../src/host.ts";
import {
	keyHint as keyHintFromRoot,
	keyText as keyTextFromRoot,
	Theme as RootTheme,
	type ToolDefinition as RootToolDefinition,
	rawKeyHint as rawKeyHintFromRoot,
	renderDiff as renderDiffFromRoot,
	truncateToVisualLines as truncateToVisualLinesFromRoot,
} from "../src/index.ts";
import { type RenderDiffOptions, renderDiff } from "../src/modes/interactive/components/diff.ts";
import {
	type formatKeyText,
	type KeyTextFormatOptions,
	type keyDisplayText,
	keyHint,
	keyText,
	rawKeyHint,
} from "../src/modes/interactive/components/keybinding-hints.ts";
import {
	truncateToVisualLines,
	type VisualTruncateResult,
} from "../src/modes/interactive/components/visual-truncate.ts";
import {
	type getThemeByName,
	type initTheme,
	type onThemeChange,
	type setRegisteredThemes,
	setTheme,
	setThemeInstance,
	Theme,
	type ThemeBg,
	type ThemeColor,
	theme,
} from "../src/modes/interactive/theme/theme.ts";

describe("presentation public type contracts", () => {
	it("keeps the root and old theme path on the same class declaration", () => {
		expect(RootTheme).toBe(Theme);
		expectTypeOf<RootTheme>().toEqualTypeOf<Theme>();
		expectTypeOf(theme).toEqualTypeOf<Theme>();
	});

	it("keeps host-facing tool rendering on the canonical theme declaration", () => {
		expectTypeOf<HostToolDefinition>().toEqualTypeOf<RootToolDefinition>();
		type HostRenderCall = NonNullable<HostToolDefinition["renderCall"]>;
		expectTypeOf<Parameters<HostRenderCall>[1]>().toEqualTypeOf<Theme>();
	});

	it("keeps the old theme path function signatures explicit", () => {
		expectTypeOf<typeof initTheme>().toEqualTypeOf<(themeName?: string, enableWatcher?: boolean) => void>();
		expectTypeOf<typeof setTheme>().toEqualTypeOf<
			(name: string, enableWatcher?: boolean) => { success: boolean; error?: string }
		>();
		expectTypeOf<typeof setThemeInstance>().toEqualTypeOf<(themeInstance: Theme) => void>();
		expectTypeOf<typeof onThemeChange>().toEqualTypeOf<(callback: () => void) => void>();
		expectTypeOf<typeof setRegisteredThemes>().toEqualTypeOf<(themes: Theme[]) => void>();
		expectTypeOf<typeof getThemeByName>().toEqualTypeOf<(name: string) => Theme | undefined>();
		expectTypeOf<Theme["fg"]>().toEqualTypeOf<(color: ThemeColor, text: string) => string>();
		expectTypeOf<Theme["bg"]>().toEqualTypeOf<(color: ThemeBg, text: string) => string>();
		expectTypeOf<ReturnType<Theme["getColorMode"]>>().toEqualTypeOf<"truecolor" | "256color">();
	});

	it("keeps presentation helper signatures and root re-exports aligned", () => {
		expect(keyTextFromRoot).toBe(keyText);
		expect(keyHintFromRoot).toBe(keyHint);
		expect(rawKeyHintFromRoot).toBe(rawKeyHint);
		expect(renderDiffFromRoot).toBe(renderDiff);
		expect(truncateToVisualLinesFromRoot).toBe(truncateToVisualLines);

		expectTypeOf<typeof keyText>().toEqualTypeOf<(keybinding: Keybinding) => string>();
		expectTypeOf<typeof keyDisplayText>().toEqualTypeOf<(keybinding: Keybinding) => string>();
		expectTypeOf<typeof keyHint>().toEqualTypeOf<(keybinding: Keybinding, description: string) => string>();
		expectTypeOf<typeof rawKeyHint>().toEqualTypeOf<(key: string, description: string) => string>();
		expectTypeOf<typeof formatKeyText>().toEqualTypeOf<(key: string, options?: KeyTextFormatOptions) => string>();
		expectTypeOf<KeyTextFormatOptions>().toEqualTypeOf<{ capitalize?: boolean }>();
		expectTypeOf<typeof renderDiff>().toEqualTypeOf<(diffText: string, options?: RenderDiffOptions) => string>();
		expectTypeOf<RenderDiffOptions>().toEqualTypeOf<{ filePath?: string }>();
		expectTypeOf<typeof truncateToVisualLines>().toEqualTypeOf<
			(text: string, maxVisualLines: number, width: number, paddingX?: number) => VisualTruncateResult
		>();
		expectTypeOf<VisualTruncateResult>().toEqualTypeOf<{ visualLines: string[]; skippedCount: number }>();
	});

	it("rejects invalid presentation arguments", () => {
		const invalidColorString: string = "not-a-color";
		// @ts-expect-error ThemeColor is a closed union.
		const invalidColor: ThemeColor = invalidColorString;
		// @ts-expect-error truncateToVisualLines accepts at most four arguments.
		const tooManyTruncateArgs = () => truncateToVisualLines("text", 1, 80, 0, 0);
		// @ts-expect-error theme colors are a closed union.
		const invalidThemeColor = () => theme.fg("not-a-color", "text");
		// @ts-expect-error setThemeInstance requires a Theme instance.
		const invalidThemeInstance = () => setThemeInstance({});
		// @ts-expect-error the watcher flag is boolean.
		const invalidWatcherFlag = () => setTheme("dark", "yes");

		expect(invalidColor).toBe("not-a-color");
		expect(typeof tooManyTruncateArgs).toBe("function");
		expect(typeof invalidThemeColor).toBe("function");
		expect(typeof invalidThemeInstance).toBe("function");
		expect(typeof invalidWatcherFlag).toBe("function");
	});
});
