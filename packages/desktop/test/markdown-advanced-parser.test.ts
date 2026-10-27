import { readFileSync } from "node:fs";
import type { Token } from "marked";
import { marked } from "marked";
import { describe, expect, it } from "vitest";
import { lexMarkdownBlocks } from "../src/renderer/components/markdown-lexer.ts";
import { lexMarkdown, markdownDocumentDefSalt } from "../src/renderer/components/markdown-parser.ts";

const syntaxFixtures = JSON.parse(
	readFileSync(new URL("../../coding-agent/test/fixtures/knowledge-markdown-advanced.json", import.meta.url), "utf8"),
) as { source: string; targets: string[] }[];
it.each(syntaxFixtures)("keeps rendered links aligned with graph extraction: $source", ({ source, targets }) => {
	const collect = (tokens: readonly Token[]): string[] =>
		tokens.flatMap((token): string[] => {
			if (token.type === "wikiReference") return [String(token.reference)];
			return "tokens" in token && token.tokens ? collect(token.tokens) : [];
		});
	expect(collect(lexMarkdown(source))).toEqual(targets);
});

describe("Advanced Markdown parser invariants", () => {
	it.each([
		"intro\n\n$$\n\nalpha\n\nbeta\n\ngamma\n\n$$\n\nafter",
		"intro\n\\[\n\nalpha\n\nbeta\n\\]\n\nafter",
		"first $x^2$ then \\(\\frac{1}{2}\\).\n\n![[Note#Heading|Label]]",
		"> [!warning]+ Title\n> $$\n> x\n>\n> y\n> $$\n>\n> ![[Note]]\n",
	])("matches a full parse at every streamed character prefix: %s", (source) => {
		let cache = null as ReturnType<typeof lexMarkdownBlocks>["cache"];
		for (let end = 1; end <= source.length; end++) {
			const prefix = source.slice(0, end);
			const result = lexMarkdownBlocks(prefix, cache);
			const fresh = lexMarkdown(prefix);
			expect([...result.tokens], `prefix ${end}`).toEqual([...fresh]);
			expect(result.defSalt).toBe(markdownDocumentDefSalt(fresh));
			expect(result.tokens.map((token) => token.raw).join("")).toBe(prefix);
			cache = result.cache;
		}
	});
	it("does not swallow prices before a real formula", () => {
		const tokens = lexMarkdown("Cost $5 and $10 then $x$");
		const inline = tokens[0]?.type === "paragraph" ? tokens[0].tokens : [];
		expect(inline?.filter((token) => token.type === "inlineMath").map((token) => token.raw)).toEqual(["$x$"]);
	});
	it("interrupts a paragraph at a block formula opener without requiring blank lines", () => {
		const source = "before\n$$\na\n\nb\n$$\nafter";
		expect(lexMarkdown(source).some((token) => token.type === "blockMath")).toBe(true);
	});
	it("keeps extension configuration private instead of changing global Marked behavior", () => {
		expect(JSON.stringify(marked.lexer("$x$ ![[Note]]"))).not.toContain('"inlineMath"');
		expect(JSON.stringify(marked.lexer("$x$ ![[Note]]"))).not.toContain('"wikiReference"');
	});
});
