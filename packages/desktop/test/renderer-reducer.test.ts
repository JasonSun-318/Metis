import type { ConnectionEventsParams, ItemView, SessionSnapshot, SessionSummary } from "@metis/app-protocol";
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
		unread: false,
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

function childItem(itemId: string, text: string, state: ItemView["state"] = "streaming"): ItemView {
	return { ...item(itemId, text, state), sessionId: "child-1" };
}

function snapshot(serverEpoch = EPOCH_A, cursor = 0, recentItems: ItemView[] = [item("item-1", "A")]): SessionSnapshot {
	return {
		session: session(),
		collaborationMode: "default",
		permissionMode: "ask",
		turns: [],
		recentItems,
		nextBeforeItemId: null,
		activeTurnId: null,
		pendingInteractions: [],
		queuedTurns: [],
		tasks: [],
		deliveredFiles: [],
		goal: null,
		thinkingSelection: "off",
		actualThinkingLevel: "off",
		availableThinkingSelections: ["off"],
		availableModels: [{ provider: "test", modelId: "model-a", name: "Model A" }],
		agents: [],
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
	it("replaces queued turns from snapshots and queue events", () => {
		const store = new AppStore();
		store.applySnapshot({
			...snapshot(EPOCH_A, 0),
			queuedTurns: [
				{
					queueItemId: "queue-1",
					revision: "revision-1",
					state: "queued",
					text: "First",
					attachments: [],
				},
			],
		});
		expect(store.getSnapshot().queuedTurns.map(({ text }) => text)).toEqual(["First"]);

		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 1,
				toCursor: 1,
				events: [
					{
						type: "turn/queueChanged",
						sessionId: "session-1",
						queuedTurns: [
							{
								queueItemId: "queue-1",
								revision: "revision-2",
								state: "paused",
								text: "Edited",
								attachments: [{ name: "notes.txt", byteLength: 12 }],
							},
						],
					},
				],
			}),
		).toBe("applied");
		expect(store.getSnapshot().queuedTurns).toEqual([
			expect.objectContaining({
				revision: "revision-2",
				state: "paused",
				text: "Edited",
			}),
		]);
	});

	it("keeps the selected child transcript separate from the parent", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot(EPOCH_A, 0));
		store.selectAgentTranscript("child-1");

		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 1,
				toCursor: 4,
				events: [
					{
						type: "agent/item/started",
						sessionId: "session-1",
						agentId: "child-1",
						item: childItem("child-live", ""),
					},
					{
						type: "agent/item/delta",
						sessionId: "session-1",
						agentId: "child-1",
						itemId: "child-live",
						delta: { type: "text", text: "hello" },
					},
					{
						type: "agent/item/completed",
						sessionId: "session-1",
						agentId: "child-1",
						item: childItem("child-live", "hello", "completed"),
					},
					{
						type: "agent/itemsChanged",
						sessionId: "session-1",
						agentId: "child-1",
					},
				],
			}),
		).toBe("applied");

		const state = store.getSnapshot();
		expect(state.agentTranscript.itemsById.get("child-live")?.content).toEqual([{ type: "text", text: "hello" }]);
		expect(state.agentTranscript.journalRevision).toBe(1);
		expect(state.itemsById.has("child-live")).toBe(false);

		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 5,
				toCursor: 5,
				events: [
					{
						type: "agent/item/started",
						sessionId: "session-1",
						agentId: "child-2",
						item: { ...childItem("ignored", "ignored"), sessionId: "child-2" },
					},
				],
			}),
		).toBe("applied");
		expect(store.getSnapshot().agentTranscript.itemsById.has("ignored")).toBe(false);
	});

	it("replaces and paginates child history, then clears it on session switch", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot());
		store.selectAgentTranscript("child-1");
		store.replaceAgentItems("child-1", null, {
			items: [childItem("durable", "new", "completed")],
			nextBeforeItemId: "durable",
		});
		store.prependAgentItems("child-1", null, {
			items: [childItem("older", "old", "completed")],
			nextBeforeItemId: null,
		});
		expect(store.getSnapshot().agentTranscript.itemOrder).toEqual(["older", "durable"]);

		store.applySnapshot({ ...snapshot(EPOCH_B), session: session("session-2") });
		expect(store.getSnapshot().agentTranscript).toMatchObject({
			agentId: null,
			itemOrder: [],
			nextBeforeItemId: null,
		});
	});

	it("requests a selected-child refresh after a same-session resnapshot", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot(EPOCH_A));
		store.selectAgentTranscript("child-1");
		store.applySnapshot(snapshot(EPOCH_B));
		expect(store.getSnapshot().agentTranscript).toMatchObject({ agentId: "child-1", journalRevision: 1 });
	});

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

	it("removes only one mode-project and clears its active projection idempotently", () => {
		const store = new AppStore();
		const active = { ...session("chat-active"), mode: "chat" as const, cwd: "/work/root" };
		store.applySnapshot({
			...snapshot(EPOCH_A, 4, [{ ...item("active-item", "visible"), sessionId: active.sessionId }]),
			session: active,
			model: { provider: "test", modelId: "model-a" },
		});
		store.setSessions({
			sessions: [
				active,
				{ ...session("chat-archived"), mode: "chat", cwd: "/work/root", archived: true },
				{ ...session("code-same"), cwd: "/work/root" },
				{ ...session("chat-child"), mode: "chat", cwd: "/work/root/child" },
				{
					...session("chat-scheduled"),
					mode: "chat",
					cwd: "/work/root",
					scheduled: { taskId: "task", runId: "run" },
				},
			],
			nextAfterSessionId: null,
		});

		store.removeModeProject("chat", "/work/root");
		const state = store.getSnapshot();
		expect([...state.sessionsById.keys()]).toEqual(["code-same", "chat-child", "chat-scheduled"]);
		expect(state.activeSessionId).toBeNull();
		expect(state.itemOrder).toEqual([]);
		expect(state.agents).toEqual([]);
		expect(state.permissionMode).toBe("auto");
		expect(state.availableModels).toEqual([{ provider: "test", modelId: "model-a", name: "Model A" }]);
		expect(state.model).toEqual({ provider: "test", modelId: "model-a" });
		const afterFirst = store.getSnapshot();
		store.removeModeProject("chat", "/work/root");
		expect(store.getSnapshot()).toBe(afterFirst);
	});

	it("removes one session without clearing another active projection", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot());
		store.setSessions({ sessions: [session(), session("session-2")], nextAfterSessionId: null });

		store.removeSession("session-2");
		expect(store.getSnapshot().activeSessionId).toBe("session-1");
		expect(store.getSnapshot().sessionOrder).toEqual(["session-1"]);
		const afterFirst = store.getSnapshot();
		store.removeSession("session-2");
		expect(store.getSnapshot()).toBe(afterFirst);

		store.addInteraction({
			interactionId: "33333333-3333-4333-8333-333333333333",
			sessionId: "other-session",
			title: "Keep",
			message: "Keep this interaction",
			createdAt: "2026-07-16T00:00:00.000Z",
			kind: "confirm",
		});
		store.removeSession("session-1");
		expect(store.getSnapshot().activeSessionId).toBeNull();
		expect(store.getSnapshot().syncStatus).toBe("empty");
		expect(store.getSnapshot().interactionOrder).toEqual(["33333333-3333-4333-8333-333333333333"]);
	});

	it("applies terminal deletion and reload invalidations", () => {
		const deleted = new AppStore();
		deleted.applySnapshot(snapshot(EPOCH_A, 2));
		deleted.setSessions({ sessions: [session(), session("session-2")], nextAfterSessionId: null });
		expect(
			deleted.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 3,
				toCursor: 4,
				events: [
					{ type: "session/invalidated", sessionId: "session-2", reason: "deleted" },
					{ type: "session/invalidated", sessionId: "session-1", reason: "deleted" },
				],
			}),
		).toBe("applied");
		expect(deleted.getSnapshot().activeSessionId).toBeNull();
		expect(deleted.getSnapshot().syncStatus).toBe("empty");

		const reload = new AppStore();
		reload.applySnapshot(snapshot(EPOCH_A, 2));
		expect(
			reload.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 3,
				toCursor: 3,
				events: [{ type: "session/invalidated", sessionId: "session-1", reason: "reload_required" }],
			}),
		).toBe("resnapshot_required");
		expect(reload.getSnapshot().syncStatus).toBe("resnapshot_required");
	});

	it("updates a background session without invalidating the active transcript", () => {
		const store = new AppStore();
		const background = session("session-2");
		store.applySnapshot(snapshot(EPOCH_A, 0));
		store.setSessions({ sessions: [session(), background], nextAfterSessionId: null });
		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 1,
				toCursor: 1,
				events: [{ type: "session/updated", session: { ...background, unread: true } }],
			}),
		).toBe("applied");
		expect(store.getSnapshot().sessionsById.get("session-2")?.unread).toBe(true);
		expect(store.getSnapshot().activeSessionId).toBe("session-1");
		expect(store.getSnapshot().syncStatus).toBe("ready");
	});

	it("applies one project invalidation without removing the other mode", () => {
		const store = new AppStore();
		const chat = { ...session("chat-active"), mode: "chat" as const };
		store.applySnapshot({ ...snapshot(EPOCH_A, 2), session: chat });
		store.setSessions({
			sessions: [chat, { ...session("code-preserved"), mode: "code", cwd: chat.cwd }],
			nextAfterSessionId: null,
		});

		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 3,
				toCursor: 3,
				events: [{ type: "project/invalidated", mode: "chat", cwd: chat.cwd!, reason: "deleted" }],
			}),
		).toBe("applied");
		expect(store.getSnapshot().activeSessionId).toBeNull();
		expect(store.getSnapshot().sessionOrder).toEqual(["code-preserved"]);
	});

	it("replaces and streams the active session collaboration mode", () => {
		const store = new AppStore();
		store.applySnapshot({ ...snapshot(EPOCH_A, 0), collaborationMode: "plan" });
		expect(store.getSnapshot().collaborationMode).toBe("plan");

		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 1,
				toCursor: 1,
				events: [
					{
						type: "session/collaborationModeChanged",
						sessionId: "session-1",
						collaborationMode: "default",
					},
				],
			}),
		).toBe("applied");
		expect(store.getSnapshot().collaborationMode).toBe("default");

		store.applySnapshot({ ...snapshot(EPOCH_B, 4), collaborationMode: "plan" });
		expect(store.getSnapshot().collaborationMode).toBe("plan");
	});

	it("replaces and streams the active session permission mode", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot(EPOCH_A, 0));
		expect(store.getSnapshot().permissionMode).toBe("ask");

		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 1,
				toCursor: 1,
				events: [
					{
						type: "session/permissionModeChanged",
						sessionId: "session-1",
						permissionMode: "full",
					},
				],
			}),
		).toBe("applied");
		expect(store.getSnapshot().permissionMode).toBe("full");

		store.applySnapshot({ ...snapshot(EPOCH_B, 4), permissionMode: "ask" });
		expect(store.getSnapshot().permissionMode).toBe("ask");
	});

	it("replaces, live-updates, and clears the active session task snapshot", () => {
		const store = new AppStore();
		store.applySnapshot({
			...snapshot(EPOCH_A, 0),
			tasks: [{ task: "Inspect implementation", completed: false }],
		});
		expect(store.getSnapshot().tasks).toEqual([{ task: "Inspect implementation", completed: false }]);

		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 1,
				toCursor: 1,
				events: [
					{
						type: "session/tasksChanged",
						sessionId: "session-1",
						tasks: [{ task: "Inspect implementation", completed: true }],
					},
				],
			}),
		).toBe("applied");
		expect(store.getSnapshot().tasks).toEqual([{ task: "Inspect implementation", completed: true }]);

		store.applySnapshot({
			...snapshot(EPOCH_B, 2, []),
			session: session("session-2"),
			tasks: [{ task: "Second session", completed: false }],
		});
		expect(store.getSnapshot().tasks).toEqual([{ task: "Second session", completed: false }]);
		store.removeSession("session-2");
		expect(store.getSnapshot().tasks).toEqual([]);
	});

	it("replaces and live-updates delivered files from snapshot and events", () => {
		const store = new AppStore();
		const deliveredFile = {
			fileId: "aaaaaaaaaaaaaaaa",
			name: "report.xlsx",
			byteLength: 4096,
			deliveredAt: "2026-08-18T00:00:00.000Z",
		};
		store.applySnapshot({
			...snapshot(EPOCH_A, 0),
			deliveredFiles: [deliveredFile],
		});
		expect(store.getSnapshot().deliveredFiles).toEqual([deliveredFile]);

		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 1,
				toCursor: 1,
				events: [
					{
						type: "session/deliveredFilesChanged",
						sessionId: "session-1",
						deliveredFiles: [
							deliveredFile,
							{
								fileId: "bbbbbbbbbbbbbbbb",
								name: "notes.txt",
								byteLength: 12,
								deliveredAt: "2026-08-18T00:00:01.000Z",
							},
						],
					},
				],
			}),
		).toBe("applied");
		expect(store.getSnapshot().deliveredFiles).toHaveLength(2);
	});

	it("replaces, live-updates, and clears the active session goal snapshot", () => {
		const store = new AppStore();
		const goal = {
			goalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
			objective: "keep tests green",
			status: "active" as const,
			timeUsedSeconds: 0,
			activeStartedAt: "2026-08-17T00:00:00.000Z",
		};
		store.applySnapshot({
			...snapshot(EPOCH_A, 0),
			goal,
		});
		expect(store.getSnapshot().goal).toEqual(goal);

		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 1,
				toCursor: 1,
				events: [
					{
						type: "session/goalChanged",
						sessionId: "session-1",
						goal: { ...goal, status: "paused", activeStartedAt: null, timeUsedSeconds: 9 },
					},
				],
			}),
		).toBe("applied");
		expect(store.getSnapshot().goal).toEqual({
			...goal,
			status: "paused",
			activeStartedAt: null,
			timeUsedSeconds: 9,
		});

		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 2,
				toCursor: 2,
				events: [{ type: "session/goalChanged", sessionId: "session-1", goal: null }],
			}),
		).toBe("applied");
		expect(store.getSnapshot().goal).toBeNull();
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

	it("preserves session summaries but not active projection events while resubscribing", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot());
		store.markResubscribing();
		expect(
			store.applyBatch({
				...batch(EPOCH_A, 1, 2),
				events: [
					{
						type: "session/updated",
						session: { ...session(), state: "idle", unread: true, lastTurnOutcome: "completed" },
					},
					...batch(EPOCH_A, 1, 2).events,
				],
			}),
		).toBe("resnapshot_required");
		expect(store.getSnapshot().itemsById.get("item-1")?.content).toEqual([{ type: "text", text: "A" }]);
		expect(store.getSnapshot().sessionsById.get("session-1")).toEqual(
			expect.objectContaining({
				state: "idle",
				unread: true,
				lastTurnOutcome: "completed",
			}),
		);
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
