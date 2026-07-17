import { isPermissionMode, type PermissionMode } from "./permission-mode.ts";

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

export type SessionControlEntry = SessionPermissionsEntry | SessionPermissionDecisionEntry;

export type SessionControlPayload = SessionControlEntry extends infer Entry
	? Entry extends SessionControlEntry
		? Omit<Entry, "id" | "parentId" | "timestamp">
		: never
	: never;

function invalid(message: string): never {
	throw new TypeError(message);
}

function dataFields(value: unknown): Map<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		invalid("Session control entry must be an object");
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) invalid("Session control entry must be a plain object");

	const fields = new Map<string, unknown>();
	for (const key of Reflect.ownKeys(value)) {
		if (typeof key !== "string") invalid("Session control entry must not contain symbol fields");
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) {
			invalid("Session control entry must contain only enumerable data properties");
		}
		fields.set(key, descriptor.value);
	}
	return fields;
}

function assertOnlyFields(fields: ReadonlyMap<string, unknown>, allowed: readonly string[]): void {
	const allowedFields = new Set(allowed);
	const unknown = [...fields.keys()].filter((key) => !allowedFields.has(key)).sort()[0];
	if (unknown) invalid(`Session control entry has unknown field: ${unknown}`);
}

function requiredString(fields: ReadonlyMap<string, unknown>, key: string): string {
	const value = fields.get(key);
	if (typeof value !== "string" || value.length === 0)
		invalid(`Session control entry.${key} must be a non-empty string`);
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

export function isSessionControlEntryType(type: unknown): type is SessionControlEntry["type"] {
	return type === "session_permissions" || type === "session_permission_decision";
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
		if (decision !== "allow" && decision !== "ask" && decision !== "deny") {
			invalid("Session control entry.decision is invalid");
		}
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
	invalid(`Unknown session control entry type: ${type}`);
}
