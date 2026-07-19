import type { ConnectionEventsParams, ItemView, SessionSnapshot, SessionSummary } from "@arcmind/app-protocol";
import { describe, expect, it } from "vitest";
import { groupSessionsByProject } from "../src/renderer/components/SessionSidebar.tsx";
import { AppStore } from "../src/renderer/store/app-store.ts";

const EPOCH_A = "11111111-1111-4111-8111-111111111111";
const EPOCH_B = "22222222-2222-4222-8222-222222222222";

function session(sessionId = "session-1"): SessionSummary {
	return {
		sessionId,
		cwd: "/tmp/project",
		createdAt: "2026-07-16T00:00:00.000Z",
		updatedAt: "2026-07-16T00:00:00.000Z",
		state: "running",
		archived: false,
	};
}

function item(itemId: string, text: string, state: ItemView["state"] = "streaming"): ItemView {
	return {
		itemId,
		sessionId: "session-1",
		role: "assistant",
		state,
		content: [{ type: "text", text }],
		createdAt: "2026-07-16T00:00:00.000Z",
	};
}

function snapshot(serverEpoch = EPOCH_A, cursor = 0, recentItems: ItemView[] = [item("item-1", "A")]): SessionSnapshot {
	return {
		session: session(),
		turns: [],
		recentItems,
		nextBeforeItemId: null,
		activeTurnId: null,
		pendingInteractions: [],
		thinkingSelection: "off",
		actualThinkingLevel: "off",
		availableThinkingSelections: ["off"],
		subagents: [],
		serverEpoch,
		cursor,
	};
}

function batch(serverEpoch: string, fromCursor: number, toCursor: number, text = "B"): ConnectionEventsParams {
	return {
		serverEpoch,
		fromCursor,
		toCursor,
		events: [
			{
				type: "item/delta",
				sessionId: "session-1",
				itemId: "item-1",
				delta: { type: "text", text },
			},
		],
	};
}

describe("renderer projection reducer", () => {
	it("groups recent tasks by their project without copying session state", () => {
		const store = new AppStore();
		const first = { ...session("session-1"), cwd: "/work/alpha", name: "First" };
		const second = { ...session("session-2"), cwd: "/work/beta", name: "Second" };
		const third = { ...session("session-3"), cwd: "/work/alpha", name: "Third" };
		const legacy = { ...session("session-4"), cwd: null, name: "Legacy" };
		store.setSessions({ sessions: [first, second, third, legacy], nextAfterSessionId: null });

		const groups = groupSessionsByProject(store.getSnapshot());
		expect(groups.map(({ name, sessions }) => [name, sessions.map((item) => item.sessionId)])).toEqual([
			["alpha", ["session-1", "session-3"]],
			["beta", ["session-2"]],
			["Other", ["session-4"]],
		]);
		expect(groups[0]?.sessions[0]).toBe(store.getSnapshot().sessionsById.get("session-1"));
	});

	it("replaces the complete active projection on every snapshot", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot(EPOCH_A, 3, [item("old-item", "old", "completed")]));
		store.applySnapshot(snapshot(EPOCH_B, 8, [item("new-item", "new", "completed")]));

		const state = store.getSnapshot();
		expect(state.serverEpoch).toBe(EPOCH_B);
		expect(state.cursor).toBe(8);
		expect(state.itemOrder).toEqual(["new-item"]);
		expect(state.itemsById.has("old-item")).toBe(false);
		expect(state.syncStatus).toBe("ready");
	});

	it("updates only the addressed item for a streaming delta", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot(EPOCH_A, 0, [item("item-1", "A"), item("item-2", "untouched")]));
		const untouched = store.getSnapshot().itemsById.get("item-2");
		const itemsMap = store.getSnapshot().itemsById;

		expect(store.applyBatch(batch(EPOCH_A, 1, 1))).toBe("applied");
		const state = store.getSnapshot();
		expect(state.itemsById).toBe(itemsMap);
		expect(state.itemsById.get("item-2")).toBe(untouched);
		expect(state.itemsById.get("item-1")?.content).toEqual([{ type: "text", text: "AB" }]);
		expect(state.cursor).toBe(1);
	});

	it.each([
		["old epoch", batch(EPOCH_B, 1, 1)],
		["duplicate cursor", batch(EPOCH_A, 0, 0)],
		["cursor gap", batch(EPOCH_A, 2, 2)],
		["out of order", batch(EPOCH_A, -1, -1)],
	])("requires a fresh snapshot for %s events", (_label, events) => {
		const store = new AppStore();
		store.applySnapshot(snapshot());
		expect(store.applyBatch(events)).toBe("resnapshot_required");
		expect(store.getSnapshot().syncStatus).toBe("resnapshot_required");
		expect(store.getSnapshot().itemsById.get("item-1")?.content).toEqual([{ type: "text", text: "A" }]);
	});

	it("never applies events received while resubscribing", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot());
		store.markResubscribing();
		expect(store.applyBatch(batch(EPOCH_A, 1, 1))).toBe("resnapshot_required");
		expect(store.getSnapshot().itemsById.get("item-1")?.content).toEqual([{ type: "text", text: "A" }]);
	});

	it("prepends a backward history page without duplicating existing items", () => {
		const store = new AppStore();
		store.applySnapshot({
			...snapshot(EPOCH_A, 0, [item("item-200", "newer", "completed")]),
			nextBeforeItemId: "item-200",
		});
		store.prependItems({
			items: [item("item-0", "oldest", "completed"), item("item-200", "updated", "completed")],
			nextBeforeItemId: null,
		});

		expect(store.getSnapshot().itemOrder).toEqual(["item-0", "item-200"]);
		expect(store.getSnapshot().itemsById.get("item-200")?.content).toEqual([{ type: "text", text: "updated" }]);
		expect(store.getSnapshot().nextBeforeItemId).toBeNull();
	});
});
