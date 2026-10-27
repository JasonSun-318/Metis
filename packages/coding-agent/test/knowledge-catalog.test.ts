import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readKnowledgeCatalog } from "../src/core/knowledge-catalog.ts";

describe("Knowledge directory catalog", () => {
	let root: string;
	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "metis-knowledge-catalog-"));
	});
	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});
	it("distinguishes an absent catalog from a persisted empty catalog", async () => {
		expect(readKnowledgeCatalog(root)).toBeUndefined();
		await writeFile(join(root, "knowledge-libraries.json"), JSON.stringify({ libraries: [] }));
		expect(readKnowledgeCatalog(root)).toEqual([]);
	});
	it("reads registered directories without changing the catalog", async () => {
		const libraries = [{ id: "a", name: "产品资料", path: join(root, "资料") }];
		await writeFile(join(root, "knowledge-libraries.json"), JSON.stringify({ libraries }));
		expect(readKnowledgeCatalog(root)).toEqual(libraries);
	});
	it("rejects corrupt or non-absolute catalog records instead of restoring old links", async () => {
		for (const content of ["", "{", JSON.stringify({ libraries: [{ id: "a", name: "资料", path: "relative" }] })]) {
			await writeFile(join(root, "knowledge-libraries.json"), content);
			expect(() => readKnowledgeCatalog(root)).toThrow();
		}
	});
	it("rejects a symlink catalog", async () => {
		const target = join(root, "other.json");
		await writeFile(target, JSON.stringify({ libraries: [] }));
		await symlink(target, join(root, "knowledge-libraries.json"));
		expect(() => readKnowledgeCatalog(root)).toThrow();
	});
});
