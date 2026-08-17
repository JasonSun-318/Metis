import { fauxAssistantMessage, fauxToolCall } from "@metis/ai";
import { afterEach, describe, expect, it } from "vitest";
import { GOAL_CUSTOM_TYPE, readThreadGoal, writeThreadGoal } from "../../src/core/goal/index.ts";
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

	it("marks active goals blocked on non-retryable errors", async () => {
		const harness = await createHarness({ settings: { retry: { enabled: false } } });
		harnesses.push(harness);
		writeThreadGoal(harness.sessionManager, { objective: "long task", status: "active" });
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid api key" }),
			fauxAssistantMessage("should not continue"),
		]);

		await harness.session.prompt("keep going");

		expect(readThreadGoal(harness.sessionManager)?.status).toBe("blocked");
		expect(harness.getPendingResponseCount()).toBe(1);
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
