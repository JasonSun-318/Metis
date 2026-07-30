// @vitest-environment jsdom

import type { ClientResult, SessionSnapshot, SessionSummary } from "@arcmind/app-protocol";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	App,
	firstInteractionForSession,
	sessionDisplayTitle,
	titleFromPrompt,
} from "../src/renderer/components/App.tsx";
import { buildSessionTree } from "../src/renderer/components/SessionSidebar.tsx";
import { SkillsPanel } from "../src/renderer/components/SkillsPanel.tsx";
import { AppStore } from "../src/renderer/store/app-store.ts";
import {
	loadProjectPreferences,
	removeProjectPreference,
	saveProjectPreferences,
	setProjectAlias,
	setProjectPinned,
} from "../src/renderer/store/project-preferences.ts";
import type { ArcMindDesktopApi } from "../src/shared/desktop-api.ts";

const EPOCH = "11111111-1111-4111-8111-111111111111";

function session(sessionId: string, mode: "chat" | "code", cwd: string, name?: string): SessionSummary {
	return {
		sessionId,
		mode,
		cwdOrigin: "user-selected",
		cwd,
		...(name ? { name } : {}),
		createdAt: "2026-07-20T00:00:00.000Z",
		updatedAt: "2026-07-20T00:00:00.000Z",
		state: "idle",
		archived: false,
	};
}

function snapshot(summary: SessionSummary): SessionSnapshot {
	return {
		session: summary,
		permissionMode: "ask",
		model: { provider: "test-provider", modelId: "test-model" },
		availableModels: [
			{ provider: "test-provider", modelId: "test-model", name: "Test model" },
			{ provider: "test-provider", modelId: "other-model", name: "Other model" },
		],
		turns: [],
		recentItems: [],
		nextBeforeItemId: null,
		activeTurnId: null,
		pendingInteractions: [],
		thinkingSelection: "off",
		actualThinkingLevel: "off",
		availableThinkingSelections: ["off"],
		subagents: [],
		serverEpoch: EPOCH,
		cursor: 0,
	};
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll("button")].find((candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label);
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

function menuOption(container: HTMLElement, label: string): HTMLButtonElement {
	const match = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')].find((candidate) =>
		candidate.textContent?.includes(label),
	);
	if (!match) throw new Error(`Missing menu option: ${label}`);
	return match;
}

function projectRow(container: ParentNode, cwd: string): HTMLElement {
	const heading = container.querySelector<HTMLElement>(`.project-heading[title="${cwd}"]`);
	const row = heading?.closest<HTMLElement>(".project-group");
	if (!row) throw new Error(`Missing project row: ${cwd}`);
	return row;
}

async function flush() {
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 0));
	});
}

function changeTextarea(textarea: HTMLTextAreaElement, value: string) {
	Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, value);
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function changeInput(input: HTMLInputElement, value: string) {
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function createHarness(options: {
	failFirstOpen?: boolean;
	failOpenSessionIds?: readonly string[];
	loseFirstCreateResponse?: boolean;
	loseFirstStartResponse?: boolean;
	sessions?: readonly SessionSummary[];
} = {}) {
	const chat = session("chat-existing", "chat", "/work/chat-project", "Chat project task");
	const code = session("code-existing", "code", "/work/code-project", "Code project task");
	let sessions = options.sessions ? [...options.sessions] : [chat, code];
	let failFirstOpen = options.failFirstOpen ?? false;
	let loseFirstCreateResponse = options.loseFirstCreateResponse ?? false;
	let loseFirstStartResponse = options.loseFirstStartResponse ?? false;
	const failOpenSessionIds = new Set(options.failOpenSessionIds ?? []);
	const createdByRequestId = new Map<string, SessionSummary>();
	const order: string[] = [];
	let subscriber: Parameters<ArcMindDesktopApi["subscribe"]>[0] | undefined;
	const api = {
		getServerState: vi.fn().mockResolvedValue({ state: "ready", serverEpoch: EPOCH, restartAttempt: 0, failure: null }),
		listSessions: vi.fn(async () => {
			order.push("list");
			return { sessions, nextAfterSessionId: null };
		}),
		listSkills: vi.fn().mockResolvedValue({
			skills: [
				{ name: "pdf", description: "Read and create PDF documents", source: "system" },
				{ name: "xlsx", description: "Read and create spreadsheets", source: "user" },
				{ name: "project-helper", description: "Inspect this project", source: "project" },
			],
		}),
		previewProjectDelete: vi.fn(async (input) => ({
			ok: true as const,
			result: {
				mode: input.mode,
				cwd: input.cwd,
				sessionCount: sessions.filter(
					(candidate) => candidate.mode === input.mode && candidate.cwd === input.cwd && !candidate.scheduled,
				).length,
				blockingScheduleCount: 0,
				revision: "a".repeat(64),
			},
		})),
		deleteProject: vi.fn(async (input) => {
			const before = sessions.length;
			sessions = sessions.filter(
				(candidate) => candidate.mode !== input.mode || candidate.cwd !== input.cwd || candidate.scheduled !== undefined,
			);
			return {
				ok: true as const,
				result: { mode: input.mode, cwd: input.cwd, deletedSessionCount: before - sessions.length },
			};
		}),
		selectProjectFolder: vi.fn().mockResolvedValue("/work/selected-project"),
		selectAttachmentFiles: vi.fn().mockResolvedValue([
			{ path: "/tmp/report.pdf", name: "report.pdf" },
		]),
		resolveDroppedFiles: vi.fn().mockReturnValue([]),
		getDefaultProjectLocation: vi.fn().mockResolvedValue("/Users/test/ArcMind Projects"),
		createProjectFolder: vi.fn(async ({ parentDirectory, name }) => `${parentDirectory}/${name}`),
		createSession: vi.fn(async (input) => {
			order.push("create");
			const createdMode = input.mode ?? "code";
			const created = createdByRequestId.get(input.requestId) ?? {
				...session(
					createdMode === "chat" ? "chat-created" : "code-created",
					createdMode,
					input.cwd ?? `/managed/${createdMode}-created`,
					input.name,
				),
				cwdOrigin: input.cwd ? "user-selected" : "managed",
			};
			if (!createdByRequestId.has(input.requestId)) {
				createdByRequestId.set(input.requestId, created);
				sessions = [created, ...sessions];
			}
			if (loseFirstCreateResponse) {
				loseFirstCreateResponse = false;
				throw new Error("create response lost");
			}
			return { session: created };
		}),
		renameSession: vi.fn(async ({ sessionId, name }) => {
			order.push("rename");
			const current = sessions.find((candidate) => candidate.sessionId === sessionId);
			if (!current) throw new Error("missing session");
			const renamed = { ...current, name };
			sessions = sessions.map((candidate) => candidate.sessionId === sessionId ? renamed : candidate);
			return { session: renamed };
		}),
		deleteSession: vi.fn(async ({ sessionId }) => {
			sessions = sessions.filter((candidate) => candidate.sessionId !== sessionId);
			return { sessionId, deleted: true as const, method: "trash" as const };
		}),
		openSession: vi.fn(async ({ sessionId }) => {
			order.push("open");
			if (failFirstOpen || failOpenSessionIds.delete(sessionId)) {
				failFirstOpen = false;
				throw new Error("open failed once");
			}
			const summary = sessions.find((candidate) => candidate.sessionId === sessionId);
			if (!summary) throw new Error("missing session");
			return snapshot(summary);
		}),
		startTurn: vi.fn(async () => {
			order.push("start");
			if (loseFirstStartResponse) {
				loseFirstStartResponse = false;
				throw new Error("start response lost");
			}
			return {};
		}),
		steerTurn: vi.fn().mockResolvedValue({}),
		interruptTurn: vi.fn().mockResolvedValue({}),
		readItems: vi.fn().mockResolvedValue({ items: [], nextBeforeItemId: null }),
		readSubagentItems: vi.fn().mockResolvedValue({ items: [], nextBeforeItemId: null }),
		setThinkingSelection: vi.fn().mockResolvedValue({}),
		setPermissionMode: vi.fn(async ({ permissionMode }) => ({ permissionMode })),
		setModel: vi.fn().mockResolvedValue({}),
		respondToInteraction: vi.fn().mockResolvedValue(undefined),
		retryServer: vi.fn().mockResolvedValue(undefined),
		subscribe: vi.fn((listener) => {
			subscriber = listener;
			return () => {
				if (subscriber === listener) subscriber = undefined;
			};
		}),
	} as unknown as ArcMindDesktopApi;
	return { api, emitEvent: (event: Parameters<NonNullable<typeof subscriber>>[0]) => subscriber?.(event), order };
}

afterEach(() => {
	vi.restoreAllMocks();
	localStorage.clear();
	document.body.replaceChildren();
});

describe("Chat desktop shell", () => {
	it("round-trips strict mode-scoped project preferences without splitting Unicode aliases", () => {
		let preferences = setProjectAlias(new Map(), "chat", "/work/shared", `  ${"🚀".repeat(81)}  `);
		preferences = setProjectPinned(preferences, "chat", "/work/shared", true);
		preferences = setProjectAlias(preferences, "code", "/work/shared", "Code alias");
		saveProjectPreferences(localStorage, preferences);

		const loaded = loadProjectPreferences(localStorage);
		expect([...loaded.values()]).toEqual(expect.arrayContaining([
			{ mode: "chat", cwd: "/work/shared", alias: "🚀".repeat(80), pinned: true },
			{ mode: "code", cwd: "/work/shared", alias: "Code alias", pinned: false },
		]));
		const withoutChat = removeProjectPreference(loaded, "chat", "/work/shared");
		expect([...withoutChat.values()]).toEqual([
			{ mode: "code", cwd: "/work/shared", alias: "Code alias", pinned: false },
		]);
	});

	it("ignores malformed project preference documents and invalid entries", () => {
		for (const value of [
			"{broken",
			JSON.stringify({ version: 2, entries: [] }),
			JSON.stringify({ version: 1, entries: [], unknown: true }),
			JSON.stringify({ version: 1, entries: [{ mode: "other", cwd: "/work/a", pinned: false }] }),
			JSON.stringify({ version: 1, entries: [{ mode: "chat", cwd: "", pinned: false }] }),
			JSON.stringify({ version: 1, entries: [{ mode: "chat", cwd: "/work/a", pinned: "yes" }] }),
			JSON.stringify({ version: 1, entries: [{ mode: "chat", cwd: "/work/a", pinned: false, extra: 1 }] }),
		]) {
			localStorage.setItem("arcmind.projectPreferences.v1", value);
			expect(loadProjectPreferences(localStorage).size).toBe(0);
		}
	});

	it("applies aliases per mode, clears blank aliases, and stably partitions pinned projects", () => {
		const store = new AppStore();
		store.setSessions({
			sessions: [
				session("chat-a", "chat", "/work/a", "A"),
				session("chat-b", "chat", "/work/b", "B"),
				session("chat-c", "chat", "/work/c", "C"),
				session("code-a", "code", "/work/a", "Code A"),
			],
			nextAfterSessionId: null,
		});
		let preferences = setProjectAlias(new Map(), "chat", "/work/a", "Chat A");
		preferences = setProjectAlias(preferences, "code", "/work/a", "Code A alias");
		preferences = setProjectPinned(preferences, "chat", "/work/b", true);
		preferences = setProjectPinned(preferences, "chat", "/work/c", true);
		preferences = setProjectAlias(preferences, "chat", "/work/a", "   ");

		expect(buildSessionTree(store.getSnapshot(), "chat", preferences).projects.map((project) => project.name)).toEqual([
			"b",
			"c",
			"a",
		]);
		expect(buildSessionTree(store.getSnapshot(), "code", preferences).projects[0]).toMatchObject({
			name: "Code A alias",
			pinned: false,
		});
	});

	it("uses mode-specific project labels while requesting shared cwd Skills", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const store = new AppStore();
		store.setSessions({
			sessions: [
				session("chat-shared", "chat", "/work/shared", "Chat"),
				session("code-shared", "code", "/work/shared", "Code"),
			],
			nextAfterSessionId: null,
		});
		let preferences = setProjectAlias(new Map(), "chat", "/work/shared", "Chat label");
		preferences = setProjectAlias(preferences, "code", "/work/shared", "Code label");
		const listSkills = vi.fn().mockResolvedValue({
			skills: [{ name: "shared", description: "Shared", source: "project" }],
		});
		const skillApi = { listSkills };
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(
			<SkillsPanel api={skillApi} preferences={preferences} serverReady state={store.getSnapshot()} />,
		));

		await act(async () => button(container, "Project").click());
		await act(async () => button(container, "Chat").click());
		await act(async () => button(container, "Chat label").click());
		await flush();
		expect(listSkills).toHaveBeenLastCalledWith({ cwd: "/work/shared" });
		preferences = setProjectAlias(preferences, "chat", "/work/shared", "Renamed Chat label");
		await act(async () => root.render(
			<SkillsPanel api={skillApi} preferences={preferences} serverReady state={store.getSnapshot()} />,
		));
		expect(container.textContent).toContain("Renamed Chat label");
		store.setSessions({
			sessions: [session("code-shared", "code", "/work/shared", "Code")],
			nextAfterSessionId: null,
		});
		await act(async () => root.render(
			<SkillsPanel api={skillApi} preferences={preferences} serverReady state={store.getSnapshot()} />,
		));
		await flush();
		expect(container.textContent).toContain("No Chat projects yet.");
		store.setSessions({
			sessions: [
				session("chat-shared", "chat", "/work/shared", "Chat"),
				session("code-shared", "code", "/work/shared", "Code"),
			],
			nextAfterSessionId: null,
		});
		await act(async () => button(container, "Skills").click());
		await act(async () => button(container, "Project").click());
		await act(async () => button(container, "Code").click());
		await act(async () => button(container, "Code label").click());
		await flush();
		expect(listSkills).toHaveBeenLastCalledWith({ cwd: "/work/shared" });
		expect(listSkills).toHaveBeenCalledTimes(2);
		await act(async () => root.unmount());
	});

	it("keeps project row actions separate from folder toggling and creates one empty session", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api, order } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		const group = projectRow(container, "/work/chat-project");
		expect(group.querySelector(".project-heading")?.getAttribute("aria-expanded")).toBe("true");
		const actionButtons = [...group.querySelectorAll<HTMLButtonElement>(".project-action-buttons > button")];
		expect(actionButtons.map((candidate) => candidate.getAttribute("aria-label"))).toEqual([
			"Project actions",
			"New task in chat-project",
		]);

		await act(async () => actionButtons[0]!.click());
		await flush();
		expect(group.querySelector(".project-heading")?.getAttribute("aria-expanded")).toBe("true");
		expect([...group.querySelectorAll("[role=menuitem]")].map((item) => item.textContent?.trim())).toEqual([
			"Rename",
			"Pin",
			"Delete",
		]);
		expect(document.activeElement?.textContent?.trim()).toBe("Rename");
		await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
		expect(document.activeElement?.textContent?.trim()).toBe("Pin");
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		await flush();
		expect(group.querySelector("[role=menu]")).toBeNull();
		expect(document.activeElement?.getAttribute("aria-label")).toBe("Project actions");

		order.length = 0;
		await act(async () => actionButtons[1]!.click());
		await flush();
		await flush();
		expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({
			mode: "chat",
			cwd: "/work/chat-project",
		}));
		expect(order).toEqual(["create", "open", "list"]);
		expect(api.startTurn).not.toHaveBeenCalled();
		expect(container.querySelector('[data-active-session-id="chat-created"]')).not.toBeNull();
		expect(container.querySelector(".transcript")?.textContent ?? "").toBe("");
		expect(localStorage.getItem("arcmind.activeSessionId.chat")).toBe("chat-created");

		order.length = 0;
		const textarea = container.querySelector<HTMLTextAreaElement>("#composer-input")!;
		await act(async () => changeTextarea(textarea, "Inspect this project"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();
		expect(api.renameSession).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "chat-created",
			name: "Inspect this project",
		}));
		expect(order).toEqual(["rename", "list", "start"]);
		expect(api.startTurn).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "chat-created",
			text: "Inspect this project",
		}));
		await act(async () => root.unmount());
	});

	it("starts an unnamed session turn even when automatic display naming fails", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const unnamed = session("chat-unnamed", "chat", "/work/chat-project");
		localStorage.setItem("arcmind.activeSessionId.chat", unnamed.sessionId);
		const { api } = createHarness({ sessions: [unnamed] });
		vi.mocked(api.renameSession).mockRejectedValueOnce(new Error("rename unavailable"));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		const textarea = container.querySelector<HTMLTextAreaElement>("#composer-input")!;
		await act(async () => changeTextarea(textarea, "Keep the turn"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();
		expect(api.renameSession).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: unnamed.sessionId,
			name: "Keep the turn",
		}));
		expect(api.startTurn).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: unnamed.sessionId,
			text: "Keep the turn",
		}));
		await act(async () => root.unmount());
	});

	it("renames and deletes ordinary sessions while scheduled sessions stay read-only", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const active = session("chat-session-active", "chat", "/work/shared", "Active task");
		const other = session("chat-session-other", "chat", "/work/shared", "Other task");
		const running = { ...session("chat-session-running", "chat", "/work/shared", "Running task"), state: "running" as const };
		const scheduled = {
			...session("chat-session-scheduled", "chat", "/work/shared", "Scheduled task"),
			scheduled: { taskId: "task-a", runId: "run-a" },
		};
		localStorage.setItem("arcmind.activeSessionId.chat", active.sessionId);
		const { api } = createHarness({ sessions: [active, other, running, scheduled] });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		const scheduledRow = button(container, "Scheduled task").closest<HTMLElement>(".session-row")!;
		expect(scheduledRow.textContent).toContain("Scheduled");
		expect(scheduledRow.querySelector(".session-actions")).toBeNull();

		let otherRow = button(container, "Other task").closest<HTMLElement>(".session-row")!;
		await act(async () => button(otherRow, "Actions for Other task").click());
		expect([...otherRow.querySelectorAll("[role=menuitem]")].map((item) => item.textContent?.trim())).toEqual(["Rename", "Delete"]);
		await act(async () => button(otherRow, "Rename").click());
		await flush();
		const input = container.querySelector<HTMLInputElement>("#session-rename-input")!;
		expect(input.value).toBe("Other task");
		await act(async () => changeInput(input, "Renamed task"));
		await act(async () => button(container.querySelector<HTMLElement>(".project-dialog")!, "Rename").click());
		await flush();
		expect(api.renameSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: other.sessionId, name: "Renamed task" }));
		expect(container.textContent).toContain("Renamed task");

		otherRow = button(container, "Renamed task").closest<HTMLElement>(".session-row")!;
		await act(async () => button(otherRow, "Actions for Renamed task").click());
		await act(async () => button(otherRow, "Delete").click());
		await flush();
		expect(container.querySelector(".project-dialog")?.textContent).toContain("Project memory, Skills, schedules, other sessions, and source files are unchanged");
		await act(async () => button(container, "Move to Trash").click());
		await flush();
		expect(api.deleteSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: other.sessionId }));
		expect(container.textContent).not.toContain("Renamed task");
		expect(container.querySelector('[data-active-session-id="chat-session-active"]')).not.toBeNull();

		const runningRow = button(container, "Running task").closest<HTMLElement>(".session-row")!;
		await act(async () => button(runningRow, "Actions for Running task").click());
		expect(button(runningRow, "Delete").disabled).toBe(true);
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

		const activeRow = button(container, "Active task").closest<HTMLElement>(".session-row")!;
		await act(async () => button(activeRow, "Actions for Active task").click());
		await act(async () => button(activeRow, "Delete").click());
		await flush();
		await act(async () => button(container, "Move to Trash").click());
		await flush();
		expect(container.textContent).toContain("What can I take off your plate?");
		expect(localStorage.getItem("arcmind.activeSessionId.chat")).toBeNull();
		await act(async () => root.unmount());
	});

	it("reuses the session delete request id after a lost response", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const active = session("chat-delete-retry", "chat", "/work/retry", "Retry task");
		localStorage.setItem("arcmind.activeSessionId.chat", active.sessionId);
		const { api } = createHarness({ sessions: [active] });
		vi.mocked(api.deleteSession).mockRejectedValueOnce(new Error("delete response lost"));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		const row = button(container, "Retry task").closest<HTMLElement>(".session-row")!;
		await act(async () => button(row, "Actions for Retry task").click());
		await act(async () => button(row, "Delete").click());
		await flush();
		await act(async () => button(container, "Move to Trash").click());
		await flush();
		expect(container.querySelector(".project-dialog")?.textContent).toContain("delete response lost");
		await act(async () => button(container, "Move to Trash").click());
		await flush();

		expect(api.deleteSession).toHaveBeenCalledTimes(2);
		expect(vi.mocked(api.deleteSession).mock.calls[0]![0].requestId).toBe(
			vi.mocked(api.deleteSession).mock.calls[1]![0].requestId,
		);
		expect(container.textContent).toContain("What can I take off your plate?");
		await act(async () => root.unmount());
	});

	it("reuses the project create request id when its first response is lost", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness({ loseFirstCreateResponse: true });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		const create = () => button(
			projectRow(container, "/work/chat-project"),
			"New task in chat-project",
		);
		await act(async () => create().click());
		await flush();
		await act(async () => create().click());
		await flush();
		await flush();

		expect(api.createSession).toHaveBeenCalledTimes(2);
		expect(vi.mocked(api.createSession).mock.calls[0]![0].requestId).toBe(
			vi.mocked(api.createSession).mock.calls[1]![0].requestId,
		);
		expect(api.startTurn).not.toHaveBeenCalled();
		expect(container.querySelector('[data-active-session-id="chat-created"]')).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("renames and pins only the exact mode without mutating sessions or Desktop APIs", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const sharedSessions = [
			session("chat-shared-row", "chat", "/work/shared", "Chat session"),
			session("code-shared-row", "code", "/work/shared", "Code session"),
		];
		const journalFixture = JSON.stringify(sharedSessions);
		const { api } = createHarness({ sessions: sharedSessions });
		const container = document.createElement("div");
		document.body.append(container);
		let root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		let chatGroup = projectRow(container, "/work/shared");
		await act(async () => button(chatGroup, "Project actions").click());
		await act(async () => button(chatGroup, "Rename").click());
		await flush();
		const input = container.querySelector<HTMLInputElement>("#project-rename-input")!;
		expect(document.activeElement).toBe(input);
		await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		await flush();
		expect(container.querySelector(".project-dialog")).toBeNull();
		expect(document.activeElement?.textContent?.trim()).toBe("Rename");
		await act(async () => button(chatGroup, "Rename").click());
		await flush();
		const reopenedInput = container.querySelector<HTMLInputElement>("#project-rename-input")!;
		await act(async () => changeInput(reopenedInput, "  Chat alias  "));
		await act(async () => button(container.querySelector<HTMLElement>(".project-dialog")!, "Rename").click());
		await flush();
		chatGroup = projectRow(container, "/work/shared");
		expect(chatGroup.querySelector(".project-heading span")?.textContent).toBe("Chat alias");
		await act(async () => button(chatGroup, "Pin").click());
		await act(async () => button(container, "Code").click());
		await flush();
		const codeGroup = projectRow(container, "/work/shared");
		expect(codeGroup.querySelector(".project-heading span")?.textContent).toBe("shared");
		await act(async () => button(codeGroup, "Project actions").click());
		expect(button(codeGroup, "Pin")).not.toBeNull();
		await act(async () => button(container, "Chat").click());
		await flush();
		chatGroup = projectRow(container, "/work/shared");
		expect(chatGroup.querySelector(".project-heading span")?.textContent).toBe("Chat alias");
		await act(async () => button(chatGroup, "Project actions").click());
		expect(button(chatGroup, "Unpin")).not.toBeNull();
		expect(JSON.stringify(sharedSessions)).toBe(journalFixture);
		expect(api.createSession).not.toHaveBeenCalled();
		expect(api.previewProjectDelete).not.toHaveBeenCalled();
		expect(api.deleteProject).not.toHaveBeenCalled();

		await act(async () => root.unmount());
		root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		expect(container.querySelector('.project-heading[title="/work/shared"] span')?.textContent).toBe("Chat alias");
		await act(async () => root.unmount());
	});

	it("shows a complete mode-specific delete preview, blocks schedules, then removes only Chat", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const chatActive = session("chat-delete-active", "chat", "/work/shared", "Chat active");
		const chatArchived = { ...session("chat-delete-archived", "chat", "/work/shared", "Chat archived"), archived: true };
		const code = session("code-delete-preserved", "code", "/work/shared", "Code preserved");
		let preferences = setProjectAlias(new Map(), "chat", "/work/shared", "Chat local");
		preferences = setProjectPinned(preferences, "chat", "/work/shared", true);
		preferences = setProjectAlias(preferences, "code", "/work/shared", "Code local");
		saveProjectPreferences(localStorage, preferences);
		localStorage.setItem("arcmind.activeSessionId.chat", chatActive.sessionId);
		const { api } = createHarness({ sessions: [chatActive, chatArchived, code] });
		vi.mocked(api.previewProjectDelete)
			.mockResolvedValueOnce({
				ok: true,
				result: {
					mode: "chat",
					cwd: "/canonical/shared",
					sessionCount: 2,
					blockingScheduleCount: 1,
					revision: "a".repeat(64),
				},
			})
			.mockResolvedValueOnce({
				ok: true,
				result: {
					mode: "chat",
					cwd: "/canonical/shared",
					sessionCount: 2,
					blockingScheduleCount: 0,
					revision: "b".repeat(64),
				},
			});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		const group = projectRow(container, "/work/shared");
		await act(async () => button(group, "Project actions").click());
		await act(async () => button(group, "Delete").click());
		await flush();
		expect(container.querySelector(".project-dialog")?.textContent).toContain("2 Chat sessions");
		expect(container.querySelector(".project-dialog")?.textContent).toContain("/canonical/shared");
		expect(container.querySelector(".project-dialog")?.textContent).toContain("Code project and its memory are unchanged");
		expect(container.querySelector(".project-dialog")?.textContent).toContain("source folder and its files are unchanged");
		expect(container.querySelector(".project-dialog")?.textContent).toContain("Schedules are not deleted automatically");
		expect(button(container, "Move to Trash").disabled).toBe(true);
		await act(async () => button(container, "Cancel").click());
		await act(async () => button(group, "Delete").click());
		await flush();
		expect(button(container, "Move to Trash").disabled).toBe(false);
		await act(async () => button(container, "Move to Trash").click());
		await flush();
		await flush();

		expect(api.deleteProject).toHaveBeenCalledWith(expect.objectContaining({
			mode: "chat",
			cwd: "/work/shared",
			expectedRevision: "b".repeat(64),
		}));
		expect(container.textContent).not.toContain("Chat local");
		expect(container.textContent).toContain("What can I take off your plate?");
		expect(localStorage.getItem("arcmind.activeSessionId.chat")).toBeNull();
		expect([...loadProjectPreferences(localStorage).values()]).toEqual([
			{ mode: "code", cwd: "/work/shared", alias: "Code local", pinned: false },
		]);
		await act(async () => button(container, "Code").click());
		await flush();
		expect(container.textContent).toContain("Code local");
		expect(container.textContent).toContain("Code preserved");
		await act(async () => root.unmount());
	});

	it("keeps renderer evidence on delete failure and reloads a fresh preview on Retry", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const chat = session("chat-delete-failure", "chat", "/work/failure", "Keep me");
		localStorage.setItem("arcmind.activeSessionId.chat", chat.sessionId);
		const { api } = createHarness({ sessions: [chat] });
		const lostResponse = new Error("delete response was lost");
		vi.mocked(api.deleteProject).mockRejectedValueOnce(lostResponse);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		const group = projectRow(container, "/work/failure");
		await act(async () => button(group, "Project actions").click());
		await act(async () => button(group, "Delete").click());
		await flush();
		await act(async () => button(container, "Move to Trash").click());
		await flush();
		expect(container.querySelector(".project-dialog")?.textContent).toContain("delete response was lost");
		expect(container.textContent).toContain("Keep me");
		expect(localStorage.getItem("arcmind.activeSessionId.chat")).toBe(chat.sessionId);
		await act(async () => button(container, "Retry").click());
		await flush();
		expect(api.previewProjectDelete).toHaveBeenCalledTimes(2);
		await act(async () => button(container, "Move to Trash").click());
		await flush();
		await flush();
		expect(api.deleteProject).toHaveBeenCalledTimes(2);
		expect(vi.mocked(api.deleteProject).mock.calls[0]![0].requestId).toBe(
			vi.mocked(api.deleteProject).mock.calls[1]![0].requestId,
		);
		expect(container.textContent).not.toContain("Keep me");
		await act(async () => root.unmount());
	});

	it("ignores a delayed preview after another project becomes active", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness({
			sessions: [
				session("chat-preview-a", "chat", "/work/a", "A"),
				session("chat-preview-b", "chat", "/work/b", "B"),
			],
		});
		let resolveA!: (value: { ok: true; result: ClientResult<"project/deletePreview"> }) => void;
		vi.mocked(api.previewProjectDelete).mockImplementation(async ({ mode, cwd }) => {
			if (cwd === "/work/a") return await new Promise((resolve) => {
				resolveA = resolve;
			});
			return {
				ok: true,
				result: { mode, cwd: "/canonical/b", sessionCount: 1, blockingScheduleCount: 0, revision: "b".repeat(64) },
			};
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		const groupA = projectRow(container, "/work/a");
		const groupB = projectRow(container, "/work/b");
		await act(async () => button(groupA, "Project actions").click());
		await act(async () => button(groupA, "Delete").click());
		expect(container.querySelector(".project-dialog")?.textContent).toContain("Checking project data");
		await act(async () => button(container, "Cancel").click());
		await act(async () => button(groupB, "Project actions").click());
		await act(async () => button(groupB, "Delete").click());
		await flush();
		expect(container.querySelector(".project-dialog")?.textContent).toContain("/canonical/b");
		await act(async () => resolveA({
			ok: true,
			result: {
				mode: "chat",
				cwd: "/canonical/a",
				sessionCount: 99,
				blockingScheduleCount: 0,
				revision: "a".repeat(64),
			},
		}));
		await flush();
		expect(container.querySelector(".project-dialog")?.textContent).toContain("/canonical/b");
		expect(container.querySelector(".project-dialog")?.textContent).not.toContain("/canonical/a");
		await act(async () => root.unmount());
	});

	it("builds a compact Unicode-safe title from the first prompt", () => {
		expect(titleFromPrompt("  分析这个项目\n carefully  ")).toBe("分析这个项目 carefully");
		expect(titleFromPrompt("🚀".repeat(49))).toBe(`${"🚀".repeat(47)}…`);
	});

	it("never exposes the managed workspace path as the session title", () => {
		expect(sessionDisplayTitle({ cwd: "/Users/example/.arcmind/agent/workspaces/session-id", cwdOrigin: "managed", name: "" })).toBe("Chat");
		expect(sessionDisplayTitle({ cwd: "/work/project", cwdOrigin: "user-selected", name: "" })).toBe("/work/project");
	});

	it("selects the first pending interaction for the visible session", () => {
		const other = {
			interactionId: "00000000-0000-4000-8000-000000000201",
			sessionId: "other-session",
			title: "Other",
			message: "Other session prompt",
			createdAt: "2026-07-20T00:00:00.000Z",
			kind: "confirm" as const,
		};
		const visible = {
			interactionId: "00000000-0000-4000-8000-000000000202",
			sessionId: "visible-session",
			title: "Visible",
			message: "Visible session prompt",
			createdAt: "2026-07-20T00:00:00.000Z",
			kind: "confirm" as const,
		};
		const interactions = new Map([
			[other.interactionId, other],
			[visible.interactionId, visible],
		]);

		expect(firstInteractionForSession(
			[other.interactionId, visible.interactionId],
			interactions,
			"visible-session",
		)).toBe(visible);
	});

	it("filters the initial Chat tree and creates the real session only on first send", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.code", "code-existing");
		const { api, order } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		expect(container.textContent).toContain("Chat project task");
		expect(container.textContent).not.toContain("Code project task");
		expect(api.openSession).not.toHaveBeenCalled();
		await act(async () => button(container, "New task").click());
		expect(api.createSession).not.toHaveBeenCalled();
		expect(button(container, "New task").getAttribute("aria-current")).toBe("page");
		expect(container.querySelector('.session-button[aria-current="page"]')).toBeNull();

		await act(async () => button(container, "Work in a project or folder").click());
		await flush();
		expect(api.selectProjectFolder).toHaveBeenCalledTimes(1);
		expect(api.createSession).not.toHaveBeenCalled();
		expect(container.textContent).toContain("selected-project");

		const textarea = container.querySelector("textarea")!;
		await act(async () => changeTextarea(textarea, "  Analyze this repository\ncarefully  "));
		order.length = 0;
		await act(async () => textarea.form!.requestSubmit());
		await flush();
		await flush();

		expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({
			mode: "chat",
			cwd: "/work/selected-project",
			name: "Analyze this repository carefully",
		}));
		expect(api.startTurn).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "chat-created",
			text: "Analyze this repository\ncarefully",
		}));
		expect(order).toEqual(["create", "list", "open", "start"]);

		await act(async () => root.unmount());
	});

	it("creates an unfoldered Chat task only on its first send", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		expect(container.querySelectorAll("#composer-input")).toHaveLength(1);
		expect(container.querySelectorAll('[aria-label="Add to message"]')).toHaveLength(1);
		expect(api.createSession).not.toHaveBeenCalled();
		const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
		await act(async () => changeTextarea(textarea, "Start without a folder"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();
		await flush();

		const createInput = vi.mocked(api.createSession).mock.calls[0]![0];
		expect(createInput).toMatchObject({
			mode: "chat",
			name: "Start without a folder",
		});
		expect(createInput).not.toHaveProperty("cwd");
		expect(api.startTurn).toHaveBeenCalledTimes(1);
		await act(async () => root.unmount());
	});

	it("places permissions after Add and creates a Full draft atomically without confirmation", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		const leading = container.querySelector(".composer-leading")!;
		expect(leading.children[0]?.classList.contains("composer-add")).toBe(true);
		expect(leading.children[1]?.classList.contains("permission-selector")).toBe(true);
		const trigger = button(container, "Select permissions, current Ask");
		await act(async () => trigger.click());
		expect(container.querySelector('[role="menu"]')).not.toBeNull();
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
		expect(container.querySelector('[role="menu"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);

		await act(async () => trigger.click());
		await act(async () => menuOption(container, "Full access").click());
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(button(container, "Select permissions, current Full")).not.toBeNull();
		const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
		await act(async () => changeTextarea(textarea, "Run with full access"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();
		await flush();

		expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({
			mode: "chat",
			permissionMode: "full",
		}));
		expect(api.setPermissionMode).not.toHaveBeenCalled();
		await act(async () => root.unmount());
	});

	it("keeps a session permission change local to its control until the server event arrives", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		const { api, emitEvent } = createHarness();
		let resolveChange!: (result: { permissionMode: "full" }) => void;
		vi.mocked(api.setPermissionMode).mockImplementationOnce(() => new Promise((resolve) => {
			resolveChange = resolve;
		}));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Select permissions, current Ask").click());
		await act(async () => menuOption(container, "Full access").click());
		const pendingTrigger = button(container, "Select permissions, current Ask");
		expect(pendingTrigger.disabled).toBe(true);
		for (const label of ["Chat", "Code", "New task", "Skills", "Chat project task"]) {
			expect(button(container, label).disabled, label).toBe(false);
		}

		await act(async () => resolveChange({ permissionMode: "full" }));
		expect(button(container, "Select permissions, current Ask").disabled).toBe(false);
		await act(async () => emitEvent({
			type: "app-server",
			envelope: {
				jsonrpc: "2.0",
				method: "connection/events",
				params: {
					serverEpoch: EPOCH,
					fromCursor: 1,
					toCursor: 1,
					events: [{
						type: "session/permissionModeChanged",
						sessionId: "chat-existing",
						permissionMode: "full",
					}],
				},
			},
		}));
		expect(button(container, "Select permissions, current Full")).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("returns to a fresh task when another client deletes the active session", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		const { api, emitEvent } = createHarness();
		const store = new AppStore();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={store} />));
		await flush();

		await act(async () =>
			emitEvent({
				type: "app-server",
				envelope: {
					jsonrpc: "2.0",
					method: "connection/events",
					params: {
						serverEpoch: EPOCH,
						fromCursor: 1,
						toCursor: 3,
						events: [
							{ type: "session/invalidated", sessionId: "chat-existing", reason: "reload_required" },
							{ type: "session/invalidated", sessionId: "code-existing", reason: "deleted" },
							{ type: "session/invalidated", sessionId: "chat-existing", reason: "deleted" },
						],
					},
				},
			}),
		);

		expect(store.getSnapshot().activeSessionId).toBeNull();
		expect(store.getSnapshot().sessionsById.has("code-existing")).toBe(false);
		expect(localStorage.getItem("arcmind.activeSessionId.chat")).toBeNull();
		expect(container.querySelector(".new-task-home")).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("removes a remotely deleted project while preserving the other mode", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		const { api, emitEvent } = createHarness();
		const store = new AppStore();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={store} />));
		await flush();

		await act(async () =>
			emitEvent({
				type: "app-server",
				envelope: {
					jsonrpc: "2.0",
					method: "connection/events",
					params: {
						serverEpoch: EPOCH,
						fromCursor: 1,
						toCursor: 2,
						events: [
							{
								type: "project/invalidated",
								mode: "chat",
								cwd: "/work/chat-project",
								reason: "reload_required",
							},
							{
								type: "project/invalidated",
								mode: "chat",
								cwd: "/work/chat-project",
								reason: "deleted",
							},
						],
					},
				},
			}),
		);

		expect(store.getSnapshot().activeSessionId).toBeNull();
		expect(store.getSnapshot().sessionsById.has("code-existing")).toBe(true);
		expect(localStorage.getItem("arcmind.activeSessionId.chat")).toBeNull();
		expect(container.querySelector(".new-task-home")).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("resnapshots the real permission after a partial downgrade failure", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		const summary = session("chat-existing", "chat", "/work/chat-project", "Chat project task");
		vi.mocked(api.openSession)
			.mockResolvedValueOnce({ ...snapshot(summary), permissionMode: "full" })
			.mockResolvedValueOnce({ ...snapshot(summary), permissionMode: "ask" });
		vi.mocked(api.setPermissionMode).mockRejectedValueOnce(new Error("child downgrade failed"));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Select permissions, current Full").click());
		await act(async () => menuOption(container, "Ask before changes").click());
		await flush();
		await flush();

		expect(api.openSession).toHaveBeenCalledTimes(2);
		expect(button(container, "Select permissions, current Ask")).not.toBeNull();
		expect(container.textContent).toContain("child downgrade failed");
		await act(async () => root.unmount());
	});

	it("disables session permission changes while a turn is running", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		const running = { ...session("chat-existing", "chat", "/work/chat-project", "Chat project task"), state: "running" as const };
		vi.mocked(api.openSession).mockResolvedValueOnce({
			...snapshot(running),
			activeTurnId: "turn-running",
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		expect(button(container, "Select permissions, current Ask").disabled).toBe(true);
		await act(async () => root.unmount());
	});

	it("opens an empty Code session immediately after choosing an existing folder", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.code", "code-existing");
		const { api, order } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Code").click());
		await flush();
		await act(async () => button(container, "New task").click());

		expect(container.textContent).toContain("Create a new project");
		expect(container.querySelectorAll("#composer-input")).toHaveLength(0);
		expect(api.selectProjectFolder).not.toHaveBeenCalled();
		expect(api.createSession).not.toHaveBeenCalled();

		await act(async () => button(container, "Use an existing folder").click());
		expect(container.textContent).toContain("Choose a folder and ArcMind will treat its files as project context.");
		order.length = 0;
		await act(async () => button(container, "Choose folder").click());
		await flush();
		await flush();

		expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({
			mode: "code",
			cwd: "/work/selected-project",
		}));
		expect(api.startTurn).not.toHaveBeenCalled();
		expect(order).toEqual(["create", "open", "list"]);
		expect(container.querySelectorAll("#composer-input")).toHaveLength(1);
		await act(async () => root.unmount());
	});

	it("lets users dismiss Code project setup without auto-selecting an existing session", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Code").click());
		await flush();
		expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Create a new project");
		await act(async () => document.activeElement?.dispatchEvent(
			new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
		));

		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(projectRow(container, "/work/code-project")).not.toBeNull();
		expect(container.querySelector('[data-active-session-id="code-existing"]')).toBeNull();
		expect(api.openSession).not.toHaveBeenCalled();
		await act(async () => root.unmount());
	});

	it("creates a new folder and immediately opens its empty Code session", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.code", "code-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		await act(async () => button(container, "Code").click());
		await flush();
		await act(async () => button(container, "New task").click());
		await act(async () => button(container, "Start from scratch").click());
		await flush();

		expect(container.querySelector<HTMLInputElement>("#code-project-name")?.value).toBe("");
		expect(container.textContent).toContain("/Users/test/ArcMind Projects");
		await act(async () => changeInput(container.querySelector<HTMLInputElement>("#code-project-name")!, "Desktop App"));
		await act(async () => container.querySelector<HTMLFormElement>(".code-project-form")!.requestSubmit());
		await flush();
		await flush();

		expect(api.createProjectFolder).toHaveBeenCalledWith({
			parentDirectory: "/Users/test/ArcMind Projects",
			name: "Desktop App",
			files: [],
		});
		expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({
			mode: "code",
			cwd: "/Users/test/ArcMind Projects/Desktop App",
		}));
		expect(api.startTurn).not.toHaveBeenCalled();
		await act(async () => root.unmount());
	});

	it("keeps the add menu in an existing Code session composer", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.code", "code-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		vi.mocked(api.listSkills).mockClear();

		await act(async () => button(container, "Code").click());
		await flush();

		expect(container.querySelector('[data-active-session-id="code-existing"]')).not.toBeNull();
		expect(api.listSkills).toHaveBeenCalledWith({ sessionId: "code-existing" });
		expect(container.querySelectorAll('[aria-label="Add to message"]')).toHaveLength(1);
		await act(async () => button(container, "Add to message").click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Skills").click());
		expect(container.querySelector(".composer-skill-menu")?.textContent).toContain("pdf");
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		await act(async () => button(container, "Add to message").click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Add files or photos").click());
		await flush();
		expect(container.querySelector(".composer-chips")?.textContent).toContain("report.pdf");
		await act(async () => root.unmount());
	});

	it("clears skills while the newly visible session skills are loading", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		localStorage.setItem("arcmind.activeSessionId.code", "code-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Add to message").click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Skills").click());
		expect(container.querySelector(".composer-skill-menu")?.textContent).toContain("pdf");
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

		vi.mocked(api.listSkills).mockImplementationOnce(() => new Promise(() => undefined));
		await act(async () => button(container, "Code").click());
		await flush();
		await act(async () => button(container, "Add to message").click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Skills").click());

		expect(container.querySelector(".composer-skill-menu")?.textContent).not.toContain("pdf");
		await act(async () => root.unmount());
	});

	it("reports a failed interrupt without leaving an unhandled rejection", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		vi.mocked(api.openSession).mockImplementation(async ({ sessionId }) => {
			const summary = session(sessionId, "chat", "/work/chat-project", "Chat project task");
			return {
				...snapshot({ ...summary, state: "running" }),
				activeTurnId: "00000000-0000-4000-8000-000000000301",
			};
		});
		vi.mocked(api.interruptTurn).mockRejectedValueOnce(new Error("interrupt failed"));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Stop task").click());
		await flush();

		expect(api.interruptTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "chat-existing" }));
		expect(container.textContent).toContain("interrupt failed");
		await act(async () => root.unmount());
	});

	it("submits selected files and one hidden skill on first Chat send", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		expect(container.querySelector('[aria-label="Add folder (coming soon)"]')).toBeNull();
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, code: "KeyU", metaKey: true })));
		await flush();
		expect(api.selectAttachmentFiles).toHaveBeenCalledTimes(1);
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add to message"]')!.click());
		expect(container.querySelector(".composer-add-menu > .composer-menu-separator")).not.toBeNull();
		expect(container.querySelector(".composer-menu-shortcut")?.textContent).toBe("⌘U");
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Add files or photos").click());
		await flush();
		expect(api.selectAttachmentFiles).toHaveBeenCalledTimes(2);
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add to message"]')!.click());
		const skillsButton = button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Skills");
		await act(async () => skillsButton.click());
		expect(skillsButton.classList.contains("is-active")).toBe(true);
		await act(async () => button(container.querySelector<HTMLElement>(".composer-skill-menu")!, "pdf").click());

		expect(container.textContent).toContain("report.pdf");
		expect(container.querySelector('[aria-label="Remove skill pdf"]')).not.toBeNull();
		expect([...container.querySelectorAll("button")].some((candidate) => candidate.textContent?.trim() === "Browse skills")).toBe(false);
		const textarea = container.querySelector("textarea")!;
		await act(async () => changeTextarea(textarea, "Summarize this"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();
		await flush();

		expect(api.createSession).toHaveBeenCalledTimes(1);
		expect(api.startTurn).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "chat-created",
			text: "/skill:pdf Summarize this",
			attachments: [{ path: "/tmp/report.pdf", name: "report.pdf" }],
		}));
		await act(async () => root.unmount());
	});

	it("removes files, replaces the selected skill, closes with Escape, and routes Manage skills", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		const add = () => container.querySelector<HTMLButtonElement>('[aria-label="Add to message"]')!;
		await act(async () => add().click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Add files or photos").click());
		await flush();
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove file report.pdf"]')!.click());
		expect(container.textContent).not.toContain("report.pdf");

		await act(async () => add().click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Skills").click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-skill-menu")!, "pdf").click());
		await act(async () => add().click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Skills").click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-skill-menu")!, "xlsx").click());
		expect(container.querySelector('[aria-label="Remove skill pdf"]')).toBeNull();
		expect(container.querySelector('[aria-label="Remove skill xlsx"]')).not.toBeNull();

		await act(async () => add().click());
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(container.querySelector(".composer-add-menu")).toBeNull();

		await act(async () => add().click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Skills").click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-skill-menu")!, "Manage skills").click());
		expect(container.textContent).toContain("Skills included with ArcMind");
		await act(async () => root.unmount());
	});

	it("permits an attachment-only Chat send", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Add to message"]')!.click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Add files or photos").click());
		await flush();
		await act(async () => container.querySelector<HTMLTextAreaElement>("textarea")!.form!.requestSubmit());
		await flush();
		await flush();

		expect(api.startTurn).toHaveBeenCalledWith(expect.objectContaining({
			text: "",
			attachments: [{ path: "/tmp/report.pdf", name: "report.pdf" }],
		}));
		await act(async () => root.unmount());
	});

	it("retains additions after a failed active send and changes replay identity with the file", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		const { api } = createHarness({ loseFirstStartResponse: true });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		expect(container.querySelector(".model-control")?.textContent).toBe("Test model");
		expect(button(container, "Select effort, current Off")).not.toBeNull();

		const add = () => container.querySelector<HTMLButtonElement>('[aria-label="Add to message"]')!;
		await act(async () => add().click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Add files or photos").click());
		await flush();
		await act(async () => add().click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Skills").click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-skill-menu")!, "pdf").click());
		const textarea = container.querySelector("textarea")!;
		await act(async () => changeTextarea(textarea, "Same prompt"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();

		expect(textarea.value).toBe("Same prompt");
		expect(container.querySelector('[aria-label="Remove file report.pdf"]')).not.toBeNull();
		expect(container.querySelector('[aria-label="Remove skill pdf"]')).not.toBeNull();
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove file report.pdf"]')!.click());
		vi.mocked(api.selectAttachmentFiles).mockResolvedValueOnce([{ path: "/tmp/other.pdf", name: "other.pdf" }]);
		await act(async () => add().click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "Add files or photos").click());
		await flush();
		await act(async () => textarea.form!.requestSubmit());
		await flush();

		const first = vi.mocked(api.startTurn).mock.calls[0]![0];
		const second = vi.mocked(api.startTurn).mock.calls[1]![0];
		expect(second.requestId).not.toBe(first.requestId);
		expect(second).toEqual(expect.objectContaining({
			text: "/skill:pdf Same prompt",
			attachments: [{ path: "/tmp/other.pdf", name: "other.pdf" }],
		}));
		expect(textarea.value).toBe("");
		expect(container.querySelector(".composer-chips")).toBeNull();
		await act(async () => root.unmount());
	});

	it("keeps an optimistic effort visible and resnapshots after a failed change", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
		localStorage.setItem("arcmind.activeSessionId.code", "code-existing");
		const { api } = createHarness();
		const codeSnapshot = {
			...snapshot(session("code-existing", "code", "/work/code-project", "Code project task")),
			thinkingSelection: "high" as const,
			actualThinkingLevel: "high" as const,
			availableThinkingSelections: ["off", "low", "medium", "high", "ultra"] as const,
		};
		vi.mocked(api.openSession).mockResolvedValue(codeSnapshot);
		let rejectChange!: (reason: Error) => void;
		vi.mocked(api.setThinkingSelection).mockImplementation(() => new Promise((_resolve, reject) => {
			rejectChange = reject;
		}));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		await act(async () => button(container, "Code").click());
		await flush();

		const trigger = button(container, "Select effort, current High");
		await act(async () => trigger.click());
		const range = container.querySelector<HTMLInputElement>('.thinking-control input[type="range"]')!;
		await act(async () => {
			range.dispatchEvent(new Event("pointerdown", { bubbles: true }));
			Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(range, "3.8");
			range.dispatchEvent(new Event("input", { bubbles: true }));
			range.dispatchEvent(new Event("pointerup", { bubbles: true }));
			trigger.click();
		});

		expect(api.setThinkingSelection).toHaveBeenCalledWith(expect.objectContaining({ selection: "ultra" }));
		expect(trigger.textContent).toContain("Ultra");
		await act(async () => rejectChange(new Error("selection failed")));
		await flush();
		await flush();
		expect(trigger.textContent).toContain("High");
		expect(container.textContent).toContain("selection failed");
		await act(async () => root.unmount());
	});

	it("keeps a project group collapsed across unrelated renders", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		const project = container.querySelector<HTMLButtonElement>(".project-heading")!;
		const group = project.closest<HTMLElement>(".project-group")!;
		const drawer = group.querySelector<HTMLElement>(".project-drawer")!;
		const sessionCount = drawer.querySelectorAll(".session-button").length;
		expect(project.getAttribute("aria-expanded")).toBe("true");
		expect(sessionCount).toBeGreaterThan(0);
		await act(async () => project.click());
		await flush();
		expect(project.getAttribute("aria-expanded")).toBe("false");
		expect(group.contains(drawer)).toBe(true);
		expect(drawer.hasAttribute("inert")).toBe(true);
		expect(api.openSession).not.toHaveBeenCalled();
		expect(group.querySelector('.session-button[aria-current="page"]')).toBeNull();
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Show tools sidebar"]')!.click());
		expect(container.querySelector(".project-heading")?.getAttribute("aria-expanded")).toBe("false");
		expect(drawer.querySelectorAll(".session-button")).toHaveLength(sessionCount);

		await act(async () => root.unmount());
	});

	it("does not submit while an input method editor is composing", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		const textarea = container.querySelector("textarea")!;
		await act(async () => changeTextarea(textarea, "还在组词"));

		await act(async () => {
			textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", isComposing: true }));
		});
		expect(api.createSession).not.toHaveBeenCalled();
		expect(textarea.value).toBe("还在组词");

		await act(async () => root.unmount());
	});

	it("keeps the draft after an open failure and retries without a second create", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness({ failFirstOpen: true });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		const textarea = container.querySelector("textarea")!;
		await act(async () => changeTextarea(textarea, "Keep this draft"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();

		expect(container.textContent).toContain("open failed once");
		expect(textarea.value).toBe("Keep this draft");
		expect(api.createSession).toHaveBeenCalledTimes(1);
		expect(button(container, "Select permissions, current Ask").disabled).toBe(true);
		await act(async () => textarea.form!.requestSubmit());
		await flush();
		await flush();

		expect(api.createSession).toHaveBeenCalledTimes(1);
		expect(api.startTurn).toHaveBeenCalledTimes(1);
		await act(async () => root.unmount());
	});

	it("retries an existing Code folder with the same idempotent create request after open fails", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.code", "code-existing");
		const { api } = createHarness({ failOpenSessionIds: ["code-created"] });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		await act(async () => button(container, "Code").click());
		await flush();
		await act(async () => button(container, "New task").click());
		await act(async () => button(container, "Use an existing folder").click());
		await act(async () => button(container, "Choose folder").click());
		await flush();

		expect(container.textContent).toContain("open failed once");
		expect(api.createSession).toHaveBeenCalledTimes(1);
		const firstRequestId = vi.mocked(api.createSession).mock.calls[0]![0].requestId;
		await act(async () => button(container, "Choose folder").click());
		await flush();
		await flush();

		expect(api.createSession).toHaveBeenCalledTimes(2);
		expect(vi.mocked(api.createSession).mock.calls[1]![0].requestId).toBe(firstRequestId);
		expect(api.startTurn).not.toHaveBeenCalled();
		expect(container.querySelectorAll("#composer-input")).toHaveLength(1);
		await act(async () => root.unmount());
	});

	it("locks the selected folder after a draft session has been created", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness({ failFirstOpen: true });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Work in a project or folder").click());
		await flush();
		const textarea = container.querySelector("textarea")!;
		await act(async () => changeTextarea(textarea, "Keep the real folder"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();

		const folderButton = container.querySelector<HTMLButtonElement>(".folder-picker")!;
		expect(folderButton.disabled).toBe(true);
		folderButton.click();
		expect(api.selectProjectFolder).toHaveBeenCalledTimes(1);
		await act(async () => root.unmount());
	});

	it("keys a retried Chat turn request ID to its session and text", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness({ loseFirstStartResponse: true });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		const textarea = container.querySelector("textarea")!;

		await act(async () => changeTextarea(textarea, "First payload"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();
		expect(container.textContent).toContain("start response lost");

		await act(async () => changeTextarea(textarea, "Changed payload"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();
		await flush();

		const first = vi.mocked(api.startTurn).mock.calls[0]![0];
		const second = vi.mocked(api.startTurn).mock.calls[1]![0];
		expect(second.sessionId).toBe(first.sessionId);
		expect(second.text).toBe("Changed payload");
		expect(second.requestId).not.toBe(first.requestId);
		await act(async () => root.unmount());
	});

	it("reuses the Chat create request ID when the first response is lost", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness({ loseFirstCreateResponse: true });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		const textarea = container.querySelector("textarea")!;
		await act(async () => changeTextarea(textarea, "Retry the same create"));

		await act(async () => textarea.form!.requestSubmit());
		await flush();
		expect(container.textContent).toContain("create response lost");
		expect(textarea.value).toBe("Retry the same create");
		expect(button(container, "Select permissions, current Ask").disabled).toBe(true);

		await act(async () => textarea.form!.requestSubmit());
		await flush();
		await flush();

		expect(api.createSession).toHaveBeenCalledTimes(2);
		expect(vi.mocked(api.createSession).mock.calls[1]![0].requestId).toBe(
			vi.mocked(api.createSession).mock.calls[0]![0].requestId,
		);
		expect(api.startTurn).toHaveBeenCalledTimes(1);
		await act(async () => root.unmount());
	});

	it("reuses an active turn request ID when its first response is lost", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		const { api } = createHarness({ loseFirstStartResponse: true });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		const textarea = container.querySelector("textarea")!;
		await act(async () => changeTextarea(textarea, "Retry active turn"));

		await act(async () => textarea.form!.requestSubmit());
		await flush();
		expect(container.textContent).toContain("start response lost");
		await act(async () => textarea.form!.requestSubmit());
		await flush();

		expect(api.startTurn).toHaveBeenCalledTimes(2);
		expect(vi.mocked(api.startTurn).mock.calls[1]![0].requestId).toBe(
			vi.mocked(api.startTurn).mock.calls[0]![0].requestId,
		);
		await act(async () => root.unmount());
	});

	it("keeps the Chat home visible when opening a sidebar session fails", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness({ failOpenSessionIds: ["chat-existing"] });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Chat project task").click());
		await flush();

		expect(container.textContent).toContain("open failed once");
		expect(container.textContent).toContain("What can I take off your plate?");
		expect(container.textContent).not.toContain("ArcMind Code");
		await act(async () => root.unmount());
	});

	it("keeps the current session synchronized when reopening it fails", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		const store = new AppStore();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={store} />));
		await flush();
		expect(store.getSnapshot().syncStatus).toBe("ready");
		vi.mocked(api.openSession).mockRejectedValueOnce(new Error("reopen failed"));

		await act(async () => button(container, "Chat project task").click());
		await flush();

		expect(container.textContent).toContain("reopen failed");
		expect(store.getSnapshot().activeSessionId).toBe("chat-existing");
		expect(store.getSnapshot().syncStatus).toBe("ready");
		expect(localStorage.getItem("arcmind.activeSessionId.chat")).toBe("chat-existing");
		await act(async () => root.unmount());
	});

	it("keeps unrelated navigation enabled while a model change is pending", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		let resolveChange!: () => void;
		vi.mocked(api.setModel).mockImplementationOnce(() => new Promise<void>((resolve) => {
			resolveChange = resolve;
		}));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Select model").click());
		const otherModel = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
			.find((candidate) => candidate.textContent?.includes("Other model"));
		if (!otherModel) throw new Error("Missing Other model option");
		act(() => otherModel.click());
		await flush();

		expect(button(container, "Select model").disabled).toBe(true);
		expect(container.querySelectorAll(".session-sidebar button:disabled")).toHaveLength(0);
		for (const label of ["Chat", "Code", "New task", "Skills", "Chat project task"]) {
			expect(button(container, label).disabled, label).toBe(false);
		}

		await act(async () => resolveChange());
		expect(button(container, "Select model").disabled).toBe(false);
		await act(async () => root.unmount());
	});

	it("keeps unrelated navigation enabled while another session is opening", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		const first = session("chat-existing", "chat", "/work/chat-project", "Chat project task");
		const second = session("chat-other", "chat", "/work/chat-project", "Other chat task");
		const { api } = createHarness({ sessions: [first, second] });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		let resolveOpen!: (value: SessionSnapshot) => void;
		vi.mocked(api.openSession).mockImplementationOnce(() => new Promise((resolve) => {
			resolveOpen = resolve;
		}));

		act(() => button(container, "Other chat task").click());
		await flush();

		expect(container.textContent).toContain("Chat project task");
		expect(container.querySelectorAll(".session-sidebar button:disabled")).toHaveLength(0);
		for (const label of ["Chat", "Code", "New task", "Skills", "Chat project task"]) {
			expect(button(container, label).disabled, label).toBe(false);
		}

		await act(async () => resolveOpen(snapshot(second)));
		expect(container.querySelector('[data-active-session-id="chat-other"]')).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("resnapshots the current session when events race with a failed open", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		const { api, emitEvent } = createHarness();
		const store = new AppStore();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={store} />));
		await flush();
		let rejectOpen!: (error: Error) => void;
		vi.mocked(api.openSession).mockImplementationOnce(
			() => new Promise((_resolve, reject) => {
				rejectOpen = reject;
			}),
		);

		act(() => button(container, "Chat project task").click());
		emitEvent({
			type: "app-server",
			envelope: {
				jsonrpc: "2.0",
				method: "connection/events",
				params: {
					serverEpoch: EPOCH,
					fromCursor: 1,
					toCursor: 1,
					events: [{ type: "server/state", state: "ready" }],
				},
			},
		});
		expect(store.getSnapshot().syncStatus).toBe("resnapshot_required");
		await act(async () => rejectOpen(new Error("switch failed")));
		await flush();

		expect(api.openSession).toHaveBeenCalledTimes(3);
		expect(api.openSession).toHaveBeenLastCalledWith({ sessionId: "chat-existing" });
		expect(store.getSnapshot().syncStatus).toBe("ready");
		expect(container.textContent).toContain("switch failed");
		await act(async () => root.unmount());
	});

	it("keeps the Chat home visible when restoring its remembered session fails", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.code", "code-existing");
		const { api } = createHarness({ failOpenSessionIds: ["chat-existing"] });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		expect(container.querySelector(".mode-switch")?.getAttribute("data-mode")).toBe("chat");
		expect(container.querySelectorAll(".mode-switch-indicator")).toHaveLength(1);

		await act(async () => button(container, "Code").click());
		await flush();
		expect(container.querySelector(".mode-switch")?.getAttribute("data-mode")).toBe("code");
		await act(async () => button(container, "Chat").click());
		await flush();

		expect(container.textContent).toContain("open failed once");
		expect(container.textContent).toContain("What can I take off your plate?");
		expect(container.textContent).not.toContain("ArcMind Code");
		await act(async () => root.unmount());
	});

	it("does not flash the mode home while restoring its remembered session", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		localStorage.setItem("arcmind.activeSessionId.code", "code-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		expect(container.textContent).toContain("Chat project task");

		let resolveCodeOpen!: (value: SessionSnapshot) => void;
		vi.mocked(api.openSession).mockImplementationOnce(() => new Promise((resolve) => {
			resolveCodeOpen = resolve;
		}));
		act(() => button(container, "Code").click());

		expect(container.textContent).toContain("Chat project task");
		expect(container.textContent).not.toContain("ArcMind Code");

		await act(async () => resolveCodeOpen(snapshot(session("code-existing", "code", "/work/code-project", "Code project task"))));
		expect(container.textContent).toContain("Code project task");
		await act(async () => root.unmount());
	});

	it("does not expose a draft composer while the remembered session is bootstrapping", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		let resolveOpen!: (value: SessionSnapshot) => void;
		vi.mocked(api.openSession).mockImplementationOnce(
			() => new Promise((resolve) => {
				resolveOpen = resolve;
			}),
		);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		expect(container.textContent).not.toContain("What can I take off your plate?");
		expect(container.querySelector("#composer-input")).toBeNull();

		await act(async () => resolveOpen(snapshot(session("chat-existing", "chat", "/work/chat-project", "Chat project task"))));
		expect(container.querySelector('[data-active-session-id="chat-existing"]')).not.toBeNull();
		expect(container.querySelector("#composer-input")).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("shows an interaction required to finish remembered-session bootstrapping", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");
		const { api, emitEvent } = createHarness();
		vi.mocked(api.openSession).mockImplementationOnce(() => new Promise(() => undefined));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		act(() => emitEvent({
			type: "app-server",
			envelope: {
				jsonrpc: "2.0",
				id: "00000000-0000-4000-8000-000000000201",
				method: "interaction/request",
				params: {
					serverEpoch: EPOCH,
					interaction: {
						interactionId: "00000000-0000-4000-8000-000000000202",
						sessionId: "chat-existing",
						title: "Trust this project?",
						message: "Project resources can execute code.",
						createdAt: "2026-07-20T00:00:00.000Z",
						kind: "project_trust",
						projectPath: "/work/chat-project",
						choices: [{ id: "trust-once", label: "Trust (this session only)" }],
					},
				},
			},
		}));

		expect(container.textContent).toContain("Trust this project?");
		expect(container.textContent).not.toContain("What can I take off your plate?");
		expect(container.querySelector("#composer-input")).toBeNull();
		await act(async () => root.unmount());
	});

	it("restores the remembered session per mode and keeps Skills visual-only", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("arcmind.activeSessionId.code", "code-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		localStorage.setItem("arcmind.activeSessionId.chat", "chat-existing");

		await act(async () => button(container, "Code").click());
		await flush();
		expect(container.textContent).toContain("Code project task");
		expect(container.textContent).not.toContain("Chat project task");
		expect(api.openSession).toHaveBeenLastCalledWith({ sessionId: "code-existing" });
		expect(container.textContent).toContain("Test model");
		expect(container.querySelector('[aria-label="Add to message"]')).not.toBeNull();

		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Hide sessions sidebar"]')!.click());
		expect(container.querySelector(".session-sidebar")).toBeNull();
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Show sessions sidebar"]')!.click());
		expect(container.querySelector(".session-sidebar")).not.toBeNull();
		expect(container.querySelector('[aria-label="Search"]')).not.toBeNull();
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Show tools sidebar"]')!.click());
		expect(container.textContent).toContain("审阅");
		expect(container.textContent).toContain("文件");
		expect(container.textContent).toContain("Subagent");

		const backendCalls = vi.mocked(api.createSession).mock.calls.length + vi.mocked(api.openSession).mock.calls.length;
		await act(async () => button(container, "Skills").click());
		expect(container.textContent).toContain("Skills included with ArcMind");
		expect(vi.mocked(api.createSession).mock.calls.length + vi.mocked(api.openSession).mock.calls.length).toBe(backendCalls);

		await act(async () => button(container, "Chat").click());
		await flush();
		expect(api.openSession).toHaveBeenLastCalledWith({ sessionId: "chat-existing" });
		expect(container.textContent).toContain("Chat project task");
		expect(container.textContent).not.toContain("Code project task");
		expect(container.textContent).toContain("终端");
		expect(container.textContent).toContain("浏览器");
		expect(container.textContent).toContain("侧边任务");
		expect(container.textContent).not.toContain("审阅");
		expect(container.textContent).not.toContain("文件");
		expect(container.textContent).not.toContain("Subagent");
		expect(container.querySelector('[aria-label="Add to message"]')).not.toBeNull();
		await act(async () => root.unmount());
	});
});
