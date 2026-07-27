import { describe, expect, it } from "vitest";
import {
	advancePastNow,
	firstOccurrence,
	nextOccurrence,
	normalizeScheduleSpec,
	validateScheduleInputSpec,
	validateScheduleSpec,
} from "../src/core/schedules/time.ts";

describe("schedule time", () => {
	it("supports one exact local day and time", () => {
		expect(
			firstOccurrence({ kind: "once", date: "2026-08-03", time: "09:30" }, "Asia/Shanghai", "2026-07-26T00:00:00Z"),
		).toBe("2026-08-03T01:30:00Z");
	});

	it("clamps monthly day 31 and resumes day 31 when available", () => {
		const spec = { kind: "monthly", day: 31, time: "09:00" } as const;
		expect(nextOccurrence(spec, "Asia/Shanghai", "2026-01-31T01:00:00Z")).toBe("2026-02-28T01:00:00Z");
		expect(nextOccurrence(spec, "Asia/Shanghai", "2026-02-28T01:00:00Z")).toBe("2026-03-31T01:00:00Z");
	});

	it("moves a nonexistent DST time forward and chooses the earlier duplicate", () => {
		expect(
			firstOccurrence(
				{ kind: "once", date: "2026-03-08", time: "02:30" },
				"America/New_York",
				"2026-01-01T00:00:00Z",
			),
		).toBe("2026-03-08T07:30:00Z");
		expect(
			firstOccurrence(
				{ kind: "once", date: "2026-11-01", time: "01:30" },
				"America/New_York",
				"2026-01-01T00:00:00Z",
			),
		).toBe("2026-11-01T05:30:00Z");
	});

	it("normalizes weekly weekdays and advances without catch-up", () => {
		const spec = validateScheduleSpec({ kind: "weekly", weekdays: [5, 1, 5], time: "08:00" });
		expect(spec).toEqual({ kind: "weekly", weekdays: [1, 5], time: "08:00" });
		if (spec.kind === "once") throw new Error("expected recurring schedule");
		expect(
			advancePastNow({
				spec,
				timezone: "Asia/Shanghai",
				dueAt: "2026-07-20T00:00:00Z",
				now: "2026-07-26T00:00:00Z",
			}),
		).toEqual({ nextRunAt: "2026-07-27T00:00:00Z", skippedCount: 1 });
	});

	it("normalizes an interval's local start fields to one instant", () => {
		const input = validateScheduleInputSpec({
			kind: "interval",
			every: 2,
			unit: "hour",
			startDate: "2026-08-03",
			startTime: "09:30",
		});
		expect(normalizeScheduleSpec(input, "Asia/Shanghai")).toEqual({
			kind: "interval",
			every: 2,
			unit: "hour",
			startAt: "2026-08-03T01:30:00Z",
		});
	});

	it.each([
		{ kind: "once", date: "2026-02-30", time: "09:00" },
		{ kind: "daily", time: "24:00" },
		{ kind: "weekly", weekdays: [], time: "09:00" },
		{ kind: "monthly", day: 0, time: "09:00" },
		{ kind: "interval", every: 0, unit: "minute", startDate: "2026-01-01", startTime: "09:00" },
	])("rejects invalid specs", (spec) => expect(() => validateScheduleInputSpec(spec)).toThrow());

	it("advances interval misses arithmetically", () => {
		expect(
			advancePastNow({
				spec: { kind: "interval", every: 15, unit: "minute", startAt: "2026-07-26T00:00:00Z" },
				timezone: "Asia/Shanghai",
				dueAt: "2026-07-26T00:00:00Z",
				now: "2026-07-26T01:00:00Z",
			}),
		).toEqual({ nextRunAt: "2026-07-26T01:15:00Z", skippedCount: 4 });
	});

	it("rejects unknown fields and invalid timezones", () => {
		expect(() => validateScheduleInputSpec({ kind: "daily", time: "09:00", cwd: "/tmp" })).toThrow();
		expect(() => normalizeScheduleSpec({ kind: "daily", time: "09:00" }, "Not/A_Zone")).toThrow();
	});
});
