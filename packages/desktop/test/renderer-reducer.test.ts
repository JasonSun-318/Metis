import type { ConnectionEventsParams, ItemView, SessionSnapshot, SessionSummary } from "@arcmind/app-protocol";
import { describe, expect, it } from "vitest";
import { buildSessionTree } from "../src/renderer/components/SessionSidebar.tsx";
import { AppStore } from "../src/renderer/store/app-store.ts";

const EPOCH_A = "11111111-1111-4111-8111-111111111111";
const EPOCH_B = "22222222-2222-4222-8222-222222222222";

function session(sessionId = "session-1"): SessionSummary {
	return {
		sessionId,
		mode: "code",
		cwdOrigin: "user-selected",
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
		availableModels: [{ provider: "test", modelId: "model-a", name: "Model A" }],
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
	it("filters sessions by mode and separates managed tasks from project folders", () => {
		const store = new AppStore();
		const first = { ...session("session-1"), mode: "chat" as const, cwd: "/work/alpha", name: "First" };
		const code = { ...session("session-2"), cwd: "/work/beta", name: "Code" };
		const third = { ...session("session-3"), mode: "chat" as const, cwd: "/work/alpha", name: "Third" };
		const managed = {
			...session("session-4"),
			mode: "chat" as const,
			cwdOrigin: "managed" as const,
			cwd: "/internal/chat",
			name: "Managed",
		};
		const legacy = { ...session("session-5"), cwd: null, name: "Legacy" };
		store.setSessions({ sessions: [first, code, third, managed, legacy], nextAfterSessionId: null });

		const chat = buildSessionTree(store.getSnapshot(), "chat", new Map());
		expect(chat.projects.map(({ name, sessions }) => [name, sessions.map((item) => item.sessionId)])).toEqual([
			["alpha", ["session-1", "session-3"]],
		]);
		expect(chat.tasks.map((item) => item.sessionId)).toEqual(["session-4"]);
		expect(chat.projects[0]?.sessions[0]).toBe(store.getSnapshot().sessionsById.get("session-1"));

		const codeTree = buildSessionTree(store.getSnapshot(), "code", new Map());
		expect(codeTree.projects.map((group) => group.name)).toEqual(["beta"]);
		expect(codeTree.tasks.map((item) => item.sessionId)).toEqual(["session-5"]);
	});

	it("replaces the complete active projection on every snapshot", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot(EPOCH_A, 3, [item("old-item", "old", "completed")]));
		store.applyBatch({
			serverEpoch: EPOCH_A,
			fromCursor: 4,
			toCursor: 4,
			events: [
				{
					type: "interaction/notify",
					notificationId: "33333333-3333-4333-8333-333333333333",
					sessionId: "session-1",
					level: "info",
					message: "old notification",
					createdAt: "2026-07-16T00:00:00.000Z",
				},
			],
		});
		expect(store.getSnapshot().notifications).toHaveLength(1);
		store.applySnapshot(snapshot(EPOCH_B, 8, [item("new-item", "new", "completed")]));

		const state = store.getSnapshot();
		expect(state.serverEpoch).toBe(EPOCH_B);
		expect(state.cursor).toBe(8);
		expect(state.itemOrder).toEqual(["new-item"]);
		expect(state.itemsById.has("old-item")).toBe(false);
		expect(state.notifications).toEqual([]);
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

	it("preserves streamed thinking before visible text", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot(EPOCH_A, 0, [{ ...item("item-1", ""), content: [] }]));
		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 1,
				toCursor: 2,
				events: [
					{
						type: "item/delta",
						sessionId: "session-1",
						itemId: "item-1",
						delta: { type: "thinking", text: "think" },
					},
					{
						type: "item/delta",
						sessionId: "session-1",
						itemId: "item-1",
						delta: { type: "text", text: "answer" },
					},
				],
			}),
		).toBe("applied");
		expect(store.getSnapshot().itemsById.get("item-1")?.content).toEqual([
			{ type: "thinking", text: "think" },
			{ type: "text", text: "answer" },
		]);
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

	it("restores the previous projection status after an unchanged open fails", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot());
		const previous = store.getSnapshot();
		store.markResubscribing();
		expect(store.getSnapshot().syncStatus).toBe("resubscribing");

		store.restoreSyncStatusAfterFailedOpen(previous);
		expect(store.getSnapshot().syncStatus).toBe("ready");
	});

	it("projects model changes with the selected model's real effort levels", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot());
		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 1,
				toCursor: 1,
				events: [
					{
						type: "session/modelChanged",
						sessionId: "session-1",
						model: { provider: "test", modelId: "model-b" },
						thinkingSelection: "max",
						actualThinkingLevel: "max",
						availableThinkingSelections: ["off", "low", "high", "max"],
					},
				],
			}),
		).toBe("applied");
		expect(store.getSnapshot().model).toEqual({ provider: "test", modelId: "model-b" });
		expect(store.getSnapshot().availableThinkingSelections).toEqual(["off", "low", "high", "max"]);
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
