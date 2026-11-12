import { closeSync, existsSync, fsyncSync, openSync, readdirSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";

/** Journal directories that may still contain the retired session mode field. */
const JOURNAL_ROOTS = ["sessions", "agents"] as const;
const SKIPPED_DIRECTORIES = new Set(["subagents"]);
const MAX_HEADER_BYTES = 64 * 1024;

export interface SessionModeMigrationResult {
	readonly scanned: number;
	readonly migrated: number;
	readonly failed: readonly string[];
}

function collectJournals(directory: string, files: string[]): void {
	if (!existsSync(directory)) return;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
			collectJournals(path, files);
			continue;
		}
		if (entry.name.endsWith(".jsonl")) files.push(path);
	}
}

function withoutMode(header: Record<string, unknown>): Record<string, unknown> {
	const { mode: _mode, ...rest } = header;
	return rest;
}

function writeFileAtomically(path: string, bytes: Buffer): void {
	const temporary = `${path}.mode-migrating-${process.pid}`;
	const descriptor = openSync(temporary, "w", 0o600);
	try {
		writeSync(descriptor, bytes);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	renameSync(temporary, path);
}

/**
 * Strip the retired `mode` header field from every session and agent journal.
 *
 * The unified session model no longer accepts that field, so a journal written by
 * an older Metis release must be rewritten before the catalog reads it. Only the
 * header line changes; the rest of the file is preserved byte for byte. Running
 * this repeatedly is safe, and each journal is replaced atomically.
 */
export function migrateLegacySessionModes(agentDir: string): SessionModeMigrationResult {
	const files: string[] = [];
	for (const root of JOURNAL_ROOTS) collectJournals(join(agentDir, root), files);
	let scanned = 0;
	let migrated = 0;
	const failed: string[] = [];
	for (const path of files.sort()) {
		scanned += 1;
		try {
			const bytes = readFileSync(path);
			const newline = bytes.indexOf(0x0a);
			const headerEnd = newline === -1 ? bytes.length : newline;
			if (headerEnd > MAX_HEADER_BYTES) {
				failed.push(path);
				continue;
			}
			const header = JSON.parse(bytes.subarray(0, headerEnd).toString("utf8")) as unknown;
			if (!header || typeof header !== "object" || Array.isArray(header)) {
				failed.push(path);
				continue;
			}
			const record = header as Record<string, unknown>;
			if (!Object.hasOwn(record, "mode")) continue;
			const rest = bytes.subarray(newline === -1 ? bytes.length : newline + 1);
			const rewritten = Buffer.concat([Buffer.from(`${JSON.stringify(withoutMode(record))}\n`, "utf8"), rest]);
			writeFileAtomically(path, rewritten);
			migrated += 1;
		} catch {
			failed.push(path);
		}
	}
	return { scanned, migrated, failed };
}
