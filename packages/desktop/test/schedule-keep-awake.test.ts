import { describe, expect, it, vi } from "vitest";
import { createScheduleKeepAwake } from "../src/main/schedule-keep-awake.ts";

describe("schedule Keep Awake", () => {
	it("starts one prevent-app-suspension blocker and stops it idempotently", () => {
		const active = new Set<number>();
		const blocker = {
			start: vi.fn(() => {
				active.add(7);
				return 7;
			}),
			isStarted: vi.fn((id: number) => active.has(id)),
			stop: vi.fn((id: number) => active.delete(id)),
		};
		const keepAwake = createScheduleKeepAwake(blocker);
		keepAwake.set(true);
		keepAwake.set(true);
		expect(blocker.start).toHaveBeenCalledTimes(1);
		expect(blocker.start).toHaveBeenCalledWith("prevent-app-suspension");
		keepAwake.set(false);
		keepAwake.set(false);
		expect(blocker.stop).toHaveBeenCalledTimes(1);
		expect(active.size).toBe(0);
	});
});
