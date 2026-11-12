#!/usr/bin/env node
/**
 * Remove the retired chat/code session `mode` field from session journals.
 *
 * Sessions no longer have a chat/code classification, so the header field is
 * obsolete. This utility rewrites the header line only and leaves every other
 * byte untouched. It is a dry run by default, keeps a backup copy of every
 * changed journal, and is safe to run repeatedly.
 *
 * Run it while the app is closed, after upgrading to the unified build:
 *   node scripts/migrate-session-modes.mjs                    # dry run
 *   node scripts/migrate-session-modes.mjs --apply            # migrate + backup
 *   node scripts/migrate-session-modes.mjs --clean-leases     # drop stale mode locks
 *
 * Session journals live under `<agent-dir>/sessions/`; archived journals use
 * `<agent-dir>/sessions/.archive/`. Agent-conversation journals under
 * `<agent-dir>/agents/` are migrated too; quarantined and backup journals are
 * outside these roots and are left untouched.
 */
import { createHash } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const SKIPPED_DIRECTORIES = new Set(["subagents", "agents"]);
const LEGACY_MODE_LEASE_PATTERN = /^\.mode-(?:chat|code)-project\.mutation$/;

function defaultAgentDir() {
	return join(homedir(), ".metis", "agent");
}

function walkFiles(directory, visit) {
	if (!existsSync(directory)) return;
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) {
			if (SKIPPED_DIRECTORIES.has(entry.name)) continue;
			walkFiles(path, visit);
			continue;
		}
		visit(path, entry.name);
	}
}

function walkDirectories(directory, visit) {
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const path = join(directory, entry.name);
		visit(path, entry.name);
		if (SKIPPED_DIRECTORIES.has(entry.name) || entry.name === ".archive") continue;
		walkDirectories(path, visit);
	}
}

/** Session and agent-conversation journals that may still carry the retired mode field. */
export function findSessionJournals(agentDir) {
	const files = [];
	for (const root of ["sessions", "agents"]) {
		walkFiles(join(agentDir, root), (path, name) => {
			if (name.endsWith(".jsonl")) files.push(path);
		});
	}
	return files.sort();
}

function readJournal(path) {
	const bytes = readFileSync(path);
	const newline = bytes.indexOf(0x0a);
	const headerEnd = newline === -1 ? bytes.length : newline;
	const header = JSON.parse(bytes.subarray(0, headerEnd).toString("utf8"));
	if (!header || typeof header !== "object" || Array.isArray(header)) {
		throw new Error("Journal header is not an object");
	}
	const rest = bytes.subarray(newline === -1 ? bytes.length : newline + 1);
	return { header, rest };
}

function withoutMode(header) {
	const { mode: _mode, ...rest } = header;
	return rest;
}

function hashBytes(bytes) {
	return createHash("sha256").update(bytes).digest("hex");
}

function relativeToAgentDir(agentDir, path) {
	return relative(agentDir, path).split("\\").join("/");
}

function writeFileAtomically(path, bytes) {
	const temporary = `${path}.migrating-${process.pid}`;
	const descriptor = openSync(temporary, "w", 0o600);
	try {
		writeSync(descriptor, bytes);
		fsyncSync(descriptor);
	} finally {
		closeSync(descriptor);
	}
	renameSync(temporary, path);
}

/** Journals whose header still carries a chat/code mode. */
export function planSessionModeMigration({ agentDir = defaultAgentDir() } = {}) {
	const entries = [];
	const errors = [];
	for (const path of findSessionJournals(agentDir)) {
		try {
			const { header, rest } = readJournal(path);
			if (!Object.hasOwn(header, "mode")) continue;
			entries.push({
				path,
				relativePath: relativeToAgentDir(agentDir, path),
				mode: header.mode,
				header,
				rest,
			});
		} catch (error) {
			errors.push({ path, relativePath: relativeToAgentDir(agentDir, path), error: String(error) });
		}
	}
	return { entries, errors };
}

/** Session and project-mutation leases that mean an app is still running. */
export function findActiveLocks({ agentDir = defaultAgentDir() } = {}) {
	const locks = [];
	walkFiles(join(agentDir, "sessions"), (path, name) => {
		if (name !== "owner.json") return;
		const directory = dirname(path);
		if (directory.endsWith(".lease") || LEGACY_MODE_LEASE_PATTERN.test(directory.split("/").at(-1) ?? "")) {
			locks.push(path);
		}
	});
	return locks;
}

/** Stale `.mode-{chat|code}-project.mutation` directories without an owner. */
export function findLegacyMutationLeases({ agentDir = defaultAgentDir() } = {}) {
	const sessionsRoot = join(agentDir, "sessions");
	const leases = [];
	if (!existsSync(sessionsRoot)) return leases;
	walkDirectories(sessionsRoot, (path, name) => {
		if (LEGACY_MODE_LEASE_PATTERN.test(name)) {
			leases.push({ path, owned: existsSync(join(path, "owner.json")) });
		}
	});
	return leases;
}

export function cleanLegacyMutationLeases({ agentDir = defaultAgentDir(), force = false } = {}) {
	const removed = [];
	const kept = [];
	for (const lease of findLegacyMutationLeases({ agentDir })) {
		if (lease.owned && !force) {
			kept.push(lease.path);
			continue;
		}
		rmSync(lease.path, { recursive: true, force: true });
		removed.push(lease.path);
	}
	return { removed, kept };
}

/**
 * Rewrite each planned journal's header, backing up the original first.
 * Returns counts plus the backup directory when anything changed.
 */
export function applySessionModeMigration({ agentDir = defaultAgentDir(), backupDir } = {}) {
	const { entries, errors } = planSessionModeMigration({ agentDir });
	if (errors.length > 0) return { migrated: [], errors, backupDir: undefined };
	if (entries.length === 0) return { migrated: [], errors, backupDir: undefined };
	const resolvedBackup = resolve(
		backupDir ?? join(agentDir, `sessions-mode-backup-${new Date().toISOString().replace(/[:.]/g, "-")}`),
	);
	const migrated = [];
	for (const entry of entries) {
		const original = readFileSync(entry.path);
		const nextHeader = withoutMode(entry.header);
		const headerBytes = Buffer.from(`${JSON.stringify(nextHeader)}\n`, "utf8");
		const next = Buffer.concat([headerBytes, entry.rest]);
		const backupPath = join(resolvedBackup, entry.relativePath);
		mkdirSync(dirname(backupPath), { recursive: true });
		writeFileAtomically(backupPath, original);
		writeFileAtomically(entry.path, next);
		const written = readFileSync(entry.path);
		const writtenHeader = JSON.parse(written.subarray(0, written.indexOf(0x0a)).toString("utf8"));
		if (Object.hasOwn(writtenHeader, "mode")) throw new Error(`Journal still has a mode field: ${entry.path}`);
		const writtenRest = written.subarray(written.indexOf(0x0a) + 1);
		if (hashBytes(writtenRest) !== hashBytes(entry.rest)) {
			throw new Error(`Journal body changed while migrating: ${entry.path}`);
		}
		migrated.push({
			path: entry.path,
			relativePath: entry.relativePath,
			mode: entry.mode,
			backupPath,
			byteLength: original.length,
		});
	}
	return { migrated, errors, backupDir: resolvedBackup };
}

function parseArgs(argv) {
	const options = {
		agentDir: defaultAgentDir(),
		apply: false,
		cleanLeases: false,
		force: false,
		json: false,
		backupDir: undefined,
	};
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--agent-dir") options.agentDir = resolve(argv[++index] ?? "");
		else if (argument === "--apply") options.apply = true;
		else if (argument === "--backup") options.backupDir = resolve(argv[++index] ?? "");
		else if (argument === "--clean-leases") options.cleanLeases = true;
		else if (argument === "--force") options.force = true;
		else if (argument === "--json") options.json = true;
		else if (argument === "--help" || argument === "-h") {
			console.log(`Usage: node scripts/migrate-session-modes.mjs [options]

  --agent-dir <dir>   Metis agent directory (default: ~/.metis/agent)
  --apply             Rewrite journals (dry run by default)
  --backup <dir>      Backup directory for changed journals
  --clean-leases      Remove stale .mode-*-project.mutation directories
  --force             Migrate even when session leases are present
  --json              Print the result as JSON`);
			process.exit(0);
		} else {
			console.error(`Unknown argument: ${argument}`);
			process.exit(2);
		}
	}
	if (!existsSync(join(options.agentDir, "sessions"))) {
		console.error(`No sessions directory found under ${options.agentDir}`);
		process.exit(2);
	}
	return options;
}

function run() {
	const options = parseArgs(process.argv.slice(2));
	const locks = findActiveLocks({ agentDir: options.agentDir });
	const blocked = options.apply && locks.length > 0 && !options.force;
	const { entries, errors } = planSessionModeMigration({ agentDir: options.agentDir });
	const report = {
		agentDir: options.agentDir,
		mode: options.apply ? "apply" : "dry-run",
		locks,
		changed: entries.length,
		journals: entries.map((entry) => ({ relativePath: entry.relativePath, mode: entry.mode })),
		errors,
	};
	if (blocked) report.error = "Session leases are present; close Metis before migrating (or pass --force).";

	if (!blocked && options.apply) {
		const result = applySessionModeMigration({ agentDir: options.agentDir, backupDir: options.backupDir });
		report.migrated = result.migrated.map(({ relativePath, mode, backupPath }) => ({
			relativePath,
			mode,
			backupPath,
		}));
		report.backupDir = result.backupDir;
		if (result.errors.length > 0) report.errors = result.errors;
	}
	if (options.cleanLeases)
		report.leases = cleanLegacyMutationLeases({ agentDir: options.agentDir, force: options.force });
	report.ok = !report.error && report.errors.length === 0;

	if (options.json) {
		console.log(JSON.stringify(report, null, 2));
	} else {
		console.log(`Metis session mode migration (${report.mode})`);
		console.log(`Agent directory: ${report.agentDir}`);
		console.log(`Journals with a retired mode: ${report.changed}`);
		if (report.journals !== undefined) {
			for (const journal of report.journals) console.log(`  ${journal.relativePath} (was ${journal.mode})`);
		}
		for (const error of report.errors) console.error(`  ! ${error.relativePath}: ${error.error}`);
		if (report.locks.length > 0) console.log(`Active leases found: ${report.locks.length}`);
		if (report.backupDir) console.log(`Backup: ${report.backupDir}`);
		if (report.leases) {
			console.log(
				`Removed stale mode leases: ${report.leases.removed.length}; kept owned: ${report.leases.kept.length}`,
			);
		}
		if (report.error) console.error(`Error: ${report.error}`);
		else if (!options.apply) console.log("Dry run only; pass --apply to rewrite the journals.");
		else console.log(`Migrated ${report.migrated?.length ?? 0} journal(s).`);
	}
	process.exit(report.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) run();
