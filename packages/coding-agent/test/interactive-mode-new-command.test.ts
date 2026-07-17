import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentMode } from "../src/core/agent-mode.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { canonicalizePath } from "../src/utils/paths.ts";

type NewCommandContext = {
	guardSessionMutation: () => boolean;
	handleClearCommand: (mode?: AgentMode, cwd?: string) => Promise<void>;
	showError: (message: string) => void;
	showExtensionSelector: (title: string, options: string[]) => Promise<string | undefined>;
	showExtensionInput: (title: string, placeholder?: string) => Promise<string | undefined>;
	sessionManager: { getMode(): AgentMode };
	runtimeHost: { terminalCwd: string };
};

type InteractiveModePrototype = {
	handleNewSessionCommand(this: NewCommandContext, text: string): Promise<void>;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function context(selections: Array<string | undefined>, mode: AgentMode = "code", terminalCwd = process.cwd()) {
	const handleClearCommand = vi.fn(async () => {});
	const showError = vi.fn();
	const showExtensionSelector = vi.fn(async () => selections.shift());
	const showExtensionInput = vi.fn(async () => selections.shift());
	return {
		value: {
			guardSessionMutation: () => false,
			handleClearCommand,
			showError,
			showExtensionSelector,
			showExtensionInput,
			sessionManager: { getMode: () => mode },
			runtimeHost: { terminalCwd },
		} satisfies NewCommandContext,
		handleClearCommand,
		showError,
		showExtensionSelector,
		showExtensionInput,
	};
}

describe("InteractiveMode /new", () => {
	const tempDirs: string[] = [];
	afterEach(() => {
		while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
	});

	it("chooses mode first and keeps the current mode first", async () => {
		const test = context(["Chat", "ArcMind managed workspace"], "chat");

		await prototype.handleNewSessionCommand.call(test.value, "/new");

		expect(test.showExtensionSelector).toHaveBeenNthCalledWith(1, "New session mode", ["Chat", "Code"]);
		expect(test.handleClearCommand).toHaveBeenCalledWith("chat", undefined);
	});

	it("creates Chat in the captured terminal cwd when selected", async () => {
		const terminalCwd = process.cwd();
		const terminal = `Terminal working directory (${terminalCwd})`;
		const test = context([terminal], "code", terminalCwd);

		await prototype.handleNewSessionCommand.call(test.value, "/new chat");

		expect(test.showExtensionSelector).toHaveBeenCalledWith("Chat workspace", [
			"ArcMind managed workspace",
			terminal,
			"Other directory",
		]);
		expect(test.handleClearCommand).toHaveBeenCalledWith("chat", terminalCwd);
	});

	it("offers only terminal or another directory for Code", async () => {
		const terminalCwd = process.cwd();
		const terminal = `Terminal working directory (${terminalCwd})`;
		const test = context([terminal], "chat", terminalCwd);

		await prototype.handleNewSessionCommand.call(test.value, "/new code");

		expect(test.showExtensionSelector).toHaveBeenCalledWith("Code workspace", [terminal, "Other directory"]);
		expect(test.handleClearCommand).toHaveBeenCalledWith("code", terminalCwd);
	});

	it("validates an entered directory before replacing the session", async () => {
		const directory = mkdtempSync(join(tmpdir(), "arcmind-new-command-"));
		tempDirs.push(directory);
		const test = context(["Other directory", directory]);

		await prototype.handleNewSessionCommand.call(test.value, "/new code");

		expect(test.showExtensionInput).toHaveBeenCalledWith("Directory", process.cwd());
		expect(test.handleClearCommand).toHaveBeenCalledWith("code", canonicalizePath(directory));
	});

	it("cancels without replacing the active session", async () => {
		const test = context([undefined]);

		await prototype.handleNewSessionCommand.call(test.value, "/new");

		expect(test.handleClearCommand).not.toHaveBeenCalled();
	});

	it("rejects an unknown mode", async () => {
		const test = context([]);

		await prototype.handleNewSessionCommand.call(test.value, "/new focus");

		expect(test.showError).toHaveBeenCalledWith("Usage: /new [chat|code]");
		expect(test.handleClearCommand).not.toHaveBeenCalled();
	});
});
