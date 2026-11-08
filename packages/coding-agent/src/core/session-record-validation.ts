import { isAbsolute, normalize } from "node:path";
import { DEFAULT_AGENT_MODE, isAgentMode } from "./agent-mode.ts";
import { isPermissionPreset } from "./permissions/settings.ts";
import { isRuntimeControlEntryType, parseRuntimeControlEntry, type RuntimeControlEntry } from "./runtime-recovery.ts";
import {
	isSessionControlEntryType,
	isSessionDirectoryControlEntryType,
	parseSessionControlEntry,
	type SessionControlEntry,
} from "./session-control.ts";
import { assertValidSessionId } from "./session-id.ts";
import { CorruptSessionError } from "./session-journal.ts";
import type { FileEntry, SessionEntry, SessionHeader } from "./session-manager.ts";
import {
	corruptSession,
	isJsonObject,
	readSessionVersion,
	validateAgentConversationVersion,
	validateSessionRecordVersion,
} from "./session-migrations.ts";
import { isValidAgentTypeId, parseAgentRoleSnapshot } from "./subagents/agent-type-registry.ts";

export function validateRawSessionRecord(record: unknown, index: number, filePath: string): Record<string, unknown> {
	if (!isJsonObject(record) || typeof record.type !== "string" || record.type.length === 0) {
		corruptSession(filePath, index + 1, "Session record must be a JSON object with a type");
	}
	if (index === 0 && record.type !== "session") {
		corruptSession(filePath, 1, `Session file is not a valid metis session: ${filePath}`);
	}
	if (index > 0 && record.type === "session") {
		corruptSession(filePath, index + 1, "Session journal contains more than one header");
	}
	return record;
}

export function validateSessionHeader(record: Record<string, unknown>, filePath: string): SessionHeader {
	const header = record as unknown as SessionHeader;
	const headerFields = new Set([
		"type",
		"version",
		"id",
		"timestamp",
		"cwd",
		"mode",
		"cwdOrigin",
		"permissionPreset",
		"parentSession",
		"agent",
		"scheduled",
	]);
	if (Object.keys(record).some((field) => !headerFields.has(field))) {
		corruptSession(filePath, 1, "Session header contains an unsupported field");
	}
	try {
		assertValidSessionId(header.id);
	} catch (error) {
		throw new CorruptSessionError(filePath, 1, "Session header has an invalid id", { cause: error });
	}
	if (typeof header.timestamp !== "string" || !Number.isFinite(Date.parse(header.timestamp))) {
		corruptSession(filePath, 1, "Session header has an invalid timestamp");
	}
	if (typeof header.cwd !== "string") {
		corruptSession(filePath, 1, "Session header has an invalid cwd");
	}
	if (header.parentSession !== undefined && typeof header.parentSession !== "string") {
		corruptSession(filePath, 1, "Session header has an invalid parentSession");
	}
	if (header.mode !== undefined && !isAgentMode(header.mode)) {
		corruptSession(filePath, 1, "Session header has an invalid mode");
	}
	if (header.cwdOrigin !== undefined && header.cwdOrigin !== "managed" && header.cwdOrigin !== "user-selected") {
		corruptSession(filePath, 1, "Session header has an invalid cwdOrigin");
	}
	if (record.permissionPreset !== undefined && !isPermissionPreset(record.permissionPreset)) {
		corruptSession(filePath, 1, "Session header has an invalid permissionPreset");
	}
	if (header.agent !== undefined) {
		if (!isJsonObject(header.agent)) corruptSession(filePath, 1, "Session header has an invalid agent marker");
		const agent = header.agent;
		const agentFields = new Set([
			"agentId",
			"name",
			"parentSessionId",
			"rootSessionId",
			"agentPath",
			"agentType",
			"roleSnapshot",
			"tools",
			"writePolicy",
			"permissionPreset",
			"model",
			"thinkingLevel",
			"cwd",
			"forkTurns",
			"timeoutSeconds",
			"mayDelegate",
			"initialTask",
		]);
		if (Object.keys(agent).some((field) => !agentFields.has(field))) {
			corruptSession(filePath, 1, "Session header agent marker contains an unsupported field");
		}
		try {
			assertValidSessionId(agent.agentId);
			assertValidSessionId(agent.parentSessionId);
			assertValidSessionId(agent.rootSessionId);
		} catch (error) {
			throw new CorruptSessionError(filePath, 1, "Session header has an invalid agent id", { cause: error });
		}
		if (agent.agentId !== header.id) corruptSession(filePath, 1, "Session header agent id must match session id");
		if (
			typeof agent.name !== "string" ||
			agent.name.length < 1 ||
			agent.name.length > 128 ||
			/[\u0000-\u001f\u007f-\u009f]/u.test(agent.name)
		) {
			corruptSession(filePath, 1, "Session header has an invalid agent name");
		}
		if (!Array.isArray(agent.agentPath) || agent.agentPath.length < 1 || agent.agentPath.length > 2) {
			corruptSession(filePath, 1, "Session header has an invalid agent path");
		}
		if (agent.agentPath.at(-1) !== agent.agentId) {
			corruptSession(filePath, 1, "Session header agent path must end with agent id");
		}
		if (typeof agent.agentType !== "string" || !isValidAgentTypeId(agent.agentType)) {
			corruptSession(filePath, 1, "Session header has an invalid agent type");
		}
		if (agent.roleSnapshot !== undefined) {
			if ((header.version ?? 1) < 15)
				corruptSession(filePath, 1, "Agent role snapshots require a v15 session header");
			try {
				const snapshot = parseAgentRoleSnapshot(agent.roleSnapshot);
				if (snapshot.agentType !== agent.agentType) throw new Error("Role snapshot type mismatch");
			} catch (error) {
				throw new CorruptSessionError(filePath, 1, "Invalid agent role snapshot", { cause: error });
			}
		}
		if (agent.writePolicy !== "inherit" && agent.writePolicy !== "deny") {
			corruptSession(filePath, 1, "Session header has an invalid agent write policy");
		}
		if (!isPermissionPreset(agent.permissionPreset)) {
			corruptSession(filePath, 1, "Session header has an invalid agent permission preset");
		}
		if (
			!isJsonObject(agent.model) ||
			typeof agent.model.provider !== "string" ||
			typeof agent.model.modelId !== "string"
		) {
			corruptSession(filePath, 1, "Session header has an invalid agent model");
		}
		if (typeof agent.cwd !== "string" || !isAbsolute(agent.cwd) || normalize(agent.cwd) !== agent.cwd) {
			corruptSession(filePath, 1, "Session header has an invalid agent cwd");
		}
		if (
			agent.forkTurns !== "all" &&
			(!Number.isInteger(agent.forkTurns) || agent.forkTurns < 0 || agent.forkTurns > 1_000)
		) {
			corruptSession(filePath, 1, "Session header has an invalid agent forkTurns");
		}
		if (!Number.isInteger(agent.timeoutSeconds) || agent.timeoutSeconds < 1 || agent.timeoutSeconds > 1_800) {
			corruptSession(filePath, 1, "Session header has an invalid agent timeout");
		}
		if (typeof agent.mayDelegate !== "boolean") {
			corruptSession(filePath, 1, "Session header has an invalid agent delegation flag");
		}
		if (typeof agent.initialTask !== "string" || agent.initialTask.length < 1) {
			corruptSession(filePath, 1, "Session header has an invalid agent initial task");
		}
		if (!Array.isArray(agent.tools) || agent.tools.length > 128) {
			corruptSession(filePath, 1, "Session header has invalid agent tools");
		}
	}
	if (header.scheduled !== undefined) {
		if (!isJsonObject(header.scheduled))
			corruptSession(filePath, 1, "Session header has an invalid scheduled marker");
		const fields = Object.keys(header.scheduled);
		if (fields.length !== 2 || !fields.includes("taskId") || !fields.includes("runId")) {
			corruptSession(filePath, 1, "Session header has an invalid scheduled marker");
		}
		try {
			assertValidSessionId(header.scheduled.taskId);
			assertValidSessionId(header.scheduled.runId);
		} catch (error) {
			throw new CorruptSessionError(filePath, 1, "Session header has an invalid scheduled id", { cause: error });
		}
		if (header.agent !== undefined) {
			corruptSession(filePath, 1, "Session header cannot be both scheduled and an agent");
		}
	}
	const version = readSessionVersion(record, filePath);
	if (version < 6 && (header.cwdOrigin !== undefined || record.permissionPreset !== undefined)) {
		corruptSession(filePath, 1, "Workspace and permission header fields require a v6 session header");
	}
	if (version >= 14 && !isPermissionPreset(header.permissionPreset)) {
		corruptSession(filePath, 1, "Current session header requires permissionPreset");
	}
	if (version < 10 && header.scheduled !== undefined) {
		corruptSession(filePath, 1, "Scheduled header fields require a v10 session header");
	}
	if (version < 13 && header.agent !== undefined) {
		corruptSession(filePath, 1, "Agent header fields require a v13 session header");
	}
	return header;
}

export function validateSessionRecordEnvelopes(records: readonly unknown[], filePath: string): void {
	if (records.length === 0) corruptSession(filePath, 1, "Session journal is empty");
	for (let index = 0; index < records.length; index += 1) {
		validateRawSessionRecord(records[index], index, filePath);
	}
}

function validateRawSessionRecords(records: readonly unknown[], filePath: string): SessionHeader {
	validateSessionRecordEnvelopes(records, filePath);
	const header = validateSessionHeader(records[0] as Record<string, unknown>, filePath);
	const version = header.version ?? 1;
	for (let index = 1; index < records.length; index++) {
		const type = (records[index] as { type: string }).type;
		validateSessionRecordVersion(type, version, filePath, index + 1);
		validateAgentConversationVersion(records[index] as Record<string, unknown>, version, filePath, index + 1);
		if (type.startsWith("runtime_")) {
			if (!isRuntimeControlEntryType(type)) {
				corruptSession(filePath, index + 1, `Unknown runtime control entry type: ${type}`);
			}
			parseRuntimeRecord(records[index], index + 1, filePath);
			continue;
		}
		if (isSessionControlEntryType(type)) {
			if (isSessionDirectoryControlEntryType(type) && (header.mode ?? DEFAULT_AGENT_MODE) !== "code") {
				corruptSession(filePath, index + 1, "Directory controls are only valid for Code sessions");
			}
			parseSessionControlRecord(records[index], index + 1, filePath);
			continue;
		}
		if (type.startsWith("session_permission")) {
			corruptSession(filePath, index + 1, `Unknown session control entry type: ${type}`);
		}
		if (type.startsWith("session_directory_")) {
			corruptSession(filePath, index + 1, `Unknown session control entry type: ${type}`);
		}
	}
	return header;
}

export function parseRuntimeRecord(record: unknown, lineNumber: number, filePath: string): RuntimeControlEntry {
	try {
		const entry = parseRuntimeControlEntry(record);
		if (!Number.isFinite(Date.parse(entry.timestamp))) {
			corruptSession(filePath, lineNumber, `Runtime control entry ${entry.id} has an invalid timestamp`);
		}
		return entry;
	} catch (error) {
		if (error instanceof CorruptSessionError) throw error;
		throw new CorruptSessionError(filePath, lineNumber, "Invalid runtime control entry", { cause: error });
	}
}

export function parseSessionControlRecord(record: unknown, lineNumber: number, filePath: string): SessionControlEntry {
	try {
		const entry = parseSessionControlEntry(record);
		if (!Number.isFinite(Date.parse(entry.timestamp))) {
			corruptSession(filePath, lineNumber, `Session control entry ${entry.id} has an invalid timestamp`);
		}
		return entry;
	} catch (error) {
		if (error instanceof CorruptSessionError) throw error;
		throw new CorruptSessionError(filePath, lineNumber, "Invalid session control entry", { cause: error });
	}
}

function validateRecordId(id: unknown, lineNumber: number, filePath: string, seen: Set<string>): asserts id is string {
	if (typeof id !== "string" || id.length === 0) {
		corruptSession(filePath, lineNumber, "Session entry has an invalid id");
	}
	if (seen.has(id)) {
		corruptSession(filePath, lineNumber, `Session entry id is duplicated: ${id}`);
	}
}

export function validateSessionGraphEntry(
	entry: SessionEntry,
	lineNumber: number,
	filePath: string,
	seenRecordIds: Set<string>,
	seenTreeIds: Set<string>,
): void {
	validateRecordId(entry.id, lineNumber, filePath, seenRecordIds);
	if (entry.parentId !== null && (typeof entry.parentId !== "string" || entry.parentId.length === 0)) {
		corruptSession(filePath, lineNumber, `Session entry ${entry.id} has an invalid parentId`);
	}
	if (entry.parentId === entry.id) {
		corruptSession(filePath, lineNumber, `Session entry ${entry.id} cannot be its own parent`);
	}
	if (entry.parentId !== null && !seenTreeIds.has(entry.parentId)) {
		corruptSession(
			filePath,
			lineNumber,
			`Session entry ${entry.id} references a missing or forward parent: ${entry.parentId}`,
		);
	}
	if (typeof entry.timestamp !== "string" || !Number.isFinite(Date.parse(entry.timestamp))) {
		corruptSession(filePath, lineNumber, `Session entry ${entry.id} has an invalid timestamp`);
	}
	if (entry.type === "label" && (typeof entry.targetId !== "string" || !seenTreeIds.has(entry.targetId))) {
		corruptSession(filePath, lineNumber, `Label ${entry.id} references an unknown target`);
	}
	if (entry.type === "message" && entry.turnId !== undefined && (typeof entry.turnId !== "string" || !entry.turnId)) {
		corruptSession(filePath, lineNumber, `Session message ${entry.id} has an invalid turnId`);
	}
	if (
		entry.type === "message" &&
		entry.agentMessageId !== undefined &&
		(entry.message.role !== "user" ||
			typeof entry.agentMessageId !== "string" ||
			!entry.agentMessageId ||
			entry.agentMessageId.length > 256)
	)
		corruptSession(filePath, lineNumber, "Invalid agent message identity");
	seenRecordIds.add(entry.id);
	seenTreeIds.add(entry.id);
}

export function validateControlGraphEntry(
	entry: RuntimeControlEntry | SessionControlEntry,
	lineNumber: number,
	filePath: string,
	seenRecordIds: Set<string>,
	seenTreeIds: Set<string>,
): void {
	validateRecordId(entry.id, lineNumber, filePath, seenRecordIds);
	if (entry.parentId !== null && !seenTreeIds.has(entry.parentId)) {
		corruptSession(
			filePath,
			lineNumber,
			`Control entry ${entry.id} references a missing, forward, or non-tree parent: ${entry.parentId}`,
		);
	}
	seenRecordIds.add(entry.id);
}

export function validateSessionGraph(records: readonly FileEntry[], filePath: string): void {
	validateRawSessionRecords(records, filePath);
	const seenRecordIds = new Set<string>();
	const seenTreeIds = new Set<string>();
	for (let index = 1; index < records.length; index++) {
		const record = records[index];
		if (isRuntimeControlEntryType(record.type)) {
			validateControlGraphEntry(
				parseRuntimeRecord(record, index + 1, filePath),
				index + 1,
				filePath,
				seenRecordIds,
				seenTreeIds,
			);
		} else if (isSessionControlEntryType(record.type)) {
			validateControlGraphEntry(
				parseSessionControlRecord(record, index + 1, filePath),
				index + 1,
				filePath,
				seenRecordIds,
				seenTreeIds,
			);
		} else {
			validateSessionGraphEntry(record as SessionEntry, index + 1, filePath, seenRecordIds, seenTreeIds);
		}
	}
}
