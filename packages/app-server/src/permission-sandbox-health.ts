import type { ClientResult } from "@metis/app-protocol";
import { WorkspaceSandbox, type WorkspaceSandboxHealthReport } from "@metis/coding-agent/host";

type SandboxHealthResult = ClientResult<"permission/sandbox/health">;
type SandboxSelfTestResult = ClientResult<"permission/sandbox/selfTest">;

/**
 * Read-only diagnosis; never installs helpers, runs recovery, or changes
 * permission settings. Internal paths and raw errors stay in the core report.
 */
export async function readPermissionSandboxHealth(): Promise<SandboxHealthResult> {
	try {
		return toClientReport(await WorkspaceSandbox.health());
	} catch {
		return failureReport("readiness");
	}
}

/**
 * Explicit, user-triggered self-test. It starts a real sandbox with temporary
 * fixtures and checks permitted, denied, and network boundaries. Recovery
 * actions are returned as identifiers so the UI can only offer mechanisms that
 * actually exist.
 */
export async function runPermissionSandboxSelfTest(): Promise<SandboxSelfTestResult> {
	try {
		return toClientReport(await WorkspaceSandbox.selfTest());
	} catch {
		return failureReport("self-test");
	}
}

function toClientReport(report: WorkspaceSandboxHealthReport): SandboxHealthResult {
	return {
		status: report.status,
		code: report.code,
		checkedAt: report.checkedAt,
		platform: protocolPlatform(report.platform),
		mode: report.mode,
		checks: report.checks.map((check) =>
			check.reason === undefined
				? { id: check.id, status: check.status }
				: { id: check.id, status: check.status, reason: check.reason },
		),
		recoveryActions: [...report.recoveryActions],
	};
}

function protocolPlatform(platform: NodeJS.Platform): NonNullable<SandboxHealthResult["platform"]> {
	return platform === "darwin" || platform === "linux" || platform === "win32" ? platform : "other";
}

function failureReport(mode: "readiness" | "self-test"): SandboxHealthResult {
	const platform = protocolPlatform(process.platform);
	return {
		status: "misconfigured",
		code: "probe-failed",
		mode,
		platform,
		checkedAt: new Date().toISOString(),
		checks:
			mode === "self-test"
				? [
						{ id: "sandbox-startup", status: "failed", reason: "probe-failed" },
						{ id: "filesystem-permitted", status: "skipped", reason: "sandbox-unavailable" },
						{ id: "filesystem-denied", status: "skipped", reason: "sandbox-unavailable" },
						{ id: "network-denied", status: "skipped", reason: "sandbox-unavailable" },
					]
				: [{ id: "dependencies", status: "failed", reason: "probe-failed" }],
		recoveryActions: platform === "win32" ? ["install-windows-sandbox", "check-app-update"] : ["check-app-update"],
	};
}
