import type { TUI } from "@metis/tui";
import { Value } from "typebox/value";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { SubagentManager } from "../src/core/subagents/manager.ts";
import { createSubagentTools } from "../src/core/subagents/tools.ts";
import { AGENT_TOOL_NAMES, MAX_AGENT_INPUT_UTF8_BYTES } from "../src/core/subagents/types.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const ACTOR_ID = "parent-session-1";

function execute(
	tool: ReturnType<typeof createSubagentTools>[number],
	params: Record<string, unknown>,
	signal?: AbortSignal,
) {
	return tool.execute("call", params, signal, undefined, {} as never);
}

function setup() {
	const manager = {
		spawn: vi.fn(async (_actorId, input) => ({
			agentId: "child-1",
			taskId: "task-1",
			name: input.name,
			agentType: input.agentType ?? ("default" as const),
			status: "running" as const,
			tools: input.agentType === "explorer" ? ["read", "grep"] : ["read", "bash"],
			writePolicy: input.agentType === "explorer" ? ("deny" as const) : ("inherit" as const),
			mayDelegate: input.agentType !== "explorer",
		})),
		inspect: vi.fn(async () => ({ kind: "list" as const, agents: [] })),
		sendMessage: vi.fn(async (_actorId, input) => ({
			agentId: input.agentId,
			taskId: "task-1",
			delivery: "accepted" as const,
		})),
		followUpTask: vi.fn(async (_actorId, input) => ({
			agentId: input.agentId,
			taskId: "task-2",
			status: "queued" as const,
		})),
		waitAgents: vi.fn(async () => ({
			timedOut: false,
			agents: [],
			mailboxEventIds: ["agent:child-1:task-1:terminal"],
		})),
		interrupt: vi.fn(async (_actorId, agentId) => ({
			agentId,
			taskId: "task-1",
			status: "stopped" as const,
			cancelledTaskIds: [],
		})),
	} as unknown as SubagentManager;
	const stageAgentMailboxDelivery = vi.fn((eventIds: readonly string[]) => eventIds);
	const session = {
		sessionManager: { getSessionId: () => ACTOR_ID },
		activeDurableTurnId: "turn-1",
		stageAgentMailboxDelivery,
	} as unknown as AgentSession;
	return {
		manager,
		session,
		stageAgentMailboxDelivery,
		tools: createSubagentTools({ getManager: () => manager, getSession: () => session }),
	};
}

describe("agent control tools", () => {
	beforeAll(() => initTheme("dark"));

	it("installs exactly the six asynchronous orchestration tools", () => {
		const { tools } = setup();
		expect(tools.map((tool) => tool.name)).toEqual([...AGENT_TOOL_NAMES]);
		const spawn = tools.find((tool) => tool.name === "spawn_agent")!;
		const followUp = tools.find((tool) => tool.name === "followup_task")!;
		const wait = tools.find((tool) => tool.name === "wait_agents")!;
		expect(Value.Check(spawn.parameters, { name: "researcher", task: "inspect", agentType: "explorer" })).toBe(true);
		expect(Value.Check(spawn.parameters, { name: "researcher", task: "inspect", model: "together/Qwen/Qwen3" })).toBe(
			true,
		);
		expect(Value.Check(spawn.parameters, { name: "researcher", task: "inspect", background: true })).toBe(false);
		expect(
			Value.Check(spawn.parameters, { name: "researcher", task: "x".repeat(MAX_AGENT_INPUT_UTF8_BYTES + 1) }),
		).toBe(false);
		expect(Value.Check(followUp.parameters, { agentId: "child-1", task: "continue", background: true })).toBe(false);
		expect(Value.Check(wait.parameters, { agentIds: ["child-1"], timeoutMs: 10 })).toBe(true);
		expect(Value.Check(wait.parameters, {})).toBe(false);
		expect(JSON.stringify(spawn.parameters)).toContain(
			"The agent_coordination prompt lists every available role with its tool, write, and delegation capabilities.",
		);
	});

	it("forwards the public inputs and returns receipts without implicit waiting", async () => {
		const { manager, tools } = setup();
		const controller = new AbortController();
		const spawnResult = await execute(
			tools.find((tool) => tool.name === "spawn_agent")!,
			{ name: "researcher", task: "inspect", agentType: "explorer", forkTurns: 2, model: "faux/faux" },
			controller.signal,
		);
		expect(manager.spawn).toHaveBeenCalledWith(
			ACTOR_ID,
			{
				name: "researcher",
				task: "inspect",
				agentType: "explorer",
				forkTurns: 2,
				model: "faux/faux",
			},
			controller.signal,
		);
		expect(manager.waitAgents).not.toHaveBeenCalled();
		expect(spawnResult.details).toMatchObject({ agentId: "child-1", taskId: "task-1", status: "running" });

		await execute(tools.find((tool) => tool.name === "followup_task")!, {
			agentId: "child-1",
			task: "check edge case",
		});
		expect(manager.followUpTask).toHaveBeenCalledWith(
			ACTOR_ID,
			{ agentId: "child-1", task: "check edge case", requestId: expect.any(String) },
			undefined,
		);
		expect(manager.waitAgents).not.toHaveBeenCalled();
	});

	it.each(["send_message", "followup_task"])(
		"keeps %s replay identity stable and separates new turns and calls",
		async (name) => {
			const { manager, tools, session } = setup();
			const method = name === "send_message" ? "sendMessage" : "followUpTask";
			const params =
				name === "send_message"
					? { agentId: "child-1", message: "Same text" }
					: { agentId: "child-1", task: "Same text" };
			const tool = tools.find((candidate) => candidate.name === name)!;
			const controller = new AbortController();
			await execute(tool, params, controller.signal);
			await execute(tool, params, controller.signal);
			const identity = vi.mocked(manager[method]).mock.calls[0]![1].requestId;
			expect(identity).toMatch(/^agent-tool-[a-f0-9]{64}$/);
			expect(vi.mocked(manager[method]).mock.calls[1]![1].requestId).toBe(identity);
			expect(vi.mocked(manager[method]).mock.calls[0]![2]).toBe(controller.signal);
			const recreated = createSubagentTools({ getManager: () => manager, getSession: () => session });
			await execute(recreated.find((candidate) => candidate.name === name)!, params);
			expect(vi.mocked(manager[method]).mock.calls[2]![1].requestId).toBe(identity);
			Object.defineProperty(session, "activeDurableTurnId", { value: "turn-2" });
			await execute(tool, params);
			expect(vi.mocked(manager[method]).mock.calls[3]![1].requestId).not.toBe(identity);
			await tool.execute("another-call", params, undefined, undefined, {} as never);
			expect(vi.mocked(manager[method]).mock.calls[4]![1].requestId).not.toBe(
				vi.mocked(manager[method]).mock.calls[3]![1].requestId,
			);
		},
	);

	it("keeps inspect task-scoped and stages only mailbox ids returned by wait", async () => {
		const { manager, stageAgentMailboxDelivery, tools } = setup();
		await execute(tools.find((tool) => tool.name === "inspect_agents")!, {
			agentId: "child-1",
			taskId: "task-1",
			beforeEventId: "event-2",
			limit: 10,
		});
		expect(manager.inspect).toHaveBeenCalledWith(ACTOR_ID, {
			agentId: "child-1",
			taskId: "task-1",
			beforeEventId: "event-2",
			limit: 10,
		});

		await execute(tools.find((tool) => tool.name === "send_message")!, {
			agentId: "child-1",
			message: "stay focused",
		});
		await execute(tools.find((tool) => tool.name === "wait_agents")!, {
			agentIds: ["child-1"],
			timeoutMs: 50,
		});
		await execute(tools.find((tool) => tool.name === "interrupt_agent")!, { agentId: "child-1" });
		expect(manager.sendMessage).toHaveBeenCalledWith(
			ACTOR_ID,
			{
				agentId: "child-1",
				message: "stay focused",
				requestId: expect.any(String),
			},
			undefined,
		);
		expect(manager.waitAgents).toHaveBeenCalledWith(ACTOR_ID, { agentIds: ["child-1"], timeoutMs: 50 }, undefined);
		expect(stageAgentMailboxDelivery).toHaveBeenCalledWith(["agent:child-1:task-1:terminal"]);
		expect(manager.interrupt).toHaveBeenCalledWith(ACTOR_ID, "child-1");
	});

	it("returns only compact wait identities, statuses, and terminal results to the model", async () => {
		const { manager, tools } = setup();
		vi.mocked(manager.waitAgents).mockResolvedValueOnce({
			timedOut: false,
			agents: [
				{
					agentId: "child-1",
					name: "secret worker",
					agentType: "worker",
					depth: 1,
					status: "done",
					archived: false,
					tools: ["read", "bash"],
					writePolicy: "inherit",
					mayDelegate: true,
					parentSessionId: ACTOR_ID,
					rootSessionId: ACTOR_ID,
					agentPath: ["child-1"],
					tasks: [
						{
							taskId: "task-1",
							taskSummary: "private task summary",
							status: "done",
							finalMessage: "SECRET_FINAL_TRANSCRIPT",
							createdAt: new Date(0).toISOString(),
							updatedAt: new Date(0).toISOString(),
						},
					],
					latestTask: {
						taskId: "task-1",
						taskSummary: "private task summary",
						status: "done",
						finalMessage: "SECRET_FINAL_TRANSCRIPT",
						createdAt: new Date(0).toISOString(),
						updatedAt: new Date(0).toISOString(),
					},
					createdAt: new Date(0).toISOString(),
					updatedAt: new Date(0).toISOString(),
				},
			],
			mailboxEventIds: ["agent:child-1:task-1:terminal"],
		});

		const waited = await execute(tools.find((tool) => tool.name === "wait_agents")!, {
			agentIds: ["child-1"],
		});
		const serialized = JSON.stringify(waited);
		expect(waited.details).toEqual({
			timedOut: false,
			agents: [{ agentId: "child-1", taskId: "task-1", status: "done" }],
			mailboxEventIds: ["agent:child-1:task-1:terminal"],
			terminalResults: [
				{
					agentId: "child-1",
					taskId: "task-1",
					status: "done",
					finalMessage: "SECRET_FINAL_TRANSCRIPT",
				},
			],
		});
		expect(serialized).toContain("SECRET_FINAL_TRANSCRIPT");
		expect(serialized).not.toContain("private task summary");
	});

	it("returns the mailbox task result when a queued follow-up is already running", async () => {
		const { manager, tools } = setup();
		const createdAt = new Date(0).toISOString();
		const first = {
			taskId: "task-1",
			taskSummary: "first private task",
			status: "done" as const,
			finalMessage: "first final",
			createdAt,
			updatedAt: createdAt,
		};
		const second = {
			taskId: "task-2",
			taskSummary: "second private task",
			status: "running" as const,
			createdAt,
			updatedAt: createdAt,
		};
		vi.mocked(manager.waitAgents).mockResolvedValueOnce({
			timedOut: false,
			agents: [
				{
					agentId: "child-1",
					name: "worker",
					agentType: "worker",
					depth: 1,
					status: "running",
					archived: false,
					tools: ["read", "bash"],
					writePolicy: "inherit",
					mayDelegate: true,
					parentSessionId: ACTOR_ID,
					rootSessionId: ACTOR_ID,
					agentPath: ["child-1"],
					tasks: [first, second],
					currentTask: second,
					latestTask: second,
					createdAt,
					updatedAt: createdAt,
				},
			],
			mailboxEventIds: ["agent:child-1:task-1:terminal"],
		});

		const waited = await execute(tools.find((tool) => tool.name === "wait_agents")!, {
			agentIds: ["child-1"],
		});
		expect(waited.details).toEqual({
			timedOut: false,
			agents: [{ agentId: "child-1", taskId: "task-2", status: "running" }],
			mailboxEventIds: ["agent:child-1:task-1:terminal"],
			terminalResults: [{ agentId: "child-1", taskId: "task-1", status: "done", finalMessage: "first final" }],
		});
	});

	it("keeps full inspect activity behind expansion", async () => {
		const { manager, tools } = setup();
		const marker = "FULL_TRACE_PAYLOAD";
		vi.mocked(manager.inspect).mockResolvedValueOnce({
			kind: "trace",
			agent: {
				agentId: "child-1",
				name: "researcher",
				agentType: "default",
				depth: 1,
				status: "done",
				archived: false,
				tools: ["read", "grep"],
				writePolicy: "deny",
				mayDelegate: false,
				parentSessionId: ACTOR_ID,
				rootSessionId: ACTOR_ID,
				agentPath: ["child-1"],
				tasks: [],
				createdAt: new Date(0).toISOString(),
				updatedAt: new Date(0).toISOString(),
			},
			taskId: "task-1",
			events: [
				{
					eventId: "event-1",
					taskId: "task-1",
					timestamp: new Date(0).toISOString(),
					kind: "final",
					text: marker,
				},
			],
			nextBeforeEventId: "event-older",
		});
		const inspect = tools.find((tool) => tool.name === "inspect_agents")!;
		const result = await execute(inspect, { agentId: "child-1", taskId: "task-1", limit: 10 });
		const modelText = result.content.find((block) => block.type === "text")?.text ?? "";
		expect(modelText).toContain("Capabilities tools=[read, grep] · writes=deny · delegation=denied");
		expect(modelText).toContain("Task task-1");
		expect(modelText).toContain("Next before event event-older");
		const component = new ToolExecutionComponent(
			"inspect_agents",
			"call",
			{ agentId: "child-1", taskId: "task-1", limit: 10 },
			{},
			inspect,
			{ requestRender: () => undefined } as unknown as TUI,
			process.cwd(),
		);
		component.updateResult({ ...result, isError: false });
		expect(stripAnsi(component.render(120).join("\n"))).not.toContain(marker);
		expect(result.details).toMatchObject({
			agent: { tools: ["read", "grep"], writePolicy: "deny", mayDelegate: false },
		});
		component.setExpanded(true);
		expect(stripAnsi(component.render(120).join("\n"))).toContain(marker);
	});

	it("exposes compact relation, task identity, usage, and update time to the model", async () => {
		const { manager, tools } = setup();
		const at = new Date(0).toISOString();
		const task = {
			taskId: "task-1",
			taskSummary: "review the boundary",
			status: "done" as const,
			finalMessage: "private full-history result",
			usage: {
				model: { provider: "faux", modelId: "faux" },
				input: 3,
				output: 5,
				cacheRead: 0,
				cacheWrite: 0,
				elapsedMs: 10,
				toolCalls: 2,
			},
			createdAt: at,
			updatedAt: at,
		};
		vi.mocked(manager.inspect).mockResolvedValueOnce({
			kind: "list",
			agents: [
				{
					agentId: "child-1",
					name: "reviewer",
					agentType: "reviewer",
					depth: 2,
					status: "done",
					archived: false,
					tools: ["read", "grep", "bash"],
					writePolicy: "deny",
					mayDelegate: false,
					parentSessionId: "parent-agent",
					rootSessionId: ACTOR_ID,
					agentPath: ["parent-agent", "child-1"],
					tasks: [task],
					latestTask: task,
					createdAt: at,
					updatedAt: at,
				},
			],
			usage: { input: 3, output: 5, cacheRead: 0, cacheWrite: 0, elapsedMs: 10 },
		});
		const inspected = await execute(tools.find((tool) => tool.name === "inspect_agents")!, {});
		const content = inspected.content.find((block) => block.type === "text")?.text ?? "";
		expect(content).toContain("parent=parent-agent depth=2");
		expect(content).toContain("Latest task task-1");
		expect(content).toContain("input=3 output=5 toolCalls=2");
		expect(content).toContain(`updated=${at}`);
		expect(JSON.stringify(inspected.details)).not.toContain("private full-history result");
		expect(inspected.details).not.toHaveProperty("agents.0.tasks");
	});

	it("returns terminal results only for the mailbox ids actually staged", async () => {
		const { manager, stageAgentMailboxDelivery, tools } = setup();
		const at = new Date(0).toISOString();
		const tasks = ["task-1", "task-2"].map((taskId) => ({
			taskId,
			taskSummary: taskId,
			status: "done" as const,
			finalMessage: `${taskId} final`,
			createdAt: at,
			updatedAt: at,
		}));
		vi.mocked(stageAgentMailboxDelivery).mockReturnValueOnce(["agent:child-1:task-1:terminal"]);
		vi.mocked(manager.waitAgents).mockResolvedValueOnce({
			timedOut: false,
			agents: [
				{
					agentId: "child-1",
					name: "worker",
					agentType: "worker",
					depth: 1,
					status: "done",
					archived: false,
					tools: ["read", "bash"],
					writePolicy: "inherit",
					mayDelegate: true,
					parentSessionId: ACTOR_ID,
					rootSessionId: ACTOR_ID,
					agentPath: ["child-1"],
					tasks,
					latestTask: tasks[1],
					createdAt: at,
					updatedAt: at,
				},
			],
			mailboxEventIds: ["agent:child-1:task-1:terminal", "agent:child-1:task-2:terminal"],
		});
		const waited = await execute(tools.find((tool) => tool.name === "wait_agents")!, {
			agentIds: ["child-1"],
		});
		expect(waited.details).toMatchObject({
			mailboxEventIds: ["agent:child-1:task-1:terminal"],
			terminalResults: [{ taskId: "task-1", finalMessage: "task-1 final" }],
		});
		expect(JSON.stringify(waited.details)).not.toContain("task-2 final");
	});
});
