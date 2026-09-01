import { describe, expect, it, vi } from "vitest";
import type { PermissionReviewer, PermissionReviewResult } from "../../src/core/permissions/index.ts";
import { ToolAuthorizationRuntime } from "../../src/core/permissions/index.ts";
import { highRiskRequest, safeRequest } from "./runtime-fixtures.ts";

const allowed: PermissionReviewResult = Object.freeze({
	kind: "allow",
	reviewer: "model",
	assessedRisk: "high",
	userAuthorization: "high",
	scopeComplete: true,
	rationale: "Exact direct-user authorization",
});

describe("ToolAuthorizationRuntime concurrency", () => {
	it("serializes reviews while deterministic actions bypass the review queue", async () => {
		const releases: Array<() => void> = [];
		let active = 0;
		let maximumActive = 0;
		const reviewer: PermissionReviewer = {
			review: vi.fn(async () => {
				active += 1;
				maximumActive = Math.max(maximumActive, active);
				await new Promise<void>((resolve) => releases.push(resolve));
				active -= 1;
				return allowed;
			}),
		};
		const runtime = new ToolAuthorizationRuntime({ sessionId: "session-1", reviewerFactory: () => reviewer });
		const first = runtime.authorizeAndExecute(highRiskRequest());
		const second = runtime.authorizeAndExecute(highRiskRequest());
		await vi.waitFor(() => expect(releases).toHaveLength(1));

		await expect(
			Promise.all(Array.from({ length: 20 }, () => runtime.authorizeAndExecute(safeRequest()))),
		).resolves.toHaveLength(20);
		expect(releases).toHaveLength(1);

		releases.shift()?.();
		await vi.waitFor(() => expect(releases).toHaveLength(1));
		releases.shift()?.();
		await expect(Promise.all([first, second])).resolves.toEqual(["executed", "executed"]);
		expect(maximumActive).toBe(1);
	});
});
