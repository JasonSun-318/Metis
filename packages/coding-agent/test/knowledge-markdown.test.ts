import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseKnowledgeNote, resolveKnowledgeLink } from "../src/core/knowledge-markdown.ts";

const syntaxFixtures = JSON.parse(
	readFileSync(new URL("./fixtures/knowledge-markdown-advanced.json", import.meta.url), "utf8"),
) as { source: string; targets: string[] }[];
it.each(syntaxFixtures)("keeps graph links aligned with the reader: $source", ({ source, targets }) => {
	expect(parseKnowledgeNote("Source.md", source).links.map((link) => link.target)).toEqual(targets);
});

describe("parseKnowledgeNote math handling", () => {
	it("does not create graph edges for pseudo links inside formulas", () => {
		const content = [
			"# Note",
			"",
			"$$[[Not a link]]$$",
			"",
			"Inline $[[$a+b]]$ and $[ref](./x.md)$ stay math.",
			"",
			"\\([[\\text{also}]]\\)",
			"",
			"\\[[[block]]\\]",
			"",
			"Real [[Real Note]] and [real](./real.md) survive.",
			"",
			"Prices like $5 and $10 do not eat the [[After Prices]] link.",
		].join("\n");
		const note = parseKnowledgeNote("Note.md", content);
		expect(note.links).toEqual([
			{ target: "Real Note", kind: "wiki" },
			{ target: "After Prices", kind: "wiki" },
			{ target: "./real.md", kind: "markdown" },
		]);
	});

	it("keeps links that only look like currency guards outside math", () => {
		const note = parseKnowledgeNote("a.md", "$5\n\n[[B]]");
		expect(note.links).toEqual([{ target: "B", kind: "wiki" }]);
	});
});

describe("resolveKnowledgeLink", () => {
	const paths = new Set(["a.md", "dir/b.md", "dir2/b.md", "alias-target.md"]);
	const names = new Map<string, string[]>([
		["a", ["a.md"]],
		["dir/b", ["dir/b.md"]],
		["dir2/b", ["dir2/b.md"]],
		["b", ["dir/b.md", "dir2/b.md"]],
		["alias", ["alias-target.md"]],
	]);
	it("prefers source-relative for markdown and rejects ambiguous names", () => {
		expect(resolveKnowledgeLink("dir/a.md", "./b.md", paths, names, "markdown")).toBe("dir/b.md");
		expect(resolveKnowledgeLink("a.md", "b", paths, names, "wiki")).toBeNull();
		expect(resolveKnowledgeLink("a.md", "alias", paths, names, "wiki")).toBe("alias-target.md");
	});
});
