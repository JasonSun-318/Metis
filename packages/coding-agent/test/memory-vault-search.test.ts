import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryVault } from "../src/core/memory/vault.ts";
import { memoryUsageKey } from "../src/core/memory/vault-identity.ts";
import { resolveVaultProject } from "../src/core/memory/vault-project.ts";
import { MemorySearchIndex } from "../src/core/memory/vault-search.ts";
import type { MemoryActor, NoteType } from "../src/core/memory/vault-types.ts";
import { readUsage, recordUsage, removeUsage } from "../src/core/memory/vault-usage.ts";
import { putNote, withMemoryFixture } from "./helpers/memory-vault-fixture.ts";

const AGENT: MemoryActor = { kind: "agent", sessionId: "sess-1" };

describe("MemorySearchIndex", () => {
	const tempDirs: string[] = [];
	const makeTemp = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "metis-vault-search-"));
		tempDirs.push(dir);
		return dir;
	};

	async function makeVault(opts?: { withProject?: boolean }) {
		const root = makeTemp();
		const agentDir = join(root, "agent");
		const cwd = join(root, "work");
		const project = opts?.withProject ? resolveVaultProject(cwd, "user-selected") : undefined;
		const vault = new MemoryVault({ agentDir, project });
		vault.ensureLayout();
		return vault;
	}

	async function addNote(
		vault: MemoryVault,
		note: {
			slug: string;
			scope?: "global" | "project";
			type?: NoteType;
			description?: string;
			aliases?: string[];
			content: string;
		},
	) {
		const result = await vault.write(
			{
				op: "create",
				scope: note.scope ?? "global",
				target: { slug: note.slug },
				frontmatter: {
					type: note.type ?? "reference",
					description: note.description ?? note.slug,
					aliases: note.aliases,
				},
				content: note.content,
			},
			AGENT,
		);
		if (!result.ok) throw new Error(`setup write failed: ${result.error}`);
	}

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("matches mixed Chinese and English queries", async () => {
		const vault = await makeVault();
		await addNote(vault, { slug: "pkg", content: "该项目只用 pnpm，npm install 会破坏 lockfile" });
		await addNote(vault, { slug: "other", content: "unrelated cooking recipes" });
		const index = new MemorySearchIndex(vault);
		const hits = index.search("pnpm 包管理", { recordUsage: false });
		expect(hits[0]?.slug).toBe("pkg");
	});

	it("matches aliases", async () => {
		const vault = await makeVault();
		await addNote(vault, { slug: "pnpm-only", aliases: ["包管理"], content: "details" });
		await addNote(vault, { slug: "plain", content: "nothing relevant" });
		const index = new MemorySearchIndex(vault);
		const hits = index.search("包管理", { recordUsage: false });
		expect(hits[0]?.slug).toBe("pnpm-only");
	});

	it("matches Chinese substrings via bigrams", async () => {
		const vault = await makeVault();
		await addNote(vault, { slug: "conventions", content: "提交信息必须使用约定式格式" });
		await addNote(vault, { slug: "other", content: "zzz" });
		const index = new MemorySearchIndex(vault);
		const hits = index.search("约定式", { recordUsage: false });
		expect(hits.map((hit) => hit.slug)).toContain("conventions");
	});

	it("applies recency decay to older notes", async () => {
		const vault = await makeVault();
		await addNote(vault, { slug: "old-note", content: "deploy uses helm charts" });
		await addNote(vault, { slug: "new-note", content: "deploy uses helm charts" });
		const stale = vault.readNote("global", "old-note")!;
		writeFileSync(stale.path, readFileSync(stale.path, "utf8").replace(/updated: .*/u, "updated: 2020-01-01"));
		const index = new MemorySearchIndex(vault);
		const hits = index.search("helm charts", { recordUsage: false });
		expect(hits.map((hit) => hit.slug)).toEqual(["new-note", "old-note"]);
	});

	it("boosts notes with recorded usage", async () => {
		const vault = await makeVault();
		await addNote(vault, { slug: "used-note", content: "identical deploy procedure" });
		await addNote(vault, { slug: "idle-note", content: "identical deploy procedure" });
		await recordUsage(vault.root, ["global/notes/used-note"]);
		const index = new MemorySearchIndex(vault);
		const hits = index.search("deploy procedure", { recordUsage: false });
		expect(hits[0]?.slug).toBe("used-note");
	});

	it("records usage by default and skips it when recordUsage is false", async () => {
		const vault = await makeVault();
		await addNote(vault, { slug: "rec", content: "track me please" });
		const index = new MemorySearchIndex(vault);
		index.search("track me", { recordUsage: false });
		await index.whenIdle();
		expect(readUsage(vault.root)["global/notes/rec"]).toBeUndefined();

		index.search("track me");
		await index.whenIdle();
		expect(readUsage(vault.root)["global/notes/rec"]?.useCount).toBe(1);
	});

	it("project A searches never change project B scores", async () => {
		await withMemoryFixture(async (f) => {
			const a = f.vault("a");
			const b = f.vault("b");
			await putNote(a, "project", "z-shared", "needle");
			await putNote(b, "project", "z-shared", "needle");
			await putNote(b, "project", "a-other", "needle");
			const ia = new MemorySearchIndex(a);
			const ib = new MemorySearchIndex(b);
			const before = ib.search("needle", { recordUsage: false }).map((hit) => hit.slug);
			ia.search("needle");
			await ia.whenIdle();
			expect(ib.search("needle", { recordUsage: false }).map((hit) => hit.slug)).toEqual(before);
		});
	});

	it("legacy usage keys migrate to per-project keys conservatively", async () => {
		await withMemoryFixture(async (f) => {
			const a = f.vault("a");
			const b = f.vault("b");
			await putNote(a, "project", "shared", "alpha");
			await putNote(b, "project", "shared", "beta");
			const usagePath = join(f.agentDir, "memory", ".meta", "usage.json");
			writeFileSync(
				usagePath,
				JSON.stringify({
					"global/x": { useCount: 2, lastUsed: "2026-01-01T00:00:00Z" },
					"project/shared": { useCount: 3, lastUsed: "2026-01-01T00:00:00Z" },
				}),
			);
			const keyA = memoryUsageKey("project", "shared", f.project("a").projectKey);
			const keyB = memoryUsageKey("project", "shared", f.project("b").projectKey);
			const first = readUsage(a.root);
			expect(first["global/notes/x"]?.useCount).toBe(2);
			expect(first[keyA]?.useCount).toBe(3);
			expect(first[keyB]?.useCount).toBe(3);
			// Repeated reads don't double-count and stay normalized.
			expect(readUsage(a.root)[keyA]?.useCount).toBe(3);

			const index = new MemorySearchIndex(a);
			index.search("alpha");
			await index.whenIdle();
			const after = readUsage(a.root);
			expect(after[keyA]?.useCount).toBe(4);
			expect(after[keyB]?.useCount).toBe(3);
			// The original v1 file was preserved before the first locked rewrite.
			const backup = join(f.agentDir, "memory", ".meta", "usage-v1.json");
			expect(existsSync(backup)).toBe(true);
			expect(JSON.parse(readFileSync(backup, "utf8"))["project/shared"]?.useCount).toBe(3);
			expect(readFileSync(usagePath, "utf8")).not.toContain("project/shared");

			await removeUsage(a.root, [keyA]);
			expect(readUsage(a.root)[keyB]?.useCount).toBe(3);
		});
	});

	it("filters by scope and type", async () => {
		const vault = await makeVault({ withProject: true });
		await addNote(vault, { slug: "g-note", content: "shared keyword content" });
		await addNote(vault, {
			slug: "p-note",
			scope: "project",
			type: "project",
			content: "shared keyword content",
		});
		const index = new MemorySearchIndex(vault);
		expect(index.search("shared keyword", { scope: "global", recordUsage: false }).map((hit) => hit.slug)).toEqual([
			"g-note",
		]);
		expect(index.search("shared keyword", { scope: "project", recordUsage: false }).map((hit) => hit.slug)).toEqual([
			"p-note",
		]);
		expect(index.search("shared keyword", { type: "project", recordUsage: false }).map((hit) => hit.slug)).toEqual([
			"p-note",
		]);
	});
});
