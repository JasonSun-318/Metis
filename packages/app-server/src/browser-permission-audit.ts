import { createHash, randomUUID } from "node:crypto";
import type { BrowserToolCall } from "@metis/app-protocol";
import {
	createPermissionAuditEvent,
	digestCanonical,
	type PermissionAuditEvent,
	type PermissionAuditSink,
} from "@metis/coding-agent/host";

export type BrowserPermissionAuditRequest = BrowserToolCall & { readonly toolCallId: string };

export interface BrowserPermissionAudit {
	decision(
		request: BrowserPermissionAuditRequest,
		outcome: "allow" | "deny" | "unavailable" | "cancelled",
		reasonCode: string,
	): Promise<void>;
	execution(
		request: BrowserPermissionAuditRequest,
		outcome: "success" | "failure" | "cancelled",
		reasonCode: string,
	): Promise<void>;
}

export class BrowserPermissionDeniedError extends Error {
	constructor(message = "The browser action was denied") {
		super(message);
		this.name = "BrowserPermissionDeniedError";
	}
}

export class BrowserPermissionDecisionUnavailableError extends Error {
	readonly outcome: "unavailable" | "cancelled";
	readonly reasonCode: "browser.local.unavailable" | "browser.local.cancelled";

	constructor(outcome: "unavailable" | "cancelled", message = "The browser permission decision is unavailable") {
		super(message);
		this.name = "BrowserPermissionDecisionUnavailableError";
		this.outcome = outcome;
		this.reasonCode = outcome === "cancelled" ? "browser.local.cancelled" : "browser.local.unavailable";
	}
}

function actionDigest(request: BrowserPermissionAuditRequest): string {
	return digestCanonical({ tool: request.tool, input: request.input });
}

function textDigest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function riskLevel(request: BrowserPermissionAuditRequest): PermissionAuditEvent["riskLevel"] {
	if (request.tool === "browser_act") {
		switch (request.input.risk) {
			case "financial":
			case "sensitive_data":
				return "critical";
			case "destructive":
			case "external_side_effect":
				return "high";
			case "ordinary":
				return "low";
		}
	}
	if (request.tool === "browser_navigate") return "medium";
	if (request.tool === "browser_handoff") return "high";
	return "low";
}

function reviewer(request: BrowserPermissionAuditRequest): Pick<PermissionAuditEvent, "reviewer"> | object {
	return request.tool === "browser_act" && request.input.risk !== "ordinary" ? { reviewer: "user" as const } : {};
}

export function createBrowserPermissionAudit(options: {
	readonly sessionId: string;
	readonly sink: PermissionAuditSink;
	readonly now?: () => number;
	readonly createEventId?: () => string;
}): BrowserPermissionAudit {
	const now = options.now ?? Date.now;
	const createEventId = options.createEventId ?? randomUUID;
	const append = async (
		request: BrowserPermissionAuditRequest,
		stage: "decision" | "execution",
		outcome: PermissionAuditEvent["outcome"],
		reasonCode: string,
	): Promise<void> => {
		try {
			await options.sink.append(
				createPermissionAuditEvent({
					eventId: createEventId(),
					sessionId: options.sessionId,
					actionId: `browser:${textDigest(request.toolCallId)}`,
					actionDigest: actionDigest(request),
					toolName: request.tool,
					provenance: "host",
					riskLevel: riskLevel(request),
					stage,
					outcome,
					...(stage === "decision" ? reviewer(request) : {}),
					executionTarget: "external",
					reasonCode,
					timestamp: new Date(now()).toISOString(),
				}),
			);
		} catch {
			// Security audit is observational and cannot widen or reverse the browser decision.
		}
	};
	const audit: BrowserPermissionAudit = {
		decision: (
			request: BrowserPermissionAuditRequest,
			outcome: "allow" | "deny" | "unavailable" | "cancelled",
			reasonCode: string,
		) => append(request, "decision", outcome, reasonCode),
		execution: (
			request: BrowserPermissionAuditRequest,
			outcome: "success" | "failure" | "cancelled",
			reasonCode: string,
		) => append(request, "execution", outcome, reasonCode),
	};
	return Object.freeze(audit);
}
