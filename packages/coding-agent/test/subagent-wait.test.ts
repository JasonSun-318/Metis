import { describe, expect, it } from "vitest";
import type { AgentSummary } from "../src/core/subagents/types.ts";
import {
	normalizeWaitAgentIds,
	pendingApprovalAgentIds,
	pendingMailboxAgentIds,
	selectedLiveAgents,
	waitAgentsSnapshot,
} from "../src/core/subagents/wait.ts";

function summary(agentId: string, status: AgentSummary["status"], archived = false): AgentSummary {
	return {
		agentId,
		name: agentId,
		agentType: "worker",
		depth: 1,
		status,
		archived,
		tasks: [],
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		parentSessionId: "parent",
		rootSessionId: "parent",
		agentPath: [agentId],
	};
}

describe("agent wait helpers", () => {
	it("accepts only 1-8 unique explicit targets", () => {
		expect(normalizeWaitAgentIds(["a", "b"])).toEqual(["a", "b"]);
		for (const invalid of [[], ["a", "a"], Array.from({ length: 9 }, (_, index) => `agent-${index}`)]) {
			expect(() => normalizeWaitAgentIds(invalid)).toThrow(/1-8 unique agent IDs/);
		}
	});

	it("maps pending terminal mailbox events to selected agent ids", () => {
		const ids = pendingMailboxAgentIds(
			["agent:child-1:task-1:terminal", "agent:child-2:task-2:terminal", "other:event"],
			new Set(["child-1", "child-3"]),
		);
		expect(ids).toEqual(["child-1"]);
	});

	it("returns approval attention before a terminal mailbox event", () => {
		const agent = summary("child-1", "running");
		const result = waitAgentsSnapshot(
			[agent],
			new Set(["child-1"]),
			["agent:child-1:task-1:terminal"],
			new Map([["child-1", { taskId: "task-1", toolName: "bash" }]]),
		);
		expect(result).toEqual({
			timedOut: false,
			agents: [agent],
			mailboxEventIds: [],
			attention: {
				agentId: "child-1",
				taskId: "task-1",
				kind: "approval_required",
				toolName: "bash",
			},
		});
	});

	it("returns terminal events and otherwise keeps waiting for live agents", () => {
		const done = summary("child-1", "done");
		expect(waitAgentsSnapshot([done], new Set(["child-1"]), ["agent:child-1:task-1:terminal"], new Map())).toEqual({
			timedOut: false,
			agents: [done],
			mailboxEventIds: ["agent:child-1:task-1:terminal"],
		});
		expect(waitAgentsSnapshot([summary("child-1", "running")], new Set(["child-1"]), [], new Map())).toBe(undefined);
		expect(selectedLiveAgents([done], new Set(["child-1"]))).toBe(false);
		expect(pendingApprovalAgentIds(["child-2"], new Set(["child-2"]))).toEqual(["child-2"]);
	});
});
