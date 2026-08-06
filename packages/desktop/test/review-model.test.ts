import { describe, expect, it } from "vitest";
import { buildReviewTree, reviewPatchKey } from "../src/renderer/components/review-model.ts";
import type { DesktopWorkspaceReviewFile } from "../src/shared/desktop-api.ts";

const file = (relativePath: string): DesktopWorkspaceReviewFile => ({
	relativePath,
	previousRelativePath: null,
	status: "modified",
	additions: 1,
	deletions: 2,
	binary: false,
});

describe("review model", () => {
	it("builds a stable directory-first tree and revision-scoped patch keys", () => {
		const tree = buildReviewTree([file("z.ts"), file("src/z.ts"), file("src/a.ts"), file("a.ts")]);
		expect(tree.map((node) => node.name)).toEqual(["src", "a.ts", "z.ts"]);
		expect(tree[0]).toMatchObject({
			kind: "directory",
			children: [
				{ kind: "file", name: "a.ts" },
				{ kind: "file", name: "z.ts" },
			],
		});
		expect(reviewPatchKey("working-tree", "src/a.ts")).toBe("working-tree\0src/a.ts");
	});
});
