import type { TUI } from "@metis/tui";
import { Value } from "typebox/value";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { SubagentManager } from "../src/core/subagents/manager.ts";
import { createSubagentTools } from "../src/core/subagents/tools.ts";
import { AGENT_TOOL_NAMES } from "../src/core/subagents/types.ts";
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
	const stageAgentMailboxDelivery = vi.fn();
	const session = {
		sessionManager: { getSessionId: () => ACTOR_ID },
		stageAgentMailboxDelivery,
	} as unknown as AgentSession;
	return {
		manager,
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
		expect(Value.Check(spawn.parameters, { name: "researcher", task: "inspect", background: true })).toBe(false);
		expect(Value.Check(followUp.parameters, { agentId: "child-1", task: "continue", background: true })).toBe(false);
		expect(Value.Check(wait.parameters, { agentIds: ["child-1"], timeoutMs: 10 })).toBe(true);
		expect(Value.Check(wait.parameters, {})).toBe(false);
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
			{ agentId: "child-1", task: "check edge case" },
			undefined,
		);
		expect(manager.waitAgents).not.toHaveBeenCalled();
	});

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
		expect(manager.sendMessage).toHaveBeenCalledWith(ACTOR_ID, {
			agentId: "child-1",
			message: "stay focused",
		});
		expect(manager.waitAgents).toHaveBeenCalledWith(ACTOR_ID, { agentIds: ["child-1"], timeoutMs: 50 }, undefined);
		expect(stageAgentMailboxDelivery).toHaveBeenCalledWith(["agent:child-1:task-1:terminal"]);
		expect(manager.interrupt).toHaveBeenCalledWith(ACTOR_ID, "child-1");
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
		});
		const inspect = tools.find((tool) => tool.name === "inspect_agents")!;
		const result = await execute(inspect, { agentId: "child-1", taskId: "task-1", limit: 10 });
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
		component.setExpanded(true);
		expect(stripAnsi(component.render(120).join("\n"))).toContain(marker);
	});
});
