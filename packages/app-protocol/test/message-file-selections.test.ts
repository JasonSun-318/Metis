import { Compile } from "typebox/compile";
import { describe, expect, it } from "vitest";
import { ItemViewSchema, MessageFileSelectionViewSchema } from "../src/views.ts";

describe("sent file selection views", () => {
	const selection = { name: "AGENTS.md", source: "workspace", selectedText: "Quoted text", startLine: 1, endLine: 8 };
	it("accepts bounded previews and rejects private storage and slide addressing", () => {
		const schema = Compile(MessageFileSelectionViewSchema);
		expect(schema.Check(selection)).toBe(true);
		expect(schema.Check({ ...selection, path: "/private/work/AGENTS.md" })).toBe(false);
		expect(schema.Check({ ...selection, selectedText: "中".repeat(2048) })).toBe(false);
		expect(schema.Check({ ...selection, target: { kind: "pptx", page: 2, objectName: "Title" } })).toBe(true);
		expect(
			schema.Check({
				...selection,
				target: { kind: "pptx", page: 2, objectName: "Title", slidePath: "ppt/slides/slide2.xml" },
			}),
		).toBe(false);
	});
	it("keeps references optional and limits a message to eight cards", () => {
		const schema = Compile(ItemViewSchema);
		const item = {
			itemId: "user-1",
			sessionId: "11111111-1111-4111-8111-111111111111",
			role: "user",
			state: "completed",
			content: [],
			createdAt: "2026-10-15T00:00:00Z",
		};
		expect(schema.Check(item)).toBe(true);
		expect(schema.Check({ ...item, fileSelections: Array(8).fill(selection) })).toBe(true);
		expect(schema.Check({ ...item, fileSelections: Array(9).fill(selection) })).toBe(false);
	});
});
