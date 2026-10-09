import type { ConnectionEventsParams, ItemView, SessionSnapshot, SessionSummary } from "@metis/app-protocol";
import { describe, expect, it, vi } from "vitest";
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
		useMemory: true,
		contributeMemory: true,
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
		permissionPreset: "ask",
		effectiveSettings: { sandboxPolicy: "workspace-write", approvalPolicy: "user" },
		constrainedByParent: false,
		sandboxHealth: "healthy",
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
	it("restores current process, applies live output and clears it on session switch", () => {
		const store = new AppStore();
		const process = {
			processId: "p1",
			command: "echo hello",
			output: "",
			state: "running" as const,
			truncated: false,
		};
		store.applySnapshot({ ...snapshot(), process });
		expect(store.getSnapshot().process).toEqual(process);
		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 1,
				toCursor: 1,
				events: [
					{
						type: "session/processChanged",
						sessionId: "session-1",
						process: { ...process, output: "hello", state: "completed" },
					},
				],
			}),
		).toBe("applied");
		expect(store.getSnapshot().process).toMatchObject({ output: "hello", state: "completed" });
		store.applySnapshot({ ...snapshot(), session: session("session-2") });
		expect(store.getSnapshot().process).toBeUndefined();
	});

	it("coalesces streaming-only subscriber notifications to one frame", async () => {
		vi.useFakeTimers();
		try {
			const store = new AppStore();
			store.applySnapshot(snapshot());
			const listener = vi.fn();
			store.subscribe(listener);

			expect(store.applyBatch(batch(EPOCH_A, 1, 1, "B"))).toBe("applied");
			expect(store.applyBatch(batch(EPOCH_A, 2, 2, "C"))).toBe("applied");
			expect(store.getSnapshot().itemsById.get("item-1")?.content).toEqual([{ type: "text", text: "ABC" }]);
			expect(listener).not.toHaveBeenCalled();

			await vi.advanceTimersByTimeAsync(16);
			expect(listener).toHaveBeenCalledOnce();
		} finally {
			vi.useRealTimers();
		}
	});

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
		store.selectAgentTranscript("session-1", "child-1");

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
						taskId: "task-1",
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

	it("applies live events when the explicitly selected task is the current task", () => {
		const store = new AppStore();
		const task = {
			taskId: "task-current",
			taskSummary: "Current task",
			status: "running" as const,
			createdAt: "2026-07-16T00:00:00.000Z",
			updatedAt: "2026-07-16T00:00:00.000Z",
		};
		store.applySnapshot({
			...snapshot(EPOCH_A, 0),
			agents: [
				{
					agentId: "child-1",
					name: "Current worker",
					agentType: "worker",
					depth: 1,
					status: "running",
					archived: false,
					parentSessionId: "session-1",
					rootSessionId: "session-1",
					agentPath: ["child-1"],
					tasks: [task],
					currentTask: task,
					latestTask: task,
					createdAt: "2026-07-16T00:00:00.000Z",
					updatedAt: "2026-07-16T00:00:00.000Z",
				},
			],
		});
		store.selectAgentTranscript("session-1", "child-1", "task-current");

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
						item: childItem("selected-live", ""),
					},
					{
						type: "agent/item/delta",
						sessionId: "session-1",
						agentId: "child-1",
						itemId: "selected-live",
						delta: { type: "text", text: "visible" },
					},
					{
						type: "agent/item/completed",
						sessionId: "session-1",
						agentId: "child-1",
						item: childItem("selected-live", "visible", "completed"),
					},
					{
						type: "agent/itemsChanged",
						sessionId: "session-1",
						agentId: "child-1",
						taskId: "task-current",
					},
				],
			}),
		).toBe("applied");
		expect(store.getSnapshot().agentTranscript.itemsById.get("selected-live")?.content).toEqual([
			{ type: "text", text: "visible" },
		]);
		expect(store.getSnapshot().agentTranscript.journalRevision).toBe(1);
	});

	it("refreshes an explicitly selected task after its terminal summary clears currentTask", () => {
		const store = new AppStore();
		const task = {
			taskId: "task-current",
			status: "running" as const,
			taskSummary: "current",
			createdAt: "2026-07-16T00:00:00.000Z",
			updatedAt: "2026-07-16T00:00:00.000Z",
		};
		const running = {
			agentId: "child-1",
			name: "worker",
			agentType: "worker" as const,
			depth: 1,
			status: "running" as const,
			archived: false,
			parentSessionId: "session-1",
			rootSessionId: "session-1",
			agentPath: ["child-1"],
			tasks: [task],
			currentTask: task,
			latestTask: task,
			createdAt: task.createdAt,
			updatedAt: task.updatedAt,
		};
		store.applySnapshot({ ...snapshot(EPOCH_A, 0), agents: [running] });
		store.selectAgentTranscript("session-1", "child-1", "task-current");
		const terminal = { ...task, status: "done" as const, updatedAt: "2026-07-16T00:01:00.000Z" };

		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 1,
				toCursor: 2,
				events: [
					{
						type: "agent/updated",
						sessionId: "session-1",
						agent: {
							...running,
							status: "done",
							tasks: [terminal],
							currentTask: undefined,
							latestTask: terminal,
							updatedAt: terminal.updatedAt,
						},
					},
					{
						type: "agent/itemsChanged",
						sessionId: "session-1",
						agentId: "child-1",
						taskId: "task-current",
					},
				],
			}),
		).toBe("applied");
		expect(store.getSnapshot().agentTranscript.journalRevision).toBe(1);
	});

	it("replaces and paginates child history, then mirrors the new session's empty transcript on switch", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot());
		store.selectAgentTranscript("session-1", "child-1");
		store.replaceAgentItems("session-1", "child-1", null, {
			items: [childItem("durable", "new", "completed")],
			nextBeforeItemId: "durable",
		});
		store.prependAgentItems("session-1", "child-1", null, {
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
		// The previous session's own bucket keeps its selection.
		expect(store.getSnapshot().sessions.get("session-1")?.agentTranscript.itemOrder).toEqual(["older", "durable"]);
	});

	it("requests a selected-child refresh after a same-session resnapshot", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot(EPOCH_A));
		store.selectAgentTranscript("session-1", "child-1");
		store.applySnapshot(snapshot(EPOCH_B));
		expect(store.getSnapshot().agentTranscript).toMatchObject({ agentId: "child-1", journalRevision: 1 });
	});

	it("routes agent transcript events and deletions to their own session bucket", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot(EPOCH_A, 0));
		store.beginSubscription("session-2", { focus: false });
		store.applySnapshot({ ...snapshot(EPOCH_A, 0), session: session("session-2") });
		expect(store.getSnapshot().activeSessionId).toBe("session-1");
		store.selectAgentTranscript("session-1", "child-a");
		store.selectAgentTranscript("session-2", "child-b");

		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 1,
				toCursor: 5,
				events: [
					{
						type: "agent/item/started",
						sessionId: "session-2",
						agentId: "child-b",
						item: { ...childItem("b-live", ""), sessionId: "child-b" },
					},
					{
						type: "agent/item/delta",
						sessionId: "session-2",
						agentId: "child-b",
						itemId: "b-live",
						delta: { type: "text", text: "B" },
					},
					{
						type: "agent/itemsChanged",
						sessionId: "session-2",
						agentId: "child-b",
						taskId: "task-b",
					},
					{
						type: "agent/item/started",
						sessionId: "session-1",
						agentId: "child-a",
						item: { ...childItem("a-live", ""), sessionId: "child-a" },
					},
					{
						type: "agent/item/started",
						sessionId: "session-1",
						agentId: "child-b",
						item: { ...childItem("stray", "stray"), sessionId: "child-b" },
					},
				],
			}),
		).toBe("applied");

		let state = store.getSnapshot();
		expect(state.sessions.get("session-2")?.agentTranscript.itemsById.get("b-live")?.content).toEqual([
			{ type: "text", text: "B" },
		]);
		expect(state.sessions.get("session-2")?.agentTranscript.journalRevision).toBe(1);
		expect(state.sessions.get("session-1")?.agentTranscript.itemOrder).toEqual(["a-live"]);
		expect(state.sessions.get("session-1")?.agentTranscript.itemsById.has("stray")).toBe(false);
		// The compat mirror still shows the active session's transcript.
		expect(state.agentTranscript.agentId).toBe("child-a");

		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 6,
				toCursor: 6,
				events: [
					{
						type: "agent/deleted",
						sessionId: "session-2",
						agentId: "child-b",
						deletedAgentIds: ["child-b"],
					},
				],
			}),
		).toBe("applied");
		state = store.getSnapshot();
		expect(state.sessions.get("session-2")?.agentTranscript.agentId).toBeNull();
		expect(state.sessions.get("session-2")?.agentTranscript.itemOrder).toEqual([]);
		expect(state.sessions.get("session-1")?.agentTranscript.agentId).toBe("child-a");
		expect(state.sessions.get("session-1")?.agentTranscript.itemsById.has("a-live")).toBe(true);
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
		expect(state.permissionPreset).toBe("auto");
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
		expect(store.getSnapshot().permissionPreset).toBe("ask");

		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 1,
				toCursor: 1,
				events: [
					{
						type: "session/permissionPresetChanged",
						sessionId: "session-1",
						permissionPreset: "full",
						effectiveSettings: { sandboxPolicy: "danger-full-access", approvalPolicy: "user" },
						constrainedByParent: false,
						sandboxHealth: "healthy",
					},
				],
			}),
		).toBe("applied");
		expect(store.getSnapshot().permissionPreset).toBe("full");
		expect(store.getSnapshot().constrainedByParent).toBe(false);
		expect(store.getSnapshot().sandboxHealth).toBe("healthy");

		store.applySnapshot({ ...snapshot(EPOCH_B, 4), permissionPreset: "ask" });
		expect(store.getSnapshot().permissionPreset).toBe("ask");
	});

	it("tracks model review start and clears only the matching action", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot(EPOCH_A, 0));
		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 1,
				toCursor: 1,
				events: [
					{
						type: "session/permissionReviewStarted",
						sessionId: "session-1",
						actionId: "action-a",
						reviewer: "model",
						riskLevel: "high",
					},
				],
			}),
		).toBe("applied");
		expect(store.getSnapshot().activeReview).toEqual({
			actionId: "action-a",
			reviewer: "model",
			riskLevel: "high",
		});

		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 2,
				toCursor: 2,
				events: [
					{
						type: "session/permissionReviewCompleted",
						sessionId: "session-1",
						actionId: "action-other",
						reviewer: "model",
						outcome: "deny",
						riskLevel: "high",
					},
				],
			}),
		).toBe("applied");
		expect(store.getSnapshot().activeReview?.actionId).toBe("action-a");

		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 3,
				toCursor: 3,
				events: [
					{
						type: "session/permissionReviewCompleted",
						sessionId: "session-1",
						actionId: "action-a",
						reviewer: "model",
						outcome: "unavailable",
						riskLevel: "high",
					},
				],
			}),
		).toBe("applied");
		expect(store.getSnapshot().activeReview).toBeUndefined();
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
			availability: "available" as const,
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
								availability: "unavailable",
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
		expect(state.notifications).toHaveLength(1);
		expect(state.syncStatus).toBe("ready");
	});

	it("dismisses only the captured notifications, preserving other IDs and newer events", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot(EPOCH_A, 0));
		store.applyBatch({
			serverEpoch: EPOCH_A,
			fromCursor: 1,
			toCursor: 3,
			events: ["global", "session", "newer"].map((id) => ({
				type: "interaction/notify" as const,
				notificationId: id,
				level: "info" as const,
				message: id,
				createdAt: new Date().toISOString(),
				...(id === "session" ? { sessionId: "session-1" } : {}),
			})),
		});
		store.dismissNotifications(["global"]);
		expect(store.getSnapshot().notifications.map((notice) => notice.notificationId)).toEqual(["session", "newer"]);
		const before = store.getSnapshot();
		store.dismissNotifications(["global"]);
		expect(store.getSnapshot()).toBe(before);
	});

	it("surfaces connection-level memory changes as notifications", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot(EPOCH_A, 0));
		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 1,
				toCursor: 1,
				events: [
					{
						type: "memory/changed",
						entry: {
							id: "44444444-4444-4444-8444-444444444444",
							ts: "2026-07-16T01:00:00.000Z",
							actor: { kind: "agent", sessionId: "session-1" },
							op: "create",
							scope: "global",
							target: { slug: "prefers-concise-replies" },
						},
					},
				],
			}),
		).toBe("applied");
		const notifications = store.getSnapshot().notifications;
		expect(notifications).toHaveLength(1);
		expect(notifications[0]!.message).toBe('Saved memory: note "prefers-concise-replies"');
		expect(notifications[0]!.sessionId).toBeUndefined();
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
		["out of order", batch(EPOCH_A, -1, -1)],
	])("requires a fresh snapshot for %s events", (_label, events) => {
		const store = new AppStore();
		store.applySnapshot(snapshot());
		expect(store.applyBatch(events)).toBe("resnapshot_required");
		expect(store.getSnapshot().syncStatus).toBe("resnapshot_required");
		expect(store.getSnapshot().itemsById.get("item-1")?.content).toEqual([{ type: "text", text: "A" }]);
	});

	it("applies a batch that skips ahead in the cursor stream", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot());
		expect(store.applyBatch(batch(EPOCH_A, 3, 3))).toBe("applied");
		expect(store.getSnapshot().itemsById.get("item-1")?.content).toEqual([{ type: "text", text: "AB" }]);
		expect(store.getSnapshot().cursor).toBe(3);
	});

	it("skips background session events while applying active session events", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot());
		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 1,
				toCursor: 2,
				events: [
					{
						type: "item/delta",
						sessionId: "session-2",
						itemId: "item-2",
						delta: { type: "text", text: "x" },
					},
					{
						type: "item/delta",
						sessionId: "session-1",
						itemId: "item-1",
						delta: { type: "text", text: "B" },
					},
				],
			}),
		).toBe("applied");
		expect(store.getSnapshot().itemsById.get("item-1")?.content).toEqual([{ type: "text", text: "AB" }]);
		expect(store.getSnapshot().itemsById.has("item-2")).toBe(false);
		expect(store.getSnapshot().syncStatus).toBe("ready");
	});

	it("replays buffered events for a session that was still opening", () => {
		const store = new AppStore();
		store.applySnapshot({ ...snapshot(), cursor: 10 });
		store.beginSubscription("session-2");
		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 11,
				toCursor: 12,
				events: [
					{
						type: "item/started",
						item: { ...item("item-2", "s2"), sessionId: "session-2" },
					},
					{
						type: "item/delta",
						sessionId: "session-2",
						itemId: "item-2",
						delta: { type: "text", text: "-more" },
					},
				],
			}),
		).toBe("applied");
		expect(store.getSnapshot().itemsById.has("item-2")).toBe(false);
		store.applySnapshot({
			...snapshot(),
			session: session("session-2"),
			recentItems: [{ ...item("item-2", "s2"), sessionId: "session-2" }],
			cursor: 11,
		});
		expect(store.getSnapshot().activeSessionId).toBe("session-2");
		expect(store.getSnapshot().itemsById.get("item-2")?.content).toEqual([{ type: "text", text: "s2-more" }]);
		expect(store.getSnapshot().cursor).toBe(12);
	});

	it("does not adopt the snapshot cursor when it is ahead of buffered events", () => {
		const store = new AppStore();
		store.applySnapshot({ ...snapshot(), cursor: 10 });
		store.beginSubscription("session-2");
		store.applyBatch({
			serverEpoch: EPOCH_A,
			fromCursor: 11,
			toCursor: 12,
			events: [
				{
					type: "item/started",
					item: { ...item("item-2", "s2"), sessionId: "session-2" },
				},
				{
					type: "item/delta",
					sessionId: "session-2",
					itemId: "item-2",
					delta: { type: "text", text: "-more" },
				},
			],
		});
		store.applySnapshot({
			...snapshot(),
			session: session("session-2"),
			recentItems: [{ ...item("item-2", "full"), sessionId: "session-2", state: "completed" }],
			cursor: 15,
		});
		expect(store.getSnapshot().itemsById.get("item-2")?.content).toEqual([{ type: "text", text: "full" }]);
		expect(store.getSnapshot().cursor).toBe(12);
		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 13,
				toCursor: 13,
				events: [{ type: "session/updated", session: session("session-3") }],
			}),
		).toBe("applied");
		expect(store.getSnapshot().cursor).toBe(13);
		expect(store.getSnapshot().sessionsById.has("session-3")).toBe(true);
	});

	it("keeps applying active session events while another session subscribes", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot());
		store.beginSubscription("session-2");
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
		).toBe("applied");
		expect(store.getSnapshot().itemsById.get("item-1")?.content).toEqual([{ type: "text", text: "AB" }]);
		expect(store.getSnapshot().syncStatus).toBe("resubscribing");
		expect(store.getSnapshot().cursor).toBe(2);
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
		const subscription = store.beginSubscription("session-1");
		expect(store.getSnapshot().syncStatus).toBe("resubscribing");

		store.cancelSubscription("session-1", subscription);
		expect(store.getSnapshot().syncStatus).toBe("ready");
	});

	it("keeps applying the active session's events while another session opens", () => {
		const store = new AppStore();
		store.applySnapshot({ ...snapshot(), cursor: 10 });
		const subscription = store.beginSubscription("session-2");
		store.applyBatch({
			serverEpoch: EPOCH_A,
			fromCursor: 11,
			toCursor: 12,
			events: [
				{
					type: "item/delta",
					sessionId: "session-1",
					itemId: "item-1",
					delta: { type: "text", text: "-keep" },
				},
				{
					type: "item/delta",
					sessionId: "session-2",
					itemId: "item-2",
					delta: { type: "text", text: "-drop" },
				},
			],
		});
		expect(store.getSnapshot().itemsById.get("item-1")?.content).toEqual([{ type: "text", text: "A-keep" }]);
		expect(store.getSnapshot().sessions.get("session-2")?.syncStatus).toBe("subscribing");
		store.cancelSubscription("session-2", subscription);
		expect(store.getSnapshot().sessions.has("session-2")).toBe(false);
		expect(store.getSnapshot().syncStatus).toBe("ready");
		expect(store.getSnapshot().itemsById.get("item-1")?.content).toEqual([{ type: "text", text: "A-keep" }]);
		expect(store.getSnapshot().itemsById.has("item-2")).toBe(false);
		expect(store.getSnapshot().cursor).toBe(12);
	});

	it("replays a reopened session's buffered events when its open is cancelled", () => {
		const store = new AppStore();
		store.applySnapshot({ ...snapshot(), cursor: 10 });
		const subscription = store.beginSubscription("session-1");
		store.applyBatch({
			serverEpoch: EPOCH_A,
			fromCursor: 11,
			toCursor: 11,
			events: [
				{
					type: "item/delta",
					sessionId: "session-1",
					itemId: "item-1",
					delta: { type: "text", text: "-more" },
				},
			],
		});
		expect(store.getSnapshot().itemsById.get("item-1")?.content).toEqual([{ type: "text", text: "A" }]);
		store.cancelSubscription("session-1", subscription);
		expect(store.getSnapshot().syncStatus).toBe("ready");
		expect(store.getSnapshot().itemsById.get("item-1")?.content).toEqual([{ type: "text", text: "A-more" }]);
		expect(store.getSnapshot().cursor).toBe(11);
	});

	it("keeps events buffered by a background resubscribe when the same session is focused", () => {
		const store = new AppStore();
		store.applySnapshot({ ...snapshot(), cursor: 10 });
		const background = {
			...snapshot(),
			session: session("session-2"),
			recentItems: [{ ...item("item-2", "s2"), sessionId: "session-2" }],
			cursor: 10,
		};
		store.beginSubscription("session-2", { focus: false });
		store.applySnapshot(background);
		// The live pane resubscribes in the background, and a delta arrives while it waits.
		store.beginSubscription("session-2", { focus: false });
		store.applyBatch({
			serverEpoch: EPOCH_A,
			fromCursor: 11,
			toCursor: 11,
			events: [
				{ type: "item/delta", sessionId: "session-2", itemId: "item-2", delta: { type: "text", text: "-live" } },
			],
		});
		// Focusing the pane claims the in-flight subscription with an open snapshot taken before that delta.
		store.beginSubscription("session-2");
		store.applySnapshot(background);
		const state = store.getSnapshot();
		expect(state.activeSessionId).toBe("session-2");
		expect(state.syncStatus).toBe("ready");
		expect(state.itemsById.get("item-2")?.content).toEqual([{ type: "text", text: "s2-live" }]);
	});

	it("ignores a stale cancel after the same session is reopened", () => {
		const store = new AppStore();
		store.applySnapshot({ ...snapshot(), cursor: 10 });
		const first = store.beginSubscription("session-1");
		store.beginSubscription("session-1");
		store.applyBatch({
			serverEpoch: EPOCH_A,
			fromCursor: 11,
			toCursor: 11,
			events: [
				{
					type: "item/delta",
					sessionId: "session-1",
					itemId: "item-1",
					delta: { type: "text", text: "-live" },
				},
			],
		});
		store.cancelSubscription("session-1", first);
		expect(store.getSnapshot().sessions.get("session-1")?.syncStatus).toBe("subscribing");
		store.applySnapshot({ ...snapshot(), cursor: 10 });
		expect(store.getSnapshot().syncStatus).toBe("ready");
		expect(store.getSnapshot().itemsById.get("item-1")?.content).toEqual([{ type: "text", text: "A-live" }]);
	});

	it("keeps only the newest open's focus claim", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot());
		store.beginSubscription("session-2");
		store.beginSubscription("session-3");
		store.applySnapshot({ ...snapshot(), session: session("session-3"), recentItems: [], cursor: 3 });
		const state = store.getSnapshot();
		expect(state.activeSessionId).toBe("session-3");
		expect(state.syncStatus).toBe("ready");
		expect(state.sessions.get("session-2")?.syncStatus).toBe("subscribing");
		expect(state.sessions.get("session-2")?.focusOnSnapshot).toBe(false);
	});

	it("ignores a cancel token once the subscription landed", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot());
		const subscription = store.beginSubscription("session-2");
		store.applySnapshot({ ...snapshot(), session: session("session-2"), recentItems: [], cursor: 5 });
		const before = store.getSnapshot();
		store.cancelSubscription("session-2", subscription);
		const state = store.getSnapshot();
		expect(state).toBe(before);
		expect(state.sessions.get("session-2")?.syncStatus).toBe("ready");
		expect(state.activeSessionId).toBe("session-2");
	});

	it("cancelling a superseded open keeps the in-flight subscription alive", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot());
		const superseded = store.beginSubscription("session-2");
		const current = store.beginSubscription("session-3");
		store.cancelSubscription("session-3", current);
		expect(store.getSnapshot().sessions.has("session-3")).toBe(false);
		expect(store.getSnapshot().sessions.get("session-2")?.syncStatus).toBe("subscribing");
		expect(store.getSnapshot().syncStatus).toBe("ready");
		store.cancelSubscription("session-2", superseded);
		expect(store.getSnapshot().sessions.has("session-2")).toBe(false);
		expect(store.getSnapshot().syncStatus).toBe("ready");
	});

	it("keeps demanding a resnapshot once one is required", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot());
		expect(store.applyBatch(batch(EPOCH_B, 1, 1))).toBe("resnapshot_required");
		expect(store.applyBatch(batch(EPOCH_A, 1, 1))).toBe("resnapshot_required");
		expect(store.getSnapshot().syncStatus).toBe("resnapshot_required");
	});

	it("requires a resnapshot when the resubscribe buffer overflows", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot());
		store.beginSubscription("session-2");
		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 1,
				toCursor: 5001,
				events: Array.from({ length: 5001 }, (_, index) => ({
					type: "item/delta" as const,
					sessionId: "session-2",
					itemId: `item-${index}`,
					delta: { type: "text" as const, text: `${index}` },
				})),
			}),
		).toBe("applied");
		store.applySnapshot({ ...snapshot(), session: session("session-2"), recentItems: [], cursor: 1 });
		expect(store.getSnapshot().syncStatus).toBe("resnapshot_required");
	});

	it("applies session-less events immediately while another session subscribes", () => {
		const store = new AppStore();
		store.applySnapshot(snapshot());
		store.beginSubscription("session-2");
		store.applyBatch({
			serverEpoch: EPOCH_A,
			fromCursor: 1,
			toCursor: 1,
			events: [
				{
					type: "memory/changed",
					entry: {
						id: "memory-1",
						ts: "2026-07-20T00:00:00.000Z",
						actor: { kind: "agent", sessionId: "session-1" },
						op: "create",
						scope: "global",
						target: { slug: "note" },
					},
				},
			],
		});
		expect(store.getSnapshot().notifications).toHaveLength(1);
		store.applySnapshot({ ...snapshot(), session: session("session-2"), recentItems: [], cursor: 3 });
		expect(store.getSnapshot().syncStatus).toBe("ready");
		expect(store.getSnapshot().notifications).toHaveLength(1);
	});

	it("routes interleaved events to their own session buckets", () => {
		const store = new AppStore();
		store.applySnapshot({ ...snapshot(), cursor: 10 });
		store.beginSubscription("session-2", { focus: false });
		store.applySnapshot({
			...snapshot(),
			session: session("session-2"),
			recentItems: [{ ...item("item-2", "s2"), sessionId: "session-2" }],
			cursor: 10,
		});
		const revisionBefore = store.getSnapshot().sessions.get("session-2")!.revision;
		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 11,
				toCursor: 12,
				events: [
					{
						type: "item/delta",
						sessionId: "session-2",
						itemId: "item-2",
						delta: { type: "text", text: "-bg" },
					},
					{
						type: "item/delta",
						sessionId: "session-1",
						itemId: "item-1",
						delta: { type: "text", text: "-fg" },
					},
				],
			}),
		).toBe("applied");
		const state = store.getSnapshot();
		expect(state.activeSessionId).toBe("session-1");
		expect(state.itemsById.get("item-1")?.content).toEqual([{ type: "text", text: "A-fg" }]);
		expect(state.itemsById.has("item-2")).toBe(false);
		const background = state.sessions.get("session-2")!;
		expect(background.syncStatus).toBe("ready");
		expect(background.itemsById.get("item-2")?.content).toEqual([{ type: "text", text: "s2-bg" }]);
		expect(background.revision).toBeGreaterThan(revisionBefore);
	});

	it("marks only the offending session bucket when a delta cannot be applied", () => {
		const store = new AppStore();
		store.applySnapshot({ ...snapshot(), cursor: 10 });
		store.beginSubscription("session-2", { focus: false });
		store.applySnapshot({
			...snapshot(),
			session: session("session-2"),
			recentItems: [{ ...item("item-2", "s2", "completed"), sessionId: "session-2" }],
			cursor: 10,
		});
		expect(
			store.applyBatch({
				serverEpoch: EPOCH_A,
				fromCursor: 11,
				toCursor: 12,
				events: [
					{
						type: "item/delta",
						sessionId: "session-2",
						itemId: "item-2",
						delta: { type: "text", text: "-bad" },
					},
					{
						type: "item/delta",
						sessionId: "session-1",
						itemId: "item-1",
						delta: { type: "text", text: "-ok" },
					},
				],
			}),
		).toBe("applied");
		const state = store.getSnapshot();
		expect(state.syncStatus).toBe("ready");
		expect(state.itemsById.get("item-1")?.content).toEqual([{ type: "text", text: "A-ok" }]);
		expect(state.sessions.get("session-2")?.syncStatus).toBe("resnapshot_required");
		expect(state.sessions.get("session-2")?.itemsById.get("item-2")?.content).toEqual([{ type: "text", text: "s2" }]);
	});

	it("replays a matching project invalidation buffered while subscribing", () => {
		const store = new AppStore();
		store.applySnapshot({ ...snapshot(), cursor: 10 });
		store.upsertSession({ ...session("session-2"), cwd: "/tmp/other" });
		store.beginSubscription("session-2", { focus: false });
		store.applyBatch({
			serverEpoch: EPOCH_A,
			fromCursor: 11,
			toCursor: 11,
			events: [{ type: "project/invalidated", mode: "code", cwd: "/tmp/other", reason: "reload_required" }],
		});
		expect(store.getSnapshot().sessions.get("session-2")?.syncStatus).toBe("subscribing");
		store.applySnapshot({
			...snapshot(),
			session: { ...session("session-2"), cwd: "/tmp/other" },
			recentItems: [],
			cursor: 10,
		});
		expect(store.getSnapshot().sessions.get("session-2")?.syncStatus).toBe("resnapshot_required");
		expect(store.getSnapshot().syncStatus).toBe("ready");
	});

	it("marks other buckets stale when a snapshot changes the server epoch", () => {
		const store = new AppStore();
		store.applySnapshot({ ...snapshot(), cursor: 5 });
		store.beginSubscription("session-2", { focus: false });
		store.applySnapshot({ ...snapshot(), session: session("session-2"), recentItems: [], cursor: 5 });
		store.applySnapshot({ ...snapshot(EPOCH_B, 20), session: session("session-3"), recentItems: [] });
		expect(store.getSnapshot().sessions.get("session-1")?.syncStatus).toBe("resnapshot_required");
		expect(store.getSnapshot().sessions.get("session-2")?.syncStatus).toBe("resnapshot_required");
		expect(store.getSnapshot().sessions.get("session-3")?.syncStatus).toBe("ready");
		expect(store.getSnapshot().serverEpoch).toBe(EPOCH_B);
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
		store.prependItems("session-1", {
			items: [item("item-0", "oldest", "completed"), item("item-200", "updated", "completed")],
			nextBeforeItemId: null,
		});

		expect(store.getSnapshot().itemOrder).toEqual(["item-0", "item-200"]);
		expect(store.getSnapshot().itemsById.get("item-200")?.content).toEqual([{ type: "text", text: "updated" }]);
		expect(store.getSnapshot().nextBeforeItemId).toBeNull();
	});

	function hiddenSnapshot(sessionId: string, text: string): SessionSnapshot {
		return {
			...snapshot(),
			session: session(sessionId),
			recentItems: [{ ...item(`item-${sessionId}`, text), sessionId }],
		};
	}

	describe("retired projection cache", () => {
		function subscribeHidden(store: AppStore, sessionId: string, text = "hidden"): void {
			store.beginSubscription(sessionId, { focus: false });
			store.applySnapshot(hiddenSnapshot(sessionId, text));
		}

		it("retires a hidden bucket and adopts it back with stale content while subscribing", () => {
			const store = new AppStore();
			store.applySnapshot(snapshot());
			subscribeHidden(store, "session-2", "stale text");

			store.dropProjection("session-2");
			expect(store.getSnapshot().sessions.has("session-2")).toBe(false);
			expect(store.getSnapshot().retiredSessions.get("session-2")?.itemOrder).toEqual(["item-session-2"]);

			store.beginSubscription("session-2", { focus: false });
			const adopted = store.getSnapshot().sessions.get("session-2");
			expect(store.getSnapshot().retiredSessions.has("session-2")).toBe(false);
			expect(adopted?.syncStatus).toBe("subscribing");
			expect(adopted?.itemOrder).toEqual(["item-session-2"]);
			expect(adopted?.itemsById.get("item-session-2")?.content).toEqual([{ type: "text", text: "stale text" }]);
		});

		it("replaces adopted content when the fresh snapshot lands", () => {
			const store = new AppStore();
			store.applySnapshot(snapshot());
			subscribeHidden(store, "session-2", "stale text");
			store.dropProjection("session-2");
			store.beginSubscription("session-2", { focus: false });

			store.applySnapshot(hiddenSnapshot("session-2", "fresh text"));
			const bucket = store.getSnapshot().sessions.get("session-2");
			expect(bucket?.syncStatus).toBe("ready");
			expect(bucket?.itemOrder).toEqual(["item-session-2"]);
			expect(bucket?.itemsById.get("item-session-2")?.content).toEqual([{ type: "text", text: "fresh text" }]);
		});

		it("evicts the oldest retired bucket past the capacity of eight", () => {
			const store = new AppStore();
			store.applySnapshot(snapshot());
			for (let index = 1; index <= 9; index += 1) {
				subscribeHidden(store, `session-${index + 1}`, `text ${index}`);
			}
			for (let index = 1; index <= 9; index += 1) {
				store.dropProjection(`session-${index + 1}`);
			}
			const retired = store.getSnapshot().retiredSessions;
			expect(retired.size).toBe(8);
			expect(retired.has("session-2")).toBe(false);
			expect(retired.has("session-10")).toBe(true);
			expect([...retired.keys()]).toEqual([
				"session-3",
				"session-4",
				"session-5",
				"session-6",
				"session-7",
				"session-8",
				"session-9",
				"session-10",
			]);
		});

		it("does not retire the active session or a missing bucket", () => {
			const store = new AppStore();
			store.applySnapshot(snapshot());
			store.dropProjection("session-1");
			expect(store.getSnapshot().sessions.has("session-1")).toBe(true);
			expect(store.getSnapshot().retiredSessions.size).toBe(0);
			store.dropProjection("missing");
			expect(store.getSnapshot().retiredSessions.size).toBe(0);
		});

		it("discards retired buckets when the server epoch changes", () => {
			const store = new AppStore();
			store.applySnapshot(snapshot());
			subscribeHidden(store, "session-2", "stale text");
			store.dropProjection("session-2");

			store.applySnapshot({ ...snapshot(EPOCH_B, 8), session: session("session-3") });
			expect(store.getSnapshot().retiredSessions.size).toBe(0);

			store.beginSubscription("session-2", { focus: false });
			const bucket = store.getSnapshot().sessions.get("session-2");
			expect(bucket?.syncStatus).toBe("subscribing");
			expect(bucket?.itemOrder).toEqual([]);
		});

		it("discards retired buckets when the session is removed", () => {
			const store = new AppStore();
			store.applySnapshot(snapshot());
			subscribeHidden(store, "session-2", "stale text");
			store.dropProjection("session-2");

			store.removeSession("session-2");
			expect(store.getSnapshot().retiredSessions.size).toBe(0);
			store.beginSubscription("session-2", { focus: false });
			expect(store.getSnapshot().sessions.get("session-2")?.itemOrder).toEqual([]);
		});
	});
});
