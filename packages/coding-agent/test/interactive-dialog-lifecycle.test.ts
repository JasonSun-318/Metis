import { Container, Text } from "@metis/tui";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUIDialogOptions } from "../src/core/extensions/types.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

interface DialogHarness {
	showExtensionSelector(
		title: string,
		options: string[],
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined>;
	showExtensionInput(
		title: string,
		placeholder?: string,
		opts?: ExtensionUIDialogOptions,
	): Promise<string | undefined>;
	showExtensionEditor(title: string, text?: string): Promise<string | undefined>;
	resetExtensionUI(): void;
	hideExtensionSelector(): void;
	hideExtensionInput(): void;
	extensionSelector?: { handleInput(input: string): void };
	extensionInput?: { handleInput(input: string): void };
}

function harness(): DialogHarness {
	return Object.assign(Object.create(InteractiveMode.prototype), {
		runtimeHost: { session: { settingsManager: { getExternalEditorCommand: () => undefined } } },
		editor: new Text("editor"),
		editorContainer: new Container(),
		ui: { setFocus: vi.fn(), requestRender: vi.fn(), hideOverlay: vi.fn() },
		defaultEditor: {},
		footer: { invalidate: vi.fn() },
		footerDataProvider: { clearExtensionStatuses: vi.fn() },
		...Object.fromEntries(
			[
				"clearExtensionTerminalInputListeners",
				"setExtensionFooter",
				"setExtensionHeader",
				"clearExtensionWidgets",
				"setCustomEditorComponent",
				"setupAutocompleteProvider",
				"updateTerminalTitle",
				"setWorkingIndicator",
				"setHiddenThinkingLabel",
			].map((name) => [name, vi.fn()]),
		),
	});
}

beforeEach(() => {
	initTheme("dark");
	vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("extension dialog lifecycle", () => {
	it.each(["selector", "input", "editor"])("settles the pending %s on reset", async (kind) => {
		const mode = harness();
		const result =
			kind === "selector"
				? mode.showExtensionSelector("Choose", ["Yes"], { timeout: 10000 })
				: kind === "input"
					? mode.showExtensionInput("Input", undefined, { timeout: 10000 })
					: mode.showExtensionEditor("Edit", "text");
		mode.resetExtensionUI();
		await expect(result).resolves.toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});
	it("cancels a competing dialog without replacing the active selector", async () => {
		const mode = harness();
		const first = mode.showExtensionSelector("First", ["Yes"], { timeout: 10000 });
		const selector = mode.extensionSelector;
		const second = mode.showExtensionSelector("Second", ["No"]);
		expect(mode.extensionSelector).toBe(selector);
		await expect(second).resolves.toBeUndefined();
		await expect(mode.showExtensionInput("Input")).resolves.toBeUndefined();
		mode.hideExtensionSelector();
		await expect(first).resolves.toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("settles a hidden dialog and detaches its abort handler from later dialogs", async () => {
		const mode = harness();
		const controller = new AbortController();
		const first = mode.showExtensionInput("First", undefined, { signal: controller.signal, timeout: 10000 });
		mode.hideExtensionInput();
		await expect(first).resolves.toBeUndefined();
		const second = mode.showExtensionInput("Second");
		const input = mode.extensionInput;
		controller.abort();
		expect(mode.extensionInput).toBe(input);
		mode.hideExtensionInput();
		await expect(second).resolves.toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});
});
