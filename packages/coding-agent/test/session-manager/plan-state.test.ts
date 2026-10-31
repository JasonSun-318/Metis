import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reducePlanState } from "../../src/core/plan-state.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createSubmitPlanToolDefinition } from "../../src/core/submit-plan.ts";

describe("Plan state", () => {
	it("keeps only the latest branch-visible proposal current and derives superseded status", () => {
		const entries = [
			{
				type: "session_collaboration_mode",
				id: "mode-1",
				parentId: "u1",
				timestamp: "2026-08-25T00:00:00.000Z",
				collaborationMode: "plan",
			},
			{
				type: "session_plan_proposal",
				id: "p1",
				parentId: "u1",
				timestamp: "2026-08-25T00:00:01.000Z",
				planId: "plan-a",
				revision: 1,
				title: "First",
				markdown: "# First",
			},
			{
				type: "session_plan_proposal",
				id: "p2",
				parentId: "u2",
				timestamp: "2026-08-25T00:00:02.000Z",
				planId: "plan-a",
				revision: 2,
				title: "Second",
				markdown: "# Second",
			},
		] as const;
		const state = reducePlanState(entries, new Set(["u1", "u2"]));
		expect(state.collaborationMode).toBe("plan");
		expect(state.plans.map(({ revision, status }) => ({ revision, status }))).toEqual([
			{ revision: 1, status: "superseded" },
			{ revision: 2, status: "proposed" },
		]);
		expect(state.currentPlan?.revision).toBe(2);
	});

	it("does not select a proposal attached to another branch", () => {
		const entries = [
			{
				type: "session_plan_proposal",
				id: "p1",
				parentId: "left",
				timestamp: "2026-08-25T00:00:01.000Z",
				planId: "plan-a",
				revision: 1,
				title: "Left",
				markdown: "# Left",
			},
		] as const;
		expect(reducePlanState(entries, new Set(["right"])).currentPlan).toBeUndefined();
	});

	it("derives accepted and cancelled terminal status", () => {
		const entries = [
			{
				type: "session_plan_proposal",
				id: "p1",
				parentId: "u1",
				timestamp: "2026-08-25T00:00:01.000Z",
				planId: "plan-a",
				revision: 1,
				title: "Plan",
				markdown: "# Plan",
			},
			{
				type: "session_plan_status",
				id: "s1",
				parentId: "u1",
				timestamp: "2026-08-25T00:00:02.000Z",
				planId: "plan-a",
				revision: 1,
				status: "accepted",
			},
		] as const;
		const state = reducePlanState(entries, new Set(["u1"]));
		expect(state.currentPlan).toBeUndefined();
		expect(state.plans[0]?.status).toBe("accepted");
	});
});

describe("SessionManager plan state", () => {
	let directory: string;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "metis-plan-"));
	});

	afterEach(() => {
		rmSync(directory, { recursive: true, force: true });
	});

	it("persists collaboration mode and proposals outside the transcript", () => {
		const session = SessionManager.inMemory(directory, { mode: "chat" });
		const userId = session.appendMessage({ role: "user", content: "explore", timestamp: 1 });
		expect(userId).toBeTruthy();
		session.setCollaborationMode("plan");
		expect(session.getCollaborationMode()).toBe("plan");
		const plan = session.submitPlan({ title: "Auth flow", markdown: "# Auth flow" });
		expect(plan.revision).toBe(1);
		expect(session.getPlanState().currentPlan?.title).toBe("Auth flow");
		expect(session.getEntries().some((entry) => entry.type.startsWith("session_plan"))).toBe(false);
		expect(session.buildSessionContext().messages).not.toContainEqual(
			expect.objectContaining({ customType: "plan" }),
		);
		session.close();
	});

	it("rejects oversized markdown and stale plan actions", () => {
		const session = SessionManager.inMemory(directory, { mode: "chat" });
		session.appendMessage({ role: "user", content: "explore", timestamp: 1 });
		session.setCollaborationMode("plan");
		expect(() => session.submitPlan({ title: "x", markdown: "a".repeat(65_537) })).toThrow(/too large/iu);
		session.submitPlan({ title: "ok", markdown: "# ok" });
		expect(() => session.acceptPlan({ planId: "stale", revision: 1 })).toThrow(/current plan/iu);
		session.close();
	});

	it("blocks leaving Plan mode while a proposal is current", () => {
		const session = SessionManager.inMemory(directory, { mode: "chat" });
		session.appendMessage({ role: "user", content: "explore", timestamp: 1 });
		session.setCollaborationMode("plan");
		session.submitPlan({ title: "Plan", markdown: "# Plan" });
		expect(() => session.setCollaborationMode("default")).toThrow(/Cancel or start/iu);
		session.close();
	});
	it("requires Plan mode and a non-empty proposal, and restores the exact current revision from disk", async () => {
		const session = SessionManager.create(directory, join(directory, "sessions"), { mode: "chat" });
		const tool = createSubmitPlanToolDefinition((input) => session.submitPlan(input));
		session.appendMessage({ role: "user", content: "Plan this change", timestamp: 1 });
		await expect(
			tool.execute("submit", { title: "Plan", markdown: "# Plan" }, undefined, undefined, {} as never),
		).rejects.toThrow(/not in Plan mode/);
		session.setCollaborationMode("plan");
		await expect(
			tool.execute("submit", { title: "Plan", markdown: "   " }, undefined, undefined, {} as never),
		).rejects.toThrow(/cannot be blank/);
		expect(session.getPlanState().currentPlan).toBeUndefined();
		const first = session.submitPlan({ title: "Plan", markdown: "# First proposal" });
		const current = session.submitPlan({ title: "Revised plan", markdown: "# Revised proposal" });
		expect(() => session.acceptPlan({ planId: first.planId, revision: first.revision })).toThrow(/current plan/);
		const file = session.getSessionFile()!;
		session.close();
		const reopened = SessionManager.open(file);
		try {
			expect(reopened.getCollaborationMode()).toBe("plan");
			expect(reopened.getPlanState().currentPlan).toEqual(current);
			const ref = { planId: current.planId, revision: current.revision };
			expect(reopened.acceptPlan(ref).status).toBe("accepted");
			expect(() => reopened.acceptPlan(ref)).toThrow(/current plan/);
		} finally {
			reopened.close();
		}
	});

	it("accepts and cancels the current proposal", () => {
		const session = SessionManager.inMemory(directory, { mode: "chat" });
		session.appendMessage({ role: "user", content: "explore", timestamp: 1 });
		session.setCollaborationMode("plan");
		const plan = session.submitPlan({ title: "Plan", markdown: "# Plan" });
		const accepted = session.acceptPlan({ planId: plan.planId, revision: plan.revision });
		expect(accepted.status).toBe("accepted");

		session.setCollaborationMode("plan");
		const next = session.submitPlan({ title: "Next", markdown: "# Next" });
		const cancelled = session.cancelPlan({ planId: next.planId, revision: next.revision });
		expect(cancelled.status).toBe("cancelled");
		session.close();
	});
});
