import { isAbsolute, normalize } from "node:path";
import { dataFields } from "./data-fields.ts";
import { isPermissionManualReason, type PermissionManualReason } from "./permissions/reviewer.ts";
import { isPermissionPreset, type PermissionPreset } from "./permissions/settings.ts";
import { type CollaborationMode, MAX_PLAN_MARKDOWN_UTF8_BYTES, MAX_PLAN_TITLE_UTF16_UNITS } from "./plan-state.ts";
import { type DurablePromptInput, parseDurablePromptSubmission } from "./runtime-recovery.ts";
import { type AgentRoleSnapshot, parseAgentRoleSnapshot } from "./subagents/agent-type-registry.ts";
import type {
	AgentMailboxEvent,
	AgentMessageOrigin,
	AgentMessageReceipt,
	AgentRunControl,
	AgentTaskStatus,
	AgentUsage,
} from "./subagents/types.ts";

interface SessionControlEntryBase {
	readonly id: string;
	readonly parentId: string | null;
	readonly timestamp: string;
}

export interface SessionPermissionPresetEntry extends SessionControlEntryBase {
	readonly type: "session_permission_preset";
	readonly permissionPreset: PermissionPreset;
}

export type PermissionDecision = "allow" | "ask" | "deny";
export type PermissionDecisionSource = "user" | "reviewer" | "policy" | "rule" | "model" | "full";

export interface SessionPermissionAuditEntry extends SessionControlEntryBase {
	readonly type: "session_permission_audit";
	readonly actionId: string;
	readonly toolName: string;
	readonly source: PermissionDecisionSource;
	readonly decision: PermissionDecision;
	readonly reason: string;
	readonly ruleIds?: readonly string[];
	readonly matchedRule?: { readonly id: string; readonly name: string; readonly scope: string };
	readonly manualReason?: PermissionManualReason;
	readonly remember?: "session" | "project";
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

export interface AgentTaskEntry extends SessionControlEntryBase {
	readonly instructionRevision?: number;
	readonly consumedInstructionRevision?: number;
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

export interface AgentPermissionCeilingEntry extends SessionControlEntryBase {
	readonly type: "agent_permission_ceiling";
	readonly agentId: string;
	readonly permissionPreset: PermissionPreset;
}

export interface AgentMailboxEventEntry extends SessionControlEntryBase {
	readonly type: "agent_mailbox_event";
	readonly event: AgentMailboxEvent;
}

export interface AgentMailboxDeliveryEntry extends SessionControlEntryBase {
	readonly type: "agent_mailbox_delivery";
	readonly deliveryId: string;
	readonly eventIds: readonly string[];
	readonly state: "started" | "completed";
}

export interface AgentInputEntry extends SessionControlEntryBase, AgentMessageReceipt {
	readonly type: "agent_input";
	readonly input: DurablePromptInput;
	readonly origin: AgentMessageOrigin;
	readonly requestHash: string;
	readonly error?: string;
}
export interface AgentRunControlEntry extends SessionControlEntryBase, AgentRunControl {
	readonly type: "agent_run_control";
	readonly agentId: string;
	readonly action: "stop" | "resume";
	readonly origin: AgentMessageOrigin;
}
export interface AgentRoleSnapshotEntry extends SessionControlEntryBase {
	readonly type: "agent_role_snapshot";
	readonly agentId: string;
	readonly roleSnapshot: AgentRoleSnapshot;
}
export type AgentControlEntry =
	| AgentInputEntry
	| AgentRunControlEntry
	| AgentRoleSnapshotEntry
	| AgentTaskEntry
	| AgentMessageEntry
	| AgentArchivedEntry
	| AgentPermissionCeilingEntry
	| AgentMailboxEventEntry
	| AgentMailboxDeliveryEntry;

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

export type SessionControlEntry =
	| SessionPermissionPresetEntry
	| SessionPermissionAuditEntry
	| SessionDirectoryControlEntry
	| SessionCollaborationModeEntry
	| SessionPlanProposalEntry
	| SessionPlanStatusEntry
	| AgentControlEntry;

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

const encoder = new TextEncoder();
const AGENT_TASK_STATUSES = new Set(["queued", "running", "done", "failed", "stopped"]);
const STATE_REASONS = new Set(["completed", "error", "interrupted", "timeout", "parent_unloaded", "recovered"]);

function invalid(message: string): never {
	throw new TypeError(message);
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

function parseUsage(value: unknown): AgentUsage {
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

function parseAgentMailboxEvent(value: unknown): AgentMailboxEvent {
	const label = "Session control entry.event";
	const fields = dataFields(value, label);
	const common = ["eventId", "taskId", "agentId", "parentSessionId", "name", "type", "completedAt"];
	const kind = fields.get("type");
	if (kind === "intervention" || kind === "run_control") {
		assertOnlyFields(
			fields,
			[
				...common,
				...(kind === "intervention"
					? ["messageId", "instructionRevision", "delivery", "state", "text", "imageCount"]
					: ["action", "state", "scope"]),
			],
			label,
		);
		const base = {
			eventId: requiredString(fields, "eventId", { maxLength: 512, noControls: true }),
			taskId: requiredString(fields, "taskId", { maxLength: 256, noControls: true }),
			agentId: requiredString(fields, "agentId", { maxLength: 256, noControls: true }),
			parentSessionId: requiredString(fields, "parentSessionId", { maxLength: 256, noControls: true }),
			name: requiredString(fields, "name", { maxLength: 128, noControls: true }),
			completedAt: requiredString(fields, "completedAt", { maxLength: 64, noControls: true }),
		};
		if (!Number.isFinite(Date.parse(base.completedAt))) invalid("Invalid agent event timestamp");
		if (kind === "run_control") {
			const action = fields.get("action");
			const state = fields.get("state");
			const scope = fields.get("scope");
			if (action !== "stop" && action !== "resume") invalid("Invalid run control action");
			if (state !== "enabled" && state !== "user_paused" && state !== "interrupted")
				invalid("Invalid run control state");
			if (scope !== "self" && scope !== "subtree") invalid("Invalid run control scope");
			return { ...base, type: kind, action, state, scope };
		}
		const delivery = parseDelivery(fields.get("delivery"));
		const state = parseDeliveryState(fields.get("state"));
		return {
			...base,
			type: kind,
			messageId: requiredString(fields, "messageId", { maxLength: 256, noControls: true }),
			instructionRevision: positiveSafeInteger(fields, "instructionRevision"),
			delivery,
			state,
			text: requiredString(fields, "text", { maxBytes: 4096 }),
			...(fields.has("imageCount") ? { imageCount: nonNegativeSafeInteger(fields, "imageCount") } : {}),
		};
	}
	assertOnlyFields(
		fields,
		[...common, "status", "finalMessage", "error", "instructionRevision", "consumedInstructionRevision"],
		label,
	);
	if (kind !== "terminal") invalid(`${label}.type must be terminal, intervention or run_control`);
	const status = fields.get("status");
	if (status !== "done" && status !== "failed" && status !== "stopped") {
		invalid(`${label}.status is invalid`);
	}
	const completedAt = requiredString(fields, "completedAt", { label, maxLength: 64, noControls: true });
	if (!Number.isFinite(Date.parse(completedAt))) invalid(`${label}.completedAt is invalid`);
	return {
		eventId: requiredString(fields, "eventId", { label, maxLength: 512, noControls: true }),
		taskId: requiredString(fields, "taskId", { label, maxLength: 256, noControls: true }),
		agentId: requiredString(fields, "agentId", { label, maxLength: 256, noControls: true }),
		parentSessionId: requiredString(fields, "parentSessionId", { label, maxLength: 256, noControls: true }),
		name: requiredString(fields, "name", { label, maxLength: 128, noControls: true }),
		type: "terminal",
		status,
		...parseInstructionRevisions(fields),
		...(fields.has("finalMessage")
			? { finalMessage: optionalString(fields, "finalMessage", { label, maxBytes: 4 * 1024 }) }
			: {}),
		...(fields.has("error") ? { error: optionalString(fields, "error", { label, maxBytes: 4 * 1024 }) } : {}),
		completedAt,
	};
}

export function isAgentControlEntryType(type: unknown): type is AgentControlEntry["type"] {
	return (
		type === "agent_input" ||
		type === "agent_run_control" ||
		type === "agent_role_snapshot" ||
		type === "agent_task" ||
		type === "agent_message" ||
		type === "agent_archived" ||
		type === "agent_permission_ceiling" ||
		type === "agent_mailbox_event" ||
		type === "agent_mailbox_delivery"
	);
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
		type === "session_permission_preset" ||
		type === "session_permission_audit" ||
		isSessionDirectoryControlEntryType(type) ||
		isPlanControlEntryType(type) ||
		isAgentControlEntryType(type)
	);
}

function nonNegativeSafeInteger(fields: ReadonlyMap<string, unknown>, key: string): number {
	const value = fields.get(key);
	if (!Number.isSafeInteger(value) || (value as number) < 0) invalid(`Session control entry.${key} is invalid`);
	return value as number;
}
function parseInstructionRevisions(fields: ReadonlyMap<string, unknown>): {
	instructionRevision?: number;
	consumedInstructionRevision?: number;
} {
	const instructionRevision = fields.has("instructionRevision")
		? nonNegativeSafeInteger(fields, "instructionRevision")
		: undefined;
	const consumedInstructionRevision = fields.has("consumedInstructionRevision")
		? nonNegativeSafeInteger(fields, "consumedInstructionRevision")
		: undefined;
	if (
		consumedInstructionRevision !== undefined &&
		(instructionRevision === undefined || consumedInstructionRevision > instructionRevision)
	)
		invalid("Consumed instruction revision exceeds accepted revision");
	return {
		...(instructionRevision === undefined ? {} : { instructionRevision }),
		...(consumedInstructionRevision === undefined ? {} : { consumedInstructionRevision }),
	};
}
function parseDelivery(value: unknown): AgentMessageReceipt["delivery"] {
	if (value !== "steer" && value !== "start" && value !== "queue") invalid("Invalid agent delivery");
	return value;
}
function parseDeliveryState(value: unknown): AgentMessageReceipt["state"] {
	if (
		value !== "accepted" &&
		value !== "queued" &&
		value !== "delivered" &&
		value !== "cancelled" &&
		value !== "failed"
	)
		invalid("Invalid agent delivery state");
	return value;
}
function parseOrigin(value: unknown): AgentMessageOrigin {
	const fields = dataFields(value, "Agent message origin");
	const kind = fields.get("kind");
	if (kind === "user") {
		assertOnlyFields(fields, ["kind"]);
		return { kind };
	}
	if (kind === "agent") {
		assertOnlyFields(fields, ["kind", "sessionId", "sourceItemId"]);
		return {
			kind,
			sessionId: requiredString(fields, "sessionId", { maxLength: 256, noControls: true }),
			...(fields.has("sourceItemId")
				? { sourceItemId: requiredString(fields, "sourceItemId", { maxLength: 256, noControls: true }) }
				: {}),
		};
	}
	if (kind === "system") {
		assertOnlyFields(fields, ["kind", "eventId"]);
		return { kind, eventId: requiredString(fields, "eventId", { maxLength: 512, noControls: true }) };
	}
	invalid("Invalid agent message origin");
}

export function parseSessionControlEntry(value: unknown): SessionControlEntry {
	const fields = dataFields(value);
	const type = requiredString(fields, "type");
	const baseFields = ["type", "id", "parentId", "timestamp"] as const;
	if (type === "session_permission_preset") {
		assertOnlyFields(fields, [...baseFields, "permissionPreset"]);
		const permissionPreset = fields.get("permissionPreset");
		if (!isPermissionPreset(permissionPreset)) invalid("Session control entry.permissionPreset is invalid");
		return {
			type,
			...parseBase(fields),
			permissionPreset,
		};
	}
	if (type === "session_permission_audit") {
		assertOnlyFields(fields, [
			...baseFields,
			"actionId",
			"toolName",
			"source",
			"decision",
			"reason",
			"ruleIds",
			"matchedRule",
			"manualReason",
			"remember",
		]);
		const source = fields.get("source");
		const decision = fields.get("decision");
		if (
			source !== "user" &&
			source !== "reviewer" &&
			source !== "policy" &&
			source !== "rule" &&
			source !== "model" &&
			source !== "full"
		) {
			invalid("Session control entry.source is invalid");
		}
		if (decision !== "allow" && decision !== "ask" && decision !== "deny")
			invalid("Session control entry.decision is invalid");
		const rawRuleIds = fields.get("ruleIds");
		if (rawRuleIds !== undefined && (!Array.isArray(rawRuleIds) || rawRuleIds.length > 115)) {
			invalid("Session control entry.ruleIds is invalid");
		}
		const ruleIds = rawRuleIds?.map((value) => {
			if (typeof value !== "string" || !value || encoder.encode(value).byteLength > 128) {
				invalid("Session control entry.ruleIds is invalid");
			}
			return value;
		});
		let matchedRule: { readonly id: string; readonly name: string; readonly scope: string } | undefined;
		if (fields.has("matchedRule")) {
			const value = fields.get("matchedRule");
			if (typeof value !== "object" || value === null || Array.isArray(value)) {
				invalid("Session control entry.matchedRule is invalid");
			}
			const rule = dataFields(value, "Session control entry.matchedRule");
			assertOnlyFields(rule, ["id", "name", "scope"], "Session control entry.matchedRule");
			matchedRule = Object.freeze({
				id: requiredString(rule, "id", {
					label: "Session control entry.matchedRule",
					maxBytes: 128,
					noControls: true,
				}),
				name: requiredString(rule, "name", {
					label: "Session control entry.matchedRule",
					maxBytes: 256,
					noControls: true,
				}),
				scope: requiredString(rule, "scope", {
					label: "Session control entry.matchedRule",
					maxBytes: 256,
					noControls: true,
				}),
			});
		}
		const remember = fields.get("remember");
		if (remember !== undefined && remember !== "session" && remember !== "project")
			invalid("Session control entry.remember is invalid");
		const manualReason = fields.get("manualReason");
		if (manualReason !== undefined && !isPermissionManualReason(manualReason)) {
			invalid("Session control entry.manualReason is invalid");
		}
		return {
			type,
			...parseBase(fields),
			actionId: requiredString(fields, "actionId"),
			toolName: requiredString(fields, "toolName"),
			source,
			decision,
			reason: requiredString(fields, "reason"),
			...(ruleIds === undefined ? {} : { ruleIds: Object.freeze(ruleIds) }),
			...(matchedRule === undefined ? {} : { matchedRule }),
			...(manualReason === undefined ? {} : { manualReason }),
			...(remember === undefined ? {} : { remember }),
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
	if (type === "agent_input") {
		assertOnlyFields(fields, [
			...baseFields,
			"agentId",
			"taskId",
			"messageId",
			"requestId",
			"delivery",
			"state",
			"instructionRevision",
			"input",
			"origin",
			"requestHash",
			"error",
		]);
		const requestId = requiredString(fields, "requestId", { maxLength: 256, noControls: true });
		const requestHash = requiredString(fields, "requestHash", { maxLength: 64 });
		if (!/^[a-f0-9]{64}$/.test(requestHash)) invalid("Invalid agent request hash");
		const rawInput = dataFields(fields.get("input"), "Agent input");
		const input = parseDurablePromptSubmission({ requestId, ...Object.fromEntries(rawInput) }).input;
		return {
			type,
			...parseBase(fields),
			agentId: requiredString(fields, "agentId", { maxLength: 256, noControls: true }),
			taskId: requiredString(fields, "taskId", { maxLength: 256, noControls: true }),
			messageId: requiredString(fields, "messageId", { maxLength: 256, noControls: true }),
			requestId,
			delivery: parseDelivery(fields.get("delivery")),
			state: parseDeliveryState(fields.get("state")),
			instructionRevision: positiveSafeInteger(fields, "instructionRevision"),
			input,
			origin: parseOrigin(fields.get("origin")),
			requestHash,
			...(fields.has("error") ? { error: requiredString(fields, "error", { maxBytes: 4096 }) } : {}),
		};
	}
	if (type === "agent_run_control") {
		assertOnlyFields(fields, [...baseFields, "agentId", "action", "state", "scope", "requestId", "origin"]);
		const action = fields.get("action");
		const state = fields.get("state");
		const scope = fields.get("scope");
		if (action !== "stop" && action !== "resume") invalid("Invalid run control action");
		if (state !== "enabled" && state !== "user_paused" && state !== "interrupted")
			invalid("Invalid run control state");
		if (scope !== "self" && scope !== "subtree") invalid("Invalid run control scope");
		return {
			type,
			...parseBase(fields),
			agentId: requiredString(fields, "agentId", { maxLength: 256, noControls: true }),
			action,
			state,
			scope,
			requestId: requiredString(fields, "requestId", { maxLength: 256, noControls: true }),
			origin: parseOrigin(fields.get("origin")),
		};
	}
	if (type === "agent_role_snapshot") {
		assertOnlyFields(fields, [...baseFields, "agentId", "roleSnapshot"]);
		return {
			type,
			...parseBase(fields),
			agentId: requiredString(fields, "agentId", { maxLength: 256, noControls: true }),
			roleSnapshot: parseAgentRoleSnapshot(fields.get("roleSnapshot")),
		};
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
			"instructionRevision",
			"consumedInstructionRevision",
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
			text: requiredString(fields, "text", { maxBytes: 64 * 1024 }),
			taskSummary: requiredString(fields, "taskSummary", { maxLength: 240 }),
			status: status as AgentTaskStatus,
			...parseInstructionRevisions(fields),
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
			text: requiredString(fields, "text", { maxBytes: 64 * 1024 }),
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
	if (type === "agent_permission_ceiling") {
		assertOnlyFields(fields, [...baseFields, "agentId", "permissionPreset"]);
		const permissionPreset = fields.get("permissionPreset");
		if (!isPermissionPreset(permissionPreset)) invalid("Session control entry.permissionPreset is invalid");
		return {
			type,
			...parseBase(fields),
			agentId: requiredString(fields, "agentId", { maxLength: 256, noControls: true }),
			permissionPreset,
		};
	}
	if (type === "agent_mailbox_event") {
		assertOnlyFields(fields, [...baseFields, "event"]);
		return { type, ...parseBase(fields), event: parseAgentMailboxEvent(fields.get("event")) };
	}
	if (type === "agent_mailbox_delivery") {
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
