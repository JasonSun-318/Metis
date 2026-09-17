import { randomUUID } from "node:crypto";
import { appendFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { ensureDirectoryDurablySync, readSingleLinkTextFileSync, writeFileDurablySync } from "../durable-file.ts";
import { memoryTargetId } from "./vault-identity.ts";
import { getChangelogPath, getHistoryDir, getSnapshotDir } from "./vault-paths.ts";
import type { MemoryActor, MemoryScope, MemoryTarget } from "./vault-types.ts";

export type ChangelogOp = "create" | "append" | "replace" | "str_replace" | "rename" | "delete" | "undo" | "migrate";

export interface ChangelogEntry {
	id: string;
	ts: string;
	actor: MemoryActor;
	op: ChangelogOp;
	scope: MemoryScope;
	target: MemoryTarget;
	/** Owning project for "project"-scope entries; guards cross-project undo. */
	projectKey?: string;
	newSlug?: string;
	/** Snapshot path relative to the vault root. */
	snapshot?: string;
	/** Whether the target file existed before this change; recorded on new entries. */
	beforeExists?: boolean;
	/** Shared id linking every entry produced by one rename operation. */
	operationId?: string;
	undoes?: string;
	undoneBy?: string;
}

/** Append one changelog line. Callers hold the vault lock. */
export function appendChangelog(root: string, entry: ChangelogEntry): void {
	ensureDirectoryDurablySync(getHistoryDir(root));
	appendFileSync(getChangelogPath(root), `${JSON.stringify(entry)}\n`, { mode: 0o600 });
}

function parseChangelog(raw: string | undefined): ChangelogEntry[] {
	if (!raw) return [];
	const entries: ChangelogEntry[] = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		try {
			const entry = JSON.parse(line) as ChangelogEntry;
			if (entry && typeof entry.id === "string" && typeof entry.op === "string") entries.push(entry);
		} catch {
			// Skip corrupt lines; the log is append-mostly and self-heals on the next write.
		}
	}
	return entries;
}

function readChangelogFile(root: string): ChangelogEntry[] {
	return parseChangelog(readSingleLinkTextFileSync(getChangelogPath(root), { maxBytes: 8 * 1024 * 1024 }));
}

/** Newest first. */
export function readChangelog(root: string, limit?: number): ChangelogEntry[] {
	const entries = readChangelogFile(root).reverse();
	return limit === undefined ? entries : entries.slice(0, limit);
}

/**
 * Serialize the changelog state after an undo: mark every entry in `undoneIds`
 * and append the undo entry. `raw` is the current log content read under the
 * vault lock; the result replaces the file in one atomic write.
 */
export function serializeUndoCommit(
	raw: string | undefined,
	undoEntry: ChangelogEntry,
	undoneIds: readonly string[],
): string {
	const entries = parseChangelog(raw);
	for (const entry of entries) {
		if (undoneIds.includes(entry.id)) entry.undoneBy = undoEntry.id;
	}
	entries.push(undoEntry);
	return `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

/**
 * Persist the pre-change content of a target under `.history/<scope>/<targetKey>/`.
 * Returns the root-relative snapshot path, or undefined when there is nothing to snapshot.
 */
export function saveSnapshot(
	root: string,
	scope: MemoryScope,
	target: MemoryTarget,
	currentContent: string | undefined,
	projectKey?: string,
): string | undefined {
	if (currentContent === undefined) return undefined;
	const dir = getSnapshotDir(root, scope, target, projectKey);
	ensureDirectoryDurablySync(dir);
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const path = join(dir, `${stamp}-${randomUUID().slice(0, 8)}.md`);
	writeFileDurablySync(path, currentContent, { flag: "wx", mode: 0o600 });
	return relative(root, path).split(sep).join("/");
}

/** Read a snapshot back; `snapshot` is the root-relative path stored in the changelog. */
export function readSnapshot(root: string, snapshot: string): string | undefined {
	if (snapshot.includes("..") || snapshot.startsWith("/") || /^[A-Za-z]:/u.test(snapshot)) return undefined;
	return readSingleLinkTextFileSync(join(root, snapshot));
}

export interface SnapshotRetention {
	snapshotsPerTarget: number;
	snapshotMaxAgeDays: number;
}

/** Referenced snapshots grouped by their logical target (project-aware). */
function snapshotGroups(root: string): Map<string, Set<string>> {
	const groups = new Map<string, Set<string>>();
	for (const entry of readChangelogFile(root)) {
		if (!entry.snapshot) continue;
		const owner =
			entry.scope === "project" && !entry.projectKey
				? `legacy-unknown/${entry.id}`
				: memoryTargetId(entry.scope, entry.target, entry.projectKey);
		let group = groups.get(owner);
		if (!group) {
			group = new Set();
			groups.set(owner, group);
		}
		group.add(entry.snapshot);
	}
	return groups;
}

/** Enumerate snapshot files under one snapshot directory; returns root-relative paths. */
function listSnapshotFiles(root: string, scopeDir: string): string[] {
	const found: string[] = [];
	let targets: string[];
	try {
		targets = readdirSync(scopeDir);
	} catch {
		return found;
	}
	for (const target of targets) {
		const targetDir = join(scopeDir, target);
		try {
			if (!statSync(targetDir).isDirectory()) continue;
			for (const name of readdirSync(targetDir)) {
				if (name.endsWith(".md") && statSync(join(targetDir, name)).isFile()) {
					found.push(relative(root, join(targetDir, name)).split(sep).join("/"));
				}
			}
		} catch {}
	}
	return found;
}

/** All snapshot file paths (root-relative) in both the v2 and legacy layouts. */
function enumerateSnapshotFiles(root: string): string[] {
	const historyDir = getHistoryDir(root);
	const files = [
		...listSnapshotFiles(root, join(historyDir, "v2", "global")),
		...listSnapshotFiles(root, join(historyDir, "global")),
		...listSnapshotFiles(root, join(historyDir, "project")),
	];
	const projectsDir = join(historyDir, "v2", "projects");
	let projectKeys: string[];
	try {
		projectKeys = readdirSync(projectsDir);
	} catch {
		projectKeys = [];
	}
	for (const key of projectKeys) {
		files.push(...listSnapshotFiles(root, join(projectsDir, key)));
	}
	return files;
}

/**
 * Enforce retention: keep at most `snapshotsPerTarget` snapshots per logical
 * target (project-aware, resolved through changelog entries) and drop anything
 * older than `snapshotMaxAgeDays`. Snapshot files no entry references are only
 * age-pruned. Callers hold the vault root lock.
 */
export function pruneSnapshots(root: string, limits: SnapshotRetention): void {
	const now = Date.now();
	const maxAgeMs = limits.snapshotMaxAgeDays * 24 * 60 * 60 * 1000;
	const groups = snapshotGroups(root);
	const referenced = new Set<string>();
	for (const paths of groups.values()) for (const path of paths) referenced.add(path);
	const keep = new Set<string>();
	for (const paths of groups.values()) {
		const sorted = [...paths]
			.map((path) => {
				try {
					return { path, mtimeMs: statSync(join(root, path)).mtimeMs };
				} catch {
					return undefined;
				}
			})
			.filter((item): item is { path: string; mtimeMs: number } => item !== undefined)
			.sort((left, right) => right.mtimeMs - left.mtimeMs || right.path.localeCompare(left.path));
		let kept = 0;
		for (const item of sorted) {
			if (kept >= limits.snapshotsPerTarget || now - item.mtimeMs > maxAgeMs) continue;
			keep.add(item.path);
			kept++;
		}
	}
	const targetDirs = new Set<string>();
	for (const path of enumerateSnapshotFiles(root)) {
		targetDirs.add(dirname(join(root, path)));
		if (keep.has(path)) continue;
		let ageMs = 0;
		try {
			ageMs = now - statSync(join(root, path)).mtimeMs;
		} catch {
			continue;
		}
		// Referenced files are kept per their group budget; unreferenced files
		// are only removed once they age out.
		if (referenced.has(path) || ageMs > maxAgeMs) {
			try {
				rmSync(join(root, path), { force: true });
			} catch {
				// Best effort; a lingering snapshot is harmless.
			}
		}
	}
	for (const dir of targetDirs) {
		try {
			if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true });
		} catch {
			// Best effort.
		}
	}
}
