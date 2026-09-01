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

export interface PermissionReviewRouterOptions {
	readonly model: PermissionReviewer;
	readonly user?: PermissionReviewer;
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
	let bounded = reason.replaceAll("\0", "").trim() || "Permission review is unavailable";
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
	if (!isRecord(result)) return undefined;
	const prototype = Object.getPrototypeOf(result);
	if (prototype !== Object.prototype && prototype !== null) return undefined;
	const descriptors = Object.getOwnPropertyDescriptors(result);
	if (
		Reflect.ownKeys(descriptors).some((key) => {
			if (typeof key === "symbol") return true;
			const descriptor = descriptors[key];
			return !descriptor || !("value" in descriptor) || !descriptor.enumerable;
		})
	) {
		return undefined;
	}
	if (result.reviewer !== "model" && result.reviewer !== "user") return undefined;
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
	let normalized: PermissionReviewResult | undefined;
	try {
		normalized = normalizedResult(result);
	} catch {
		normalized = undefined;
	}
	if (!normalized) {
		let reviewer: "model" | "user" = "model";
		try {
			if (isRecord(result)) {
				const descriptor = Object.getOwnPropertyDescriptor(result, "reviewer");
				if (descriptor && "value" in descriptor && descriptor.value === "user") reviewer = "user";
			}
		} catch {
			// A hostile adapter result is invalid and remains attributed to the model fallback.
		}
		return unavailableReview(reviewer, "Permission reviewer returned an invalid result");
	}
	if (normalized.kind === "unavailable") return normalized;
	if (RISK_RANK[normalized.assessedRisk] < RISK_RANK[request.decision.riskLevel]) {
		if (normalized.kind === "deny") {
			return Object.freeze({
				...normalized,
				assessedRisk: request.decision.riskLevel,
				rationale: "Reviewer cannot lower deterministic risk",
			});
		}
		return deniedByValidation(request, normalized, "Reviewer cannot lower deterministic risk");
	}
	if (normalized.kind === "deny") return normalized;
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

function fallbackDeny(
	request: PermissionReviewRequest,
	reviewer: "model" | "user",
	rationale: string,
): PermissionReviewResult {
	return Object.freeze({
		kind: "deny",
		reviewer,
		assessedRisk: request.decision.riskLevel,
		userAuthorization: "unknown",
		scopeComplete: false,
		rationale,
	});
}

async function runReviewer(
	reviewer: PermissionReviewer,
	expectedReviewer: "model" | "user",
	request: PermissionReviewRequest,
): Promise<PermissionReviewResult> {
	try {
		const result = await reviewer.review(request);
		if (request.signal.aborted) return unavailableReview(expectedReviewer, "Permission review was cancelled");
		if (result.reviewer !== expectedReviewer) {
			return unavailableReview(expectedReviewer, "Permission reviewer provenance is invalid");
		}
		return validateReviewResult(request, result);
	} catch {
		return unavailableReview(expectedReviewer, "Permission reviewer failed unexpectedly");
	}
}

/** Selects one authoritative review path and applies interactive fail-closed fallback. */
export class PermissionReviewRouter implements PermissionReviewer {
	private readonly options: PermissionReviewRouterOptions;

	constructor(options: PermissionReviewRouterOptions) {
		this.options = options;
	}

	async review(request: PermissionReviewRequest): Promise<PermissionReviewResult> {
		const requiredReviewer = request.decision.minimumReviewer;
		if (request.signal.aborted) {
			return unavailableReview(requiredReviewer, "Permission review was cancelled");
		}
		if (requiredReviewer === "user") {
			if (!request.interactive) {
				return fallbackDeny(request, "user", "User review is required but no interactive UI is attached");
			}
			if (!this.options.user) return unavailableReview("user", "No user permission reviewer is available");
			return runReviewer(this.options.user, "user", request);
		}

		const modelResult = await runReviewer(this.options.model, "model", request);
		if (modelResult.kind !== "unavailable" || request.signal.aborted) return modelResult;
		if (!request.interactive) {
			return fallbackDeny(request, "model", "Automatic review is unavailable in a headless session");
		}
		if (!this.options.user) return modelResult;
		return runReviewer(this.options.user, "user", request);
	}
}
