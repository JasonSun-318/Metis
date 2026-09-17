/**
 * One-shot migration of the legacy memory layout (sqlite facts + flat topic
 * projections) into the markdown vault. Called at the top of `ensureVaultLayout`
 * before any new-format directories are created.
 *
 * Legacy artifacts are never deleted: everything recognized is moved into
 * `.history/legacy-<ISOts>/` with relative paths preserved, facts are rewritten
 * as vault notes, and `.history/migrated.json` marks the run so it stays
 * idempotent. With no legacy data present this performs zero fs writes.
 *
 * Interrupted runs resume through `.history/migration-in-progress.json`: the
 * journal is written before any file moves, records which note groups already
 * imported, and is only removed after the completion marker lands. Archives
 * left behind by a pre-journal run are re-imported in place instead of
 * producing a second archive.
 */
import { randomUUID } from "node:crypto";
import { type Dirent, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
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
import { appendChangelog, type ChangelogEntry, readChangelog } from "./vault-history.ts";
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
const MIGRATION_JOURNAL = "migration-in-progress.json";
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

interface LegacyMigrationJournal {
	version: 1;
	phase: "archiving" | "importing";
	archives: Array<{ relativeDir: string; inventory: LegacyInventory; completedGroups: string[] }>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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

function journalPath(root: string): string {
	return join(getHistoryDir(root), MIGRATION_JOURNAL);
}

/**
 * The marker only counts when it parses to an object with an `at` timestamp —
 * a truncated or corrupt file must not short-circuit an unfinished migration.
 */
function completedMarker(root: string): boolean {
	const raw = readSingleLinkTextFileSync(join(getHistoryDir(root), MIGRATED_MARKER), { maxBytes: 64 * 1024 });
	if (raw === undefined) return false;
	try {
		const parsed = JSON.parse(raw) as { at?: unknown } | null;
		return typeof parsed === "object" && parsed !== null && typeof parsed.at === "string";
	} catch {
		return false;
	}
}

function readJournal(root: string): LegacyMigrationJournal | undefined {
	const raw = readSingleLinkTextFileSync(journalPath(root), { maxBytes: 1024 * 1024 });
	if (raw === undefined) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		throw new Error(`unreadable migration journal: ${errorMessage(error)}`);
	}
	const journal = parsed as LegacyMigrationJournal;
	if (
		typeof journal !== "object" ||
		journal === null ||
		journal.version !== 1 ||
		(journal.phase !== "archiving" && journal.phase !== "importing") ||
		!Array.isArray(journal.archives) ||
		journal.archives.some(
			(archive) =>
				typeof archive?.relativeDir !== "string" ||
				archive.relativeDir.includes("..") ||
				!Array.isArray(archive.completedGroups),
		)
	) {
		throw new Error("unreadable migration journal: invalid shape");
	}
	return journal;
}

function writeMigrationJournal(root: string, journal: LegacyMigrationJournal): void {
	replaceFileAtomicallySync(journalPath(root), JSON.stringify(journal), { mode: 0o600 });
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

/** `.history/legacy-*` archives already on disk (left by pre-journal runs). */
function orphanArchives(root: string): string[] {
	return readdirNames(getHistoryDir(root)).filter((name) => name.startsWith(LEGACY_DIR_PREFIX));
}

/** Rebuild what an existing archive holds so its facts can still be imported. */
function inventoryFromArchive(dir: string): LegacyInventory {
	return {
		sqlite: SQLITE_FILES.filter((name) => existsSync(join(dir, name))),
		globalMarkdown: topLevelMarkdownFiles(join(dir, "global")),
		projectDirs: topLevelDirs(join(dir, "projects")),
	};
}

/**
 * Read the deleted store's schema; an unopenable db or a missing/corrupt facts
 * table is an error, never "zero facts". A missing memory_projects table just
 * means no cwd mapping (orphan keys stay under their hash).
 */
function readLegacySqlite(
	path: string,
): { ok: true; facts: LegacyFact[]; projects: Map<string, string> } | { ok: false; error: string } {
	let db: DatabaseSync;
	try {
		db = new DatabaseSync(path, { readOnly: true });
	} catch (error) {
		return { ok: false, error: `cannot open legacy database ${path}: ${errorMessage(error)}` };
	}
	try {
		const projects = new Map<string, string>();
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
		let rows: Array<Record<string, unknown>>;
		try {
			rows = db
				.prepare("SELECT scope, cwd_key, topic_file, text, created_at FROM facts WHERE status = 'active'")
				.all() as Array<Record<string, unknown>>;
		} catch (error) {
			return { ok: false, error: `cannot read legacy facts from ${path}: ${errorMessage(error)}` };
		}
		const facts: LegacyFact[] = [];
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
		return { ok: true, facts, projects };
	} finally {
		try {
			db.close();
		} catch {
			// Best effort.
		}
	}
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

/** The `[from, to]` moves one archive needs; `to` lives under `.history/legacy-*`. */
function plannedMoves(root: string, relativeDir: string, inventory: LegacyInventory): Array<[string, string]> {
	const legacyDir = join(root, relativeDir);
	const moves: Array<[string, string]> = [];
	for (const name of inventory.sqlite) moves.push([join(root, name), join(legacyDir, name)]);
	for (const name of inventory.globalMarkdown) {
		moves.push([join(root, "global", name), join(legacyDir, "global", name)]);
	}
	for (const name of inventory.projectDirs) {
		moves.push([join(root, "projects", name), join(legacyDir, "projects", name)]);
	}
	return moves;
}

/** Byte/tree equality for a source/destination pair; archives are never overwritten. */
function verifySameContent(from: string, to: string): boolean {
	try {
		const a = statSync(from);
		const b = statSync(to);
		if (a.isFile() && b.isFile()) return readFileSync(from).equals(readFileSync(to));
		if (a.isDirectory() && b.isDirectory()) {
			const namesA = readdirSync(from).sort();
			const namesB = readdirSync(to).sort();
			if (namesA.length !== namesB.length) return false;
			return namesA.every(
				(name, index) => name === namesB[index] && verifySameContent(join(from, name), join(to, name)),
			);
		}
	} catch {
		return false;
	}
	return false;
}

/**
 * Perform one archive's moves idempotently: a file already at its destination
 * counts as moved, a file still at its source is renamed, both-present must
 * verify identical, and neither-present means data was lost — an error that
 * keeps the journal so the next run reports it again.
 */
function runArchivingPhase(root: string, archive: LegacyMigrationJournal["archives"][number]): void {
	for (const [from, to] of plannedMoves(root, archive.relativeDir, archive.inventory)) {
		if (existsSync(to)) {
			if (existsSync(from) && !verifySameContent(from, to)) {
				throw new Error(`legacy artifact exists in both locations with different content: ${from}`);
			}
			continue;
		}
		if (!existsSync(from)) throw new Error(`legacy artifact missing: ${from}`);
		ensureDirectoryDurablySync(dirname(to));
		renameSync(from, to);
	}
}

function runMigration(
	agentDir: string,
	root: string,
	journal: LegacyMigrationJournal,
	events: MemoryEvents,
): LegacyMigrationSummary {
	// Phase 1: move every archive's artifacts, then flip the journal.
	if (journal.phase === "archiving") {
		for (const archive of journal.archives) runArchivingPhase(root, archive);
		journal.phase = "importing";
		writeMigrationJournal(root, journal);
	}

	// Phase 2: import each group idempotently. `migrationGroup` in the changelog
	// covers the note-written-but-journal-lost window; completedGroups covers the
	// rest. Either way the group is only marked done after its writes landed.
	const logged = new Set(
		readChangelog(root)
			.map((entry) => entry.migrationGroup)
			.filter((key): key is string => key !== undefined),
	);
	const touched = new Map<
		string,
		{ scope: MemoryScope; key?: string; root?: string | null; source?: "git" | "cwd" }
	>();
	let factsTotal = 0;
	let notes = 0;
	const at = new Date().toISOString();
	const today = at.slice(0, 10);
	for (const archive of journal.archives) {
		const archiveDir = join(root, archive.relativeDir);
		let facts: LegacyFact[] = [];
		let projects = new Map<string, string>();
		if (archive.inventory.sqlite.includes("memory.sqlite")) {
			const read = readLegacySqlite(join(archiveDir, "memory.sqlite"));
			if (!read.ok) throw new Error(read.error);
			facts = read.facts;
			projects = read.projects;
		}
		factsTotal += facts.length;
		for (const [groupId, group] of groupFacts(facts, projects)) {
			const touchKey = `${group.scope}:${group.project?.key ?? ""}`;
			if (!touched.has(touchKey)) {
				touched.set(touchKey, {
					scope: group.scope,
					...(group.project
						? { key: group.project.key, root: group.project.root, source: group.project.source }
						: {}),
				});
			}
			if (archive.completedGroups.includes(groupId)) continue;
			const migrationGroup = `${archive.relativeDir}:${groupId}`;
			if (!logged.has(migrationGroup)) {
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
				let changed = false;
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
					changed = true;
				} else {
					changed = mergeFactsIntoExisting(path, raw, group.texts);
				}
				if (changed) notes++;
				// A previous attempt may have saved the note but failed before
				// recording it. Content deduplication must not skip the missing log.
				const entry: ChangelogEntry = {
					id: randomUUID(),
					ts: new Date().toISOString(),
					actor: MIGRATE_ACTOR,
					op: "migrate",
					scope: group.scope,
					target: { slug: group.slug },
					...(group.project ? { projectKey: group.project.key } : {}),
					migrationGroup,
				};
				appendChangelog(root, entry);
				events.emit("changed", { entry });
				logged.add(migrationGroup);
			}
			archive.completedGroups.push(groupId);
			writeMigrationJournal(root, journal);
		}
	}

	// Rebuild indexes through the vault so ordering and limits match exactly —
	// including scopes whose groups all replayed as already-logged.
	for (const scope of touched.values()) {
		const project =
			scope.key === undefined
				? undefined
				: { root: scope.root ?? "", projectKey: scope.key, source: scope.source ?? "cwd" };
		new MemoryVault({ agentDir, ...(project ? { project } : {}), events }).rebuildIndex(scope.scope);
	}

	replaceFileAtomicallySync(
		join(getHistoryDir(root), MIGRATED_MARKER),
		JSON.stringify({
			version: 2,
			at,
			notes,
			facts: factsTotal,
			archives: journal.archives.map((archive) => archive.relativeDir),
			legacyDir: journal.archives[0]?.relativeDir,
		}),
		{ mode: 0o600 },
	);
	rmSync(journalPath(root), { force: true });
	return { migrated: true, facts: factsTotal, notes, legacyDir: journal.archives[0]?.relativeDir };
}

/** Build a fresh journal covering pending artifacts plus archives from pre-journal runs. */
function buildJournal(root: string): LegacyMigrationJournal | undefined {
	const inventory = scanLegacy(root);
	const orphans = orphanArchives(root).sort();
	if (isEmpty(inventory) && orphans.length === 0) return undefined;
	const archives: LegacyMigrationJournal["archives"] = [];
	if (!isEmpty(inventory)) {
		const at = new Date().toISOString().replace(/[:.]/g, "-");
		archives.push({
			relativeDir: `.history/${LEGACY_DIR_PREFIX}${at}`,
			inventory,
			completedGroups: [],
		});
	}
	for (const name of orphans) {
		archives.push({
			relativeDir: `.history/${name}`,
			inventory: inventoryFromArchive(join(getHistoryDir(root), name)),
			completedGroups: [],
		});
	}
	return { version: 1, phase: "archiving", archives };
}

/**
 * Migrate the legacy layout under `<agentDir>/memory` once. Synchronous and
 * idempotent: returns `{migrated: false}` with zero side effects when no legacy
 * artifacts exist or a previous run already completed. A `journal` left by an
 * interrupted run resumes where it stopped; a failed run reports `error` and
 * stays resumable instead of marking the migration done.
 */
export function migrateLegacyMemory(agentDir: string, events?: MemoryEvents): LegacyMigrationSummary {
	const root = getVaultRoot(agentDir);
	if (completedMarker(root)) {
		// A journal left after the marker is stale; dropping it is idempotent.
		rmSync(journalPath(root), { force: true });
		return { migrated: false, facts: 0, notes: 0 };
	}
	// Fast path outside the lock: only lock when a journal, leftover artifacts,
	// or pre-journal archives make a migration run plausible.
	if (!existsSync(journalPath(root)) && isEmpty(scanLegacy(root)) && orphanArchives(root).length === 0) {
		return { migrated: false, facts: 0, notes: 0 };
	}

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
		if (completedMarker(root)) {
			// Crash between marker write and journal cleanup: just drop the journal.
			rmSync(journalPath(root), { force: true });
			return { migrated: false, facts: 0, notes: 0 };
		}
		const journal = readJournal(root) ?? buildJournal(root);
		if (journal === undefined) return { migrated: false, facts: 0, notes: 0 };
		// Persist before any file moves so an interruption is resumable.
		writeMigrationJournal(root, journal);
		try {
			return runMigration(agentDir, root, journal, events ?? new MemoryEvents());
		} catch (error) {
			return {
				migrated: false,
				facts: 0,
				notes: 0,
				...(journal.archives[0] ? { legacyDir: journal.archives[0].relativeDir } : {}),
				error: errorMessage(error),
			};
		}
	} catch (error) {
		return {
			migrated: false,
			facts: 0,
			notes: 0,
			error: errorMessage(error),
		};
	} finally {
		try {
			release();
		} catch {
			// A compromised lock after the fact must not break startup.
		}
	}
}
