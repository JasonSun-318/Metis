import { setKeybindings } from "@arcmind/tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { PermissionsSelectorComponent } from "../src/modes/interactive/components/permissions-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("PermissionsSelectorComponent", () => {
	beforeAll(() => initTheme("dark"));
	beforeEach(() => setKeybindings(new KeybindingsManager()));

	it("reuses the current SelectList style and descriptions", () => {
		const selector = new PermissionsSelectorComponent(
			{ mode: "ask", reviewerEnabled: true },
			() => {},
			() => {},
		);

		const output = stripAnsi(selector.render(100).join("\n"));

		expect(output).toContain("Ask before changes");
		expect(output).toContain("Auto with review");
		expect(output).toContain("Full access");
		expect(output).toContain("Read in a sandbox");
	});

	it("saves Ask or Full directly", () => {
		const onSave = vi.fn();
		const selector = new PermissionsSelectorComponent({ mode: "ask", reviewerEnabled: false }, onSave, () => {});

		selector.handleInput("\n");

		expect(onSave).toHaveBeenCalledWith({ mode: "ask", reviewerEnabled: false });
	});

	it("selects reviewer state as a second Auto list", () => {
		const onSave = vi.fn();
		const selector = new PermissionsSelectorComponent({ mode: "auto", reviewerEnabled: true }, onSave, () => {});

		selector.handleInput("\n");
		expect(stripAnsi(selector.render(100).join("\n"))).toContain("Reviewer enabled");
		selector.handleInput("\x1b[B");
		selector.handleInput("\n");

		expect(onSave).toHaveBeenCalledWith({ mode: "auto", reviewerEnabled: false });
	});

	it("returns from reviewer choices before cancelling the whole selector", () => {
		const onCancel = vi.fn();
		const selector = new PermissionsSelectorComponent({ mode: "auto", reviewerEnabled: true }, () => {}, onCancel);

		selector.handleInput("\n");
		selector.handleInput("\x1b");
		expect(onCancel).not.toHaveBeenCalled();
		expect(stripAnsi(selector.render(100).join("\n"))).toContain("Auto with review");
		selector.handleInput("\x1b");

		expect(onCancel).toHaveBeenCalledOnce();
	});
});
