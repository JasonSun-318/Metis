import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
	createWorkspaceSandboxSelfTest,
	type WorkspaceSandbox,
	type WorkspaceSandboxNetworkTarget,
} from "../../src/core/workspace-sandbox.ts";
import { createSandboxHealthReport } from "../../src/core/workspace-sandbox-health.ts";

const checkedAt = "2026-10-29T08:00:00.000Z";

function readiness(overrides: Partial<Parameters<typeof createSandboxHealthReport>[0]> = {}) {
	return createSandboxHealthReport({
		status: "healthy",
		code: "ready",
		mode: "readiness",
		platform: "linux",
		checkedAt,
		checks: [
			{ id: "platform", status: "passed" },
			{ id: "package", status: "passed" },
			{ id: "dependencies", status: "passed" },
		],
		...overrides,
	});
}

function fakeSandbox(respond: (command: string) => { exitCode: number | null; output?: string; throw?: boolean }): {
	sandbox: WorkspaceSandbox;
	dispose: ReturnType<typeof vi.fn>;
} {
	const dispose = vi.fn(async () => {});
	const sandbox = {
		operations: {
			exec: vi.fn(async (command: string, _cwd: string, options: { onData: (data: Buffer) => void }) => {
				const result = respond(command);
				if (result.throw) throw new Error("sandbox died");
				if (result.output) options.onData(Buffer.from(result.output));
				return { exitCode: result.exitCode };
			}),
		},
		dispose,
		forceDispose: vi.fn(),
	} as unknown as WorkspaceSandbox;
	return { sandbox, dispose };
}

function harness(
	input: {
		readonly readinessReport?: ReturnType<typeof readiness>;
		readonly sandbox?: WorkspaceSandbox;
		readonly network?: WorkspaceSandboxNetworkTarget;
		readonly createSandboxError?: Error;
	} = {},
) {
	const removed: string[] = [];
	const closed = vi.fn(async () => {});
	const createSandbox = vi.fn(async () => {
		if (input.createSandboxError) throw input.createSandboxError;
		return input.sandbox!;
	});
	const selfTest = createWorkspaceSandboxSelfTest({
		readiness: async () => input.readinessReport ?? readiness(),
		createSandbox: createSandbox as never,
		createFixture: (prefix) => realpathSync(mkdtempSync(join(tmpdir(), prefix))),
		removeFixture: (path) => {
			removed.push(path);
			rmSync(path, { recursive: true, force: true });
		},
		createNetworkTarget: async () => input.network ?? { port: 60090, hits: () => 0, close: closed },
		now: () => new Date(checkedAt),
		platform: "linux",
	});
	return { selfTest, createSandbox, removed, closed };
}

describe("workspace sandbox self-test", () => {
	it("marks every behavior check as skipped when readiness has not passed", async () => {
		const { selfTest, createSandbox, removed } = harness({
			readinessReport: readiness({
				status: "unavailable",
				code: "dependencies-unavailable",
				checks: [
					{ id: "platform", status: "passed" },
					{ id: "package", status: "passed" },
					{ id: "dependencies", status: "failed", reason: "dependency-unavailable" },
				],
			}),
		});

		const report = await selfTest();

		expect(createSandbox).not.toHaveBeenCalled();
		expect(removed).toEqual([]);
		expect(report).toMatchObject({ mode: "self-test", status: "unavailable", code: "dependencies-unavailable" });
		expect(
			report.checks.filter((check) =>
				["sandbox-startup", "filesystem-permitted", "filesystem-denied", "network-denied"].includes(check.id),
			),
		).toEqual([
			{ id: "sandbox-startup", status: "skipped", reason: "readiness-failed" },
			{ id: "filesystem-permitted", status: "skipped", reason: "readiness-failed" },
			{ id: "filesystem-denied", status: "skipped", reason: "readiness-failed" },
			{ id: "network-denied", status: "skipped", reason: "readiness-failed" },
		]);
	});

	it("reports startup failure as failed and never counts the rest as passed", async () => {
		const { selfTest, removed } = harness({ createSandboxError: new Error("broker failed") });

		const report = await selfTest();

		expect(removed).toHaveLength(1);
		expect(removed.every((path) => !existsSync(path))).toBe(true);
		expect(report.status).toBe("misconfigured");
		expect(report.code).toBe("self-test-failed");
		expect(report.recoveryActions).toEqual(["check-app-update"]);
		expect(report.checks).toEqual([
			{ id: "platform", status: "passed" },
			{ id: "package", status: "passed" },
			{ id: "dependencies", status: "passed" },
			{ id: "sandbox-startup", status: "failed", reason: "sandbox-start-failed" },
			{ id: "filesystem-permitted", status: "skipped", reason: "sandbox-unavailable" },
			{ id: "filesystem-denied", status: "skipped", reason: "sandbox-unavailable" },
			{ id: "network-denied", status: "skipped", reason: "sandbox-unavailable" },
		]);
	});

	it("runs permitted, denied, and network probes and always cleans up", async () => {
		const { sandbox, dispose } = fakeSandbox((command) => {
			if (command.startsWith("printf")) return { exitCode: 0, output: "metis-sandbox-probe" };
			if (command.startsWith("cat")) return { exitCode: 1 };
			return { exitCode: 7 };
		});
		const { selfTest, removed, closed } = harness({ sandbox });

		const report = await selfTest();

		expect(report).toMatchObject({ status: "healthy", code: "ready" });
		expect(report.checks.slice(-4)).toEqual([
			{ id: "sandbox-startup", status: "passed" },
			{ id: "filesystem-permitted", status: "passed" },
			{ id: "filesystem-denied", status: "passed" },
			{ id: "network-denied", status: "passed" },
		]);
		expect(dispose).toHaveBeenCalledOnce();
		expect(closed).toHaveBeenCalledOnce();
		expect(removed).toHaveLength(2);
		expect(removed.every((path) => !existsSync(path))).toBe(true);
	});

	it("does not treat a missing curl as a passed network check", async () => {
		const { sandbox } = fakeSandbox((command) => {
			if (command.startsWith("printf")) return { exitCode: 0, output: "metis-sandbox-probe" };
			if (command.startsWith("cat")) return { exitCode: 1 };
			return { exitCode: 127, output: "bash: curl: command not found" };
		});
		const { selfTest } = harness({ sandbox });

		const report = await selfTest();

		expect(report.code).toBe("self-test-incomplete");
		expect(report.checks.at(-1)).toEqual({
			id: "network-denied",
			status: "skipped",
			reason: "network-probe-unavailable",
		});
	});

	it("accepts a proxy 403 as a proven network denial", async () => {
		const { sandbox } = fakeSandbox((command) => {
			if (command.startsWith("printf")) return { exitCode: 0, output: "metis-sandbox-probe" };
			if (command.startsWith("cat")) return { exitCode: 1 };
			return { exitCode: 22, output: "curl: (22) The requested URL returned error: 403" };
		});
		const { selfTest } = harness({ sandbox });

		const report = await selfTest();

		expect(report).toMatchObject({ status: "healthy", code: "ready" });
		expect(report.checks.at(-1)).toEqual({ id: "network-denied", status: "passed" });
	});

	it("fails the network check on an unexpected curl error", async () => {
		const { sandbox } = fakeSandbox((command) => {
			if (command.startsWith("printf")) return { exitCode: 0, output: "metis-sandbox-probe" };
			if (command.startsWith("cat")) return { exitCode: 1 };
			return { exitCode: 2, output: "curl: option : blank argument where content is expected" };
		});
		const { selfTest } = harness({ sandbox });

		const report = await selfTest();

		expect(report.status).toBe("misconfigured");
		expect(report.code).toBe("self-test-failed");
		expect(report.checks.at(-1)).toEqual({
			id: "network-denied",
			status: "failed",
			reason: "probe-failed",
		});
	});

	it("fails the network check when the probe is terminated without an exit code", async () => {
		const { sandbox } = fakeSandbox((command) => {
			if (command.startsWith("printf")) return { exitCode: 0, output: "metis-sandbox-probe" };
			if (command.startsWith("cat")) return { exitCode: 1 };
			return { exitCode: null };
		});
		const { selfTest } = harness({ sandbox });

		const report = await selfTest();

		expect(report.status).toBe("misconfigured");
		expect(report.checks.at(-1)).toEqual({
			id: "network-denied",
			status: "failed",
			reason: "probe-failed",
		});
	});

	it("fails the network check when the local listener receives the request", async () => {
		let hits = 0;
		const { sandbox } = fakeSandbox((command) => {
			if (command.startsWith("printf")) return { exitCode: 0, output: "metis-sandbox-probe" };
			if (command.startsWith("cat")) return { exitCode: 1 };
			hits += 1;
			return { exitCode: 0, output: "metis-sandbox-network-probe" };
		});
		const { selfTest } = harness({
			sandbox,
			network: { port: 60090, hits: () => hits, close: async () => {} },
		});

		const report = await selfTest();

		expect(report.status).toBe("misconfigured");
		expect(report.code).toBe("self-test-failed");
		expect(report.checks.at(-1)).toEqual({
			id: "network-denied",
			status: "failed",
			reason: "network-not-denied",
		});
	});
});
