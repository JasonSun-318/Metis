import { randomUUID } from "node:crypto";
import { appendFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ensureDirectoryDurablySync, readSingleLinkTextFileSync, writeFileDurablySync } from "../durable-file.ts";
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
): string | undefined {
	if (currentContent === undefined) return undefined;
	const dir = getSnapshotDir(root, scope, target);
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

/**
 * Enforce retention: keep at most `snapshotsPerTarget` snapshots per target and
 * drop anything older than `snapshotMaxAgeDays`.
 */
export function pruneSnapshots(root: string, limits: SnapshotRetention): void {
	const historyDir = getHistoryDir(root);
	const now = Date.now();
	const maxAgeMs = limits.snapshotMaxAgeDays * 24 * 60 * 60 * 1000;
	for (const scope of ["global", "project"] as const) {
		const scopeDir = join(historyDir, scope);
		let targets: string[];
		try {
			targets = readdirSync(scopeDir);
		} catch {
			continue;
		}
		for (const target of targets) {
			const targetDir = join(scopeDir, target);
			let files: string[];
			try {
				if (!statSync(targetDir).isDirectory()) continue;
				files = readdirSync(targetDir)
					.filter((name) => name.endsWith(".md"))
					.sort()
					.reverse();
			} catch {
				continue;
			}
			let kept = 0;
			for (const name of files) {
				const path = join(targetDir, name);
				let ageMs = 0;
				try {
					ageMs = now - statSync(path).mtimeMs;
				} catch {
					continue;
				}
				if (kept < limits.snapshotsPerTarget && ageMs <= maxAgeMs) {
					kept++;
					continue;
				}
				try {
					rmSync(path, { force: true });
				} catch {
					// Best effort; a lingering snapshot is harmless.
				}
			}
			try {
				if (readdirSync(targetDir).length === 0) rmSync(targetDir, { recursive: true, force: true });
			} catch {
				// Best effort.
			}
		}
	}
}
