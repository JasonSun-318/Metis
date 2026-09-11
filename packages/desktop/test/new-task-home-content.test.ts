import { describe, expect, it } from "vitest";
import {
	getHomePeriod,
	HOME_GREETINGS,
	HOME_STARTERS,
	pickHomeGreeting,
} from "../src/renderer/new-task-home-content.ts";

describe("new task home content", () => {
	it.each([
		[4, "late"],
		[5, "morning"],
		[10, "morning"],
		[11, "noon"],
		[13, "noon"],
		[14, "afternoon"],
		[17, "afternoon"],
		[18, "evening"],
		[22, "evening"],
		[23, "late"],
	])("uses the local hour %i", (hour, expected) => {
		expect(getHomePeriod(new Date(2026, 8, 11, Number(hour)))).toBe(expected);
	});

	it("selects an eligible sentence and skips the previous ID", () => {
		const now = new Date(2026, 8, 11, 9);
		const first = pickHomeGreeting(now, undefined, () => 0);
		const second = pickHomeGreeting(now, first.id, () => 0);
		expect(second.id).not.toBe(first.id);
		for (const fraction of [0, 0.25, 0.5, 0.75, 0.999]) {
			expect(["morning", "anytime"]).toContain(pickHomeGreeting(now, undefined, () => fraction).period);
		}
		expect(HOME_GREETINGS.some((item) => item.id === "morning-start")).toBe(true);
	});

	it("has the agreed nine starters in reading order", () => {
		expect(HOME_STARTERS.map((item) => item.id)).toEqual([
			"report",
			"slides",
			"spreadsheet",
			"research",
			"document",
			"plan",
			"writing",
			"compare",
			"meeting",
		]);
		expect(new Set(HOME_GREETINGS.map((item) => item.id)).size).toBe(19);
	});
});
