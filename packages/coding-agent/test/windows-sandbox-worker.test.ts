import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { SandboxRuntimeCoordinator } from "../src/core/sandbox-runtime.ts";
import {
	executeWindowsSandboxWorker,
	resolveWindowsSandboxWorkerLaunch,
	type WindowsSandboxWorkerLauncher,
	windowsSandboxWorkerTestHelpers,
} from "../src/core/windows-sandbox-worker.ts";

function grant() {
	return {
		actionId: "action-1",
		sandbox: "workspace-write" as const,
		denyReadPaths: [],
		capabilityReadPaths: [],
		capabilityWritePaths: [],
		readPaths: [],
		writePaths: [],
		networkTargets: [],
		fullOnce: false,
	};
}

function deferred(): { promise: Promise<void>; resolve(): void } {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

class FakeWorker extends EventEmitter {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly stdio = [this.stdin, this.stdout, this.stderr];
	readonly pid = undefined;
	readonly connected = false;
	readonly exitCode = null;
	readonly signalCode = null;
	readonly killed = false;
	readonly spawnargs: string[] = [];
	readonly spawnfile = "fake-worker";
	readonly channel = undefined;

	constructor(onFrame: (frame: Record<string, unknown>, reply: (frame: unknown) => void) => void) {
		super();
		let buffered = "";
		this.stdin.on("data", (chunk) => {
			buffered += chunk.toString();
			for (;;) {
				const newline = buffered.indexOf("\n");
				if (newline < 0) break;
				const line = buffered.slice(0, newline);
				buffered = buffered.slice(newline + 1);
				if (!line) continue;
				onFrame(JSON.parse(line), (frame) => this.stdout.write(`${JSON.stringify(frame)}\n`));
			}
		});
	}
}

function launcher(
	onFrame: (frame: Record<string, unknown>, reply: (frame: unknown) => void) => void,
): WindowsSandboxWorkerLauncher {
	return () => new FakeWorker(onFrame) as unknown as ChildProcessWithoutNullStreams;
}

describe("Windows sandbox worker boundary", () => {
	it("keeps setup/wrap asynchronous, runs the host callback, then requests worker cleanup", async () => {
		const frames: string[] = [];
		let heartbeat = false;
		const workerLauncher = launcher((frame, reply) => {
			frames.push(String(frame.type));
			if (frame.type === "start") {
				setTimeout(
					() =>
						reply({
							type: "wrapped",
							requestId: frame.requestId,
							argv: ["sandboxed.exe", "/c", "echo ok"],
							env: { WORKER_ONLY: "1" },
						}),
					10,
				);
			}
			if (frame.type === "finish") {
				reply({ type: "finished", requestId: frame.requestId });
			}
		});
		setTimeout(() => {
			heartbeat = true;
		}, 0);

		const result = await executeWindowsSandboxWorker(
			{
				command: "echo ok",
				shell: "cmd.exe",
				cwd: join(tmpdir(), "workspace"),
				grant: grant(),
				onData: () => {},
			},
			async ({ argv, env, signal }) => {
				expect(heartbeat).toBe(true);
				expect(signal?.aborted).toBe(false);
				expect(argv[0]).toBe("sandboxed.exe");
				expect(env.WORKER_ONLY).toBe("1");
				return "done";
			},
			{ agentDir: join(tmpdir(), "agent"), launcher: workerLauncher },
		);

		expect(result).toBe("done");
		expect(frames).toEqual(["start", "finish"]);
	});

	it("pauses for the existing setup approval callback before wrapping", async () => {
		const decisions: boolean[] = [];
		const requestSetup = vi.fn(async () => true);
		const workerLauncher = launcher((frame, reply) => {
			if (frame.type === "start") reply({ type: "setup_required", requestId: frame.requestId });
			if (frame.type === "setup_decision") {
				decisions.push(Boolean(frame.approved));
				reply({ type: "wrapped", requestId: frame.requestId, argv: ["sandboxed.exe"], env: {} });
			}
			if (frame.type === "finish") reply({ type: "finished", requestId: frame.requestId });
		});

		await expect(
			executeWindowsSandboxWorker(
				{
					command: "echo ok",
					shell: "cmd.exe",
					cwd: join(tmpdir(), "workspace"),
					grant: grant(),
					onData: () => {},
				},
				async () => "ok",
				{ agentDir: join(tmpdir(), "agent"), requestSetup, launcher: workerLauncher },
			),
		).resolves.toBe("ok");
		expect(requestSetup).toHaveBeenCalledOnce();
		expect(decisions).toEqual([true]);
	});

	it("fails closed when Windows setup is denied", async () => {
		const run = vi.fn(async () => "should not run");
		const workerLauncher = launcher((frame, reply) => {
			if (frame.type === "start") reply({ type: "setup_required", requestId: frame.requestId });
			if (frame.type === "setup_decision") {
				expect(frame.approved).toBe(false);
				reply({ type: "error", requestId: frame.requestId, phase: "setup", message: "setup denied" });
			}
		});

		await expect(
			executeWindowsSandboxWorker(
				{
					command: "echo ok",
					shell: "cmd.exe",
					cwd: join(tmpdir(), "workspace"),
					grant: grant(),
					onData: () => {},
				},
				run,
				{ agentDir: join(tmpdir(), "agent"), requestSetup: async () => false, launcher: workerLauncher },
			),
		).rejects.toThrow("setup denied");
		expect(run).not.toHaveBeenCalled();
	});

	it("aborts the host command and waits for worker cleanup without sending finish", async () => {
		const frames: string[] = [];
		const started = deferred();
		const controller = new AbortController();
		const workerLauncher = launcher((frame, reply) => {
			frames.push(String(frame.type));
			if (frame.type === "start") {
				reply({ type: "wrapped", requestId: frame.requestId, argv: ["sandboxed.exe"], env: {} });
			}
			if (frame.type === "abort") {
				setTimeout(() => reply({ type: "finished", requestId: frame.requestId }), 0);
			}
		});
		const execution = executeWindowsSandboxWorker(
			{
				command: "long-running",
				shell: "cmd.exe",
				cwd: join(tmpdir(), "workspace"),
				grant: grant(),
				signal: controller.signal,
				onData: () => {},
			},
			async ({ signal }) => {
				started.resolve();
				return new Promise<string>((_resolve, reject) => {
					signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				});
			},
			{ agentDir: join(tmpdir(), "agent"), launcher: workerLauncher },
		);
		await started.promise;
		controller.abort(new Error("cancelled by test"));

		await expect(execution).rejects.toThrow("cancelled by test");
		expect(frames).toEqual(["start", "abort"]);
	});

	it("preserves a command failure while reporting cleanup failure", async () => {
		const workerLauncher = launcher((frame, reply) => {
			if (frame.type === "start") {
				reply({ type: "wrapped", requestId: frame.requestId, argv: ["sandboxed.exe"], env: {} });
			}
			if (frame.type === "finish") {
				reply({ type: "error", requestId: frame.requestId, phase: "cleanup", message: "reset failed" });
			}
		});

		await expect(
			executeWindowsSandboxWorker(
				{
					command: "fail",
					shell: "cmd.exe",
					cwd: join(tmpdir(), "workspace"),
					grant: grant(),
					onData: () => {},
				},
				async () => {
					throw new Error("command failed");
				},
				{ agentDir: join(tmpdir(), "agent"), launcher: workerLauncher },
			),
		).rejects.toThrow("Command and sandbox cleanup failed");
	});

	it("aborts the host callback when the worker crashes", async () => {
		let worker: FakeWorker;
		worker = new FakeWorker((frame, reply) => {
			if (frame.type !== "start") return;
			reply({ type: "wrapped", requestId: frame.requestId, argv: ["sandboxed.exe"], env: {} });
			setTimeout(() => worker.emit("exit", 1, null), 0);
		});

		await expect(
			executeWindowsSandboxWorker(
				{
					command: "crash",
					shell: "cmd.exe",
					cwd: join(tmpdir(), "workspace"),
					grant: grant(),
					onData: () => {},
				},
				({ signal }) =>
					new Promise<string>((_resolve, reject) => {
						signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
					}),
				{ agentDir: join(tmpdir(), "agent"), launcher: () => worker as unknown as ChildProcessWithoutNullStreams },
			),
		).rejects.toThrow("exited before completion");
	});

	it("keeps same-process Windows commands FIFO while callbacks remain unchanged", async () => {
		const events: string[] = [];
		let workerNumber = 0;
		const workerLauncher: WindowsSandboxWorkerLauncher = () => {
			const id = ++workerNumber;
			return new FakeWorker((frame, reply) => {
				if (frame.type === "start") {
					events.push(`start-${id}`);
					reply({ type: "wrapped", requestId: frame.requestId, argv: [`worker-${id}`], env: {} });
				}
				if (frame.type === "finish") {
					events.push(`finish-${id}`);
					reply({ type: "finished", requestId: frame.requestId });
				}
			}) as unknown as ChildProcessWithoutNullStreams;
		};
		const coordinator = new SandboxRuntimeCoordinator({
			agentDir: join(tmpdir(), "agent"),
			platform: "win32",
			windowsWorkerLauncher: workerLauncher,
		});

		const first = coordinator.executeWith(
			{ command: "one", shell: "cmd.exe", cwd: join(tmpdir(), "workspace"), grant: grant(), onData: () => {} },
			async () => {
				events.push("run-1");
				await Promise.resolve();
				return 1;
			},
		);
		const second = coordinator.executeWith(
			{ command: "two", shell: "cmd.exe", cwd: join(tmpdir(), "workspace"), grant: grant(), onData: () => {} },
			async () => {
				events.push("run-2");
				return 2;
			},
		);

		await expect(Promise.all([first, second])).resolves.toEqual([1, 2]);
		expect(events).toEqual(["start-1", "run-1", "finish-1", "start-2", "run-2", "finish-2"]);
	});

	it("resolves Node, compiled binary, and Electron launch shapes", () => {
		expect(
			resolveWindowsSandboxWorkerLaunch({
				execPath: "node.exe",
				cliPath: "C:\\app\\dist\\cli.js",
				compiledBinary: false,
				electron: false,
				env: {},
			}),
		).toMatchObject({ command: "node.exe", args: ["C:\\app\\dist\\cli.js", "--internal-windows-sandbox-worker"] });
		expect(
			resolveWindowsSandboxWorkerLaunch({ execPath: "arcmind.exe", compiledBinary: true, electron: false, env: {} }),
		).toMatchObject({ command: "arcmind.exe", args: ["--internal-windows-sandbox-worker"] });
		expect(
			resolveWindowsSandboxWorkerLaunch({
				execPath: "electron.exe",
				cliPath: "C:\\app\\dist\\cli.js",
				compiledBinary: false,
				electron: true,
				env: {},
			}).env.ELECTRON_RUN_AS_NODE,
		).toBe("1");
	});

	it("rejects malformed and oversized private protocol frames", () => {
		expect(() => windowsSandboxWorkerTestHelpers.parseWorkerFrame('{"type":"wrapped"}')).toThrow(
			"Invalid worker frame",
		);
		expect(windowsSandboxWorkerTestHelpers.MAX_FRAME_BYTES).toBe(1024 * 1024);
	});
});
