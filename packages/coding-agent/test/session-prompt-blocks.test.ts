import { describe, expect, it } from "vitest";
import { replaceVersionedPromptBlock } from "../src/core/session-prompt-blocks.ts";

const instructions = "shared strict block instructions";
const selectionBlock = (files: unknown) =>
	`<file_selections>\n${JSON.stringify({ version: 1, instructions, files })}\n</file_selections>`;
const stringItems = (value: unknown): string[] => {
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new TypeError("invalid items");
	return value;
};

describe("strict prompt block replacement", () => {
	it("replaces parsed items through an explicit readItems adapter", () => {
		const text = `before ${selectionBlock(["a", "b"])} after`;

		expect(
			replaceVersionedPromptBlock(
				text,
				"file_selections",
				instructions,
				"files",
				stringItems,
				(items) => `[${items.join("+")}]`,
			),
		).toBe("before [a+b] after");
	});
	it("preserves the original block when the replacement callback throws", () => {
		const block = selectionBlock(["a"]);
		let called = false;

		expect(
			replaceVersionedPromptBlock(block, "file_selections", instructions, "files", stringItems, () => {
				called = true;
				throw new Error("replacement failed");
			}),
		).toBe(block);
		expect(called).toBe(true);
	});
	it("preserves the original block when readItems rejects the parsed value", () => {
		const block = selectionBlock(["a"]);
		let replaced = false;

		expect(
			replaceVersionedPromptBlock(
				block,
				"file_selections",
				instructions,
				"files",
				() => {
					throw new TypeError("invalid items");
				},
				() => {
					replaced = true;
					return "replaced";
				},
			),
		).toBe(block);
		expect(replaced).toBe(false);
	});
	it("supports the conversation quote tag and key without changing the shared mechanics", () => {
		const block = `<conversation_quotes>\n${JSON.stringify({
			version: 1,
			instructions,
			quotes: ["q"],
		})}\n</conversation_quotes>`;

		expect(
			replaceVersionedPromptBlock(block, "conversation_quotes", instructions, "quotes", stringItems, (items) =>
				items.join("|"),
			),
		).toBe("q");
	});
});
