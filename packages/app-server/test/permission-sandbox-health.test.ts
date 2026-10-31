import { WorkspaceSandbox } from "@metis/coding-agent/host";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPermissionSandboxHealth, runPermissionSandboxSelfTest } from "../src/permission-sandbox-health.ts";

vi.mock("@metis/coding-agent/host", () => ({ WorkspaceSandbox: { health: vi.fn(), selfTest: vi.fn() } }));
afterEach(() => vi.resetAllMocks());

const checkedAt = "2026-10-29T08:00:00.000Z";

function report(overrides: Record<string, unknown> = {}) {
	return {
		status: "healthy" as const,
		code: "ready" as const,
		mode: "readiness" as const,
		platform: "darwin" as NodeJS.Platform,
		checkedAt,
		checks: [
			{ id: "platform" as const, status: "passed" as const },
			{ id: "package" as const, status: "skipped" as const, reason: "not-applicable" as const },
			{ id: "dependencies" as const, status: "passed" as const },
		],
		recoveryActions: [] as const,
		details: [] as readonly string[],
		...overrides,
	};
}

describe("permission sandbox diagnostics bridge", () => {
	it("forwards structured readiness without internal details", async () => {
		const readinessReport = report();
		vi.mocked(WorkspaceSandbox.health).mockResolvedValue({
			...readinessReport,
			details: ["/private/internal/path"],
		});

		expect(await readPermissionSandboxHealth()).toEqual({
			status: "healthy",
			code: "ready",
			checkedAt,
			platform: "darwin",
			mode: "readiness",
			checks: [
				{ id: "platform", status: "passed" },
				{ id: "package", status: "skipped", reason: "not-applicable" },
				{ id: "dependencies", status: "passed" },
			],
			recoveryActions: [],
		});
		expect(WorkspaceSandbox.health).toHaveBeenCalledOnce();
	});

	it("maps platforms outside the sandbox runtime to other", async () => {
		vi.mocked(WorkspaceSandbox.health).mockResolvedValue(
			report({
				status: "unavailable",
				code: "unsupported",
				platform: "freebsd" as NodeJS.Platform,
				checks: [{ id: "platform", status: "failed", reason: "unsupported-platform" }],
			}),
		);

		expect(await readPermissionSandboxHealth()).toMatchObject({
			status: "unavailable",
			code: "unsupported",
			platform: "other",
		});
	});

	it("returns a safe readiness failure without raw errors", async () => {
		vi.mocked(WorkspaceSandbox.health).mockRejectedValue(new Error("private diagnostic"));
		const result = await readPermissionSandboxHealth();
		expect(result).toMatchObject({
			status: "misconfigured",
			code: "probe-failed",
			mode: "readiness",
			checks: [{ id: "dependencies", status: "failed", reason: "probe-failed" }],
		});
		expect(JSON.stringify(result)).not.toContain("private diagnostic");
	});

	it("forwards explicit self-test checks and only supported recovery actions", async () => {
		vi.mocked(WorkspaceSandbox.selfTest).mockResolvedValue(
			report({
				status: "misconfigured",
				code: "self-test-failed",
				mode: "self-test",
				platform: "win32",
				checkedAt,
				checks: [
					{ id: "platform", status: "passed" },
					{ id: "package", status: "passed" },
					{ id: "dependencies", status: "passed" },
					{ id: "sandbox-startup", status: "passed" },
					{ id: "filesystem-permitted", status: "passed" },
					{ id: "filesystem-denied", status: "failed", reason: "outside-read-not-denied" },
					{ id: "network-denied", status: "skipped", reason: "network-probe-unavailable" },
				],
				recoveryActions: ["install-windows-sandbox", "check-app-update"],
			}),
		);

		const result = await runPermissionSandboxSelfTest();
		expect(result).toMatchObject({
			status: "misconfigured",
			code: "self-test-failed",
			mode: "self-test",
			platform: "win32",
			recoveryActions: ["install-windows-sandbox", "check-app-update"],
		});
		expect(result.checks).toContainEqual({
			id: "filesystem-denied",
			status: "failed",
			reason: "outside-read-not-denied",
		});
		expect(result.checks).toContainEqual({
			id: "network-denied",
			status: "skipped",
			reason: "network-probe-unavailable",
		});
		expect(WorkspaceSandbox.selfTest).toHaveBeenCalledOnce();
	});

	it("reports a failed self-test without exposing the thrown error", async () => {
		vi.mocked(WorkspaceSandbox.selfTest).mockRejectedValue(new Error("/Users/private/secret"));
		const result = await runPermissionSandboxSelfTest();
		expect(result).toMatchObject({
			status: "misconfigured",
			code: "probe-failed",
			mode: "self-test",
			recoveryActions: ["check-app-update"],
		});
		expect(result.checks).toContainEqual({
			id: "sandbox-startup",
			status: "failed",
			reason: "probe-failed",
		});
		expect(JSON.stringify(result)).not.toContain("/Users/private/secret");
	});
});
