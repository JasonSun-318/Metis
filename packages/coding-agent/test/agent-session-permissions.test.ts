import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@metis/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@metis/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createInteractiveBashBoundary } from "../src/core/interactive-bash-boundary.ts";
import type { PermissionApprovalRequest } from "../src/core/permission-policy.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import type { WorkspaceSandbox } from "../src/core/workspace-sandbox.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

function customTool(name = "custom_action") {
	const execute = vi.fn(async (_toolCallId: string, _params: unknown) => ({
		content: [{ type: "text" as const, text: "done" }],
		details: {},
	}));
	const tool: AgentTool = {
		name,
		label: "Custom action",
		description: "Test custom action",
		parameters: Type.Object({ value: Type.String() }),
		execute,
	};
	return { tool, execute };
}

function fakeBashBoundary() {
	const hostExec = vi.fn(async () => ({ exitCode: 0 }));
	const sandboxExec = vi.fn(async () => ({ exitCode: 0 }));
	const sandbox: WorkspaceSandbox = {
		operations: { exec: sandboxExec as BashOperations["exec"] },
		dispose: vi.fn(async () => {}),
		forceDispose: vi.fn(),
	};
	const createSandbox = vi.fn(async () => sandbox);
	const boundary = createInteractiveBashBoundary({
		hostOperations: { exec: hostExec as BashOperations["exec"] },
		context: () => ({
			cwd: process.cwd(),
			workspaceRoots: [process.cwd()],
			readOnlyRoots: [],
			writeRoots: [],
		}),
		createSandbox: createSandbox as never,
	});
	return { boundary, hostExec, sandboxExec, createSandbox };
}

describe("AgentSession permission enforcement", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it.each([
		{ mode: "ask", command: "pwd", asks: true, target: "sandbox" },
		{ mode: "ask", command: "rm -rf ./build", asks: true, target: "sandbox" },
		{ mode: "auto", command: "pwd", asks: false, target: "sandbox" },
		{ mode: "auto", command: "rm -rf ./build", asks: true, target: "sandbox" },
		{ mode: "auto", command: "git push origin main", asks: true, target: "host" },
		{ mode: "full", command: "rm -rf ./build", asks: false, target: "host" },
	] as const)("routes $mode Bash '$command' to $target", async ({ mode, command, asks, target }) => {
		const fake = fakeBashBoundary();
		const requestApproval = vi.fn(async () => ({ decision: "allow" as const }));
		const harness = await createHarness({
			permissionSettings: { mode },
			requestPermissionApproval: requestApproval,
			interactiveBashBoundary: fake.boundary,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run it");

		expect(requestApproval).toHaveBeenCalledTimes(asks ? 1 : 0);
		expect(fake.sandboxExec).toHaveBeenCalledTimes(target === "sandbox" ? 1 : 0);
		expect(fake.hostExec).toHaveBeenCalledTimes(target === "host" ? 1 : 0);
		expect(fake.createSandbox).toHaveBeenCalledTimes(target === "sandbox" ? 1 : 0);
	});

	it("reuses an exact remembered Bash approval but asks again when command text changes", async () => {
		const fake = fakeBashBoundary();
		const requestApproval = vi.fn(async () => ({ decision: "allow" as const, remember: "project" as const }));
		const harness = await createHarness({
			permissionSettings: { mode: "auto" },
			requestPermissionApproval: requestApproval,
			interactiveBashBoundary: fake.boundary,
			withAgentDir: true,
		});
		harnesses.push(harness);

		for (const command of ["rm -rf ./build", "rm -rf ./build", "rm -rf ./cache"]) {
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("run it");
		}

		expect(requestApproval).toHaveBeenCalledTimes(2);
		expect(fake.sandboxExec).toHaveBeenCalledTimes(3);
		expect(fake.hostExec).not.toHaveBeenCalled();
	});

	it("asks once, audits once, and executes a custom tool in Ask", async () => {
		const { tool, execute } = customTool();
		const requestApproval = vi.fn(async (_request: PermissionApprovalRequest) => ({ decision: "allow" as const }));
		const harness = await createHarness({
			tools: [tool],
			permissionSettings: { mode: "ask" },
			requestPermissionApproval: requestApproval,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("custom_action", { value: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run it");

		expect(requestApproval).toHaveBeenCalledOnce();
		expect(requestApproval.mock.calls[0]?.[0].cwd).toBe(harness.tempDir);
		expect(execute).toHaveBeenCalledOnce();
		expect(
			harness.sessionManager
				.getDurableJournalSnapshot()
				.filter((entry) => entry.type === "session_permission_decision"),
		).toEqual([expect.objectContaining({ source: "user", decision: "allow", toolName: "custom_action" })]);
	});

	it("denies without execution and writes one user decision", async () => {
		const { tool, execute } = customTool();
		const harness = await createHarness({
			tools: [tool],
			permissionSettings: { mode: "ask" },
			requestPermissionApproval: async () => ({ decision: "deny", reason: "No" }),
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("custom_action", { value: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run it");

		expect(execute).not.toHaveBeenCalled();
		expect(
			harness.session.messages.some(
				(message) => message.role === "toolResult" && getMessageText(message).includes("Permission denied"),
			),
		).toBe(true);
		expect(
			harness.sessionManager
				.getDurableJournalSnapshot()
				.filter((entry) => entry.type === "session_permission_decision"),
		).toEqual([expect.objectContaining({ source: "user", decision: "deny" })]);
	});

	it("adds the session cwd when forwarding an approval that does not include one", async () => {
		const requestApproval = vi.fn(async (_request: PermissionApprovalRequest) => ({ decision: "deny" as const }));
		const harness = await createHarness({ requestPermissionApproval: requestApproval });
		harnesses.push(harness);

		await harness.session.requestPermissionApproval({
			action: {
				actionId: "forwarded-action",
				toolName: "custom_action",
				provenance: "sdk",
				risks: ["custom"],
				paths: [],
				networkTargets: [],
			},
			args: { value: "x" },
			reason: "test",
		});

		expect(requestApproval.mock.calls[0]?.[0].cwd).toBe(harness.tempDir);
	});

	it("fails closed without UI and does not record a false user denial", async () => {
		const { tool, execute } = customTool();
		const harness = await createHarness({
			tools: [tool],
			permissionSettings: { mode: "ask" },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("custom_action", { value: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run it");

		expect(execute).not.toHaveBeenCalled();
		expect(
			harness.sessionManager
				.getDurableJournalSnapshot()
				.filter((entry) => entry.type === "session_permission_decision"),
		).toEqual([]);
	});

	it("does not let approval UI mutate execution arguments", async () => {
		const { tool, execute } = customTool();
		const harness = await createHarness({
			tools: [tool],
			permissionSettings: { mode: "ask" },
			requestPermissionApproval: async (request) => {
				(request.args as { value: string }).value = "changed-in-ui";
				return { decision: "allow" };
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("custom_action", { value: "original" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run it");

		expect(execute).toHaveBeenCalledOnce();
		expect(execute.mock.calls[0]?.[1]).toEqual({ value: "original" });
	});

	it("executes in Full without approval or decision audit", async () => {
		const { tool, execute } = customTool();
		const requestApproval = vi.fn(async () => ({ decision: "deny" as const }));
		const harness = await createHarness({
			tools: [tool],
			permissionSettings: { mode: "full" },
			requestPermissionApproval: requestApproval,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("custom_action", { value: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run it");

		expect(execute).toHaveBeenCalledOnce();
		expect(requestApproval).not.toHaveBeenCalled();
		expect(
			harness.sessionManager
				.getDurableJournalSnapshot()
				.filter((entry) => entry.type === "session_permission_decision"),
		).toEqual([]);
	});

	it("runs a proven structured read in Ask without approval", async () => {
		const requestApproval = vi.fn(async () => ({ decision: "deny" as const }));
		const harness = await createHarness({
			permissionSettings: { mode: "ask" },
			requestPermissionApproval: requestApproval,
		});
		harnesses.push(harness);
		const path = join(harness.sessionManager.getCwd(), "package.json");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("read it");

		expect(requestApproval).not.toHaveBeenCalled();
		expect(
			harness.session.messages.some(
				(message) => message.role === "toolResult" && getMessageText(message).includes("metis"),
			),
		).toBe(true);
	});

	it("reads an installed Skill without approval", async () => {
		const skillRoot = mkdtempSync(join(tmpdir(), "metis-installed-skill-"));
		try {
			const path = join(skillRoot, "SKILL.md");
			writeFileSync(path, "# Create a Skill\n");
			const baseResourceLoader = createTestResourceLoader();
			const requestApproval = vi.fn(async () => ({ decision: "deny" as const }));
			const harness = await createHarness({
				permissionSettings: { mode: "ask" },
				requestPermissionApproval: requestApproval,
				resourceLoader: {
					...baseResourceLoader,
					getSkills: () => ({
						diagnostics: [],
						skills: [
							{
								name: "create-skill",
								description: "Create a Skill",
								filePath: path,
								baseDir: skillRoot,
								disableModelInvocation: false,
								sourceInfo: { path, source: "local", scope: "user", origin: "top-level" },
							},
						],
					}),
				},
			});
			harnesses.push(harness);
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("read the Skill");

			expect(requestApproval).not.toHaveBeenCalled();
			expect(harness.session.messages.some((message) => getMessageText(message).includes("Create a Skill"))).toBe(
				true,
			);
		} finally {
			rmSync(skillRoot, { recursive: true, force: true });
		}
	});

	it("automatically reads from an added directory", async () => {
		const requestApproval = vi.fn(async () => ({ decision: "allow" as const }));
		const harness = await createHarness({
			permissionSettings: { mode: "ask" },
			requestPermissionApproval: requestApproval,
		});
		harnesses.push(harness);
		const external = mkdtempSync(join(tmpdir(), "metis-added-read-"));
		try {
			const path = join(external, "safe.txt");
			writeFileSync(path, "safe\n");
			harness.sessionManager.addWorkspaceDirectory(external);
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("read", { path })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("read it");
			expect(requestApproval).not.toHaveBeenCalled();
		} finally {
			rmSync(external, { recursive: true, force: true });
		}
	});

	it("invalidates an Ask grant when workspace roots change before execution", async () => {
		const external = mkdtempSync(join(tmpdir(), "metis-root-revalidation-"));
		try {
			const path = join(external, "new.txt");
			let harness!: Harness;
			harness = await createHarness({
				permissionSettings: { mode: "ask" },
				requestPermissionApproval: async () => {
					harness.sessionManager.removeWorkspaceDirectory(external);
					return { decision: "allow" };
				},
			});
			harnesses.push(harness);
			harness.sessionManager.addWorkspaceDirectory(external);
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("write", { path, content: "x" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("write it");
			expect(existsSync(path)).toBe(false);
			expect(
				harness.session.messages.some(
					(message) =>
						message.role === "toolResult" && getMessageText(message).includes("workspace roots changed"),
				),
			).toBe(true);
		} finally {
			rmSync(external, { recursive: true, force: true });
		}
	});

	it("serializes parallel approval callbacks", async () => {
		const first = customTool("custom_one");
		const second = customTool("custom_two");
		let active = 0;
		let maximum = 0;
		const harness = await createHarness({
			tools: [first.tool, second.tool],
			permissionSettings: { mode: "ask" },
			requestPermissionApproval: async () => {
				active += 1;
				maximum = Math.max(maximum, active);
				await Promise.resolve();
				active -= 1;
				return { decision: "allow" };
			},
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("custom_one", { value: "1" }), fauxToolCall("custom_two", { value: "2" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run both");

		expect(maximum).toBe(1);
		expect(first.execute).toHaveBeenCalledOnce();
		expect(second.execute).toHaveBeenCalledOnce();
	});

	it("automatically trusts only explicitly named host control tools", async () => {
		const inspect = customTool("inspect_agents");
		const spawn = customTool("spawn_agent");
		const requestApproval = vi.fn(async (_request: PermissionApprovalRequest) => ({ decision: "allow" as const }));
		const harness = await createHarness({
			permissionSettings: { mode: "ask" },
			requestPermissionApproval: requestApproval,
		});
		harnesses.push(harness);
		harness.session.installHostTools([inspect.tool, spawn.tool] as never, {
			automaticPermissionToolNames: ["inspect_agents"],
		});
		harness.setResponses([
			fauxAssistantMessage(
				[fauxToolCall("inspect_agents", { value: "inspect" }), fauxToolCall("spawn_agent", { value: "spawn" })],
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("inspect and spawn");

		expect(inspect.execute).toHaveBeenCalledOnce();
		expect(spawn.execute).toHaveBeenCalledOnce();
		expect(requestApproval).toHaveBeenCalledOnce();
		expect(requestApproval.mock.calls[0]?.[0].action.toolName).toBe("spawn_agent");
	});

	it("does not transfer host-control trust to a same-name replacement definition", async () => {
		const inspect = customTool("inspect_agents");
		const requestApproval = vi.fn(async (_request: PermissionApprovalRequest) => ({ decision: "allow" as const }));
		const harness = await createHarness({
			permissionSettings: { mode: "ask" },
			requestPermissionApproval: requestApproval,
		});
		harnesses.push(harness);
		harness.session.installHostTools([inspect.tool] as never, {
			automaticPermissionToolNames: ["inspect_agents"],
		});
		const registry = (
			harness.session as unknown as {
				_toolDefinitions: Map<string, { definition: AgentTool; sourceInfo: unknown }>;
			}
		)._toolDefinitions;
		const registered = registry.get("inspect_agents")!;
		registry.set("inspect_agents", {
			...registered,
			definition: { ...registered.definition },
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("inspect_agents", { value: "inspect" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("inspect");

		expect(requestApproval).toHaveBeenCalledOnce();
		expect(inspect.execute).toHaveBeenCalledOnce();
	});
});
