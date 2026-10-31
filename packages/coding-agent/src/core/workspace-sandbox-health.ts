import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SandboxDependencyCheck } from "@anthropic-ai/sandbox-runtime";
import { getPackageDir } from "../config.ts";

export const SANDBOX_RUNTIME_VERSION = "0.0.67";
export const SANDBOX_RUNTIME_ID = `@anthropic-ai/sandbox-runtime@${SANDBOX_RUNTIME_VERSION}`;

export type WorkspaceSandboxHealthStatus = "healthy" | "unavailable" | "misconfigured";

export type WorkspaceSandboxHealthCode =
	| "ready"
	| "unsupported"
	| "dependencies-unavailable"
	| "package-invalid"
	| "probe-failed"
	| "self-test-failed"
	| "self-test-incomplete";

export type WorkspaceSandboxHealthMode = "readiness" | "self-test";

export type WorkspaceSandboxCheckStatus = "passed" | "failed" | "skipped";

export type WorkspaceSandboxCheckId =
	| "platform"
	| "package"
	| "dependencies"
	| "sandbox-startup"
	| "filesystem-permitted"
	| "filesystem-denied"
	| "network-denied";

export type WorkspaceSandboxCheckReason =
	| "not-applicable"
	| "not-run"
	| "readiness-failed"
	| "unsupported-platform"
	| "unsupported-architecture"
	| "helper-missing"
	| "helper-invalid"
	| "dependency-unavailable"
	| "probe-failed"
	| "sandbox-start-failed"
	| "sandbox-unavailable"
	| "workspace-write-failed"
	| "outside-read-not-denied"
	| "network-probe-unavailable"
	| "network-not-denied";

export type WorkspaceSandboxRecoveryAction = "install-windows-sandbox" | "check-app-update";

export interface WorkspaceSandboxCheck {
	readonly id: WorkspaceSandboxCheckId;
	readonly status: WorkspaceSandboxCheckStatus;
	readonly reason?: WorkspaceSandboxCheckReason;
}

export interface WorkspaceSandboxHealthReport {
	readonly status: WorkspaceSandboxHealthStatus;
	readonly code: WorkspaceSandboxHealthCode;
	readonly mode: WorkspaceSandboxHealthMode;
	readonly checkedAt: string;
	readonly platform: NodeJS.Platform;
	readonly checks: readonly WorkspaceSandboxCheck[];
	readonly recoveryActions: readonly WorkspaceSandboxRecoveryAction[];
	/** Internal diagnostics. Never forwarded over the app protocol. */
	readonly details: readonly string[];
}

export interface SandboxHealthReportInput {
	readonly status: WorkspaceSandboxHealthStatus;
	readonly code: WorkspaceSandboxHealthCode;
	readonly mode: WorkspaceSandboxHealthMode;
	readonly platform: NodeJS.Platform;
	readonly checkedAt?: string;
	readonly checks: readonly WorkspaceSandboxCheck[];
	readonly recoveryActions?: readonly WorkspaceSandboxRecoveryAction[];
	readonly details?: readonly string[];
}

type SandboxHelperKind = "seccomp" | "srt-win";

interface SandboxRuntimeManifestHelper {
	readonly kind: SandboxHelperKind;
	readonly architecture: string;
	readonly file: string;
	readonly sha256: string;
	readonly executable: boolean;
}

interface SandboxRuntimeManifest {
	readonly schemaVersion: 1;
	readonly package: "@anthropic-ai/sandbox-runtime";
	readonly version: typeof SANDBOX_RUNTIME_VERSION;
	readonly helpers: readonly SandboxRuntimeManifestHelper[];
}

export interface WorkspaceSandboxHealthDependencies {
	readonly platform: NodeJS.Platform;
	readonly architecture: string;
	readonly packageDir: string;
	readonly isSupportedPlatform: () => boolean;
	readonly checkDependencies: (helperPath?: string) => Promise<SandboxDependencyCheck>;
	readonly now?: () => Date;
}

export function createSandboxHealthReport(input: SandboxHealthReportInput): WorkspaceSandboxHealthReport {
	return Object.freeze({
		status: input.status,
		code: input.code,
		mode: input.mode,
		checkedAt: input.checkedAt ?? new Date().toISOString(),
		platform: input.platform,
		checks: Object.freeze(input.checks.map((check) => Object.freeze({ ...check }))),
		recoveryActions: Object.freeze([...(input.recoveryActions ?? [])]),
		details: Object.freeze([...(input.details ?? [])]),
	});
}

function check(
	id: WorkspaceSandboxCheckId,
	status: WorkspaceSandboxCheckStatus,
	reason?: WorkspaceSandboxCheckReason,
): WorkspaceSandboxCheck {
	return Object.freeze(reason ? { id, status, reason } : { id, status });
}

export function skippedSandboxChecks(
	ids: readonly WorkspaceSandboxCheckId[],
	reason: WorkspaceSandboxCheckReason,
): WorkspaceSandboxCheck[] {
	return ids.map((id) => check(id, "skipped", reason));
}

export function readinessRecoveryActions(
	code: WorkspaceSandboxHealthCode,
	platform: NodeJS.Platform,
): WorkspaceSandboxRecoveryAction[] {
	if (platform === "win32" && code === "dependencies-unavailable") {
		return ["install-windows-sandbox", "check-app-update"];
	}
	if (code === "package-invalid" || code === "probe-failed") return ["check-app-update"];
	return [];
}

export function selfTestRecoveryActions(
	checks: readonly WorkspaceSandboxCheck[],
	platform: NodeJS.Platform,
): WorkspaceSandboxRecoveryAction[] {
	if (!checks.some((candidate) => candidate.status === "failed")) return [];
	// srt-win can repair its account ACLs and WFP egress fence. Every desktop
	// platform can also re-download a verified runtime through the app updater.
	return platform === "win32" ? ["install-windows-sandbox", "check-app-update"] : ["check-app-update"];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseManifest(path: string): SandboxRuntimeManifest {
	const metadata = lstatSync(path);
	if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 64 * 1024) {
		throw new TypeError("Sandbox runtime manifest is invalid");
	}
	const value: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		value.package !== "@anthropic-ai/sandbox-runtime" ||
		value.version !== SANDBOX_RUNTIME_VERSION ||
		!Array.isArray(value.helpers)
	) {
		throw new TypeError("Sandbox runtime manifest is invalid");
	}
	for (const helper of value.helpers) {
		if (
			!isRecord(helper) ||
			(helper.kind !== "seccomp" && helper.kind !== "srt-win") ||
			typeof helper.architecture !== "string" ||
			typeof helper.file !== "string" ||
			!/^[a-f0-9]{64}$/u.test(String(helper.sha256)) ||
			typeof helper.executable !== "boolean"
		) {
			throw new TypeError("Sandbox runtime manifest helper is invalid");
		}
	}
	return value as unknown as SandboxRuntimeManifest;
}

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sandboxRuntimeRoots(packageDir: string): readonly string[] {
	const root = packageDir.replace(/\.asar([\\/])/u, ".asar.unpacked$1");
	return [join(root, "vendor", "sandbox-runtime"), join(root, "dist", "vendor", "sandbox-runtime")];
}

function inspectBundledHelper(input: {
	readonly packageDir: string;
	readonly architecture: string;
	readonly kind: SandboxHelperKind;
}):
	| { readonly ok: true; readonly path: string }
	| {
			readonly ok: false;
			readonly reason: string;
			readonly checkReason: "helper-missing" | "helper-invalid";
	  } {
	const root = sandboxRuntimeRoots(input.packageDir).find((candidate) => existsSync(join(candidate, "manifest.json")));
	if (!root) return { ok: false, reason: "Sandbox runtime manifest is missing", checkReason: "helper-missing" };
	try {
		const manifest = parseManifest(join(root, "manifest.json"));
		const executable = input.kind === "seccomp" ? "apply-seccomp" : "srt-win.exe";
		const relativePath = `${input.kind}/${input.architecture}/${executable}`;
		const helper = manifest.helpers.find(
			(entry) =>
				entry.kind === input.kind && entry.architecture === input.architecture && entry.file === relativePath,
		);
		if (!helper || helper.executable !== (input.kind === "seccomp")) {
			return {
				ok: false,
				reason: "Sandbox runtime manifest does not contain the required helper",
				checkReason: "helper-missing",
			};
		}
		const path = join(root, ...relativePath.split("/"));
		const metadata = lstatSync(path);
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			return { ok: false, reason: "Sandbox runtime helper is not a regular file", checkReason: "helper-invalid" };
		}
		if (input.kind === "seccomp" && (metadata.mode & 0o111) === 0) {
			return { ok: false, reason: "Sandbox runtime helper is not executable", checkReason: "helper-invalid" };
		}
		if (sha256(path) !== helper.sha256) {
			return {
				ok: false,
				reason: "Sandbox runtime helper digest does not match the manifest",
				checkReason: "helper-invalid",
			};
		}
		return { ok: true, path };
	} catch {
		return { ok: false, reason: "Sandbox runtime package could not be verified", checkReason: "helper-invalid" };
	}
}

export function bundledSandboxHelperPath(kind: SandboxHelperKind): string {
	const result = inspectBundledHelper({ packageDir: getPackageDir(), architecture: process.arch, kind });
	if (!result.ok) throw new Error(result.reason);
	return result.path;
}

export function createWorkspaceSandboxHealthProbe(
	dependencies: WorkspaceSandboxHealthDependencies,
): () => Promise<WorkspaceSandboxHealthReport> {
	return async () => {
		const checkedAt = (dependencies.now ?? (() => new Date()))().toISOString();
		const report = (
			status: WorkspaceSandboxHealthStatus,
			code: WorkspaceSandboxHealthCode,
			checks: readonly WorkspaceSandboxCheck[],
			details: readonly string[] = [],
		) =>
			createSandboxHealthReport({
				status,
				code,
				mode: "readiness",
				platform: dependencies.platform,
				checkedAt,
				checks,
				recoveryActions: readinessRecoveryActions(code, dependencies.platform),
				details,
			});

		if (!(["darwin", "linux", "win32"] as const).includes(dependencies.platform as "darwin" | "linux" | "win32")) {
			return report(
				"unavailable",
				"unsupported",
				[check("platform", "failed", "unsupported-platform")],
				["Unsupported platform"],
			);
		}
		if (!(["arm64", "x64"] as const).includes(dependencies.architecture as "arm64" | "x64")) {
			return report(
				"unavailable",
				"unsupported",
				[check("platform", "failed", "unsupported-architecture")],
				["Unsupported architecture"],
			);
		}
		if (!dependencies.isSupportedPlatform()) {
			return report(
				"unavailable",
				"unsupported",
				[check("platform", "failed", "unsupported-platform")],
				["Sandbox runtime reports an unsupported platform"],
			);
		}

		const platformCheck = check("platform", "passed");
		const kind =
			dependencies.platform === "linux" ? "seccomp" : dependencies.platform === "win32" ? "srt-win" : undefined;
		let helperPath: string | undefined;
		let packageCheck: WorkspaceSandboxCheck;
		if (!kind) {
			packageCheck = check("package", "skipped", "not-applicable");
		} else {
			const helper = inspectBundledHelper({
				packageDir: dependencies.packageDir,
				architecture: dependencies.architecture,
				kind,
			});
			if (!helper.ok) {
				return report(
					"misconfigured",
					"package-invalid",
					[
						platformCheck,
						check("package", "failed", helper.checkReason),
						check("dependencies", "skipped", "readiness-failed"),
					],
					[helper.reason],
				);
			}
			helperPath = helper.path;
			packageCheck = check("package", "passed");
		}

		try {
			const checked = await dependencies.checkDependencies(helperPath);
			if (checked.errors.length > 0) {
				return report(
					"unavailable",
					"dependencies-unavailable",
					[platformCheck, packageCheck, check("dependencies", "failed", "dependency-unavailable")],
					checked.errors,
				);
			}
			return report(
				"healthy",
				"ready",
				[platformCheck, packageCheck, check("dependencies", "passed")],
				checked.warnings,
			);
		} catch {
			return report(
				"misconfigured",
				"probe-failed",
				[platformCheck, packageCheck, check("dependencies", "failed", "probe-failed")],
				["Sandbox dependency probe failed"],
			);
		}
	};
}

export const workspaceSandboxHealth = createWorkspaceSandboxHealthProbe({
	platform: process.platform,
	architecture: process.arch,
	packageDir: getPackageDir(),
	isSupportedPlatform: () => true,
	checkDependencies: async (helperPath) => {
		const runtime = await import("@anthropic-ai/sandbox-runtime");
		if (!runtime.SandboxManager.isSupportedPlatform()) {
			return { errors: ["Unsupported platform"], warnings: [] };
		}
		if (process.platform === "win32") {
			if (!helperPath) throw new Error("Sandbox runtime helper is missing");
			const srtWin = runtime.resolveSrtWin({ path: helperPath });
			const checked = await runtime.checkWindowsDependenciesAsync({ srtWin });
			if (checked.errors.length === 0) await runtime.verifyWindowsWfpEgress({ srtWin });
			return checked;
		}
		return runtime.SandboxManager.checkDependenciesAsync();
	},
});
