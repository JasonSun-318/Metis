import type { TUI } from "@metis/tui";
import { Value } from "typebox/value";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { SubagentManager } from "../src/core/subagents/manager.ts";
import { createSubagentTools } from "../src/core/subagents/tools.ts";
import { type ActivateSubagentsResult, SUBAGENT_ACTIVATION_TOOL_NAME } from "../src/core/subagents/types.ts";
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

function createFakeTui(): TUI {
	return { requestRender: () => undefined } as unknown as TUI;
}

function setup() {
	let selection: "high" | "ultra" = "ultra";
	const manager = {
		spawn: vi.fn(async (_actorId, input) => ({
			agentId: "child-1",
			taskId: "task-1",
			name: input.name,
			agentType: "default" as const,
			status: "running" as const,
		})),
		inspect: vi.fn(async () => ({
			kind: "list" as const,
			agents: [],
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, elapsedMs: 0 },
		})),
		interrupt: vi.fn(async (_actorId, agentId) => ({
			agentId,
			taskId: "task-1",
			status: "stopped" as const,
			cancelledTaskIds: [],
		})),
	} as unknown as SubagentManager;
	const activationResults: ActivateSubagentsResult[] = [
		{ activated: true, alreadyActivated: false },
		{ activated: true, alreadyActivated: true },
	];
	const activateSubagents = vi.fn(
		() => activationResults.shift() ?? { activated: true as const, alreadyActivated: true },
	);
	const session = {
		getThinkingSelection: () => selection,
		sessionManager: { getSessionId: () => ACTOR_ID },
	} as unknown as AgentSession;
	const tools = createSubagentTools({ getManager: () => manager, getSession: () => session, activateSubagents });
	return {
		activateSubagents,
		manager,
		tools,
		setSelection: (value: "high" | "ultra") => {
			selection = value;
		},
	};
}

describe("subagent control tools", () => {
	beforeAll(() => initTheme("dark"));

	it("defines one strict idempotent activation tool with the agreed model copy", async () => {
		const { activateSubagents, tools } = setup();
		const activate = tools.find((tool) => tool.name === SUBAGENT_ACTIVATION_TOOL_NAME)!;

		expect(activate.executionMode).toBe("sequential");
		expect(Value.Check(activate.parameters, {})).toBe(true);
		expect(Value.Check(activate.parameters, { extra: true })).toBe(false);

		const first = await execute(activate, {});
		expect(first.details).toEqual({ activated: true, alreadyActivated: false });
		await expect(execute(activate, {})).resolves.toMatchObject({
			details: { activated: true, alreadyActivated: true },
		});
		expect(activateSubagents).toHaveBeenCalledTimes(2);

		const component = new ToolExecutionComponent(
			SUBAGENT_ACTIVATION_TOOL_NAME,
			"call",
			{},
			{},
			activate,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ ...first, isError: false });
		expect(stripAnsi(component.render(120).join("\n"))).toContain("Subagents activated");
	});

	it("forwards actor-scoped spawn and inspect calls while Ultra is active", async () => {
		const { manager, tools } = setup();
		const spawn = tools.find((tool) => tool.name === "spawn_agent")!;
		expect(Value.Check(spawn.parameters, { name: "researcher", task: "inspect", tools: [], background: true })).toBe(
			true,
		);

		const response = await execute(spawn, {
			name: "researcher",
			task: "inspect",
			tools: [],
			background: true,
		});
		expect(manager.spawn).toHaveBeenCalledWith(
			ACTOR_ID,
			{
				name: "researcher",
				task: "inspect",
				forkTurns: undefined,
				model: undefined,
			},
			undefined,
		);
		expect(response.details).toMatchObject({ agentId: "child-1", status: "running" });

		await execute(tools.find((tool) => tool.name === "inspect_agents")!, {});
		expect(manager.inspect).toHaveBeenCalledWith(ACTOR_ID, {
			agentId: undefined,
			beforeEventId: undefined,
			limit: undefined,
		});
	});

	it("rejects stale creation outside Ultra while cleanup remains callable", async () => {
		const { activateSubagents, manager, tools, setSelection } = setup();
		setSelection("high");
		await expect(execute(tools.find((tool) => tool.name === SUBAGENT_ACTIVATION_TOOL_NAME)!, {})).rejects.toThrow(
			"Ultra is required",
		);
		expect(activateSubagents).not.toHaveBeenCalled();
		await expect(
			execute(tools.find((tool) => tool.name === "spawn_agent")!, {
				name: "child",
				task: "task",
				tools: [],
			}),
		).rejects.toThrow("Ultra is required");
		await execute(tools.find((tool) => tool.name === "inspect_agents")!, {});
		await execute(tools.find((tool) => tool.name === "interrupt_agent")!, { agentId: "child-1" });
		expect(manager.inspect).toHaveBeenCalled();
		expect(manager.interrupt).toHaveBeenCalledWith(ACTOR_ID, "child-1");
	});

	it("forwards abort signals for spawn", async () => {
		const { manager, tools } = setup();
		const controller = new AbortController();
		await execute(
			tools.find((tool) => tool.name === "spawn_agent")!,
			{ name: "child", task: "inspect", tools: [] },
			controller.signal,
		);
		expect(manager.spawn).toHaveBeenCalledWith(
			ACTOR_ID,
			{ name: "child", task: "inspect", forkTurns: undefined, model: undefined },
			controller.signal,
		);
	});

	it("collapses structured inspect results until the user expands them", async () => {
		const { manager, tools } = setup();
		const inspect = tools.find((tool) => tool.name === "inspect_agents")!;
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
				createdAt: new Date(0).toISOString(),
				updatedAt: new Date(0).toISOString(),
			},
			taskId: "task-1",
			events: Array.from({ length: 20 }, (_, index) => ({
				eventId: `event-${index}`,
				taskId: "task-1",
				timestamp: new Date(0).toISOString(),
				kind: "llm" as const,
				text: marker,
			})),
		});

		const response = await execute(inspect, { agentId: "child-1" });
		expect(response.content[0]?.type === "text" ? response.content[0].text : "").toContain("researcher");

		const component = new ToolExecutionComponent(
			"inspect_agents",
			"call",
			{ agentId: "child-1" },
			{},
			inspect,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ ...response, isError: false });

		component.setExpanded(true);
		const expanded = stripAnsi(component.render(120).join("\n"));
		expect(expanded).toContain(marker);
	});

	it("shows the real error in collapsed output", () => {
		const { tools } = setup();
		const inspect = tools.find((tool) => tool.name === "inspect_agents")!;
		const component = new ToolExecutionComponent(
			"inspect_agents",
			"call",
			{},
			{},
			inspect,
			createFakeTui(),
			process.cwd(),
		);
		component.updateResult({ content: [{ type: "text", text: "Permission denied" }], isError: true });

		const collapsed = stripAnsi(component.render(120).join("\n"));
		expect(collapsed).toContain("Permission denied");
		expect(collapsed).not.toContain("Completed");

		component.updateResult({ content: [], isError: true });
		const emptyError = stripAnsi(component.render(120).join("\n"));
		expect(emptyError).toContain("Failed");
	});
});
