import { describe, expect, it } from "vitest";
import { matchSlashCommand, type SlashCommandId } from "../src/modes/interactive/slash-command.ts";

function commandId(text: string): SlashCommandId | undefined {
	return matchSlashCommand(text)?.id;
}

describe("slash command matching", () => {
	it("matches exact commands", () => {
		expect(commandId("/settings")).toBe("settings");
		expect(commandId("/permissions")).toBe("permissions");
		expect(commandId("/scoped-models")).toBe("scoped-models");
		expect(commandId("/copy")).toBe("copy");
		expect(commandId("/session")).toBe("session");
		expect(commandId("/hotkeys")).toBe("hotkeys");
		expect(commandId("/fork")).toBe("fork");
		expect(commandId("/clone")).toBe("clone");
		expect(commandId("/tree")).toBe("tree");
		expect(commandId("/trust")).toBe("trust");
		expect(commandId("/logout")).toBe("logout");
		expect(commandId("/reload")).toBe("reload");
		expect(commandId("/debug")).toBe("debug");
		expect(commandId("/resume")).toBe("resume");
		expect(commandId("/quit")).toBe("quit");
	});

	it("accepts trailing arguments only for commands that take one", () => {
		for (const [text, expected] of [
			["/model", "model"],
			["/model sonnet", "model"],
			["/export out.json", "export"],
			["/import in.json", "import"],
			["/name my task", "name"],
			["/login anthropic", "login"],
			["/add-dir /tmp/work", "add-dir"],
			["/remove-dir /tmp/work", "remove-dir"],
			["/dirs extra", "dirs"],
			["/new code", "new"],
			["/compact instructions", "compact"],
			["/memory status", "memory"],
			["/dream now", "dream"],
		] as const) {
			expect(commandId(text)).toBe(expected);
		}
	});

	it("maps usage-warning variants separately", () => {
		expect(commandId("/schedule")).toBe("schedule");
		expect(commandId("/schedule tomorrow")).toBe("schedule-usage");
		expect(commandId("/mcp")).toBe("mcp");
		expect(commandId("/mcp add")).toBe("mcp-usage");
	});

	it("does not treat arguments as valid for exact-only commands", () => {
		expect(commandId("/settings now")).toBeUndefined();
		expect(commandId("/quit please")).toBeUndefined();
		expect(commandId("/hotkeys ")).toBeUndefined();
	});

	it("ignores non-commands and bash input", () => {
		expect(commandId("")).toBeUndefined();
		expect(commandId("hello")).toBeUndefined();
		expect(commandId("/unknown")).toBeUndefined();
		expect(commandId("!ls -la")).toBeUndefined();
		expect(commandId("//settings")).toBeUndefined();
		expect(commandId("/Settings")).toBeUndefined();
	});

	it("covers every declared command id", () => {
		const ids = new Set(
			[
				"/settings",
				"/permissions",
				"/scoped-models",
				"/model",
				"/export",
				"/import",
				"/copy",
				"/name",
				"/session",
				"/hotkeys",
				"/fork",
				"/clone",
				"/tree",
				"/trust",
				"/login",
				"/logout",
				"/add-dir",
				"/remove-dir",
				"/dirs",
				"/new",
				"/compact",
				"/memory",
				"/dream",
				"/schedule",
				"/schedule x",
				"/mcp",
				"/mcp x",
				"/reload",
				"/debug",
				"/resume",
				"/quit",
			].map((text) => commandId(text)),
		);
		expect(ids.size).toBe(31);
	});
});
