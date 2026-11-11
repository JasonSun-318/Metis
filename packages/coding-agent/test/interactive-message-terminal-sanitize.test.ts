import { Text } from "@metis/tui";
import { describe, expect, test } from "vitest";
import type { ParsedSkillBlock } from "../src/core/agent-session.ts";
import type { BranchSummaryMessage, CompactionSummaryMessage, CustomMessage } from "../src/core/messages.ts";
import { BranchSummaryMessageComponent } from "../src/modes/interactive/components/branch-summary-message.ts";
import { CompactionSummaryMessageComponent } from "../src/modes/interactive/components/compaction-summary-message.ts";
import { CustomMessageComponent } from "../src/modes/interactive/components/custom-message.ts";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

/** OSC 52, CSI erase, 8-bit CSI, and NUL embedded in otherwise visible text. */
const INJECTED = "hello\x1b]52;c;VEVTVA==\x07\x1b[2J\x9b2J\x00world";

function expectTerminalControlsRemoved(rendered: string): void {
	expect(rendered).not.toContain("\x1b]52;");
	expect(rendered).not.toContain("\x1b[2J");
	expect(rendered).not.toMatch(/[\x00\x9b]/u);
	expect(rendered).not.toContain("\r");
	expect(stripAnsi(rendered)).toContain("helloworld");
}

describe("interactive message body sanitization", () => {
	test("strips terminal controls from skill content and name without mutating the block", () => {
		initTheme("dark");
		const skill: ParsedSkillBlock = {
			name: INJECTED,
			location: "/tmp/skill",
			content: `before\r\n${INJECTED}`,
			skillText: INJECTED,
			userMessage: INJECTED,
		};
		const component = new SkillInvocationMessageComponent(skill);

		const collapsed = component.render(100).join("\n");
		expectTerminalControlsRemoved(collapsed);
		expect(stripAnsi(collapsed)).toContain("[skill]");
		expect(collapsed).toContain("\x1b[1m");
		expect(stripAnsi(collapsed)).toContain("to expand");

		component.setExpanded(true);
		const expanded = component.render(100).join("\n");
		expectTerminalControlsRemoved(expanded);
		expect(stripAnsi(expanded)).toContain("before");
		expect(skill.content).toBe(`before\r\n${INJECTED}`);
		expect(skill.name).toBe(INJECTED);
	});

	test("strips terminal controls from an expanded compaction summary", () => {
		initTheme("dark");
		const message: CompactionSummaryMessage = {
			role: "compactionSummary",
			summary: INJECTED,
			tokensBefore: 12,
			timestamp: 1,
		};
		const component = new CompactionSummaryMessageComponent(message);
		component.setExpanded(true);

		const rendered = component.render(100).join("\n");
		expectTerminalControlsRemoved(rendered);
		expect(stripAnsi(rendered)).toContain("Compacted from 12 tokens");
		expect(rendered).toContain("\x1b[1m");
		expect(message.summary).toBe(INJECTED);
	});

	test("strips terminal controls from an expanded branch summary", () => {
		initTheme("dark");
		const message: BranchSummaryMessage = {
			role: "branchSummary",
			summary: INJECTED,
			fromId: "branch-1",
			timestamp: 1,
		};
		const component = new BranchSummaryMessageComponent(message);
		component.setExpanded(true);

		const rendered = component.render(100).join("\n");
		expectTerminalControlsRemoved(rendered);
		expect(stripAnsi(rendered)).toContain("Branch Summary");
		expect(message.summary).toBe(INJECTED);
	});

	test("strips terminal controls from custom message text before markdown", () => {
		initTheme("dark");
		const stringMessage: CustomMessage = {
			role: "custom",
			customType: "note",
			content: INJECTED,
			display: true,
			timestamp: 1,
		};
		const stringRendered = new CustomMessageComponent(stringMessage).render(100).join("\n");
		expectTerminalControlsRemoved(stringRendered);
		expect(stripAnsi(stringRendered)).toContain("[note]");
		expect(stringMessage.content).toBe(INJECTED);

		const partsMessage: CustomMessage = {
			role: "custom",
			customType: "note",
			content: [
				{ type: "text", text: "hello\x1b[2J" },
				{ type: "image", data: "not-shown", mimeType: "image/png" },
				{ type: "text", text: "\x1b]52;c;VEVTVA==\x07world" },
			],
			display: true,
			timestamp: 1,
		};
		const partsRendered = new CustomMessageComponent(partsMessage).render(100).join("\n");
		expect(partsRendered).not.toContain("\x1b[2J");
		expect(partsRendered).not.toContain("\x1b]52;");
		expect(stripAnsi(partsRendered)).toContain("hello");
		expect(stripAnsi(partsRendered)).toContain("world");
		expect(partsMessage.content[0]).toEqual({ type: "text", text: "hello\x1b[2J" });
	});

	test("leaves extension-rendered custom messages on their own component", () => {
		initTheme("dark");
		const message: CustomMessage = {
			role: "custom",
			customType: "note",
			content: INJECTED,
			display: true,
			timestamp: 1,
		};
		const component = new CustomMessageComponent(message, () => new Text("rendered-by-extension", 0, 0));
		const rendered = component.render(80).join("\n");

		expect(rendered).toContain("rendered-by-extension");
		expect(message.content).toBe(INJECTED);
	});

	test("strips controls inside user text and keeps the outer OSC 133 markers", () => {
		initTheme("dark");
		const text = `hello\x1b]133;A\x07\x1b]52;c;VEVTVA==\x07\x1b[2J\x9b2J\x00\r\nworld`;
		const component = new UserMessageComponent(text);
		const lines = component.render(80);
		const rendered = lines.join("\n");

		expect(lines.length).toBeGreaterThanOrEqual(3);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[0]).not.toContain(OSC133_ZONE_END);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
		for (const line of lines.slice(1, -1)) {
			expect(line).not.toContain("\x1b]133;");
		}
		expect(rendered).not.toContain("\x1b]52;");
		expect(rendered).not.toContain("\x1b[2J");
		expect(rendered).not.toMatch(/[\x00\x9b]/u);
		expect(rendered).not.toContain("\r");
		expect(stripAnsi(rendered)).toContain("hello");
		expect(stripAnsi(rendered)).toContain("world");
		expect(text).toContain("\x1b]133;A");
	});
});
