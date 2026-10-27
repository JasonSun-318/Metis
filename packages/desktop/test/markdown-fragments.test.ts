import { describe, expect, it } from "vitest";
import { selectMarkdownFragment } from "../src/renderer/components/markdown-fragments.ts";

describe("Markdown source fragments", () => {
	it("selects a heading and its children through the next same or higher heading", () => {
		const text = "# Intro\n\nstart\n\n## **Flow**\n\nbody\n\n### Detail\n\nchild\n\n## Other\n\nend";
		expect(selectMarkdownFragment(text, "Flow")).toBe("## **Flow**\n\nbody\n\n### Detail\n\nchild\n\n");
	});
	it("rejects duplicate headings and duplicate block IDs", () => {
		expect(() => selectMarkdownFragment("## Same\n\nfirst\n\n## Same\n\nsecond", "Same")).toThrow("Ambiguous");
		expect(() => selectMarkdownFragment("one ^id\n\ntwo ^id", "^id")).toThrow("Ambiguous");
	});
	it("selects paragraph, list and quote source blocks", () => {
		expect(selectMarkdownFragment("before\n\nDecision ^decision\n\nafter", "^decision")).toBe("Decision");
		expect(selectMarkdownFragment("- one\n- two\n\n^items\n\nafter", "^items")).toContain("- two");
		expect(selectMarkdownFragment("> quoted ^quote\n\nafter", "^quote")).toContain("> quoted");
	});
	it("ignores code and math locators and strips frontmatter without corrupting source text", () => {
		const text =
			"---\r\ntitle: A\r\n---\r\n\r\n```md\n## Fake\nx ^bad\n```\n\n$$\n## Fake\nx ^bad\n$$\n\nreal ^good\n";
		expect(() => selectMarkdownFragment(text, "Fake")).toThrow("not found");
		expect(() => selectMarkdownFragment(text, "^bad")).toThrow("not found");
		expect(selectMarkdownFragment(text, "^good")).toBe("real\n");
	});
});
