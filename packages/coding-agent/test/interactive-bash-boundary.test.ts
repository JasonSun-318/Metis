import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildInteractiveBashReadOnlyRoots,
	createInteractiveBashBoundary,
} from "../src/core/interactive-bash-boundary.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import type { WorkspaceSandbox } from "../src/core/workspace-sandbox.ts";

describe("interactive Bash boundary", () => {
	const boundaries: Array<ReturnType<typeof createInteractiveBashBoundary>> = [];
	const cwd = process.cwd();
	const options = (actionId?: string, signal?: AbortSignal) => ({ actionId, signal, onData: () => {} });
	const sandbox = (exec: BashOperations["exec"] = vi.fn(async () => ({ exitCode: 0 }))): WorkspaceSandbox => ({
		operations: { exec },
		dispose: vi.fn(async () => {}),
		forceDispose: vi.fn(),
	});
	const boundary = (input: {
		hostExec?: BashOperations["exec"];
		createSandbox?: (context: unknown) => Promise<WorkspaceSandbox>;
		context?: () => {
			cwd: string;
			workspaceRoots: readonly string[];
			readOnlyRoots: readonly string[];
			writeRoots: readonly string[];
		};
	}) => {
		const value = createInteractiveBashBoundary({
			hostOperations: { exec: input.hostExec ?? vi.fn(async () => ({ exitCode: 0 })) },
			context: input.context ?? (() => ({ cwd, workspaceRoots: [cwd], readOnlyRoots: [], writeRoots: [] })),
			createSandbox: input.createSandbox as never,
		});
		boundaries.push(value);
		return value;
	};

	afterEach(async () => {
		await Promise.all(boundaries.splice(0).map((value) => value.dispose()));
	});

	it("routes exact one-action bindings and lazily reuses one sandbox", async () => {
		const hostExec = vi.fn(async () => ({ exitCode: 0 }));
		const sandboxExec = vi.fn(async () => ({ exitCode: 0 }));
		const instance = sandbox(sandboxExec);
		const createSandbox = vi.fn(async () => instance);
		const value = boundary({ hostExec, createSandbox });

		value.bindLegacy("safe-1", "sandbox");
		await value.operations.exec("pwd", cwd, options("safe-1"));
		value.bindLegacy("safe-2", "sandbox");
		await value.operations.exec("npm test", cwd, options("safe-2"));
		expect(createSandbox).toHaveBeenCalledOnce();
		expect(sandboxExec).toHaveBeenCalledTimes(2);
		expect(hostExec).not.toHaveBeenCalled();

		value.bindLegacy("host-1", "host");
		await value.operations.exec("git push", cwd, options("host-1"));
		expect(hostExec).toHaveBeenCalledOnce();
		expect(createSandbox).toHaveBeenCalledOnce();
		await expect(value.operations.exec("pwd", cwd, options("safe-1"))).rejects.toThrow("no permission binding");
	});

	it("rejects missing, reused, and unbound action IDs without host fallback", async () => {
		const hostExec = vi.fn(async () => ({ exitCode: 0 }));
		const value = boundary({ hostExec, createSandbox: vi.fn(async () => sandbox()) });
		expect(() => value.bindLegacy("", "sandbox")).toThrow("action ID is required");
		value.bindLegacy("one", "sandbox");
		expect(() => value.bindLegacy("one", "host")).toThrow("was reused");
		await expect(value.operations.exec("pwd", cwd, options())).rejects.toThrow("requires an action ID");
		await expect(value.operations.exec("pwd", cwd, options("missing"))).rejects.toThrow("no permission binding");
		expect(hostExec).not.toHaveBeenCalled();
	});

	it("rotates only when the normalized sandbox context changes", async () => {
		let roots: readonly string[] = [cwd, "/tmp"];
		const first = sandbox();
		const second = sandbox();
		const createSandbox = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
		const value = boundary({
			createSandbox,
			context: () => ({ cwd, workspaceRoots: roots, readOnlyRoots: [], writeRoots: [] }),
		});
		value.bindLegacy("one", "sandbox");
		await value.operations.exec("pwd", cwd, options("one"));
		roots = ["/tmp", cwd];
		value.bindLegacy("two", "sandbox");
		await value.operations.exec("pwd", cwd, options("two"));
		expect(createSandbox).toHaveBeenCalledOnce();

		roots = [cwd];
		value.bindLegacy("three", "sandbox");
		await value.operations.exec("pwd", cwd, options("three"));
		expect(createSandbox).toHaveBeenCalledTimes(2);
		expect(first.dispose).toHaveBeenCalledOnce();
	});

	it("passes workspaceReadOnly to sandbox creation", async () => {
		const createSandbox = vi.fn(async () => sandbox());
		const value = boundary({
			createSandbox,
			context: () => ({
				cwd,
				workspaceRoots: [cwd],
				readOnlyRoots: [],
				writeRoots: [join(cwd, "work")],
				workspaceReadOnly: true,
			}),
		});
		value.bindLegacy("one", "sandbox");
		await value.operations.exec("pwd", cwd, options("one"));
		expect(createSandbox).toHaveBeenCalledWith(expect.objectContaining({ workspaceReadOnly: true }));
	});

	it("passes only memory carve-outs as read roots and the root as protected metadata", async () => {
		const memoryRoot = join(cwd, "agent-memory");
		const globalRoot = join(memoryRoot, "global");
		const projectRoot = join(memoryRoot, "projects", "hash");
		const createSandbox = vi.fn(async () => sandbox());
		const value = boundary({
			createSandbox,
			context: () => ({
				cwd,
				workspaceRoots: [cwd],
				readOnlyRoots: buildInteractiveBashReadOnlyRoots({ memoryReadRoots: [globalRoot, projectRoot] }),
				writeRoots: [],
				protectedRoots: [memoryRoot],
			}),
		});
		value.bindLegacy("safe", "sandbox");
		await value.operations.exec("pwd", cwd, options("safe"));
		expect(createSandbox).toHaveBeenCalledWith(
			expect.objectContaining({
				readOnlyRoots: expect.arrayContaining([globalRoot, projectRoot]),
				protectedRoots: [memoryRoot],
			}),
		);
	});

	it("serializes sandbox commands and skips an aborted queued command", async () => {
		let finishFirst!: () => void;
		const sandboxExec = vi
			.fn()
			.mockImplementationOnce(
				() =>
					new Promise<{ exitCode: number | null }>((resolve) => {
						finishFirst = () => resolve({ exitCode: 0 });
					}),
			)
			.mockResolvedValue({ exitCode: 0 });
		const value = boundary({ createSandbox: vi.fn(async () => sandbox(sandboxExec)) });
		const controller = new AbortController();
		value.bindLegacy("one", "sandbox");
		value.bindLegacy("two", "sandbox");
		const first = value.operations.exec("sleep", cwd, options("one"));
		const second = value.operations.exec("pwd", cwd, options("two", controller.signal));
		await vi.waitFor(() => expect(sandboxExec).toHaveBeenCalledOnce());
		controller.abort();
		finishFirst();
		await expect(first).resolves.toEqual({ exitCode: 0 });
		await expect(second).rejects.toThrow("aborted");
		expect(sandboxExec).toHaveBeenCalledOnce();
	});

	it("fails closed when sandbox creation fails and host-only work never creates one", async () => {
		const hostExec = vi.fn(async () => ({ exitCode: 0 }));
		const createSandbox = vi.fn(async () => {
			throw new Error("sandbox unavailable");
		});
		const value = boundary({ hostExec, createSandbox });
		value.bindLegacy("safe", "sandbox");
		await expect(value.operations.exec("pwd", cwd, options("safe"))).rejects.toThrow("sandbox unavailable");
		expect(hostExec).not.toHaveBeenCalled();

		value.bindLegacy("full", "host");
		await value.operations.exec("pwd", cwd, options("full"));
		expect(hostExec).toHaveBeenCalledOnce();
		expect(createSandbox).toHaveBeenCalledOnce();
	});

	it("reset and disposal reject pending work and prevent later execution", async () => {
		let rejectRunning!: (error: Error) => void;
		const sandboxExec = vi.fn(
			() =>
				new Promise<{ exitCode: number | null }>((_resolve, reject) => {
					rejectRunning = reject;
				}),
		);
		const instance = sandbox(sandboxExec);
		vi.mocked(instance.dispose).mockImplementation(async () => rejectRunning(new Error("sandbox disposed")));
		const value = boundary({ createSandbox: vi.fn(async () => instance) });
		value.bindLegacy("one", "sandbox");
		value.bindLegacy("two", "sandbox");
		const running = value.operations.exec("sleep", cwd, options("one"));
		const queued = value.operations.exec("pwd", cwd, options("two"));
		await vi.waitFor(() => expect(sandboxExec).toHaveBeenCalledOnce());
		await value.reset();
		await expect(running).rejects.toThrow("sandbox disposed");
		await expect(queued).rejects.toThrow("reset");

		await expect(value.dispose()).resolves.toBeUndefined();

		const forceInstance = sandbox();
		const forced = boundary({ createSandbox: vi.fn(async () => forceInstance) });
		forced.bindLegacy("three", "sandbox");
		await forced.operations.exec("pwd", cwd, options("three"));
		forced.forceDispose();
		expect(forceInstance.forceDispose).toHaveBeenCalledOnce();
		await expect(forced.operations.exec("pwd", cwd, options("three"))).rejects.toThrow("closed");
		await expect(forced.dispose()).resolves.toBeUndefined();
	});
});
