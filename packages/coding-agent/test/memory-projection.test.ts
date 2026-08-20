import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getAutoMemoryPaths, getMemorySqlitePath, loadAutoMemory } from "../src/core/auto-memory.ts";
import { renderProjection, writeProjection } from "../src/core/memory/memory-projection.ts";
import { openMemoryStore } from "../src/core/memory/memory-store.ts";
import type { MemoryFact } from "../src/core/memory/memory-types.ts";
import { canonicalizePathForCreation, encodePathForStorage } from "../src/utils/paths.ts";

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

	it("renders one preferences index line and a topic file with both fact texts", () => {
		const facts = [
			fact({
				id: "a",
				topicFile: "preferences.md",
				text: "User prefers Chinese replies",
				createdAt: "2026-08-21T00:00:00.000Z",
			}),
			fact({
				id: "b",
				topicFile: "preferences.md",
				text: "User likes concise answers",
				createdAt: "2026-08-21T01:00:00.000Z",
			}),
		];

		const rendered = renderProjection(facts);
		const lines = rendered.indexMarkdown.split(/\r?\n/).filter((line) => line.trim().length > 0);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatch(INDEX_ENTRY);
		expect(lines[0]).toMatch(/^- \[preferences\.md\]\(preferences\.md\) — /);
		const sentence = lines[0]!.split(" — ", 2)[1]!;
		expect(sentence.length).toBeLessThanOrEqual(120);
		expect(sentence).toContain("Chinese");
		expect(sentence).toContain("concise");

		const topic = rendered.topicFiles.get("preferences.md");
		expect(topic).toBeDefined();
		expect(topic).toContain("User prefers Chinese replies");
		expect(topic).toContain("User likes concise answers");
		expect(rendered.truncated).toBe(false);
		expect(rendered.omittedTopicCount).toBe(0);
	});

	it("truncates the returned index to maxIndexLines by latest createdAt", () => {
		const facts: MemoryFact[] = [];
		for (let i = 0; i < 205; i++) {
			facts.push(
				fact({
					id: `t${i}`,
					topicFile: `topic-${String(i).padStart(3, "0")}.md`,
					text: `Fact ${i}`,
					createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
				}),
			);
		}

		const rendered = renderProjection(facts, { maxIndexLines: 200 });
		const lines = rendered.indexMarkdown.split(/\r?\n/).filter((line) => INDEX_ENTRY.test(line));
		expect(lines).toHaveLength(200);
		expect(rendered.truncated).toBe(true);
		expect(rendered.omittedTopicCount).toBe(5);
		expect(lines[0]).toContain("topic-204.md");
		expect(lines[199]).toContain("topic-005.md");
		expect(rendered.topicFiles.size).toBe(205);
	});

	it("writeProjection writes full catalogs on disk while loadAutoMemory still truncates", () => {
		const root = mkdtempSync(join(tmpdir(), "metis-proj-"));
		dirs.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const sqlitePath = getMemorySqlitePath(agentDir);
		expect(sqlitePath).toBe(join(agentDir, "memory", "memory.sqlite"));

		const store = openMemoryStore(sqlitePath);
		const cwdKey = encodePathForStorage(canonicalizePathForCreation(cwd));

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
				text: "User likes concise answers",
				createdAt: "2026-08-21T01:00:00.000Z",
			}),
		);

		for (let i = 0; i < 205; i++) {
			store.insertFact(
				fact({
					id: `p${i}`,
					scope: "project",
					cwdKey,
					mode: "chat",
					topicFile: `topic-${String(i).padStart(3, "0")}.md`,
					text: `Project fact ${i}`,
					createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
				}),
			);
		}

		writeProjection(agentDir, cwd, "chat", store);
		store.close();

		const paths = getAutoMemoryPaths(agentDir, cwd, "chat");
		const globalIndex = readFileSync(paths.global.indexPath, "utf8");
		const globalLines = globalIndex.split(/\r?\n/).filter((line) => INDEX_ENTRY.test(line));
		expect(globalLines).toHaveLength(1);
		expect(globalLines[0]).toMatch(/^- \[preferences\.md\]\(preferences\.md\) — /);
		const preferences = readFileSync(join(paths.global.directory, "preferences.md"), "utf8");
		expect(preferences).toContain("User prefers Chinese replies");
		expect(preferences).toContain("User likes concise answers");

		const projectIndex = readFileSync(paths.project.indexPath, "utf8");
		const projectLines = projectIndex.split(/\r?\n/).filter((line) => INDEX_ENTRY.test(line));
		expect(projectLines).toHaveLength(205);
		expect(projectLines[0]).toContain("topic-204.md");
		expect(readFileSync(join(paths.project.directory, "topic-204.md"), "utf8")).toContain("Project fact 204");
		expect(readFileSync(join(paths.project.directory, "topic-000.md"), "utf8")).toContain("Project fact 0");

		const loaded = loadAutoMemory(agentDir, cwd, "chat");
		expect(loaded.project.truncated).toBe(true);
		const loadedLines = loaded.project.content.split(/\r?\n/).filter((line) => INDEX_ENTRY.test(line));
		expect(loadedLines.length).toBeLessThanOrEqual(200);
		expect(loadedLines[0]).toContain("topic-204.md");
	});
});
