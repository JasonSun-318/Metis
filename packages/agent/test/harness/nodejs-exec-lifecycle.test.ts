import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: spawnMock };
});

class FakeChildProcess extends EventEmitter {
	pid: number;
	stdout = new PassThrough();
	stderr = new PassThrough();
	stdin = null;
	unref = vi.fn();

	constructor(pid: number = 12345) {
		super();
		this.pid = pid;
	}
}

let root = "";
let shellPath = "";
let fakeChild: FakeChildProcess | undefined;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "metis-nodejs-exec-lifecycle-"));
	shellPath = join(root, "shell");
	await writeFile(shellPath, "");
	fakeChild = undefined;
	spawnMock.mockReset();
	spawnMock.mockImplementation(() => {
		fakeChild = new FakeChildProcess();
		return fakeChild;
	});
	vi.spyOn(process, "kill").mockImplementation(() => true);
});

afterEach(async () => {
	vi.useRealTimers();
	spawnMock.mockReset();
	vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

function createEnv(): NodeExecutionEnv {
	return new NodeExecutionEnv({ cwd: root, shellPath });
}

async function waitForChild(): Promise<FakeChildProcess> {
	await vi.waitFor(
		() => {
			expect(fakeChild).toBeDefined();
		},
		{ interval: 1 },
	);
	const child = fakeChild!;
	await vi.waitFor(
		() => {
			expect(child.stdout.listenerCount("data")).toBeGreaterThan(0);
			expect(child.stderr.listenerCount("data")).toBeGreaterThan(0);
		},
		{ interval: 1 },
	);
	return child;
}

describe("NodeExecutionEnv exec lifecycle", () => {
	it("settles a timed-out command when close never arrives", async () => {
		const promise = createEnv().exec("ignored", { timeout: 0.02 });
		const child = await waitForChild();

		const result = await promise;

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatchObject({ code: "timeout" });
		expect(process.kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
		expect(child.unref).toHaveBeenCalledOnce();
	});

	it("settles an aborted command when close never arrives", async () => {
		const controller = new AbortController();
		const promise = createEnv().exec("ignored", { abortSignal: controller.signal });
		const child = await waitForChild();

		controller.abort();
		const result = await promise;

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatchObject({ code: "aborted" });
		expect(process.kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
	});

	it("settles a callback failure when close never arrives and ignores late events", async () => {
		const chunks: string[] = [];
		const promise = createEnv().exec("ignored", {
			onStdout: (chunk) => {
				chunks.push(chunk);
				throw new Error("callback failed");
			},
		});
		const child = await waitForChild();

		child.stdout.emit("data", "out");
		const result = await promise;

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toMatchObject({ code: "callback_error", message: "callback failed" });
		}
		expect(chunks).toEqual(["out"]);
		expect(child.stdout.listenerCount("data")).toBe(0);

		child.stdout.emit("data", "late stdout");
		child.stderr.emit("data", "late stderr");
		child.stdout.emit("error", new Error("late stdout error"));
		child.stderr.emit("error", new Error("late stderr error"));
		child.emit("error", new Error("late child error"));
		child.emit("close", 0);

		expect(chunks).toEqual(["out"]);
	});

	it("keeps normal streams, callbacks, exit codes, and listener cleanup below the cap", async () => {
		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		const promise = createEnv().exec("ignored", {
			onStdout: (chunk) => stdoutChunks.push(chunk),
			onStderr: (chunk) => stderrChunks.push(chunk),
		});
		const child = await waitForChild();

		child.stdout.emit("data", "out");
		child.stdout.emit("data", "put");
		child.stderr.emit("data", "err");
		child.emit("close", 7);

		const result = await promise;

		expect(result).toEqual({ ok: true, value: { stdout: "output", stderr: "err", exitCode: 7 } });
		expect(stdoutChunks).toEqual(["out", "put"]);
		expect(stderrChunks).toEqual(["err"]);
		expect(child.stdout.listenerCount("data")).toBe(0);
		expect(child.stderr.listenerCount("data")).toBe(0);

		child.stdout.emit("data", "late stdout");
		child.stderr.emit("data", "late stderr");
		child.stdout.emit("error", new Error("late stdout error"));
		child.stderr.emit("error", new Error("late stderr error"));
		child.emit("error", new Error("late child error"));
		child.emit("close", 1);

		expect(stdoutChunks).toEqual(["out", "put"]);
		expect(stderrChunks).toEqual(["err"]);
	});

	it("fails explicitly when aggregate stdout and stderr exceed 64 MiB", async () => {
		const halfCap = 32 * 1024 * 1024;
		const stdoutChunk = "a".repeat(halfCap);
		const stderrChunk = "b".repeat(halfCap + 1);
		const callbackSizes: number[] = [];
		const promise = createEnv().exec("ignored", {
			onStdout: (chunk) => callbackSizes.push(chunk.length),
			onStderr: (chunk) => callbackSizes.push(chunk.length),
		});
		const child = await waitForChild();

		child.stdout.emit("data", stdoutChunk);
		child.stderr.emit("data", stderrChunk);
		const result = await promise;

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.code).toBe("unknown");
			expect(result.error.message).toMatch(/64 MiB.*capture limit/);
		}
		expect(callbackSizes).toEqual([halfCap]);
		expect(process.kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
	});

	it("keeps callback_error precedence over timeout and abort", async () => {
		const controller = new AbortController();
		let resolveDataEmitted!: () => void;
		const dataEmitted = new Promise<void>((resolve) => {
			resolveDataEmitted = resolve;
		});
		spawnMock.mockImplementation(() => {
			const child = new FakeChildProcess();
			fakeChild = child;
			queueMicrotask(() => {
				child.stdout.emit("data", "out");
				resolveDataEmitted();
			});
			return child;
		});
		const promise = createEnv().exec("ignored", {
			timeout: 0.05,
			abortSignal: controller.signal,
			onStdout: () => {
				throw new Error("callback failed");
			},
		});

		await dataEmitted;
		await new Promise((resolve) => setTimeout(resolve, 60));
		controller.abort();
		fakeChild!.emit("close", 0);

		const result = await promise;

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatchObject({ code: "callback_error" });
	});

	it("keeps timeout precedence over abort", async () => {
		const controller = new AbortController();
		const promise = createEnv().exec("ignored", { timeout: 0.02, abortSignal: controller.signal });
		const child = await waitForChild();

		await new Promise((resolve) => setTimeout(resolve, 40));
		controller.abort();
		child.emit("close", 0);

		const result = await promise;

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatchObject({ code: "timeout" });
	});

	it("returns aborted when close follows an abort", async () => {
		const controller = new AbortController();
		const promise = createEnv().exec("ignored", { abortSignal: controller.signal });
		const child = await waitForChild();

		controller.abort();
		child.emit("close", 0);

		const result = await promise;

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatchObject({ code: "aborted" });
	});

	it("does not surface asynchronous taskkill errors on Windows", async () => {
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		let taskkillErrorCount = 0;
		try {
			spawnMock.mockImplementation((command: string) => {
				if (command === "taskkill") {
					const taskkill = new EventEmitter() as EventEmitter & { unref: () => void };
					taskkill.unref = () => {};
					queueMicrotask(() => {
						taskkillErrorCount++;
						taskkill.emit("error", new Error("taskkill failed"));
					});
					return taskkill;
				}
				fakeChild = new FakeChildProcess(4242);
				return fakeChild;
			});

			const controller = new AbortController();
			const promise = createEnv().exec("ignored", { abortSignal: controller.signal });
			await waitForChild();

			controller.abort();
			const result = await promise;

			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error).toMatchObject({ code: "aborted" });
			await vi.waitFor(
				() => {
					expect(taskkillErrorCount).toBe(1);
				},
				{ interval: 1 },
			);
			expect(spawnMock).toHaveBeenCalledWith(
				"taskkill",
				["/F", "/T", "/PID", "4242"],
				expect.objectContaining({ windowsHide: true }),
			);
		} finally {
			if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
		}
	});

	it("terminates the process when a capture stream fails", async () => {
		const promise = createEnv().exec("ignored");
		const child = await waitForChild();
		child.stdout.emit("error", new Error("pipe failed"));
		const result = await promise;
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toMatchObject({ code: "spawn_error", message: "pipe failed" });
		expect(process.kill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
		expect(child.unref).toHaveBeenCalledOnce();
	});

	it("bounds shell discovery when the probe never closes", async () => {
		const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		vi.useFakeTimers();
		try {
			const promise = new NodeExecutionEnv({ cwd: root }).exec("ignored");
			await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledWith("where", ["bash.exe"], expect.any(Object)));
			const probe = spawnMock.mock.results[0].value as FakeChildProcess;
			await vi.advanceTimersByTimeAsync(5000);
			const result = await promise;
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.error.code).toBe("shell_unavailable");
			expect(probe.stdout.listenerCount("data")).toBe(0);
			expect(probe.unref).toHaveBeenCalledOnce();
		} finally {
			if (descriptor) Object.defineProperty(process, "platform", descriptor);
		}
	});
});
