import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
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

	it("deduplicates normalized active facts only inside one scope", () => {
		const dir = mkdtempSync(join(tmpdir(), "metis-mem-"));
		dirs.push(dir);
		const store = openMemoryStore(join(dir, "memory.sqlite"));
		const base = {
			mode: null,
			topicFile: "preferences.md",
			status: "active" as const,
			createdAt: "2026-08-21T00:00:00.000Z",
			sourceTurn: null,
			embedding: null,
			embeddingModel: null,
		};
		expect(
			store.insertFact({ ...base, id: "a", scope: "global", cwdKey: null, text: "  Use  Chinese　replies " }),
		).toBe(true);
		expect(store.insertFact({ ...base, id: "b", scope: "global", cwdKey: null, text: "use chinese replies" })).toBe(
			false,
		);
		expect(
			store.insertFact({ ...base, id: "c", scope: "project", cwdKey: "project", text: "use chinese replies" }),
		).toBe(true);
		store.close();
	});

	it("migrates legacy topics and keeps the deterministic newest duplicate active", () => {
		const dir = mkdtempSync(join(tmpdir(), "metis-mem-"));
		dirs.push(dir);
		const path = join(dir, "memory.sqlite");
		const db = new DatabaseSync(path);
		db.exec(`CREATE TABLE facts (
			id TEXT PRIMARY KEY, scope TEXT NOT NULL, cwd_key TEXT, mode TEXT, topic_file TEXT NOT NULL,
			text TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, source_turn TEXT,
			embedding BLOB, embedding_model TEXT
		)`);
		const insert = db.prepare(
			"INSERT INTO facts VALUES (?, 'global', NULL, NULL, ?, ?, 'active', ?, NULL, NULL, NULL)",
		);
		insert.run("old", "Foo.md", "Use Chinese replies", "2026-01-01T00:00:00.000Z");
		insert.run("new", "foo.md", " use  chinese replies ", "2026-02-01T00:00:00.000Z");
		insert.run("reserved", "project.md", "reserved fact", "2026-03-01T00:00:00.000Z");
		const collision = `legacy-${createHash("sha256").update("../old.md").digest("hex").slice(0, 12)}.md`;
		insert.run("collision", collision, "valid collision topic", "2026-03-15T00:00:00.000Z");
		insert.run("unsafe", "../old.md", "unsafe topic fact", "2026-04-01T00:00:00.000Z");
		db.close();

		const store = openMemoryStore(path);
		expect(store.getFactById("new")?.status).toBe("active");
		expect(store.getFactById("old")?.status).toBe("superseded");
		expect(store.getFactById("new")?.topicFile).toBe("foo.md");
		expect(store.getFactById("reserved")?.topicFile).toMatch(/^legacy-[0-9a-f]{12,64}\.md$/u);
		expect(store.getFactById("unsafe")?.topicFile).toMatch(/^legacy-[0-9a-f]{12,64}\.md$/u);
		expect(store.getFactById("unsafe")?.topicFile).not.toBe(collision);
		expect(store.getFactById("collision")?.topicFile).toBe(collision);
		store.close();
	});

	it("bounds historical ordinary topics with a stable legacy overflow", () => {
		const dir = mkdtempSync(join(tmpdir(), "metis-mem-"));
		dirs.push(dir);
		const path = join(dir, "memory.sqlite");
		const db = new DatabaseSync(path);
		db.exec(`CREATE TABLE facts (
			id TEXT PRIMARY KEY, scope TEXT NOT NULL, cwd_key TEXT, mode TEXT, topic_file TEXT NOT NULL,
			text TEXT NOT NULL, status TEXT NOT NULL, created_at TEXT NOT NULL, source_turn TEXT,
			embedding BLOB, embedding_model TEXT
		)`);
		const insert = db.prepare(
			"INSERT INTO facts VALUES (?, 'global', NULL, NULL, ?, ?, 'active', ?, NULL, NULL, NULL)",
		);
		for (let index = 0; index < 33; index++) {
			insert.run(
				`fact-${index}`,
				`topic-${String(index).padStart(2, "0")}.md`,
				`historical ${index}`,
				new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
			);
		}
		db.close();

		let store = openMemoryStore(path);
		expect([0, 1, 2].map((index) => store.getFactById(`fact-${index}`)?.topicFile)).toEqual([
			"legacy-overflow.md",
			"legacy-overflow.md",
			"legacy-overflow.md",
		]);
		expect(
			store
				.listActiveFacts("global", null, null)
				.map((fact) => fact.topicFile)
				.filter((topic) => topic !== "legacy-overflow.md"),
		).toHaveLength(30);
		store.close();
		store = openMemoryStore(path);
		expect(store.getFactById("fact-0")?.topicFile).toBe("legacy-overflow.md");
		store.close();
	});
});

import { createHash } from "node:crypto";
