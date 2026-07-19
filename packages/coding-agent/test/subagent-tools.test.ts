import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { SubagentManager } from "../src/core/subagents/manager.ts";
import { createSubagentTools } from "../src/core/subagents/tools.ts";
import { SUBAGENT_TOOL_NAMES } from "../src/core/subagents/types.ts";

function execute(
	tool: ReturnType<typeof createSubagentTools>[number],
	params: Record<string, unknown>,
	signal?: AbortSignal,
) {
	return tool.execute("call", params, signal, undefined, {} as never);
}

function setup() {
	let selection: "high" | "ultra" = "ultra";
	const manager = {
		spawn: vi.fn(async (input) => ({
			...input,
			agentId: "child-1",
			status: "running",
			taskSummary: input.task,
			mode: "code",
			permissionMode: "ask",
			forkTurns: 0,
		})),
		inspect: vi.fn(async () => ({
			agents: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, elapsedMs: 0 },
		})),
		message: vi.fn(async (input) => ({ agentId: input.agentId, status: "running", delivery: "accepted" })),
		wait: vi.fn(async () => ({ agents: [] })),
		interrupt: vi.fn(async (agentId) => ({ agentId, status: "stopped" })),
		close: vi.fn(async (agentId) => ({ agentId, status: "closed" })),
	} as unknown as SubagentManager;
	const session = { getThinkingSelection: () => selection } as unknown as AgentSession;
	const tools = createSubagentTools({ getManager: () => manager, getSession: () => session });
	return {
		manager,
		tools,
		setSelection: (value: "high" | "ultra") => {
			selection = value;
		},
	};
}

describe("subagent control tools", () => {
	it("defines exactly six strict schemas and forwards structured results", async () => {
		const { manager, tools } = setup();
		expect(tools.map((tool) => tool.name)).toEqual(SUBAGENT_TOOL_NAMES);
		const spawn = tools.find((tool) => tool.name === "spawn_agent")!;
		expect(Value.Check(spawn.parameters, { name: "researcher", task: "inspect", tools: [] })).toBe(true);
		expect(Value.Check(spawn.parameters, { name: "researcher", task: "inspect", tools: [], extra: true })).toBe(
			false,
		);
		expect(Value.Check(spawn.parameters, { name: "researcher", task: "inspect", tools: [], forkTurns: 0 })).toBe(
			false,
		);

		const response = await execute(spawn, { name: "researcher", task: "inspect", tools: [] });
		expect(manager.spawn).toHaveBeenCalledWith({
			name: "researcher",
			task: "inspect",
			tools: [],
			thinkingLevel: undefined,
		});
		expect(response.details).toMatchObject({ agentId: "child-1", status: "running" });
		expect(JSON.parse(response.content[0]!.type === "text" ? response.content[0]!.text : "null")).toMatchObject({
			agentId: "child-1",
		});
	});

	it("rejects stale creation and messaging outside Ultra while cleanup remains callable", async () => {
		const { manager, tools, setSelection } = setup();
		setSelection("high");
		await expect(
			execute(tools.find((tool) => tool.name === "spawn_agent")!, { name: "child", task: "task", tools: [] }),
		).rejects.toThrow("Ultra is required");
		await expect(
			execute(tools.find((tool) => tool.name === "message_agent")!, {
				agentId: "child-1",
				mode: "follow_up",
				message: "next",
			}),
		).rejects.toThrow("Ultra is required");
		await execute(tools.find((tool) => tool.name === "inspect_agents")!, {});
		await execute(tools.find((tool) => tool.name === "interrupt_agent")!, { agentId: "child-1" });
		expect(manager.inspect).toHaveBeenCalled();
		expect(manager.interrupt).toHaveBeenCalledWith("child-1");
	});

	it("passes only wait's abort signal to the manager", async () => {
		const { manager, tools } = setup();
		const controller = new AbortController();
		await execute(tools.find((tool) => tool.name === "wait_agents")!, { agentIds: ["child-1"] }, controller.signal);
		expect(manager.wait).toHaveBeenCalledWith({ agentIds: ["child-1"] }, controller.signal);
	});
});
