import type { NormalizedPermissionAction, PermissionPolicyDecision } from "./types.ts";

const MAX_REASON_BYTES = 2 * 1024;

type Reviewer = "model" | "user";

/**
 * Stable display-only reasons for why an action needed a manual decision.
 * They never participate in authorization and remain bounded for protocol use.
 */
export const PERMISSION_MANUAL_REASONS = [
	"sensitive",
	"write",
	"network",
	"destructive",
	"analysis-incomplete",
	"critical",
	"model-denied",
	"model-unavailable",
	"model-timeout",
	"policy",
] as const;
export type PermissionManualReason = (typeof PERMISSION_MANUAL_REASONS)[number];

export function isPermissionManualReason(value: unknown): value is PermissionManualReason {
	return typeof value === "string" && (PERMISSION_MANUAL_REASONS as readonly string[]).includes(value);
}

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
	readonly priorModelOutcome?: "deny" | "unavailable";
	/** The model reviewer's bounded unavailable reason; display metadata only. */
	readonly priorModelReason?: string;
}

export type PermissionReviewResult =
	| {
			readonly kind: "allow" | "deny";
			readonly reviewer: Reviewer;
			readonly manualReason?: PermissionManualReason;
			readonly remember?: "session" | "project";
	  }
	| { readonly kind: "unavailable"; readonly reviewer: Reviewer; readonly reason: string };

export interface PermissionReviewer {
	review(request: PermissionReviewRequest): Promise<PermissionReviewResult>;
}

export interface PermissionReviewRouterOptions {
	readonly model: PermissionReviewer;
	readonly user?: PermissionReviewer;
	/** The Auto approval-model switch. Missing or throwing means disabled. Read on every review. */
	readonly isModelEnabled?: () => boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value).sort();
	const sortedExpected = [...expected].sort();
	return keys.length === sortedExpected.length && keys.every((key, index) => key === sortedExpected[index]);
}

export function unavailableReview(reviewer: Reviewer, reason: string): PermissionReviewResult {
	let bounded = reason.replaceAll("\0", "").trim() || "Permission review is unavailable";
	if (Buffer.byteLength(bounded, "utf8") > MAX_REASON_BYTES) {
		bounded = Buffer.from(bounded)
			.subarray(0, MAX_REASON_BYTES - 3)
			.toString("utf8")
			.replace(/�$/u, "");
		bounded = `${bounded}…`;
	}
	return Object.freeze({ kind: "unavailable", reviewer, reason: bounded });
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
	const allowedKeys = [
		"kind",
		"reviewer",
		...(result.manualReason === undefined ? [] : ["manualReason"]),
		...(result.remember === undefined ? [] : ["remember"]),
	];
	if (
		result.remember !== undefined &&
		(result.reviewer !== "user" || (result.remember !== "session" && result.remember !== "project"))
	)
		return undefined;
	if ((result.kind !== "allow" && result.kind !== "deny") || !exactKeys(result, allowedKeys)) {
		return undefined;
	}
	if (result.manualReason !== undefined && !isPermissionManualReason(result.manualReason)) return undefined;
	return Object.freeze({
		kind: result.kind,
		reviewer: result.reviewer,
		...(result.manualReason === undefined ? {} : { manualReason: result.manualReason }),
		...(result.remember === undefined ? {} : { remember: result.remember }),
	});
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
		let reviewer: Reviewer = "model";
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
	if (normalized.kind === "deny") return normalized;
	if (request.decision.minimumReviewer === "user" && normalized.reviewer !== "user") {
		return Object.freeze({ kind: "deny", reviewer: normalized.reviewer });
	}
	return normalized;
}

function fallbackDeny(reviewer: Reviewer): PermissionReviewResult {
	return Object.freeze({ kind: "deny", reviewer });
}

async function runReviewer(
	reviewer: PermissionReviewer,
	expectedReviewer: Reviewer,
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

	private modelEnabled(): boolean {
		try {
			return this.options.isModelEnabled?.() === true;
		} catch {
			return false;
		}
	}

	/** User review is either the required path or the interactive fallback; headless always denies. */
	private async reviewUser(request: PermissionReviewRequest): Promise<PermissionReviewResult> {
		const requiredReviewer = request.decision.minimumReviewer;
		if (request.signal.aborted) {
			return unavailableReview(requiredReviewer, "Permission review was cancelled");
		}
		if (!request.interactive) return fallbackDeny(requiredReviewer);
		if (!this.options.user) return unavailableReview("user", "No user permission reviewer is available");
		return runReviewer(this.options.user, "user", request);
	}

	async review(request: PermissionReviewRequest): Promise<PermissionReviewResult> {
		const requiredReviewer = request.decision.minimumReviewer;
		if (request.signal.aborted) {
			return unavailableReview(requiredReviewer, "Permission review was cancelled");
		}
		if (requiredReviewer === "user") {
			return this.reviewUser(request);
		}
		if (!this.modelEnabled()) {
			return this.reviewUser(request);
		}

		const modelResult = await runReviewer(this.options.model, "model", request);
		if (modelResult.kind === "allow" || request.signal.aborted) return modelResult;
		return this.reviewUser(
			Object.freeze({
				...request,
				priorModelOutcome: modelResult.kind,
				...(modelResult.kind === "unavailable" ? { priorModelReason: modelResult.reason } : {}),
			}),
		);
	}
}
