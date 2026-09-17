import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

const durableMock = vi.hoisted(() => ({ failOnce: new Set<string>() }));
vi.mock("../src/core/durable-file.ts", async (importOriginal) => {
	const mod = await importOriginal<typeof import("../src/core/durable-file.ts")>();
	return {
		...mod,
		replaceFileAtomicallySync: (path: string, data: string | Uint8Array, options?: { mode?: number }) => {
			if (durableMock.failOnce.delete(path)) throw new Error("injected write failure");
			return mod.replaceFileAtomicallySync(path, data, options);
		},
	};
});

import { ensureVaultLayout } from "../src/core/auto-memory.ts";
import { migrateLegacyMemory } from "../src/core/memory/migrate-legacy.ts";
import { MemoryVault } from "../src/core/memory/vault.ts";
import { readChangelog } from "../src/core/memory/vault-history.ts";
import { getScopeDir, getVaultRoot } from "../src/core/memory/vault-paths.ts";
import { resolveVaultProject } from "../src/core/memory/vault-project.ts";
import { INDEX_ENTRY } from "../src/core/memory/vault-types.ts";
import { canonicalizePathForCreation } from "../src/utils/paths.ts";

/** The deleted store's schema, kept verbatim so fixtures match real legacy dbs. */
const LEGACY_SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  cwd_key TEXT,
  mode TEXT,
  topic_file TEXT NOT NULL,
  text TEXT NOT NULL,
  fingerprint TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  source_turn TEXT,
  embedding BLOB,
  embedding_model TEXT
);
CREATE TABLE IF NOT EXISTS memory_projects (
  project_key TEXT PRIMARY KEY,
  canonical_cwd TEXT NOT NULL UNIQUE,
  legacy_key TEXT NOT NULL,
  legacy_claimed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
`;

interface FactFixture {
	scope: "global" | "project";
	cwdKey?: string;
	topicFile: string;
	text: string;
	status?: string;
	createdAt?: string;
}

function oldKey(cwd: string): string {
	return createHash("sha256").update(canonicalizePathForCreation(cwd)).digest("hex");
}

function writeLegacyDb(dbPath: string, facts: FactFixture[], projects: Array<{ key: string; cwd: string }>): void {
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new DatabaseSync(dbPath);
	try {
		db.exec("PRAGMA journal_mode = WAL;");
		db.exec(LEGACY_SCHEMA);
		const insertFact = db.prepare(
			"INSERT INTO facts (id, scope, cwd_key, mode, topic_file, text, fingerprint, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
		);
		const insertProject = db.prepare(
			"INSERT INTO memory_projects (project_key, canonical_cwd, legacy_key, legacy_claimed, created_at) VALUES (?, ?, ?, 0, ?)",
		);
		for (const project of projects) {
			insertProject.run(
				project.key,
				canonicalizePathForCreation(project.cwd),
				`legacy-${project.key.slice(0, 8)}`,
				"2025-01-01T00:00:00.000Z",
			);
		}
		let index = 0;
		for (const fact of facts) {
			insertFact.run(
				`fact-${index++}`,
				fact.scope,
				fact.cwdKey ?? null,
				"code",
				fact.topicFile,
				fact.text,
				null,
				fact.status ?? "active",
				fact.createdAt ?? "2025-06-01T12:00:00.000Z",
			);
		}
	} finally {
		db.close();
	}
}

function legacyDirs(root: string): string[] {
	const history = join(root, ".history");
	try {
		return readdirSync(history).filter((name) => name.startsWith("legacy-"));
	} catch {
		return [];
	}
}

function tree(dir: string, prefix = ""): string[] {
	const out: string[] = [];
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return out;
	}
	for (const name of names.sort()) {
		out.push(`${prefix}${name}`);
		out.push(...tree(join(dir, name), `${prefix}${name}/`));
	}
	return out;
}

describe("migrateLegacyMemory", () => {
	const tempDirs: string[] = [];
	const makeTemp = (): string => {
		const dir = mkdtempSync(join(tmpdir(), "metis-migrate-"));
		tempDirs.push(dir);
		return dir;
	};

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("returns unmigrated with zero side effects on an empty agentDir", () => {
		const agentDir = join(makeTemp(), "agent");
		const result = migrateLegacyMemory(agentDir);
		expect(result).toEqual({ migrated: false, facts: 0, notes: 0 });
		expect(existsSync(getVaultRoot(agentDir))).toBe(false);
	});

	it("ignores a vault that only contains new-format content", () => {
		const agentDir = join(makeTemp(), "agent");
		ensureVaultLayout(agentDir);
		const root = getVaultRoot(agentDir);
		const globalDir = getScopeDir(root, "global");
		writeFileSync(join(globalDir, "MEMORY.md"), "- [reference] [existing](notes/existing.md) — already here\n");
		writeFileSync(
			join(globalDir, "notes", "existing.md"),
			"---\nname: existing\ndescription: already here\ntype: reference\ncreated: 2026-09-01\nupdated: 2026-09-01\nsources: [user]\nconfidence: high\n---\n# existing\n",
		);
		const result = migrateLegacyMemory(agentDir);
		expect(result.migrated).toBe(false);
		expect(readFileSync(join(globalDir, "MEMORY.md"), "utf8")).toContain("existing");
		expect(existsSync(join(globalDir, "notes", "existing.md"))).toBe(true);
		expect(legacyDirs(root)).toEqual([]);
	});

	it("migrates facts to notes, merges sibling project keys to the git root, and archives the old layout", () => {
		const base = makeTemp();
		const agentDir = join(base, "agent");
		const root = getVaultRoot(agentDir);

		const repoRoot = join(base, "repo");
		mkdirSync(join(repoRoot, ".git"), { recursive: true });
		const subdir = join(repoRoot, "packages", "x");
		mkdirSync(subdir, { recursive: true });
		const plainDir = join(base, "plain");
		mkdirSync(plainDir);

		const keyA = oldKey(repoRoot);
		const keyB = oldKey(subdir);
		const keyC = oldKey(plainDir);
		const mergedKey = resolveVaultProject(repoRoot, "user-selected")!.projectKey;
		expect(mergedKey).toBe(keyA);
		expect(mergedKey).not.toBe(keyB);

		writeLegacyDb(
			join(root, "memory.sqlite"),
			[
				{
					scope: "global",
					topicFile: "preferences.md",
					text: "likes dark mode",
					createdAt: "2025-05-01T00:00:00.000Z",
				},
				{
					scope: "global",
					topicFile: "preferences.md",
					text: "prefers pnpm over npm",
					createdAt: "2025-06-02T00:00:00.000Z",
				},
				{ scope: "global", topicFile: "preferences.md", text: "should not migrate", status: "archived" },
				{ scope: "project", cwdKey: keyA, topicFile: "setup.md", text: "run pnpm dev" },
				{ scope: "project", cwdKey: keyA, topicFile: "setup.md", text: "tests need docker" },
				{ scope: "project", cwdKey: keyB, topicFile: "setup.md", text: "run pnpm dev" }, // duplicate merges away
				{ scope: "project", cwdKey: keyB, topicFile: "setup.md", text: "build via turbo" },
				{ scope: "project", cwdKey: keyC, topicFile: "notes.md", text: "plain dir fact" },
			],
			[
				{ key: keyA, cwd: repoRoot },
				{ key: keyB, cwd: subdir },
				// keyC deliberately unmapped: its facts stay under the old key.
			],
		);

		// Legacy projection files (flat layout).
		mkdirSync(join(root, "global"), { recursive: true });
		writeFileSync(join(root, "global", "MEMORY.md"), "- [preferences.md](preferences.md) — old index\n");
		writeFileSync(join(root, "global", "preferences.md"), "likes dark mode\nprefers pnpm over npm\n");
		for (const [key, files] of [
			[keyA, ["project.md", "setup.md"]],
			[keyB, ["project.md"]],
			[keyC, ["project.md", "notes.md"]],
		] as const) {
			mkdirSync(join(root, "projects", key), { recursive: true });
			for (const file of files) writeFileSync(join(root, "projects", key, file), `${file} contents\n`);
		}

		const result = migrateLegacyMemory(agentDir);
		expect(result.migrated).toBe(true);
		expect(result.facts).toBe(7);
		expect(result.notes).toBe(3);

		// Legacy archive preserves relative paths.
		const [legacy] = legacyDirs(root);
		expect(legacy).toBeDefined();
		const legacyRoot = join(root, ".history", legacy!);
		expect(existsSync(join(legacyRoot, "memory.sqlite"))).toBe(true);
		expect(readFileSync(join(legacyRoot, "global", "MEMORY.md"), "utf8")).toContain("old index");
		expect(existsSync(join(legacyRoot, "global", "preferences.md"))).toBe(true);
		expect(existsSync(join(legacyRoot, "projects", keyA, "project.md"))).toBe(true);
		expect(existsSync(join(legacyRoot, "projects", keyB, "project.md"))).toBe(true);
		expect(existsSync(join(legacyRoot, "projects", keyC, "notes.md"))).toBe(true);
		// Old files are gone from the live layout.
		expect(existsSync(join(root, "memory.sqlite"))).toBe(false);
		expect(existsSync(join(root, "projects", keyB))).toBe(false);
		expect(readFileSync(join(root, "global", "MEMORY.md"), "utf8")).not.toContain("old index");

		// Global note.
		const preferences = readFileSync(join(root, "global", "notes", "preferences.md"), "utf8");
		expect(preferences).toContain("type: reference");
		expect(preferences).toContain("- likes dark mode");
		expect(preferences).toContain("- prefers pnpm over npm");
		expect(preferences).not.toContain("should not migrate");
		const prefNote = new MemoryVault({ agentDir }).readNote("global", "preferences")!;
		expect(prefNote.frontmatter.type).toBe("reference");
		expect(prefNote.frontmatter.created).toBe("2025-05-01");
		expect(prefNote.frontmatter.updated).toBe("2025-06-02");
		expect(prefNote.frontmatter.sources).toEqual(["migrated"]);
		expect(prefNote.frontmatter.confidence).toBe("medium");

		// keyA + keyB merged into the git-root project.
		const mergedDir = join(root, "projects", mergedKey);
		const setup = readFileSync(join(mergedDir, "notes", "setup.md"), "utf8");
		expect(setup.match(/^- /gmu)).toHaveLength(3);
		expect(setup).toContain("- run pnpm dev");
		expect(setup).toContain("- tests need docker");
		expect(setup).toContain("- build via turbo");
		expect(JSON.parse(readFileSync(join(mergedDir, ".project.json"), "utf8")).root).toBe(
			canonicalizePathForCreation(repoRoot),
		);
		const projectIndex = readFileSync(join(mergedDir, "MEMORY.md"), "utf8").trim();
		expect(projectIndex).toMatch(INDEX_ENTRY);
		expect(projectIndex).toContain("setup");

		// Orphan key stays under its own hash with an unknown root.
		const orphanDir = join(root, "projects", keyC);
		expect(readFileSync(join(orphanDir, "notes", "notes.md"), "utf8")).toContain("- plain dir fact");
		expect(JSON.parse(readFileSync(join(orphanDir, ".project.json"), "utf8")).root).toBeNull();

		// Changelog: one migrate entry per note, not undoable.
		const entries = readChangelog(root);
		const migrations = entries.filter((entry) => entry.op === "migrate");
		expect(migrations).toHaveLength(3);
		for (const entry of migrations) {
			expect(entry.actor).toEqual({ kind: "migrate" });
			expect(entry.undoneBy).toBeUndefined();
		}
		expect(migrations.filter((entry) => entry.scope === "project")).toHaveLength(2);
		expect(migrations.find((entry) => entry.projectKey === mergedKey)).toBeDefined();

		// Marker written.
		expect(existsSync(join(root, ".history", "migrated.json"))).toBe(true);

		// Re-run is a no-op.
		const before = tree(root);
		const second = migrateLegacyMemory(agentDir);
		expect(second).toEqual({ migrated: false, facts: 0, notes: 0 });
		expect(tree(root)).toEqual(before);
		expect(legacyDirs(root)).toHaveLength(1);
	});

	it("reports an error and keeps the journal when the sqlite is corrupt", () => {
		const agentDir = join(makeTemp(), "agent");
		const root = getVaultRoot(agentDir);
		mkdirSync(join(root, "global"), { recursive: true });
		writeFileSync(join(root, "memory.sqlite"), Buffer.from("not a sqlite database"));
		writeFileSync(join(root, "global", "MEMORY.md"), "- [old.md](old.md) — old\n");
		writeFileSync(join(root, "global", "old.md"), "stale projection\n");

		const result = migrateLegacyMemory(agentDir);
		expect(result.migrated).toBe(false);
		expect(result.error).toBeDefined();
		expect(existsSync(join(root, ".history", "migrated.json"))).toBe(false);
		expect(existsSync(join(root, ".history", "migration-in-progress.json"))).toBe(true);

		// The artifacts were still archived; nothing is left at the live root.
		const [legacy] = legacyDirs(root);
		expect(existsSync(join(root, ".history", legacy!, "memory.sqlite"))).toBe(true);
		expect(existsSync(join(root, ".history", legacy!, "global", "old.md"))).toBe(true);
		expect(existsSync(join(root, "global", "notes"))).toBe(false);
		// A retry fails the same way instead of committing an empty migration.
		expect(migrateLegacyMemory(agentDir).error).toBeDefined();
	});

	it("moves legacy project dirs even without a sqlite", () => {
		const agentDir = join(makeTemp(), "agent");
		const root = getVaultRoot(agentDir);
		const key = "0".repeat(64);
		mkdirSync(join(root, "projects", key), { recursive: true });
		writeFileSync(join(root, "projects", key, "project.md"), "old project index\n");

		const result = migrateLegacyMemory(agentDir);
		expect(result.migrated).toBe(true);
		expect(result.notes).toBe(0);
		expect(existsSync(join(root, "projects", key))).toBe(false);
		const [legacy] = legacyDirs(root);
		expect(readFileSync(join(root, ".history", legacy!, "projects", key, "project.md"), "utf8")).toContain(
			"old project index",
		);
	});

	it("leaves new-format project dirs with .project.json alone", () => {
		const agentDir = join(makeTemp(), "agent");
		const root = getVaultRoot(agentDir);
		const key = "f".repeat(64);
		mkdirSync(join(root, "projects", key), { recursive: true });
		writeFileSync(join(root, "projects", key, ".project.json"), JSON.stringify({ root: "/somewhere" }));

		const result = migrateLegacyMemory(agentDir);
		expect(result.migrated).toBe(false);
		expect(existsSync(join(root, "projects", key, ".project.json"))).toBe(true);
		expect(legacyDirs(root)).toEqual([]);
	});

	it("resumes an archive created before any notes or completion marker", () => {
		const agentDir = join(makeTemp(), "agent");
		const archive = join(agentDir, "memory", ".history", "legacy-interrupted");
		mkdirSync(archive, { recursive: true });
		const db = new DatabaseSync(join(archive, "memory.sqlite"));
		db.exec(
			"CREATE TABLE facts (scope TEXT, cwd_key TEXT, topic_file TEXT, text TEXT, created_at TEXT, status TEXT); INSERT INTO facts VALUES ('global', NULL, 'prefs.md', 'original durable preference', '2026-01-01', 'active');",
		);
		db.close();
		const result = migrateLegacyMemory(agentDir);
		expect(result.error).toBeUndefined();
		expect(new MemoryVault({ agentDir }).readNote("global", "prefs")!.body).toContain("original durable preference");
		expect(existsSync(join(archive, "memory.sqlite"))).toBe(true);
		const first = readFileSync(join(agentDir, "memory", "global", "notes", "prefs.md"), "utf8");
		migrateLegacyMemory(agentDir);
		expect(readFileSync(join(agentDir, "memory", "global", "notes", "prefs.md"), "utf8")).toBe(first);
	});

	it("does not complete migration after a note destination fails", () => {
		const agentDir = join(makeTemp(), "agent");
		const root = getVaultRoot(agentDir);
		writeLegacyDb(join(root, "memory.sqlite"), [{ scope: "global", topicFile: "prefs.md", text: "keep this" }], []);
		mkdirSync(join(root, "global", "notes", "prefs.md"), { recursive: true });
		const failed = migrateLegacyMemory(agentDir);
		expect(failed.error).toBeDefined();
		expect(existsSync(join(root, ".history", "migrated.json"))).toBe(false);
		rmSync(join(root, "global", "notes", "prefs.md"), { recursive: true });
		expect(migrateLegacyMemory(agentDir).error).toBeUndefined();
		expect(new MemoryVault({ agentDir }).readNote("global", "prefs")!.body).toContain("keep this");
	});

	it("resume preserves user edits and never duplicates migrated facts", () => {
		const agentDir = join(makeTemp(), "agent");
		const root = getVaultRoot(agentDir);
		mkdirSync(join(root, ".history", "legacy-x"), { recursive: true });
		writeLegacyDb(
			join(root, ".history", "legacy-x", "memory.sqlite"),
			[{ scope: "global", topicFile: "prefs.md", text: "keep this" }],
			[],
		);
		// The interrupted run wrote the note; the user edited it afterwards.
		new MemoryVault({ agentDir }).ensureLayout();
		writeFileSync(
			join(root, "global", "notes", "prefs.md"),
			"---\nname: prefs\ndescription: user edited\ntype: reference\ncreated: 2026-01-01\nupdated: 2026-01-02\nsources: [migrated, user]\nconfidence: medium\n---\n# prefs\n\n- keep this\n\nuser added text\n",
		);
		writeFileSync(
			join(root, ".history", "migration-in-progress.json"),
			JSON.stringify({
				version: 1,
				phase: "importing",
				archives: [
					{
						relativeDir: ".history/legacy-x",
						inventory: { sqlite: ["memory.sqlite"], globalMarkdown: [], projectDirs: [] },
						completedGroups: [],
					},
				],
			}),
		);
		const result = migrateLegacyMemory(agentDir);
		expect(result.error).toBeUndefined();
		const note = new MemoryVault({ agentDir }).readNote("global", "prefs")!;
		expect(note.body).toContain("user added text");
		expect(note.frontmatter.description).toBe("user edited");
		expect(note.body.match(/keep this/gu)).toHaveLength(1);
		expect(existsSync(join(root, ".history", "migrated.json"))).toBe(true);
		expect(existsSync(join(root, ".history", "migration-in-progress.json"))).toBe(false);
	});

	it("cleans a stale journal left behind after the marker without re-importing", () => {
		const agentDir = join(makeTemp(), "agent");
		const root = getVaultRoot(agentDir);
		writeLegacyDb(join(root, "memory.sqlite"), [{ scope: "global", topicFile: "prefs.md", text: "keep this" }], []);
		expect(migrateLegacyMemory(agentDir).error).toBeUndefined();
		const [legacy] = legacyDirs(root);
		expect(legacy).toBeDefined();
		const before = readChangelog(root).filter((entry) => entry.op === "migrate").length;
		// Simulate a crash between writing the marker and deleting the journal.
		writeFileSync(
			join(root, ".history", "migration-in-progress.json"),
			JSON.stringify({
				version: 1,
				phase: "importing",
				archives: [
					{
						relativeDir: `.history/${legacy}`,
						inventory: { sqlite: ["memory.sqlite"], globalMarkdown: [], projectDirs: [] },
						completedGroups: [],
					},
				],
			}),
		);
		expect(migrateLegacyMemory(agentDir)).toEqual({ migrated: false, facts: 0, notes: 0 });
		expect(existsSync(join(root, ".history", "migration-in-progress.json"))).toBe(false);
		expect(readChangelog(root).filter((entry) => entry.op === "migrate")).toHaveLength(before);
	});

	it("does not duplicate migrate entries when the marker write fails", () => {
		const agentDir = join(makeTemp(), "agent");
		const root = getVaultRoot(agentDir);
		writeLegacyDb(join(root, "memory.sqlite"), [{ scope: "global", topicFile: "prefs.md", text: "keep this" }], []);
		durableMock.failOnce.add(join(root, ".history", "migrated.json"));
		expect(migrateLegacyMemory(agentDir).error).toBeDefined();
		const migrations = readChangelog(root).filter((entry) => entry.op === "migrate");
		expect(migrations.length).toBeGreaterThan(0);
		expect(existsSync(join(root, ".history", "migration-in-progress.json"))).toBe(true);
		expect(migrateLegacyMemory(agentDir).error).toBeUndefined();
		expect(readChangelog(root).filter((entry) => entry.op === "migrate")).toHaveLength(migrations.length);
	});

	it("runs through ensureVaultLayout before the new dirs exist", () => {
		const agentDir = join(makeTemp(), "agent");
		const root = getVaultRoot(agentDir);
		mkdirSync(join(root, "global"), { recursive: true });
		writeFileSync(join(root, "global", "MEMORY.md"), "- [x.md](x.md) — old\n");

		ensureVaultLayout(agentDir);
		expect(legacyDirs(root)).toHaveLength(1);
		// New layout is created afterwards as usual.
		expect(existsSync(join(root, "global", "notes"))).toBe(true);
		expect(existsSync(join(root, "global", "_pinned"))).toBe(true);
		expect(existsSync(join(root, ".history", "migrated.json"))).toBe(true);
	});
});
