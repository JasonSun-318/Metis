import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@metis/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/types.ts";
import { createInteractiveBashBoundary } from "../src/core/interactive-bash-boundary.ts";
import type { PermissionApprovalRequest } from "../src/core/permissions/approval.ts";
import { permissionClaim, permissionDescriptor } from "../src/core/tool-permission-adapter.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import type { WorkspaceSandbox } from "../src/core/workspace-sandbox.ts";
import { canonicalizeActionPath } from "../src/utils/paths.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";
import { createTestResourceLoader } from "./utilities.ts";

function customTool(name = "custom_action") {
	const parameters = Type.Object({ value: Type.String() });
	const execute = vi.fn(async (_toolCallId: string, _params: unknown) => ({
		content: [{ type: "text" as const, text: "done" }],
		details: {},
	}));
	const tool: ToolDefinition<typeof parameters> = {
		name,
		label: "Custom action",
		description: "Test custom action",
		parameters,
		permission: permissionDescriptor((_params, context) =>
			permissionClaim({ writePaths: [join(context.cwd, `.permission-fixture-${name}`)] }),
		),
		execute,
	};
	return { tool, execute };
}

function fakeBashBoundary() {
	let cwd = process.cwd();
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
			cwd,
			workspaceRoots: [cwd],
			readOnlyRoots: [],
			writeRoots: [],
		}),
		createSandbox: createSandbox as never,
	});
	return {
		boundary,
		hostExec,
		sandboxExec,
		createSandbox,
		setCwd: (next: string) => {
			cwd = next;
		},
	};
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
		{ mode: "auto", command: "curl https://example.test", asks: true, target: "sandbox" },
		{ mode: "full", command: "rm -rf ./build", asks: true, target: "host" },
	] as const)("routes $mode Bash '$command' to $target", async ({ mode, command, asks, target }) => {
		const fake = fakeBashBoundary();
		const requestApproval = vi.fn(async () => ({ decision: "allow" as const }));
		const harness = await createHarness({
			permissionPreset: mode,
			requestPermissionApproval: requestApproval,
			interactiveBashBoundary: fake.boundary,
		});
		fake.setCwd(harness.tempDir);
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

	it("rejects a Bash network command whose destination cannot be bound exactly", async () => {
		const fake = fakeBashBoundary();
		const requestApproval = vi.fn(async () => ({ decision: "allow" as const }));
		const harness = await createHarness({
			permissionPreset: "auto",
			requestPermissionApproval: requestApproval,
			interactiveBashBoundary: fake.boundary,
		});
		fake.setCwd(harness.tempDir);
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "git push origin main" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("push it");

		expect(requestApproval).not.toHaveBeenCalled();
		expect(fake.sandboxExec).not.toHaveBeenCalled();
		expect(fake.hostExec).not.toHaveBeenCalled();
		const toolResult = [...harness.session.messages].reverse().find((message) => message.role === "toolResult");
		expect(toolResult?.isError).toBe(true);
		expect(getMessageText(toolResult)).toMatch(/scope is incomplete/iu);
	});

	it("reuses an exact remembered Bash approval but asks again when command text changes", async () => {
		const fake = fakeBashBoundary();
		const requestApproval = vi.fn(async () => ({ decision: "allow" as const, remember: "project" as const }));
		const harness = await createHarness({
			permissionPreset: "auto",
			requestPermissionApproval: requestApproval,
			interactiveBashBoundary: fake.boundary,
			withAgentDir: true,
		});
		fake.setCwd(harness.tempDir);
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
			toolDefinitions: [tool],
			permissionPreset: "ask",
			requestPermissionApproval: requestApproval,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("custom_action", { value: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run it");

		expect(requestApproval).toHaveBeenCalledOnce();
		expect(requestApproval.mock.calls[0]?.[0].cwd).toBe(canonicalizeActionPath(harness.tempDir, harness.tempDir));
		expect(execute).toHaveBeenCalledOnce();
		expect(
			harness.sessionManager
				.getDurableJournalSnapshot()
				.filter((entry) => entry.type === "session_permission_audit"),
		).toEqual([expect.objectContaining({ source: "user", decision: "allow", toolName: "custom_action" })]);
	});

	it("denies without execution and writes one user decision", async () => {
		const { tool, execute } = customTool();
		const harness = await createHarness({
			toolDefinitions: [tool],
			permissionPreset: "ask",
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
				.filter((entry) => entry.type === "session_permission_audit"),
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
			scopeComplete: true,
		});

		expect(requestApproval.mock.calls[0]?.[0].cwd).toBe(harness.tempDir);
	});

	it("fails closed without UI and does not record a false user denial", async () => {
		const { tool, execute } = customTool();
		const harness = await createHarness({
			toolDefinitions: [tool],
			permissionPreset: "ask",
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
				.filter((entry) => entry.type === "session_permission_audit"),
		).toEqual([]);
	});

	it("does not let approval UI mutate execution arguments", async () => {
		const { tool, execute } = customTool();
		const harness = await createHarness({
			toolDefinitions: [tool],
			permissionPreset: "ask",
			requestPermissionApproval: async (request) => {
				expect(() => {
					(request.args as { value: string }).value = "changed-in-ui";
				}).toThrow();
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

	it("cancels a pending approval when the session model changes", async () => {
		const { tool, execute } = customTool();
		let releaseApproval!: (decision: { decision: "allow" }) => void;
		const approval = new Promise<{ decision: "allow" }>((resolve) => {
			releaseApproval = resolve;
		});
		const requestApproval = vi.fn(async () => approval);
		const harness = await createHarness({
			models: [
				{ id: "faux-1", reasoning: false },
				{ id: "faux-2", reasoning: false },
			],
			toolDefinitions: [tool],
			permissionPreset: "ask",
			requestPermissionApproval: requestApproval,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("custom_action", { value: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const prompt = harness.session.prompt("run it");
		await vi.waitFor(() => expect(requestApproval).toHaveBeenCalledOnce());
		await harness.session.setModel(harness.getModel("faux-2")!);
		releaseApproval({ decision: "allow" });
		await prompt;

		expect(execute).not.toHaveBeenCalled();
		expect(harness.session.permissionGrantCount).toBe(0);
		expect(
			harness.session.messages.some(
				(message) => message.role === "toolResult" && getMessageText(message).includes("Permission denied"),
			),
		).toBe(true);
	});

	it("cancels a pending approval when sandbox health changes", async () => {
		const { tool, execute } = customTool();
		let releaseApproval!: (decision: { decision: "allow" }) => void;
		const approval = new Promise<{ decision: "allow" }>((resolve) => {
			releaseApproval = resolve;
		});
		const requestApproval = vi.fn(async () => approval);
		const harness = await createHarness({
			toolDefinitions: [tool],
			permissionPreset: "ask",
			requestPermissionApproval: requestApproval,
			sandboxHealth: "healthy",
			sandboxHealthProbe: async () => ({
				status: "unavailable",
				code: "dependencies-unavailable",
				details: [],
			}),
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("custom_action", { value: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		const prompt = harness.session.prompt("run it");
		await vi.waitFor(() => expect(requestApproval).toHaveBeenCalledOnce());
		await harness.session.refreshSandboxHealth(true);
		releaseApproval({ decision: "allow" });
		await prompt;

		expect(harness.session.permissionView.sandboxHealth).toBe("unavailable");
		expect(harness.eventsOfType("sandbox_health_changed")).toEqual([
			{ type: "sandbox_health_changed", sandboxHealth: "unavailable" },
		]);
		expect(execute).not.toHaveBeenCalled();
		expect(harness.session.permissionGrantCount).toBe(0);
	});

	it("executes in Full without approval or decision audit", async () => {
		const { tool, execute } = customTool();
		const requestApproval = vi.fn(async () => ({ decision: "deny" as const }));
		const harness = await createHarness({
			toolDefinitions: [tool],
			permissionPreset: "full",
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
				.filter((entry) => entry.type === "session_permission_audit"),
		).toEqual([]);
	});

	it("runs a proven structured read in Ask without approval", async () => {
		const requestApproval = vi.fn(async () => ({ decision: "deny" as const }));
		const harness = await createHarness({
			permissionPreset: "ask",
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

	it("reports unhealthy sandbox state and denies sandbox-targeted tools", async () => {
		const requestApproval = vi.fn(async () => ({ decision: "allow" as const }));
		const harness = await createHarness({
			permissionPreset: "ask",
			requestPermissionApproval: requestApproval,
			sandboxHealth: "unavailable",
		});
		harnesses.push(harness);
		const path = join(harness.sessionManager.getCwd(), "package.json");
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("read", { path })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("read it");

		expect(harness.session.permissionView.sandboxHealth).toBe("unavailable");
		expect(requestApproval).not.toHaveBeenCalled();
		expect(
			harness.session.messages.some(
				(message) => message.role === "toolResult" && getMessageText(message).includes("Sandbox is unavailable"),
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
				permissionPreset: "ask",
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
			permissionPreset: "ask",
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
				permissionPreset: "ask",
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
					(message) => message.role === "toolResult" && /workspace roots changed/iu.test(getMessageText(message)),
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
			toolDefinitions: [first.tool, second.tool],
			permissionPreset: "ask",
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
			permissionPreset: "ask",
			requestPermissionApproval: requestApproval,
		});
		harnesses.push(harness);
		harness.session.installHostTools([inspect.tool, spawn.tool], {
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
		expect(requestApproval.mock.calls[0]?.[0].action.provenance).toBe("host");
	});

	it("does not transfer host-control trust to a same-name replacement definition", async () => {
		const inspect = customTool("inspect_agents");
		const replacement = customTool("inspect_agents");
		const requestApproval = vi.fn(async (_request: PermissionApprovalRequest) => ({ decision: "allow" as const }));
		const harness = await createHarness({
			permissionPreset: "ask",
			requestPermissionApproval: requestApproval,
		});
		harnesses.push(harness);
		harness.session.installHostTools([inspect.tool], {
			automaticPermissionToolNames: ["inspect_agents"],
		});
		harness.session.installHostTools([replacement.tool]);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("inspect_agents", { value: "inspect" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("inspect");

		expect(requestApproval).toHaveBeenCalledOnce();
		expect(inspect.execute).not.toHaveBeenCalled();
		expect(replacement.execute).toHaveBeenCalledOnce();
	});

	it("delegates only explicitly reconstructible host tools", async () => {
		const browser = customTool("browser_act");
		const spawn = customTool("spawn_agent");
		const replacement = customTool("spawn_agent");
		const harness = await createHarness({ permissionPreset: "full" });
		harnesses.push(harness);
		harness.session.installHostTools([browser.tool, spawn.tool], {
			delegatableToolNames: ["spawn_agent"],
		});

		expect(harness.session.getDelegatableToolNames()).toContain("spawn_agent");
		expect(harness.session.getDelegatableToolNames()).not.toContain("browser_act");

		harness.session.installHostTools([replacement.tool]);
		expect(harness.session.getDelegatableToolNames()).not.toContain("spawn_agent");
	});

	describe("Plan mode Bash boundary", () => {
		it("rejects sensitive Bash reads in full permission mode", async () => {
			const fake = fakeBashBoundary();
			const harness = await createHarness({
				permissionPreset: "full",
				interactiveBashBoundary: fake.boundary,
			});
			fake.setCwd(harness.tempDir);
			harnesses.push(harness);
			await harness.session.setCollaborationMode("plan");
			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "cat .env" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);

			await harness.session.prompt("read secrets");

			expect(fake.sandboxExec).not.toHaveBeenCalled();
			expect(fake.hostExec).not.toHaveBeenCalled();
			const toolResult = [...harness.session.messages].reverse().find((message) => message.role === "toolResult");
			expect(toolResult?.isError).toBe(true);
			expect(getMessageText(toolResult)).toMatch(/approval ceiling.*sensitive-read/iu);
		});

		it("routes harmless Bash to sandbox without approval and rejects risky commands", async () => {
			const fake = fakeBashBoundary();
			const bindSpy = vi.spyOn(fake.boundary, "bind");
			const requestApproval = vi.fn(async () => ({ decision: "allow" as const }));
			const harness = await createHarness({
				permissionPreset: "ask",
				requestPermissionApproval: requestApproval,
				interactiveBashBoundary: fake.boundary,
			});
			fake.setCwd(harness.tempDir);
			harnesses.push(harness);
			const trackedFile = join(harness.tempDir, "tracked.txt");
			writeFileSync(trackedFile, "original");
			await harness.session.setCollaborationMode("plan");

			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("run pwd");
			expect(requestApproval).not.toHaveBeenCalled();
			expect(bindSpy).toHaveBeenCalledWith(expect.objectContaining({ executionTarget: "sandbox" }));
			expect(fake.sandboxExec).toHaveBeenCalledOnce();
			expect(fake.hostExec).not.toHaveBeenCalled();

			for (const [command, pattern] of [
				["curl https://example.com", /read-only sandbox.*external-side-effect/iu],
				["sudo true", /read-only sandbox.*elevation/iu],
				["cat .env", /approval ceiling.*sensitive-read/iu],
				["bash -c 'cat package.json'", /read-only sandbox.*write scope/iu],
			] as const) {
				fake.sandboxExec.mockClear();
				fake.hostExec.mockClear();
				harness.setResponses([
					fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" }),
					fauxAssistantMessage("done"),
				]);
				await harness.session.prompt(`run ${command}`);
				expect(fake.sandboxExec).not.toHaveBeenCalled();
				expect(fake.hostExec).not.toHaveBeenCalled();
				const toolResult = [...harness.session.messages].reverse().find((message) => message.role === "toolResult");
				expect(toolResult?.isError).toBe(true);
				expect(getMessageText(toolResult)).toMatch(pattern);
			}

			harness.setResponses([
				fauxAssistantMessage([fauxToolCall("bash", { command: "printf x > tracked.txt" })], {
					stopReason: "toolUse",
				}),
				fauxAssistantMessage("done"),
			]);
			await harness.session.prompt("write tracked");
			expect(readFileSync(trackedFile, "utf8")).toBe("original");
		});

		it("emits Default mode after cancel even if sandbox reset fails", async () => {
			const fake = fakeBashBoundary();
			const resetSpy = vi.spyOn(fake.boundary, "reset");
			const harness = await createHarness({
				permissionPreset: "ask",
				interactiveBashBoundary: fake.boundary,
			});
			harnesses.push(harness);
			const events: string[] = [];
			harness.session.subscribe((event) => {
				if (event.type === "plan_changed" || event.type === "collaboration_mode_changed") {
					events.push(event.type);
				}
			});
			await harness.session.setCollaborationMode("plan");
			resetSpy.mockRejectedValueOnce(new Error("sandbox reset failed"));
			const plan = harness.session.submitPlan({ title: "Safe greeting", markdown: "# Goal\n\nGreet." });
			await expect(
				harness.session.cancelPlan({ planId: plan.planId, revision: plan.revision }),
			).resolves.toMatchObject({
				status: "cancelled",
			});
			expect(harness.session.sessionManager.getCollaborationMode()).toBe("default");
			expect(events).toEqual([
				"collaboration_mode_changed",
				"plan_changed",
				"plan_changed",
				"collaboration_mode_changed",
			]);
		});
	});

	it("routes Bash through the read-only sandbox when workspaceWritePolicy is deny", async () => {
		const fake = fakeBashBoundary();
		const harness = await createHarness({
			permissionPreset: "full",
			workspaceWritePolicy: "deny",
			excludedToolNames: ["edit", "write"],
			initialActiveToolNames: ["bash", "read"],
			interactiveBashBoundary: fake.boundary,
		});
		fake.setCwd(harness.tempDir);
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run it");

		expect(fake.sandboxExec).toHaveBeenCalledOnce();
		expect(fake.hostExec).not.toHaveBeenCalled();
		expect(harness.session.getActiveToolNames()).not.toEqual(expect.arrayContaining(["edit", "write"]));
	});
});
