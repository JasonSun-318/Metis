import { constants } from "node:fs";
import { type FileHandle, mkdtemp, open, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readKnowledgeFile } from "../src/knowledge-file.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs/promises")>();
	return { ...actual, open: vi.fn(actual.open) };
});

let directory: string | undefined;
afterEach(async () => {
	vi.mocked(open).mockClear();
	if (directory) await rm(directory, { recursive: true, force: true });
});

async function fixture() {
	directory = await mkdtemp(join(tmpdir(), "metis-note-file-"));
	await writeFile(join(directory, "A.md"), "# Original note");
	return directory;
}

describe("Knowledge file identity", () => {
	it("reads a bounded note or header through numeric read-only flags", async () => {
		const root = await fixture();
		const result = await readKnowledgeFile(root, "A.md", 100, 5);
		expect(new TextDecoder().decode(result.bytes)).toBe("# Ori");
		expect(result.size).toBe(15);
		expect(vi.mocked(open).mock.calls[0]?.[1]).toBe(constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		await expect(readKnowledgeFile(root, "A.md", 5)).rejects.toThrow("preview limit");
	});
	it("rejects a symlink replacement between the path check and open", async () => {
		const root = await fixture();
		const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		vi.mocked(open).mockImplementationOnce(async (path, flags) => {
			await rename(join(root, "A.md"), join(root, "saved.md"));
			await symlink(join(root, "saved.md"), join(root, "A.md"));
			return actual.open(path, flags);
		});
		await expect(readKnowledgeFile(root, "A.md", 100)).rejects.toThrow();
	});
	it("rejects a changed path after bytes were read and closes the held handle", async () => {
		const root = await fixture();
		const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
		const closed = vi.fn();
		vi.mocked(open).mockImplementationOnce(async (path, flags) => {
			const handle = await actual.open(path, flags);
			return {
				stat: () => handle.stat(),
				read: async (buffer: Uint8Array, offset: number, length: number, position: number) => {
					const result = await handle.read(buffer, offset, length, position);
					await rename(join(root, "A.md"), join(root, "saved.md"));
					await writeFile(join(root, "A.md"), "# Replaced note");
					return result;
				},
				close: async () => {
					closed();
					await handle.close();
				},
			} as unknown as FileHandle;
		});
		await expect(readKnowledgeFile(root, "A.md", 100)).rejects.toThrow("changed while reading");
		expect(closed).toHaveBeenCalledOnce();
	});
});
