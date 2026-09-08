import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAutoMemoryPaths, getAutoMemoryRoot, getMemorySqlitePath, loadAutoMemory } from "../src/core/auto-memory.ts";
import { memoryProjectIdentity } from "../src/core/memory/memory-project.ts";
import { writeProjection } from "../src/core/memory/memory-projection.ts";
import { openMemoryStore } from "../src/core/memory/memory-store.ts";
import type { MemoryFact } from "../src/core/memory/memory-types.ts";

const INDEX_ENTRY = /^- \[([^\]]+\.md)\]\(\1\) — (.{1,120})$/u;

function fact(partial: Partial<MemoryFact> & Pick<MemoryFact, "id" | "topicFile" | "text" | "createdAt">): MemoryFact {
	return {
		scope: "global",
		cwdKey: null,
		mode: null,
		status: "active",
		sourceTurn: null,
		embedding: null,
		embeddingModel: null,
		...partial,
	};
}

describe("memory projection", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("writeProjection writes the bounded catalog on disk", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-proj-"));
		dirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const sqlitePath = getMemorySqlitePath(agentDir);
		expect(sqlitePath).toBe(join(getAutoMemoryRoot(agentDir), "memory.sqlite"));

		const store = openMemoryStore(sqlitePath);
		const projectKey = memoryProjectIdentity(cwd).projectKey;

		store.insertFact(
			fact({
				id: "g1",
				topicFile: "preferences.md",
				text: "User prefers Chinese replies",
				createdAt: "2026-08-21T00:00:00.000Z",
			}),
		);
		store.insertFact(
			fact({
				id: "g2",
				topicFile: "preferences.md",
				text: `User likes concise answers\n${"🧠".repeat(120)}`,
				createdAt: "2026-08-21T01:00:00.000Z",
			}),
		);

		for (let i = 0; i < 30; i++) {
			store.insertFact(
				fact({
					id: `p${i}`,
					scope: "project",
					cwdKey: projectKey,
					mode: null,
					topicFile: `topic-${String(i).padStart(3, "0")}.md`,
					text: `Project fact ${i}`,
					createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
				}),
			);
		}

		await writeProjection(agentDir, projectKey, store);
		store.close();

		const paths = getAutoMemoryPaths(agentDir, cwd);
		const globalIndex = readFileSync(paths.global.indexPath, "utf8");
		const globalLines = globalIndex.split(/\r?\n/).filter((line) => INDEX_ENTRY.test(line));
		expect(globalLines).toHaveLength(1);
		expect(globalLines[0]).toMatch(/^- \[preferences\.md\]\(preferences\.md\) — /);
		const summary = globalLines[0]!.split(" — ")[1]!;
		expect(summary).toContain("User prefers Chinese replies User likes concise answers 🧠");
		expect([...summary]).toHaveLength(120);
		expect(summary).not.toContain("\uFFFD");
		const preferences = readFileSync(join(paths.global.directory, "preferences.md"), "utf8");
		expect(preferences).toContain("User prefers Chinese replies");
		expect(preferences).toContain("User likes concise answers");

		const projectIndex = readFileSync(paths.project.indexPath, "utf8");
		const projectLines = projectIndex.split(/\r?\n/).filter((line) => INDEX_ENTRY.test(line));
		expect(projectLines).toHaveLength(30);
		expect(projectLines[0]).toContain("topic-029.md");
		expect(readFileSync(join(paths.project.directory, "topic-029.md"), "utf8")).toContain("Project fact 29");
		expect(readFileSync(join(paths.project.directory, "topic-000.md"), "utf8")).toContain("Project fact 0");

		const loaded = loadAutoMemory(agentDir, cwd);
		expect(loaded.project.truncated).toBe(false);
		const loadedLines = loaded.project.content.split(/\r?\n/).filter((line) => INDEX_ENTRY.test(line));
		expect(loadedLines.length).toBeLessThanOrEqual(200);
		expect(loadedLines[0]).toContain("topic-029.md");
	});

	it("removes only stale topics owned by the prior generated index", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-proj-"));
		dirs.push(root);
		const agentDir = join(root, "agent");
		const projectKey = memoryProjectIdentity(join(root, "project")).projectKey;
		const store = openMemoryStore(getMemorySqlitePath(agentDir));
		for (const topicFile of ["old.md", "overflow.md", "keep.md"]) {
			store.insertFact(fact({ id: topicFile, topicFile, text: topicFile, createdAt: "2026-08-21T00:00:00.000Z" }));
		}
		await writeProjection(agentDir, projectKey, store);
		const directory = getAutoMemoryPaths(agentDir, join(root, "project")).global.directory;
		writeFileSync(join(directory, "notes.md"), "unrelated\n");
		store.deleteFact("old.md");
		store.deleteFact("overflow.md");
		await writeProjection(agentDir, projectKey, store);
		expect(existsSync(join(directory, "old.md"))).toBe(false);
		expect(existsSync(join(directory, "overflow.md"))).toBe(false);
		expect(existsSync(join(directory, "keep.md"))).toBe(true);
		expect(readFileSync(join(directory, "notes.md"), "utf8")).toBe("unrelated\n");
		store.close();
	});

	it("keeps the old ownership index when stale cleanup fails, then succeeds on retry", async () => {
		const root = mkdtempSync(join(tmpdir(), "metis-proj-"));
		dirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const projectKey = memoryProjectIdentity(cwd).projectKey;
		const store = openMemoryStore(getMemorySqlitePath(agentDir));
		store.insertFact(fact({ id: "old", topicFile: "old.md", text: "old", createdAt: "2026-08-21T00:00:00.000Z" }));
		await writeProjection(agentDir, projectKey, store);
		const paths = getAutoMemoryPaths(agentDir, cwd);
		const oldIndex = readFileSync(paths.global.indexPath, "utf8");
		const alias = join(paths.global.directory, "alias");
		linkSync(join(paths.global.directory, "old.md"), alias);
		store.deleteFact("old");
		await expect(writeProjection(agentDir, projectKey, store)).rejects.toThrow(/aliased/u);
		expect(readFileSync(paths.global.indexPath, "utf8")).toBe(oldIndex);
		unlinkSync(alias);
		await writeProjection(agentDir, projectKey, store);
		expect(readFileSync(paths.global.indexPath, "utf8")).toBe("");
		expect(existsSync(join(paths.global.directory, "old.md"))).toBe(false);
		store.close();
	});
});
