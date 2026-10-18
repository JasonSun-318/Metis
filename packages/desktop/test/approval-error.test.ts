import { describe, expect, it } from "vitest";
import { approvalErrorMessage } from "../src/renderer/approval-error.ts";

describe("approvalErrorMessage", () => {
	it("returns an ordinary Error message unchanged", () => {
		expect(approvalErrorMessage(new Error("Network request failed"))).toBe("Network request failed");
	});

	it.each([undefined, null, "stale", { message: "unavailable" }, 42])(
		"falls back for a non-Error cause: %s",
		(cause) => {
			expect(approvalErrorMessage(cause)).toBe("The response could not be sent.");
		},
	);

	it.each([
		"Approval is stale",
		"This approval is STALE",
		"Approval is unavailable",
		"Session UNAVAILABLE",
		"Request was cancelled",
		"This approval is no longer valid",
		"This approval is NO LONGER valid",
	])("maps lifecycle errors (%s) to the unavailable message", (message) => {
		expect(approvalErrorMessage(new Error(message))).toBe("This approval is no longer available.");
	});

	it("does not treat a differently spelled cancellation as a lifecycle error", () => {
		expect(approvalErrorMessage(new Error("Request was canceled"))).toBe("Request was canceled");
	});
});
