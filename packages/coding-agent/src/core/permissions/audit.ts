import type { RiskLevel, ToolProvenance } from "./types.ts";

const STAGES = ["decision", "review", "grant-issued", "execution", "grant-revoked"] as const;
const OUTCOMES = ["allow", "deny", "unavailable", "success", "failure", "cancelled"] as const;
const REVIEWERS = ["model", "user"] as const;
const TARGETS = ["sandbox", "host", "external"] as const;
const PROVENANCES: readonly ToolProvenance[] = ["builtin", "host", "extension", "sdk", "mcp"];
const RISKS: readonly RiskLevel[] = ["low", "medium", "high", "critical"];
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const REASON_CODE_PATTERN = /^[a-z][a-z0-9._-]{0,127}$/;

export interface PermissionAuditEvent {
	readonly eventId: string;
	readonly sessionId: string;
	readonly actionId: string;
	readonly actionDigest: string;
	readonly toolName: string;
	readonly provenance: ToolProvenance;
	readonly riskLevel: RiskLevel;
	readonly stage: (typeof STAGES)[number];
	readonly outcome: (typeof OUTCOMES)[number];
	readonly reviewer?: (typeof REVIEWERS)[number];
	readonly remember?: "session" | "project";
	readonly executionTarget?: (typeof TARGETS)[number];
	readonly ruleIds?: readonly string[];
	readonly matchedRule?: { readonly id: string; readonly name: string; readonly scope: string };
	readonly reasonCode: string;
	readonly timestamp: string;
}

export type PermissionAuditEventInput = PermissionAuditEvent;

export interface PermissionAuditSink {
	append(event: PermissionAuditEvent): Promise<void> | void;
}

export interface PermissionAuditFailure {
	readonly eventId: string;
	readonly stage: PermissionAuditEvent["stage"];
}

function text(value: unknown, field: string, maximum: number): string {
	if (
		typeof value !== "string" ||
		!value.trim() ||
		value.includes("\0") ||
		Buffer.byteLength(value, "utf8") > maximum
	) {
		throw new TypeError(`${field} is invalid`);
	}
	return value;
}

function enumValue<T extends string>(value: unknown, values: readonly T[], field: string): T {
	if (!values.includes(value as T)) throw new TypeError(`${field} is invalid`);
	return value as T;
}

export function createPermissionAuditEvent(input: PermissionAuditEventInput): PermissionAuditEvent {
	const actionDigest = text(input.actionDigest, "actionDigest", 64);
	if (!DIGEST_PATTERN.test(actionDigest)) throw new TypeError("actionDigest is invalid");
	const reasonCode = text(input.reasonCode, "reasonCode", 128);
	if (!REASON_CODE_PATTERN.test(reasonCode)) throw new TypeError("reasonCode is invalid");
	const timestamp = text(input.timestamp, "timestamp", 64);
	try {
		if (new Date(timestamp).toISOString() !== timestamp) throw new Error("invalid");
	} catch {
		throw new TypeError("timestamp is invalid");
	}
	return Object.freeze({
		eventId: text(input.eventId, "eventId", 256),
		sessionId: text(input.sessionId, "sessionId", 256),
		actionId: text(input.actionId, "actionId", 1_024),
		actionDigest,
		toolName: text(input.toolName, "toolName", 256),
		provenance: enumValue(input.provenance, PROVENANCES, "provenance"),
		riskLevel: enumValue(input.riskLevel, RISKS, "riskLevel"),
		stage: enumValue(input.stage, STAGES, "stage"),
		outcome: enumValue(input.outcome, OUTCOMES, "outcome"),
		...(input.reviewer === undefined ? {} : { reviewer: enumValue(input.reviewer, REVIEWERS, "reviewer") }),
		...(input.remember === undefined
			? {}
			: { remember: enumValue(input.remember, ["session", "project"] as const, "remember") }),
		...(input.executionTarget === undefined
			? {}
			: { executionTarget: enumValue(input.executionTarget, TARGETS, "executionTarget") }),
		...(input.ruleIds === undefined
			? {}
			: {
					ruleIds: Object.freeze(input.ruleIds.map((id) => text(id, "ruleId", 128))),
				}),
		...(input.matchedRule === undefined
			? {}
			: {
					matchedRule: Object.freeze({
						id: text(input.matchedRule.id, "matchedRule.id", 128),
						name: text(input.matchedRule.name, "matchedRule.name", 256),
						scope: text(input.matchedRule.scope, "matchedRule.scope", 32),
					}),
				}),
		reasonCode,
		timestamp,
	});
}

export class PermissionAuditWriter {
	private readonly sink: PermissionAuditSink;
	private readonly onFailure?: (failure: PermissionAuditFailure) => void;

	constructor(sink: PermissionAuditSink, onFailure?: (failure: PermissionAuditFailure) => void) {
		this.sink = sink;
		this.onFailure = onFailure;
	}

	async append(event: PermissionAuditEvent): Promise<boolean> {
		try {
			await this.sink.append(event);
			return true;
		} catch {
			try {
				this.onFailure?.(Object.freeze({ eventId: event.eventId, stage: event.stage }));
			} catch {
				// Audit telemetry must never change the permission decision.
			}
			return false;
		}
	}
}
