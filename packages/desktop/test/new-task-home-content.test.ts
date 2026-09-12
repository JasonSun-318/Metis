import { describe, expect, it } from "vitest";
import {
	CODE_HOME_GREETINGS,
	getHomePeriod,
	getHomeStarters,
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

	it.each([
		[4, "late"],
		[7, "morning"],
		[12, "noon"],
		[16, "afternoon"],
		[20, "evening"],
	])("provides named and anonymous copy for every %s greeting", (hour, period) => {
		for (const mode of ["chat", "code"] as const) {
			const greeting = pickHomeGreeting(new Date(2026, 8, 12, hour), undefined, () => 0, mode);
			expect([period, "anytime"]).toContain(greeting.period);
			expect(greeting.key).toContain("{{name}}");
			expect(greeting.anonymousKey).not.toContain("{{name}}");
		}
	});

	it("keeps the greeting pools unique and avoids an adjacent repeat in either mode", () => {
		for (const greetings of [HOME_GREETINGS, CODE_HOME_GREETINGS]) {
			expect(new Set(greetings.map((item) => item.id)).size).toBe(greetings.length);
			for (const item of greetings) {
				expect(item.key).toContain("{{name}}");
				expect(item.anonymousKey).not.toContain("{{name}}");
			}
		}

		const date = new Date(2026, 8, 12, 9);
		for (const mode of ["chat", "code"] as const) {
			const first = pickHomeGreeting(date, undefined, () => 0, mode);
			const second = pickHomeGreeting(date, first.id, () => 0, mode);
			expect(second.id).not.toBe(first.id);
		}
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

	it("returns the six Code starters in the agreed order", () => {
		expect(getHomeStarters("chat")).toBe(HOME_STARTERS);
		expect(getHomeStarters("code").map((item) => item.id)).toEqual([
			"feature",
			"debug",
			"explain",
			"review",
			"test",
			"performance",
		]);
		expect(getHomeStarters("code")).toHaveLength(6);
		expect(new Set(getHomeStarters("code").map((item) => item.id)).size).toBe(6);
		for (const starter of getHomeStarters("code")) {
			expect(starter.prompt.length).toBeGreaterThan(100);
			expect(starter.title.length).toBeGreaterThan(0);
			expect(starter.description.length).toBeGreaterThan(0);
		}
	});
});
