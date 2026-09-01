import { describe, expect, it, vi } from "vitest";
import {
	digestExecutionGrantProfile,
	ExecutionGrantStore,
	PermissionAuditWriter,
	PermissionPolicy,
	settingsForPreset,
	ToolAuthorizationRuntime,
} from "../../src/core/permissions/index.ts";
import { workspaceWrite } from "./fixtures.ts";
import { highRiskRequest, safeRequest } from "./runtime-fixtures.ts";

function percentile(samples: readonly number[], p: number): number {
	const ranked = [...samples].sort((left, right) => left - right);
	return ranked[Math.min(ranked.length - 1, Math.max(0, Math.ceil((p / 100) * ranked.length) - 1))]!;
}

describe("permission performance gates", () => {
	it("keeps warm low-risk policy plus grant-hash under 5ms p95", () => {
		const policy = new PermissionPolicy();
		const action = workspaceWrite();
		const settings = settingsForPreset("auto");
		const run = () => {
			const decision = policy.evaluate({ settings, action });
			if (decision.kind === "deny") throw new Error(decision.reason);
			return digestExecutionGrantProfile({
				readRoots: decision.grant.readRoots,
				writeRoots: decision.grant.writeRoots,
				protectedRoots: decision.grant.protectedRoots,
				networkEndpoints: decision.grant.networkEndpoints,
			});
		};
		for (let index = 0; index < 200; index += 1) run();
		const samples: number[] = [];
		for (let index = 0; index < 10_000; index += 1) {
			const started = performance.now();
			run();
			samples.push(performance.now() - started);
		}
		expect(percentile(samples, 95)).toBeLessThan(5);
	});

	it("executes 100 safe actions with zero model or user interactions", async () => {
		const reviewerFactory = vi.fn(() => {
			throw new Error("reviewer must not be constructed for safe actions");
		});
		const runtime = new ToolAuthorizationRuntime({ sessionId: "perf-safe", reviewerFactory });
		await expect(
			Promise.all(Array.from({ length: 100 }, () => runtime.authorizeAndExecute(safeRequest()))),
		).resolves.toHaveLength(100);
		expect(reviewerFactory).not.toHaveBeenCalled();
	});

	it("does not stall 20 parallel safe actions behind one pending model review", async () => {
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const reviewer = {
			review: vi.fn(async () => {
				await pending;
				return {
					kind: "allow" as const,
					reviewer: "model" as const,
					assessedRisk: "high" as const,
					userAuthorization: "high" as const,
					scopeComplete: true,
					rationale: "Released after safe work finished.",
				};
			}),
		};
		const runtime = new ToolAuthorizationRuntime({ sessionId: "perf-queue", reviewerFactory: () => reviewer });
		const blocked = runtime.authorizeAndExecute(highRiskRequest());
		await vi.waitFor(() => expect(reviewer.review).toHaveBeenCalledOnce());
		const started = performance.now();
		await expect(
			Promise.all(Array.from({ length: 20 }, () => runtime.authorizeAndExecute(safeRequest()))),
		).resolves.toHaveLength(20);
		expect(performance.now() - started).toBeLessThan(1_000);
		expect(reviewer.review).toHaveBeenCalledOnce();
		release();
		await expect(blocked).resolves.toBe("executed");
	});

	it("serializes model reviews per session and drops unused grants after cancel", async () => {
		let active = 0;
		let maximum = 0;
		const reviewer = {
			review: vi.fn(async (request: { signal: AbortSignal }) => {
				active += 1;
				maximum = Math.max(maximum, active);
				await new Promise<void>((_resolve, reject) => {
					if (request.signal.aborted) {
						active -= 1;
						reject(request.signal.reason ?? new Error("aborted"));
						return;
					}
					request.signal.addEventListener(
						"abort",
						() => {
							active -= 1;
							reject(request.signal.reason ?? new Error("aborted"));
						},
						{ once: true },
					);
				});
				return {
					kind: "deny" as const,
					reviewer: "model" as const,
					assessedRisk: "high" as const,
					userAuthorization: "unknown" as const,
					scopeComplete: true,
					rationale: "unreachable",
				};
			}),
		};
		const grants = new ExecutionGrantStore();
		const audit = new PermissionAuditWriter({ append: () => undefined });
		const runtime = new ToolAuthorizationRuntime({
			sessionId: "perf-serial",
			reviewerFactory: () => reviewer,
			grants,
			audit,
		});
		const first = runtime.authorizeAndExecute(highRiskRequest());
		const second = runtime.authorizeAndExecute(highRiskRequest());
		await vi.waitFor(() => expect(reviewer.review).toHaveBeenCalledOnce());
		runtime.invalidate("session");
		await expect(first).rejects.toThrow("Permission denied");
		await expect(second).rejects.toThrow("Permission denied");
		expect(maximum).toBe(1);
		await expect(runtime.authorizeAndExecute(safeRequest())).resolves.toBe("executed");
	});
});
