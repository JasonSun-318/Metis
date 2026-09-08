import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveFileSelections } from "../src/file-selection-context.ts";

let root: string;
afterEach(async () => {
	if (root) await rm(root, { recursive: true, force: true });
});
it("resolves identity inside its session and rejects escapes, stale artifacts and invalid quotes", async () => {
	root = await mkdtemp(join(tmpdir(), "metis-selections-"));
	const cwd = join(root, "project");
	await mkdir(cwd);
	await writeFile(join(cwd, "notes.md"), "original");
	const outside = join(root, "notes.md");
	await writeFile(outside, "delivered");
	await symlink(outside, join(cwd, "escape.md"));
	const context = {
		cwd,
		resolveDelivered: (id: string) => (id === "1234567890abcdef" ? { name: "notes.md", path: outside } : undefined),
	};
	const quote = {
		source: "workspace" as const,
		relativePath: "notes.md",
		basis: "source" as const,
		selectedText: "original",
	};
	expect(await resolveFileSelections([quote], context)).toMatchObject([
		{ path: await realpath(join(cwd, "notes.md")), name: "notes.md" },
	]);
	expect(
		await resolveFileSelections(
			[{ source: "delivered", fileId: "1234567890abcdef", basis: "source", selectedText: "delivered" }],
			context,
		),
	).toMatchObject([{ path: outside }]);
	for (const relativePath of ["../notes.md", outside, "escape.md", "missing.md", ".", "C:\\notes.md"])
		await expect(resolveFileSelections([{ ...quote, relativePath }], context)).rejects.toThrow();
	for (const bad of [
		{ ...quote, selectedText: " " },
		{ ...quote, startLine: 2 },
		{ ...quote, startLine: 2, endLine: 1 },
	])
		await expect(resolveFileSelections([bad], context)).rejects.toThrow();
	await expect(
		resolveFileSelections(
			[{ source: "delivered", fileId: "0000000000000000", basis: "source", selectedText: "x" }],
			context,
		),
	).rejects.toThrow("unavailable");
});
