import type { AgentMessage } from "@metis/agent-core";
import {
	formatSize as agentFormatSize,
	sanitizeBinaryOutput as agentSanitizeBinaryOutput,
	truncateLine as agentTruncateLine,
} from "@metis/agent-core";
import type { Message } from "@metis/ai";
import { describe, expect, expectTypeOf, it } from "vitest";
import { type BashExecutionMessage, bashExecutionToText, convertToLlm } from "../src/core/messages.ts";
import { formatSize, GREP_MAX_LINE_LENGTH, truncateLine } from "../src/core/tools/truncate.ts";
import {
	convertToLlm as convertToLlmFromRoot,
	formatSize as formatSizeFromRoot,
	truncateLine as truncateLineFromRoot,
} from "../src/index.ts";
import { sanitizeBinaryOutput } from "../src/utils/shell.ts";

const loneHighSurrogate = String.fromCharCode(0xd83d);
const loneLowSurrogate = String.fromCharCode(0xde00);

const baseBashMessage: BashExecutionMessage = {
	role: "bashExecution",
	command: "npm test",
	output: "all good",
	exitCode: 0,
	cancelled: false,
	truncated: false,
	timestamp: 1_700_000_000_000,
};

const bashExpected = {
	withOutput: "Ran `npm test`\n```\nall good\n```",
	noOutput: "Ran `npm test`\n(no output)",
};

const formatSizeCases: Array<[number, string]> = [
	[-1, "-1B"],
	[-1024, "-1024B"],
	[-1536, "-1536B"],
	[0, "0B"],
	[1, "1B"],
	[1023, "1023B"],
	[1024, "1.0KB"],
	[1025, "1.0KB"],
	[1536, "1.5KB"],
	[1024 * 1024 - 1, "1024.0KB"],
	[1024 * 1024, "1.0MB"],
	[1024 * 1024 + 512 * 1024, "1.5MB"],
	[1.25 * 1024 * 1024, "1.3MB"],
	[10 * 1024 * 1024, "10.0MB"],
	[1024 * 1024 * 1024, "1024.0MB"],
];

const truncateLineCases: Array<[string, number | undefined, { text: string; wasTruncated: boolean }]> = [
	["abcdef", 3, { text: "abc... [truncated]", wasTruncated: true }],
	["abc", 3, { text: "abc", wasTruncated: false }],
	["abc", 0, { text: "... [truncated]", wasTruncated: true }],
	["", 0, { text: "", wasTruncated: false }],
	["abc", undefined, { text: "abc", wasTruncated: false }],
	["😀😀😀", 2, { text: "😀... [truncated]", wasTruncated: true }],
	["😀😀😀", 1, { text: `${loneHighSurrogate}... [truncated]`, wasTruncated: true }],
	["😀😀😀", 3, { text: `😀${loneHighSurrogate}... [truncated]`, wasTruncated: true }],
	["😀x", 3, { text: "😀x", wasTruncated: false }],
	["😀x", 2, { text: "😀... [truncated]", wasTruncated: true }],
];

const sanitizerCases: Array<[string, string]> = [
	["a\u0000b\u0001c\u0008d\u001fe\tf\ng\rh", "abcde\tf\ng\rh"],
	["\u0000\u0001\u001f", ""],
	["\u0009\u000a\u000d", "\u0009\u000a\u000d"],
	["del\u007f-c1\u0080\u009f", "del\u007f-c1\u0080\u009f"],
	["format\uFFF9-\uFFFA-\uFFFB-end", "format---end"],
	["kept\uFFF8\uFFFC\uFFFD", "kept\uFFF8\uFFFC\uFFFD"],
	["emoji\u{1F600}\u200D\u{1F469}\u{1F680}", "emoji\u{1F600}\u200D\u{1F469}\u{1F680}"],
	[`lone-high-${loneHighSurrogate}`, `lone-high-${loneHighSurrogate}`],
	[`lone-low-${loneLowSurrogate}`, `lone-low-${loneLowSurrogate}`],
];

describe("public helper compatibility", () => {
	describe("formatSize", () => {
		it.each(formatSizeCases)("formats %j bytes as %j", (bytes, expected) => {
			expect(formatSize(bytes)).toBe(expected);
			expect(formatSizeFromRoot(bytes)).toBe(expected);
			expect(agentFormatSize(bytes)).toBe(expected);
		});
	});

	describe("truncateLine", () => {
		it("keeps the public default character limit", () => {
			expect(GREP_MAX_LINE_LENGTH).toBe(500);
			expect(truncateLine("a".repeat(500))).toEqual({ text: "a".repeat(500), wasTruncated: false });
			expect(truncateLine("a".repeat(501))).toEqual({
				text: `${"a".repeat(500)}... [truncated]`,
				wasTruncated: true,
			});
			expect(truncateLine("a".repeat(501), undefined)).toEqual({
				text: `${"a".repeat(500)}... [truncated]`,
				wasTruncated: true,
			});
		});

		it.each(truncateLineCases)("truncates %j at %j", (line, maxChars, expected) => {
			expect(truncateLine(line, maxChars)).toEqual(expected);
			expect(truncateLineFromRoot(line, maxChars)).toEqual(expected);
			expect(agentTruncateLine(line, maxChars)).toEqual(expected);
		});
	});

	describe("bashExecutionToText", () => {
		it("formats output, missing output, exit codes, cancellation and truncation in order", () => {
			expect(bashExecutionToText(baseBashMessage)).toBe(bashExpected.withOutput);
			expect(bashExecutionToText({ ...baseBashMessage, output: "" })).toBe(bashExpected.noOutput);
			expect(bashExecutionToText({ ...baseBashMessage, exitCode: 2 })).toBe(
				`${bashExpected.withOutput}\n\nCommand exited with code 2`,
			);
			expect(bashExecutionToText({ ...baseBashMessage, exitCode: undefined })).toBe(bashExpected.withOutput);
			expect(bashExecutionToText({ ...baseBashMessage, cancelled: true })).toBe(
				`${bashExpected.withOutput}\n\n(command cancelled)`,
			);
			expect(
				bashExecutionToText({
					...baseBashMessage,
					cancelled: true,
					exitCode: 2,
					truncated: true,
					fullOutputPath: "/tmp/full.log",
				}),
			).toBe(`${bashExpected.withOutput}\n\n(command cancelled)\n\n[Output truncated. Full output: /tmp/full.log]`);
			expect(bashExecutionToText({ ...baseBashMessage, truncated: true })).toBe(bashExpected.withOutput);
			expect(bashExecutionToText({ ...baseBashMessage, truncated: true, fullOutputPath: "/tmp/full.log" })).toBe(
				`${bashExpected.withOutput}\n\n[Output truncated. Full output: /tmp/full.log]`,
			);
			expect(bashExecutionToText({ ...baseBashMessage, output: "", cancelled: true, exitCode: 1 })).toBe(
				`${bashExpected.noOutput}\n\n(command cancelled)`,
			);
		});
	});

	describe("sanitizeBinaryOutput", () => {
		it.each(sanitizerCases)("sanitizes %j as %j", (input, expected) => {
			expect(sanitizeBinaryOutput(input)).toBe(expected);
			expect(agentSanitizeBinaryOutput(input)).toBe(expected);
		});
	});

	describe("bash execution message conversion", () => {
		it("keeps the local bash message shape and skips excluded messages", () => {
			expect(convertToLlm([baseBashMessage])).toEqual([
				{
					role: "user",
					content: [{ type: "text", text: bashExpected.withOutput }],
					timestamp: baseBashMessage.timestamp,
				},
			]);
			expect(convertToLlm([{ ...baseBashMessage, excludeFromContext: true }])).toEqual([]);
			expect(convertToLlmFromRoot([baseBashMessage])).toEqual(convertToLlm([baseBashMessage]));
			expect(convertToLlmFromRoot([{ ...baseBashMessage, excludeFromContext: true }])).toEqual([]);
		});

		it("keeps explicit helper types and the local exclusion field", () => {
			expectTypeOf(formatSize).toEqualTypeOf<(bytes: number) => string>();
			expectTypeOf(truncateLine).toEqualTypeOf<
				(line: string, maxChars?: number) => { text: string; wasTruncated: boolean }
			>();
			expectTypeOf(sanitizeBinaryOutput).toEqualTypeOf<(str: string) => string>();
			expectTypeOf(bashExecutionToText).toEqualTypeOf<(msg: BashExecutionMessage) => string>();
			expectTypeOf(convertToLlm).toEqualTypeOf<(messages: AgentMessage[]) => Message[]>();
			expectTypeOf<BashExecutionMessage["role"]>().toEqualTypeOf<"bashExecution">();
			expectTypeOf<BashExecutionMessage["exitCode"]>().toEqualTypeOf<number | undefined>();
			expectTypeOf<BashExecutionMessage["fullOutputPath"]>().toEqualTypeOf<string | undefined>();
			expectTypeOf<BashExecutionMessage["excludeFromContext"]>().toEqualTypeOf<boolean | undefined>();
			expectTypeOf<Extract<AgentMessage, { role: "bashExecution" }>>().toEqualTypeOf<BashExecutionMessage>();

			const message: BashExecutionMessage = baseBashMessage;
			// @ts-expect-error bashExecution messages require the literal role.
			const invalidRole: BashExecutionMessage = { ...message, role: "bash" };
			// @ts-expect-error excludeFromContext is a boolean.
			const invalidExclusion: BashExecutionMessage = { ...message, excludeFromContext: "yes" };
			// @ts-expect-error output is required on bashExecution messages.
			const missingOutput: BashExecutionMessage = {
				role: "bashExecution",
				command: "npm test",
				exitCode: 0,
				cancelled: false,
				truncated: false,
				timestamp: 0,
			};
			expect(invalidRole.role).toBe("bash");
			expect(invalidExclusion.excludeFromContext).toBe("yes");
			expect(missingOutput.command).toBe("npm test");
		});
	});
});
