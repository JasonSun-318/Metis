import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@arcmind/ai/compat";
import type { TUI } from "@arcmind/tui";
import { Value } from "typebox/value";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import {
	type AgentSessionRuntime,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/core/agent-session-runtime.ts";
import { classifyAction, routeAction } from "../src/core/permission-policy.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createUpdatePlanToolDefinition, type UpdatePlanInput } from "../src/core/update-plan.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const roots: string[] = [];
const runtimes: AgentSessionRuntime[] = [];
const sessions: AgentSession[] = [];

beforeAll(() => initTheme("dark"));

afterEach(async () => {
	while (runtimes.length > 0) await runtimes.pop()?.dispose();
	while (sessions.length > 0) sessions.pop()?.dispose();
	while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function planInput() {
	return {
		plan: [
			{ step: "  Inspect the implementation  ", status: "completed" as const },
			{ step: "Add the tool", status: "in_progress" as const },
			{ step: "Run tests", status: "pending" as const },
		],
	};
}

async function renderPlan(input: UpdatePlanInput, keepAnsi = false): Promise<string> {
	const tool = createUpdatePlanToolDefinition();
	const result = await tool.execute("plan-render", input, undefined, undefined, {} as never);
	const component = new ToolExecutionComponent(
		"update_plan",
		"plan-render",
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

function renderPlanError(message: string, keepAnsi = false): string {
	const component = new ToolExecutionComponent(
		"update_plan",
		"plan-error",
		{ plan: [{ step: " ", status: "pending" }] },
		{},
		undefined,
		{ requestRender() {} } as unknown as TUI,
		process.cwd(),
	);
	component.setArgsComplete();
	component.updateResult({ content: [{ type: "text", text: message }], isError: true });
	const rendered = component.render(120).join("\n");
	return keepAnsi ? rendered : stripAnsi(rendered);
}

async function createTestSession(
	options: {
		noTools?: "all" | "builtin";
		tools?: string[];
		excludeTools?: string[];
	} = {},
	subagent = false,
): Promise<AgentSession> {
	const root = mkdtempSync(join(tmpdir(), "arcmind-update-plan-options-"));
	const cwd = join(root, "project");
	const agentDir = join(root, "agent");
	mkdirSync(cwd);
	roots.push(root);
	const services = await createAgentSessionServices({
		cwd,
		agentDir,
		resourceLoaderOptions: {
			noContextFiles: true,
			noExtensions: true,
			noPromptTemplates: true,
			noSkills: true,
			noThemes: true,
		},
	});
	const sessionManager = SessionManager.create(cwd, join(root, "sessions"), {
		mode: "code",
		...(subagent
			? {
					parentSession: "parent-session",
					subagent: {
						agentId: "child-agent",
						name: "child",
						parentSessionId: "parent-session",
					},
				}
			: {}),
	});
	const { session } = await createAgentSessionFromServices({
		services,
		sessionManager,
		model: getModel("anthropic", "claude-sonnet-4-5")!,
		...options,
	});
	sessions.push(session);
	return session;
}

describe("update_plan", () => {
	it("accepts only a complete plan and returns its normalized state", async () => {
		const tool = createUpdatePlanToolDefinition();
		expect(Object.keys(tool.parameters.properties)).toEqual(["plan"]);
		expect(Value.Check(tool.parameters, { ...planInput(), explanation: "not supported" })).toBe(false);
		expect(
			Value.Check(tool.parameters, {
				plan: Array.from({ length: 65 }, (_, index) => ({ step: `Step ${index + 1}`, status: "pending" })),
			}),
		).toBe(true);
		const result = await tool.execute("plan-1", planInput(), undefined, undefined, {} as never);

		expect(result.details).toEqual({
			plan: [
				{ step: "Inspect the implementation", status: "completed" },
				{ step: "Add the tool", status: "in_progress" },
				{ step: "Run tests", status: "pending" },
			],
		});
		expect(result.content).toEqual([
			{
				type: "text",
				text: [
					'<latest_plan state="active">',
					"1. [completed] Inspect the implementation",
					"2. [in_progress] Add the tool",
					"3. [pending] Run tests",
					"</latest_plan>",
				].join("\n"),
			},
		]);
	});

	it("rejects invalid progress atomically", async () => {
		const tool = createUpdatePlanToolDefinition();
		await expect(
			tool.execute("blank", { plan: [{ step: "  ", status: "pending" }] }, undefined, undefined, {} as never),
		).rejects.toThrow("Plan steps cannot be empty");
		await expect(
			tool.execute(
				"plan-2",
				{
					plan: [
						{ step: "One", status: "in_progress" },
						{ step: "Two", status: "in_progress" },
					],
				},
				undefined,
				undefined,
				{} as never,
			),
		).rejects.toThrow("Only one plan step can be in progress");
	});

	it("distinguishes completed and cleared state", async () => {
		const tool = createUpdatePlanToolDefinition();
		const completed = await tool.execute(
			"done",
			{ plan: [{ step: "Ship it", status: "completed" }] },
			undefined,
			undefined,
			{} as never,
		);
		const cleared = await tool.execute("clear", { plan: [] }, undefined, undefined, {} as never);

		expect(completed.content[0]).toMatchObject({
			type: "text",
			text: expect.stringContaining('state="completed"'),
		});
		expect(cleared.content).toEqual([{ type: "text", text: '<latest_plan state="cleared" />' }]);
	});

	it("renders every built-in update once, including completed and cleared plans", async () => {
		const rendered = await renderPlan(planInput());
		expect(rendered).toContain("Plan · 1/3");
		expect(rendered).toContain("[✓] Inspect the implementation");
		expect(rendered).toContain("[→] Add the tool");
		expect(rendered).toContain("[ ] Run tests");
		expect(rendered.match(/Inspect the implementation/g)).toHaveLength(1);
		expect(await renderPlan(planInput(), true)).toContain(theme.bg("toolPendingBg", "x").split("x")[0]);

		const completed = await renderPlan({ plan: [{ step: "Ship it", status: "completed" }] });
		expect(completed).toContain("Plan · 1/1");
		expect(completed.match(/Ship it/g)).toHaveLength(1);
		expect(await renderPlan({ plan: [{ step: "Ship it", status: "completed" }] }, true)).toContain(
			theme.bg("toolSuccessBg", "x").split("x")[0],
		);

		const cleared = await renderPlan({ plan: [] });
		expect(cleared).toContain("Cleared Plan");
		expect(await renderPlan({ plan: [] }, true)).toContain(theme.bg("toolPendingBg", "x").split("x")[0]);

		const error = renderPlanError("Plan steps cannot be empty");
		expect(error).toContain("Plan steps cannot be empty");
		expect(error).not.toContain("Plan ·");
		expect(renderPlanError("Plan steps cannot be empty", true)).toContain(theme.bg("toolErrorBg", "x").split("x")[0]);
	});

	it("uses the normal built-in activation and filtering rules", async () => {
		const noTools = await createTestSession({ noTools: "all" });
		expect(noTools.getAllTools()).toEqual([]);

		const noBuiltins = await createTestSession({ noTools: "builtin" });
		expect(noBuiltins.getActiveToolNames()).not.toContain("update_plan");

		const allowlisted = await createTestSession({ tools: ["read"] });
		expect(allowlisted.getAllTools().map(({ name }) => name)).not.toContain("update_plan");

		const explicitlyAllowed = await createTestSession({ tools: ["update_plan"] });
		expect(explicitlyAllowed.getActiveToolNames()).toEqual(["update_plan"]);

		const excluded = await createTestSession({ excludeTools: ["update_plan"] });
		expect(excluded.getAllTools().map(({ name }) => name)).not.toContain("update_plan");
	});

	it("never exposes the master plan tool to a subagent session", async () => {
		const child = await createTestSession({}, true);
		expect(child.getAllTools().map(({ name }) => name)).not.toContain("update_plan");
		expect(child.getActiveToolNames()).not.toContain("update_plan");
	});

	it("does not require permission approval", () => {
		const action = classifyAction({
			actionId: "plan-1",
			toolName: "update_plan",
			provenance: "builtin",
			args: planInput(),
			cwd: process.cwd(),
		});
		expect(action.risks).toEqual(["ordinary-read"]);
		expect(routeAction({ mode: "ask", reviewerEnabled: true }, action, "assistant")).toBe("allow");
	});

	it("is installed in normal CLI runtimes and advertised in the system prompt", async () => {
		const root = mkdtempSync(join(tmpdir(), "arcmind-update-plan-"));
		const cwd = join(root, "project");
		const agentDir = join(root, "agent");
		mkdirSync(cwd);
		roots.push(root);
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir,
				resourceLoaderOptions: {
					noContextFiles: true,
					noExtensions: true,
					noPromptTemplates: true,
					noSkills: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model })),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd,
			agentDir,
			sessionManager: SessionManager.create(cwd, join(root, "sessions"), { mode: "code" }),
		});
		runtimes.push(runtime);

		expect(runtime.session.getActiveToolNames()).toContain("update_plan");
		expect(runtime.session.systemPrompt).toContain(
			"- update_plan: Track meaningful progress for complex multi-step work",
		);
		expect(runtime.session.systemPrompt).toContain("Use update_plan only for complex multi-step tasks");
	});
});
