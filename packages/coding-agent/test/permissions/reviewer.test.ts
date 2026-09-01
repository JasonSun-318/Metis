import { describe, expect, it } from "vitest";
import {
	type PermissionReviewResult,
	parseModelReviewOutput,
	validateReviewResult,
} from "../../src/core/permissions/index.ts";
import { reviewInput, validJson } from "./reviewer-fixtures.ts";

function modelAllow(
	overrides: Partial<Extract<PermissionReviewResult, { kind: "allow" }>> = {},
): Extract<PermissionReviewResult, { kind: "allow" }> {
	return {
		kind: "allow",
		reviewer: "model",
		assessedRisk: "medium",
		userAuthorization: "medium",
		scopeComplete: true,
		rationale: "Exact direct-user authorization is present.",
		...overrides,
	};
}

describe("permission review contract", () => {
	it("parses one exact bounded model JSON object", () => {
		expect(parseModelReviewOutput(validJson())).toEqual({
			kind: "allow",
			reviewer: "model",
			assessedRisk: "medium",
			userAuthorization: "medium",
			scopeComplete: true,
			rationale: "The direct user message authorizes this exact action.",
		});
	});

	it.each([
		'{"decision":"allow","unexpected":true}',
		'{"decision":"maybe"}',
		`${validJson()} explanation`,
		validJson({ rationale: "x".repeat(2 * 1024 + 1) }),
		validJson({ assessedRisk: "critical", decision: "allow" }),
		validJson({ scopeComplete: false, decision: "allow" }),
	])("rejects malformed, extra, oversized, or contradictory model output", (output) => {
		expect(() => parseModelReviewOutput(output)).toThrow();
	});

	it("enforces deterministic risk, reviewer, scope, and authorization thresholds", () => {
		expect(validateReviewResult(reviewInput(), modelAllow())).toMatchObject({ kind: "allow" });
		expect(validateReviewResult(reviewInput(), modelAllow({ userAuthorization: "low" }))).toMatchObject({
			kind: "deny",
		});
		expect(validateReviewResult(reviewInput(), modelAllow({ assessedRisk: "low" }))).toMatchObject({ kind: "deny" });
		expect(
			validateReviewResult(
				reviewInput({ decision: { ...reviewInput().decision, minimumReviewer: "user" } }),
				modelAllow(),
			),
		).toMatchObject({ kind: "deny" });
		expect(validateReviewResult(reviewInput(), modelAllow({ scopeComplete: false }))).toMatchObject({ kind: "deny" });
	});

	it("allows high model review only with high exact authorization and reserves critical risk for users", () => {
		const highRequest = reviewInput({ decision: { ...reviewInput().decision, riskLevel: "high" } });
		expect(
			validateReviewResult(highRequest, modelAllow({ assessedRisk: "high", userAuthorization: "high" })),
		).toMatchObject({ kind: "allow" });
		expect(
			validateReviewResult(highRequest, modelAllow({ assessedRisk: "high", userAuthorization: "medium" })),
		).toMatchObject({ kind: "deny" });

		const criticalRequest = reviewInput({
			decision: { ...reviewInput().decision, riskLevel: "critical", minimumReviewer: "user" },
		});
		expect(
			validateReviewResult(criticalRequest, modelAllow({ assessedRisk: "critical", userAuthorization: "high" })),
		).toMatchObject({ kind: "deny" });
		expect(
			validateReviewResult(criticalRequest, {
				...modelAllow({ assessedRisk: "critical", userAuthorization: "high" }),
				reviewer: "user",
			}),
		).toMatchObject({ kind: "allow" });
	});

	it("passes through safe deny and unavailable outcomes", () => {
		const denied: PermissionReviewResult = {
			...modelAllow(),
			kind: "deny",
			rationale: "Not authorized.",
		};
		const unavailable: PermissionReviewResult = { kind: "unavailable", reviewer: "model", reason: "timeout" };
		expect(validateReviewResult(reviewInput(), denied)).toEqual(denied);
		expect(validateReviewResult(reviewInput(), unavailable)).toEqual(unavailable);
	});

	it("turns structurally invalid adapter results into unavailable", () => {
		expect(
			validateReviewResult(reviewInput(), { ...modelAllow(), assessedRisk: "negligible" } as never),
		).toMatchObject({ kind: "unavailable", reviewer: "model" });
		expect(
			validateReviewResult(reviewInput(), { ...modelAllow(), grant: { executionTarget: "host" } } as never),
		).toMatchObject({ kind: "unavailable", reviewer: "model" });
	});
});
