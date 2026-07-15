import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type MemoryCommandContext = {
	settingsManager: {
		setAutoMemoryEnabled: (enabled: boolean) => void;
	};
	session: { refreshSystemPrompt: () => void };
	showStatus: (message: string) => void;
	showWarning: (message: string) => void;
};

type InteractiveModePrototype = {
	handleMemoryCommand(this: MemoryCommandContext, action: string): void;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

describe("InteractiveMode /memory", () => {
	it.each([
		["on", true, "Long-term memory enabled"],
		["off", false, "Long-term memory disabled"],
	] as const)("applies /memory %s immediately", (action, enabled, message) => {
		const setAutoMemoryEnabled = vi.fn();
		const refreshSystemPrompt = vi.fn();
		const showStatus = vi.fn();
		const showWarning = vi.fn();
		const context: MemoryCommandContext = {
			settingsManager: { setAutoMemoryEnabled },
			session: { refreshSystemPrompt },
			showStatus,
			showWarning,
		};

		prototype.handleMemoryCommand.call(context, action);

		expect(setAutoMemoryEnabled).toHaveBeenCalledWith(enabled);
		expect(refreshSystemPrompt).toHaveBeenCalledOnce();
		expect(showStatus).toHaveBeenCalledWith(message);
		expect(showWarning).not.toHaveBeenCalled();
	});

	it("rejects unknown arguments without changing state", () => {
		const setAutoMemoryEnabled = vi.fn();
		const refreshSystemPrompt = vi.fn();
		const showWarning = vi.fn();
		const context: MemoryCommandContext = {
			settingsManager: { setAutoMemoryEnabled },
			session: { refreshSystemPrompt },
			showStatus: vi.fn(),
			showWarning,
		};

		prototype.handleMemoryCommand.call(context, "maybe");

		expect(showWarning).toHaveBeenCalledWith("Usage: /memory [on|off]");
		expect(setAutoMemoryEnabled).not.toHaveBeenCalled();
		expect(refreshSystemPrompt).not.toHaveBeenCalled();
	});
});
