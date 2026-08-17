import { describe, expect, it } from "vitest";
import { parseGoalSlash } from "../src/renderer/goal-slash.ts";

describe("parseGoalSlash", () => {
	it("parses usage, clear, pause, resume, and set branches", () => {
		expect(parseGoalSlash("/goal")).toEqual({ kind: "usage" });
		expect(parseGoalSlash("  /goal  ")).toEqual({ kind: "usage" });
		expect(parseGoalSlash("/goal edit")).toEqual({ kind: "usage" });
		expect(parseGoalSlash("/goal clear")).toEqual({ kind: "clear" });
		expect(parseGoalSlash("/goal pause")).toEqual({ kind: "pause" });
		expect(parseGoalSlash("/goal resume")).toEqual({ kind: "resume" });
		expect(parseGoalSlash("/goal keep tests green")).toEqual({
			kind: "set",
			objective: "keep tests green",
		});
		expect(parseGoalSlash("/goal CLEAR")).toEqual({ kind: "clear" });
	});

	it("returns set for overlong objectives and ignores non-goal text", () => {
		expect(parseGoalSlash(`/goal ${"x".repeat(4001)}`)).toEqual({
			kind: "set",
			objective: "x".repeat(4001),
		});
		expect(parseGoalSlash("/goals keep going")).toBeNull();
		expect(parseGoalSlash("goal keep going")).toBeNull();
		expect(parseGoalSlash("/compact")).toBeNull();
	});
});
