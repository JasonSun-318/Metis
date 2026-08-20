import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getMemorySqlitePath } from "../src/core/auto-memory.ts";
import { ingestMarkdownIfEmpty } from "../src/core/memory/memory-ingest.ts";
import { openMemoryStore } from "../src/core/memory/memory-store.ts";

describe("ingestMarkdownIfEmpty", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("ingests global and project Markdown trees into SQLite once", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "metis-ingest-"));
		dirs.push(agentDir);
		const memoryDir = join(agentDir, "memory");
		const projectDir = join(memoryDir, "projects", "--other--", "code");
		mkdirSync(memoryDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });

		writeFileSync(
			join(memoryDir, "MEMORY.md"),
			"- [preferences.md](preferences.md) — User prefers Chinese\n- [broken](nope) — not valid\n",
		);
		writeFileSync(join(memoryDir, "preferences.md"), "User prefers Chinese replies\n");
		writeFileSync(join(projectDir, "project.md"), "- [auth.md](auth.md) — Auth lives in app-server\n");
		writeFileSync(join(projectDir, "auth.md"), "Auth lives in app-server\n");

		await ingestMarkdownIfEmpty(agentDir);

		const store = openMemoryStore(getMemorySqlitePath(agentDir));
		const global = store.listActiveFacts("global", null, null);
		const project = store.listActiveFacts("project", "--other--", "code");
		expect(global.length).toBeGreaterThanOrEqual(1);
		expect(global.every((f) => f.scope === "global" && f.cwdKey === null && f.mode === null)).toBe(true);
		expect(global.some((f) => f.topicFile === "preferences.md" && f.text.includes("Chinese"))).toBe(true);
		expect(global.every((f) => f.sourceTurn === "ingest" && f.embedding === null)).toBe(true);
		expect(project.length).toBeGreaterThanOrEqual(1);
		expect(project.every((f) => f.scope === "project" && f.cwdKey === "--other--" && f.mode === "code")).toBe(true);
		expect(project.some((f) => f.topicFile === "auth.md" && f.text.includes("Auth"))).toBe(true);
		const countAfterFirst = global.length + project.length;
		store.close();

		await ingestMarkdownIfEmpty(agentDir);
		const store2 = openMemoryStore(getMemorySqlitePath(agentDir));
		const global2 = store2.listActiveFacts("global", null, null);
		const project2 = store2.listActiveFacts("project", "--other--", "code");
		expect(global2.length + project2.length).toBe(countAfterFirst);
		store2.close();
	});

	it("is a no-op for empty memory directories", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "metis-ingest-empty-"));
		dirs.push(agentDir);
		mkdirSync(join(agentDir, "memory"), { recursive: true });

		await ingestMarkdownIfEmpty(agentDir);

		const store = openMemoryStore(getMemorySqlitePath(agentDir));
		expect(store.listActiveFacts("global", null, null)).toEqual([]);
		store.close();
	});

	it("skips secret-like topic chunks", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "metis-ingest-secret-"));
		dirs.push(agentDir);
		const memoryDir = join(agentDir, "memory");
		mkdirSync(memoryDir, { recursive: true });
		writeFileSync(join(memoryDir, "MEMORY.md"), "- [keys.md](keys.md) — Credentials\n");
		writeFileSync(join(memoryDir, "keys.md"), "User prefers Chinese\n\napi_key=sk-live-secret\n");

		await ingestMarkdownIfEmpty(agentDir);

		const store = openMemoryStore(getMemorySqlitePath(agentDir));
		const facts = store.listActiveFacts("global", null, null);
		expect(facts.some((f) => f.text.includes("Chinese"))).toBe(true);
		expect(facts.some((f) => /api_key|sk-live/i.test(f.text))).toBe(false);
		store.close();
	});
});
