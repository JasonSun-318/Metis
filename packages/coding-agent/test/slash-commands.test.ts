import { describe, expect, it } from "vitest";
import { BUILTIN_SLASH_COMMANDS, getBuiltinSlashCommands } from "../src/core/slash-commands.ts";

describe("built-in slash commands", () => {
	it("lists directory commands for every session", () => {
		const names = getBuiltinSlashCommands().map((command) => command.name);
		for (const name of ["add-dir", "remove-dir", "dirs"]) expect(names).toContain(name);
	});

	it("no longer exposes scheduled tasks or web-search flags", () => {
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "schedule")).toBe(false);
	});

	it("exposes /memory undo hint and drops /dream", () => {
		const memory = BUILTIN_SLASH_COMMANDS.find((command) => command.name === "memory");
		expect(memory?.argumentHint).toBe("[on|off|use on|off|contribute on|off|undo [id]|undo-run <runId>|dream]");
		expect(BUILTIN_SLASH_COMMANDS.some((command) => command.name === "dream")).toBe(false);
	});
});
