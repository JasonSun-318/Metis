import { describe, expect, it } from "vitest";
import { parseToolFileDiff } from "../src/renderer/components/tool-code-diff.ts";

describe("saved tool diff previews", () => {
	it("parses newly created files without treating /dev/null as the display name", () => {
		const diff = parseToolFileDiff({
			path: "写给Jason的话.md",
			kind: "added",
			diff: "===================================================================\n--- /dev/null\n+++ b/写给Jason的话.md\n@@ -0,0 +1,2 @@\n+# 你好\n+Jason\n",
		});
		expect(diff?.name).toBe("写给Jason的话.md");
		expect(diff?.type).toBe("new");
		expect(diff?.deletionLines).toEqual([]);
		expect(diff?.additionLines).toEqual(["# 你好\n", "Jason\n"]);
		expect(diff?.hunks[0]?.additionStart).toBe(1);
	});

	it("keeps both versions and original line numbers across separate hunks", () => {
		const diff = parseToolFileDiff({
			path: "src/app.ts",
			kind: "modified",
			diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -10,2 +10,2 @@\n-const value = 1;\n+const value = 2;\n context\n@@ -30 +30 @@\n-before\n+after\n",
		});
		expect(diff?.type).toBe("change");
		expect(diff?.deletionLines).toEqual(["const value = 1;\n", "context\n", "before\n"]);
		expect(diff?.additionLines).toEqual(["const value = 2;\n", "context\n", "after\n"]);
		expect(diff?.hunks.map((hunk) => [hunk.deletionStart, hunk.additionStart])).toEqual([
			[10, 10],
			[30, 30],
		]);
	});

	it("renders a deletion and preserves the missing final newline", () => {
		const diff = parseToolFileDiff({
			path: "old.txt",
			kind: "deleted",
			diff: "--- a/old.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-goodbye\n\\ No newline at end of file\n",
		});
		expect(diff?.type).toBe("deleted");
		expect(diff?.deletionLines).toEqual(["goodbye"]);
		expect(diff?.additionLines).toEqual([]);
	});

	it("shows only complete saved lines when a patch is truncated mid-line", () => {
		const diff = parseToolFileDiff({
			path: "large.ts",
			kind: "modified",
			truncated: true,
			diff: "--- a/large.ts\n+++ b/large.ts\n@@ -20,3 +20,5 @@\n context\n-before\n+after\n+incomplete",
		});
		expect(diff?.hunks[0]?.additionStart).toBe(20);
		expect(diff?.hunks[0]?.additionCount).toBe(2);
		expect(diff?.hunks[0]?.deletionCount).toBe(2);
		expect(diff?.additionLines).toEqual(["context\n", "after\n"]);
		expect(diff?.deletionLines).toEqual(["context\n", "before\n"]);
	});

	it("returns no preview for unavailable, empty, malformed or header-only patches", () => {
		for (const patch of [
			undefined,
			"",
			"unrecognized patch",
			"--- a/test.ts\n+++ b/test.ts\n",
			"--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n+only one side\n",
		]) {
			expect(parseToolFileDiff({ path: "test.ts", kind: "modified", diff: patch })).toBeNull();
		}
	});
});
