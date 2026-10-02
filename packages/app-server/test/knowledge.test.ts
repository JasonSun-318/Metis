import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KnowledgeService } from "../src/knowledge.ts";

vi.mock("node:fs/promises", async (original) => {
	const fs = await original<typeof import("node:fs/promises")>();
	return { ...fs, readFile: vi.fn(fs.readFile) };
});

import { readFile } from "node:fs/promises";

describe("Markdown knowledge directories", () => {
	let root: string;
	let vault: string;
	let service: KnowledgeService;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "metis-knowledge-"));
		vault = join(root, "资料库");
		await mkdir(vault);
		await mkdir(join(root, "agent"));
		service = new KnowledgeService(join(root, "agent"));
		vi.mocked(readFile).mockClear();
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});
	it("registers one canonical absolute directory without creating files in the library", async () => {
		const library = await service.register(vault);
		expect(library.path).toBe(await realpath(vault));
		expect(await service.register(vault)).toEqual(library);
		expect(new KnowledgeService(join(root, "agent")).list().libraries).toEqual([library]);
		expect((await service.scan(library.id)).notes).toEqual([]);
		await expect(service.register("relative/path")).rejects.toThrow("absolute");
	});
	it("shows nested notes and resolves path, alias, heading and Markdown links while ignoring code", async () => {
		await mkdir(join(vault, "topic", "deep"), { recursive: true });
		await writeFile(
			join(vault, "Home.md"),
			"```md\n# Example heading\n[[Fake]]\n```\n# Home\n[[topic/deep/Note#Heading|Details]] [[Alias]] [note](topic/deep/Note.md)\n`[[Missing]]`",
		);
		await writeFile(join(vault, "topic/deep/Note.md"), "---\ntitle: Deep note\naliases: [Alias]\n---\n[[Home]]");
		const library = await service.register(vault);
		const result = await service.scan(library.id);
		expect(result.notes.map((note) => note.path)).toEqual(["Home.md", "topic/deep/Note.md"]);
		expect(result.notes[0].title).toBe("Home");
		expect(result.notes[0].links).toEqual([
			{ target: "topic/deep/Note", kind: "wiki" as const, path: "topic/deep/Note.md" },
			{ target: "Alias", kind: "wiki" as const, path: "topic/deep/Note.md" },
			{ target: "topic/deep/Note.md", kind: "markdown" as const, path: "topic/deep/Note.md" },
		]);
		expect(result.edges).toEqual([{ source: "Home.md", target: "topic/deep/Note.md" }]);
		expect(result.warnings).toEqual([]);
	});
	it("does not invent links when duplicate basenames are ambiguous", async () => {
		for (const dir of ["a", "b"]) {
			await mkdir(join(vault, dir));
			await writeFile(join(vault, dir, "Same.md"), "# Same");
		}
		await writeFile(join(vault, "Home.md"), "[[Same]] [[a/Same]]");
		const library = await service.register(vault);
		const home = (await service.scan(library.id)).notes.find((note) => note.path === "Home.md")!;
		expect(home.links).toEqual([
			{ target: "Same", kind: "wiki" as const, path: null },
			{ target: "a/Same", kind: "wiki" as const, path: "a/Same.md" },
		]);
	});
	it("distinguishes vault-root wikilinks from note-relative Markdown destinations", async () => {
		await mkdir(join(vault, "topic", "topic"), { recursive: true });
		await writeFile(join(vault, "topic", "Home.md"), "[[topic/Note]] [local](topic/Note.md) [[Upper]]");
		await writeFile(join(vault, "topic", "Note.md"), "# Root target");
		await writeFile(join(vault, "topic", "topic", "Note.md"), "# Relative target");
		await writeFile(join(vault, "topic", "Upper.MD"), "# Upper");
		const library = await service.register(vault);
		const note = (await service.scan(library.id)).notes.find((item) => item.path === "topic/Home.md")!;
		expect(note.links).toEqual([
			{ target: "topic/Note", kind: "wiki", path: "topic/Note.md" },
			{ target: "Upper", kind: "wiki", path: "topic/Upper.MD" },
			{ target: "topic/Note.md", kind: "markdown", path: "topic/topic/Note.md" },
		]);
	});
	it("reuses unchanged metadata and observes edited/deleted files", async () => {
		await writeFile(join(vault, "Note.md"), "# Before");
		const library = await service.register(vault);
		await service.scan(library.id);
		vi.mocked(readFile).mockClear();
		await service.scan(library.id);
		expect(readFile).not.toHaveBeenCalled();
		await writeFile(join(vault, "Note.md"), "# Changed title");
		expect((await service.scan(library.id)).notes[0].title).toBe("Changed title");
		expect((await service.read(library.id, "Note.md")).content).toBe("# Changed title");
		await unlink(join(vault, "Note.md"));
		expect((await service.scan(library.id)).notes).toEqual([]);
	});
	it("reports malformed notes and prevents viewer traversal outside the selected directory", async () => {
		const library = await service.register(vault);
		await writeFile(join(root, "private.md"), "outside");
		await writeFile(join(vault, "Broken.md"), "---\naliases: [broken\n---\n# Broken");
		await symlink(join(root, "private.md"), join(vault, "Outside.md"));
		await expect(service.read(library.id, "../private.md")).rejects.toThrow("Invalid");
		await expect(service.read(library.id, "Outside.md")).rejects.toThrow("outside");
		const result = await service.scan(library.id);
		expect(result.notes).toEqual([]);
		expect(result.warnings[0]).toContain("Broken.md");
	});
});
