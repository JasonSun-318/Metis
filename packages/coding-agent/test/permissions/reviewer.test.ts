import { describe, expect, it, vi } from "vitest";
import {
	type PermissionReviewResult,
	unavailableReview,
	validateReviewResult,
} from "../../src/core/permissions/index.ts";
import { reviewInput } from "./reviewer-fixtures.ts";

describe("permission review contract", () => {
	it("accepts exact binary decisions from the expected reviewer", () => {
		expect(validateReviewResult(reviewInput(), { kind: "allow", reviewer: "model" })).toEqual({
			kind: "allow",
			reviewer: "model",
		});
		expect(validateReviewResult(reviewInput(), { kind: "deny", reviewer: "model" })).toEqual({
			kind: "deny",
			reviewer: "model",
		});
	});

	it("does not let a model satisfy a user-required review", () => {
		const input = reviewInput({
			decision: { ...reviewInput().decision, riskLevel: "critical", minimumReviewer: "user" },
		});
		expect(validateReviewResult(input, { kind: "allow", reviewer: "model" })).toMatchObject({
			kind: "deny",
			reviewer: "model",
		});
	});

	it("allows critical review only from an explicit user", () => {
		const input = reviewInput({
			decision: { ...reviewInput().decision, riskLevel: "critical", minimumReviewer: "user" },
		});
		expect(validateReviewResult(input, { kind: "allow", reviewer: "user" })).toEqual({
			kind: "allow",
			reviewer: "user",
		});
	});

	it("turns extra fields, accessors, and invalid values into unavailable", () => {
		expect(
			validateReviewResult(reviewInput(), {
				kind: "allow",
				reviewer: "model",
				rationale: "not allowed",
			} as never),
		).toMatchObject({ kind: "unavailable", reviewer: "model" });
		expect(validateReviewResult(reviewInput(), { kind: "allow", reviewer: "system" } as never)).toMatchObject({
			kind: "unavailable",
			reviewer: "model",
		});
		const getter = vi.fn(() => "allow");
		const hostile = Object.defineProperty({ kind: "allow", reviewer: "model" }, "kind", {
			enumerable: true,
			get: getter,
		});
		expect(validateReviewResult(reviewInput(), hostile as never)).toMatchObject({ kind: "unavailable" });
		expect(getter).not.toHaveBeenCalled();
	});

	it("passes through bounded unavailable outcomes", () => {
		const unavailable: PermissionReviewResult = { kind: "unavailable", reviewer: "model", reason: "timeout" };
		expect(validateReviewResult(reviewInput(), unavailable)).toEqual(unavailable);
		const oversized = unavailableReview("model", "x".repeat(3 * 1024));
		expect(oversized.kind).toBe("unavailable");
		if (oversized.kind !== "unavailable") return;
		expect(Buffer.byteLength(oversized.reason, "utf8")).toBeLessThanOrEqual(2 * 1024);
	});
});
