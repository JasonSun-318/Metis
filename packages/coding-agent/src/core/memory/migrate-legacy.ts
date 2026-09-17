/**
 * One-shot migration of the legacy memory layout (sqlite facts + flat topic
 * projections) into the markdown vault. Called at the top of `ensureVaultLayout`
 * before any new-format directories are created.
 *
 * Legacy artifacts are never deleted: everything recognized is moved into
 * `.history/legacy-<ISOts>/` with relative paths preserved, facts are rewritten
 * as vault notes, and `.history/migrated.json` marks the run so it stays
 * idempotent. With no legacy data present this performs zero fs writes.
 */
import { randomUUID } from "node:crypto";
import { type Dirent, existsSync, readdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import lockfile from "proper-lockfile";
import {
	createFileAtomicallySync,
	ensureDirectoryDurablySync,
	ensureRealDirectoryDurablySync,
	readSingleLinkTextFileSync,
	replaceFileAtomicallySync,
} from "../durable-file.ts";
import { MEMORY_LOCK_OPTIONS } from "./memory-lock.ts";
import { MemoryVault, serializeNote } from "./vault.ts";
import { MemoryEvents } from "./vault-events.ts";
import { appendChangelog, type ChangelogEntry } from "./vault-history.ts";
import {
	getHistoryDir,
	getNotePath,
	getNotesDir,
	getPinnedDir,
	getProjectMetaPath,
	getScopeDir,
	getVaultRoot,
} from "./vault-paths.ts";
import { resolveVaultProject, type VaultProjectIdentity } from "./vault-project.ts";
import { isSafeSlug, MEMORY_LIMITS, type MemoryScope, type NoteFrontmatter } from "./vault-types.ts";

const SQLITE_FILES = ["memory.sqlite", "memory.sqlite-wal", "memory.sqlite-shm"] as const;
const MIGRATED_MARKER = "migrated.json";
/** Legacy project keys are sha256 hex digests; anything else is never a directory name. */
const LEGACY_PROJECT_KEY = /^[0-9a-f]{64}$/u;
const LEGACY_DIR_PREFIX = "legacy-";
const MIGRATE_ACTOR = { kind: "migrate" } as const;

export interface LegacyMigrationSummary {
	migrated: boolean;
	/** Active fact rows read from the legacy sqlite. */
	facts: number;
	/** Notes written (created or merged into an existing note). */
	notes: number;
	/** Vault-relative directory holding the moved legacy artifacts. */
	legacyDir?: string;
	/** Set when the run failed partway; artifacts already moved stay under `legacyDir`. */
	error?: string;
}

interface LegacyInventory {
	/** Basenames of `memory.sqlite*` files present at the vault root. */
	sqlite: string[];
	/** Top-level `*.md` files in `global/` that predate the vault layout. */
	globalMarkdown: string[];
	/** `projects/<key>` directory names lacking `.project.json`. */
	projectDirs: string[];
}

interface LegacyFact {
	scope: string;
	/** Validated legacy `cwd_key` (sha256 hex) or undefined when unusable. */
	cwdKey?: string;
	topicFile: string;
	text: string;
	createdAt?: string;
}

interface NoteGroup {
	scope: MemoryScope;
	/** Resolved project key; `root` is null for orphan keys with no cwd mapping. */
	project?: { key: string; root: string | null; source: "git" | "cwd" };
	slug: string;
	texts: string[];
	seen: Set<string>;
	dates: string[];
}

function readdirNames(dir: string): string[] {
	try {
		return readdirSync(dir);
	} catch {
		return [];
	}
}

function topLevelMarkdownFiles(dir: string): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.filter((entry) => entry.isFile() && entry.name.endsWith(".md")).map((entry) => entry.name);
}

function topLevelDirs(dir: string): string[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
}

/** Marker file or an existing `legacy-*` archive means a previous run already happened. */
function alreadyMigrated(root: string): boolean {
	const history = getHistoryDir(root);
	if (existsSync(join(history, MIGRATED_MARKER))) return true;
	return readdirNames(history).some((name) => name.startsWith(LEGACY_DIR_PREFIX));
}

function scanLegacy(root: string): LegacyInventory {
	const sqlite = SQLITE_FILES.filter((name) => existsSync(join(root, name)));
	const globalDir = getScopeDir(root, "global");
	// A new-format global dir always contains notes/ + _pinned/; there MEMORY.md is
	// the live index and only stray non-index files count as legacy leftovers.
	const newFormat = existsSync(getNotesDir(globalDir)) || existsSync(getPinnedDir(globalDir));
	let globalMarkdown = topLevelMarkdownFiles(globalDir);
	if (newFormat) globalMarkdown = globalMarkdown.filter((name) => name !== "MEMORY.md");
	const projectsDir = join(root, "projects");
	const projectDirs = topLevelDirs(projectsDir).filter(
		(name) => !existsSync(getProjectMetaPath(join(projectsDir, name))),
	);
	return { sqlite, globalMarkdown, projectDirs };
}

function isEmpty(inventory: LegacyInventory): boolean {
	return inventory.sqlite.length === 0 && inventory.globalMarkdown.length === 0 && inventory.projectDirs.length === 0;
}

/** Standalone reader for the deleted store's schema; a broken db yields no rows. */
function readLegacySqlite(path: string): { facts: LegacyFact[]; projects: Map<string, string> } {
	const facts: LegacyFact[] = [];
	const projects = new Map<string, string>();
	let db: DatabaseSync | undefined;
	try {
		db = new DatabaseSync(path, { readOnly: true });
	} catch {
		return { facts, projects };
	}
	try {
		try {
			const rows = db.prepare("SELECT project_key, canonical_cwd FROM memory_projects").all() as Array<
				Record<string, unknown>
			>;
			for (const row of rows) {
				if (typeof row.project_key === "string" && typeof row.canonical_cwd === "string") {
					projects.set(row.project_key, row.canonical_cwd);
				}
			}
		} catch {
			// Missing/renamed table → no project mapping.
		}
		try {
			const rows = db
				.prepare("SELECT scope, cwd_key, topic_file, text, created_at FROM facts WHERE status = 'active'")
				.all() as Array<Record<string, unknown>>;
			for (const row of rows) {
				if (typeof row.text !== "string" || typeof row.topic_file !== "string") continue;
				const cwdKey =
					typeof row.cwd_key === "string" && LEGACY_PROJECT_KEY.test(row.cwd_key) ? row.cwd_key : undefined;
				facts.push({
					scope: typeof row.scope === "string" ? row.scope : "global",
					...(cwdKey ? { cwdKey } : {}),
					topicFile: row.topic_file,
					text: row.text,
					...(typeof row.created_at === "string" ? { createdAt: row.created_at } : {}),
				});
			}
		} catch {
			// Missing/renamed table → no facts.
		}
	} finally {
		try {
			db.close();
		} catch {
			// Best effort.
		}
	}
	return { facts, projects };
}

/** `topic_file` → vault slug; unrecoverable names fall back to `migrated-<n>`. */
function sanitizeSlug(topicFile: string, fallback: string): string {
	const slug = topicFile
		.toLowerCase()
		.replace(/\.md$/u, "")
		.replace(/[^a-z0-9._-]+/gu, "-")
		.replace(/\.{2,}/gu, ".")
		.replace(/-{2,}/gu, "-")
		.replace(/^[^a-z0-9]+/u, "")
		.replace(/[._-]+$/u, "")
		.slice(0, 120);
	return isSafeSlug(slug) ? slug : fallback;
}

function humanizeSlug(slug: string): string {
	return slug.replace(/[._-]+/gu, " ").trim() || slug;
}

function asDate(value: string | undefined): string | undefined {
	const match = value ? /^(\d{4}-\d{2}-\d{2})/u.exec(value) : null;
	return match?.[1];
}

function groupFacts(facts: LegacyFact[], projects: Map<string, string>): Map<string, NoteGroup> {
	const groups = new Map<string, NoteGroup>();
	let fallbacks = 0;
	for (const fact of facts) {
		const scope: MemoryScope = fact.scope === "project" ? "project" : "global";
		let project: NoteGroup["project"];
		if (scope === "project") {
			// Legacy cwd_key is sha256(canonical cwd); without the memory_projects row
			// the cwd itself is unrecoverable, so the notes stay keyed by that hash.
			if (!fact.cwdKey) continue;
			const canonicalCwd = projects.get(fact.cwdKey);
			let identity: VaultProjectIdentity | undefined;
			if (canonicalCwd !== undefined) {
				try {
					identity = resolveVaultProject(canonicalCwd, "user-selected");
				} catch {
					identity = undefined;
				}
			}
			project = identity
				? { key: identity.projectKey, root: identity.root, source: identity.source }
				: { key: fact.cwdKey, root: null, source: "cwd" };
		}
		const slug = sanitizeSlug(fact.topicFile, `migrated-${++fallbacks}`);
		const text = fact.text.replace(/\s+/gu, " ").trim();
		if (!text) continue;
		const groupKey = `${scope}:${project?.key ?? ""}:${slug}`;
		let group = groups.get(groupKey);
		if (!group) {
			group = { scope, ...(project ? { project } : {}), slug, texts: [], seen: new Set(), dates: [] };
			groups.set(groupKey, group);
		}
		if (!group.seen.has(text)) {
			group.seen.add(text);
			group.texts.push(text);
		}
		const date = asDate(fact.createdAt);
		if (date) group.dates.push(date);
	}
	return groups;
}

/** Append missing `- fact` bullets to an existing note without touching its frontmatter. */
function mergeFactsIntoExisting(path: string, raw: string, texts: string[]): boolean {
	const existing = new Set<string>();
	for (const line of raw.split("\n")) {
		const match = /^- (.*)$/u.exec(line);
		if (match) existing.add(match[1]!.trim());
	}
	const added = texts.filter((text) => !existing.has(text));
	if (added.length === 0) return false;
	const content = `${raw.replace(/\s+$/u, "")}\n${added.map((text) => `- ${text}`).join("\n")}\n`;
	replaceFileAtomicallySync(path, content, { mode: 0o600 });
	return true;
}

function moveIntoLegacy(root: string, legacyDir: string, inventory: LegacyInventory): void {
	const moves: Array<[string, string]> = [];
	for (const name of inventory.sqlite) moves.push([join(root, name), join(legacyDir, name)]);
	for (const name of inventory.globalMarkdown) {
		moves.push([join(root, "global", name), join(legacyDir, "global", name)]);
	}
	for (const name of inventory.projectDirs) {
		moves.push([join(root, "projects", name), join(legacyDir, "projects", name)]);
	}
	for (const [from, to] of moves) {
		try {
			ensureDirectoryDurablySync(dirname(to));
			renameSync(from, to);
		} catch {
			// Leave unmovable artifacts in place; remaining steps cope either way.
		}
	}
}

function runMigration(
	agentDir: string,
	root: string,
	inventory: LegacyInventory,
	events: MemoryEvents,
): LegacyMigrationSummary {
	const at = new Date().toISOString();
	const legacyRel = `.history/${LEGACY_DIR_PREFIX}${at.replace(/[:.]/g, "-")}`;
	const legacyDir = join(root, legacyRel);

	moveIntoLegacy(root, legacyDir, inventory);

	// Read the moved db when possible; fall back to the original path if its move failed.
	let facts: LegacyFact[] = [];
	let projects = new Map<string, string>();
	if (inventory.sqlite.includes("memory.sqlite")) {
		const movedPath = join(legacyDir, "memory.sqlite");
		const dbPath = existsSync(movedPath) ? movedPath : join(root, "memory.sqlite");
		({ facts, projects } = readLegacySqlite(dbPath));
	}

	const today = at.slice(0, 10);
	const touched = new Map<
		string,
		{ scope: MemoryScope; key?: string; root?: string | null; source?: "git" | "cwd" }
	>();
	let notes = 0;
	for (const group of groupFacts(facts, projects).values()) {
		try {
			const scopeDir = getScopeDir(root, group.scope, group.project?.key);
			ensureRealDirectoryDurablySync(getNotesDir(scopeDir), 0o700);
			ensureRealDirectoryDurablySync(getPinnedDir(scopeDir), 0o700);
			if (group.project) {
				const metaPath = getProjectMetaPath(scopeDir);
				if (!existsSync(metaPath)) {
					createFileAtomicallySync(metaPath, JSON.stringify({ root: group.project.root, createdAt: at }), {
						mode: 0o600,
					});
				}
			}
			const path = getNotePath(scopeDir, group.slug);
			const raw = readSingleLinkTextFileSync(path);
			if (raw === undefined) {
				const frontmatter: NoteFrontmatter = {
					name: humanizeSlug(group.slug),
					description: [...(group.texts[0] ?? "")].slice(0, MEMORY_LIMITS.descriptionChars).join(""),
					type: "reference",
					created: group.dates.length ? group.dates.reduce((a, b) => (a < b ? a : b)) : today,
					updated: group.dates.length ? group.dates.reduce((a, b) => (a > b ? a : b)) : today,
					sources: ["migrated"],
					confidence: "medium",
				};
				const body = `# ${frontmatter.name}\n\n${group.texts.map((text) => `- ${text}`).join("\n")}`;
				createFileAtomicallySync(path, serializeNote(frontmatter, body), { mode: 0o600 });
			} else if (!mergeFactsIntoExisting(path, raw, group.texts)) {
				continue; // Existing note already covered every fact; no change to record.
			}
			notes++;
			const entry: ChangelogEntry = {
				id: randomUUID(),
				ts: new Date().toISOString(),
				actor: MIGRATE_ACTOR,
				op: "migrate",
				scope: group.scope,
				target: { slug: group.slug },
				...(group.project ? { projectKey: group.project.key } : {}),
			};
			appendChangelog(root, entry);
			events.emit("changed", { entry });
			const touchKey = `${group.scope}:${group.project?.key ?? ""}`;
			if (!touched.has(touchKey)) {
				touched.set(touchKey, {
					scope: group.scope,
					...(group.project
						? { key: group.project.key, root: group.project.root, source: group.project.source }
						: {}),
				});
			}
		} catch {
			// A single malformed group must not abort the rest of the migration.
		}
	}

	// Rebuild indexes through the vault so ordering and limits match exactly.
	for (const scope of touched.values()) {
		const project =
			scope.key === undefined
				? undefined
				: { root: scope.root ?? "", projectKey: scope.key, source: scope.source ?? "cwd" };
		new MemoryVault({ agentDir, ...(project ? { project } : {}), events }).rebuildIndex(scope.scope);
	}

	replaceFileAtomicallySync(
		join(getHistoryDir(root), MIGRATED_MARKER),
		JSON.stringify({ at, notes, facts: facts.length, legacyDir: legacyRel }),
		{ mode: 0o600 },
	);
	return { migrated: true, facts: facts.length, notes, legacyDir: legacyRel };
}

/**
 * Migrate the legacy layout under `<agentDir>/memory` once. Synchronous and
 * idempotent: returns `{migrated: false}` with zero side effects when no legacy
 * artifacts exist or a previous run already completed.
 */
export function migrateLegacyMemory(agentDir: string, events?: MemoryEvents): LegacyMigrationSummary {
	const root = getVaultRoot(agentDir);
	if (alreadyMigrated(root)) return { migrated: false, facts: 0, notes: 0 };
	const inventory = scanLegacy(root);
	if (isEmpty(inventory)) return { migrated: false, facts: 0, notes: 0 };

	// Serialization against a concurrent app-server/CLI doing the same one-shot
	// move. The sync lock API rejects `retries`; a held lock just means the other
	// process is mid-migration, so skipping is correct.
	let release: (() => void) | undefined;
	try {
		release = lockfile.lockSync(root, {
			realpath: MEMORY_LOCK_OPTIONS.realpath,
			stale: MEMORY_LOCK_OPTIONS.stale,
		});
	} catch {
		return { migrated: false, facts: 0, notes: 0 };
	}
	try {
		if (alreadyMigrated(root)) return { migrated: false, facts: 0, notes: 0 };
		const fresh = scanLegacy(root);
		if (isEmpty(fresh)) return { migrated: false, facts: 0, notes: 0 };
		try {
			return runMigration(agentDir, root, fresh, events ?? new MemoryEvents());
		} catch (error) {
			// Best-effort: a failed run must not take startup down with it. The next
			// ensureVaultLayout retries unless a legacy-* dir was already created.
			return {
				migrated: false,
				facts: 0,
				notes: 0,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	} finally {
		try {
			release();
		} catch {
			// A compromised lock after the fact must not break startup.
		}
	}
}
