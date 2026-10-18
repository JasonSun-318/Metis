import { type Component, setCapabilities, setKeybindings } from "@metis/tui";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createLsToolDefinition } from "../src/core/tools/ls.ts";
import { DEFAULT_MAX_BYTES, formatSize, type TruncationResult } from "../src/core/tools/truncate.ts";
import { keyText } from "../src/modes/interactive/components/keybinding-hints.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const WIDTH = 10_000;

type ToolResult = {
	content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
};

type RenderOptions = {
	expanded?: boolean;
	showImages?: boolean;
	lastComponent?: Component;
};

const tools = [
	{
		name: "find",
		tool: createFindToolDefinition(process.cwd()),
		collapsedLines: 20,
		limitDetails: { resultLimitReached: 2 },
		limitWarning: "2 results limit",
	},
	{
		name: "grep",
		tool: createGrepToolDefinition(process.cwd()),
		collapsedLines: 15,
		limitDetails: { matchLimitReached: 2 },
		limitWarning: "2 matches limit",
	},
	{
		name: "ls",
		tool: createLsToolDefinition(process.cwd()),
		collapsedLines: 20,
		limitDetails: { entryLimitReached: 2 },
		limitWarning: "2 entries limit",
	},
] as const;

function renderResult(tool: ToolDefinition<any, any>, result: ToolResult, options: RenderOptions = {}): Component {
	const expanded = options.expanded ?? false;
	return tool.renderResult!(result as never, { expanded, isPartial: false }, theme, {
		args: {},
		toolCallId: "tool-1",
		invalidate: () => {},
		lastComponent: options.lastComponent,
		state: {},
		cwd: process.cwd(),
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded,
		showImages: options.showImages ?? true,
		isError: false,
	});
}

function visible(component: Component): string {
	return component
		.render(WIDTH)
		.map((line) => line.replace(/ +$/, ""))
		.join("\n");
}

function textResult(text: string, details?: unknown): ToolResult {
	return { content: [{ type: "text", text }], details };
}

function imageResult(): ToolResult {
	return { content: [{ type: "image", data: "abc", mimeType: "image/png" }] };
}

function mixedResult(): ToolResult {
	return {
		content: [
			{ type: "text", text: "before\nafter" },
			{ type: "image", data: "abc", mimeType: "image/png" },
		],
	};
}

function displayLines(lines: string[]): string {
	return lines.map((line) => theme.fg("toolOutput", line)).join("\n");
}

function truncation(maxBytes: number | undefined): TruncationResult {
	return {
		content: "",
		truncated: true,
		truncatedBy: "bytes",
		totalLines: 1,
		totalBytes: 100,
		outputLines: 0,
		outputBytes: 0,
		lastLinePartial: false,
		firstLineExceedsLimit: true,
		maxLines: 1,
		maxBytes: maxBytes as number,
	};
}

describe("list tool result rendering", () => {
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});

	beforeEach(() => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
	});

	for (const { name, tool, collapsedLines, limitDetails, limitWarning } of tools) {
		describe(name, () => {
			const lines = (count: number) => Array.from({ length: count }, (_, index) => `${name}-line-${index + 1}`);

			test("renders nothing for empty output", () => {
				expect(visible(renderResult(tool, { content: [], details: undefined }))).toBe("");
			});

			test("renders nothing for whitespace-only output", () => {
				expect(visible(renderResult(tool, textResult("\n  \n\t\n")))).toBe("");
			});

			test("trims output before splitting lines", () => {
				const rendered = visible(renderResult(tool, textResult("\n\n  alpha  \n beta  \n\n")));
				expect(rendered).toBe(`\n${displayLines(["alpha  ", " beta"])}`);
			});

			test(`renders exactly ${collapsedLines} lines without an expand hint`, () => {
				const body = lines(collapsedLines);
				const component = renderResult(tool, textResult(body.join("\n")));
				expect(visible(component)).toBe(`\n${displayLines(body)}`);
				expect(stripAnsi(visible(component))).not.toContain("to expand");
			});

			test(`collapses ${collapsedLines + 1} lines and shows the exact expand hint`, () => {
				const body = lines(collapsedLines + 1);
				const rendered = visible(renderResult(tool, textResult(body.join("\n"))));
				expect(stripAnsi(rendered)).toBe(
					`\n${body.slice(0, collapsedLines).join("\n")}\n... (1 more lines, ${keyText("app.tools.expand")} to expand)`,
				);
				expect(rendered).toContain(theme.fg("toolOutput", body[0]!));
				expect(rendered).toContain(theme.fg("muted", "... (1 more lines,"));
				expect(rendered).toContain(theme.fg("dim", keyText("app.tools.expand")));
				expect(rendered).toContain(theme.fg("muted", " to expand"));
				expect(rendered).toContain(theme.fg("muted", ")"));
			});

			test("renders every line when expanded", () => {
				const body = lines(collapsedLines + 3);
				const rendered = visible(renderResult(tool, textResult(body.join("\n")), { expanded: true }));
				expect(rendered).toBe(`\n${displayLines(body)}`);
				expect(stripAnsi(rendered)).not.toContain("to expand");
			});

			test("renders unique limit warning with the default byte limit", () => {
				const rendered = visible(
					renderResult(tool, {
						content: [{ type: "text", text: "one\ntwo" }],
						details: { ...limitDetails, truncation: truncation(undefined) },
					}),
				);
				expect(rendered).toBe(
					`\n${displayLines(["one", "two"])}\n${theme.fg("warning", `[Truncated: ${limitWarning}, ${formatSize(DEFAULT_MAX_BYTES)} limit]`)}`,
				);
			});

			test("renders custom maxBytes in the byte-limit warning", () => {
				const rendered = visible(
					renderResult(tool, textResult("one", { ...limitDetails, truncation: truncation(2048) })),
				);
				expect(rendered).toBe(
					`\n${displayLines(["one"])}\n${theme.fg("warning", `[Truncated: ${limitWarning}, 2.0KB limit]`)}`,
				);
			});

			test("renders image fallback for image-only results", () => {
				const rendered = visible(renderResult(tool, imageResult()));
				expect(rendered).toBe(`\n${displayLines(["[Image: [image/png]]"])}`);
			});

			test("appends image fallback after mixed text content", () => {
				const rendered = visible(renderResult(tool, mixedResult()));
				expect(rendered).toBe(`\n${displayLines(["before", "after", "[Image: [image/png]]"])}`);
			});

			test("honors showImages when the terminal supports inline images", () => {
				setCapabilities({ images: "kitty", trueColor: true, hyperlinks: false });

				expect(visible(renderResult(tool, imageResult(), { showImages: true }))).toBe("");
				expect(visible(renderResult(tool, imageResult(), { showImages: false }))).toBe(
					`\n${displayLines(["[Image: [image/png]]"])}`,
				);
				expect(visible(renderResult(tool, mixedResult(), { showImages: true }))).toBe(
					`\n${displayLines(["before", "after"])}`,
				);
				expect(visible(renderResult(tool, mixedResult(), { showImages: false }))).toBe(
					`\n${displayLines(["before", "after", "[Image: [image/png]]"])}`,
				);
			});

			test("reuses the previous Text component", () => {
				const first = renderResult(tool, textResult("first"));
				const second = renderResult(tool, textResult("second"), { lastComponent: first });

				expect(second).toBe(first);
				expect(visible(second)).toBe(`\n${displayLines(["second"])}`);
			});
		});
	}

	test("grep renders the linesTruncated warning", () => {
		const rendered = visible(renderResult(tools[1].tool, textResult("one", { linesTruncated: true })));
		expect(rendered).toBe(`\n${displayLines(["one"])}\n${theme.fg("warning", "[Truncated: some lines truncated]")}`);
	});

	test("grep combines truncation warnings in order", () => {
		const rendered = visible(
			renderResult(
				tools[1].tool,
				textResult("one", { matchLimitReached: 2, truncation: truncation(2048), linesTruncated: true }),
			),
		);
		expect(rendered).toBe(
			`\n${displayLines(["one"])}\n${theme.fg("warning", "[Truncated: 2 matches limit, 2.0KB limit, some lines truncated]")}`,
		);
	});
});
