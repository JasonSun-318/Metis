import { Temporal } from "@js-temporal/polyfill";
import type { ScheduleInputSpec, ScheduleSpec } from "./types.ts";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function strictObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Invalid schedule");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !keys.includes(key))) throw new TypeError("Invalid schedule fields");
	return record;
}

function date(value: unknown): string {
	if (typeof value !== "string" || !DATE_PATTERN.test(value)) throw new TypeError("Invalid schedule date");
	try {
		if (Temporal.PlainDate.from(value).toString() !== value) throw new TypeError("Invalid schedule date");
	} catch {
		throw new TypeError("Invalid schedule date");
	}
	return value;
}

function time(value: unknown): string {
	if (typeof value !== "string" || !TIME_PATTERN.test(value)) throw new TypeError("Invalid schedule time");
	Temporal.PlainTime.from(value);
	return value;
}

function positiveInteger(value: unknown, maximum: number, name: string): number {
	if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > maximum) {
		throw new TypeError(`Invalid schedule ${name}`);
	}
	return value as number;
}

export function validateScheduleTimezone(value: unknown): string {
	if (typeof value !== "string" || value.length === 0 || value.length > 255) {
		throw new TypeError("Invalid schedule timezone");
	}
	try {
		Temporal.Instant.fromEpochMilliseconds(0).toZonedDateTimeISO(value);
	} catch {
		throw new TypeError("Invalid schedule timezone");
	}
	return value;
}

function instant(value: unknown): string {
	if (typeof value !== "string") throw new TypeError("Invalid schedule instant");
	try {
		return Temporal.Instant.from(value).toString();
	} catch {
		throw new TypeError("Invalid schedule instant");
	}
}

export function validateScheduleInputSpec(value: unknown): ScheduleInputSpec {
	const record = strictObject(value, [
		"kind",
		"date",
		"time",
		"weekdays",
		"day",
		"every",
		"unit",
		"startDate",
		"startTime",
	]);
	switch (record.kind) {
		case "once": {
			strictObject(value, ["kind", "date", "time"]);
			return { kind: "once", date: date(record.date), time: time(record.time) };
		}
		case "daily": {
			strictObject(value, ["kind", "time"]);
			return { kind: "daily", time: time(record.time) };
		}
		case "weekly": {
			strictObject(value, ["kind", "weekdays", "time"]);
			if (!Array.isArray(record.weekdays) || record.weekdays.length === 0) {
				throw new TypeError("Invalid schedule weekdays");
			}
			const weekdays = [...new Set(record.weekdays.map((item) => positiveInteger(item, 7, "weekday")))].sort(
				(a, b) => a - b,
			);
			return { kind: "weekly", weekdays, time: time(record.time) };
		}
		case "monthly": {
			strictObject(value, ["kind", "day", "time"]);
			return { kind: "monthly", day: positiveInteger(record.day, 31, "day"), time: time(record.time) };
		}
		case "interval": {
			strictObject(value, ["kind", "every", "unit", "startDate", "startTime"]);
			if (record.unit !== "minute" && record.unit !== "hour") throw new TypeError("Invalid schedule interval unit");
			return {
				kind: "interval",
				every: positiveInteger(record.every, 10_000, "interval"),
				unit: record.unit,
				startDate: date(record.startDate),
				startTime: time(record.startTime),
			};
		}
		default:
			throw new TypeError("Invalid schedule kind");
	}
}

export function validateScheduleSpec(value: unknown): ScheduleSpec {
	const record = strictObject(value, ["kind", "date", "time", "weekdays", "day", "every", "unit", "startAt"]);
	if (record.kind !== "interval") {
		const spec = validateScheduleInputSpec(value);
		if (spec.kind === "interval") throw new TypeError("Invalid schedule interval");
		return spec;
	}
	strictObject(value, ["kind", "every", "unit", "startAt"]);
	if (record.unit !== "minute" && record.unit !== "hour") throw new TypeError("Invalid schedule interval unit");
	return {
		kind: "interval",
		every: positiveInteger(record.every, 10_000, "interval"),
		unit: record.unit,
		startAt: instant(record.startAt),
	};
}

function localInstant(
	dateValue: Temporal.PlainDate,
	timeValue: Temporal.PlainTime,
	timezoneValue: string,
): Temporal.Instant {
	return dateValue
		.toPlainDateTime(timeValue)
		.toZonedDateTime(timezoneValue, { disambiguation: "compatible" })
		.toInstant();
}

function monthlyDate(year: number, month: number, dayValue: number): Temporal.PlainDate {
	const first = Temporal.PlainDate.from({ year, month, day: 1 });
	return first.with({ day: Math.min(dayValue, first.daysInMonth) });
}

export function normalizeScheduleSpec(value: ScheduleInputSpec, timezoneValue: string): ScheduleSpec {
	validateScheduleTimezone(timezoneValue);
	const spec = validateScheduleInputSpec(value);
	if (spec.kind !== "interval") return spec;
	return {
		kind: "interval",
		every: spec.every,
		unit: spec.unit,
		startAt: localInstant(
			Temporal.PlainDate.from(spec.startDate),
			Temporal.PlainTime.from(spec.startTime),
			timezoneValue,
		).toString(),
	};
}

export function firstOccurrence(spec: ScheduleSpec, timezoneValue: string, now: string): string {
	validateScheduleTimezone(timezoneValue);
	const normalized = validateScheduleSpec(spec);
	const nowInstant = Temporal.Instant.from(now);
	if (normalized.kind === "once") {
		return localInstant(
			Temporal.PlainDate.from(normalized.date),
			Temporal.PlainTime.from(normalized.time),
			timezoneValue,
		).toString();
	}
	return nextOccurrence(normalized, timezoneValue, nowInstant.toString());
}

export function nextOccurrence(
	spec: Exclude<ScheduleSpec, { kind: "once" }>,
	timezoneValue: string,
	after: string,
): string {
	validateScheduleTimezone(timezoneValue);
	const instantValue = Temporal.Instant.from(after);
	if (spec.kind === "interval") {
		const normalized = validateScheduleSpec(spec);
		if (normalized.kind !== "interval") throw new TypeError("Invalid interval schedule");
		const stepMs = normalized.every * (normalized.unit === "minute" ? 60_000 : 3_600_000);
		const anchorMs = Temporal.Instant.from(normalized.startAt).epochMilliseconds;
		const steps = Math.floor((instantValue.epochMilliseconds - anchorMs) / stepMs) + 1;
		return Temporal.Instant.fromEpochMilliseconds(anchorMs + Math.max(0, steps) * stepMs).toString();
	}
	const normalized = validateScheduleSpec(spec);
	if (normalized.kind === "once" || normalized.kind === "interval") throw new TypeError("Invalid recurring schedule");
	const zoned = instantValue.toZonedDateTimeISO(timezoneValue);
	const timeValue = Temporal.PlainTime.from(normalized.time);
	if (normalized.kind === "daily") {
		let dateValue = zoned.toPlainDate();
		if (Temporal.Instant.compare(localInstant(dateValue, timeValue, timezoneValue), instantValue) <= 0) {
			dateValue = dateValue.add({ days: 1 });
		}
		return localInstant(dateValue, timeValue, timezoneValue).toString();
	}
	if (normalized.kind === "weekly") {
		for (let offset = 0; offset <= 7; offset += 1) {
			const dateValue = zoned.toPlainDate().add({ days: offset });
			const candidate = localInstant(dateValue, timeValue, timezoneValue);
			if (
				normalized.weekdays.includes(dateValue.dayOfWeek) &&
				Temporal.Instant.compare(candidate, instantValue) > 0
			) {
				return candidate.toString();
			}
		}
		throw new RangeError("Weekly schedule did not produce a next occurrence");
	}
	for (let offset = 0; offset <= 12; offset += 1) {
		const month = zoned.toPlainDate().with({ day: 1 }).add({ months: offset });
		const candidate = localInstant(monthlyDate(month.year, month.month, normalized.day), timeValue, timezoneValue);
		if (Temporal.Instant.compare(candidate, instantValue) > 0) return candidate.toString();
	}
	throw new RangeError("Monthly schedule did not produce a next occurrence");
}

export function advancePastNow(input: {
	spec: Exclude<ScheduleSpec, { kind: "once" }>;
	timezone: string;
	dueAt: string;
	now: string;
}): { nextRunAt: string; skippedCount: number } {
	const now = Temporal.Instant.from(input.now);
	let due = Temporal.Instant.from(input.dueAt);
	if (Temporal.Instant.compare(due, now) > 0) return { nextRunAt: due.toString(), skippedCount: 0 };
	if (input.spec.kind === "interval") {
		const stepMs = input.spec.every * (input.spec.unit === "minute" ? 60_000 : 3_600_000);
		const skippedCount = Math.floor((now.epochMilliseconds - due.epochMilliseconds) / stepMs);
		return {
			nextRunAt: Temporal.Instant.fromEpochMilliseconds(
				due.epochMilliseconds + (skippedCount + 1) * stepMs,
			).toString(),
			skippedCount,
		};
	}
	for (let skippedCount = 0; skippedCount < 10_000; skippedCount += 1) {
		due = Temporal.Instant.from(nextOccurrence(input.spec, input.timezone, due.toString()));
		if (Temporal.Instant.compare(due, now) > 0) return { nextRunAt: due.toString(), skippedCount };
	}
	throw Object.assign(new RangeError("Schedule recurrence exceeded 10,000 occurrences"), {
		code: "SCHEDULE_RANGE_EXCEEDED",
	});
}
