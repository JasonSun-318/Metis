import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { embeddingConfigKey } from "../src/core/memory/memory-embedder.ts";
import { backfillMemoryEmbeddings, capRetrievedFacts, searchMemories } from "../src/core/memory/memory-search.ts";
import { openMemoryStore } from "../src/core/memory/memory-store.ts";
import type { MemoryFact } from "../src/core/memory/memory-types.ts";

describe("memory search", () => {
	const embeddingSettings = {
		name: "Embedding",
		provider: "Qwen",
		baseUrl: "https://example.test/v1",
		api: "openai-compatible" as const,
		modelId: "embedding-model",
	};
	const embeddingKey = embeddingConfigKey(embeddingSettings);
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
			embeddingModel: embeddingKey,
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
			projectKey: "unused",
			embeddingSettings,
			embeddingApiKey: "secret",
			embedQuery: async () => new Float32Array([0.95, 0.05, 0]),
		});
		expect(hits[0]?.text).toContain("TypeScript");
		expect(hits.map((h) => h.id)).toEqual(["a"]);
		expect(hits[0]?.id).toBe("a");
		expect(store.listHealth()).toContainEqual(expect.objectContaining({ operation: "embedding", status: "ok" }));
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
			projectKey: "unused",
			embeddingSettings,
			embeddingApiKey: "secret",
			rerankSettings: {
				name: "Rerank",
				provider: "Cohere",
				endpointUrl: "https://example.test/v2/rerank",
				modelId: "rerank",
			},
			rerankApiKey: "secret",
			embedQuery: async () => new Float32Array([0.95, 0.05, 0]),
			rerank: async (_query, docs) => [...docs].reverse().map((d) => d.id),
		});
		expect(hits[0]?.id).toBe("b");
		expect(store.listHealth()).toContainEqual(expect.objectContaining({ operation: "rerank", status: "ok" }));
		store.close();
	});

	it("keeps fused ranking when rerank fails", async () => {
		const dir = mkdtempSync(join(tmpdir(), "metis-mem-search-"));
		dirs.push(dir);
		const store = openMemoryStore(join(dir, "memory.sqlite"));
		store.insertFact(insertFact({ id: "a", text: "typescript backend", embedding: new Float32Array([1, 0]) }));
		store.insertFact(insertFact({ id: "b", text: "dark theme", embedding: new Float32Array([0.8, 0.2]) }));

		const hits = await searchMemories({
			store,
			query: "typescript",
			projectKey: "unused",
			embeddingSettings,
			embeddingApiKey: "secret",
			rerankSettings: {
				name: "Rerank",
				provider: "Cohere",
				endpointUrl: "https://example.test/rerank",
				modelId: "rerank",
			},
			rerankApiKey: "secret",
			embedQuery: async () => new Float32Array([1, 0]),
			rerank: async () => {
				throw new Error("offline secret Bearer exposed-token");
			},
		});
		expect(hits.map((hit) => hit.id)).toEqual(["a", "b"]);
		const health = store.listHealth().find((row) => row.operation === "rerank");
		expect(health).toMatchObject({ status: "error" });
		expect(health?.reason).not.toContain("secret");
		expect(health?.reason).not.toContain("exposed-token");
		store.close();
	});

	it("aborts the actual embedding request on timeout and falls back to positive keyword hits", async () => {
		const dir = mkdtempSync(join(tmpdir(), "metis-mem-search-"));
		dirs.push(dir);
		const store = openMemoryStore(join(dir, "memory.sqlite"));
		store.insertFact(insertFact({ id: "keyword", text: "typescript backend", embedding: null }));
		let observed: AbortSignal | undefined;
		const hits = await searchMemories({
			store,
			query: "typescript",
			projectKey: "unused",
			embeddingSettings,
			embeddingApiKey: "secret",
			retrieveTimeoutMs: 10,
			fetchFn: async (_input, init) => {
				observed = init?.signal as AbortSignal;
				return await new Promise<Response>((_resolve, reject) => {
					observed?.addEventListener(
						"abort",
						() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
						{ once: true },
					);
				});
			},
		});
		expect(observed?.aborted).toBe(true);
		expect(hits.map((hit) => hit.id)).toEqual(["keyword"]);
		expect(store.listHealth()).toContainEqual(expect.objectContaining({ operation: "embedding", status: "error" }));
		store.close();
	});

	it("propagates caller cancellation", async () => {
		const dir = mkdtempSync(join(tmpdir(), "metis-mem-search-"));
		dirs.push(dir);
		const store = openMemoryStore(join(dir, "memory.sqlite"));
		store.insertFact(insertFact({ id: "keyword", text: "typescript backend", embedding: null }));
		const controller = new AbortController();
		const pending = searchMemories({
			store,
			query: "typescript",
			projectKey: "unused",
			embeddingSettings,
			embeddingApiKey: "secret",
			signal: controller.signal,
			fetchFn: async (_input, init) =>
				await new Promise<Response>((_resolve, reject) => {
					(init?.signal as AbortSignal).addEventListener(
						"abort",
						() => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
						{ once: true },
					);
				}),
		});
		controller.abort();
		await expect(pending).rejects.toMatchObject({ name: "AbortError" });
		store.close();
	});

	it("caps Unicode fact text even when the first hit is oversized", () => {
		const [hit] = capRetrievedFacts([{ id: "long", scope: "global", text: "😀".repeat(3_000), score: 1 }], 8, 2_048);
		expect(Array.from(hit!.text)).toHaveLength(2_048);
		expect(hit!.text.endsWith("…")).toBe(true);
	});

	it("uses the last 8000 complete Unicode query characters", async () => {
		const dir = mkdtempSync(join(tmpdir(), "metis-mem-search-"));
		dirs.push(dir);
		const store = openMemoryStore(join(dir, "memory.sqlite"));
		let observed = "";
		await searchMemories({
			store,
			query: `drop${"😀".repeat(8_000)}`,
			projectKey: "unused",
			embeddingSettings,
			embeddingApiKey: "secret",
			embedQuery: async (query) => {
				observed = query;
				return new Float32Array([1, 0]);
			},
		});
		expect(Array.from(observed)).toHaveLength(8_000);
		expect(observed).not.toContain("drop");
		expect(observed).not.toContain("�");
		store.close();
	});

	it("drains every backfill batch under one lease", async () => {
		const dir = mkdtempSync(join(tmpdir(), "metis-mem-search-"));
		dirs.push(dir);
		const store = openMemoryStore(join(dir, "memory.sqlite"));
		for (let index = 0; index < 70; index++) {
			store.insertFact(
				insertFact({
					id: `pending-${index}`,
					text: `pending ${index}`,
					embedding: null,
					embeddingModel: null,
				}),
			);
		}
		const embedBatch = vi.fn(async (texts: string[]) => texts.map(() => new Float32Array([1, 0])));
		const updated = await backfillMemoryEmbeddings({
			store,
			embeddingSettings,
			embeddingApiKey: "secret",
			embedTexts: embedBatch,
		});
		expect(updated).toBe(70);
		expect(embedBatch.mock.calls.map(([texts]) => texts.length)).toEqual([32, 32, 6]);
		expect(store.listFactsNeedingEmbedding(embeddingKey, 100)).toEqual([]);
		expect(store.listHealth()).toContainEqual(expect.objectContaining({ operation: "backfill", status: "ok" }));
		store.close();
	});

	it("allows only one concurrent backfill owner", async () => {
		const dir = mkdtempSync(join(tmpdir(), "metis-mem-search-"));
		dirs.push(dir);
		const path = join(dir, "memory.sqlite");
		const firstStore = openMemoryStore(path);
		const secondStore = openMemoryStore(path);
		firstStore.insertFact(insertFact({ id: "pending", text: "pending", embedding: null, embeddingModel: null }));
		let release!: () => void;
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		const firstEmbed = vi.fn(async () => {
			await held;
			return [new Float32Array([1, 0])];
		});
		const first = backfillMemoryEmbeddings({
			store: firstStore,
			embeddingSettings,
			embeddingApiKey: "secret",
			embedTexts: firstEmbed,
		});
		await vi.waitFor(() => expect(firstEmbed).toHaveBeenCalledOnce());
		const secondEmbed = vi.fn(async () => [new Float32Array([0, 1])]);
		expect(
			await backfillMemoryEmbeddings({
				store: secondStore,
				embeddingSettings,
				embeddingApiKey: "secret",
				embedTexts: secondEmbed,
			}),
		).toBe(0);
		expect(secondEmbed).not.toHaveBeenCalled();
		release();
		expect(await first).toBe(1);
		firstStore.close();
		secondStore.close();
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
				mode: null,
				text: "project a typescript note",
				embedding: new Float32Array([0.9, 0.1, 0]),
			}),
		);
		store.insertFact(
			insertFact({
				id: "other",
				scope: "project",
				cwdKey: "cwd-b",
				mode: null,
				text: "other project typescript note",
				embedding: new Float32Array([0.9, 0.1, 0]),
			}),
		);

		const hits = await searchMemories({
			store,
			query: "typescript",
			projectKey: "cwd-a",
			embeddingSettings,
			embeddingApiKey: "secret",
			embedQuery: async () => new Float32Array([1, 0, 0]),
		});
		expect(hits.map((h) => h.id).sort()).toEqual(["global", "here"]);
		store.close();
	});
});
