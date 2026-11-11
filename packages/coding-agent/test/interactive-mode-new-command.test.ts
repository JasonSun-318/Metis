import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { canonicalizePath } from "../src/utils/paths.ts";

type NewCommandContext = {
	guardSessionMutation: () => boolean;
	handleClearCommand: (cwd?: string) => Promise<void>;
	showError: (message: string) => void;
	showExtensionSelector: (title: string, options: string[]) => Promise<string | undefined>;
	showExtensionInput: (title: string, placeholder?: string) => Promise<string | undefined>;
	runtimeHost: { terminalCwd: string };
};

type InteractiveModePrototype = {
	handleNewSessionCommand(this: NewCommandContext, text: string): Promise<void>;
};

const prototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function context(selections: Array<string | undefined>, terminalCwd = process.cwd()) {
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

	it("offers the managed, terminal, and other workspace options", async () => {
		const terminalCwd = process.cwd();
		const terminal = `Terminal working directory (${terminalCwd})`;
		const test = context(["Metis managed workspace"], terminalCwd);

		await prototype.handleNewSessionCommand.call(test.value, "/new");

		expect(test.showExtensionSelector).toHaveBeenCalledWith("New session workspace", [
			"Metis managed workspace",
			terminal,
			"Other directory",
		]);
		expect(test.handleClearCommand).toHaveBeenCalledWith(undefined);
	});

	it("creates the session in the terminal cwd when selected", async () => {
		const terminalCwd = process.cwd();
		const terminal = `Terminal working directory (${terminalCwd})`;
		const test = context([terminal], terminalCwd);

		await prototype.handleNewSessionCommand.call(test.value, "/new");

		expect(test.handleClearCommand).toHaveBeenCalledWith(terminalCwd);
	});

	it("validates an entered directory before replacing the session", async () => {
		const directory = mkdtempSync(join(tmpdir(), "metis-new-command-"));
		tempDirs.push(directory);
		const test = context(["Other directory", directory]);

		await prototype.handleNewSessionCommand.call(test.value, "/new");

		expect(test.showExtensionInput).toHaveBeenCalledWith("Directory", process.cwd());
		expect(test.handleClearCommand).toHaveBeenCalledWith(canonicalizePath(directory));
	});

	it("rejects arguments and cancels without replacing the active session", async () => {
		const withArgument = context(["Metis managed workspace"]);
		await prototype.handleNewSessionCommand.call(withArgument.value, "/new chat");
		expect(withArgument.showError).toHaveBeenCalledWith("Usage: /new");
		expect(withArgument.handleClearCommand).not.toHaveBeenCalled();

		const cancelled = context([undefined]);
		await prototype.handleNewSessionCommand.call(cancelled.value, "/new");
		expect(cancelled.handleClearCommand).not.toHaveBeenCalled();
	});
});
