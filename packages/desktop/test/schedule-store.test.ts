import type { ScheduleTaskView } from "@metis/app-protocol";
import { describe, expect, it, vi } from "vitest";
import { ScheduleStore } from "../src/renderer/store/schedule-store.ts";

const EPOCH = "10000000-0000-4000-8000-000000000001";
const TASK_ID = "20000000-0000-4000-8000-000000000001";

function task(name = "Morning brief"): ScheduleTaskView {
	return {
		id: TASK_ID,
		name,
		description: "Calendar and inbox",
		instruction: "Summarize the day",
		model: { provider: "openai", modelId: "gpt-4" },
		schedule: { kind: "daily", time: "08:00" },
		timezone: "Asia/Shanghai",
		target: { kind: "general", workspace: "task" },
		status: "active",
		createdAt: "2026-07-31T00:00:00Z",
		updatedAt: "2026-07-31T00:00:00Z",
		nextRunAt: "2026-08-01T00:00:00Z",
		unreadCount: 0,
	};
}

describe("ScheduleStore", () => {
	it("applies one epoch snapshot, live task updates, unrelated cursor events, and deletion", () => {
		const store = new ScheduleStore();
		const listener = vi.fn();
		store.subscribe(listener);
		store.applySnapshot({ serverEpoch: EPOCH, tasks: [task()], unreadCount: 0, cursor: 4 });
		store.applyBatch({
			serverEpoch: EPOCH,
			fromCursor: 5,
			toCursor: 5,
			events: [{ type: "server/state", state: "ready" }],
		});
		store.applyBatch({
			serverEpoch: EPOCH,
			fromCursor: 6,
			toCursor: 6,
			events: [{ type: "schedule/updated", task: task("Renamed") }],
		});
		expect(store.getSnapshot().tasksById.get(TASK_ID)?.name).toBe("Renamed");
		store.applyBatch({
			serverEpoch: EPOCH,
			fromCursor: 7,
			toCursor: 7,
			events: [{ type: "schedule/deleted", taskId: TASK_ID }],
		});
		expect(store.getSnapshot().taskOrder).toEqual([]);
		expect(listener).toHaveBeenCalledTimes(3);
	});

	it("requires a new snapshot after a refresh notice", () => {
		const store = new ScheduleStore();
		store.applySnapshot({ serverEpoch: EPOCH, tasks: [], unreadCount: 0, cursor: 2 });
		store.applyBatch({
			serverEpoch: EPOCH,
			fromCursor: 4,
			toCursor: 4,
			events: [{ type: "schedule/refreshed" }],
		});
		expect(store.getSnapshot().syncStatus).toBe("resnapshot_required");
	});

	it("applies a forward cursor gap and requires a snapshot for a duplicate batch", () => {
		const store = new ScheduleStore();
		store.applySnapshot({ serverEpoch: EPOCH, tasks: [], unreadCount: 0, cursor: 2 });
		store.applyBatch({
			serverEpoch: EPOCH,
			fromCursor: 4,
			toCursor: 4,
			events: [{ type: "schedule/updated", task: task("Gap task") }],
		});
		expect(store.getSnapshot().syncStatus).toBe("ready");
		expect(store.getSnapshot().tasksById.get(TASK_ID)?.name).toBe("Gap task");
		expect(store.getSnapshot().cursor).toBe(4);
		store.applyBatch({
			serverEpoch: EPOCH,
			fromCursor: 4,
			toCursor: 4,
			events: [{ type: "schedule/deleted", taskId: TASK_ID }],
		});
		expect(store.getSnapshot().syncStatus).toBe("resnapshot_required");
		expect(store.getSnapshot().tasksById.has(TASK_ID)).toBe(true);
	});
});
