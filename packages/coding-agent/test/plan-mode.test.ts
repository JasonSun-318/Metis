import type { AgentMessage } from "@metis/agent-core";
import { describe, expect, it } from "vitest";
import { PLAN_MODE_SYSTEM_PROMPT, planVisibleToolNames, projectPlanContext } from "../src/core/plan-mode.ts";
import type { StoredPlan } from "../src/core/plan-state.ts";

const planRevision2: StoredPlan = {
	entryId: "proposal-2",
	parentId: "user-2",
	planId: "plan-a",
	revision: 2,
	title: "Current plan",
	markdown: "planRevision2Body",
	status: "proposed",
	createdAt: "2026-08-25T00:00:00.000Z",
};

const messagesWithTwoSubmitCalls: AgentMessage[] = [
	{
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "call-1",
				name: "submit_plan",
				arguments: { title: "Old", markdown: "planRevision1Body" },
			},
		],
		timestamp: 1,
	},
	{
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "submit_plan",
		content: [{ type: "text", text: "submitted" }],
		isError: false,
		timestamp: 2,
	},
	{
		role: "assistant",
		content: [
			{
				type: "toolCall",
				id: "call-2",
				name: "submit_plan",
				arguments: { title: "Current", markdown: "planRevision2Body" },
			},
		],
		timestamp: 3,
	},
	{
		role: "toolResult",
		toolCallId: "call-2",
		toolName: "submit_plan",
		content: [{ type: "text", text: "submitted" }],
		isError: false,
		timestamp: 4,
	},
];

describe("plan mode projection", () => {
	it("exposes only trusted exploration tools and submit_plan", () => {
		const visible = planVisibleToolNames(
			["read", "grep", "bash", "edit", "write", "web_fetch", "web_search", "ask_user", "set_tasks", "mcp_write"],
			(name) =>
				["ask_user", "submit_plan"].includes(name) ? "trusted" : name === "mcp_write" ? "mcp" : "builtin",
		);
		expect(visible).toEqual(["read", "grep", "bash", "web_fetch", "web_search", "ask_user", "submit_plan"]);
	});

	it("removes old submit_plan calls and injects one latest plan", () => {
		const projected = projectPlanContext(messagesWithTwoSubmitCalls, {
			collaborationMode: "plan",
			currentPlan: planRevision2,
		});
		expect(JSON.stringify(projected)).not.toContain("planRevision1Body");
		expect(JSON.stringify(projected)).not.toContain('"name":"submit_plan"');
		expect(JSON.stringify(projected).match(/"customType":"metis_plan_context"/gu)).toHaveLength(1);
		expect(JSON.stringify(projected)).toContain("planRevision2Body");
	});

	it("does not instruct the model to emit a proposed_plan tag", () => {
		expect(PLAN_MODE_SYSTEM_PROMPT).not.toContain("<proposed_plan>");
		expect(PLAN_MODE_SYSTEM_PROMPT).toContain("submit_plan");
	});

	it("prefers execution plan over current proposal", () => {
		const executionPlan: StoredPlan = {
			...planRevision2,
			revision: 1,
			markdown: "executionBody",
		};
		const projected = projectPlanContext(messagesWithTwoSubmitCalls, {
			collaborationMode: "default",
			currentPlan: planRevision2,
			executionPlan,
		});
		expect(JSON.stringify(projected)).toContain("executionBody");
		expect(JSON.stringify(projected)).not.toContain("planRevision2Body");
	});
});
