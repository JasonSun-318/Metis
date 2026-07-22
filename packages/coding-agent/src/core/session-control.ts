import { isAbsolute, normalize } from "node:path";
import { isPathInside } from "../utils/paths.ts";
import { isAgentMode } from "./agent-mode.ts";
import { isPermissionMode, type PermissionMode } from "./permission-mode.ts";
import type { SubagentConfig, SubagentStatus, SubagentTombstone, SubagentUsage } from "./subagents/types.ts";

interface SessionControlEntryBase {
	readonly id: string;
	readonly parentId: string | null;
	readonly timestamp: string;
}

export interface SessionPermissionsEntry extends SessionControlEntryBase {
	readonly type: "session_permissions";
	readonly permissionMode: PermissionMode;
	readonly reviewerEnabled: boolean;
}

export type PermissionDecision = "allow" | "ask" | "deny";
export type PermissionDecisionSource = "user" | "reviewer";

export interface SessionPermissionDecisionEntry extends SessionControlEntryBase {
	readonly type: "session_permission_decision";
	readonly actionId: string;
	readonly toolName: string;
	readonly source: PermissionDecisionSource;
	readonly decision: PermissionDecision;
	readonly reason: string;
}

export interface SubagentCreatedEntry extends SessionControlEntryBase {
	readonly type: "subagent_created";
	readonly config: SubagentConfig;
}

export type SubagentStateReason = "completed" | "error" | "interrupted" | "timeout" | "parent_unloaded" | "recovered";

export interface SubagentStateEntry extends SessionControlEntryBase {
	readonly type: "subagent_state";
	readonly agentId: string;
	readonly runId: string;
	readonly status: Exclude<SubagentStatus, "closed">;
	readonly reason?: SubagentStateReason;
	readonly finalSummary?: string;
	readonly error?: string;
	readonly residualPath?: string;
	readonly usage?: SubagentUsage;
}

export interface SubagentFollowUpEntry extends SessionControlEntryBase {
	readonly type: "subagent_follow_up";
	readonly agentId: string;
	readonly runId: string;
	readonly messageId: string;
	readonly text: string;
	readonly state: "queued" | "accepted" | "cancelled";
}

export interface SubagentClosedEntry extends SessionControlEntryBase {
	readonly type: "subagent_closed";
	readonly tombstone: SubagentTombstone;
}

export interface SubagentModeChangeEntry extends SessionControlEntryBase {
	readonly type: "subagent_mode_change";
	readonly enabled: boolean;
}

export type SubagentControlEntry =
	| SubagentCreatedEntry
	| SubagentStateEntry
	| SubagentFollowUpEntry
	| SubagentClosedEntry
	| SubagentModeChangeEntry;

export type SessionControlEntry = SessionPermissionsEntry | SessionPermissionDecisionEntry | SubagentControlEntry;

export type SessionControlPayload = SessionControlEntry extends infer Entry
	? Entry extends SessionControlEntry
		? Omit<Entry, "id" | "parentId" | "timestamp">
		: never
	: never;

export type SubagentControlPayload = SubagentControlEntry extends infer Entry
	? Entry extends SubagentControlEntry
		? Omit<Entry, "id" | "parentId" | "timestamp">
		: never
	: never;

const encoder = new TextEncoder();
const REAL_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const SUBAGENT_STATUSES = new Set(["queued", "running", "done", "failed", "stopped", "close_failed"]);
const STATE_REASONS = new Set(["completed", "error", "interrupted", "timeout", "parent_unloaded", "recovered"]);

function invalid(message: string): never {
	throw new TypeError(message);
}

function dataFields(value: unknown, label = "Session control entry"): Map<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) invalid(`${label} must be an object`);
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) invalid(`${label} must be a plain object`);

	const fields = new Map<string, unknown>();
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") invalid(`${label} must not contain symbol fields`);
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
			invalid(`${label} must contain only enumerable data properties`);
		}
		fields.set(key, descriptor.value);
	}
	return fields;
}

function assertOnlyFields(
	fields: ReadonlyMap<string, unknown>,
	allowed: readonly string[],
	label = "Session control entry",
): void {
	const allowedFields = new Set(allowed);
	const unknown = [...fields.keys()].filter((key) => !allowedFields.has(key)).sort()[0];
	if (unknown) invalid(`${label} has unknown field: ${unknown}`);
}

function requiredString(
	fields: ReadonlyMap<string, unknown>,
	key: string,
	options: { label?: string; maxBytes?: number; maxLength?: number; noControls?: boolean } = {},
): string {
	const label = options.label ?? "Session control entry";
	const value = fields.get(key);
	if (typeof value !== "string" || value.length === 0) invalid(`${label}.${key} must be a non-empty string`);
	if (options.maxLength !== undefined && value.length > options.maxLength) invalid(`${label}.${key} is too long`);
	if (options.maxBytes !== undefined && encoder.encode(value).byteLength > options.maxBytes)
		invalid(`${label}.${key} is too large`);
	if (options.noControls && /[\u0000-\u001f\u007f-\u009f]/u.test(value))
		invalid(`${label}.${key} contains control characters`);
	return value;
}

function optionalString(
	fields: ReadonlyMap<string, unknown>,
	key: string,
	options: { label?: string; maxBytes?: number } = {},
): string | undefined {
	if (!fields.has(key)) return undefined;
	return requiredString(fields, key, options);
}

function finiteNonNegative(fields: ReadonlyMap<string, unknown>, key: string, label: string): number {
	const value = fields.get(key);
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0)
		invalid(`${label}.${key} must be finite and non-negative`);
	return value;
}

function parseBase(fields: ReadonlyMap<string, unknown>): SessionControlEntryBase {
	const parentId = fields.get("parentId");
	if (parentId !== null && (typeof parentId !== "string" || parentId.length === 0)) {
		invalid("Session control entry.parentId must be null or a non-empty string");
	}
	return {
		id: requiredString(fields, "id"),
		parentId,
		timestamp: requiredString(fields, "timestamp"),
	};
}

function parseModel(value: unknown, label: string): SubagentConfig["model"] {
	const fields = dataFields(value, label);
	assertOnlyFields(fields, ["provider", "modelId"], label);
	return {
		provider: requiredString(fields, "provider", { label, maxLength: 256, noControls: true }),
		modelId: requiredString(fields, "modelId", { label, maxLength: 512, noControls: true }),
	};
}

function parseTools(value: unknown, label: string): readonly string[] {
	if (!Array.isArray(value) || value.length > 128) invalid(`${label} must be an array of at most 128 tool names`);
	const tools = value.map((tool) => {
		if (
			typeof tool !== "string" ||
			tool.length === 0 ||
			tool.length > 256 ||
			/[\u0000-\u001f\u007f-\u009f]/u.test(tool)
		) {
			invalid(`${label} contains an invalid tool name`);
		}
		return tool;
	});
	if (new Set(tools).size !== tools.length) invalid(`${label} must contain unique tool names`);
	return tools;
}

function parsePaths(value: unknown, label: string): readonly string[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
		invalid(`${label} must be a non-empty array of at most 32 paths`);
	}
	const paths = value.map((path) => {
		if (
			typeof path !== "string" ||
			path.length === 0 ||
			encoder.encode(path).byteLength > 32 * 1024 ||
			!isAbsolute(path) ||
			normalize(path) !== path
		) {
			invalid(`${label} contains an invalid path`);
		}
		return path;
	});
	if (new Set(paths).size !== paths.length) invalid(`${label} must contain unique paths`);
	return paths;
}

function parseForkTurns(value: unknown, label: string): SubagentConfig["forkTurns"] {
	if (value === "all") return value;
	if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > 1_000) {
		invalid(`${label} must be "all" or an integer from 0 through 1000`);
	}
	return value as number;
}

function parseConfig(value: unknown): SubagentConfig {
	const label = "Session control entry.config";
	const fields = dataFields(value, label);
	assertOnlyFields(
		fields,
		[
			"agentId",
			"name",
			"task",
			"taskSummary",
			"mode",
			"tools",
			"permissionMode",
			"reviewerEnabled",
			"model",
			"thinkingLevel",
			"cwd",
			"readPaths",
			"writePaths",
			"forkTurns",
			"timeoutSeconds",
			"role",
			"developerInstructions",
		],
		label,
	);
	const mode = fields.get("mode");
	const permissionMode = fields.get("permissionMode");
	const reviewerEnabled = fields.get("reviewerEnabled");
	const thinkingLevel = fields.get("thinkingLevel");
	const timeoutSeconds = fields.get("timeoutSeconds");
	if (!isAgentMode(mode)) invalid(`${label}.mode is invalid`);
	if (!isPermissionMode(permissionMode)) invalid(`${label}.permissionMode is invalid`);
	if (typeof reviewerEnabled !== "boolean") invalid(`${label}.reviewerEnabled must be a boolean`);
	if (typeof thinkingLevel !== "string" || !REAL_THINKING_LEVELS.has(thinkingLevel))
		invalid(`${label}.thinkingLevel is invalid`);
	if (!Number.isInteger(timeoutSeconds) || (timeoutSeconds as number) < 1 || (timeoutSeconds as number) > 1_800) {
		invalid(`${label}.timeoutSeconds must be an integer from 1 through 1800`);
	}
	const cwd = requiredString(fields, "cwd", { label, maxBytes: 32 * 1024 });
	if (!isAbsolute(cwd) || normalize(cwd) !== cwd) invalid(`${label}.cwd must be a canonical absolute path`);
	const readPaths = fields.has("readPaths") ? parsePaths(fields.get("readPaths"), `${label}.readPaths`) : [cwd];
	const writePaths = fields.has("writePaths") ? parsePaths(fields.get("writePaths"), `${label}.writePaths`) : [cwd];
	if (writePaths.some((writePath) => !readPaths.some((readPath) => isPathInside(readPath, writePath)))) {
		invalid(`${label}.writePaths must stay inside readPaths`);
	}
	return {
		agentId: requiredString(fields, "agentId", { label, maxLength: 256, noControls: true }),
		name: requiredString(fields, "name", { label, maxLength: 128, noControls: true }),
		task: requiredString(fields, "task", { label, maxBytes: 2 * 1024 * 1024 }),
		taskSummary: requiredString(fields, "taskSummary", { label, maxLength: 240 }),
		mode,
		tools: parseTools(fields.get("tools"), `${label}.tools`),
		permissionMode,
		reviewerEnabled,
		model: parseModel(fields.get("model"), `${label}.model`),
		thinkingLevel: thinkingLevel as SubagentConfig["thinkingLevel"],
		cwd,
		// Compatibility for v7 sessions created by the first implementation.
		readPaths,
		writePaths,
		forkTurns: parseForkTurns(fields.get("forkTurns"), `${label}.forkTurns`),
		timeoutSeconds: timeoutSeconds as number,
		role: optionalString(fields, "role", { label, maxBytes: 8 * 1024 }),
		developerInstructions: optionalString(fields, "developerInstructions", { label, maxBytes: 64 * 1024 }),
	};
}

function parseUsage(value: unknown): SubagentUsage {
	const label = "Session control entry.usage";
	const fields = dataFields(value, label);
	assertOnlyFields(fields, ["model", "input", "output", "cacheRead", "cacheWrite", "elapsedMs", "cost"], label);
	return {
		model: parseModel(fields.get("model"), `${label}.model`),
		input: finiteNonNegative(fields, "input", label),
		output: finiteNonNegative(fields, "output", label),
		cacheRead: finiteNonNegative(fields, "cacheRead", label),
		cacheWrite: finiteNonNegative(fields, "cacheWrite", label),
		elapsedMs: finiteNonNegative(fields, "elapsedMs", label),
		...(fields.has("cost") ? { cost: finiteNonNegative(fields, "cost", label) } : {}),
	};
}

function parseTombstone(value: unknown): SubagentTombstone {
	const label = "Session control entry.tombstone";
	const fields = dataFields(value, label);
	assertOnlyFields(fields, ["agentId", "name", "status", "taskSummary", "finalSummary", "closedAt"], label);
	if (fields.get("status") !== "closed") invalid(`${label}.status must be closed`);
	return {
		agentId: requiredString(fields, "agentId", { label, maxLength: 256, noControls: true }),
		name: requiredString(fields, "name", { label, maxLength: 128, noControls: true }),
		status: "closed",
		taskSummary: requiredString(fields, "taskSummary", { label, maxLength: 240 }),
		finalSummary: optionalString(fields, "finalSummary", { label, maxBytes: 4 * 1024 }),
		closedAt: requiredString(fields, "closedAt", { label }),
	};
}

export function isSubagentControlEntryType(type: unknown): type is SubagentControlEntry["type"] {
	return (
		type === "subagent_created" ||
		type === "subagent_state" ||
		type === "subagent_follow_up" ||
		type === "subagent_closed" ||
		type === "subagent_mode_change"
	);
}

export function isSessionControlEntryType(type: unknown): type is SessionControlEntry["type"] {
	return type === "session_permissions" || type === "session_permission_decision" || isSubagentControlEntryType(type);
}

export function parseSessionControlEntry(value: unknown): SessionControlEntry {
	const fields = dataFields(value);
	const type = requiredString(fields, "type");
	const baseFields = ["type", "id", "parentId", "timestamp"] as const;
	if (type === "session_permissions") {
		assertOnlyFields(fields, [...baseFields, "permissionMode", "reviewerEnabled"]);
		const permissionMode = fields.get("permissionMode");
		const reviewerEnabled = fields.get("reviewerEnabled");
		if (!isPermissionMode(permissionMode)) invalid("Session control entry.permissionMode is invalid");
		if (typeof reviewerEnabled !== "boolean") invalid("Session control entry.reviewerEnabled must be a boolean");
		return { type, ...parseBase(fields), permissionMode, reviewerEnabled };
	}
	if (type === "session_permission_decision") {
		assertOnlyFields(fields, [...baseFields, "actionId", "toolName", "source", "decision", "reason"]);
		const source = fields.get("source");
		const decision = fields.get("decision");
		if (source !== "user" && source !== "reviewer") invalid("Session control entry.source is invalid");
		if (decision !== "allow" && decision !== "ask" && decision !== "deny")
			invalid("Session control entry.decision is invalid");
		return {
			type,
			...parseBase(fields),
			actionId: requiredString(fields, "actionId"),
			toolName: requiredString(fields, "toolName"),
			source,
			decision,
			reason: requiredString(fields, "reason"),
		};
	}
	if (type === "subagent_created") {
		assertOnlyFields(fields, [...baseFields, "config"]);
		return { type, ...parseBase(fields), config: parseConfig(fields.get("config")) };
	}
	if (type === "subagent_state") {
		assertOnlyFields(fields, [
			...baseFields,
			"agentId",
			"runId",
			"status",
			"reason",
			"finalSummary",
			"error",
			"residualPath",
			"usage",
		]);
		const status = fields.get("status");
		const reason = fields.get("reason");
		if (typeof status !== "string" || !SUBAGENT_STATUSES.has(status))
			invalid("Session control entry.status is invalid");
		if (reason !== undefined && (typeof reason !== "string" || !STATE_REASONS.has(reason)))
			invalid("Session control entry.reason is invalid");
		if (reason === "completed" && status !== "done")
			invalid("Session control entry.reason completed requires done status");
		if (reason === "error" && status !== "failed" && status !== "close_failed")
			invalid("Session control entry.reason error requires failed status");
		if ((reason === "interrupted" || reason === "parent_unloaded") && status !== "stopped")
			invalid(`Session control entry.reason ${reason} requires stopped status`);
		if (reason === "timeout" && status !== "failed")
			invalid("Session control entry.reason timeout requires failed status");
		if (reason === "recovered" && status !== "queued")
			invalid("Session control entry.reason recovered requires queued status");
		const base = parseBase(fields);
		return {
			type,
			...base,
			agentId: requiredString(fields, "agentId", { maxLength: 256, noControls: true }),
			runId: fields.has("runId")
				? requiredString(fields, "runId", { maxLength: 256, noControls: true })
				: `legacy-${base.id}`,
			status: status as Exclude<SubagentStatus, "closed">,
			...(reason === undefined ? {} : { reason: reason as SubagentStateReason }),
			...(fields.has("finalSummary")
				? { finalSummary: optionalString(fields, "finalSummary", { maxBytes: 4 * 1024 }) }
				: {}),
			...(fields.has("error") ? { error: optionalString(fields, "error", { maxBytes: 64 * 1024 }) } : {}),
			...(fields.has("residualPath")
				? { residualPath: optionalString(fields, "residualPath", { maxBytes: 32 * 1024 }) }
				: {}),
			...(fields.has("usage") ? { usage: parseUsage(fields.get("usage")) } : {}),
		};
	}
	if (type === "subagent_follow_up") {
		assertOnlyFields(fields, [...baseFields, "agentId", "runId", "messageId", "text", "state"]);
		const state = fields.get("state");
		if (state !== "queued" && state !== "accepted" && state !== "cancelled")
			invalid("Session control entry.state is invalid");
		const base = parseBase(fields);
		return {
			type,
			...base,
			agentId: requiredString(fields, "agentId", { maxLength: 256, noControls: true }),
			runId: fields.has("runId")
				? requiredString(fields, "runId", { maxLength: 256, noControls: true })
				: `legacy-${base.id}`,
			messageId: requiredString(fields, "messageId", { maxLength: 256, noControls: true }),
			text: requiredString(fields, "text", { maxBytes: 2 * 1024 * 1024 }),
			state,
		};
	}
	if (type === "subagent_closed") {
		assertOnlyFields(fields, [...baseFields, "tombstone"]);
		return { type, ...parseBase(fields), tombstone: parseTombstone(fields.get("tombstone")) };
	}
	if (type === "subagent_mode_change") {
		assertOnlyFields(fields, [...baseFields, "enabled"]);
		const enabled = fields.get("enabled");
		if (typeof enabled !== "boolean") invalid("Session control entry.enabled must be a boolean");
		return { type, ...parseBase(fields), enabled };
	}
	invalid(`Unknown session control entry type: ${type}`);
}
