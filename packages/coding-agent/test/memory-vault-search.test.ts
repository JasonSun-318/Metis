import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryVault } from "../src/core/memory/vault.ts";
import { resolveVaultProject } from "../src/core/memory/vault-project.ts";
import { MemorySearchIndex } from "../src/core/memory/vault-search.ts";
import type { MemoryActor, NoteType } from "../src/core/memory/vault-types.ts";
import { readUsage, recordUsage } from "../src/core/memory/vault-usage.ts";

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
		await recordUsage(vault.root, ["global/used-note"]);
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
		expect(readUsage(vault.root)["global/rec"]).toBeUndefined();

		index.search("track me");
		await index.whenIdle();
		expect(readUsage(vault.root)["global/rec"]?.useCount).toBe(1);
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
