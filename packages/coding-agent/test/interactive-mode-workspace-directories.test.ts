import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type Context = {
	guardSessionMutation: () => boolean;
	sessionManager: {
		getMode(): "chat" | "code";
		getWorkspaceRoots(): readonly string[];
		addWorkspaceDirectory(path: string): { path: string; changed: boolean };
		removeWorkspaceDirectory(path: string): { path: string; changed: boolean };
	};
	session: { refreshSystemPrompt(): void };
	showStatus(message: string): void;
	showWarning(message: string): void;
	showError(message: string): void;
};

type Prototype = {
	getWorkspaceDirectoryCommandArgument(
		this: unknown,
		text: string,
		command: "/add-dir" | "/remove-dir",
	): string | undefined;
	handleAddDirectoryCommand(this: Context, inputPath: string | undefined): void;
	handleRemoveDirectoryCommand(this: Context, inputPath: string | undefined): void;
	handleDirectoriesCommand(this: Context, argument: string): void;
};

const prototype = InteractiveMode.prototype as unknown as Prototype;

function context(mode: "chat" | "code" = "code") {
	return {
		guardSessionMutation: vi.fn(() => false),
		sessionManager: {
			getMode: () => mode,
			getWorkspaceRoots: () => ["/project", "/external"],
			addWorkspaceDirectory: vi.fn(() => ({ path: "/external", changed: true })),
			removeWorkspaceDirectory: vi.fn(() => ({ path: "/external", changed: true })),
		},
		session: { refreshSystemPrompt: vi.fn() },
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
	} satisfies Context;
}

describe("InteractiveMode Code workspace directory commands", () => {
	it("parses the complete single path and strips matching outer quotes", () => {
		expect(prototype.getWorkspaceDirectoryCommandArgument.call({}, "/add-dir /tmp/shared dir", "/add-dir")).toBe(
			"/tmp/shared dir",
		);
		expect(
			prototype.getWorkspaceDirectoryCommandArgument.call({}, '/remove-dir "/tmp/shared dir"', "/remove-dir"),
		).toBe("/tmp/shared dir");
		expect(prototype.getWorkspaceDirectoryCommandArgument.call({}, "/add-dir", "/add-dir")).toBeUndefined();
	});

	it("adds and removes once while refreshing the model prompt only for changes", () => {
		const value = context();
		prototype.handleAddDirectoryCommand.call(value, "/external");
		expect(value.sessionManager.addWorkspaceDirectory).toHaveBeenCalledWith("/external");
		expect(value.session.refreshSystemPrompt).toHaveBeenCalledOnce();
		expect(value.showStatus).toHaveBeenCalledWith("Added working directory: /external");

		value.sessionManager.addWorkspaceDirectory.mockReturnValueOnce({ path: "/external", changed: false });
		prototype.handleAddDirectoryCommand.call(value, "/external");
		expect(value.session.refreshSystemPrompt).toHaveBeenCalledOnce();
		expect(value.showStatus).toHaveBeenCalledWith("Working directory already added: /external");

		prototype.handleRemoveDirectoryCommand.call(value, "/external");
		expect(value.session.refreshSystemPrompt).toHaveBeenCalledTimes(2);
		expect(value.showStatus).toHaveBeenCalledWith("Removed working directory: /external");
	});

	it("rejects the commands in Chat before mutating state", () => {
		const value = context("chat");
		prototype.handleAddDirectoryCommand.call(value, "/external");
		prototype.handleRemoveDirectoryCommand.call(value, "/external");
		prototype.handleDirectoriesCommand.call(value, "");
		expect(value.sessionManager.addWorkspaceDirectory).not.toHaveBeenCalled();
		expect(value.sessionManager.removeWorkspaceDirectory).not.toHaveBeenCalled();
		expect(value.showWarning).toHaveBeenCalledTimes(3);
		expect(value.showWarning).toHaveBeenCalledWith("Additional directories are only available in Code mode");
	});

	it("shows usage, missing removal, and the complete root list", () => {
		const value = context();
		value.sessionManager.removeWorkspaceDirectory.mockReturnValueOnce({ path: "/missing", changed: false });
		prototype.handleAddDirectoryCommand.call(value, undefined);
		prototype.handleRemoveDirectoryCommand.call(value, "/missing");
		prototype.handleDirectoriesCommand.call(value, "");
		prototype.handleDirectoriesCommand.call(value, "extra");
		expect(value.showWarning).toHaveBeenCalledWith("Usage: /add-dir <path>");
		expect(value.showWarning).toHaveBeenCalledWith("Usage: /dirs");
		expect(value.showStatus).toHaveBeenCalledWith("Working directory was not added: /missing");
		expect(value.showStatus).toHaveBeenCalledWith("Working directories:\n- /project (primary)\n- /external");
	});

	it("does not mutate roots while the session mutation guard is active", () => {
		const value = context();
		value.guardSessionMutation.mockReturnValue(true);
		prototype.handleAddDirectoryCommand.call(value, "/external");
		prototype.handleRemoveDirectoryCommand.call(value, "/external");
		expect(value.sessionManager.addWorkspaceDirectory).not.toHaveBeenCalled();
		expect(value.sessionManager.removeWorkspaceDirectory).not.toHaveBeenCalled();
	});
});
