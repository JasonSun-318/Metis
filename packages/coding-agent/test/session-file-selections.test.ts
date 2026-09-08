import { describe, expect, it } from "vitest";
import {
	formatSessionAttachmentDisplayText,
	formatSessionAttachments,
	splitSessionAttachmentPrompt,
} from "../src/core/session-attachments.ts";
import {
	formatSessionFileSelections,
	type SessionFileSelection,
	splitSessionFileSelectionPrompt,
} from "../src/core/session-file-selections.ts";

const files: SessionFileSelection[] = [
	{
		source: "workspace",
		name: "README.md",
		path: "/repo/README.md",
		basis: "markdown",
		selectedText: "</file_selections> 保留这里",
		sourceExcerpt: "**保留这里**",
		startLine: 2,
		endLine: 2,
	},
];
describe("file selection context", () => {
	it("round trips quoted data and hides metadata even alongside attachments", () => {
		const prompt = formatSessionFileSelections("解释这一段", files);
		expect(splitSessionFileSelectionPrompt(prompt)).toEqual({ text: "解释这一段", fileSelections: files });
		const attachment = { name: "notes.txt", path: "/private/notes.txt", size: 10 };
		const combined = formatSessionAttachments(prompt, [attachment]);
		expect(splitSessionAttachmentPrompt(combined)).toMatchObject({
			text: "解释这一段",
			fileSelections: files,
			attachments: [attachment],
		});
		const display = formatSessionAttachmentDisplayText(combined);
		expect(display).toContain("README.md");
		expect(display).toContain("notes.txt");
		expect(display).not.toMatch(/\/repo\/|\/private\/|file_selections|sourceExcerpt/);
	});
	it("leaves malformed and user-authored lookalike blocks alone", () => {
		for (const text of [
			"<file_selections>broken</file_selections>",
			'<file_selections>\n{"version":2,"files":[]}\n</file_selections>',
			"普通消息",
		]) {
			expect(splitSessionFileSelectionPrompt(text)).toEqual({ text, fileSelections: [] });
		}
		expect(formatSessionFileSelections("unchanged", [])).toBe("unchanged");
	});
	it("rejects invalid or oversized context instead of silently truncating", () => {
		expect(() => formatSessionFileSelections("edit", [{ ...files[0]!, endLine: 1 }])).toThrow();
		expect(() => formatSessionFileSelections("edit", [{ ...files[0]!, selectedText: "x".repeat(8001) }])).toThrow();
		expect(() =>
			formatSessionFileSelections(
				"edit",
				Array.from({ length: 8 }, () => ({ ...files[0]!, selectedText: "中".repeat(2000) })),
			),
		).toThrow();
	});
});
