import type { AgentTool } from "@arcmind/agent-core";
import { fauxAssistantMessage, fauxToolCall, type SimpleStreamOptions } from "@arcmind/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	type SandboxManagerAdapter,
	SandboxRuntimeCoordinator,
	type SandboxSpawnInput,
} from "../src/core/sandbox-runtime.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { createHarness, getMessageText, type Harness } from "./suite/harness.ts";

function customTool(
	execute = vi.fn(async () => ({ content: [{ type: "text" as const, text: "done" }], details: {} })),
) {
	const tool: AgentTool = {
		name: "custom_action",
		label: "Custom action",
		description: "Test custom action",
		parameters: Type.Object({ value: Type.String() }),
		execute,
	};
	return { tool, execute };
}

describe("AgentSession permission enforcement", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		while (harnesses.length > 0) await harnesses.pop()?.cleanup();
	});

	it("uses user approval without reviewer in Ask mode and audits the decision", async () => {
		const { tool, execute } = customTool();
		const reviewer = vi.fn(async () => '{"decision":"allow","reason":"ok"}');
		const requestApproval = vi.fn(async () => ({ decision: "allow" as const }));
		const harness = await createHarness({
			tools: [tool],
			permissionSettings: { mode: "ask", reviewerEnabled: true },
			permissionReviewerStream: reviewer,
			requestPermissionApproval: requestApproval,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("custom_action", { value: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run the custom action");

		expect(reviewer).not.toHaveBeenCalled();
		expect(requestApproval).toHaveBeenCalledOnce();
		expect(execute).toHaveBeenCalledOnce();
		expect(harness.sessionManager.getDurableJournalSnapshot()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "session_permission_decision",
					source: "user",
					decision: "allow",
					toolName: "custom_action",
				}),
			]),
		);
	});

	it("lets the current-session reviewer allow one Auto action without user approval", async () => {
		const { tool, execute } = customTool();
		const reviewer = vi.fn(async () => '{"decision":"allow","reason":"Matches the explicit request"}');
		const requestApproval = vi.fn(async () => ({ decision: "deny" as const }));
		const harness = await createHarness({
			tools: [tool],
			permissionSettings: { mode: "auto", reviewerEnabled: true },
			permissionReviewerStream: reviewer,
			requestPermissionApproval: requestApproval,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("custom_action", { value: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run the custom action");

		expect(reviewer).toHaveBeenCalledOnce();
		expect(requestApproval).not.toHaveBeenCalled();
		expect(execute).toHaveBeenCalledOnce();
		expect(harness.sessionManager.getDurableJournalSnapshot()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "session_permission_decision",
					source: "reviewer",
					decision: "allow",
				}),
			]),
		);
	});

	it("runs the reviewer with thinking off or the model's lowest supported level", async () => {
		const { tool } = customTool();
		const harness = await createHarness({
			models: [{ id: "faux-1", reasoning: true }],
			tools: [tool],
			permissionSettings: { mode: "auto", reviewerEnabled: true },
		});
		harnesses.push(harness);
		const reviewerReasoning: Array<SimpleStreamOptions["reasoning"]> = [];
		const reviewerResponse = (_context: unknown, options: unknown) => {
			reviewerReasoning.push((options as SimpleStreamOptions | undefined)?.reasoning);
			return fauxAssistantMessage('{"decision":"allow","reason":"Matches the request"}');
		};

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("custom_action", { value: "off" })], { stopReason: "toolUse" }),
			reviewerResponse,
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run it");

		Object.assign(harness.getModel(), { thinkingLevelMap: { off: null, minimal: null } });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("custom_action", { value: "low" })], { stopReason: "toolUse" }),
			reviewerResponse,
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("run it again");

		expect(reviewerReasoning).toEqual([undefined, "low"]);
	});

	it("escalates reviewer ask to the user and records both decisions", async () => {
		const { tool } = customTool();
		const harness = await createHarness({
			tools: [tool],
			permissionSettings: { mode: "auto", reviewerEnabled: true },
			permissionReviewerStream: async () => '{"decision":"ask","reason":"Target is ambiguous"}',
			requestPermissionApproval: async () => ({ decision: "allow" }),
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("custom_action", { value: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run it");

		const decisions = harness.sessionManager
			.getDurableJournalSnapshot()
			.filter((entry) => entry.type === "session_permission_decision");
		expect(decisions).toEqual([
			expect.objectContaining({ source: "reviewer", decision: "ask" }),
			expect.objectContaining({ source: "user", decision: "allow" }),
		]);
	});

	it("fails closed when approval is required but no UI exists", async () => {
		const { tool, execute } = customTool();
		const harness = await createHarness({
			tools: [tool],
			permissionSettings: { mode: "ask", reviewerEnabled: true },
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("custom_action", { value: "x" })], { stopReason: "toolUse" }),
		]);

		await harness.session.prompt("run it");
		expect(execute).not.toHaveBeenCalled();
		expect(
			harness.session.messages.some(
				(message) =>
					message.role === "toolResult" && getMessageText(message).includes("no approval UI is available"),
			),
		).toBe(true);
	});

	it("consumes manual bash approval exactly once", async () => {
		const harness = await createHarness({
			permissionSettings: { mode: "ask", reviewerEnabled: true },
			requestPermissionApproval: async () => ({ decision: "allow" }),
		});
		harnesses.push(harness);
		const operations: BashOperations = {
			exec: async (_command, _cwd, options) => {
				options.onData(Buffer.from("ok"));
				return { exitCode: 0 };
			},
		};
		const authorization = await harness.session.authorizeUserBash("echo ok");

		await expect(
			harness.session.executeBash("echo ok", undefined, { operations, authorization }),
		).resolves.toMatchObject({ output: "ok" });
		await expect(harness.session.executeBash("echo ok", undefined, { operations, authorization })).rejects.toThrow(
			"Invalid or expired one-action permission grant",
		);
	});

	it("Full mode bypasses reviewer and user approval", async () => {
		const { tool, execute } = customTool();
		const reviewer = vi.fn(async () => '{"decision":"deny","reason":"no"}');
		const requestApproval = vi.fn(async () => ({ decision: "deny" as const }));
		const harness = await createHarness({
			tools: [tool],
			permissionSettings: { mode: "full", reviewerEnabled: true },
			permissionReviewerStream: reviewer,
			requestPermissionApproval: requestApproval,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("custom_action", { value: "x" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("run it");

		expect(execute).toHaveBeenCalledOnce();
		expect(reviewer).not.toHaveBeenCalled();
		expect(requestApproval).not.toHaveBeenCalled();
	});

	it("runs an automatically allowed Ask-mode bash read through SRT with its returned environment", async () => {
		const events: string[] = [];
		const manager: SandboxManagerAdapter = {
			isSupportedPlatform: () => true,
			checkDependencies: () => ({ errors: [], warnings: [] }),
			reset: async () => {
				events.push("reset");
			},
			initialize: async () => {
				events.push("initialize");
			},
			wrapWithSandboxArgv: async () => {
				events.push("wrap");
				return { argv: ["wrapped", "pwd"], env: { SRT_ONLY: "1" } };
			},
			cleanupAfterCommand: async () => {
				events.push("cleanup");
			},
		};
		let spawnInput: SandboxSpawnInput | undefined;
		const sandboxRuntime = new SandboxRuntimeCoordinator({
			agentDir: process.cwd(),
			manager,
			acquireLock: async () => async () => {
				events.push("release");
			},
			spawn: async (input) => {
				spawnInput = input;
				events.push("spawn");
				input.onData(Buffer.from("sandboxed"));
				return { exitCode: 0 };
			},
		});
		const harness = await createHarness({
			permissionSettings: { mode: "ask", reviewerEnabled: true },
			sandboxRuntime,
		});
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("bash", { command: "pwd" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		await harness.session.prompt("show the current directory");

		expect(spawnInput?.env).toEqual({ SRT_ONLY: "1" });
		expect(events).toEqual(["reset", "initialize", "wrap", "spawn", "cleanup", "reset", "release"]);
		expect(
			harness.session.messages.some(
				(message) => message.role === "toolResult" && getMessageText(message).includes("sandboxed"),
			),
		).toBe(true);
	});
});
