import { setKeybindings } from "@metis/tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { PermissionsSelectorComponent } from "../src/modes/interactive/components/permissions-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("PermissionsSelectorComponent", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("reuses the current SelectList style for Ask, Auto, and Full", () => {
		const selector = new PermissionsSelectorComponent(
			"ask",
			() => {},
			() => {},
		);
		const output = stripAnsi(selector.render(100).join("\n"));

		expect(output).toContain("Ask");
		expect(output).toContain("Auto");
		expect(output).toContain("Full");
		expect(output).toContain("workspace sandbox");
		expect(output).toContain("Runs without a sandbox or tool approvals");
		expect(output).not.toContain("no Metis approval");
	});

	it("saves Ask, Auto, or Full directly", () => {
		const onSave = vi.fn();
		const ask = new PermissionsSelectorComponent("ask", onSave, () => {});
		ask.handleInput("\n");
		expect(onSave).toHaveBeenCalledWith("ask");

		const auto = new PermissionsSelectorComponent("ask", onSave, () => {});
		auto.handleInput("\x1b[B");
		auto.handleInput("\n");
		expect(onSave).toHaveBeenLastCalledWith("auto");

		const full = new PermissionsSelectorComponent("ask", onSave, () => {});
		full.handleInput("\x1b[B");
		full.handleInput("\x1b[B");
		full.handleInput("\n");
		expect(onSave).toHaveBeenLastCalledWith("full");
	});

	it("cancels from the only selector screen", () => {
		const onCancel = vi.fn();
		const selector = new PermissionsSelectorComponent("ask", () => {}, onCancel);
		selector.handleInput("\x1b");
		expect(onCancel).toHaveBeenCalledOnce();
	});
});
