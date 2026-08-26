import { isAbsolute, normalize } from "node:path";
import { isPersistedPermissionMode, type PersistedPermissionMode } from "./permission-mode.ts";
import { type CollaborationMode, MAX_PLAN_MARKDOWN_UTF8_BYTES, MAX_PLAN_TITLE_UTF16_UNITS } from "./plan-state.ts";
import type { AgentTaskStatus, AgentUsage, SubagentMailboxEvent, SubagentUsage } from "./subagents/types.ts";

interface SessionControlEntryBase {
	readonly id: string;
	readonly parentId: string | null;
	readonly timestamp: string;
}

export interface SessionPermissionsEntry extends SessionControlEntryBase {
	readonly type: "session_permissions";
	readonly permissionMode: PersistedPermissionMode;
	/** Legacy v6-v8 field. New writers omit it. */
	readonly reviewerEnabled?: boolean;
}

export type PermissionDecision = "allow" | "ask" | "deny";
export type PermissionDecisionSource = "user" | "reviewer" | "policy";

export interface SessionPermissionDecisionEntry extends SessionControlEntryBase {
	readonly type: "session_permission_decision";
	readonly actionId: string;
	readonly toolName: string;
	readonly source: PermissionDecisionSource;
	readonly decision: PermissionDecision;
	readonly reason: string;
}

export interface SessionDirectoryAddedEntry extends SessionControlEntryBase {
	readonly type: "session_directory_added";
	readonly path: string;
}

export interface SessionDirectoryRemovedEntry extends SessionControlEntryBase {
	readonly type: "session_directory_removed";
	readonly path: string;
}

export type SessionDirectoryControlEntry = SessionDirectoryAddedEntry | SessionDirectoryRemovedEntry;

export type AgentStateReason = "completed" | "error" | "interrupted" | "timeout" | "parent_unloaded" | "recovered";
export type SubagentStateReason = AgentStateReason;

export interface AgentTaskEntry extends SessionControlEntryBase {
	readonly type: "agent_task";
	readonly agentId: string;
	readonly taskId: string;
	readonly text: string;
	readonly taskSummary: string;
	readonly status: AgentTaskStatus;
	readonly reason?: AgentStateReason;
	readonly finalMessage?: string;
	readonly error?: string;
	readonly usage?: AgentUsage;
}

export interface AgentMessageEntry extends SessionControlEntryBase {
	readonly type: "agent_message";
	readonly agentId: string;
	readonly taskId: string;
	readonly messageId: string;
	readonly text: string;
	readonly state: "accepted" | "cancelled";
}

export interface AgentArchivedEntry extends SessionControlEntryBase {
	readonly type: "agent_archived";
	readonly agentId: string;
	readonly archived: boolean;
}

export type AgentControlEntry = AgentTaskEntry | AgentMessageEntry | AgentArchivedEntry;

export interface SubagentMailboxEventEntry extends SessionControlEntryBase {
	readonly type: "subagent_mailbox_event";
	readonly event: SubagentMailboxEvent;
}

export interface SubagentMailboxDeliveryEntry extends SessionControlEntryBase {
	readonly type: "subagent_mailbox_delivery";
	readonly deliveryId: string;
	readonly eventIds: readonly string[];
	readonly state: "started" | "completed";
}

export interface SubagentModeChangeEntry extends SessionControlEntryBase {
	readonly type: "subagent_mode_change";
	readonly enabled: boolean;
}

export interface SessionCollaborationModeEntry extends SessionControlEntryBase {
	readonly type: "session_collaboration_mode";
	readonly collaborationMode: CollaborationMode;
}

export interface SessionPlanProposalEntry extends SessionControlEntryBase {
	readonly type: "session_plan_proposal";
	readonly planId: string;
	readonly revision: number;
	readonly title: string;
	readonly markdown: string;
}

export interface SessionPlanStatusEntry extends SessionControlEntryBase {
	readonly type: "session_plan_status";
	readonly planId: string;
	readonly revision: number;
	readonly status: "accepted" | "cancelled";
}

export type SubagentControlEntry = SubagentMailboxEventEntry | SubagentMailboxDeliveryEntry | SubagentModeChangeEntry;

export type SessionControlEntry =
	| SessionPermissionsEntry
	| SessionPermissionDecisionEntry
	| SessionDirectoryControlEntry
	| SessionCollaborationModeEntry
	| SessionPlanProposalEntry
	| SessionPlanStatusEntry
	| AgentControlEntry
	| SubagentControlEntry;

export type SessionControlPayload = SessionControlEntry extends infer Entry
	? Entry extends SessionControlEntry
		? Omit<Entry, "id" | "parentId" | "timestamp">
		: never
	: never;

export type AgentControlPayload = AgentControlEntry extends infer Entry
	? Entry extends AgentControlEntry
		? Omit<Entry, "id" | "parentId" | "timestamp">
		: never
	: never;

export type SubagentControlPayload = SubagentControlEntry extends infer Entry
	? Entry extends SubagentControlEntry
		? Omit<Entry, "id" | "parentId" | "timestamp">
		: never
	: never;

const encoder = new TextEncoder();
const AGENT_TASK_STATUSES = new Set(["queued", "running", "done", "failed", "stopped"]);
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

function positiveSafeInteger(fields: ReadonlyMap<string, unknown>, key: string): number {
	const value = fields.get(key);
	if (!Number.isSafeInteger(value) || (value as number) < 1) invalid(`Session control entry.${key} is invalid`);
	return value as number;
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

function parseModel(value: unknown, label: string): AgentUsage["model"] {
	const fields = dataFields(value, label);
	assertOnlyFields(fields, ["provider", "modelId"], label);
	return {
		provider: requiredString(fields, "provider", { label, maxLength: 256, noControls: true }),
		modelId: requiredString(fields, "modelId", { label, maxLength: 512, noControls: true }),
	};
}

function parseUsage(value: unknown): SubagentUsage {
	const label = "Session control entry.usage";
	const fields = dataFields(value, label);
	assertOnlyFields(
		fields,
		["model", "input", "output", "cacheRead", "cacheWrite", "elapsedMs", "toolCalls", "cost"],
		label,
	);
	const toolCalls = fields.get("toolCalls");
	if (toolCalls !== undefined && (!Number.isInteger(toolCalls) || (toolCalls as number) < 0)) {
		invalid(`${label}.toolCalls must be a non-negative integer`);
	}
	return {
		model: parseModel(fields.get("model"), `${label}.model`),
		input: finiteNonNegative(fields, "input", label),
		output: finiteNonNegative(fields, "output", label),
		cacheRead: finiteNonNegative(fields, "cacheRead", label),
		cacheWrite: finiteNonNegative(fields, "cacheWrite", label),
		elapsedMs: finiteNonNegative(fields, "elapsedMs", label),
		...(toolCalls !== undefined ? { toolCalls: toolCalls as number } : {}),
		...(fields.has("cost") ? { cost: finiteNonNegative(fields, "cost", label) } : {}),
	};
}

function parseSubagentMailboxEvent(value: unknown): SubagentMailboxEvent {
	const label = "Session control entry.event";
	const fields = dataFields(value, label);
	assertOnlyFields(
		fields,
		["eventId", "runId", "agentId", "name", "type", "status", "finalMessage", "error", "completedAt"],
		label,
	);
	if (fields.get("type") !== "terminal") invalid(`${label}.type must be terminal`);
	const status = fields.get("status");
	if (status !== "done" && status !== "failed" && status !== "stopped") {
		invalid(`${label}.status is invalid`);
	}
	const completedAt = requiredString(fields, "completedAt", { label, maxLength: 64, noControls: true });
	if (!Number.isFinite(Date.parse(completedAt))) invalid(`${label}.completedAt is invalid`);
	return {
		eventId: requiredString(fields, "eventId", { label, maxLength: 512, noControls: true }),
		runId: requiredString(fields, "runId", { label, maxLength: 256, noControls: true }),
		agentId: requiredString(fields, "agentId", { label, maxLength: 256, noControls: true }),
		name: requiredString(fields, "name", { label, maxLength: 128, noControls: true }),
		type: "terminal",
		status,
		...(fields.has("finalMessage")
			? { finalMessage: optionalString(fields, "finalMessage", { label, maxBytes: 4 * 1024 }) }
			: {}),
		...(fields.has("error") ? { error: optionalString(fields, "error", { label, maxBytes: 4 * 1024 }) } : {}),
		completedAt,
	};
}

export function isAgentControlEntryType(type: unknown): type is AgentControlEntry["type"] {
	return type === "agent_task" || type === "agent_message" || type === "agent_archived";
}

export function isSubagentControlEntryType(type: unknown): type is SubagentControlEntry["type"] {
	return type === "subagent_mailbox_event" || type === "subagent_mailbox_delivery" || type === "subagent_mode_change";
}

export function isSessionDirectoryControlEntryType(type: unknown): type is SessionDirectoryControlEntry["type"] {
	return type === "session_directory_added" || type === "session_directory_removed";
}

export function isPlanControlEntryType(
	type: unknown,
): type is SessionCollaborationModeEntry["type"] | SessionPlanProposalEntry["type"] | SessionPlanStatusEntry["type"] {
	return type === "session_collaboration_mode" || type === "session_plan_proposal" || type === "session_plan_status";
}

export function isSessionControlEntryType(type: unknown): type is SessionControlEntry["type"] {
	return (
		type === "session_permissions" ||
		type === "session_permission_decision" ||
		isSessionDirectoryControlEntryType(type) ||
		isPlanControlEntryType(type) ||
		isAgentControlEntryType(type) ||
		isSubagentControlEntryType(type)
	);
}

export function parseSessionControlEntry(value: unknown): SessionControlEntry {
	const fields = dataFields(value);
	const type = requiredString(fields, "type");
	const baseFields = ["type", "id", "parentId", "timestamp"] as const;
	if (type === "session_permissions") {
		assertOnlyFields(fields, [...baseFields, "permissionMode", "reviewerEnabled"]);
		const permissionMode = fields.get("permissionMode");
		const reviewerEnabled = fields.get("reviewerEnabled");
		if (!isPersistedPermissionMode(permissionMode)) invalid("Session control entry.permissionMode is invalid");
		if (reviewerEnabled !== undefined && typeof reviewerEnabled !== "boolean") {
			invalid("Session control entry.reviewerEnabled must be a boolean");
		}
		return {
			type,
			...parseBase(fields),
			permissionMode,
			...(reviewerEnabled === undefined ? {} : { reviewerEnabled }),
		};
	}
	if (type === "session_permission_decision") {
		assertOnlyFields(fields, [...baseFields, "actionId", "toolName", "source", "decision", "reason"]);
		const source = fields.get("source");
		const decision = fields.get("decision");
		if (source !== "user" && source !== "reviewer" && source !== "policy") {
			invalid("Session control entry.source is invalid");
		}
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
	if (isSessionDirectoryControlEntryType(type)) {
		assertOnlyFields(fields, [...baseFields, "path"]);
		const path = requiredString(fields, "path", { maxBytes: 32 * 1024, noControls: true });
		if (!isAbsolute(path) || normalize(path) !== path) {
			invalid("Session control entry.path must be a canonical absolute path");
		}
		return { type, ...parseBase(fields), path };
	}
	if (type === "agent_task") {
		assertOnlyFields(fields, [
			...baseFields,
			"agentId",
			"taskId",
			"text",
			"taskSummary",
			"status",
			"reason",
			"finalMessage",
			"error",
			"usage",
		]);
		const status = fields.get("status");
		const reason = fields.get("reason");
		if (typeof status !== "string" || !AGENT_TASK_STATUSES.has(status)) {
			invalid("Session control entry.status is invalid");
		}
		if (reason !== undefined && (typeof reason !== "string" || !STATE_REASONS.has(reason))) {
			invalid("Session control entry.reason is invalid");
		}
		if (reason === "completed" && status !== "done") {
			invalid("Session control entry.reason completed requires done status");
		}
		if (reason === "error" && status !== "failed") {
			invalid("Session control entry.reason error requires failed status");
		}
		if ((reason === "interrupted" || reason === "parent_unloaded") && status !== "stopped") {
			invalid(`Session control entry.reason ${reason} requires stopped status`);
		}
		if (reason === "timeout" && status !== "failed") {
			invalid("Session control entry.reason timeout requires failed status");
		}
		if (reason === "recovered" && status !== "queued") {
			invalid("Session control entry.reason recovered requires queued status");
		}
		return {
			type,
			...parseBase(fields),
			agentId: requiredString(fields, "agentId", { maxLength: 256, noControls: true }),
			taskId: requiredString(fields, "taskId", { maxLength: 256, noControls: true }),
			text: requiredString(fields, "text", { maxBytes: 2 * 1024 * 1024 }),
			taskSummary: requiredString(fields, "taskSummary", { maxLength: 240 }),
			status: status as AgentTaskStatus,
			...(reason === undefined ? {} : { reason: reason as AgentStateReason }),
			...(fields.has("finalMessage")
				? { finalMessage: optionalString(fields, "finalMessage", { maxBytes: 4 * 1024 }) }
				: {}),
			...(fields.has("error") ? { error: optionalString(fields, "error", { maxBytes: 64 * 1024 }) } : {}),
			...(fields.has("usage") ? { usage: parseUsage(fields.get("usage")) as AgentUsage } : {}),
		};
	}
	if (type === "agent_message") {
		assertOnlyFields(fields, [...baseFields, "agentId", "taskId", "messageId", "text", "state"]);
		const state = fields.get("state");
		if (state !== "accepted" && state !== "cancelled") invalid("Session control entry.state is invalid");
		return {
			type,
			...parseBase(fields),
			agentId: requiredString(fields, "agentId", { maxLength: 256, noControls: true }),
			taskId: requiredString(fields, "taskId", { maxLength: 256, noControls: true }),
			messageId: requiredString(fields, "messageId", { maxLength: 256, noControls: true }),
			text: requiredString(fields, "text", { maxBytes: 2 * 1024 * 1024 }),
			state,
		};
	}
	if (type === "agent_archived") {
		assertOnlyFields(fields, [...baseFields, "agentId", "archived"]);
		const archived = fields.get("archived");
		if (typeof archived !== "boolean") invalid("Session control entry.archived must be a boolean");
		return {
			type,
			...parseBase(fields),
			agentId: requiredString(fields, "agentId", { maxLength: 256, noControls: true }),
			archived,
		};
	}
	if (type === "subagent_mailbox_event") {
		assertOnlyFields(fields, [...baseFields, "event"]);
		return { type, ...parseBase(fields), event: parseSubagentMailboxEvent(fields.get("event")) };
	}
	if (type === "subagent_mailbox_delivery") {
		assertOnlyFields(fields, [...baseFields, "deliveryId", "eventIds", "state"]);
		const rawEventIds = fields.get("eventIds");
		if (!Array.isArray(rawEventIds) || rawEventIds.length === 0) {
			invalid("Session control entry.eventIds must contain at least one event ID");
		}
		if (rawEventIds.length > 256) invalid("Session control entry.eventIds may contain at most 256 event IDs");
		const eventIds = rawEventIds.map((value, index) => {
			if (
				typeof value !== "string" ||
				value.length === 0 ||
				value.length > 512 ||
				/[\u0000-\u001f\u007f-\u009f]/u.test(value)
			) {
				invalid(`Session control entry.eventIds[${index}] is invalid`);
			}
			return value;
		});
		if (new Set(eventIds).size !== eventIds.length) {
			invalid("Session control entry.eventIds must not contain duplicates");
		}
		const state = fields.get("state");
		if (state !== "started" && state !== "completed") invalid("Session control entry.state is invalid");
		return {
			type,
			...parseBase(fields),
			deliveryId: requiredString(fields, "deliveryId", { maxLength: 256, noControls: true }),
			eventIds,
			state,
		};
	}
	if (type === "subagent_mode_change") {
		assertOnlyFields(fields, [...baseFields, "enabled"]);
		const enabled = fields.get("enabled");
		if (typeof enabled !== "boolean") invalid("Session control entry.enabled must be a boolean");
		return { type, ...parseBase(fields), enabled };
	}
	if (type === "session_collaboration_mode") {
		assertOnlyFields(fields, [...baseFields, "collaborationMode"]);
		const collaborationMode = fields.get("collaborationMode");
		if (collaborationMode !== "default" && collaborationMode !== "plan") {
			invalid("Session control entry.collaborationMode is invalid");
		}
		return { type, ...parseBase(fields), collaborationMode };
	}
	if (type === "session_plan_proposal") {
		assertOnlyFields(fields, [...baseFields, "planId", "revision", "title", "markdown"]);
		return {
			type,
			...parseBase(fields),
			planId: requiredString(fields, "planId", { maxLength: 128, noControls: true }),
			revision: positiveSafeInteger(fields, "revision"),
			title: requiredString(fields, "title", { maxLength: MAX_PLAN_TITLE_UTF16_UNITS, noControls: true }),
			markdown: requiredString(fields, "markdown", { maxBytes: MAX_PLAN_MARKDOWN_UTF8_BYTES }),
		};
	}
	if (type === "session_plan_status") {
		assertOnlyFields(fields, [...baseFields, "planId", "revision", "status"]);
		const status = fields.get("status");
		if (status !== "accepted" && status !== "cancelled") invalid("Session control entry.status is invalid");
		return {
			type,
			...parseBase(fields),
			planId: requiredString(fields, "planId", { maxLength: 128, noControls: true }),
			revision: positiveSafeInteger(fields, "revision"),
			status,
		};
	}
	invalid(`Unknown session control entry type: ${type}`);
}
