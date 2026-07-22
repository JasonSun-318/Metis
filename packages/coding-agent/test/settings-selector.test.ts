import { beforeAll, describe, expect, it } from "vitest";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const config = {
	autoCompact: true,
	showImages: true,
	imageWidthCells: 60,
	autoResizeImages: true,
	blockImages: false,
	enableSkillCommands: true,
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	transport: "auto",
	httpIdleTimeoutMs: 300_000,
	thinkingSelection: "medium",
	availableThinkingSelections: ["off", "medium"],
	currentTheme: "dark",
	terminalTheme: "dark",
	availableThemes: ["dark"],
	hideThinkingBlock: false,
	showCacheMissNotices: false,
	enableProviderAttribution: false,
	doubleEscapeAction: "tree",
	treeFilterMode: "default",
	showHardwareCursor: false,
	editorPaddingX: 0,
	outputPad: 1,
	autocompleteMaxVisible: 5,
	quietStartup: false,
	defaultProjectTrust: "ask",
	clearOnShrink: false,
	showTerminalProgress: false,
	webSearchEnabled: false,
	webSearchProvider: "brave",
} satisfies SettingsConfig;

const callbacks = new Proxy({}, { get: () => () => undefined }) as SettingsCallbacks;

describe("settings selector web search controls", () => {
	beforeAll(() => initTheme("dark"));

	it("shows enablement and selected provider", () => {
		const text = stripAnsi(new SettingsSelectorComponent(config, callbacks).render(120).join("\n"));
		expect(text).toContain("Web search");
		expect(text).toContain("false");
		expect(text).toContain("Brave Search");
	});
});
