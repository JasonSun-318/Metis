import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ spawnProcess: vi.fn() }));

vi.mock("../src/utils/child-process.ts", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/utils/child-process.ts")>()),
	spawnProcess: mocks.spawnProcess,
}));

import { createWorkspaceSandbox, WorkspaceSandboxError } from "../src/core/workspace-sandbox.ts";

const originalPlatform = process.platform;

type FakeBroker = ChildProcess & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };

function fakeBroker(onRequest: (request: Record<string, unknown>, child: FakeBroker) => void): FakeBroker {
	const child = new EventEmitter() as FakeBroker;
	child.stdin = new PassThrough();
	child.stdout = new PassThrough();
	child.stderr = new PassThrough();
	let input = "";
	child.stdin.on("data", (chunk: Buffer) => {
		input += chunk.toString();
		let newline = input.indexOf("\n");
		while (newline !== -1) {
			const request = JSON.parse(input.slice(0, newline)) as Record<string, unknown>;
			input = input.slice(newline + 1);
			onRequest(request, child);
			newline = input.indexOf("\n");
		}
	});
	return child;
}

function respond(child: FakeBroker, value: unknown): void {
	child.stdout.write(`${JSON.stringify(value)}\n`);
}

describe("workspace sandbox parent fail-closed behavior", () => {
	const roots: string[] = [];
	const cwd = () => {
		const value = mkdtempSync(join(tmpdir(), "metis-sandbox-parent-test-"));
		roots.push(value);
		return value;
	};

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllEnvs();
		Object.defineProperty(process, "platform", { value: originalPlatform });
		mocks.spawnProcess.mockReset();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("does not spawn a broker merely by importing the host module", () => {
		expect(mocks.spawnProcess).not.toHaveBeenCalled();
	});

	it("preserves Windows profile directories without forwarding unrelated secrets", async () => {
		vi.stubEnv("LOCALAPPDATA", "C:\\Users\\tester\\AppData\\Local");
		vi.stubEnv("APPDATA", "C:\\Users\\tester\\AppData\\Roaming");
		vi.stubEnv("METIS_SANDBOX_TEST_SECRET", "must-not-reach-broker");
		let commandEnvironment: unknown;
		mocks.spawnProcess.mockReturnValue(
			fakeBroker((request, child) => {
				if (request.type === "init") respond(child, { type: "ready" });
				if (request.type === "exec") {
					commandEnvironment = request.env;
					respond(child, { type: "result", id: request.id, exitCode: 0 });
				}
			}),
		);
		const root = cwd();
		const sandbox = await createWorkspaceSandbox({ cwd: root, workspaceRoots: [root] });
		await sandbox.operations.exec("echo ready", root, { onData: () => {} });
		for (const environment of [mocks.spawnProcess.mock.calls[0][2].env, commandEnvironment]) {
			expect(environment).toMatchObject({
				LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local",
				APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
			});
			expect(environment).not.toHaveProperty("METIS_SANDBOX_TEST_SECRET");
		}
		sandbox.forceDispose();
	});

	it("sends the complete immutable filesystem and network profile before readiness", async () => {
		let initialization: Record<string, unknown> | undefined;
		mocks.spawnProcess.mockReturnValue(
			fakeBroker((request, child) => {
				if (request.type === "init") {
					initialization = request;
					respond(child, { type: "ready" });
				}
			}),
		);
		const root = cwd();
		const protectedRoot = join(realpathSync(root), ".git");
		const sandbox = await createWorkspaceSandbox({
			cwd: root,
			workspaceRoots: [root],
			readOnlyRoots: [join(root, "read")],
			writeRoots: [join(root, "write")],
			writeProtectedRoots: [protectedRoot],
			networkEndpoints: [{ hostname: "api.example.com", port: 443 }],
			workspaceReadOnly: true,
		});

		expect(initialization).toMatchObject({
			type: "init",
			writeProtectedRoots: [protectedRoot],
			networkEndpoints: [{ hostname: "api.example.com", port: 443 }],
			workspaceReadOnly: true,
		});
		sandbox.forceDispose();
	});

	it("rejects malformed broker output", async () => {
		mocks.spawnProcess.mockReturnValue(
			fakeBroker((_request, child) => {
				queueMicrotask(() => child.stdout.write("{\n"));
			}),
		);
		const root = cwd();
		await expect(createWorkspaceSandbox({ cwd: root, workspaceRoots: [root] })).rejects.toMatchObject({
			code: "SANDBOX_PROTOCOL",
		});
	});

	it("rejects an early broker exit", async () => {
		mocks.spawnProcess.mockReturnValue(
			fakeBroker((_request, child) => {
				queueMicrotask(() => child.emit("exit", 1));
			}),
		);
		const root = cwd();
		await expect(createWorkspaceSandbox({ cwd: root, workspaceRoots: [root] })).rejects.toMatchObject({
			code: "SANDBOX_CLOSED",
		});
	});

	it("allows Windows initialization to finish after the ordinary control deadline", async () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		vi.useFakeTimers();
		mocks.spawnProcess.mockReturnValue(
			fakeBroker((request, child) => {
				if (request.type === "init") setTimeout(() => respond(child, { type: "ready" }), 8_600);
			}),
		);
		const root = cwd();
		const pending = createWorkspaceSandbox({ cwd: root, workspaceRoots: [root] }).then(
			(sandbox) => ({ sandbox }),
			(error: unknown) => ({ error }),
		);
		await vi.advanceTimersByTimeAsync(8_600);
		const result = await pending;
		expect(result).toHaveProperty("sandbox.operations.exec");
		if ("sandbox" in result) result.sandbox.forceDispose();
	});

	it.each([
		{ platform: "linux", timeout: 5_000 },
		{ platform: "win32", timeout: 30_000 },
	])("bounds $platform initialization without falling back to local execution", async ({ platform, timeout }) => {
		Object.defineProperty(process, "platform", { value: platform });
		vi.useFakeTimers();
		mocks.spawnProcess.mockReturnValue(fakeBroker(() => {}));
		const root = cwd();
		const pending = createWorkspaceSandbox({ cwd: root, workspaceRoots: [root] });
		const assertion = expect(pending).rejects.toBeInstanceOf(WorkspaceSandboxError);
		await vi.advanceTimersByTimeAsync(timeout);
		await assertion;
		expect(mocks.spawnProcess).toHaveBeenCalledOnce();
	});

	it("keeps Windows shutdown bounded by the ordinary control deadline", async () => {
		Object.defineProperty(process, "platform", { value: "win32" });
		vi.useFakeTimers();
		mocks.spawnProcess.mockReturnValue(
			fakeBroker((request, child) => {
				if (request.type === "init") respond(child, { type: "ready" });
			}),
		);
		const root = cwd();
		const sandbox = await createWorkspaceSandbox({ cwd: root, workspaceRoots: [root] });
		const assertion = expect(sandbox.dispose()).rejects.toThrow("Sandbox shutdown timed out");
		await vi.advanceTimersByTimeAsync(5_000);
		await assertion;
	});

	it("closes after a duplicate result id instead of accepting another command", async () => {
		mocks.spawnProcess.mockReturnValue(
			fakeBroker((request, child) => {
				if (request.type === "init") respond(child, { type: "ready" });
				if (request.type === "exec") {
					respond(child, { type: "result", id: request.id, exitCode: 0 });
					queueMicrotask(() => respond(child, { type: "result", id: request.id, exitCode: 0 }));
				}
			}),
		);
		const root = cwd();
		const sandbox = await createWorkspaceSandbox({ cwd: root, workspaceRoots: [root] });
		await expect(sandbox.operations.exec("pwd", root, { onData: () => {} })).resolves.toEqual({ exitCode: 0 });
		await new Promise((resolve) => setImmediate(resolve));
		await expect(sandbox.operations.exec("pwd", root, { onData: () => {} })).rejects.toMatchObject({
			code: "SANDBOX_CLOSED",
		});
		await sandbox.dispose();
	});
});
