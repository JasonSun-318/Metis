import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	clearThreadGoal,
	flushGoalElapsed,
	GOAL_CUSTOM_TYPE,
	readThreadGoal,
	validateGoalObjective,
	writeThreadGoal,
} from "../src/core/goal/store.ts";
import { SessionManager } from "../src/core/session-manager.ts";

function manager(): SessionManager {
	const dir = mkdtempSync(join(tmpdir(), "metis-goal-"));
	return SessionManager.create(dir, dir);
}

describe("thread goal store", () => {
	it("rejects empty or overlong objectives", () => {
		expect(() => validateGoalObjective("")).toThrow(/empty/i);
		expect(() => validateGoalObjective("   ")).toThrow(/empty/i);
		expect(() => validateGoalObjective("x".repeat(4001))).toThrow(/4000/);
		expect(validateGoalObjective("ship the review")).toBe("ship the review");
	});

	it("persists one goal per session; latest custom entry wins", () => {
		const session = manager();
		expect(readThreadGoal(session)).toBeNull();
		const created = writeThreadGoal(session, {
			objective: "  keep tests green  ",
			status: "active",
		});
		expect(created.objective).toBe("keep tests green");
		expect(created.status).toBe("active");
		expect(created.goalId.length).toBeGreaterThan(0);
		expect(created.timeUsedSeconds).toBe(0);
		expect(created.activeStartedAt).toEqual(expect.any(Number));
		expect(readThreadGoal(session)?.goalId).toBe(created.goalId);

		const updated = writeThreadGoal(session, {
			...created,
			objective: "keep tests green and reviewed",
			status: "paused",
		});
		expect(updated.goalId).toBe(created.goalId);
		expect(updated.status).toBe("paused");
		expect(updated.activeStartedAt).toBeNull();
		expect(readThreadGoal(session)?.objective).toBe("keep tests green and reviewed");
		const entries = session
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === GOAL_CUSTOM_TYPE);
		expect(entries.length).toBeGreaterThanOrEqual(2);
	});

	it("flushes elapsed time when leaving active and clears the goal", () => {
		const session = manager();
		const created = writeThreadGoal(session, { objective: "long task", status: "active" });
		const started = created.activeStartedAt!;
		const flushed = flushGoalElapsed(session, created, started + 5_000);
		expect(flushed.timeUsedSeconds).toBe(5);
		expect(flushed.status).toBe("active");
		expect(flushed.activeStartedAt).toBe(started + 5_000);

		const completed = writeThreadGoal(session, {
			...flushed,
			status: "complete",
			now: started + 5_000,
		});
		expect(completed.timeUsedSeconds).toBe(5);
		expect(clearThreadGoal(session)).toBe(true);
		expect(readThreadGoal(session)).toBeNull();
		expect(clearThreadGoal(session)).toBe(false);
	});
});
