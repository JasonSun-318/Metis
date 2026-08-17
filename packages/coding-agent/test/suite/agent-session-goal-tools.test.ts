import { getModel } from "@metis/ai/compat";
import { describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../../src/core/agent-session-runtime.ts";
import { SessionManager } from "../../src/core/session-manager.ts";

describe("AgentSession goal tools", () => {
	it("activates goal tools on primary sessions and hides them from subagents", async () => {
		const createSession = async (
			options: { tools?: string[]; excludeTools?: string[]; noTools?: "builtin" } = {},
			subagent = false,
		) => {
			const services = await createAgentSessionServices({ cwd: process.cwd() });
			const sessionManager = SessionManager.create(process.cwd(), undefined, {
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
			return createAgentSessionFromServices({
				services,
				sessionManager,
				model: getModel("anthropic", "claude-sonnet-4-5")!,
				...options,
			});
		};

		const primary = await createSession();
		expect(primary.session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["get_goal", "create_goal", "update_goal", "set_tasks"]),
		);
		expect(primary.session.systemPrompt).toContain("- get_goal:");
		expect(primary.session.systemPrompt).toContain("- create_goal:");
		expect(primary.session.systemPrompt).toContain("- update_goal:");
		primary.session.dispose();

		const child = await createSession({}, true);
		const childTools = child.session.getAllTools().map(({ name }) => name);
		expect(childTools).not.toContain("get_goal");
		expect(childTools).not.toContain("create_goal");
		expect(childTools).not.toContain("update_goal");
		expect(childTools).not.toContain("set_tasks");
		child.session.dispose();

		const excluded = await createSession({ excludeTools: ["get_goal", "create_goal", "update_goal"] });
		expect(excluded.session.getAllTools().map(({ name }) => name)).not.toEqual(
			expect.arrayContaining(["get_goal", "create_goal", "update_goal"]),
		);
		excluded.session.dispose();
	});
});
