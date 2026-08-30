import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@metis/agent-core";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";
import { ToolAuthorizationRuntime } from "../src/core/tool-authorization-runtime.ts";

function testTool(name = "custom_action") {
	const execute = vi.fn(async () => ({
		content: [{ type: "text" as const, text: "done" }],
		details: {},
	}));
	const tool: AgentTool = {
		name,
		label: name,
		description: name,
		parameters: Type.Object({ value: Type.String() }),
		execute,
	};
	return { execute, tool };
}

describe("ToolAuthorizationRuntime", () => {
	const cleanups: Array<() => void> = [];

	afterEach(() => {
		while (cleanups.length > 0) cleanups.pop()?.();
	});

	function setup(
		options: {
			readonly mode?: "ask" | "auto" | "full";
			readonly requestApproval?: (request: any) => Promise<any>;
			readonly workspaceWritePolicy?: "inherit" | "deny";
		} = {},
	) {
		const root = mkdtempSync(join(tmpdir(), "metis-tool-authorization-"));
		const cwd = join(root, "workspace");
		const sessionDir = join(root, "sessions");
		const agentDir = join(root, "agent");
		mkdirSync(cwd);
		mkdirSync(sessionDir);
		mkdirSync(agentDir);
		const sessionManager = SessionManager.create(cwd, sessionDir);
		sessionManager.setPermissionSettings({ mode: options.mode ?? "ask" });
		const sources = new Map<string, string>([["custom_action", "sdk"]]);
		const trusted = new Set<string>();
		let currentCwd = cwd;
		let shellPrefix: string | undefined;
		const runtime = new ToolAuthorizationRuntime({
			agentDir,
			sessionManager,
			cwd: () => currentCwd,
			readOnlyRoots: () => [],
			toolSource: (name) => sources.get(name),
			mcpAnnotations: () => undefined,
			webSearchNetworkTarget: () => ({ host: "api.search.test", port: 443 }),
			isTrustedControlTool: (name) => trusted.has(name),
			runtimeShellCommandPrefix: () => shellPrefix,
			workspaceWritePolicy: options.workspaceWritePolicy ?? "inherit",
			requestApproval: options.requestApproval,
		});
		cleanups.push(() => {
			runtime.dispose();
			sessionManager.close();
			rmSync(root, { recursive: true, force: true });
		});
		return {
			cwd,
			runtime,
			sessionManager,
			sources,
			trusted,
			setCwd: (value: string) => {
				currentCwd = value;
			},
			setShellPrefix: (value: string | undefined) => {
				shellPrefix = value;
			},
		};
	}

	it("approves, audits, consumes, and executes one action exactly once", async () => {
		const requestApproval = vi.fn(async () => ({ decision: "allow" as const }));
		const { runtime, sessionManager } = setup({ requestApproval });
		const { execute, tool } = testTool();
		const guarded = runtime.guard(tool);

		await runtime.beforeToolExecute(
			{ actionId: "call-1", toolName: tool.name, args: { value: "x" } },
			new AbortController().signal,
		);
		await guarded.execute("call-1", { value: "x" });

		expect(requestApproval).toHaveBeenCalledOnce();
		expect(execute).toHaveBeenCalledOnce();
		expect(
			sessionManager.getDurableJournalSnapshot().filter((entry) => entry.type === "session_permission_decision"),
		).toHaveLength(1);
		await expect(guarded.execute("call-1", { value: "x" })).rejects.toThrow(/invalid or expired/i);
	});

	it("fails closed without an approval adapter and records no user decision", async () => {
		const { runtime, sessionManager } = setup();
		const { execute, tool } = testTool();

		await runtime.beforeToolExecute(
			{ actionId: "call-2", toolName: tool.name, args: { value: "x" } },
			new AbortController().signal,
		);
		await expect(runtime.guard(tool).execute("call-2", { value: "x" })).rejects.toThrow(/permission denied/i);

		expect(execute).not.toHaveBeenCalled();
		expect(
			sessionManager.getDurableJournalSnapshot().filter((entry) => entry.type === "session_permission_decision"),
		).toHaveLength(0);
	});

	it("rejects changed args, cwd, workspace roots, and provenance before execution", async () => {
		const requestApproval = vi.fn(async () => ({ decision: "allow" as const }));
		const { cwd, runtime, sessionManager, setCwd, sources } = setup({ requestApproval });
		const { tool } = testTool();
		const signal = new AbortController().signal;

		await runtime.beforeToolExecute({ actionId: "args", toolName: tool.name, args: { value: "x" } }, signal);
		await expect(runtime.guard(tool).execute("args", { value: "changed" })).rejects.toThrow(/arguments changed/i);

		await runtime.beforeToolExecute({ actionId: "cwd", toolName: tool.name, args: { value: "x" } }, signal);
		setCwd(join(cwd, "changed"));
		await expect(runtime.guard(tool).execute("cwd", { value: "x" })).rejects.toThrow(/working directory changed/i);
		setCwd(cwd);

		await runtime.beforeToolExecute({ actionId: "roots", toolName: tool.name, args: { value: "x" } }, signal);
		const added = join(cwd, "added");
		mkdirSync(added);
		sessionManager.addWorkspaceDirectory(added);
		await expect(runtime.guard(tool).execute("roots", { value: "x" })).rejects.toThrow(/workspace roots changed/i);

		await runtime.beforeToolExecute({ actionId: "source", toolName: tool.name, args: { value: "x" } }, signal);
		sources.set(tool.name, "mcp:changed");
		await expect(runtime.guard(tool).execute("source", { value: "x" })).rejects.toThrow(/provenance changed/i);
	});

	it("serializes forwarded approvals and fills the current cwd", async () => {
		const releases: Array<() => void> = [];
		const started: string[] = [];
		const requestApproval = vi.fn(
			async (request: { readonly action: { readonly actionId: string }; readonly cwd?: string }) => {
				started.push(request.action.actionId);
				await new Promise<void>((resolve) => releases.push(resolve));
				return { decision: "allow" as const };
			},
		);
		const { cwd, runtime } = setup({ requestApproval });
		const request = (actionId: string) => ({
			action: {
				actionId,
				toolName: "custom_action",
				provenance: "sdk" as const,
				risks: ["custom" as const],
				paths: [],
				networkTargets: [],
			},
			args: { value: actionId },
			reason: "test",
		});

		const first = runtime.requestApproval(request("first"));
		const second = runtime.requestApproval(request("second"));
		await vi.waitFor(() => expect(started).toEqual(["first"]));
		releases.shift()?.();
		await first;
		await vi.waitFor(() => expect(started).toEqual(["first", "second"]));
		releases.shift()?.();
		await second;

		expect(requestApproval.mock.calls.map(([value]) => value.cwd)).toEqual([cwd, cwd]);
	});

	it("clears authorization state after hook failure, explicit cleanup, and dispose", async () => {
		const requestApproval = vi.fn(async () => ({ decision: "allow" as const }));
		const { runtime } = setup({ requestApproval });
		const { tool } = testTool();
		const signal = new AbortController().signal;

		await expect(
			runtime.beforeToolExecute({ actionId: "hook", toolName: tool.name, args: { value: "x" } }, signal, () => {
				throw new Error("durability failed");
			}),
		).rejects.toThrow("durability failed");
		await expect(runtime.guard(tool).execute("hook", { value: "x" })).rejects.toThrow(/invalid or expired/i);

		await runtime.beforeToolExecute({ actionId: "clear", toolName: tool.name, args: { value: "x" } }, signal);
		runtime.clear("clear");
		await expect(runtime.guard(tool).execute("clear", { value: "x" })).rejects.toThrow(/invalid or expired/i);

		await runtime.beforeToolExecute({ actionId: "dispose", toolName: tool.name, args: { value: "x" } }, signal);
		runtime.dispose();
		await expect(runtime.guard(tool).execute("dispose", { value: "x" })).rejects.toThrow(/disposed/i);
	});

	it("bypasses authorization only while the exact host tool remains trusted", async () => {
		const { runtime, trusted } = setup();
		const { execute, tool } = testTool("host_control");
		trusted.add(tool.name);

		await runtime.beforeToolExecute(
			{ actionId: "trusted", toolName: tool.name, args: { value: "x" } },
			new AbortController().signal,
		);
		await runtime.guard(tool).execute("trusted", { value: "x" });
		expect(execute).toHaveBeenCalledOnce();

		trusted.delete(tool.name);
		await expect(runtime.guard(tool).execute("replacement", { value: "x" })).rejects.toThrow(/invalid or expired/i);
	});
});
