import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProjectFolder } from "../src/main/project-folder.ts";

describe("project folder creation", () => {
	it("copies selected files into one new project without changing the originals", async () => {
		const root = await mkdtemp(join(tmpdir(), "metis-project-"));
		const source = join(root, "brief.txt");
		await writeFile(source, "original");

		const project = await createProjectFolder({
			parentDirectory: join(root, "Metis Projects"),
			name: "Launch plan",
			files: [{ path: source, name: "ignored-name.txt" }],
		});

		await expect(readFile(join(project, "brief.txt"), "utf8")).resolves.toBe("original");
		await expect(readFile(source, "utf8")).resolves.toBe("original");
	});

	it("rejects unsafe input before creating a project", async () => {
		const root = await mkdtemp(join(tmpdir(), "metis-project-"));
		await expect(createProjectFolder({ parentDirectory: root, name: "../escape", files: [] })).rejects.toThrow(
			"valid project name",
		);
		await expect(stat(join(root, "escape"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects duplicate destination names before creating a project", async () => {
		const root = await mkdtemp(join(tmpdir(), "metis-project-"));
		const source = join(root, "brief.txt");
		await writeFile(source, "original");
		const parentDirectory = join(root, "projects");

		await expect(
			createProjectFolder({
				parentDirectory,
				name: "Broken",
				files: [
					{ path: source, name: "brief.txt" },
					{ path: source, name: "BRIEF.TXT" },
				],
			}),
		).rejects.toThrow("Duplicate file name");
		await expect(stat(join(parentDirectory, "Broken"))).rejects.toMatchObject({ code: "ENOENT" });
	});
});
