import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTempDir } from "./session-test-utils.ts";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: spawnMock };
});

import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";

class FakeStream extends EventEmitter {
	setEncoding = vi.fn();
	destroy = vi.fn();
}

class FakeChild extends EventEmitter {
	pid: number | undefined = 4242;
	stdout = new FakeStream();
	stderr = new FakeStream();
	stdin = undefined;
	kill = vi.fn(() => true);
	unref = vi.fn();
}

function useChild(child: FakeChild): FakeChild {
	spawnMock.mockReturnValue(child);
	return child;
}

function execute(env: NodeExecutionEnv, timeout?: number) {
	return env.exec("ignored command", timeout === undefined ? undefined : { timeout });
}

async function waitForExecListeners(child: FakeChild): Promise<void> {
	await vi.waitFor(() => {
		expect(child.stdout.listenerCount("data")).toBe(1);
		expect(child.stderr.listenerCount("data")).toBe(1);
	});
}

afterEach(() => {
	spawnMock.mockReset();
	vi.restoreAllMocks();
});

describe("NodeExecutionEnv command termination compatibility", () => {
	it("settles a timeout without waiting for a close event and detaches stream listeners", async () => {
		const killSpy = vi.spyOn(process, "kill").mockReturnValue(true);
		const env = new NodeExecutionEnv({ cwd: createTempDir(), shellPath: process.execPath });
		const child = useChild(new FakeChild());

		const resultPromise = execute(env, 0.01);
		await waitForExecListeners(child);
		await vi.waitFor(() => expect(killSpy).toHaveBeenCalled());

		let pendingTimer: ReturnType<typeof setTimeout> | undefined;
		const outcome = await Promise.race([
			resultPromise.then((result) => ({ kind: "settled" as const, result })),
			new Promise<{ kind: "pending" }>((resolve) => {
				pendingTimer = setTimeout(() => resolve({ kind: "pending" }), 1000);
			}),
		]);
		if (pendingTimer) clearTimeout(pendingTimer);

		expect(outcome.kind).toBe("settled");
		if (outcome.kind !== "settled") return;

		expect(outcome.result.ok).toBe(false);
		if (!outcome.result.ok) expect(outcome.result.error.code).toBe("timeout");
		expect(child.stdout.listenerCount("data")).toBe(0);
		expect(child.stderr.listenerCount("data")).toBe(0);
	});

	it("rejects aggregate stdout plus stderr above 64 MiB instead of returning truncated success", async () => {
		vi.spyOn(process, "kill").mockReturnValue(true);
		const env = new NodeExecutionEnv({ cwd: createTempDir(), shellPath: process.execPath });
		const child = useChild(new FakeChild());
		const chunk = "a".repeat(1024 * 1024);

		const resultPromise = execute(env);
		await waitForExecListeners(child);
		for (let index = 0; index < 33; index += 1) {
			child.stdout.emit("data", chunk);
			child.stderr.emit("data", chunk);
		}
		child.emit("close", 0);

		const result = await resultPromise;
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.code).toBe("unknown");
		expect(result.error.message).toMatch(/64\s*MiB|67108864|capture limit|output limit/i);
	});

	it("preserves successful execution results and streaming callbacks", async () => {
		const env = new NodeExecutionEnv({ cwd: createTempDir(), shellPath: process.execPath });
		const child = useChild(new FakeChild());
		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];

		const resultPromise = env.exec("ignored command", {
			onStdout: (chunk) => stdoutChunks.push(chunk),
			onStderr: (chunk) => stderrChunks.push(chunk),
		});
		await waitForExecListeners(child);
		child.stdout.emit("data", "out");
		child.stderr.emit("data", "err");
		child.emit("close", 7);

		await expect(resultPromise).resolves.toEqual({ ok: true, value: { stdout: "out", stderr: "err", exitCode: 7 } });
		expect(stdoutChunks).toEqual(["out"]);
		expect(stderrChunks).toEqual(["err"]);
	});
});
