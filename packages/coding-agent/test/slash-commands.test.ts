import { describe, expect, it } from "vitest";
import { getBuiltinSlashCommands } from "../src/core/slash-commands.ts";

describe("mode-scoped built-in slash commands", () => {
	it("shows directory commands only in Code mode", () => {
		const code = getBuiltinSlashCommands("code").map((command) => command.name);
		const chat = getBuiltinSlashCommands("chat").map((command) => command.name);
		for (const name of ["add-dir", "remove-dir", "dirs"]) {
			expect(code).toContain(name);
			expect(chat).not.toContain(name);
		}
	});
});
