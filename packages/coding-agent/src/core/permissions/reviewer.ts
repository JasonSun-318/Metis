import type { NormalizedPermissionAction, PermissionPolicyDecision, RiskLevel, UserAuthorization } from "./types.ts";

const MAX_MODEL_OUTPUT_BYTES = 16 * 1024;
const MAX_RATIONALE_BYTES = 2 * 1024;
const RISK_LEVELS: readonly RiskLevel[] = ["low", "medium", "high", "critical"];
const AUTHORIZATION_LEVELS: readonly UserAuthorization[] = ["unknown", "low", "medium", "high"];
const RISK_RANK: Readonly<Record<RiskLevel, number>> = { low: 0, medium: 1, high: 2, critical: 3 };
const AUTHORIZATION_RANK: Readonly<Record<UserAuthorization, number>> = { unknown: 0, low: 1, medium: 2, high: 3 };

export interface TrustedUserMessage {
	readonly messageId: string;
	readonly text: string;
}

export interface PermissionReviewRequest {
	readonly action: NormalizedPermissionAction;
	readonly decision: Extract<PermissionPolicyDecision, { readonly kind: "review" }>;
	readonly trustedUserMessages: readonly TrustedUserMessage[];
	readonly redactedArguments: unknown;
	readonly interactive: boolean;
	readonly signal: AbortSignal;
}

interface PermissionReviewDecision<K extends "allow" | "deny"> {
	readonly kind: K;
	readonly reviewer: "model" | "user";
	readonly assessedRisk: RiskLevel;
	readonly userAuthorization: UserAuthorization;
	readonly scopeComplete: boolean;
	readonly rationale: string;
}

export type PermissionReviewResult =
	| PermissionReviewDecision<"allow">
	| PermissionReviewDecision<"deny">
	| { readonly kind: "unavailable"; readonly reviewer: "model" | "user"; readonly reason: string };

export interface PermissionReviewer {
	review(request: PermissionReviewRequest): Promise<PermissionReviewResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

function boundedReason(value: unknown, field: string): string {
	if (typeof value !== "string") throw new TypeError(`${field} must be a string`);
	const text = value.trim();
	if (!text || text.includes("\0") || Buffer.byteLength(text, "utf8") > MAX_RATIONALE_BYTES) {
		throw new TypeError(`${field} is invalid`);
	}
	return text;
}

export function unavailableReview(reviewer: "model" | "user", reason: string): PermissionReviewResult {
	let bounded = reason.trim() || "Permission review is unavailable";
	if (Buffer.byteLength(bounded, "utf8") > MAX_RATIONALE_BYTES) {
		bounded = Buffer.from(bounded)
			.subarray(0, MAX_RATIONALE_BYTES - 3)
			.toString("utf8")
			.replace(/�$/u, "");
		bounded = `${bounded}…`;
	}
	return Object.freeze({ kind: "unavailable", reviewer, reason: bounded });
}

export function parseModelReviewOutput(output: string): PermissionReviewResult {
	if (typeof output !== "string" || Buffer.byteLength(output, "utf8") > MAX_MODEL_OUTPUT_BYTES) {
		throw new TypeError("Permission reviewer output exceeds 16 KiB");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(output);
	} catch {
		throw new TypeError("Permission reviewer output is not exact JSON");
	}
	if (
		!isRecord(parsed) ||
		!exactKeys(parsed, ["decision", "assessedRisk", "userAuthorization", "scopeComplete", "rationale"]) ||
		(parsed.decision !== "allow" && parsed.decision !== "deny") ||
		!RISK_LEVELS.includes(parsed.assessedRisk as RiskLevel) ||
		!AUTHORIZATION_LEVELS.includes(parsed.userAuthorization as UserAuthorization) ||
		typeof parsed.scopeComplete !== "boolean"
	) {
		throw new TypeError("Permission reviewer output has an invalid schema");
	}
	if (parsed.decision === "allow" && (!parsed.scopeComplete || parsed.assessedRisk === "critical")) {
		throw new TypeError("Permission reviewer output is contradictory");
	}
	return Object.freeze({
		kind: parsed.decision,
		reviewer: "model",
		assessedRisk: parsed.assessedRisk as RiskLevel,
		userAuthorization: parsed.userAuthorization as UserAuthorization,
		scopeComplete: parsed.scopeComplete,
		rationale: boundedReason(parsed.rationale, "rationale"),
	});
}

function deniedByValidation(
	request: PermissionReviewRequest,
	result: PermissionReviewDecision<"allow">,
	reason: string,
): PermissionReviewResult {
	const assessedRisk =
		RISK_RANK[result.assessedRisk] >= RISK_RANK[request.decision.riskLevel]
			? result.assessedRisk
			: request.decision.riskLevel;
	return Object.freeze({ ...result, kind: "deny", assessedRisk, rationale: reason });
}

function normalizedResult(result: unknown): PermissionReviewResult | undefined {
	if (!isRecord(result) || (result.reviewer !== "model" && result.reviewer !== "user")) return undefined;
	if (result.kind === "unavailable") {
		if (!exactKeys(result, ["kind", "reviewer", "reason"]) || typeof result.reason !== "string") return undefined;
		return unavailableReview(result.reviewer, result.reason);
	}
	if (
		(result.kind !== "allow" && result.kind !== "deny") ||
		!exactKeys(result, ["kind", "reviewer", "assessedRisk", "userAuthorization", "scopeComplete", "rationale"]) ||
		!RISK_LEVELS.includes(result.assessedRisk as RiskLevel) ||
		!AUTHORIZATION_LEVELS.includes(result.userAuthorization as UserAuthorization) ||
		typeof result.scopeComplete !== "boolean"
	) {
		return undefined;
	}
	try {
		return Object.freeze({
			kind: result.kind,
			reviewer: result.reviewer,
			assessedRisk: result.assessedRisk as RiskLevel,
			userAuthorization: result.userAuthorization as UserAuthorization,
			scopeComplete: result.scopeComplete,
			rationale: boundedReason(result.rationale, "rationale"),
		});
	} catch {
		return undefined;
	}
}

export function validateReviewResult(
	request: PermissionReviewRequest,
	result: PermissionReviewResult,
): PermissionReviewResult {
	const normalized = normalizedResult(result);
	if (!normalized) {
		const reviewer = isRecord(result) && result.reviewer === "user" ? "user" : "model";
		return unavailableReview(reviewer, "Permission reviewer returned an invalid result");
	}
	if (normalized.kind !== "allow") return normalized;
	if (RISK_RANK[normalized.assessedRisk] < RISK_RANK[request.decision.riskLevel]) {
		return deniedByValidation(request, normalized, "Reviewer cannot lower deterministic risk");
	}
	if (request.decision.minimumReviewer === "user" && normalized.reviewer !== "user") {
		return deniedByValidation(request, normalized, "Policy requires a user reviewer");
	}
	if (!normalized.scopeComplete) {
		return deniedByValidation(request, normalized, "Permission scope is incomplete");
	}
	const assessedRisk = normalized.assessedRisk;
	if (assessedRisk === "critical" && normalized.reviewer !== "user") {
		return deniedByValidation(request, normalized, "Critical risk requires a user reviewer");
	}
	const requiredAuthorization = assessedRisk === "critical" ? "high" : assessedRisk;
	if (AUTHORIZATION_RANK[normalized.userAuthorization] < AUTHORIZATION_RANK[requiredAuthorization]) {
		return deniedByValidation(request, normalized, "Direct-user authorization is insufficient");
	}
	return normalized;
}
