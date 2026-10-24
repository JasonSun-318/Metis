import { describe, expect, it } from "vitest";
import { compileSchema, RetryChangedEventSchema, RetryStatusViewSchema } from "../src/index.ts";

const retry = { attempt: 1, maxAttempts: 5, delayMs: 2000 };
describe("safe model retry progress", () => {
	it("bounds progress and excludes raw provider error data", () => {
		const validator = compileSchema(RetryStatusViewSchema);
		expect(validator.Check(retry)).toBe(true);
		for (const value of [
			{ ...retry, attempt: 0 },
			{ ...retry, attempt: 6 },
			{ ...retry, delayMs: 30_001 },
			{ ...retry, errorMessage: "private endpoint" },
		])
			expect(validator.Check(value)).toBe(false);
	});
	it("uses null to clear progress", () => {
		const validator = compileSchema(RetryChangedEventSchema);
		expect(
			validator.Check({ type: "session/retryChanged", sessionId: "11111111-1111-4111-8111-111111111111", retry }),
		).toBe(true);
		expect(
			validator.Check({
				type: "session/retryChanged",
				sessionId: "11111111-1111-4111-8111-111111111111",
				retry: null,
			}),
		).toBe(true);
	});
});
