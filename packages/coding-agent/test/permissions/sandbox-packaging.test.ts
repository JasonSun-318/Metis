import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WorkspaceSandbox } from "../../src/core/workspace-sandbox.ts";
import {
	createWorkspaceSandboxHealthProbe,
	type WorkspaceSandboxHealthDependencies,
} from "../../src/core/workspace-sandbox-health.ts";

describe("packaged workspace sandbox health", () => {
	let root: string;
	let packageDir: string;

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "metis-sandbox-package-"));
		packageDir = join(root, "coding-agent");
		const result = spawnSync(
			process.execPath,
			[
				fileURLToPath(new URL("../../../../scripts/stage-coding-agent-native-tools.mjs", import.meta.url)),
				"--sandbox-only",
				"--target",
				"all",
				"--output",
				join(packageDir, "dist", "vendor", "tools"),
			],
			{ encoding: "utf8", timeout: 30_000 },
		);
		if (result.status !== 0) throw new Error(result.stderr || result.stdout || "Sandbox staging failed");
	});

	afterAll(() => rmSync(root, { recursive: true, force: true }));

	const dependencies = (
		overrides: Partial<WorkspaceSandboxHealthDependencies> = {},
	): WorkspaceSandboxHealthDependencies => ({
		platform: "linux",
		architecture: "x64",
		packageDir,
		isSupportedPlatform: () => true,
		checkDependencies: async () => ({ errors: [], warnings: [] }),
		...overrides,
	});

	it("stages a versioned manifest and both architecture helpers without network downloads", () => {
		const runtime = join(packageDir, "dist", "vendor", "sandbox-runtime");
		const manifest = JSON.parse(readFileSync(join(runtime, "manifest.json"), "utf8")) as {
			version: string;
			helpers: Array<{ kind: string; architecture: string; sha256: string }>;
		};
		expect(manifest.version).toBe("0.0.67");
		expect(manifest.helpers).toHaveLength(4);
		for (const architecture of ["x64", "arm64"]) {
			const seccomp = join(runtime, "seccomp", architecture, "apply-seccomp");
			const windows = join(runtime, "srt-win", architecture, "srt-win.exe");
			expect(statSync(seccomp).isFile()).toBe(true);
			expect(statSync(seccomp).mode & 0o111).not.toBe(0);
			expect(statSync(windows).isFile()).toBe(true);
		}
		expect(manifest.helpers.every((helper) => /^[a-f0-9]{64}$/u.test(helper.sha256))).toBe(true);
	});

	it("reports healthy, unavailable, and misconfigured states without executing a user command", async () => {
		const healthy = await createWorkspaceSandboxHealthProbe(dependencies())();
		expect(healthy).toMatchObject({ status: "healthy", code: "ready", mode: "readiness", platform: "linux" });
		expect(healthy.checks).toEqual([
			{ id: "platform", status: "passed" },
			{ id: "package", status: "passed" },
			{ id: "dependencies", status: "passed" },
		]);
		expect(Date.parse(healthy.checkedAt)).not.toBeNaN();

		const unsupported = await createWorkspaceSandboxHealthProbe(dependencies({ isSupportedPlatform: () => false }))();
		expect(unsupported).toMatchObject({ status: "unavailable", code: "unsupported" });
		expect(unsupported.checks).toEqual([{ id: "platform", status: "failed", reason: "unsupported-platform" }]);

		const unavailable = await createWorkspaceSandboxHealthProbe(
			dependencies({ checkDependencies: async () => ({ errors: ["bubblewrap unavailable"], warnings: [] }) }),
		)();
		expect(unavailable).toMatchObject({
			status: "unavailable",
			code: "dependencies-unavailable",
			recoveryActions: [],
		});
		expect(unavailable.checks.at(-1)).toEqual({
			id: "dependencies",
			status: "failed",
			reason: "dependency-unavailable",
		});

		const seccomp = join(packageDir, "dist", "vendor", "sandbox-runtime", "seccomp", "x64", "apply-seccomp");
		chmodSync(seccomp, 0o644);
		try {
			const invalid = await createWorkspaceSandboxHealthProbe(dependencies())();
			expect(invalid).toMatchObject({ status: "misconfigured", code: "package-invalid" });
			expect(invalid.checks).toEqual([
				{ id: "platform", status: "passed" },
				{ id: "package", status: "failed", reason: "helper-invalid" },
				{ id: "dependencies", status: "skipped", reason: "readiness-failed" },
			]);
			expect(invalid.recoveryActions).toEqual(["check-app-update"]);
		} finally {
			chmodSync(seccomp, 0o755);
		}
		expect(WorkspaceSandbox.health).toBeTypeOf("function");
		expect(WorkspaceSandbox.selfTest).toBeTypeOf("function");
	});
});
