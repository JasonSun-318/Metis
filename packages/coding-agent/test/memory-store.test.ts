import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openMemoryStore } from "../src/core/memory/memory-store.ts";

describe("memory store", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("inserts an active fact and finds it by cosine search", () => {
		const dir = mkdtempSync(join(tmpdir(), "metis-mem-"));
		dirs.push(dir);
		const store = openMemoryStore(join(dir, "memory.sqlite"));
		const embedding = new Float32Array([1, 0, 0]);
		store.insertFact({
			id: "f1",
			scope: "global",
			cwdKey: null,
			mode: null,
			topicFile: "preferences.md",
			text: "User prefers Chinese replies",
			status: "active",
			createdAt: "2026-08-21T00:00:00.000Z",
			sourceTurn: "turn-1",
			embedding,
			embeddingModel: "test-emb",
		});
		const hits = store.searchByEmbedding(new Float32Array([0.9, 0.1, 0]), {
			scope: "global",
			cwdKey: null,
			mode: null,
			limit: 8,
		});
		expect(hits[0]?.id).toBe("f1");
		expect(hits[0]?.text).toContain("Chinese");
		store.close();
	});

	it("does not return superseded facts", () => {
		const dir = mkdtempSync(join(tmpdir(), "metis-mem-"));
		dirs.push(dir);
		const store = openMemoryStore(join(dir, "memory.sqlite"));
		store.insertFact({
			id: "old",
			scope: "global",
			cwdKey: null,
			mode: null,
			topicFile: "preferences.md",
			text: "Chinese",
			status: "superseded",
			createdAt: "2026-08-21T00:00:00.000Z",
			sourceTurn: "turn-1",
			embedding: new Float32Array([1, 0]),
			embeddingModel: "test-emb",
		});
		expect(
			store.searchByEmbedding(new Float32Array([1, 0]), { scope: "global", cwdKey: null, mode: null, limit: 8 }),
		).toEqual([]);
		store.close();
	});

	it("lists and searches project facts when mode is null using IS NULL", () => {
		const dir = mkdtempSync(join(tmpdir(), "metis-mem-"));
		dirs.push(dir);
		const store = openMemoryStore(join(dir, "memory.sqlite"));
		store.insertFact({
			id: "p1",
			scope: "project",
			cwdKey: "--cwd--",
			mode: null,
			topicFile: "auth.md",
			text: "Auth lives in app-server",
			status: "active",
			createdAt: "2026-08-21T00:00:00.000Z",
			sourceTurn: "turn-2",
			embedding: new Float32Array([0, 1, 0]),
			embeddingModel: "test-emb",
		});
		expect(store.listActiveFacts("project", "--cwd--", null).map((f) => f.id)).toEqual(["p1"]);
		const hits = store.searchByEmbedding(new Float32Array([0, 1, 0]), {
			scope: "project",
			cwdKey: "--cwd--",
			mode: null,
			limit: 8,
		});
		expect(hits[0]?.id).toBe("p1");
		store.close();
	});
});
