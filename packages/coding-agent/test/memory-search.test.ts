import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchMemories } from "../src/core/memory/memory-search.ts";
import { openMemoryStore } from "../src/core/memory/memory-store.ts";
import type { MemoryFact } from "../src/core/memory/memory-types.ts";

describe("memory search", () => {
	const dirs: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function insertFact(partial: Partial<MemoryFact> & Pick<MemoryFact, "id" | "text" | "embedding">): MemoryFact {
		return {
			scope: "global",
			cwdKey: null,
			mode: null,
			topicFile: "prefs.md",
			status: "active",
			createdAt: "2026-08-21T00:00:00.000Z",
			sourceTurn: "t1",
			embeddingModel: "openai/text-embedding-3-small",
			...partial,
		};
	}

	it("fuses cosine and keyword scores and ranks the closer matching fact first", async () => {
		const dir = mkdtempSync(join(tmpdir(), "metis-mem-search-"));
		dirs.push(dir);
		const store = openMemoryStore(join(dir, "memory.sqlite"));
		store.insertFact(
			insertFact({
				id: "a",
				text: "User prefers TypeScript for backend services",
				embedding: new Float32Array([1, 0, 0]),
			}),
		);
		store.insertFact(
			insertFact({
				id: "b",
				text: "User likes dark mode themes",
				embedding: new Float32Array([0, 1, 0]),
			}),
		);

		const hits = await searchMemories({
			store,
			query: "TypeScript backend preferences",
			cwdKey: "unused",
			mode: "code",
			embeddingModel: "openai/text-embedding-3-small",
			embedQuery: async () => new Float32Array([0.95, 0.05, 0]),
		});
		expect(hits[0]?.text).toContain("TypeScript");
		expect(hits.map((h) => h.id)).toEqual(expect.arrayContaining(["a", "b"]));
		expect(hits[0]?.id).toBe("a");
		store.close();
	});

	it("optionally reranks candidates and can reorder hits", async () => {
		const dir = mkdtempSync(join(tmpdir(), "metis-mem-search-"));
		dirs.push(dir);
		const store = openMemoryStore(join(dir, "memory.sqlite"));
		store.insertFact(
			insertFact({
				id: "a",
				text: "User prefers TypeScript for backend services",
				embedding: new Float32Array([1, 0, 0]),
			}),
		);
		store.insertFact(
			insertFact({
				id: "b",
				text: "User likes dark mode themes",
				embedding: new Float32Array([0.8, 0.2, 0]),
			}),
		);

		const hits = await searchMemories({
			store,
			query: "TypeScript backend preferences",
			cwdKey: "unused",
			mode: "code",
			embeddingModel: "openai/text-embedding-3-small",
			rerankModel: "cohere/rerank-v3.5",
			embedQuery: async () => new Float32Array([0.95, 0.05, 0]),
			rerank: async (_query, docs) => [...docs].reverse().map((d) => d.id),
		});
		expect(hits[0]?.id).toBe("b");
		store.close();
	});

	it("only searches global plus the current project cwd/mode", async () => {
		const dir = mkdtempSync(join(tmpdir(), "metis-mem-search-"));
		dirs.push(dir);
		const store = openMemoryStore(join(dir, "memory.sqlite"));
		store.insertFact(
			insertFact({
				id: "global",
				text: "shared preference typescript",
				embedding: new Float32Array([1, 0, 0]),
			}),
		);
		store.insertFact(
			insertFact({
				id: "here",
				scope: "project",
				cwdKey: "cwd-a",
				mode: "code",
				text: "project a typescript note",
				embedding: new Float32Array([0.9, 0.1, 0]),
			}),
		);
		store.insertFact(
			insertFact({
				id: "other",
				scope: "project",
				cwdKey: "cwd-b",
				mode: "code",
				text: "other project typescript note",
				embedding: new Float32Array([0.9, 0.1, 0]),
			}),
		);

		const hits = await searchMemories({
			store,
			query: "typescript",
			cwdKey: "cwd-a",
			mode: "code",
			embeddingModel: "openai/text-embedding-3-small",
			embedQuery: async () => new Float32Array([1, 0, 0]),
		});
		expect(hits.map((h) => h.id).sort()).toEqual(["global", "here"]);
		store.close();
	});
});
