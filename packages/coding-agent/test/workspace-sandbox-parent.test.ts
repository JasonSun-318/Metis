import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
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
		const value = mkdtempSync(join(tmpdir(), "arcmind-sandbox-parent-test-"));
		roots.push(value);
		return value;
	};

	afterEach(() => {
		vi.useRealTimers();
		mocks.spawnProcess.mockReset();
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("does not spawn a broker merely by importing the host module", () => {
		expect(mocks.spawnProcess).not.toHaveBeenCalled();
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

	it("times out initialization without falling back to local execution", async () => {
		vi.useFakeTimers();
		mocks.spawnProcess.mockReturnValue(fakeBroker(() => {}));
		const root = cwd();
		const pending = createWorkspaceSandbox({ cwd: root, workspaceRoots: [root] });
		const assertion = expect(pending).rejects.toBeInstanceOf(WorkspaceSandboxError);
		await vi.advanceTimersByTimeAsync(5_000);
		await assertion;
		expect(mocks.spawnProcess).toHaveBeenCalledOnce();
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
