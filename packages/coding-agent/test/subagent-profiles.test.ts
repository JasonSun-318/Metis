import { describe, expect, it } from "vitest";
import { effectiveAgentToolNames, resolveAgentProfile } from "../src/core/subagents/profiles.ts";
import { AGENT_TOOL_NAMES, type AgentType } from "../src/core/subagents/types.ts";

const parentTools = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"edit",
	"write",
	"web_fetch",
	"web_search",
	"spawn_agent",
	"ask_user",
	"deliver_file",
	"get_goal",
	"custom_mcp_write",
];

describe("built-in agent profiles", () => {
	it("publishes exactly six orchestration tools", () => {
		expect(AGENT_TOOL_NAMES).toEqual([
			"spawn_agent",
			"inspect_agents",
			"send_message",
			"followup_task",
			"wait_agents",
			"interrupt_agent",
		]);
	});

	it.each<[AgentType, string[], "inherit" | "deny", boolean]>([
		[
			"default",
			["read", "grep", "find", "ls", "bash", "edit", "write", "web_fetch", "web_search", "custom_mcp_write"],
			"inherit",
			true,
		],
		["explorer", ["read", "grep", "find", "ls", "web_fetch", "web_search"], "deny", false],
		[
			"worker",
			["read", "grep", "find", "ls", "bash", "edit", "write", "web_fetch", "web_search", "custom_mcp_write"],
			"inherit",
			true,
		],
		["reviewer", ["read", "grep", "find", "ls", "bash"], "deny", false],
	])("resolves %s deterministically", (agentType, tools, writePolicy, mayDelegate) => {
		const resolved = resolveAgentProfile({ agentType, parentTools, depth: 1 });
		expect(resolved.tools).toEqual(tools);
		expect(resolved.writePolicy).toBe(writePolicy);
		expect(resolved.mayDelegate).toBe(mayDelegate);
	});

	it("removes delegation at the depth ceiling", () => {
		expect(resolveAgentProfile({ agentType: "worker", parentTools, depth: 2 }).mayDelegate).toBe(false);
	});

	it("reports coordination tools only when the child may delegate", () => {
		expect(effectiveAgentToolNames({ tools: ["read"], mayDelegate: true })).toEqual(["read", ...AGENT_TOOL_NAMES]);
		expect(effectiveAgentToolNames({ tools: ["read"], mayDelegate: false })).toEqual(["read"]);
	});
});
