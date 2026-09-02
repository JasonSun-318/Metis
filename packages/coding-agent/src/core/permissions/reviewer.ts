import type { NormalizedPermissionAction, PermissionPolicyDecision } from "./types.ts";

const MAX_REASON_BYTES = 2 * 1024;

type Reviewer = "model" | "user";

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

export type PermissionReviewResult =
	| { readonly kind: "allow" | "deny"; readonly reviewer: Reviewer }
	| { readonly kind: "unavailable"; readonly reviewer: Reviewer; readonly reason: string };

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
	if ((result.kind !== "allow" && result.kind !== "deny") || !exactKeys(result, ["kind", "reviewer"])) {
		return undefined;
	}
	return Object.freeze({ kind: result.kind, reviewer: result.reviewer });
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

	async review(request: PermissionReviewRequest): Promise<PermissionReviewResult> {
		const requiredReviewer = request.decision.minimumReviewer;
		if (request.signal.aborted) {
			return unavailableReview(requiredReviewer, "Permission review was cancelled");
		}
		if (requiredReviewer === "user") {
			if (!request.interactive) {
				return fallbackDeny("user");
			}
			if (!this.options.user) return unavailableReview("user", "No user permission reviewer is available");
			return runReviewer(this.options.user, "user", request);
		}

		const modelResult = await runReviewer(this.options.model, "model", request);
		if (modelResult.kind !== "unavailable" || request.signal.aborted) return modelResult;
		if (!request.interactive) {
			return fallbackDeny("model");
		}
		if (!this.options.user) return modelResult;
		return runReviewer(this.options.user, "user", request);
	}
}
