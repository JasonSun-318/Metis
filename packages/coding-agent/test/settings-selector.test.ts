import { setKeybindings } from "@metis/tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import {
	type SettingsCallbacks,
	type SettingsConfig,
	SettingsSelectorComponent,
} from "../src/modes/interactive/components/settings-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const config = {
	autoCompact: true,
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
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("shows the disabled state", () => {
		const text = stripAnsi(new SettingsSelectorComponent(config, callbacks).render(120).join("\n"));
		expect(text).toContain("Web search");
		expect(text).toContain("Disabled");
		expect(text).not.toContain("Show images");
		expect(text).not.toContain("Image width");
		expect(text).not.toContain("Auto-resize images");
		expect(text).not.toContain("Block images");
	});

	it("routes provider and disable choices through one submenu", () => {
		const onWebSearchEnabledChange = vi.fn();
		const onWebSearchProviderChange = vi.fn();
		const testCallbacks = new Proxy(
			{ onWebSearchEnabledChange, onWebSearchProviderChange },
			{ get: (target, key) => Reflect.get(target, key) ?? (() => undefined) },
		) as unknown as SettingsCallbacks;

		const providerList = new SettingsSelectorComponent(config, testCallbacks).getSettingsList();
		providerList.handleInput("\x1b[B");
		providerList.handleInput("\r");
		expect(stripAnsi(providerList.render(120).join("\n"))).toContain("Brave Search");
		providerList.handleInput("\x1b[B");
		providerList.handleInput("\r");
		expect(onWebSearchProviderChange).toHaveBeenCalledWith("brave");

		const disabledList = new SettingsSelectorComponent(
			{ ...config, webSearchEnabled: true },
			testCallbacks,
		).getSettingsList();
		disabledList.handleInput("\x1b[B");
		disabledList.handleInput("\r");
		disabledList.handleInput("\x1b[A");
		disabledList.handleInput("\r");
		expect(onWebSearchEnabledChange).toHaveBeenCalledWith(false);
	});
});
