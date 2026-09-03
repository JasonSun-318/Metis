import { describe, expect, it } from "vitest";
import {
	DEFAULT_AUTO_COMMAND_SUGGESTIONS,
	matchAutoCommandRule,
	normalizeAutoCommandRules,
	parseSimpleShellCommand,
} from "../../src/core/permissions/auto-command-rules.ts";

describe("Auto command rules", () => {
	it("parses one quote-aware simple command", () => {
		expect(parseSimpleShellCommand('git status --format="short value"')).toEqual([
			"git",
			"status",
			"--format=short value",
		]);
	});

	it.each(["ls > out", "ls | cat", "ls && pwd", "ls; pwd", "echo $(pwd)", "echo $HOME", "ls # note", "'unterminated"])(
		"rejects complex or dynamic shell source: %s",
		(source) => expect(parseSimpleShellCommand(source)).toBeUndefined(),
	);

	it("normalizes and freezes valid rules", () => {
		const rules = normalizeAutoCommandRules([
			{ command: "  git   status  ", allowNetwork: false },
			{ command: "curl", allowNetwork: true },
		]);
		expect(rules).toEqual([
			{ command: "git status", allowNetwork: false },
			{ command: "curl", allowNetwork: true },
		]);
		expect(Object.isFrozen(rules)).toBe(true);
	});

	it("rejects duplicate command prefixes even when network flags differ", () => {
		expect(() =>
			normalizeAutoCommandRules([
				{ command: "git status", allowNetwork: false },
				{ command: " git   status ", allowNetwork: true },
			]),
		).toThrow("duplicate Auto command rule");
	});

	it("rejects quoted argument phrases as stored rule prefixes", () => {
		expect(() => normalizeAutoCommandRules([{ command: 'grep "hello world"', allowNetwork: false }])).toThrow(
			"rule tokens must not contain whitespace",
		);
	});

	it("matches argv prefixes rather than raw string prefixes", () => {
		const rules = normalizeAutoCommandRules([
			{ command: "git", allowNetwork: true },
			{ command: "git status", allowNetwork: false },
		]);
		expect(matchAutoCommandRule("git status --short", rules)?.command).toBe("git status");
		expect(matchAutoCommandRule("git statusx", rules)?.command).toBe("git");
		expect(
			matchAutoCommandRule(
				"git statusx",
				normalizeAutoCommandRules([{ command: "git status", allowNetwork: false }]),
			),
		).toBeUndefined();
		expect(matchAutoCommandRule("/tmp/git status", rules)).toBeUndefined();
	});

	it("preserves empty quoted argv entries when matching prefixes", () => {
		const rules = normalizeAutoCommandRules([{ command: "git status", allowNetwork: false }]);
		expect(parseSimpleShellCommand("git '' status")).toEqual(["git", "", "status"]);
		expect(matchAutoCommandRule("git '' status", rules)).toBeUndefined();
		expect(parseSimpleShellCommand('git "st\\atus"')).toEqual(["git", "st\\atus"]);
	});

	it("ships only valid unique suggestions", () => {
		expect(DEFAULT_AUTO_COMMAND_SUGGESTIONS).toContain("ls");
		expect(DEFAULT_AUTO_COMMAND_SUGGESTIONS).toContain("git status");
		expect(new Set(DEFAULT_AUTO_COMMAND_SUGGESTIONS).size).toBe(DEFAULT_AUTO_COMMAND_SUGGESTIONS.length);
		for (const command of DEFAULT_AUTO_COMMAND_SUGGESTIONS) {
			expect(parseSimpleShellCommand(command)).toBeDefined();
		}
	});
});
