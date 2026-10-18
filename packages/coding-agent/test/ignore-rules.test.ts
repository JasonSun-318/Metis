import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ignore from "ignore";
import { afterEach, describe, expect, it } from "vitest";
import { addIgnoreRules } from "../src/core/ignore-rules.ts";

const directories: string[] = [];
function directory(): string {
	const root = mkdtempSync(join(tmpdir(), "metis-ignore-rules-"));
	directories.push(root);
	return root;
}

afterEach(() => {
	for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("resource ignore rules", () => {
	it("keeps nested patterns, negation and escaped names scoped to their directory", () => {
		const root = directory();
		const nested = join(root, "nested");
		mkdirSync(nested);
		writeFileSync(
			join(nested, ".gitignore"),
			"# comment\r\n/blocked/**\r\n!blocked/keep.md\r\n\\#private.md\r\n\\!literal.md\r\n",
		);
		const matcher = ignore();
		addIgnoreRules(matcher, nested, root);
		expect(matcher.ignores("nested/blocked/drop.md")).toBe(true);
		expect(matcher.ignores("nested/blocked/keep.md")).toBe(false);
		expect(matcher.ignores("nested/#private.md")).toBe(true);
		expect(matcher.ignores("nested/!literal.md")).toBe(true);
		expect(matcher.ignores("other/blocked/drop.md")).toBe(false);
	});

	it("applies gitignore, ignore and fdignore in their existing precedence order", () => {
		const root = directory();
		writeFileSync(join(root, ".gitignore"), "*.md\n");
		writeFileSync(join(root, ".ignore"), "!keep.md\n");
		writeFileSync(join(root, ".fdignore"), "keep.md\n!last.md\n");
		const matcher = ignore();
		addIgnoreRules(matcher, root, root);
		expect(matcher.ignores("drop.md")).toBe(true);
		expect(matcher.ignores("keep.md")).toBe(true);
		expect(matcher.ignores("last.md")).toBe(false);
	});

	it("continues to later ignore files when an earlier one cannot be read", () => {
		const root = directory();
		mkdirSync(join(root, ".gitignore"));
		writeFileSync(join(root, ".ignore"), "blocked.md\n");
		const matcher = ignore();
		expect(() => addIgnoreRules(matcher, root, root)).not.toThrow();
		expect(matcher.ignores("blocked.md")).toBe(true);
		expect(matcher.ignores("keep.md")).toBe(false);
	});
});
