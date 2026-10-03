// @vitest-environment jsdom

import { RPC_ERROR_CODES, type SessionSnapshot, type SessionSummary } from "@metis/app-protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { SessionWorkspaceWorkflow } from "../src/renderer/session-workspace-workflow.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";
import type { DesktopApiEvent, MetisDesktopApi } from "../src/shared/desktop-api.ts";

const EPOCH = "11111111-1111-4111-8111-111111111111";

function summary(sessionId: string, mode: "chat" | "code" = "chat", unread = false): SessionSummary {
	return {
		sessionId,
		mode,
		cwdOrigin: mode === "chat" ? "managed" : "user-selected",
		cwd: mode === "chat" ? `/managed/${sessionId}` : `/work/${sessionId}`,
		createdAt: "2026-08-30T00:00:00.000Z",
		updatedAt: "2026-08-30T00:00:00.000Z",
		state: "idle",
		archived: false,
		unread,
		useMemory: true,
		contributeMemory: true,
	};
}

function snapshot(sessionId: string, mode: "chat" | "code" = "chat", unread = false): SessionSnapshot {
	return {
		session: summary(sessionId, mode, unread),
		collaborationMode: "default",
		permissionPreset: "ask",
		effectiveSettings: { sandboxPolicy: "workspace-write", approvalPolicy: "user" },
		constrainedByParent: false,
		sandboxHealth: "healthy",
		turns: [],
		recentItems: [],
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
		agents: [],
		serverEpoch: EPOCH,
		cursor: 0,
	};
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (cause: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, reject, resolve };
}

function rpcFailure(code: number, message: string): Error & { code: number } {
	return Object.assign(new Error(message), { code });
}

function harness(sessions: readonly SessionSummary[] = [], onDesktopEvent?: (event: DesktopApiEvent) => void) {
	let listener: ((event: DesktopApiEvent) => void) | undefined;
	const api = {
		getServerState: vi.fn().mockResolvedValue({
			state: "ready",
			serverEpoch: EPOCH,
			restartAttempt: 0,
			failure: null,
		}),
		listSessions: vi.fn().mockResolvedValue({ sessions, nextAfterSessionId: null }),
		openSession: vi.fn(),
		markSessionRead: vi.fn(async ({ sessionId }: { sessionId: string }) => ({
			session: {
				...(sessions.find((candidate) => candidate.sessionId === sessionId) ?? summary(sessionId)),
				unread: false,
			},
		})),
		createSession: vi.fn(),
		renameSession: vi.fn(),
		forkSession: vi.fn(),
		deleteSession: vi.fn(),
		previewProjectDelete: vi.fn(),
		deleteProject: vi.fn(),
		startTurn: vi.fn().mockResolvedValue({}),
		selectProjectFolder: vi.fn().mockResolvedValue(null),
		subscribe: vi.fn((next: (event: DesktopApiEvent) => void) => {
			listener = next;
			return () => {
				if (listener === next) listener = undefined;
			};
		}),
	} as unknown as MetisDesktopApi;
	const store = new AppStore();
	const workflow = new SessionWorkspaceWorkflow({ api, store, storage: localStorage, onDesktopEvent });
	return { api, emit: (event: DesktopApiEvent) => listener?.(event), store, workflow };
}

describe("SessionWorkspaceWorkflow", () => {
	beforeEach(() => localStorage.clear());

	it("applies the welcome model and thinking selection before the first Code turn", async () => {
		const { api, workflow } = harness();
		Object.assign(api, {
			setModel: vi.fn().mockResolvedValue({}),
			setThinkingSelection: vi.fn().mockResolvedValue({}),
		});
		vi.mocked(api.createSession).mockResolvedValue({ session: summary("new-code", "code") });
		vi.mocked(api.openSession).mockResolvedValue(snapshot("new-code", "code"));
		workflow.startNewTask("code");
		await workflow.submitNewTask({ text: "Build it", attachments: [] });
		expect(api.createSession).not.toHaveBeenCalled();
		workflow.setDraftFolder("/project");
		await workflow.submitNewTask({ text: "Build it", attachments: [] }, undefined, {
			model: { provider: "example", modelId: "code-model" },
			thinkingSelection: "high",
		});
		expect(api.setModel).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "new-code", provider: "example", modelId: "code-model" }),
		);
		expect(api.setThinkingSelection).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "new-code", selection: "high" }),
		);
		expect(vi.mocked(api.setThinkingSelection).mock.invocationCallOrder[0]).toBeLessThan(
			vi.mocked(api.startTurn).mock.invocationCallOrder[0]!,
		);
		expect(workflow.getSnapshot().draft).toBeNull();
	});

	it("keeps the newest open result when older work finishes later", async () => {
		const { api, store, workflow } = harness();
		const first = deferred<SessionSnapshot>();
		const second = deferred<SessionSnapshot>();
		vi.mocked(api.openSession).mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

		const stale = workflow.openSession("session-a");
		const current = workflow.openSession("session-b");
		second.resolve(snapshot("session-b"));
		await current;
		first.resolve(snapshot("session-a"));
		await stale;

		expect(store.getSnapshot().activeSessionId).toBe("session-b");
	});

	it("does not let a stale visible open clear a newer draft", async () => {
		const { api, store, workflow } = harness();
		const pending = deferred<SessionSnapshot>();
		vi.mocked(api.openSession).mockReturnValue(pending.promise);

		const opening = workflow.openVisibleSession("old-session");
		workflow.startNewTask("code");
		pending.resolve(snapshot("old-session"));
		await opening;

		expect(workflow.getSnapshot().draft?.mode).toBe("code");
		expect(store.getSnapshot().activeSessionId).toBeNull();
	});

	it("does not let a supervisor resnapshot supersede a visible session open", async () => {
		const active = summary("active-session");
		const { api, emit, store, workflow } = harness([active, summary("visible-session")]);
		await workflow.start();
		store.applySnapshot(snapshot(active.sessionId));
		const visible = deferred<SessionSnapshot>();
		vi.mocked(api.openSession).mockReturnValue(visible.promise);

		const opening = workflow.openVisibleSession("visible-session");
		emit({
			type: "supervisor",
			view: {
				state: "ready",
				serverEpoch: "22222222-2222-4222-8222-222222222222",
				restartAttempt: 0,
				failure: null,
			},
		});

		expect(api.openSession).toHaveBeenCalledOnce();
		expect(api.openSession).toHaveBeenCalledWith({ sessionId: "visible-session" });
		visible.resolve(snapshot("visible-session"));
		await opening;
		expect(store.getSnapshot().activeSessionId).toBe("visible-session");
	});

	it("does not let an older rename overwrite the latest session name", async () => {
		const target = summary("rename-target");
		const { api, store, workflow } = harness([target]);
		store.setSessions({ sessions: [target], nextAfterSessionId: null });
		const first = deferred<{ session: SessionSummary }>();
		const second = deferred<{ session: SessionSummary }>();
		vi.mocked(api.renameSession).mockImplementation(({ name }) =>
			name === "Older" ? first.promise : second.promise,
		);
		const latest = { ...target, name: "Latest" };
		vi.mocked(api.listSessions).mockResolvedValueOnce({ sessions: [latest], nextAfterSessionId: null });

		const olderRename = workflow.renameSession(target, "Older");
		const latestRename = workflow.renameSession(target, "Latest");
		second.resolve({ session: latest });
		await latestRename;
		vi.mocked(api.listSessions).mockRejectedValue(new Error("refresh offline"));
		first.resolve({ session: { ...target, name: "Older" } });
		await olderRename;

		expect(store.getSnapshot().sessionsById.get(target.sessionId)?.name).toBe("Latest");
		expect(workflow.getSnapshot().failure).toBeNull();
		expect(api.listSessions).toHaveBeenCalledOnce();
	});

	it("uses a new rename request ID after a definitive server failure", async () => {
		const target = summary("rename-retry");
		const renamed = { ...target, name: "Recovered" };
		const { api, workflow } = harness([target]);
		vi.mocked(api.renameSession)
			.mockRejectedValueOnce(rpcFailure(RPC_ERROR_CODES.OPERATION_FAILED, "rename rejected"))
			.mockResolvedValue({ session: renamed });
		vi.mocked(api.listSessions).mockResolvedValue({ sessions: [renamed], nextAfterSessionId: null });

		await expect(workflow.renameSession(target, renamed.name)).rejects.toThrow("could not be renamed");
		const rejectedRequestId = vi.mocked(api.renameSession).mock.calls[0]![0].requestId;
		await workflow.renameSession(target, renamed.name);

		expect(vi.mocked(api.renameSession).mock.calls[1]![0].requestId).not.toBe(rejectedRequestId);
	});

	it("does not let an older rename refresh overwrite a newer completed rename", async () => {
		const target = summary("rename-refresh-target");
		const { api, store, workflow } = harness([target]);
		store.setSessions({ sessions: [target], nextAfterSessionId: null });
		const older = { ...target, name: "Older" };
		const latest = { ...target, name: "Latest" };
		vi.mocked(api.renameSession).mockResolvedValueOnce({ session: older }).mockResolvedValueOnce({ session: latest });
		const olderRefresh = deferred<{ sessions: SessionSummary[]; nextAfterSessionId: null }>();
		vi.mocked(api.listSessions)
			.mockReturnValueOnce(olderRefresh.promise)
			.mockResolvedValueOnce({ sessions: [latest], nextAfterSessionId: null });

		const olderRename = workflow.renameSession(target, "Older");
		await vi.waitFor(() => expect(api.listSessions).toHaveBeenCalledOnce());
		await workflow.renameSession(target, "Latest");
		olderRefresh.resolve({ sessions: [older], nextAfterSessionId: null });
		await olderRename;

		expect(store.getSnapshot().sessionsById.get(target.sessionId)?.name).toBe("Latest");
		expect(api.listSessions).toHaveBeenCalledTimes(2);
	});

	it("does not let one session's stale refresh overwrite another session's rename", async () => {
		const first = summary("rename-a");
		const second = summary("rename-b");
		const { api, store, workflow } = harness([first, second]);
		store.setSessions({ sessions: [first, second], nextAfterSessionId: null });
		const renamedFirst = { ...first, name: "First renamed" };
		const renamedSecond = { ...second, name: "Second renamed" };
		vi.mocked(api.renameSession)
			.mockResolvedValueOnce({ session: renamedFirst })
			.mockResolvedValueOnce({ session: renamedSecond });
		const staleRefresh = deferred<{ sessions: SessionSummary[]; nextAfterSessionId: null }>();
		vi.mocked(api.listSessions)
			.mockReturnValueOnce(staleRefresh.promise)
			.mockResolvedValueOnce({ sessions: [renamedFirst, renamedSecond], nextAfterSessionId: null });

		const firstRename = workflow.renameSession(first, renamedFirst.name);
		await vi.waitFor(() => expect(api.listSessions).toHaveBeenCalledOnce());
		await workflow.renameSession(second, renamedSecond.name);
		staleRefresh.resolve({ sessions: [renamedFirst, second], nextAfterSessionId: null });
		await firstRename;

		expect(store.getSnapshot().sessionsById.get(first.sessionId)?.name).toBe(renamedFirst.name);
		expect(store.getSnapshot().sessionsById.get(second.sessionId)?.name).toBe(renamedSecond.name);
		expect(api.listSessions).toHaveBeenCalledTimes(2);
	});

	it("retries the bootstrap catalog when an event invalidates its pending list", async () => {
		const first = summary("bootstrap-a");
		const second = summary("bootstrap-b");
		const updatedSecond = { ...second, name: "Updated during bootstrap" };
		const { api, emit, store, workflow } = harness([first, second]);
		const staleBootstrap = deferred<{ sessions: SessionSummary[]; nextAfterSessionId: null }>();
		vi.mocked(api.listSessions)
			.mockReturnValueOnce(staleBootstrap.promise)
			.mockResolvedValueOnce({ sessions: [first, updatedSecond], nextAfterSessionId: null });

		const starting = workflow.start();
		await vi.waitFor(() => expect(api.listSessions).toHaveBeenCalledOnce());
		emit({
			type: "app-server",
			envelope: {
				jsonrpc: "2.0",
				method: "connection/events",
				params: {
					serverEpoch: EPOCH,
					fromCursor: 1,
					toCursor: 1,
					events: [{ type: "session/updated", session: updatedSecond }],
				},
			},
		});
		staleBootstrap.resolve({ sessions: [first, second], nextAfterSessionId: null });
		await starting;

		expect(api.listSessions).toHaveBeenCalledTimes(2);
		expect([...store.getSnapshot().sessionsById.keys()]).toEqual([first.sessionId, second.sessionId]);
		expect(store.getSnapshot().sessionsById.get(second.sessionId)?.name).toBe(updatedSecond.name);
	});

	it("does not restart bootstrap catalog loading for non-catalog events", async () => {
		const target = summary("bootstrap-stable");
		const { api, emit, workflow } = harness([target]);
		const pendingBootstrap = deferred<{ sessions: SessionSummary[]; nextAfterSessionId: null }>();
		vi.mocked(api.listSessions).mockReturnValue(pendingBootstrap.promise);

		const starting = workflow.start();
		await vi.waitFor(() => expect(api.listSessions).toHaveBeenCalledOnce());
		emit({
			type: "app-server",
			envelope: {
				jsonrpc: "2.0",
				method: "connection/events",
				params: {
					serverEpoch: EPOCH,
					fromCursor: 1,
					toCursor: 1,
					events: [
						{
							type: "session/permissionPresetChanged",
							sessionId: target.sessionId,
							permissionPreset: "ask",
							effectiveSettings: { sandboxPolicy: "workspace-write", approvalPolicy: "user" },
							constrainedByParent: false,
							sandboxHealth: "healthy",
						},
					],
				},
			},
		});
		pendingBootstrap.resolve({ sessions: [target], nextAfterSessionId: null });
		await starting;

		expect(api.listSessions).toHaveBeenCalledOnce();
		expect(workflow.getSnapshot().bootstrapped).toBe(true);
	});

	it("does not let a mutation refresh overwrite a session snapshot that completed later", async () => {
		const first = summary("open-race-a");
		const second = summary("open-race-b");
		const renamedFirst = { ...first, name: "Renamed" };
		const openedSecond = { ...snapshot(second.sessionId), session: { ...second, name: "Opened latest" } };
		const { api, store, workflow } = harness([first, second]);
		store.setSessions({ sessions: [first, second], nextAfterSessionId: null });
		const pendingOpen = deferred<SessionSnapshot>();
		const staleRefresh = deferred<{ sessions: SessionSummary[]; nextAfterSessionId: null }>();
		vi.mocked(api.openSession).mockReturnValue(pendingOpen.promise);
		vi.mocked(api.renameSession).mockResolvedValue({ session: renamedFirst });
		vi.mocked(api.listSessions).mockReturnValue(staleRefresh.promise);

		const opening = workflow.openSession(second.sessionId);
		const renaming = workflow.renameSession(first, renamedFirst.name);
		await vi.waitFor(() => expect(api.listSessions).toHaveBeenCalledOnce());
		pendingOpen.resolve(openedSecond);
		await opening;
		staleRefresh.resolve({ sessions: [renamedFirst, second], nextAfterSessionId: null });
		await renaming;

		expect(store.getSnapshot().sessionsById.get(first.sessionId)?.name).toBe(renamedFirst.name);
		expect(store.getSnapshot().sessionsById.get(second.sessionId)?.name).toBe(openedSecond.session.name);
	});

	it("restores the previous projection after the current open fails", async () => {
		const { api, store, workflow } = harness();
		store.applySnapshot(snapshot("existing"));
		vi.mocked(api.openSession).mockRejectedValueOnce(new Error("open failed"));

		await expect(workflow.openSession("missing")).rejects.toThrow("open failed");

		expect(store.getSnapshot().activeSessionId).toBe("existing");
		expect(store.getSnapshot().syncStatus).toBe("ready");
	});

	it("restores the remembered Chat session during bootstrap", async () => {
		const remembered = summary("remembered");
		const { api, store, workflow } = harness([remembered]);
		localStorage.setItem("metis.activeSessionId.chat", remembered.sessionId);
		vi.mocked(api.openSession).mockResolvedValue(snapshot(remembered.sessionId));

		await workflow.start();

		expect(store.getSnapshot().activeSessionId).toBe(remembered.sessionId);
		expect(workflow.getSnapshot().draft).toBeNull();
		expect(workflow.getSnapshot().bootstrapped).toBe(true);
	});

	it("deduplicates mark-read while a request is pending", async () => {
		const unread = summary("unread", "chat", true);
		const { api, workflow } = harness([unread]);
		const pending = deferred<{ session: SessionSummary }>();
		vi.mocked(api.openSession).mockResolvedValue(snapshot(unread.sessionId, "chat", true));
		vi.mocked(api.markSessionRead).mockReturnValue(pending.promise);

		const opening = workflow.openSession(unread.sessionId);
		await Promise.resolve();
		const visible = workflow.openVisibleSession(unread.sessionId);
		pending.resolve({ session: { ...unread, unread: false } });
		await Promise.all([opening, visible]);

		expect(api.markSessionRead).toHaveBeenCalledTimes(1);
	});

	it("resnapshots the active session when a ready supervisor has a new epoch", async () => {
		const { api, emit, store, workflow } = harness();
		store.applySnapshot(snapshot("active"));
		await workflow.start();
		vi.mocked(api.openSession).mockResolvedValue({
			...snapshot("active"),
			serverEpoch: "22222222-2222-4222-8222-222222222222",
		});

		emit({
			type: "supervisor",
			view: {
				state: "ready",
				serverEpoch: "22222222-2222-4222-8222-222222222222",
				restartAttempt: 0,
				failure: null,
			},
		});
		await Promise.resolve();
		await Promise.resolve();

		expect(api.openSession).toHaveBeenCalledWith({ sessionId: "active" });
	});

	it("notifies desktop observers after applying the latest supervisor state", async () => {
		let store: AppStore;
		let observedEpoch: string | null | undefined;
		const next = harness([], (event) => {
			if (event.type === "supervisor") observedEpoch = store.getSnapshot().supervisor.serverEpoch;
		});
		store = next.store;
		await next.workflow.start();

		next.emit({
			type: "supervisor",
			view: {
				state: "ready",
				serverEpoch: "22222222-2222-4222-8222-222222222222",
				restartAttempt: 0,
				failure: null,
			},
		});

		expect(observedEpoch).toBe("22222222-2222-4222-8222-222222222222");
	});

	it("turns an active remote deletion into a fresh draft and cleanup request", async () => {
		const current = summary("deleted");
		const { emit, store, workflow } = harness([current]);
		store.setSessions({ sessions: [current], nextAfterSessionId: null });
		store.applySnapshot(snapshot(current.sessionId));
		await workflow.start();

		emit({
			type: "app-server",
			envelope: {
				jsonrpc: "2.0",
				method: "connection/events",
				params: {
					serverEpoch: EPOCH,
					fromCursor: 1,
					toCursor: 1,
					events: [{ type: "session/invalidated", sessionId: current.sessionId, reason: "deleted" }],
				},
			},
		});

		expect(workflow.getSnapshot().draft?.mode).toBe("chat");
		expect(workflow.getSnapshot().cleanupSessionIds).toEqual([current.sessionId]);
	});

	it("ignores late results after disposal", async () => {
		const { api, store, workflow } = harness();
		const pending = deferred<SessionSnapshot>();
		vi.mocked(api.openSession).mockReturnValue(pending.promise);
		const opening = workflow.openSession("late");

		workflow.dispose();
		pending.resolve(snapshot("late"));
		await opening;

		expect(store.getSnapshot().activeSessionId).toBeNull();
	});

	it("does not continue a new-task pipeline after disposal", async () => {
		const { api, workflow } = harness();
		const pending = deferred<{ session: SessionSummary }>();
		vi.mocked(api.createSession).mockReturnValue(pending.promise);
		workflow.startNewTask("chat");
		const submission = workflow.submitNewTask({ text: "late", attachments: [] });

		workflow.dispose();
		pending.resolve({ session: summary("late-created") });
		await submission;

		expect(api.openSession).not.toHaveBeenCalled();
		expect(api.startTurn).not.toHaveBeenCalled();
	});

	it("does not let an old project create failure pollute a restarted workflow", async () => {
		const { api, workflow } = harness();
		const pending = deferred<{ session: SessionSummary }>();
		vi.mocked(api.createSession).mockReturnValue(pending.promise);
		const creating = workflow.createSessionInProject("code", "/work/old-lifecycle");
		await vi.waitFor(() => expect(api.createSession).toHaveBeenCalledOnce());

		workflow.dispose();
		await workflow.start();
		pending.reject(new Error("old lifecycle failed"));
		await expect(creating).rejects.toThrow("old lifecycle failed");

		expect(workflow.getSnapshot().failure).toBeNull();
		expect(workflow.getSnapshot().busyProjectKeys.size).toBe(0);
	});

	it("does not start a stale new-task turn after the draft is cancelled", async () => {
		const { api, store, workflow } = harness();
		const created = summary("cancelled-created");
		const opening = deferred<SessionSnapshot>();
		vi.mocked(api.createSession).mockResolvedValue({ session: created });
		vi.mocked(api.openSession).mockReturnValue(opening.promise);
		workflow.startNewTask("chat");

		const submission = workflow.submitNewTask({ text: "do not send", attachments: [] });
		await vi.waitFor(() => expect(api.openSession).toHaveBeenCalledOnce());
		workflow.cancelNewTask();
		opening.resolve(snapshot(created.sessionId));
		await submission;

		expect(api.startTurn).not.toHaveBeenCalled();
		expect(workflow.getSnapshot().draft).toBeNull();
		expect(store.getSnapshot().activeSessionId).toBeNull();
	});

	it("reuses create and turn request IDs until each operation succeeds", async () => {
		const { api, workflow } = harness();
		const created = summary("created");
		vi.mocked(api.createSession)
			.mockRejectedValueOnce(new Error("create response lost"))
			.mockResolvedValue({ session: created });
		vi.mocked(api.openSession).mockResolvedValue(snapshot(created.sessionId));
		workflow.startNewTask("chat");

		await expect(workflow.submitNewTask({ text: "hello", attachments: [] })).rejects.toThrow("create response lost");
		const firstCreateId = vi.mocked(api.createSession).mock.calls[0]![0].requestId;
		vi.mocked(api.startTurn).mockRejectedValueOnce(new Error("turn response lost"));
		await expect(workflow.submitNewTask({ text: "hello", attachments: [] })).rejects.toThrow("turn response lost");
		expect(vi.mocked(api.createSession).mock.calls[1]![0].requestId).toBe(firstCreateId);
		const firstTurnId = vi.mocked(api.startTurn).mock.calls[0]![0].requestId;

		await workflow.submitNewTask({ text: "hello", attachments: [] });

		expect(api.createSession).toHaveBeenCalledTimes(2);
		expect(vi.mocked(api.startTurn).mock.calls[1]![0].requestId).toBe(firstTurnId);
		expect(workflow.getSnapshot().draft).toBeNull();
	});

	it("uses a new turn request ID after a definitive server failure", async () => {
		const { api, workflow } = harness();
		const created = summary("turn-retry");
		vi.mocked(api.createSession).mockResolvedValue({ session: created });
		vi.mocked(api.openSession).mockResolvedValue(snapshot(created.sessionId));
		vi.mocked(api.startTurn)
			.mockRejectedValueOnce(rpcFailure(RPC_ERROR_CODES.OPERATION_FAILED, "turn rejected"))
			.mockResolvedValue({ operationId: "turn-retry-operation", status: "accepted" });
		workflow.startNewTask("chat");

		await expect(workflow.submitNewTask({ text: "retry me", attachments: [] })).rejects.toThrow("turn rejected");
		const rejectedRequestId = vi.mocked(api.startTurn).mock.calls[0]![0].requestId;
		await workflow.submitNewTask({ text: "retry me", attachments: [] });

		expect(vi.mocked(api.startTurn).mock.calls[1]![0].requestId).not.toBe(rejectedRequestId);
	});

	it("requires a folder for Code drafts and locks the draft after create", async () => {
		const { api, workflow } = harness();
		const created = summary("code-created", "code");
		const opening = deferred<SessionSnapshot>();
		vi.mocked(api.createSession).mockResolvedValue({ session: created });
		vi.mocked(api.openSession).mockReturnValue(opening.promise);
		workflow.startNewTask("code");

		await workflow.submitNewTask({ text: "build", attachments: [] });
		expect(api.createSession).not.toHaveBeenCalled();
		workflow.setDraftFolder("/work/project");
		const submission = workflow.submitNewTask({ text: "build", attachments: [] });
		await Promise.resolve();
		expect(workflow.getSnapshot().draft?.sessionId).toBe(created.sessionId);
		workflow.setDraftFolder("/work/other");
		expect(workflow.getSnapshot().draft?.folder).toBe("/work/project");
		opening.resolve(snapshot(created.sessionId, "code"));
		await submission;
	});

	it("prepares an empty draft for knowledge linking and reuses it for the first user turn", async () => {
		const { api, workflow } = harness();
		const created = summary("knowledge-draft");
		vi.mocked(api.createSession).mockResolvedValue({ session: created });
		vi.mocked(api.openSession).mockResolvedValue(snapshot(created.sessionId));
		workflow.startNewTask("chat");
		expect(await workflow.prepareNewTask()).toBe(created.sessionId);
		expect(workflow.getSnapshot().draft?.sessionId).toBe(created.sessionId);
		expect(api.startTurn).not.toHaveBeenCalled();
		await workflow.submitNewTask({ text: "Store this in my linked library", attachments: [] });
		expect(api.createSession).toHaveBeenCalledOnce();
		expect(api.startTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: created.sessionId }));
		expect(workflow.getSnapshot().draft).toBeNull();
	});
	it("does not open a prepared draft if the user navigates away during creation", async () => {
		const { api, workflow } = harness();
		const pending = deferred<{ session: SessionSummary }>();
		vi.mocked(api.createSession).mockReturnValue(pending.promise);
		workflow.startNewTask("chat");
		const preparation = workflow.prepareNewTask();
		workflow.cancelNewTask();
		pending.resolve({ session: summary("late-knowledge-draft") });
		expect(await preparation).toBeNull();
		expect(api.openSession).not.toHaveBeenCalled();
		expect(api.startTurn).not.toHaveBeenCalled();
	});
	it("applies editor settings to the prepared knowledge session without creating another conversation", async () => {
		const { api, workflow } = harness();
		Object.assign(api, {
			setModel: vi.fn().mockResolvedValue({}),
			setThinkingSelection: vi.fn().mockResolvedValue({}),
		});
		const created = summary("editor-knowledge", "code");
		vi.mocked(api.createSession).mockResolvedValue({ session: created });
		vi.mocked(api.openSession).mockResolvedValue(snapshot(created.sessionId, "code"));
		workflow.startNewTask("code");
		workflow.setDraftFolder("/project");
		expect(await workflow.prepareNewTask()).toBe(created.sessionId);
		expect(api.startTurn).not.toHaveBeenCalled();
		await workflow.submitNewTask({ text: "Use the linked knowledge", attachments: [] }, undefined, {
			model: { provider: "example", modelId: "editor-model" },
			thinkingSelection: "high",
		});
		expect(api.createSession).toHaveBeenCalledOnce();
		expect(api.setModel).toHaveBeenCalledWith(expect.objectContaining({ sessionId: created.sessionId }));
		expect(api.setThinkingSelection).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: created.sessionId, selection: "high" }),
		);
		expect(api.startTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: created.sessionId }));
	});
	it("deduplicates an in-flight empty project session create", async () => {
		const { api, workflow } = harness();
		const created = summary("project-created", "code");
		const pending = deferred<{ session: SessionSummary }>();
		vi.mocked(api.createSession).mockReturnValue(pending.promise);
		vi.mocked(api.openSession).mockResolvedValue(snapshot(created.sessionId, "code"));

		const first = workflow.createSessionInProject("code", "/work/project");
		const second = workflow.createSessionInProject("code", "/work/project");
		pending.resolve({ session: created });
		await Promise.all([first, second]);

		expect(api.createSession).toHaveBeenCalledTimes(1);
	});

	it("uses a new project create request ID after a definitive server failure", async () => {
		const { api, workflow } = harness();
		const created = summary("project-retry", "code");
		vi.mocked(api.createSession)
			.mockRejectedValueOnce(rpcFailure(RPC_ERROR_CODES.OPERATION_FAILED, "create rejected"))
			.mockResolvedValue({ session: created });
		vi.mocked(api.openSession).mockResolvedValue(snapshot(created.sessionId, "code"));

		await expect(workflow.createSessionInProject("code", "/work/retry")).rejects.toThrow("create rejected");
		const rejectedRequestId = vi.mocked(api.createSession).mock.calls[0]![0].requestId;
		await workflow.createSessionInProject("code", "/work/retry");

		expect(vi.mocked(api.createSession).mock.calls[1]![0].requestId).not.toBe(rejectedRequestId);
	});

	it("reuses a completed project create request when opening the session fails", async () => {
		const { api, workflow } = harness();
		const created = summary("project-open-retry", "code");
		vi.mocked(api.createSession).mockResolvedValue({ session: created });
		vi.mocked(api.openSession)
			.mockRejectedValueOnce(rpcFailure(RPC_ERROR_CODES.OPERATION_FAILED, "open rejected"))
			.mockResolvedValue(snapshot(created.sessionId, "code"));

		await expect(workflow.createSessionInProject("code", "/work/open-retry")).rejects.toThrow("open rejected");
		const completedCreateRequestId = vi.mocked(api.createSession).mock.calls[0]![0].requestId;
		await workflow.createSessionInProject("code", "/work/open-retry");

		expect(vi.mocked(api.createSession).mock.calls[1]![0].requestId).toBe(completedCreateRequestId);
	});

	it("blocks deleting dirty sessions and queues cleanup after a successful delete", async () => {
		const target = summary("target");
		const { api, workflow } = harness([target]);
		vi.mocked(api.deleteSession).mockResolvedValue({
			sessionId: target.sessionId,
			deleted: true,
			method: "trash",
		});
		workflow.reportDirtySessionIds([target.sessionId]);

		await expect(workflow.deleteSession(target)).rejects.toThrow("Save or close unsaved files");
		expect(api.deleteSession).not.toHaveBeenCalled();
		workflow.reportDirtySessionIds([]);
		await workflow.deleteSession(target);

		expect(workflow.getSnapshot().cleanupSessionIds).toEqual([target.sessionId]);
		workflow.acknowledgeCleanup([target.sessionId]);
		expect(workflow.getSnapshot().cleanupSessionIds).toEqual([]);
	});

	it("reuses a session delete request ID after a lost response and opens a draft for the active session", async () => {
		const target = summary("active-delete");
		const { api, workflow } = harness([target]);
		vi.mocked(api.openSession).mockResolvedValue(snapshot(target.sessionId));
		await workflow.openVisibleSession(target.sessionId);
		expect(workflow.getSnapshot().draft).toBeNull();
		vi.mocked(api.deleteSession)
			.mockRejectedValueOnce(new Error("delete response lost"))
			.mockResolvedValue({ sessionId: target.sessionId, deleted: true, method: "trash" });

		await expect(workflow.deleteSession(target)).rejects.toThrow("delete response lost");
		const requestId = vi.mocked(api.deleteSession).mock.calls[0]![0].requestId;
		await workflow.deleteSession(target);

		expect(vi.mocked(api.deleteSession).mock.calls[1]![0].requestId).toBe(requestId);
		expect(workflow.getSnapshot().draft?.mode).toBe("chat");
	});

	it("keeps a cleanup warning when deleting the active session opens a fresh draft", async () => {
		const target = summary("active-delete-warning");
		const { api, workflow } = harness([target]);
		vi.mocked(api.openSession).mockResolvedValue(snapshot(target.sessionId));
		await workflow.openVisibleSession(target.sessionId);
		vi.mocked(api.deleteSession).mockResolvedValue({
			sessionId: target.sessionId,
			deleted: true,
			method: "trash",
			warning: "The session was deleted, but one attachment could not be moved to Trash.",
		});

		await workflow.deleteSession(target);

		expect(workflow.getSnapshot().draft?.mode).toBe("chat");
		expect(workflow.getSnapshot().failure).toMatchObject({
			operation: "delete-session-warning",
			reason: "The session was deleted, but one attachment could not be moved to Trash.",
			retryable: false,
		});
	});

	it("uses a new session delete request ID after a definitive server failure", async () => {
		const target = summary("delete-retry");
		const { api, workflow } = harness([target]);
		vi.mocked(api.deleteSession)
			.mockRejectedValueOnce(rpcFailure(RPC_ERROR_CODES.SESSION_IN_USE, "session in use"))
			.mockResolvedValue({ sessionId: target.sessionId, deleted: true, method: "trash" });

		await expect(workflow.deleteSession(target)).rejects.toThrow("still running");
		const rejectedRequestId = vi.mocked(api.deleteSession).mock.calls[0]![0].requestId;
		await workflow.deleteSession(target);

		expect(vi.mocked(api.deleteSession).mock.calls[1]![0].requestId).not.toBe(rejectedRequestId);
	});

	it("does not let a late active-session delete replace a newer selection with a draft", async () => {
		const target = summary("delete-target");
		const selected = summary("selected");
		const { api, store, workflow } = harness([target, selected]);
		const deletion = deferred<{ sessionId: string; deleted: true; method: "trash" }>();
		store.setSessions({ sessions: [target, selected], nextAfterSessionId: null });
		store.applySnapshot(snapshot(target.sessionId));
		vi.mocked(api.deleteSession).mockReturnValue(deletion.promise);
		vi.mocked(api.openSession).mockResolvedValue(snapshot(selected.sessionId));

		const deleting = workflow.deleteSession(target);
		await vi.waitFor(() => expect(api.deleteSession).toHaveBeenCalledOnce());
		await workflow.openVisibleSession(selected.sessionId);
		deletion.resolve({ sessionId: target.sessionId, deleted: true, method: "trash" });
		await deleting;

		expect(store.getSnapshot().activeSessionId).toBe(selected.sessionId);
		expect(workflow.getSnapshot().draft).toBeNull();
	});

	it("does not let failed delete recovery supersede a visible session open", async () => {
		const target = summary("failed-delete-target");
		const selected = summary("failed-delete-selection");
		const { api, store, workflow } = harness([target, selected]);
		store.setSessions({ sessions: [target, selected], nextAfterSessionId: null });
		store.applySnapshot(snapshot(target.sessionId));
		const deletion = deferred<{ sessionId: string; deleted: true; method: "trash" }>();
		const opening = deferred<SessionSnapshot>();
		vi.mocked(api.deleteSession).mockReturnValue(deletion.promise);
		vi.mocked(api.openSession).mockReturnValue(opening.promise);

		const deleting = workflow.deleteSession(target);
		const selecting = workflow.openVisibleSession(selected.sessionId);
		deletion.reject({ code: RPC_ERROR_CODES.OPERATION_FAILED });
		await expect(deleting).rejects.toThrow("could not be moved to Trash");
		expect(api.openSession).toHaveBeenCalledOnce();
		expect(api.openSession).toHaveBeenCalledWith({ sessionId: selected.sessionId });
		opening.resolve(snapshot(selected.sessionId));
		await selecting;
		expect(store.getSnapshot().activeSessionId).toBe(selected.sessionId);
	});

	it("opens a fresh draft when the deleted session becomes active before completion", async () => {
		const first = summary("delete-background-first");
		const target = summary("delete-background-target");
		const { api, workflow } = harness([first, target]);
		const deletion = deferred<{ sessionId: string; deleted: true; method: "trash" }>();
		vi.mocked(api.openSession).mockImplementation(async ({ sessionId }) => snapshot(sessionId));
		vi.mocked(api.deleteSession).mockReturnValue(deletion.promise);
		await workflow.openVisibleSession(first.sessionId);

		const deleting = workflow.deleteSession(target);
		await vi.waitFor(() => expect(api.deleteSession).toHaveBeenCalledOnce());
		await workflow.openVisibleSession(target.sessionId);
		deletion.resolve({ sessionId: target.sessionId, deleted: true, method: "trash" });
		await deleting;

		expect(workflow.getSnapshot().draft?.mode).toBe("chat");
	});

	it("opens a fresh draft when a pending deletion target becomes active again", async () => {
		const target = summary("delete-return-target");
		const other = summary("delete-return-other");
		const { api, workflow } = harness([target, other]);
		const deletion = deferred<{ sessionId: string; deleted: true; method: "trash" }>();
		vi.mocked(api.openSession).mockImplementation(async ({ sessionId }) => snapshot(sessionId));
		vi.mocked(api.deleteSession).mockReturnValue(deletion.promise);
		await workflow.openVisibleSession(target.sessionId);

		const deleting = workflow.deleteSession(target);
		await vi.waitFor(() => expect(api.deleteSession).toHaveBeenCalledOnce());
		await workflow.openVisibleSession(other.sessionId);
		await workflow.openVisibleSession(target.sessionId);
		deletion.resolve({ sessionId: target.sessionId, deleted: true, method: "trash" });
		await deleting;

		expect(workflow.getSnapshot().draft?.mode).toBe("chat");
	});

	it("does not let a late fork open over a newer selection", async () => {
		const source = summary("fork-source");
		const selected = summary("fork-selected");
		const forked = summary("fork-result");
		const { api, store, workflow } = harness([source, selected]);
		const fork = deferred<{ session: SessionSummary; entryId: string }>();
		store.setSessions({ sessions: [source, selected], nextAfterSessionId: null });
		store.applySnapshot(snapshot(source.sessionId));
		vi.mocked(api.forkSession).mockReturnValue(fork.promise);
		vi.mocked(api.openSession).mockResolvedValue(snapshot(selected.sessionId));

		const forking = workflow.forkSession("entry-1");
		await vi.waitFor(() => expect(api.forkSession).toHaveBeenCalledOnce());
		await workflow.openVisibleSession(selected.sessionId);
		fork.resolve({ session: forked, entryId: "entry-1" });
		await expect(forking).resolves.toEqual(forked);

		expect(store.getSnapshot().activeSessionId).toBe(selected.sessionId);
		expect(api.openSession).toHaveBeenCalledTimes(1);
	});

	it("reuses a fork request ID after a lost response", async () => {
		const source = summary("fork-retry-source");
		const forked = summary("fork-retry-result");
		const { api, store, workflow } = harness([source]);
		store.setSessions({ sessions: [source], nextAfterSessionId: null });
		store.applySnapshot(snapshot(source.sessionId));
		vi.mocked(api.forkSession)
			.mockRejectedValueOnce(new Error("fork response lost"))
			.mockResolvedValue({ session: forked, entryId: "entry-retry" });
		vi.mocked(api.openSession).mockResolvedValue(snapshot(forked.sessionId));

		await expect(workflow.forkSession("entry-retry")).rejects.toThrow("fork response lost");
		const requestId = vi.mocked(api.forkSession).mock.calls[0]![0].requestId;
		await workflow.forkSession("entry-retry");

		expect(vi.mocked(api.forkSession).mock.calls[1]![0].requestId).toBe(requestId);
	});

	it("reuses a project delete request ID for the same preview revision", async () => {
		const target = summary("project", "code");
		const { api, workflow } = harness([target]);
		const preview = {
			mode: "code" as const,
			cwd: target.cwd!,
			sessionCount: 1,
			blockingScheduleCount: 0,
			revision: "a".repeat(64),
		};
		vi.mocked(api.deleteProject)
			.mockRejectedValueOnce(new Error("response lost"))
			.mockResolvedValue({
				ok: true,
				result: { mode: "code", cwd: target.cwd!, deletedSessionCount: 1 },
			});

		await expect(workflow.deleteProject({ mode: "code", cwd: target.cwd! }, preview)).rejects.toThrow(
			"response lost",
		);
		const requestId = vi.mocked(api.deleteProject).mock.calls[0]![0].requestId;
		await workflow.deleteProject({ mode: "code", cwd: target.cwd! }, preview);

		expect(vi.mocked(api.deleteProject).mock.calls[1]![0].requestId).toBe(requestId);
	});

	it("keeps project preview failures local to the dialog that owns the request", async () => {
		const { api, workflow } = harness();
		const stale = deferred<Awaited<ReturnType<MetisDesktopApi["previewProjectDelete"]>>>();
		vi.mocked(api.previewProjectDelete)
			.mockReturnValueOnce(stale.promise)
			.mockResolvedValueOnce({
				ok: true,
				result: {
					mode: "chat",
					cwd: "/work/b",
					sessionCount: 1,
					blockingScheduleCount: 0,
					revision: "b".repeat(64),
				},
			});

		const first = workflow.previewProjectDelete({ mode: "chat", cwd: "/work/a" });
		await workflow.previewProjectDelete({ mode: "chat", cwd: "/work/b" });
		stale.resolve({
			ok: false,
			error: rpcFailure(RPC_ERROR_CODES.OPERATION_FAILED, "stale A preview failed"),
		});

		await expect(first).rejects.toThrow("could not be moved to Trash");
		expect(workflow.getSnapshot().failure).toBeNull();
	});

	it("uses a new project delete request ID after a definitive server failure", async () => {
		const target = summary("project-delete-retry", "code");
		const { api, workflow } = harness([target]);
		const preview = {
			mode: "code" as const,
			cwd: target.cwd!,
			sessionCount: 1,
			blockingScheduleCount: 0,
			revision: "b".repeat(64),
		};
		vi.mocked(api.deleteProject)
			.mockRejectedValueOnce(rpcFailure(RPC_ERROR_CODES.SESSION_IN_USE, "project in use"))
			.mockResolvedValue({
				ok: true,
				result: { mode: "code", cwd: target.cwd!, deletedSessionCount: 1 },
			});

		await expect(workflow.deleteProject({ mode: "code", cwd: target.cwd! }, preview)).rejects.toThrow("still in use");
		const rejectedRequestId = vi.mocked(api.deleteProject).mock.calls[0]![0].requestId;
		await workflow.deleteProject({ mode: "code", cwd: target.cwd! }, preview);

		expect(vi.mocked(api.deleteProject).mock.calls[1]![0].requestId).not.toBe(rejectedRequestId);
	});

	it("persists project and session pins through the workflow snapshot", () => {
		const target = summary("pinned", "code");
		const { workflow } = harness([target]);

		workflow.renameProject({ mode: "code", cwd: target.cwd! }, "Workbench");
		workflow.pinProject({ mode: "code", cwd: target.cwd! }, true);
		workflow.pinSession(target, true);

		expect([...workflow.getSnapshot().projectPreferences.values()]).toEqual([
			{ mode: "code", cwd: target.cwd, alias: "Workbench", pinned: true },
		]);
		expect(workflow.getSnapshot().pinnedSessionIds.has(target.sessionId)).toBe(true);
		expect(localStorage.getItem("metis.sessionPins.v1")).toContain(target.sessionId);
	});
});
