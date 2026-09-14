import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SandboxDependencyCheck } from "@anthropic-ai/sandbox-runtime";
import { getPackageDir } from "../config.ts";

export const SANDBOX_RUNTIME_VERSION = "0.0.67";
export const SANDBOX_RUNTIME_ID = `@anthropic-ai/sandbox-runtime@${SANDBOX_RUNTIME_VERSION}`;

export type WorkspaceSandboxHealthStatus = "healthy" | "unavailable" | "misconfigured";

export interface WorkspaceSandboxHealthReport {
	readonly status: WorkspaceSandboxHealthStatus;
	readonly code: "ready" | "unsupported" | "dependencies-unavailable" | "package-invalid" | "probe-failed";
	readonly details: readonly string[];
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
}

function report(
	status: WorkspaceSandboxHealthStatus,
	code: WorkspaceSandboxHealthReport["code"],
	details: readonly string[] = [],
): WorkspaceSandboxHealthReport {
	return Object.freeze({ status, code, details: Object.freeze([...details]) });
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
}): { readonly ok: true; readonly path: string } | { readonly ok: false; readonly reason: string } {
	const root = sandboxRuntimeRoots(input.packageDir).find((candidate) => existsSync(join(candidate, "manifest.json")));
	if (!root) return { ok: false, reason: "Sandbox runtime manifest is missing" };
	try {
		const manifest = parseManifest(join(root, "manifest.json"));
		const executable = input.kind === "seccomp" ? "apply-seccomp" : "srt-win.exe";
		const relativePath = `${input.kind}/${input.architecture}/${executable}`;
		const helper = manifest.helpers.find(
			(entry) =>
				entry.kind === input.kind && entry.architecture === input.architecture && entry.file === relativePath,
		);
		if (!helper || helper.executable !== (input.kind === "seccomp")) {
			return { ok: false, reason: "Sandbox runtime manifest does not contain the required helper" };
		}
		const path = join(root, ...relativePath.split("/"));
		const metadata = lstatSync(path);
		if (!metadata.isFile() || metadata.isSymbolicLink()) {
			return { ok: false, reason: "Sandbox runtime helper is not a regular file" };
		}
		if (input.kind === "seccomp" && (metadata.mode & 0o111) === 0) {
			return { ok: false, reason: "Sandbox runtime helper is not executable" };
		}
		if (sha256(path) !== helper.sha256) {
			return { ok: false, reason: "Sandbox runtime helper digest does not match the manifest" };
		}
		return { ok: true, path };
	} catch {
		return { ok: false, reason: "Sandbox runtime package could not be verified" };
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
		if (
			!(["darwin", "linux", "win32"] as const).includes(dependencies.platform as "darwin" | "linux" | "win32") ||
			!(["arm64", "x64"] as const).includes(dependencies.architecture as "arm64" | "x64") ||
			!dependencies.isSupportedPlatform()
		) {
			return report("unavailable", "unsupported");
		}
		const kind =
			dependencies.platform === "linux" ? "seccomp" : dependencies.platform === "win32" ? "srt-win" : undefined;
		let helperPath: string | undefined;
		if (kind) {
			const helper = inspectBundledHelper({
				packageDir: dependencies.packageDir,
				architecture: dependencies.architecture,
				kind,
			});
			if (!helper.ok) return report("misconfigured", "package-invalid", [helper.reason]);
			helperPath = helper.path;
		}
		try {
			const checked = await dependencies.checkDependencies(helperPath);
			if (checked.errors.length > 0) {
				return report("unavailable", "dependencies-unavailable", checked.errors);
			}
			return report("healthy", "ready", checked.warnings);
		} catch {
			return report("misconfigured", "probe-failed");
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
