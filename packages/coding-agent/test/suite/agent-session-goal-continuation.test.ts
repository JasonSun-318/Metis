import { fauxAssistantMessage, fauxToolCall } from "@metis/ai";
import { afterEach, describe, expect, it } from "vitest";
import { GOAL_CUSTOM_TYPE, readThreadGoal, writeThreadGoal } from "../../src/core/goal/index.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("AgentSession goal continuation", () => {
	const harnesses: Harness[] = [];

	afterEach(async () => {
		await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
	});

	it("injects a hidden continuation and stops after update_goal complete", async () => {
		const harness = await createHarness({
			settings: { retry: { enabled: false } },
		});
		harnesses.push(harness);
		writeThreadGoal(harness.sessionManager, { objective: "keep tests green", status: "active" });

		harness.setResponses([
			fauxAssistantMessage("making progress"),
			fauxAssistantMessage(fauxToolCall("update_goal", { status: "complete" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("goal achieved"),
		]);

		await harness.session.prompt("start the goal");

		expect(harness.getPendingResponseCount()).toBe(0);
		expect(readThreadGoal(harness.sessionManager)?.status).toBe("complete");
		const continuation = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom_message" && entry.customType === "goal_continuation");
		expect(continuation.length).toBeGreaterThanOrEqual(1);
		expect(continuation.every((entry) => entry.type === "custom_message" && entry.display === false)).toBe(true);
		expect(harness.eventsOfType("goal_changed").some((event) => event.goal?.status === "complete")).toBe(true);
	});

	it("records a user goal once before hidden continuation without adding a second model turn", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		const originalTools = harness.session.getActiveToolNames();
		expect(originalTools).toEqual(expect.arrayContaining(["get_goal", "create_goal", "update_goal"]));
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("update_goal", { status: "complete" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
			fauxAssistantMessage("must not start another turn"),
		]);
		harness.session.setGoalFromUser({ objective: "测试 goal 模式" });
		await harness.session.waitForIdle();
		expect(harness.session.getGoal()?.status).toBe("complete");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.session.getActiveToolNames()).toEqual(originalTools);
		const requests = harness.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "goal_user_request");
		expect(requests).toHaveLength(1);
		expect(requests[0]).toMatchObject({ data: { objective: "测试 goal 模式" } });
		expect(harness.events[0]).toMatchObject({ type: "entry_appended", entry: requests[0] });
		expect(harness.session.messages.some((message) => message.role === "user")).toBe(false);
	});

	it("waits for the Plan card instead of continuing an active goal after submission", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		await harness.session.setCollaborationMode("plan");
		writeThreadGoal(harness.sessionManager, { objective: "plan first", status: "active" });
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("submit_plan", { title: "Plan", markdown: "# Plan" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("should not run"),
		]);
		await harness.session.prompt("prepare the plan");
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(harness.sessionManager.getPlanState().currentPlan?.status).toBe("proposed");
		expect(readThreadGoal(harness.sessionManager)?.status).toBe("active");
		expect(await harness.session.queueGoalContinuationIfIdle()).toBe(false);
	});

	it("does not continue when the goal is paused", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		writeThreadGoal(harness.sessionManager, { objective: "paused work", status: "paused" });
		harness.setResponses([fauxAssistantMessage("one reply"), fauxAssistantMessage("should not run")]);

		await harness.session.prompt("hello");

		expect(harness.getPendingResponseCount()).toBe(1);
		expect(readThreadGoal(harness.sessionManager)?.status).toBe("paused");
		expect(
			harness.sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "goal_continuation"),
		).toBe(false);
	});

	it("marks active goals usage_limited on quota errors", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		writeThreadGoal(harness.sessionManager, { objective: "long task", status: "active" });
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "insufficient_quota" }),
			fauxAssistantMessage("should not continue"),
		]);

		await harness.session.prompt("keep going");

		expect(readThreadGoal(harness.sessionManager)?.status).toBe("usage_limited");
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("pauses active goals on non-retryable errors", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		writeThreadGoal(harness.sessionManager, { objective: "long task", status: "active" });
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid api key" }),
			fauxAssistantMessage("should not continue"),
		]);

		await harness.session.prompt("keep going");

		expect(readThreadGoal(harness.sessionManager)?.status).toBe("paused");
		expect(harness.getPendingResponseCount()).toBe(1);
	});

	it("continues a persisted active goal after startup bindings are ready", async () => {
		const sessionManager = SessionManager.inMemory();
		writeThreadGoal(sessionManager, { objective: "resume after restart", status: "active" });
		const harness = await createHarness({ sessionManager });
		harnesses.push(harness);
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("update_goal", { status: "complete" }), { stopReason: "toolUse" }),
			fauxAssistantMessage("resumed and completed"),
		]);

		await harness.session.bindExtensions({});
		await harness.session.waitForIdle();

		expect(readThreadGoal(sessionManager)?.status).toBe("complete");
		expect(
			sessionManager
				.getEntries()
				.some((entry) => entry.type === "custom_message" && entry.customType === "goal_continuation"),
		).toBe(true);
	});

	it("keeps completed goals terminal and starts a fresh goal for a new objective", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const completed = writeThreadGoal(harness.sessionManager, {
			objective: "first goal",
			status: "complete",
			timeUsedSeconds: 42,
		});

		expect(() => harness.session.setGoalFromUser({ status: "active" })).toThrow(/completed/i);
		expect(() => harness.session.setGoalFromUser({ status: "paused" })).toThrow(/completed/i);

		const next = harness.session.setGoalFromUser({ objective: "second goal", status: "paused" });
		expect(next.goalId).not.toBe(completed.goalId);
		expect(next.timeUsedSeconds).toBe(0);
		expect(next.objective).toBe("second goal");
		expect(next.status).toBe("paused");
	});

	it("exposes user goal mutations without creating a model-facing create_goal call", async () => {
		const harness = await createHarness();
		harnesses.push(harness);
		const created = harness.session.setGoalFromUser({ objective: "  ship it  " });
		expect(created.objective).toBe("ship it");
		expect(created.status).toBe("active");
		expect(harness.session.getGoal()?.goalId).toBe(created.goalId);

		const paused = harness.session.setGoalFromUser({ status: "paused" });
		expect(paused.status).toBe("paused");
		expect(harness.session.clearGoal()).toBe(true);
		expect(harness.session.getGoal()).toBeNull();
		expect(GOAL_CUSTOM_TYPE).toBe("thread_goal");
	});
});
