import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
	createInteractiveBashBoundary,
	type InteractiveBashBoundary,
} from "../../src/core/interactive-bash-boundary.ts";
import {
	type ExecutionGrant,
	ExecutionGrantStore,
	normalizePermissionAction,
	ToolAuthorizationRuntime,
} from "../../src/core/permissions/index.ts";
import type { BashOperations } from "../../src/core/tools/bash.ts";
import type { WorkspaceSandbox } from "../../src/core/workspace-sandbox.ts";

const cwd = process.cwd();

function action(command: string, timeout?: number, provenance: "builtin" | "mcp" = "builtin") {
	return normalizePermissionAction({
		actionId: "bash-1",
		toolName: "bash",
		provenance,
		toolIdentity: `${provenance}:bash:v1`,
		args: { command, ...(timeout === undefined ? {} : { timeout }) },
		cwd,
		workspaceRoots: [cwd],
		readPaths: [],
		writePaths: [],
		networkEndpoints: [],
		command,
		effects: [],
	});
}

function sandbox(exec: BashOperations["exec"]): WorkspaceSandbox {
	return {
		operations: { exec },
		dispose: vi.fn(async () => {}),
		forceDispose: vi.fn(),
	};
}

function setup(
	input: {
		hostExec?: BashOperations["exec"];
		sandboxExec?: BashOperations["exec"];
		createSandbox?: () => Promise<WorkspaceSandbox>;
	} = {},
) {
	const hostExec = input.hostExec ?? vi.fn(async () => ({ exitCode: 0 }));
	const sandboxExec = input.sandboxExec ?? vi.fn(async () => ({ exitCode: 0 }));
	const createSandbox = input.createSandbox ?? vi.fn(async () => sandbox(sandboxExec));
	const boundary = createInteractiveBashBoundary({
		hostOperations: { exec: hostExec },
		context: () => ({ cwd, workspaceRoots: [cwd], readOnlyRoots: [], writeRoots: [] }),
		createSandbox,
	});
	return { boundary, hostExec, sandboxExec, createSandbox };
}

function request(
	command: string,
	execute: (grant: ExecutionGrant) => Promise<{ exitCode: number | null }>,
	overrides: { timeout?: number; target?: "sandbox" | "host" | "external" } = {},
) {
	const target = overrides.target ?? "sandbox";
	return {
		action: action(command, overrides.timeout, target === "external" ? "mcp" : "builtin"),
		args: { command, ...(overrides.timeout === undefined ? {} : { timeout: overrides.timeout }) },
		settings:
			target === "host"
				? ({ sandboxPolicy: "danger-full-access", approvalPolicy: "user" } as const)
				: target === "external"
					? ({ sandboxPolicy: "external-sandbox", approvalPolicy: "auto-review" } as const)
					: ({ sandboxPolicy: "workspace-write", approvalPolicy: "auto-review" } as const),
		sandboxHealth: "healthy" as const,
		trustedUserMessages: [{ messageId: "user-1", text: `Run ${command}` }],
		interactive: true,
		signal: new AbortController().signal,
		execute,
	};
}

describe("grant-bound Interactive Bash", () => {
	it("accepts only a consumed ExecutionGrant on the new binding seam", () => {
		expectTypeOf<InteractiveBashBoundary["bind"]>().parameter(0).toEqualTypeOf<ExecutionGrant>();
	});

	it("consumes and claims one grant for the whole streamed command", async () => {
		const grants = new ExecutionGrantStore({ createId: () => "grant-1" });
		const consume = vi.spyOn(grants, "consumeExact");
		const sandboxExec = vi.fn(async (_command, _cwd, options) => {
			options.onData(Buffer.from("one"));
			options.onData(Buffer.from("two"));
			return { exitCode: 0 };
		});
		const value = setup({ sandboxExec });
		const chunks: string[] = [];
		const runtime = new ToolAuthorizationRuntime({ sessionId: "session-1", grants });

		await expect(
			runtime.authorizeAndExecute(
				request("pwd", async (grant) => {
					expect(() => value.boundary.bind({ ...grant })).toThrow("not consumed");
					value.boundary.bind(grant);
					const result = await value.boundary.operations.exec("pwd", cwd, {
						actionId: "bash-1",
						onData: (data) => chunks.push(data.toString()),
					});
					expect(() => value.boundary.bind(grant)).toThrow("no longer usable");
					return result;
				}),
			),
		).resolves.toEqual({ exitCode: 0 });
		expect(chunks).toEqual(["one", "two"]);
		expect(consume).toHaveBeenCalledOnce();
		expect(value.sandboxExec).toHaveBeenCalledOnce();
		expect(value.hostExec).not.toHaveBeenCalled();
		await value.boundary.dispose();
	});

	it.each([
		["command", "echo changed", cwd],
		["cwd", "pwd", `${cwd}/changed`],
	] as const)("rejects a changed %s before touching either backend", async (_field, command, executionCwd) => {
		const value = setup();
		const runtime = new ToolAuthorizationRuntime({ sessionId: "session-1" });
		await expect(
			runtime.authorizeAndExecute(
				request("pwd", async (grant) => {
					value.boundary.bind(grant);
					return value.boundary.operations.exec(command, executionCwd, {
						actionId: "bash-1",
						onData: () => {},
					});
				}),
			),
		).rejects.toThrow(/command|cwd/);
		expect(value.sandboxExec).not.toHaveBeenCalled();
		expect(value.hostExec).not.toHaveBeenCalled();
		expect(value.createSandbox).not.toHaveBeenCalled();
		await value.boundary.dispose();
	});

	it("never falls back to host when sandbox startup or child execution fails", async () => {
		const startup = setup({
			createSandbox: vi.fn(async () => {
				throw new Error("sandbox unavailable");
			}),
		});
		await expect(
			new ToolAuthorizationRuntime({ sessionId: "session-1" }).authorizeAndExecute(
				request("pwd", async (grant) => {
					startup.boundary.bind(grant);
					return startup.boundary.operations.exec("pwd", cwd, { actionId: "bash-1", onData: () => {} });
				}),
			),
		).rejects.toThrow("sandbox unavailable");
		expect(startup.hostExec).not.toHaveBeenCalled();

		const child = setup({
			sandboxExec: vi.fn(async () => {
				throw new Error("sandbox child failed");
			}),
		});
		await expect(
			new ToolAuthorizationRuntime({ sessionId: "session-2" }).authorizeAndExecute(
				request("pwd", async (grant) => {
					child.boundary.bind(grant);
					return child.boundary.operations.exec("pwd", cwd, { actionId: "bash-1", onData: () => {} });
				}),
			),
		).rejects.toThrow("sandbox child failed");
		expect(child.hostExec).not.toHaveBeenCalled();
		await Promise.all([startup.boundary.dispose(), child.boundary.dispose()]);
	});

	it("routes host only from the grant and denies external grants", async () => {
		const value = setup();
		await expect(
			new ToolAuthorizationRuntime({ sessionId: "session-1" }).authorizeAndExecute(
				request(
					"pwd",
					async (grant) => {
						value.boundary.bind(grant);
						return value.boundary.operations.exec("pwd", cwd, { actionId: "bash-1", onData: () => {} });
					},
					{ target: "host" },
				),
			),
		).resolves.toEqual({ exitCode: 0 });
		expect(value.hostExec).toHaveBeenCalledOnce();
		expect(value.createSandbox).not.toHaveBeenCalled();

		await expect(
			new ToolAuthorizationRuntime({ sessionId: "session-2" }).authorizeAndExecute(
				request(
					"pwd",
					async (grant) => {
						value.boundary.bind(grant);
						return { exitCode: 0 };
					},
					{ target: "external" },
				),
			),
		).rejects.toThrow("External execution grants");
		await value.boundary.dispose();
	});
});
