import { getModel } from "@metis/ai/compat";
import type { TUI } from "@metis/tui";
import { Value } from "typebox/value";
import { beforeAll, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-runtime.ts";
import { classifyAction } from "../src/core/permissions/classify.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createSetTasksToolDefinition, type SetTasksInput } from "../src/core/set-tasks.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

beforeAll(() => initTheme("dark"));

function taskInput() {
	return {
		tasks: [
			{ task: "  Inspect the implementation  ", completed: true },
			{ task: "Implement the task panel", completed: false },
			{ task: "Run packaged validation", completed: false },
		],
	};
}

async function renderTasks(input: SetTasksInput, keepAnsi = false): Promise<string> {
	const tool = createSetTasksToolDefinition();
	const result = await tool.execute("tasks-render", input, undefined, undefined, {} as never);
	const component = new ToolExecutionComponent(
		"set_tasks",
		"tasks-render",
		input,
		{},
		undefined,
		{ requestRender() {} } as unknown as TUI,
		process.cwd(),
	);
	component.setArgsComplete();
	component.updateResult({ ...result, isError: false });
	const rendered = component.render(120).join("\n");
	return keepAnsi ? rendered : stripAnsi(rendered);
}

describe("set_tasks", () => {
	it("accepts multiple unfinished tasks and returns a normalized full snapshot", async () => {
		const tool = createSetTasksToolDefinition();
		expect(Object.keys(tool.parameters.properties)).toEqual(["tasks"]);
		expect(Value.Check(tool.parameters, { ...taskInput(), explanation: "not supported" })).toBe(false);

		const result = await tool.execute("tasks-1", taskInput(), undefined, undefined, {} as never);

		expect(result.details).toEqual({
			tasks: [
				{ task: "Inspect the implementation", completed: true },
				{ task: "Implement the task panel", completed: false },
				{ task: "Run packaged validation", completed: false },
			],
		});
		expect(result.content).toEqual([
			{
				type: "text",
				text: [
					"<task_list>",
					"- [x] Inspect the implementation",
					"- [ ] Implement the task panel",
					"- [ ] Run packaged validation",
					"</task_list>",
				].join("\n"),
			},
		]);
	});

	it("rejects empty snapshots and blank labels while permitting multiple unfinished tasks", async () => {
		const tool = createSetTasksToolDefinition();
		expect(Value.Check(tool.parameters, { tasks: [] })).toBe(false);
		await expect(tool.execute("clear", { tasks: [] }, undefined, undefined, {} as never)).rejects.toThrow(
			"At least one task is required",
		);
		await expect(
			tool.execute("blank", { tasks: [{ task: "   ", completed: false }] }, undefined, undefined, {} as never),
		).rejects.toThrow("Tasks cannot be empty");
		await expect(
			tool.execute(
				"parallel",
				{
					tasks: [
						{ task: "One", completed: false },
						{ task: "Two", completed: false },
					],
				},
				undefined,
				undefined,
				{} as never,
			),
		).resolves.toMatchObject({ details: { tasks: expect.any(Array) } });
	});

	it("uses only the compact model-visible prompt", () => {
		const tool = createSetTasksToolDefinition();
		expect(tool.promptSnippet).toBe("Set the visible task list");
		expect(tool.description).toBe(
			"Send the complete visible task list for multi-step work; skip simple tasks. " +
				"Each call replaces the previous list. Keep completed=false until finished; " +
				"multiple tasks may remain false. Call only on meaningful changes. " +
				"When all tasks are completed, tracking ends automatically; no close call is needed.",
		);
		expect(tool.promptGuidelines).toBeUndefined();
	});

	it("renders unfinished and completed task snapshots", async () => {
		const rendered = await renderTasks(taskInput());
		expect(rendered).toContain("Tasks · 1/3");
		expect(rendered).toContain("[✓] Inspect the implementation");
		expect(rendered).toContain("[→] Implement the task panel");
		expect(rendered.match(/Inspect the implementation/g)).toHaveLength(1);
		expect(await renderTasks(taskInput(), true)).toContain(theme.bg("toolPendingBg", "x").split("x")[0]);

		const completed = await renderTasks({ tasks: [{ task: "Ship it", completed: true }] });
		expect(completed).toContain("Tasks · 1/1");
		expect(await renderTasks({ tasks: [{ task: "Ship it", completed: true }] }, true)).toContain(
			theme.bg("toolSuccessBg", "x").split("x")[0],
		);
		const completedResult = await createSetTasksToolDefinition().execute(
			"completed",
			{ tasks: [{ task: "Ship it", completed: true }] },
			undefined,
			undefined,
			{} as never,
		);
		expect(completedResult.content).toEqual([
			{
				type: "text",
				text: [
					"<task_list>",
					"- [x] Ship it",
					"</task_list>",
					"All tasks are complete. No close call is needed.",
				].join("\n"),
			},
		]);
	});

	it("uses normal primary activation, explicit filtering, and no child-agent exposure", async () => {
		const createSession = async (
			options: { noTools?: "all" | "builtin"; tools?: string[]; excludeTools?: string[] } = {},
			agent = false,
		) => {
			const services = await createAgentSessionServices({
				cwd: process.cwd(),
				resourceLoaderOptions: {
					noContextFiles: true,
					noExtensions: true,
					noPromptTemplates: true,
					noSkills: true,
					noThemes: true,
				},
			});
			const sessionManager = SessionManager.inMemory(process.cwd(), {
				mode: "code",
				...(agent
					? {
							id: "child-agent",
							agent: {
								agentId: "child-agent",
								name: "child",
								agentType: "worker" as const,
								parentSessionId: "parent-session",
								rootSessionId: "parent-session",
								agentPath: ["child-agent"],
								cwd: process.cwd(),
								tools: ["read"],
								writePolicy: "inherit" as const,
								permissionPreset: "ask" as const,
								model: { provider: "anthropic", modelId: "claude-sonnet-4-5" },
								thinkingLevel: "high" as const,
								initialTask: "test",
								forkTurns: 0,
								timeoutSeconds: 60,
								mayDelegate: true,
							},
						}
					: {}),
			});
			return createAgentSessionFromServices({
				services,
				sessionManager,
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				...options,
			});
		};

		const primary = await createSession();
		expect(primary.session.getActiveToolNames()).toContain("set_tasks");
		expect(primary.session.getAllTools().map(({ name }) => name)).not.toContain(["update", "plan"].join("_"));
		expect(primary.session.systemPrompt).toContain("- set_tasks: Set the visible task list");
		primary.session.dispose();

		const noBuiltins = await createSession({ noTools: "builtin" });
		expect(noBuiltins.session.getActiveToolNames()).not.toContain("set_tasks");
		noBuiltins.session.dispose();

		const explicit = await createSession({ tools: ["set_tasks"] });
		expect(explicit.session.getActiveToolNames()).toEqual(["set_tasks"]);
		explicit.session.dispose();

		const excluded = await createSession({ excludeTools: ["set_tasks"] });
		expect(excluded.session.getAllTools().map(({ name }) => name)).not.toContain("set_tasks");
		excluded.session.dispose();

		const child = await createSession({}, true);
		expect(child.session.getAllTools().map(({ name }) => name)).not.toContain("set_tasks");
		child.session.dispose();
	});

	it("does not require permission approval", () => {
		const action = classifyAction({
			actionId: "tasks-1",
			toolName: "set_tasks",
			provenance: "builtin",
			args: taskInput(),
			cwd: process.cwd(),
			workspaceRoots: [process.cwd()],
		});
		expect(action.risks).toEqual(["ordinary-read"]);
	});
});
