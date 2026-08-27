import { describe, expect, it } from "vitest";
import type { AgentSummary } from "../src/core/subagents/types.ts";
import { normalizeWaitAgentIds, waitAgentsSnapshot } from "../src/core/subagents/wait.ts";

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
	});

	it("returns when any selected agent is terminal even if another remains live", () => {
		const done = summary("child-1", "done");
		const running = summary("child-2", "running");
		expect(waitAgentsSnapshot([done, running], new Set(["child-1", "child-2"]), [], new Map())).toEqual({
			timedOut: false,
			agents: [done, running],
			mailboxEventIds: [],
		});
	});

	it("limits each mailbox wake-up to one bounded delivery batch", () => {
		const done = summary("child-1", "done");
		const eventIds = Array.from({ length: 9 }, (_, index) => `agent:child-1:task-${index}:terminal`);
		expect(waitAgentsSnapshot([done], new Set(["child-1"]), eventIds, new Map())?.mailboxEventIds).toEqual(
			eventIds.slice(0, 8),
		);
	});
});
