import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS, getBuiltinSlashCommands } from "../src/core/slash-commands.ts";

describe("mode-scoped built-in slash commands", () => {
	it("shows directory commands only in Code mode", () => {
		const code = getBuiltinSlashCommands("code").map((command) => command.name);
		const chat = getBuiltinSlashCommands("chat").map((command) => command.name);
		for (const name of ["add-dir", "remove-dir", "dirs"]) {
			expect(code).toContain(name);
			expect(chat).not.toContain(name);
		}
	});

	it("exposes /memory undo hint and drops /dream", () => {
		const memory = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "memory");
		expect(memory?.argumentHint).toBe("[on|off|use on|off|contribute on|off|undo [id]|dream]");
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "dream")).toBe(false);
	});
});
