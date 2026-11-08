import { randomUUID } from "crypto";
import { DEFAULT_PERMISSION_PRESET, isPermissionPreset, type PermissionPreset } from "./permissions/settings.ts";
import {
	isAgentControlEntryType,
	isPlanControlEntryType,
	isSessionControlEntryType,
	isSessionDirectoryControlEntryType,
} from "./session-control.ts";
import { CorruptSessionError, UnsupportedSessionVersionError } from "./session-journal.ts";
import type { CompactionEntry, FileEntry, SessionEntry, SessionMessageEntry } from "./session-manager.ts";

/** Current durable session journal version. */
export const CURRENT_SESSION_VERSION = 15;

export function isJsonObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function corruptSession(filePath: string, lineNumber: number, message: string): never {
	throw new CorruptSessionError(filePath, lineNumber, message);
}

/** Generate a unique short ID (8 hex chars, collision-checked) */
export function generateId(byId: { has(id: string): boolean }): string {
	for (let i = 0; i < 100; i++) {
		const id = randomUUID().slice(0, 8);
		if (!byId.has(id)) return id;
	}
	for (let i = 0; i < 100; i++) {
		const id = randomUUID();
		if (!byId.has(id)) return id;
	}
	throw new Error("Unable to generate a unique session record id");
}

/** Migrate v1 → v2: add id/parentId tree structure. Mutates in place. */
function migrateV1ToV2(entries: FileEntry[]): void {
	const ids = new Set<string>();
	let prevId: string | null = null;

	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 2;
			continue;
		}

		const treeEntry = entry as SessionEntry;
		treeEntry.id = generateId(ids);
		ids.add(treeEntry.id);
		treeEntry.parentId = prevId;
		prevId = treeEntry.id;

		// Convert firstKeptEntryIndex to firstKeptEntryId for compaction
		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry & { firstKeptEntryIndex?: number };
			if (typeof comp.firstKeptEntryIndex === "number") {
				const targetEntry = entries[comp.firstKeptEntryIndex];
				if (targetEntry && targetEntry.type !== "session") {
					comp.firstKeptEntryId = targetEntry.id;
				}
				delete comp.firstKeptEntryIndex;
			}
		}
	}
}

/** Migrate v2 → v3: rename hookMessage role to custom. Mutates in place. */
function migrateV2ToV3(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") {
			entry.version = 3;
			continue;
		}

		// Update message entries with hookMessage role
		if (entry.type === "message") {
			const msgEntry = entry as SessionMessageEntry;
			if (msgEntry.message && (msgEntry.message as { role: string }).role === "hookMessage") {
				(msgEntry.message as { role: string }).role = "custom";
			}
		}
	}
}

/** Migrate v3 → v4: externalize inline images when the session is rewritten. */
function migrateV3ToV4(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") entry.version = 4;
	}
}

/** Migrate v4 → v5: reserve journal-only runtime control records. */
function migrateV4ToV5(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") entry.version = 5;
	}
}

/** Migrate v5 → v6: reserve journal-only session permission controls. */
function migrateV5ToV6(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") entry.version = 6;
	}
}

/** Migrate v6 → v7: reserve child markers and first-class subagent controls. */
function migrateV6ToV7(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") entry.version = 7;
	}
}

/** Migrate v7 → v8: reserve Code-session additional-directory controls. */
function migrateV7ToV8(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") entry.version = 8;
	}
}

/** Migrate v8 → v9: reserve policy-owned unattended permission decisions. */
function migrateV8ToV9(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") entry.version = 9;
	}
}

/** Migrate v9 → v10: reserve hidden scheduled-session ownership markers. */
function migrateV9ToV10(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") entry.version = 10;
	}
}

/** Migrate v10 → v11: reserve the retired child mailbox control range. */
function migrateV10ToV11(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") entry.version = 11;
	}
}

/** Migrate v11 → v12: reserve durable Plan collaboration controls. */
function migrateV11ToV12(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") entry.version = 12;
	}
}

/** Migrate v12 → v13: reserve canonical Agent/Task controls. */
function migrateV12ToV13(entries: FileEntry[]): void {
	for (const entry of entries) {
		if (entry.type === "session") entry.version = 13;
	}
}

/** Convert known v13 permission fields, then stamp the current session version. */
export function migrateLegacyPermissionFields(
	value: Record<string, unknown>,
	filePath: string,
	lineNumber: number,
	fallback?: PermissionPreset,
): void {
	const legacy = value.permissionMode;
	const current = value.permissionPreset;
	if (legacy !== undefined && !isPermissionPreset(legacy)) {
		corruptSession(filePath, lineNumber, "Legacy permission mode is invalid");
	}
	if (current !== undefined && !isPermissionPreset(current)) {
		corruptSession(filePath, lineNumber, "Permission preset is invalid");
	}
	if (legacy !== undefined && current !== undefined && legacy !== current) {
		corruptSession(filePath, lineNumber, "Legacy and current permission settings conflict");
	}
	if (value.reviewerEnabled !== undefined && typeof value.reviewerEnabled !== "boolean") {
		corruptSession(filePath, lineNumber, "Legacy reviewer setting is invalid");
	}
	const permissionPreset = current ?? legacy ?? fallback;
	if (!isPermissionPreset(permissionPreset)) {
		corruptSession(filePath, lineNumber, "Legacy permission setting is missing");
	}
	value.permissionPreset = permissionPreset;
	delete value.permissionMode;
	delete value.reviewerEnabled;
}

function migrateLegacySessionPermissionsRecord(
	value: Record<string, unknown>,
	filePath: string,
	lineNumber: number,
): void {
	const keys = Object.keys(value);
	const allowed = new Set(["type", "id", "parentId", "timestamp", "permissionMode", "reviewerEnabled"]);
	if (keys.some((key) => !allowed.has(key))) {
		corruptSession(filePath, lineNumber, "Legacy permission control has an unsupported field");
	}
	for (const key of ["type", "id", "parentId", "timestamp", "permissionMode"]) {
		if (!Object.hasOwn(value, key)) {
			corruptSession(filePath, lineNumber, "Legacy permission control is missing a required field");
		}
	}
	migrateLegacyPermissionFields(value, filePath, lineNumber);
	value.type = "session_permission_preset";
}

export function migrateLegacyPermissionJournalRecord(
	value: Record<string, unknown>,
	filePath: string,
	lineNumber: number,
): void {
	if (value.type === "session_permissions") {
		migrateLegacySessionPermissionsRecord(value, filePath, lineNumber);
		return;
	}
	if (value.type === "session_permission_decision") {
		value.type = "session_permission_audit";
	}
}

function migrateV13ToV14(entries: FileEntry[], filePath: string): void {
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index] as unknown as Record<string, unknown>;
		const lineNumber = index + 1;
		if (entry.type === "session") {
			migrateLegacyPermissionFields(entry, filePath, lineNumber, DEFAULT_PERMISSION_PRESET);
			if (isJsonObject(entry.agent)) {
				migrateLegacyPermissionFields(entry.agent, filePath, lineNumber);
			}
			entry.version = 14;
			continue;
		}
		migrateLegacyPermissionJournalRecord(entry, filePath, lineNumber);
	}
}

/**
 * Classify the first journal record before any body interpretation or repair:
 * a future-format header must surface as UnsupportedSessionVersionError, never
 * as a repairable corrupt body.
 */
export function validateFirstJournalRecord(record: unknown, filePath: string): void {
	if (!isJsonObject(record) || record.type !== "session") return;
	readSessionVersion(record, filePath);
}

export function readSessionVersion(record: Record<string, unknown>, filePath: string): number {
	const version = record.version === undefined ? 1 : record.version;
	if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
		corruptSession(filePath, 1, "Session header has an invalid version");
	}
	if (version > CURRENT_SESSION_VERSION) {
		throw new UnsupportedSessionVersionError({ filePath, found: version, supported: CURRENT_SESSION_VERSION });
	}
	return version;
}

export function validateSourceSessionHeaderVersion(record: Record<string, unknown>, filePath: string): number {
	const version = readSessionVersion(record, filePath);
	if (
		version < 6 &&
		(record.cwdOrigin !== undefined ||
			record.permissionMode !== undefined ||
			record.reviewerEnabled !== undefined ||
			record.permissionPreset !== undefined)
	) {
		corruptSession(filePath, 1, "Workspace and permission header fields require a v6 session header");
	}
	if (version < 10 && record.scheduled !== undefined) {
		corruptSession(filePath, 1, "Scheduled header fields require a v10 session header");
	}
	if (version < 13 && record.agent !== undefined) {
		corruptSession(filePath, 1, "Agent header fields require a v13 session header");
	}
	return version;
}

export function validateSessionRecordVersion(
	type: string,
	version: number,
	filePath: string,
	lineNumber: number,
): void {
	if (
		["agent_input", "agent_run_control", "agent_role_snapshot", "agent_permission_ceiling"].includes(type) &&
		version < 15
	)
		corruptSession(filePath, lineNumber, "Agent conversation records require a v15 session header");
	if (type.startsWith("runtime_") && version < 5) {
		corruptSession(filePath, lineNumber, "Runtime control entries require a v5 session header");
	}
	if ((type === "session_permission_preset" || type === "session_permission_audit") && version < 14) {
		corruptSession(filePath, lineNumber, "Permission control entries require a v14 session header");
	}
	if (isSessionDirectoryControlEntryType(type) && version < 8) {
		corruptSession(filePath, lineNumber, "Directory control entries require a v8 session header");
	}
	if (isAgentControlEntryType(type) && version < 13) {
		corruptSession(filePath, lineNumber, "Agent control entries require a v13 session header");
	}
	if (isPlanControlEntryType(type) && version < 12) {
		corruptSession(filePath, lineNumber, "Plan control entries require a v12 session header");
	}
	if (
		version < 6 &&
		(type === "session_permissions" ||
			type === "session_permission_decision" ||
			(isSessionControlEntryType(type) &&
				!isAgentControlEntryType(type) &&
				type !== "session_permission_preset" &&
				type !== "session_permission_audit"))
	) {
		corruptSession(filePath, lineNumber, "Session control entries require a v6 session header");
	}
}

export function validateAgentConversationVersion(
	record: Record<string, unknown>,
	version: number,
	filePath: string,
	lineNumber: number,
): void {
	if (version >= 15) return;
	const event =
		record.type === "agent_mailbox_event" && typeof record.event === "object" && record.event !== null
			? (record.event as Record<string, unknown>)
			: undefined;
	if (
		record.agentMessageId !== undefined ||
		record.instructionRevision !== undefined ||
		record.consumedInstructionRevision !== undefined ||
		(event &&
			(event.type !== "terminal" ||
				event.instructionRevision !== undefined ||
				event.consumedInstructionRevision !== undefined))
	)
		corruptSession(filePath, lineNumber, "Agent conversation fields require a v15 session header");
}

function validateSourceSessionVersionBoundaries(entries: readonly FileEntry[], filePath: string): number {
	const header = entries.find((entry) => entry.type === "session") as unknown as Record<string, unknown> | undefined;
	const version = validateSourceSessionHeaderVersion(header ?? {}, filePath);
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index];
		if (entry.type !== "session") {
			validateSessionRecordVersion(entry.type, version, filePath, index + 1);
			validateAgentConversationVersion(entry as unknown as Record<string, unknown>, version, filePath, index + 1);
		}
	}
	return version;
}

/**
 * Run all necessary migrations to bring entries to current version.
 * Mutates entries in place. Returns true if any migration was applied.
 */
function migrateToCurrentVersion(entries: FileEntry[], filePath: string): boolean {
	const version = validateSourceSessionVersionBoundaries(entries, filePath);

	if (version >= CURRENT_SESSION_VERSION) return false;

	if (version < 2) migrateV1ToV2(entries);
	if (version < 3) migrateV2ToV3(entries);
	if (version < 4) migrateV3ToV4(entries);
	if (version < 5) migrateV4ToV5(entries);
	if (version < 6) migrateV5ToV6(entries);
	if (version < 7) migrateV6ToV7(entries);
	if (version < 8) migrateV7ToV8(entries);
	if (version < 9) migrateV8ToV9(entries);
	if (version < 10) migrateV9ToV10(entries);
	if (version < 11) migrateV10ToV11(entries);
	if (version < 12) migrateV11ToV12(entries);
	if (version < 13) migrateV12ToV13(entries);
	if (version < 14) migrateV13ToV14(entries, filePath);
	if (version < 15) for (const entry of entries) if (entry.type === "session") entry.version = 15;

	return true;
}

export { migrateToCurrentVersion };
