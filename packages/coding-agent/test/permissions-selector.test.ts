import { setKeybindings } from "@arcmind/tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { PermissionsSelectorComponent } from "../src/modes/interactive/components/permissions-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("PermissionsSelectorComponent", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("reuses the current SelectList style for Ask and Full", () => {
		const selector = new PermissionsSelectorComponent(
			{ mode: "ask" },
			() => {},
			() => {},
		);
		const output = stripAnsi(selector.render(100).join("\n"));

		expect(output).toContain("Ask before changes");
		expect(output).toContain("Full access");
		expect(output).toContain("Safe structured reads run directly");
		expect(output).not.toContain("Auto");
		expect(output).not.toContain("sandbox");
	});

	it("saves Ask or Full directly", () => {
		const onSave = vi.fn();
		const ask = new PermissionsSelectorComponent({ mode: "ask" }, onSave, () => {});
		ask.handleInput("\n");
		expect(onSave).toHaveBeenCalledWith({ mode: "ask" });

		const full = new PermissionsSelectorComponent({ mode: "ask" }, onSave, () => {});
		full.handleInput("\x1b[B");
		full.handleInput("\n");
		expect(onSave).toHaveBeenLastCalledWith({ mode: "full" });
	});

	it("cancels from the only selector screen", () => {
		const onCancel = vi.fn();
		const selector = new PermissionsSelectorComponent({ mode: "ask" }, () => {}, onCancel);
		selector.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledOnce();
	});
});
