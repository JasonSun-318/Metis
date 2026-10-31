import { canonicalizeActionPath, isPathInside } from "../../utils/paths.ts";
import type {
	ActionRisk,
	PermissionAction,
	PermissionApprovalDecision,
	PermissionApprovalRequest,
	RequestPermissionApproval,
} from "./approval.ts";
import { digestCanonical, digestRememberedPermissionAction } from "./normalize.ts";
import type {
	ProjectPermissionRuleInput,
	ProjectPermissionRuleStore,
	ProjectPermissionRuleSummary,
} from "./project-rules.ts";
import {
	type PermissionManualReason,
	type PermissionReviewer,
	type PermissionReviewRequest,
	type PermissionReviewResult,
	unavailableReview,
	validateReviewResult,
} from "./reviewer.ts";
import { buildUserReviewInput } from "./reviewer-input.ts";
import type { SessionPermissionRuleStore } from "./session-rules.ts";
import type { NormalizedPermissionAction, PermissionEffect } from "./types.ts";

const MAX_APPROVAL_REASON_BYTES = 2 * 1024;
const MAX_SUMMARY_VALUE_LENGTH = 256;
const MAX_SUMMARY_ITEMS = 16;
// Mirrors the reviewer input bound: oversized commands are never approved or
// truncated; the session owner is told to split the command and retry.
const MAX_APPROVAL_COMMAND_BYTES = 32 * 1024;

export interface UserPermissionReviewerOptions {
	readonly requestApproval: RequestPermissionApproval;
	readonly projectRules?: ProjectPermissionRuleStore;
	/** In-memory exact allows owned by the current live session. */
	readonly sessionRules?: SessionPermissionRuleStore;
	readonly projectPath?: string;
}

interface ParsedApprovalDecision {
	readonly decision: "allow" | "deny";
	readonly rememberProject: boolean;
	readonly rememberSession: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseApprovalDecision(value: unknown): ParsedApprovalDecision {
	if (!isRecord(value)) throw new TypeError("Approval response is invalid");
	if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
		throw new TypeError("Approval response is invalid");
	}
	const descriptors = Object.getOwnPropertyDescriptors(value);
	if (
		Reflect.ownKeys(descriptors).some(
			(key) =>
				typeof key === "symbol" ||
				!("value" in (descriptors[key] ?? {})) ||
				!(descriptors[key] as PropertyDescriptor).enumerable,
		)
	) {
		throw new TypeError("Approval response is invalid");
	}
	const allowedKeys = new Set(["decision", "remember", "reason"]);
	if (Object.keys(value).some((key) => !allowedKeys.has(key))) throw new TypeError("Approval response is invalid");
	if (value.decision !== "allow" && value.decision !== "deny") throw new TypeError("Approval response is invalid");
	if (value.reason !== undefined) {
		if (
			typeof value.reason !== "string" ||
			value.reason.includes("\0") ||
			Buffer.byteLength(value.reason, "utf8") > MAX_APPROVAL_REASON_BYTES
		) {
			throw new TypeError("Approval response is invalid");
		}
	}
	if (value.remember !== undefined && value.remember !== "project" && value.remember !== "session") {
		throw new TypeError("Approval response is invalid");
	}
	// Session rules are exact allows only; a deny has no session-scope form.
	if (value.remember === "session" && value.decision !== "allow") {
		throw new TypeError("Approval response is invalid");
	}
	return Object.freeze({
		decision: value.decision,
		rememberProject: value.remember === "project",
		rememberSession: value.remember === "session",
	});
}

function actionRisks(action: NormalizedPermissionAction): readonly ActionRisk[] {
	const risks = new Set<ActionRisk>();
	if (action.command !== undefined) risks.add("shell");
	for (const path of action.readPaths) {
		risks.add(action.workspaceRoots.some((root) => isPathInside(root, path)) ? "ordinary-read" : "outside-read");
	}
	for (const path of action.writePaths) {
		risks.add(action.workspaceRoots.some((root) => isPathInside(root, path)) ? "workspace-write" : "outside-write");
	}
	if (action.networkEndpoints.length > 0) risks.add("network");
	const effectRisks: Readonly<Partial<Record<PermissionEffect, ActionRisk>>> = {
		"sensitive-read": "sensitive-read",
		"external-side-effect": "external-side-effect",
		destructive: "destructive",
		elevation: "elevation",
		"security-weakening": "elevation",
		payment: "external-side-effect",
		"production-mutation": "external-side-effect",
		unknown: "unknown",
	};
	for (const effect of action.effects) {
		const risk = effectRisks[effect];
		if (risk) risks.add(risk);
	}
	if (risks.size === 0) risks.add("custom");
	return Object.freeze([...risks]);
}

function approvalAction(action: NormalizedPermissionAction, command?: string): PermissionAction {
	return Object.freeze({
		actionId: action.actionId,
		toolName: action.toolName,
		provenance: action.provenance,
		risks: actionRisks(action),
		paths: Object.freeze([...new Set([...action.readPaths, ...action.writePaths])].sort()),
		networkTargets: Object.freeze(
			action.networkEndpoints.map(({ hostname, port }) => Object.freeze({ host: hostname, port })),
		),
		...(command === undefined ? {} : { command }),
	});
}

function scopeIsComplete(request: PermissionReviewRequest): boolean {
	const { action } = request;
	if (action.effects.includes("unknown")) return false;
	if (action.command === undefined && action.toolName === "bash") return false;
	return true;
}

function exactProjectPath(action: NormalizedPermissionAction, configured: string | undefined): string | undefined {
	if (!configured) return undefined;
	const canonical = canonicalizeActionPath(configured, action.cwd);
	return action.workspaceRoots.includes(canonical) ? canonical : undefined;
}

function structuredApprovalRequest(
	request: PermissionReviewRequest,
	redactedArguments: unknown,
	redactedCommand: string | undefined,
	scopeComplete: boolean,
	rememberProjectEligible: boolean,
	rememberSessionEligible: boolean,
): PermissionApprovalRequest {
	const { action, decision } = request;
	return Object.freeze({
		action: approvalAction(action, redactedCommand),
		args: Object.freeze({
			reviewer: "user",
			deterministicRisk: decision.riskLevel,
			minimumReviewer: decision.minimumReviewer,
			provenance: action.provenance,
			toolIdentity: action.toolIdentity,
			requestedTarget: decision.grant.executionTarget,
			readPaths: action.readPaths,
			writePaths: action.writePaths,
			networkEndpoints: action.networkEndpoints,
			automaticReview:
				request.priorModelOutcome === "deny" || request.priorModelOutcome === "unavailable"
					? request.priorModelOutcome
					: "deterministic-policy-requires-user",
			redactedArguments,
		}),
		reason: decision.reason,
		cwd: action.cwd,
		executionTarget: decision.grant.executionTarget,
		scopeComplete,
		rememberProjectEligible,
		rememberSessionEligible,
		signal: request.signal,
	});
}

function boundedSummaryValue(value: string): string {
	const normalized = value.trim() || "unknown";
	if (normalized.length <= MAX_SUMMARY_VALUE_LENGTH) return normalized;
	return `${normalized.slice(0, MAX_SUMMARY_VALUE_LENGTH - 1)}…`;
}

function ruleSummary(request: PermissionReviewRequest): readonly ProjectPermissionRuleSummary[] {
	const rows: ProjectPermissionRuleSummary[] = [
		{ label: "Tool", value: request.action.toolName },
		{ label: "Risk", value: request.decision.riskLevel },
		{ label: "Execution target", value: request.decision.grant.executionTarget },
		...request.action.readPaths.map((value) => ({ label: "Read path", value })),
		...request.action.writePaths.map((value) => ({ label: "Write path", value })),
		...request.action.networkEndpoints.map(({ hostname, port }) => ({
			label: "Network",
			value: `${hostname}:${port}`,
		})),
	];
	return Object.freeze(
		rows
			.slice(0, MAX_SUMMARY_ITEMS)
			.map(({ label, value }) => Object.freeze({ label, value: boundedSummaryValue(value) })),
	);
}

function ruleInput(request: PermissionReviewRequest, projectPath: string): ProjectPermissionRuleInput {
	return Object.freeze({
		projectPath,
		actionDigest: digestRememberedPermissionAction(request.action),
		grantDigest: digestCanonical(request.decision.grant),
		toolName: request.action.toolName,
		toolIdentity: request.action.toolIdentity,
		riskLevel: request.decision.riskLevel,
		summary: ruleSummary(request),
	});
}

function manualDecisionReason(request: PermissionReviewRequest): PermissionManualReason {
	if (request.priorModelOutcome === "deny") return "model-denied";
	if (request.priorModelOutcome === "unavailable") {
		return request.priorModelReason && /\btime(?:d)?\s*out\b|\btimeout\b/iu.test(request.priorModelReason)
			? "model-timeout"
			: "model-unavailable";
	}
	const { action, decision } = request;
	if (decision.riskLevel === "critical") return "critical";
	if (action.effects.includes("sensitive-read")) return "sensitive";
	if (action.effects.includes("destructive")) return "destructive";
	if (action.writePaths.length > 0) return "write";
	if (action.networkEndpoints.length > 0) return "network";
	if (action.effects.includes("unknown")) return "analysis-incomplete";
	if (
		action.provenance === "builtin" &&
		action.toolName === "bash" &&
		(!action.shellAnalysis || !action.shellAnalysis.complete || action.shellAnalysis.disposition === "user")
	) {
		return "analysis-incomplete";
	}
	return "policy";
}

async function approvalUntilAbort(
	requestApproval: RequestPermissionApproval,
	request: PermissionApprovalRequest,
	signal: AbortSignal,
): Promise<PermissionApprovalDecision> {
	if (signal.aborted) throw signal.reason ?? new Error("Approval aborted");
	let abort: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		abort = () => reject(signal.reason ?? new Error("Approval aborted"));
		signal.addEventListener("abort", abort, { once: true });
	});
	try {
		return await Promise.race([requestApproval(request), aborted]);
	} finally {
		if (abort) signal.removeEventListener("abort", abort);
	}
}

export class UserPermissionReviewer implements PermissionReviewer {
	private readonly options: UserPermissionReviewerOptions;

	constructor(options: UserPermissionReviewerOptions) {
		this.options = options;
	}

	async review(request: PermissionReviewRequest): Promise<PermissionReviewResult> {
		if (request.signal.aborted) return unavailableReview("user", "Permission approval was cancelled");
		if (
			request.action.command !== undefined &&
			Buffer.byteLength(request.action.command, "utf8") > MAX_APPROVAL_COMMAND_BYTES
		) {
			return unavailableReview("user", "Command exceeds 32 KiB; split it into smaller commands and retry");
		}

		let redactedArguments: unknown;
		let redactedCommand: string | undefined;
		let scopeComplete: boolean;
		let projectPath: string | undefined;
		try {
			// Keep model redaction and scope validation without making the human
			// fallback depend on the model-only shell-analysis size limit.
			const reviewInput = buildUserReviewInput(request);
			redactedArguments = reviewInput.redactedArguments;
			redactedCommand = reviewInput.action.command;
			scopeComplete = scopeIsComplete(request);
			projectPath = exactProjectPath(request.action, this.options.projectPath);
		} catch {
			return unavailableReview("user", "Permission approval details are incomplete");
		}
		const rememberProjectEligible = Boolean(
			this.options.projectRules && projectPath && scopeComplete && request.decision.riskLevel !== "critical",
		);
		const rememberSessionEligible = Boolean(
			this.options.sessionRules && projectPath && scopeComplete && request.decision.riskLevel !== "critical",
		);

		let approval: ParsedApprovalDecision;
		try {
			approval = parseApprovalDecision(
				await approvalUntilAbort(
					this.options.requestApproval,
					structuredApprovalRequest(
						request,
						redactedArguments,
						redactedCommand,
						scopeComplete,
						rememberProjectEligible,
						rememberSessionEligible,
					),
					request.signal,
				),
			);
			if (request.signal.aborted) throw request.signal.reason ?? new Error("Approval aborted");
		} catch {
			return unavailableReview("user", "Permission approval UI closed or returned an invalid response");
		}

		if (approval.rememberSession) {
			if (!rememberSessionEligible || !this.options.sessionRules || !projectPath) {
				return unavailableReview("user", "This permission decision cannot be remembered safely");
			}
			try {
				this.options.sessionRules.rememberAllow(ruleInput(request, projectPath));
			} catch {
				return unavailableReview("user", "The exact session permission rule could not be saved safely");
			}
		}

		if (approval.rememberProject) {
			if (!rememberProjectEligible || !this.options.projectRules || !projectPath) {
				return unavailableReview("user", "This permission decision cannot be remembered safely");
			}
			try {
				const stored =
					approval.decision === "allow"
						? this.options.projectRules.rememberAllow(ruleInput(request, projectPath))
						: this.options.projectRules.rememberDeny(ruleInput(request, projectPath));
				if (stored.decision !== approval.decision) {
					return unavailableReview("user", "An existing exact deny rule was not replaced");
				}
			} catch {
				return unavailableReview("user", "The exact project permission rule could not be saved safely");
			}
		}

		const manualReason = manualDecisionReason(request);
		return validateReviewResult(
			request,
			Object.freeze({
				kind: approval.decision,
				reviewer: "user" as const,
				manualReason,
				...(approval.rememberProject
					? { remember: "project" as const }
					: approval.rememberSession
						? { remember: "session" as const }
						: {}),
			}),
		);
	}
}
