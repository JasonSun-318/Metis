/**
 * One-time migrations that run on startup.
 */

import chalk from "chalk";
import { createHash, randomUUID } from "crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "fs";
import { basename, dirname, join } from "path";
import { getAgentDir, getBinDir, getProjectConfigDir } from "./config.ts";
import {
	cleanupPublishedAliasesSync,
	createFileAtomicallySync,
	readSingleLinkFileFingerprintSync,
	readSingleLinkTextFileSync,
	replaceFileAtomicallySync,
	type SingleLinkFileFingerprint,
	syncDirectorySync,
} from "./core/durable-file.ts";
import { migrateKeybindingsConfig } from "./core/keybindings.ts";
import { SessionLeaseError } from "./core/session-lease.ts";
import { SessionManager } from "./core/session-manager.ts";
import { sanitizeTerminalText } from "./utils/ansi.ts";
import { encodePathForStorage } from "./utils/paths.ts";

const MIGRATION_GUIDE_URL =
	"https://gitee.com/sun124578963_0/metis/blob/main/packages/coding-agent/docs/extensions.md#extension-locations";
const EXTENSIONS_DOC_URL = "https://gitee.com/sun124578963_0/metis/blob/main/packages/coding-agent/docs/extensions.md";
const RETIRED_SESSION_NAME =
	/^\.(.+\.jsonl)\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.migrated$/i;
const RETIRED_SESSION_CHECKPOINT_VERSION = 1;
const RETIRED_SESSION_CHECKPOINT_MAX_BYTES = 4096;

interface RetiredSessionCheckpoint {
	version: typeof RETIRED_SESSION_CHECKPOINT_VERSION;
	retiredName: string;
	targetDirectory: string;
	retired: SingleLinkFileFingerprint;
	target: SingleLinkFileFingerprint;
}

function checkpointPath(agentDir: string, retiredName: string): string {
	const digest = createHash("sha256").update(retiredName).digest("hex");
	return join(agentDir, `.session-migration-reconcile.${digest}.checkpoint.json`);
}

function sameFingerprint(left: SingleLinkFileFingerprint, right: SingleLinkFileFingerprint): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs
	);
}

function parseFingerprint(value: unknown): SingleLinkFileFingerprint | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	const keys = Object.keys(record).sort();
	if (keys.join("\0") !== "ctimeNs\0dev\0ino\0mtimeNs\0size") return undefined;
	for (const key of keys) {
		if (typeof record[key] !== "string" || !/^(0|[1-9][0-9]*)$/.test(record[key])) return undefined;
	}
	return record as unknown as SingleLinkFileFingerprint;
}

function parseCheckpoint(bytes: string, retiredName: string): RetiredSessionCheckpoint | undefined {
	try {
		const value = JSON.parse(bytes) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const record = value as Record<string, unknown>;
		const keys = Object.keys(record).sort();
		if (keys.join("\0") !== "retired\0retiredName\0target\0targetDirectory\0version") return undefined;
		if (record.version !== RETIRED_SESSION_CHECKPOINT_VERSION || record.retiredName !== retiredName) return undefined;
		if (typeof record.targetDirectory !== "string") return undefined;
		if (
			!record.targetDirectory.startsWith("--") ||
			!record.targetDirectory.endsWith("--") ||
			/[\\/\0]/.test(record.targetDirectory) ||
			Buffer.byteLength(record.targetDirectory, "utf8") > 255
		) {
			return undefined;
		}
		const retired = parseFingerprint(record.retired);
		const target = parseFingerprint(record.target);
		if (!retired || !target) return undefined;
		return {
			version: RETIRED_SESSION_CHECKPOINT_VERSION,
			retiredName,
			targetDirectory: record.targetDirectory,
			retired,
			target,
		};
	} catch {
		return undefined;
	}
}

function canSkipRetiredSessionReconciliation(agentDir: string, retiredName: string): boolean {
	try {
		const bytes = readSingleLinkTextFileSync(checkpointPath(agentDir, retiredName), {
			maxBytes: RETIRED_SESSION_CHECKPOINT_MAX_BYTES,
		});
		if (bytes === undefined) return false;
		const checkpoint = parseCheckpoint(bytes, retiredName);
		const match = RETIRED_SESSION_NAME.exec(retiredName);
		if (!checkpoint || !match) return false;
		const retiredPath = join(agentDir, retiredName);
		const targetPath = join(agentDir, "sessions", checkpoint.targetDirectory, basename(match[1]!));
		const retiredBefore = readSingleLinkFileFingerprintSync(retiredPath);
		const targetBefore = readSingleLinkFileFingerprintSync(targetPath);
		const retiredAfter = readSingleLinkFileFingerprintSync(retiredPath);
		const targetAfter = readSingleLinkFileFingerprintSync(targetPath);
		if (!retiredBefore || !targetBefore || !retiredAfter || !targetAfter) return false;
		return (
			sameFingerprint(retiredBefore, retiredAfter) &&
			sameFingerprint(targetBefore, targetAfter) &&
			sameFingerprint(retiredAfter, checkpoint.retired) &&
			sameFingerprint(targetAfter, checkpoint.target)
		);
	} catch {
		return false;
	}
}

function publishRetiredSessionCheckpoint(
	agentDir: string,
	retiredName: string,
	targetDirectory: string,
	targetPath: string,
): void {
	try {
		const retiredPath = join(agentDir, retiredName);
		const retiredBefore = readSingleLinkFileFingerprintSync(retiredPath);
		const targetBefore = readSingleLinkFileFingerprintSync(targetPath);
		const retiredAfter = readSingleLinkFileFingerprintSync(retiredPath);
		const targetAfter = readSingleLinkFileFingerprintSync(targetPath);
		if (!retiredBefore || !targetBefore || !retiredAfter || !targetAfter) return;
		if (!sameFingerprint(retiredBefore, retiredAfter) || !sameFingerprint(targetBefore, targetAfter)) return;
		const checkpoint: RetiredSessionCheckpoint = {
			version: RETIRED_SESSION_CHECKPOINT_VERSION,
			retiredName,
			targetDirectory,
			retired: retiredAfter,
			target: targetAfter,
		};
		replaceFileAtomicallySync(checkpointPath(agentDir, retiredName), `${JSON.stringify(checkpoint)}\n`, {
			mode: 0o600,
		});
	} catch {
		// The retained journal is authoritative; a checkpoint is only a startup optimization.
	}
}

/**
 * Migrate legacy oauth.json and settings.json apiKeys to auth.json.
 *
 * @returns Array of provider names that were migrated
 */
export function migrateAuthToAuthJson(): string[] {
	const agentDir = getAgentDir();
	const authPath = join(agentDir, "auth.json");
	const oauthPath = join(agentDir, "oauth.json");
	const settingsPath = join(agentDir, "settings.json");

	// A crash after hard-link publication can leave the helper's temporary alias.
	cleanupPublishedAliasesSync(authPath);
	// Skip if auth.json already exists
	if (existsSync(authPath)) return [];

	const migrated: Record<string, unknown> = {};
	const providers: string[] = [];
	let retireOauth = false;
	let nextSettings: string | undefined;

	// Migrate oauth.json
	try {
		const oauthContent = readSingleLinkTextFileSync(oauthPath);
		if (oauthContent !== undefined) {
			const oauth = JSON.parse(oauthContent);
			for (const [provider, cred] of Object.entries(oauth)) {
				migrated[provider] = { type: "oauth", ...(cred as object) };
				providers.push(provider);
			}
			retireOauth = true;
		}
	} catch {
		// Skip unsafe or malformed legacy credentials.
	}

	// Migrate settings.json apiKeys
	try {
		const content = readSingleLinkTextFileSync(settingsPath);
		if (content !== undefined) {
			const settings = JSON.parse(content);
			if (settings.apiKeys && typeof settings.apiKeys === "object") {
				for (const [provider, key] of Object.entries(settings.apiKeys)) {
					if (!migrated[provider] && typeof key === "string") {
						migrated[provider] = { type: "api_key", key };
						providers.push(provider);
					}
				}
				delete settings.apiKeys;
				nextSettings = JSON.stringify(settings, null, 2);
			}
		}
	} catch {
		// Skip unsafe or malformed legacy settings.
	}

	if (Object.keys(migrated).length === 0) return [];

	try {
		createFileAtomicallySync(authPath, JSON.stringify(migrated, null, 2), { mode: 0o600 });
	} catch {
		return [];
	}

	if (retireOauth) {
		try {
			renameSync(oauthPath, `${oauthPath}.migrated`);
			syncDirectorySync(dirname(oauthPath));
		} catch {
			// auth.json is already durable; leave oauth.json as a recoverable source.
		}
	}

	if (nextSettings !== undefined) {
		try {
			replaceFileAtomicallySync(settingsPath, nextSettings, { mode: 0o600 });
		} catch {
			// auth.json is already durable; leave settings.json unchanged on replacement failure.
		}
	}

	return providers;
}

/**
 * A live writer lease is an expected reason to defer migration: the next
 * startup will see the file again after the writer closes.
 */
function isExpectedMigrationContention(error: unknown): boolean {
	return error instanceof SessionLeaseError && error.code === "SESSION_IN_USE";
}

function reportUnexpectedMigrationFailure(file: string, error: unknown): void {
	try {
		const code = (error as NodeJS.ErrnoException | undefined)?.code;
		const message = error instanceof Error ? error.message : String(error);
		const detail = code && message ? `${code}: ${message}` : message || code || "unknown error";
		console.warn(
			chalk.yellow(
				`Warning: Could not migrate session ${sanitizeTerminalText(file)}: ${sanitizeTerminalText(detail)}`,
			),
		);
	} catch {
		// Diagnostics must never abort the migration loop or mask its cleanup.
	}
}

/** Relocate flat *.jsonl session files into per-cwd session directories. */
export function migrateSessionsFromAgentRoot(): void {
	const agentDir = getAgentDir();

	let names: string[];
	try {
		names = readdirSync(agentDir);
	} catch {
		return;
	}

	// A retired journal can still grow through an old fd after migration. Reconcile
	// retained backups on every startup before looking for newly restored sources.
	for (const name of names.filter((candidate) => RETIRED_SESSION_NAME.test(candidate)).sort()) {
		if (canSkipRetiredSessionReconciliation(agentDir, name)) continue;
		reconcileRetiredSessionBackup(agentDir, name);
	}

	let files: string[];
	try {
		files = readdirSync(agentDir)
			.filter((f) => f.endsWith(".jsonl"))
			.map((f) => join(agentDir, f));
	} catch {
		return;
	}

	for (const file of files) {
		let source: SessionManager | undefined;
		let target: SessionManager | undefined;
		try {
			// Opening the source for mutation acquires its lifetime writer lease before
			// reading or repairing it. An active CLI/app-server therefore makes this
			// startup migration skip the file instead of moving it under a live writer.
			source = SessionManager.importFrom(file, file);
			const header = source.getHeader();
			if (!header?.cwd) continue;

			// Compute the correct session directory (same encoding as session-manager.ts)
			const safePath = encodePathForStorage(header.cwd);
			const correctDir = join(agentDir, "sessions", safePath);
			const newPath = join(correctDir, basename(file));

			try {
				// The target journal is create-exclusive. A target that appears at any point
				// in this migration attempt is never replaced.
				target = SessionManager.importFrom(file, newPath, undefined, {
					destinationMode: "create-exclusive",
				});
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

				// A previous copy-then-retire attempt may have crashed after publishing the
				// target. Pin both journals with writer leases and compare their raw durable
				// records. Hydrated projections can hide missing or corrupt image assets.
				target = SessionManager.importFrom(newPath, newPath);
			}

			// Validate newly published targets too. Copying and hydrating successfully is
			// not proof that every durable record and referenced asset reached the target.
			if (!target.containsDurablePrefixOf(source)) continue;

			// Atomically retire the active source path, then revalidate the exact journal
			// entry captured by the rename. Keep the uniquely named backup: a non-cooperating
			// writer may still append through an old fd after validation, and that data must
			// remain recoverable.
			const retiredPath = join(dirname(file), `.${basename(file)}.${randomUUID()}.migrated`);
			renameSync(file, retiredPath);
			syncDirectorySync(dirname(file));
			let retiredReconciled = false;
			try {
				retiredReconciled = target.containsRetiredDurableSource(retiredPath, file);
				if (!retiredReconciled) {
					restoreRetiredSessionSource(retiredPath, file);
				}
			} catch {
				restoreRetiredSessionSource(retiredPath, file);
			}
			if (retiredReconciled) {
				publishRetiredSessionCheckpoint(agentDir, basename(retiredPath), safePath, newPath);
			}
		} catch (error) {
			// A live writer is expected; report only genuinely unexpected failures
			// while leaving the source, target, and backup recovery paths untouched.
			if (!isExpectedMigrationContention(error)) {
				reportUnexpectedMigrationFailure(file, error);
			}
		} finally {
			closeSessionManagerAfterMigration(target);
			closeSessionManagerAfterMigration(source);
		}
	}
}

function reconcileRetiredSessionBackup(agentDir: string, retiredName: string): void {
	const match = RETIRED_SESSION_NAME.exec(retiredName);
	if (!match) return;
	const sourcePath = join(agentDir, match[1]!);
	const retiredPath = join(agentDir, retiredName);
	let retiredValidated = false;
	let target: SessionManager | undefined;
	try {
		// Strict read-only open rejects corrupt, symlinked, hard-linked, and
		// non-regular artifacts before any active source path is restored.
		const header = SessionManager.readRetiredSessionHeader(retiredPath);
		if (!header.cwd) return;
		retiredValidated = true;
		const targetDirectory = encodePathForStorage(header.cwd);
		const targetPath = join(agentDir, "sessions", targetDirectory, basename(sourcePath));
		if (!existsSync(targetPath)) {
			restoreRetiredSessionSource(retiredPath, sourcePath);
			return;
		}

		target = SessionManager.importFrom(targetPath, targetPath);
		if (!target.reconcileRetiredDurableSource(retiredPath, sourcePath)) {
			restoreRetiredSessionSource(retiredPath, sourcePath);
		} else {
			publishRetiredSessionCheckpoint(agentDir, retiredName, targetDirectory, targetPath);
		}
	} catch {
		if (retiredValidated) restoreRetiredSessionSource(retiredPath, sourcePath);
	} finally {
		closeSessionManagerAfterMigration(target);
	}
}

function restoreRetiredSessionSource(retiredPath: string, sourcePath: string): void {
	try {
		SessionManager.restoreRetiredSessionPrefix(retiredPath, sourcePath);
	} catch {
		// Never replace a source that reappeared concurrently; the backup remains recoverable.
	}
}

function closeSessionManagerAfterMigration(manager: SessionManager | undefined): void {
	if (!manager) return;
	try {
		manager.close();
	} catch {
		try {
			manager.close();
		} catch {
			// Preserve the original migration outcome; dead owners are reclaimable.
		}
	}
}

/**
 * Migrate commands/ to prompts/ if needed.
 * Works for both regular directories and symlinks.
 */
function migrateCommandsToPrompts(baseDir: string, label: string): boolean {
	const commandsDir = join(baseDir, "commands");
	const promptsDir = join(baseDir, "prompts");

	if (existsSync(commandsDir) && !existsSync(promptsDir)) {
		try {
			renameSync(commandsDir, promptsDir);
			console.log(chalk.green(`Migrated ${label} commands/ → prompts/`));
			return true;
		} catch (err) {
			console.log(
				chalk.yellow(
					`Warning: Could not migrate ${label} commands/ to prompts/: ${err instanceof Error ? err.message : err}`,
				),
			);
		}
	}
	return false;
}

function migrateKeybindingsConfigFile(): void {
	const configPath = join(getAgentDir(), "keybindings.json");
	if (!existsSync(configPath)) return;

	try {
		const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
			return;
		}
		const { config, migrated } = migrateKeybindingsConfig(parsed as Record<string, unknown>);
		if (!migrated) return;
		replaceFileAtomicallySync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	} catch {
		// Keep malformed files and the previous configuration on replacement failure.
	}
}

/**
 * Move fd/rg binaries from tools/ to bin/ if they exist.
 */
function migrateToolsToBin(): void {
	const agentDir = getAgentDir();
	const toolsDir = join(agentDir, "tools");
	const binDir = getBinDir();

	if (!existsSync(toolsDir)) return;

	const binaries = ["fd", "rg", "fd.exe", "rg.exe"];
	let movedAny = false;

	for (const bin of binaries) {
		const oldPath = join(toolsDir, bin);
		const newPath = join(binDir, bin);

		if (existsSync(oldPath)) {
			if (!existsSync(binDir)) {
				mkdirSync(binDir, { recursive: true });
			}
			if (!existsSync(newPath)) {
				try {
					renameSync(oldPath, newPath);
					movedAny = true;
				} catch {
					// Ignore errors
				}
			} else {
				// Target exists, just delete the old one
				try {
					rmSync?.(oldPath, { force: true });
				} catch {
					// Ignore
				}
			}
		}
	}

	if (movedAny) {
		console.log(chalk.green(`Migrated managed binaries tools/ → bin/`));
	}
}

/**
 * Check for deprecated hooks/ and tools/ directories.
 * Note: tools/ may contain fd/rg binaries extracted by Metis, so only warn if it has other files.
 */
function checkDeprecatedExtensionDirs(baseDir: string, label: string): string[] {
	const hooksDir = join(baseDir, "hooks");
	const toolsDir = join(baseDir, "tools");
	const warnings: string[] = [];

	if (existsSync(hooksDir)) {
		warnings.push(`${label} hooks/ directory found. Hooks have been renamed to extensions.`);
	}

	if (existsSync(toolsDir)) {
		// Check if tools/ contains anything other than fd/rg (which are auto-extracted binaries)
		try {
			const entries = readdirSync(toolsDir);
			const customTools = entries.filter((e) => {
				const lower = e.toLowerCase();
				return (
					lower !== "fd" && lower !== "rg" && lower !== "fd.exe" && lower !== "rg.exe" && !e.startsWith(".") // Ignore .DS_Store and other hidden files
				);
			});
			if (customTools.length > 0) {
				warnings.push(
					`${label} tools/ directory contains custom tools. Custom tools have been merged into extensions.`,
				);
			}
		} catch {
			// Ignore read errors
		}
	}

	return warnings;
}

/**
 * Run extension system migrations (commands→prompts) and collect warnings about deprecated directories.
 */
function migrateExtensionSystem(cwd: string): string[] {
	const agentDir = getAgentDir();
	const projectDir = getProjectConfigDir(cwd);

	// Migrate commands/ to prompts/
	migrateCommandsToPrompts(agentDir, "Global");
	migrateCommandsToPrompts(projectDir, "Project");

	// Check for deprecated directories
	const warnings = [
		...checkDeprecatedExtensionDirs(agentDir, "Global"),
		...checkDeprecatedExtensionDirs(projectDir, "Project"),
	];

	return warnings;
}

/**
 * Print deprecation warnings, waiting for a keypress only on a usable TTY.
 */
export async function showDeprecationWarnings(warnings: string[]): Promise<void> {
	if (warnings.length === 0) return;

	for (const warning of warnings) {
		console.log(chalk.yellow(`Warning: ${warning}`));
	}
	console.log(chalk.yellow(`\nMove your extensions to the extensions/ directory.`));
	console.log(chalk.yellow(`Migration guide: ${MIGRATION_GUIDE_URL}`));
	console.log(chalk.yellow(`Documentation: ${EXTENSIONS_DOC_URL}`));

	const stdin = process.stdin;
	if (!stdin.isTTY || stdin.destroyed || stdin.readableEnded || stdin.readable === false) {
		// Non-interactive or already-closed stdin has no keypress to wait for.
		return;
	}

	console.log(chalk.dim(`\nPress any key to continue...`));

	const wasRaw = stdin.isRaw === true;
	const wasFlowing = stdin.readableFlowing === true;
	let resumedInput = false;

	await new Promise<void>((resolve) => {
		let settled = false;
		const finish = () => {
			if (settled) return;
			settled = true;
			stdin.off("data", finish);
			stdin.off("end", finish);
			stdin.off("close", finish);
			stdin.off("error", finish);
			try {
				stdin.setRawMode?.(wasRaw);
			} catch {
				// The stream is already unusable; still restore pause ownership below.
			}
			try {
				if (!wasFlowing) stdin.pause();
				else if (!resumedInput) stdin.resume();
			} catch {
				// Best-effort state restoration for a closing stream.
			}
			resolve();
		};

		try {
			stdin.setRawMode?.(true);
			stdin.once("data", finish);
			stdin.once("end", finish);
			stdin.once("close", finish);
			stdin.on("error", finish);
			stdin.resume();
			resumedInput = true;
		} catch {
			finish();
		}
	});
	console.log();
}

/**
 * Run all migrations. Called once on startup.
 *
 * @returns Object with migration results and deprecation warnings
 */
export function runMigrations(cwd: string): {
	migratedAuthProviders: string[];
	deprecationWarnings: string[];
} {
	const migratedAuthProviders = migrateAuthToAuthJson();
	migrateSessionsFromAgentRoot();
	migrateToolsToBin();
	migrateKeybindingsConfigFile();
	const deprecationWarnings = migrateExtensionSystem(cwd);
	return { migratedAuthProviders, deprecationWarnings };
}
