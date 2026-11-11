import type { AssistantMessage } from "@metis/ai";
import { Container, Markdown, Text } from "@metis/tui";
import { describe, expect, test, vi } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { UserMessageComponent } from "../src/modes/interactive/components/user-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(
	content: AssistantMessage["content"],
	overrides: Partial<Pick<AssistantMessage, "stopReason">> = {},
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: overrides.stopReason ?? "stop",
		timestamp: Date.now(),
	};
}

function contentChildren(component: AssistantMessageComponent) {
	const content = component.children[0];
	expect(content).toBeInstanceOf(Container);
	return (content as Container).children;
}

function markdownBlocks(component: AssistantMessageComponent): Markdown[] {
	return contentChildren(component).filter((child): child is Markdown => child instanceof Markdown);
}

function textBlocks(component: AssistantMessageComponent): Text[] {
	return contentChildren(component).filter((child): child is Text => child instanceof Text);
}

function renderLines(component: AssistantMessageComponent, width = 80): string[] {
	return component.render(width);
}

function renderFresh(message: AssistantMessage, hideThinkingBlock = false, outputPad = 1, width = 80): string[] {
	return new AssistantMessageComponent(message, hideThinkingBlock, undefined, "Thinking...", outputPad).render(width);
}

describe("AssistantMessageComponent", () => {
	test("removes terminal controls from model text, thinking, and errors while retaining UI markers", () => {
		initTheme("dark");
		const injected = "hello\x1b]52;c;VEVTVA==\x07\x1b[2J\x9b2J\x00world";
		const message = createAssistantMessage(
			[
				{ type: "text", text: injected },
				{ type: "thinking", thinking: injected },
			],
			{ stopReason: "error" },
		);
		message.errorMessage = injected;
		const rendered = new AssistantMessageComponent(message).render(100).join("\n");
		expect(rendered).not.toContain("\x1b]52;");
		expect(rendered).not.toContain("\x1b[2J");
		expect(rendered).not.toMatch(/[\x00\x9b]/u);
		expect(stripAnsi(rendered)).toContain("helloworld");
		expect(rendered).toContain(OSC133_ZONE_START);
		expect(message.content[0]).toEqual({ type: "text", text: injected });
	});

	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("renders length stops as visible errors", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([{ type: "thinking", thinking: "private reasoning" }], { stopReason: "length" }),
			true,
		);
		const rendered = component.render(80).join("\n");

		expect(rendered).toContain("Thinking...");
		expect(rendered).toContain("maximum output token limit");
		expect(rendered).toContain("response may be incomplete");
	});

	test("uses configured output padding for text and thinking", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "hello" },
				{ type: "thinking", thinking: "reasoning" },
			]),
			false,
			undefined,
			"Thinking...",
			1,
		);
		const lines = component.render(80).map((line) => stripAnsi(line));

		expect(lines.some((line) => line.includes(" hello"))).toBe(true);
		expect(lines.some((line) => line.includes(" reasoning"))).toBe(true);

		component.setOutputPad(0);
		const updatedLines = component.render(80).map((line) => stripAnsi(line));
		expect(updatedLines.some((line) => line.startsWith("hello"))).toBe(true);
		expect(updatedLines.some((line) => line.startsWith("reasoning"))).toBe(true);
	});

	test("reuses markdown blocks when content grows, shrinks, or the text is unchanged", () => {
		initTheme("dark");
		const setText = vi.spyOn(Markdown.prototype, "setText");
		try {
			const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "alpha" }]));
			const first = markdownBlocks(component)[0];
			expect(first).toBeInstanceOf(Markdown);
			setText.mockClear();

			component.updateContent(createAssistantMessage([{ type: "text", text: "  alpha\x1b[2J  " }]));
			expect(setText).not.toHaveBeenCalled();
			expect(markdownBlocks(component)).toHaveLength(1);
			expect(markdownBlocks(component)[0]).toBe(first);
			expect(renderLines(component)).toEqual(
				renderFresh(createAssistantMessage([{ type: "text", text: "  alpha\x1b[2J  " }])),
			);

			component.updateContent(
				createAssistantMessage([
					{ type: "text", text: "alpha" },
					{ type: "text", text: "beta" },
				]),
			);
			const grown = markdownBlocks(component);
			expect(grown).toHaveLength(2);
			expect(grown[0]).toBe(first);
			expect(grown[1]).not.toBe(first);
			expect(setText).not.toHaveBeenCalled();

			component.updateContent(
				createAssistantMessage([
					{ type: "text", text: "alpha!\x1b[2J" },
					{ type: "text", text: "beta" },
				]),
			);
			expect(setText).toHaveBeenCalledTimes(1);
			expect(setText).toHaveBeenCalledWith("alpha!");
			expect(markdownBlocks(component)[0]).toBe(first);
			expect(markdownBlocks(component)[1]).toBe(grown[1]);
			setText.mockClear();

			component.updateContent(createAssistantMessage([{ type: "text", text: "alpha!" }]));
			expect(markdownBlocks(component)).toHaveLength(1);
			expect(markdownBlocks(component)[0]).toBe(first);
			expect(setText).not.toHaveBeenCalled();
			expect(renderLines(component)).toEqual(
				renderFresh(createAssistantMessage([{ type: "text", text: "alpha!" }])),
			);

			component.updateContent(
				createAssistantMessage([
					{ type: "text", text: "alpha!" },
					{ type: "thinking", thinking: "  think\x00  " },
				]),
			);
			const withThinking = markdownBlocks(component);
			expect(withThinking[0]).toBe(first);
			expect(withThinking).toHaveLength(2);
			expect(setText).not.toHaveBeenCalled();

			component.updateContent(
				createAssistantMessage([
					{ type: "text", text: "alpha!" },
					{ type: "thinking", thinking: "think more" },
				]),
			);
			expect(setText).toHaveBeenCalledTimes(1);
			expect(setText).toHaveBeenCalledWith("think more");
			expect(markdownBlocks(component)[0]).toBe(first);
			expect(markdownBlocks(component)[1]).toBe(withThinking[1]);
			expect(renderLines(component)).toEqual(
				renderFresh(
					createAssistantMessage([
						{ type: "text", text: "alpha!" },
						{ type: "thinking", thinking: "think more" },
					]),
				),
			);
		} finally {
			setText.mockRestore();
		}
	});

	test("replaces markdown when a content block changes type", () => {
		initTheme("dark");
		const setText = vi.spyOn(Markdown.prototype, "setText");
		try {
			const component = new AssistantMessageComponent(
				createAssistantMessage([
					{ type: "text", text: "hello" },
					{ type: "thinking", thinking: "secret" },
				]),
			);
			const [textBlock, thinkingBlock] = markdownBlocks(component);
			setText.mockClear();

			const switched = createAssistantMessage([
				{ type: "thinking", thinking: "secret" },
				{ type: "text", text: "hello" },
			]);
			component.updateContent(switched);
			const afterSwitch = markdownBlocks(component);
			expect(afterSwitch).toHaveLength(2);
			expect(afterSwitch[0]).not.toBe(textBlock);
			expect(afterSwitch[0]).not.toBe(thinkingBlock);
			expect(afterSwitch[1]).not.toBe(textBlock);
			expect(afterSwitch[1]).not.toBe(thinkingBlock);
			expect(setText).not.toHaveBeenCalled();
			expect(renderLines(component)).toEqual(renderFresh(switched));

			const toolMessage = createAssistantMessage(
				[
					{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
					{ type: "text", text: "hello" },
				],
				{ stopReason: "error" },
			);
			toolMessage.errorMessage = "boom";
			component.updateContent(toolMessage);
			expect(markdownBlocks(component)).toHaveLength(1);
			expect(markdownBlocks(component)[0]).toBe(afterSwitch[1]);
			expect(textBlocks(component)).toHaveLength(0);
			expect(setText).not.toHaveBeenCalled();
			expect(renderLines(component, 60)).toEqual(renderFresh(toolMessage, false, 1, 60));
		} finally {
			setText.mockRestore();
		}
	});

	test("recreates thinking labels and error lines while reusing unchanged markdown", () => {
		initTheme("dark");
		const message = createAssistantMessage(
			[
				{ type: "thinking", thinking: "secret" },
				{ type: "text", text: "hello" },
			],
			{ stopReason: "error" },
		);
		message.errorMessage = "boom\x1b[2J";

		const hidden = new AssistantMessageComponent(message, true);
		const hiddenLabel = textBlocks(hidden)[0];
		const hiddenText = markdownBlocks(hidden)[0];
		hidden.updateContent(message);
		expect(textBlocks(hidden)[0]).not.toBe(hiddenLabel);
		expect(markdownBlocks(hidden)).toHaveLength(1);
		expect(markdownBlocks(hidden)[0]).toBe(hiddenText);
		expect(renderLines(hidden)).toEqual(renderFresh(message, true));

		const shown = new AssistantMessageComponent(message, false);
		const [thinkingBlock, textBlock] = markdownBlocks(shown);
		const errorLine = textBlocks(shown)[0];
		shown.updateContent(message);
		expect(markdownBlocks(shown)[0]).toBe(thinkingBlock);
		expect(markdownBlocks(shown)[1]).toBe(textBlock);
		expect(textBlocks(shown)[0]).not.toBe(errorLine);
		expect(renderLines(shown)).toEqual(renderFresh(message, false));

		shown.setHideThinkingBlock(true);
		expect(markdownBlocks(shown)).toHaveLength(1);
		expect(markdownBlocks(shown)[0]).toBe(textBlock);
		expect(renderLines(shown)).toEqual(renderFresh(message, true));

		shown.setOutputPad(0);
		expect(markdownBlocks(shown)[0]).not.toBe(textBlock);
		expect(renderLines(shown)).toEqual(renderFresh(message, true, 0));
	});

	test("streaming fence updates match a freshly built message", () => {
		initTheme("dark");
		const partial = createAssistantMessage([{ type: "text", text: "```ts\nconst x = 1;\n``" }]);
		const done = createAssistantMessage([{ type: "text", text: "```ts\nconst x = 1;\n```\n\ndone" }]);
		const component = new AssistantMessageComponent(partial);
		expect(renderLines(component, 40)).toEqual(renderFresh(partial, false, 1, 40));
		component.updateContent(done);
		expect(renderLines(component, 40)).toEqual(renderFresh(done, false, 1, 40));
	});

	test("uses configured output padding for user messages", () => {
		initTheme("dark");

		const paddedComponent = new UserMessageComponent("hello", undefined, 1);
		const paddedLines = paddedComponent.render(40).map((line) => stripAnsi(line));
		expect(paddedLines.some((line) => line.startsWith(" hello"))).toBe(true);

		const unpaddedComponent = new UserMessageComponent("hello", undefined, 0);
		const unpaddedLines = unpaddedComponent.render(40).map((line) => stripAnsi(line));
		expect(unpaddedLines.some((line) => line.startsWith("hello"))).toBe(true);
	});
});
