import type { AgentMessage } from "@metis/agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@metis/ai/compat";
import { describe, expect, it } from "vitest";
import { PLAN_MODE_SYSTEM_PROMPT, projectPlanContext } from "../src/core/plan-mode.ts";
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
	fauxAssistantMessage(
		[fauxToolCall("submit_plan", { title: "Old", markdown: "planRevision1Body" }, { id: "call-1" })],
		{
			stopReason: "toolUse",
			timestamp: 1,
		},
	),
	{
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "submit_plan",
		content: [{ type: "text", text: "submitted" }],
		isError: false,
		timestamp: 2,
	},
	fauxAssistantMessage(
		[fauxToolCall("submit_plan", { title: "Current", markdown: "planRevision2Body" }, { id: "call-2" })],
		{ stopReason: "toolUse", timestamp: 3 },
	),
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
	it("retains failed submit_plan calls and their error results in the next model context", () => {
		const failed = messagesWithTwoSubmitCalls
			.slice(0, 2)
			.map((message) =>
				message.role === "toolResult"
					? { ...message, isError: true, content: [{ type: "text" as const, text: "You are not in Plan mode" }] }
					: message,
			);
		expect(projectPlanContext(failed, { collaborationMode: "default" })).toEqual(failed);
	});

	it("keeps later failed calls when a provider reuses an earlier successful call ID", () => {
		const prior = messagesWithTwoSubmitCalls.slice(0, 2);
		const failed = prior.map((message) => (message.role === "toolResult" ? { ...message, isError: true } : message));
		expect(projectPlanContext([...prior, ...failed], { collaborationMode: "default" })).toEqual(failed);
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
