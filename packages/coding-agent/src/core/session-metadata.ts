import { lstatSync, unlinkSync } from "fs";
import { dirname } from "path";
import { readSingleLinkTextFileSync, replaceFileAtomicallySync, syncDirectorySync } from "./durable-file.ts";
import {
	MAX_SESSION_DISPLAY_METADATA_BYTES,
	parseSessionDisplayMetadata,
	serializeSessionDisplayMetadata,
} from "./session-display-metadata-codec.ts";
import { getSessionDisplayMetadataPath, getSessionUnreadStatePath } from "./session-file-paths.ts";
import { assertValidSessionId } from "./session-id.ts";
import { SessionLease } from "./session-lease.ts";

const MAX_SESSION_UNREAD_STATE_BYTES = 1024;

export interface SessionDisplayMetadata {
	readonly sessionId: string;
	readonly name?: string;
	/**
	 * Per-session memory controls persisted next to the journal rather than in
	 * it: catalog scans, the dream gate, and session open all read this file
	 * cheaply, and a flag flip must not dirty the journal fingerprint. Flags are
	 * per-installation; forked/imported sessions revert to the enabled default.
	 */
	readonly useMemory?: boolean;
	readonly contributeMemory?: boolean;
}

export function readSessionUnreadState(sessionFile: string, sessionId: string): boolean {
	try {
		assertValidSessionId(sessionId);
		const text = readSingleLinkTextFileSync(getSessionUnreadStatePath(sessionFile), {
			maxBytes: MAX_SESSION_UNREAD_STATE_BYTES,
		});
		if (text === undefined) return false;
		const value = JSON.parse(text) as Record<string, unknown>;
		return value.version === 1 && value.sessionId === sessionId && value.unread === true;
	} catch {
		return false;
	}
}

export function readSessionDisplayMetadata(sessionFile: string): SessionDisplayMetadata | undefined {
	try {
		const text = readSingleLinkTextFileSync(getSessionDisplayMetadataPath(sessionFile), {
			maxBytes: MAX_SESSION_DISPLAY_METADATA_BYTES,
		});
		if (text === undefined) return undefined;
		return parseSessionDisplayMetadata(text);
	} catch {
		return undefined;
	}
}

export function removeSessionUnreadState(sessionFile: string): void {
	const path = getSessionUnreadStatePath(sessionFile);
	try {
		const stats = lstatSync(path);
		if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
			throw new Error("Session unread state must be a single-link regular file");
		}
		unlinkSync(path);
		syncDirectorySync(dirname(path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export function writeSessionUnreadState(sessionFile: string, sessionId: string): void {
	assertValidSessionId(sessionId);
	const contents = `${JSON.stringify({ version: 1, sessionId, unread: true })}\n`;
	replaceFileAtomicallySync(getSessionUnreadStatePath(sessionFile), contents, { mode: 0o600 });
}

export function removeSessionDisplayMetadata(sessionFile: string): void {
	const path = getSessionDisplayMetadataPath(sessionFile);
	try {
		const stats = lstatSync(path);
		if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1) {
			throw new Error("Session display metadata must be a single-link regular file");
		}
		unlinkSync(path);
		syncDirectorySync(dirname(path));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export function writeSessionDisplayMetadata(sessionFile: string, metadata: SessionDisplayMetadata): void {
	const contents = serializeSessionDisplayMetadata(metadata);
	replaceFileAtomicallySync(getSessionDisplayMetadataPath(sessionFile), contents, { mode: 0o600 });
}

export function migrateSessionDisplayMetadata(
	sessionFile: string,
	expected: SessionDisplayMetadata & {
		readonly dev: number;
		readonly ino: number;
		readonly size: number;
		readonly mtimeMs: number;
		readonly ctimeMs: number;
	},
): boolean {
	let lease: SessionLease;
	try {
		lease = SessionLease.acquireTransient(sessionFile);
	} catch {
		return false;
	}
	let migrated = false;
	try {
		const current = lstatSync(sessionFile);
		if (
			!current.isFile() ||
			current.isSymbolicLink() ||
			current.nlink !== 1 ||
			current.dev !== expected.dev ||
			current.ino !== expected.ino ||
			current.size !== expected.size ||
			current.mtimeMs !== expected.mtimeMs ||
			current.ctimeMs !== expected.ctimeMs
		) {
			return false;
		}
		writeSessionDisplayMetadata(sessionFile, expected);
		migrated = true;
	} catch {
		return false;
	} finally {
		try {
			lease.close();
		} catch {
			migrated = false;
		}
	}
	return migrated;
}
