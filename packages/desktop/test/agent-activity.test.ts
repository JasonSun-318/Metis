import type { AgentSummaryView, InteractionView, SessionSummary } from "@metis/app-protocol";
import { describe, expect, it } from "vitest";
import { agentActivity, isAgentRunning } from "../src/renderer/agent-activity.ts";
import { sessionIndicator } from "../src/renderer/session-view-utils.ts";
import { groupSessionsByStatus } from "../src/renderer/store/session-grouping.ts";

const date = "2026-10-26T08:00:00Z";
function agent(agentId: string, extra: Partial<AgentSummaryView> = {}): AgentSummaryView {
	return {
		agentId,
		parentSessionId: "root",
		rootSessionId: "root",
		agentPath: [agentId],
		name: agentId,
		agentType: "worker",
		depth: 1,
		status: "done",
		archived: false,
		tasks: [],
		createdAt: date,
		updatedAt: date,
		...extra,
	};
}
const root: SessionSummary = {
	sessionId: "root",
	mode: "code",
	cwd: "/tmp/project",
	cwdOrigin: "user-selected",
	createdAt: date,
	updatedAt: date,
	state: "idle",
	archived: false,
	unread: true,
	lastTurnOutcome: "completed",
	useMemory: true,
	contributeMemory: true,
};
const interactions = { interactionOrder: [], interactionsById: new Map<string, InteractionView>() };

describe("aggregate child activity", () => {
	it("keeps running and queued descendants distinct from completed notifications", () => {
		for (const status of ["running", "queued"] as const) {
			const activity = agentActivity([agent("old"), agent("new", { status })]);
			expect(activity.running).toBe(true);
			expect(sessionIndicator(root, false, activity)).toBe("running");
			expect(groupSessionsByStatus([root], interactions, new Map([["root", activity]]))[0]?.key).toBe("running");
		}
		expect(root.state).toBe("idle");
		expect(root.updatedAt).toBe(date);
	});
	it("does not count paused, interrupted, stopped, or archived children as working", () => {
		for (const extra of [
			{ runControl: "user_paused" },
			{ runControl: "interrupted" },
			{ status: "stopped" },
			{ archived: true },
		] as const)
			expect(isAgentRunning(agent("child", { status: "running", ...extra }))).toBe(false);
	});
	it("keeps child attention ahead of activity without marking the parent unread", () => {
		const activity = agentActivity([agent("child", { status: "running" })], new Set(["child"]));
		expect(sessionIndicator({ ...root, unread: false }, true, activity)).toBe("attention");
		expect(groupSessionsByStatus([root], interactions, new Map([["root", activity]]))[0]?.key).toBe("pending");
		expect(agentActivity([agent("child", { archived: true })], new Set(["child"])).attentionRequired).toBe(false);
	});
	it("restores the parent notification after the final child completes", () => {
		const activity = agentActivity([agent("child")]);
		expect(sessionIndicator(root, false, activity)).toBe("completed");
		expect(sessionIndicator(root, true, activity)).toBeUndefined();
		expect(groupSessionsByStatus([root], interactions, new Map([["root", activity]]))[0]?.key).toBe("completed");
	});
	it("a new root turn is not hidden by its previous completed result", () => {
		expect(sessionIndicator({ ...root, state: "running" }, false)).toBe("running");
	});
});
