import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memoryProjectIdentity } from "../src/core/memory/memory-project.ts";
import { openMemoryStore } from "../src/core/memory/memory-store.ts";

describe("memory project identity", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	function storeFixture() {
		const dir = mkdtempSync(join(tmpdir(), "metis-memory-project-"));
		dirs.push(dir);
		return openMemoryStore(join(dir, "memory.sqlite"));
	}

	it("gives colliding legacy paths different exact project keys", () => {
		const root = mkdtempSync(join(tmpdir(), "metis-memory-paths-"));
		dirs.push(root);
		const leftPath = join(root, "a-b", "c");
		const rightPath = join(root, "a", "b-c");
		mkdirSync(leftPath, { recursive: true });
		mkdirSync(rightPath, { recursive: true });
		const left = memoryProjectIdentity(leftPath);
		const right = memoryProjectIdentity(rightPath);
		expect(left.legacyKey).toBe(right.legacyKey);
		expect(left.projectKey).toMatch(/^[0-9a-f]{64}$/u);
		expect(left.projectKey).not.toBe(right.projectKey);
	});

	it("claims legacy facts once and does not leak them to a colliding cwd", () => {
		const root = mkdtempSync(join(tmpdir(), "metis-memory-collision-"));
		dirs.push(root);
		const first = memoryProjectIdentity(join(root, "a-b", "c"));
		const second = memoryProjectIdentity(join(root, "a", "b-c"));
		const store = storeFixture();
		store.insertFact({
			id: "legacy",
			scope: "project",
			cwdKey: first.legacyKey,
			mode: "code",
			topicFile: "facts.md",
			text: "legacy fact",
			status: "active",
			createdAt: "2026-08-21T00:00:00.000Z",
			sourceTurn: null,
			embedding: null,
			embeddingModel: null,
		});
		expect(store.resolveProject(first)).toMatchObject({ migratedFacts: 1, legacyCollision: false });
		expect(store.getFactById("legacy")).toMatchObject({ cwdKey: first.projectKey, mode: null });
		expect(store.resolveProject(second)).toMatchObject({ migratedFacts: 0, legacyCollision: true });
		expect(store.listActiveFactsForContext(second.projectKey)).toEqual([]);
		store.close();
	});

	it("fails closed when one project key is bound to another canonical cwd", () => {
		const store = storeFixture();
		store.insertProjectRow({ projectKey: "a".repeat(64), canonicalCwd: "/first", legacyKey: "first" });
		expect(() =>
			store.resolveProject({ projectKey: "a".repeat(64), canonicalCwd: "/second", legacyKey: "second" }),
		).toThrow(/project identity collision/i);
		store.close();
	});
});
