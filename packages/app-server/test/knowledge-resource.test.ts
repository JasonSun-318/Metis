import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KnowledgeService } from "../src/knowledge.ts";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const PDF = Buffer.from("%PDF-1.4 minimal");

describe("knowledge resource resolution", () => {
	let root: string;
	let vault: string;
	let service: KnowledgeService;
	it("rejects a registered root replaced with a symlink to another directory", async () => {
		const library = await service.register(vault);
		await rename(vault, `${vault}-original`);
		await mkdir(`${vault}-other`);
		await writeFile(join(`${vault}-other`, "Secret.md"), "private");
		await symlink(`${vault}-other`, vault);
		await expect(service.resolve(library.id, "Home.md", "Secret", "wiki")).rejects.toThrow("root has changed");
		await expect(service.read(library.id, "Secret.md")).rejects.toThrow("root has changed");
	});
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "metis-knowledge-resource-"));
		vault = join(root, "vault");
		await mkdir(vault);
		await mkdir(join(vault, "topic"));
		await mkdir(join(vault, "assets"));
		await writeFile(join(vault, "Home.md"), "# Home\n\n[[Note B]]");
		await writeFile(join(vault, "topic", "Note A.md"), "# A");
		await writeFile(join(vault, "topic", "Note B.md"), "# B\n\n![[diagram.png]]");
		await writeFile(join(vault, "assets", "diagram.png"), PNG);
		await writeFile(join(vault, "assets", "contract.pdf"), PDF);
		await mkdir(join(root, "agent"));
		service = new KnowledgeService(join(root, "agent"));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	it("resolves wiki notes with fragments, aliases and markdown attachments", async () => {
		const library = await service.register(vault);
		const note = await service.resolve(library.id, "Home.md", "Note B#核心流程", "wiki");
		expect(note).toMatchObject({
			libraryId: library.id,
			path: "topic/Note B.md",
			kind: "note",
			mimeType: "text/markdown",
			fragment: "核心流程",
		});
		expect(note.revision).toMatch(/^[^:]+:[^:]+:\d+$/);
		expect(note.absolutePath).toBe(await realpath(join(vault, "topic", "Note B.md")));
		expect(note.rootPath).toBe(await realpath(vault));

		const image = await service.resolve(library.id, "topic/Note B.md", "assets/diagram.png", "wiki");
		expect(image).toMatchObject({ path: "assets/diagram.png", kind: "image", mimeType: "image/png" });

		const markdown = await service.resolve(
			library.id,
			"topic/Note A.md",
			"../assets/contract.pdf#page=3",
			"markdown",
		);
		expect(markdown).toMatchObject({ path: "assets/contract.pdf", kind: "pdf", fragment: "page=3" });

		// A bare fragment resolves back to the source note.
		const selfFragment = await service.resolve(library.id, "Home.md", "#核心流程", "wiki");
		expect(selfFragment).toMatchObject({ path: "Home.md", kind: "note", fragment: "核心流程" });
		// Percent decoding must not reveal an absolute or protocol target after the fact.
		await expect(service.resolve(library.id, "Home.md", "%2Fetc%2Fpasswd.md", "markdown")).rejects.toThrow(
			/library-relative/,
		);
		await expect(service.resolve(library.id, "Home.md", "file%3A%2F%2F%2Fetc%2Fpasswd", "markdown")).rejects.toThrow(
			/protocol/,
		);
	});

	it("rejects absolute paths, protocol URLs, directory targets, escapes and symlinks outside the root", async () => {
		const library = await service.register(vault);
		await mkdir(join(vault, "empty-dir"));
		await mkdir(join(vault, "folder.pdf"));
		const outside = join(root, "outside");
		await mkdir(outside);
		await writeFile(join(outside, "secret.png"), PNG);
		await symlink(outside, join(vault, "assets", "escape"));

		for (const [reference, kind] of [
			["/etc/passwd", "wiki"],
			["file:///etc/passwd", "wiki"],
			["app://renderer/x.md", "markdown"],
			["javascript:alert(1)", "wiki"],
			["../folder.pdf", "markdown"],
			["../../outside/secret.png", "markdown"],
			["escape/secret.png", "wiki"],
			["../escape/secret.png", "markdown"],
		] as const) {
			await expect(service.resolve(library.id, "topic/Note A.md", reference, kind)).rejects.toThrow(
				/protocol|library-relative|not a file|escapes|does not match|URL/i,
			);
		}
	});

	it("rejects ambiguous references, unsupported types and mismatched file signatures", async () => {
		const library = await service.register(vault);
		await mkdir(join(vault, "other"));
		await writeFile(join(vault, "other", "Note B.md"), "# B2");
		await expect(service.resolve(library.id, "Home.md", "Note B", "wiki")).rejects.toThrow(/multiple notes/);
		await expect(service.resolve(library.id, "Home.md", "missing.png", "wiki")).rejects.toThrow(/does not match/);
		await expect(service.resolve(library.id, "Home.md", "movie.mp4", "wiki")).rejects.toThrow(/does not embed/);
		await writeFile(join(vault, "assets", "fake.png"), Buffer.from("definitely not a bitmap"));
		await expect(service.resolve(library.id, "Home.md", "assets/fake.png", "wiki")).rejects.toThrow(
			/does not match its/,
		);
	});

	it("excludes pseudo wiki links inside formulas from the scan graph", async () => {
		await writeFile(join(vault, "Math.md"), "# Math\n\n$$[[Note B]]$$ and $[x](./Note%20B.md)$\n\n[[topic/Note A]]");
		const library = await service.register(vault);
		const scan = await service.scan(library.id);
		const math = scan.notes.find((note) => note.path === "Math.md");
		expect(math?.links.map((link) => link.path)).toEqual(["topic/Note A.md"]);
		expect(scan.edges).toEqual([
			{ source: "Home.md", target: "topic/Note B.md" },
			{ source: "Math.md", target: "topic/Note A.md" },
		]);
	});

	it("rejects removed library ids even with a warm scan cache and never revives an old id for a re-registered path", async () => {
		const library = await service.register(vault);
		await service.scan(library.id);
		expect(service.remove(library.id).libraries).toEqual([]);
		await expect(service.resolve(library.id, "Home.md", "Note B", "wiki")).rejects.toThrow(/not registered/);
		const renewed = await service.register(vault);
		expect(renewed.id).not.toBe(library.id);
		await expect(service.resolve(library.id, "Home.md", "Note B", "wiki")).rejects.toThrow(/not registered/);
		const note = await service.resolve(renewed.id, "Home.md", "Note B", "wiki");
		expect(note.path).toBe("topic/Note B.md");
	});
});
