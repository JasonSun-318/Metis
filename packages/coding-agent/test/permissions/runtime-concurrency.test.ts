import { describe, expect, it, vi } from "vitest";
import type { PermissionReviewer, PermissionReviewResult } from "../../src/core/permissions/index.ts";
import {
	ExecutionGrantStore,
	PermissionAuditWriter,
	ToolAuthorizationRuntime,
} from "../../src/core/permissions/index.ts";
import { highRiskRequest, safeRequest } from "./runtime-fixtures.ts";

const allowed: PermissionReviewResult = Object.freeze({
	kind: "allow",
	reviewer: "user",
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

	it("cancels an obsolete review queue without letting an uncooperative adapter block the new lifecycle", async () => {
		let firstSignal: AbortSignal | undefined;
		let reviewCount = 0;
		const reviewer: PermissionReviewer = {
			review: vi.fn(async (request) => {
				reviewCount += 1;
				if (reviewCount === 1) {
					firstSignal = request.signal;
					return new Promise<PermissionReviewResult>(() => {});
				}
				return allowed;
			}),
		};
		const runtime = new ToolAuthorizationRuntime({ sessionId: "session-1", reviewerFactory: () => reviewer });
		const first = runtime.authorizeAndExecute(highRiskRequest());
		const queued = runtime.authorizeAndExecute(highRiskRequest());
		await vi.waitFor(() => expect(reviewer.review).toHaveBeenCalledOnce());

		runtime.invalidate("tool-registry");
		await expect(first).rejects.toThrow("Permission denied");
		await expect(queued).rejects.toThrow("Permission denied");
		expect(firstSignal?.aborted).toBe(true);
		await expect(runtime.authorizeAndExecute(highRiskRequest())).resolves.toBe("executed");
		expect(reviewer.review).toHaveBeenCalledTimes(2);
	});

	it("revokes an unused grant when lifecycle authority changes before execution", async () => {
		const grants = new ExecutionGrantStore({ createId: () => "grant-1" });
		const execute = vi.fn(async () => "executed");
		let runtime!: ToolAuthorizationRuntime;
		const audit = new PermissionAuditWriter({
			append: (event) => {
				if (event.stage === "grant-issued") runtime.invalidate("sandbox-health");
			},
		});
		runtime = new ToolAuthorizationRuntime({ sessionId: "session-1", grants, audit });

		await expect(runtime.authorizeAndExecute(safeRequest({ execute }))).rejects.toThrow("Permission runtime changed");
		expect(execute).not.toHaveBeenCalled();
		expect(grants.has("grant-1")).toBe(false);
	});

	it("propagates parent cancellation to both parent and child review requests", async () => {
		const controller = new AbortController();
		const reviews: AbortSignal[] = [];
		const execute = vi.fn(async () => "executed");
		const reviewerFactory = (): PermissionReviewer => ({
			review: async (request) => {
				reviews.push(request.signal);
				return new Promise<PermissionReviewResult>(() => {});
			},
		});
		const parent = new ToolAuthorizationRuntime({ sessionId: "parent", reviewerFactory });
		const child = new ToolAuthorizationRuntime({ sessionId: "child", reviewerFactory });
		const parentRequest = parent.authorizeAndExecute(highRiskRequest({ signal: controller.signal, execute }));
		const childRequest = child.authorizeAndExecute(highRiskRequest({ signal: controller.signal, execute }));
		await vi.waitFor(() => expect(reviews).toHaveLength(2));

		controller.abort();
		await expect(parentRequest).rejects.toThrow("Permission denied");
		await expect(childRequest).rejects.toThrow("Permission denied");
		expect(reviews.every((signal) => signal.aborted)).toBe(true);
		expect(execute).not.toHaveBeenCalled();
	});

	it.each(["model", "session"] as const)("recreates the reviewer after a %s lifecycle change", async (reason) => {
		const reviewerFactory = vi.fn((): PermissionReviewer => ({ review: async () => allowed }));
		const runtime = new ToolAuthorizationRuntime({ sessionId: "session-1", reviewerFactory });
		await expect(runtime.authorizeAndExecute(highRiskRequest())).resolves.toBe("executed");

		runtime.invalidate(reason);
		await expect(runtime.authorizeAndExecute(highRiskRequest())).resolves.toBe("executed");
		expect(reviewerFactory).toHaveBeenCalledTimes(2);
	});
});
