// @vitest-environment jsdom

import type { ClientResult, ScheduleTaskView, SessionSnapshot, SessionSummary } from "@metis/app-protocol";
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	App,
	firstInteractionForSession,
	sessionDisplayTitle,
	titleFromPrompt,
} from "../src/renderer/components/App.tsx";
import { buildSessionTree, clampSessionSidebarWidth } from "../src/renderer/components/SessionSidebar.tsx";
import { SkillsPanel } from "../src/renderer/components/SkillsPanel.tsx";
import { setLocale } from "../src/renderer/i18n.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";
import {
	loadProjectPreferences,
	removeProjectPreference,
	saveProjectPreferences,
	setProjectAlias,
	setProjectPinned,
} from "../src/renderer/store/project-preferences.ts";
import type { DesktopUpdateState, MetisDesktopApi } from "../src/shared/desktop-api.ts";

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
		unread: false,
	};
}

function scheduledTask(): ScheduleTaskView {
	return {
		id: "20000000-0000-4000-8000-000000000001",
		name: "Morning brief",
		description: "Calendar and inbox summary",
		instruction: "Summarize today's calendar.",
		model: { provider: "test-provider", modelId: "test-model" },
		schedule: { kind: "daily", time: "08:00" },
		timezone: "Asia/Shanghai",
		target: { kind: "general", workspace: "task" },
		status: "active",
		createdAt: "2026-08-01T00:00:00.000Z",
		updatedAt: "2026-08-01T00:00:00.000Z",
		nextRunAt: "2026-08-10T00:00:00.000Z",
		unreadCount: 0,
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
		tasks: [],
		thinkingSelection: "off",
		actualThinkingLevel: "off",
		availableThinkingSelections: ["off"],
		subagents: [],
		serverEpoch: EPOCH,
		cursor: 0,
	};
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
	const matches = (root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>("button")]
		.find((candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label);
	const match = matches(container) ?? matches(document.querySelector(".session-action-menu, .project-action-menu") ?? document.createDocumentFragment());
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

function codeEditor(container: ParentNode, label: string): EditorView {
	const content = [...container.querySelectorAll<HTMLElement>(".cm-content")]
		.find((element) => element.getAttribute("aria-label") === label);
	const editor = content?.closest<HTMLElement>(".cm-editor");
	const view = editor ? EditorView.findFromDOM(editor) : null;
	if (!view) throw new Error(`Missing CodeMirror editor: ${label}`);
	return view;
}

function changeCodeEditor(view: EditorView, value: string): void {
	view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
}

async function openTreeMenu(container: HTMLElement, title: string): Promise<void> {
	const label = [...container.querySelectorAll<HTMLElement>(".file-tree-row [title]")]
		.find((element) => element.title === title);
	const trigger = label?.closest(".file-tree-row")?.querySelector<HTMLButtonElement>(".file-tree-row-actions");
	if (!trigger) throw new Error(`Missing tree actions for ${title}`);
	await act(async () => trigger.click());
}

function createHarness(options: {
	failFirstOpen?: boolean;
	failOpenSessionIds?: readonly string[];
	loseFirstCreateResponse?: boolean;
	loseFirstStartResponse?: boolean;
	scheduleTasks?: readonly ScheduleTaskView[];
	sessions?: readonly SessionSummary[];
	updateState?: DesktopUpdateState;
} = {}) {
	localStorage.setItem(
		"metis.session-grouping.v1",
		localStorage.getItem("metis.session-grouping.v1") ?? '{"chat":"project","code":"project"}',
	);
	const chat = session("chat-existing", "chat", "/work/chat-project", "Chat project task");
	const code = session("code-existing", "code", "/work/code-project", "Code project task");
	let sessions = options.sessions ? [...options.sessions] : [chat, code];
	let failFirstOpen = options.failFirstOpen ?? false;
	let loseFirstCreateResponse = options.loseFirstCreateResponse ?? false;
	let loseFirstStartResponse = options.loseFirstStartResponse ?? false;
	let scheduleTasks = [...(options.scheduleTasks ?? [])];
	const failOpenSessionIds = new Set(options.failOpenSessionIds ?? []);
	const createdByRequestId = new Map<string, SessionSummary>();
	const order: string[] = [];
	let subscriber: Parameters<MetisDesktopApi["subscribe"]>[0] | undefined;
	const terminalSubscribers = new Set<Parameters<MetisDesktopApi["subscribeTerminal"]>[0]>();
	const browserSubscribers = new Set<Parameters<MetisDesktopApi["subscribeBrowser"]>[0]>();
	const updateSubscribers = new Set<Parameters<MetisDesktopApi["subscribeUpdate"]>[0]>();
	let updateState = options.updateState ?? { status: "unavailable" as const };
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
		getProfile: vi.fn().mockResolvedValue({
			generatedAt: "2026-08-01T12:00:00.000Z",
			totalTokens: 1200,
			peakDailyTokens: 600,
			longestSessionMs: 3_600_000,
			currentStreakDays: 1,
			longestStreakDays: 2,
			sessionCount: 2,
			usedSkillCount: 1,
			skillUseCount: 3,
			activity: [{ date: "2026-08-01", tokens: 600 }],
			topSkills: [{ name: "pdf", count: 3 }],
		}),
		listModels: vi.fn().mockResolvedValue({ models: [] }),
		createSchedule: vi.fn(),
		listSchedules: vi.fn(async () => ({ tasks: scheduleTasks, nextAfterTaskId: null, unreadCount: 0 })),
		getSchedule: vi.fn(),
		updateSchedule: vi.fn(),
		pauseSchedule: vi.fn(),
		resumeSchedule: vi.fn(),
		deleteSchedule: vi.fn(async ({ taskId, deleteSessions }) => {
			scheduleTasks = scheduleTasks.filter((task) => task.id !== taskId);
			const ownedSessionCount = sessions.filter((session) => session.scheduled?.taskId === taskId).length;
			if (deleteSessions) sessions = sessions.filter((session) => session.scheduled?.taskId !== taskId);
			return {
				taskId,
				deleted: true as const,
				deletedSessionCount: deleteSessions ? ownedSessionCount : 0,
				retainedSessionCount: deleteSessions ? 0 : ownedSessionCount,
			};
		}),
		runScheduleNow: vi.fn(),
		listScheduleRuns: vi.fn().mockResolvedValue({ runs: [], nextBeforeRunId: null }),
		getScheduleRun: vi.fn(),
		markScheduleRunRead: vi.fn(),
		subscribeSchedule: vi.fn().mockResolvedValue({
			snapshot: { serverEpoch: EPOCH, tasks: scheduleTasks, unreadCount: 0, cursor: 0 },
		}),
		unsubscribeSchedule: vi.fn().mockResolvedValue({ unsubscribed: true }),
		setScheduleKeepAwake: vi.fn().mockResolvedValue(undefined),
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
		getDefaultProjectLocation: vi.fn().mockResolvedValue("/Users/test/Metis Projects"),
		createProjectFolder: vi.fn(async ({ parentDirectory, name }) => `${parentDirectory}/${name}`),
		createTerminal: vi.fn(async (input) => ({
			terminalId: input.terminalId,
			pid: 1234,
			cwd: input.cwd,
			shell: "/bin/zsh",
		})),
		writeTerminal: vi.fn().mockResolvedValue(undefined),
		resizeTerminal: vi.fn().mockResolvedValue(undefined),
		closeTerminal: vi.fn().mockResolvedValue(undefined),
		subscribeTerminal: vi.fn((listener) => {
			terminalSubscribers.add(listener);
			return () => terminalSubscribers.delete(listener);
		}),
		createBrowser: vi.fn(async (input) => ({
			browserId: input.browserId,
			url: "",
			title: "New tab",
			faviconUrl: null,
			loading: false,
			canGoBack: false,
			canGoForward: false,
			zoomPercent: 100,
		})),
		captureBrowserPreview: vi.fn().mockResolvedValue("data:image/png;base64,cHJldmlldw=="),
		controlBrowser: vi.fn().mockResolvedValue(undefined),
		closeBrowser: vi.fn().mockResolvedValue(undefined),
		subscribeBrowser: vi.fn((listener) => {
			browserSubscribers.add(listener);
			return () => browserSubscribers.delete(listener);
		}),
		listWorkspaceDirectory: vi.fn(async ({ relativePath }) => relativePath === "docs"
			? [{ name: "guide.md", relativePath: "docs/guide.md", kind: "file" as const }]
			: [
				{ name: "docs", relativePath: "docs", kind: "directory" as const },
				{ name: ".env", relativePath: ".env", kind: "file" as const },
				{ name: "notes.txt", relativePath: "notes.txt", kind: "file" as const },
				{ name: "README.md", relativePath: "README.md", kind: "file" as const },
			]),
		searchWorkspaceFiles: vi.fn().mockResolvedValue(["docs/guide.md"]),
		getWorkspaceReview: vi.fn().mockResolvedValue({
			kind: "review" as const,
			repositoryRoot: "/work/code-project",
			branch: "main",
			head: null,
			revision: "working-tree" as const,
			files: [],
			commits: [],
		}),
		getWorkspaceReviewFileDiff: vi.fn().mockResolvedValue({ kind: "text" as const, patch: "" }),
		readWorkspaceFile: vi.fn(async ({ relativePath }) => ({
			kind: "text" as const,
			relativePath,
			absolutePath: `/work/code-project/${relativePath}`,
			byteLength: 24,
			text: relativePath.endsWith(".md") ? `# ${relativePath}\n\nWorkspace preview.` : `contents of ${relativePath}`,
			revision: "a".repeat(64),
		})),
		writeWorkspaceFile: vi.fn(async ({ text }) => ({ revision: "b".repeat(64), byteLength: new TextEncoder().encode(text).byteLength })),
		openWorkspaceFile: vi.fn().mockResolvedValue(undefined),
		mutateWorkspaceEntry: vi.fn(async (input) => {
			if (input.action === "create") {
				const relativePath = input.parentRelativePath ? `${input.parentRelativePath}/${input.name}` : input.name;
				return { action: "create" as const, kind: input.kind, relativePath, absolutePath: `/work/code-project/${relativePath}` };
			}
			if (input.action === "trash") {
				return {
					action: "trash" as const,
					kind: "file" as const,
					previousRelativePath: input.relativePath,
					previousAbsolutePath: `/work/code-project/${input.relativePath}`,
				};
			}
			const name = input.action === "rename" ? input.name : input.relativePath.split("/").at(-1)!;
			const parent = input.action === "rename"
				? input.relativePath.split("/").slice(0, -1).join("/")
				: input.destinationDirectoryRelativePath;
			const relativePath = parent ? `${parent}/${name}` : name;
			return {
				action: input.action,
				kind: "file" as const,
				previousRelativePath: input.relativePath,
				previousAbsolutePath: `/work/code-project/${input.relativePath}`,
				relativePath,
				absolutePath: `/work/code-project/${relativePath}`,
			};
		}),
		writeClipboardText: vi.fn().mockResolvedValue(undefined),
		setWorkspaceEditState: vi.fn().mockResolvedValue(undefined),
		getUpdateState: vi.fn(async () => updateState),
		startUpdate: vi.fn().mockResolvedValue(undefined),
		subscribeUpdate: vi.fn((listener) => {
			updateSubscribers.add(listener);
			return () => updateSubscribers.delete(listener);
		}),
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
		markSessionRead: vi.fn(async ({ sessionId }) => {
			const current = sessions.find((candidate) => candidate.sessionId === sessionId);
			if (!current) throw new Error("missing session");
			const read = { ...current, unread: false };
			sessions = sessions.map((candidate) => candidate.sessionId === sessionId ? read : candidate);
			return { session: read };
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
		interruptSubagent: vi.fn().mockResolvedValue({}),
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
	} as unknown as MetisDesktopApi;
	return {
		api,
		emitBrowser: (event: Parameters<MetisDesktopApi["subscribeBrowser"]>[0] extends (event: infer Event) => void ? Event : never) => {
			for (const listener of browserSubscribers) listener(event);
		},
		emitEvent: (event: Parameters<NonNullable<typeof subscriber>>[0]) => subscriber?.(event),
		emitUpdate: (state: DesktopUpdateState) => {
			updateState = state;
			for (const listener of updateSubscribers) listener(state);
		},
		order,
	};
}

beforeEach(async () => {
	await setLocale("en");
});

afterEach(() => {
	vi.restoreAllMocks();
	localStorage.clear();
	document.body.replaceChildren();
});

describe("Chat desktop shell", () => {
	it("resizes the sessions sidebar and restores its preferred width after window resizing", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const originalInnerWidth = window.innerWidth;
		Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_800 });
		localStorage.setItem("metis.session-sidebar-width.v1", "560");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			expect(clampSessionSidebarWidth(286)).toBe(286);
			await act(async () => root.render(<App api={api} store={new AppStore()} />));
			await flush();
			expect(container.querySelector<HTMLElement>(".app-shell")?.style.getPropertyValue("--sidebar-width")).toBe("560px");
			const resizer = container.querySelector<HTMLElement>('[role="separator"][aria-label="Resize sessions sidebar"]')!;
			Object.defineProperties(resizer, {
				hasPointerCapture: { configurable: true, value: () => false },
				setPointerCapture: { configurable: true, value: vi.fn() },
			});
			const pointer = (type: string, clientX: number) => {
				const event = new Event(type, { bubbles: true });
				Object.defineProperties(event, {
					clientX: { value: clientX },
					pointerId: { value: 1 },
				});
				return event;
			};
			await act(async () => resizer.dispatchEvent(pointer("pointerdown", 560)));
			await act(async () => resizer.dispatchEvent(pointer("pointermove", 544)));
			expect(container.querySelector<HTMLElement>(".app-shell")?.style.getPropertyValue("--sidebar-width")).toBe("544px");
			expect(localStorage.getItem("metis.session-sidebar-width.v1")).toBe("560");
			await act(async () => resizer.dispatchEvent(pointer("pointerup", 544)));
			expect(localStorage.getItem("metis.session-sidebar-width.v1")).toBe("544");

			Object.defineProperty(window, "innerWidth", { configurable: true, value: 720 });
			await act(async () => window.dispatchEvent(new Event("resize")));
			expect(container.querySelector<HTMLElement>(".app-shell")?.style.getPropertyValue("--sidebar-width")).toBe("240px");
			expect(localStorage.getItem("metis.session-sidebar-width.v1")).toBe("544");

			Object.defineProperty(window, "innerWidth", { configurable: true, value: 1_800 });
			await act(async () => window.dispatchEvent(new Event("resize")));
			expect(container.querySelector<HTMLElement>(".app-shell")?.style.getPropertyValue("--sidebar-width")).toBe("544px");
		} finally {
			await act(async () => root.unmount());
			Object.defineProperty(window, "innerWidth", { configurable: true, value: originalInnerWidth });
		}
	});

	it("groups each mode independently from the nested Date, Project, Unread, or None menu", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const now = new Date();
		const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12);
		const sessions = [
			{ ...session("chat-today", "chat", "/work/shared", "Today unread"), updatedAt: now.toISOString(), unread: true },
			{ ...session("chat-yesterday", "chat", "/work/shared", "Yesterday read"), updatedAt: yesterday.toISOString() },
			{ ...session("code-today", "code", "/work/shared", "Code today"), updatedAt: now.toISOString() },
		];
		const { api } = createHarness({ sessions });
		localStorage.removeItem("metis.session-grouping.v1");
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		expect(button(container, "Group sessions")).toBeTruthy();
		expect(button(container, "Today").getAttribute("aria-expanded")).toBe("true");
		expect(button(container, "Yesterday")).toBeTruthy();
		expect(button(container, "Today unread").querySelector(".session-button-title i")?.className).toBe("unread");
		await act(async () => button(container, "Today").click());
		expect(button(container, "Today").getAttribute("aria-expanded")).toBe("false");
		expect(button(container, "Today").closest(".session-section")?.querySelector(".session-section-drawer")?.hasAttribute("inert")).toBe(true);

		await act(async () => button(container, "Group sessions").click());
		expect(button(document.body, "Group by Date")).toBeTruthy();
		await act(async () => button(document.body, "Group by Date").click());
		await act(async () => menuOption(document.body, "Unread").click());
		expect(button(container, "Unread")).toBeTruthy();
		expect(button(container, "Read")).toBeTruthy();

		await act(async () => button(container, "Group sessions").click());
		await act(async () => button(document.body, "Group by Unread").click());
		await act(async () => menuOption(document.body, "Project").click());
		expect(projectRow(container, "/work/shared")).toBeTruthy();
		expect(container.querySelector(".session-grouping-label")?.textContent).toBe("Projects");
		expect(localStorage.getItem("metis.session-grouping.v1")).toBe('{"chat":"project","code":"date"}');

		await act(async () => button(container, "Code").click());
		await flush();
		expect(button(container, "Group sessions")).toBeTruthy();
		expect(container.querySelector(".project-heading")).toBeNull();
		expect(localStorage.getItem("metis.session-grouping.v1")).toBe('{"chat":"project","code":"date"}');

		await act(async () => button(container, "Group sessions").click());
		await act(async () => button(document.body, "Group by Date").click());
		await act(async () => menuOption(document.body, "None").click());
		expect(container.querySelector(".session-section")).toBeNull();
		expect(container.querySelectorAll(".session-row")).toHaveLength(1);
		expect(localStorage.getItem("metis.session-grouping.v1")).toBe('{"chat":"project","code":"none"}');

		await act(async () => root.unmount());
	});

	it("keeps session and project action menus outside clipping sidebar containers", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.session-grouping.v1", '{"chat":"date","code":"date"}');
		const bottom = { bottom: 754, height: 24, left: 260, right: 284, top: 730, width: 24, x: 260, y: 730, toJSON: () => ({}) } as DOMRect;
		const { api } = createHarness({ sessions: [session("chat-bottom", "chat", "/work/bottom", "Bottom task")] });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		const sessionRow = button(container, "Bottom task").closest<HTMLElement>(".session-row")!;
		const sessionTrigger = button(sessionRow, "Actions for Bottom task");
		vi.spyOn(sessionTrigger, "getBoundingClientRect").mockReturnValue(bottom);
		await act(async () => sessionTrigger.click());
		const sessionMenu = document.body.querySelector<HTMLElement>('[role="menu"][aria-label="Bottom task session actions"]')!;
		expect(sessionMenu).not.toBeNull();
		expect(sessionRow.contains(sessionMenu)).toBe(false);
		expect(sessionMenu.style.position).toBe("fixed");
		expect(Number.parseFloat(sessionMenu.style.top)).toBeLessThan(bottom.top);
		await act(async () => window.dispatchEvent(new Event("scroll")));
		expect(document.body.contains(sessionMenu)).toBe(true);
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

		await act(async () => button(container, "Group sessions").click());
		await act(async () => button(document.body, "Group by Date").click());
		await act(async () => menuOption(document.body, "Project").click());
		const group = projectRow(container, "/work/bottom");
		const projectTrigger = button(group, "Project actions");
		vi.spyOn(projectTrigger, "getBoundingClientRect").mockReturnValue(bottom);
		await act(async () => projectTrigger.click());
		const projectMenu = document.body.querySelector<HTMLElement>('[role="menu"][aria-label="bottom project actions"]')!;
		expect(projectMenu).not.toBeNull();
		expect(group.contains(projectMenu)).toBe(false);
		expect(projectMenu.style.position).toBe("fixed");
		expect(Number.parseFloat(projectMenu.style.top)).toBeLessThan(bottom.top);
		await act(async () => window.dispatchEvent(new Event("scroll")));
		expect(document.body.contains(projectMenu)).toBe(true);
		await act(async () => root.unmount());
	});

	it("restores Keep Awake during bootstrap without opening Scheduled tasks", async () => {
		localStorage.setItem("metis.scheduleKeepAwake.v1", "true");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		expect(api.setScheduleKeepAwake).toHaveBeenCalledWith(true);
		await act(async () => root.unmount());
	});

	it("shows Scheduled tasks only in Chat mode", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		expect(button(container, "Scheduled tasks")).toBeTruthy();
		await act(async () => button(container, "Code").click());
		expect([...container.querySelectorAll("button")].some((candidate) => candidate.textContent?.trim() === "Scheduled tasks")).toBe(false);
		await act(async () => root.unmount());
	});

	it("opens the personal profile from the Metis Settings menu", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Metis").click());
		expect(document.activeElement?.textContent).toBe("Settings");
		await act(async () => button(container, "Settings").click());
		await flush();
		expect(api.getProfile).toHaveBeenCalledTimes(1);
		expect(container.textContent).toContain("Personal profile");
		expect(container.textContent).toContain("Most used Skills");
		expect(container.querySelector('[role="dialog"][aria-label="Settings"]')).not.toBeNull();
		expect(container.querySelector(".app-shell")?.hasAttribute("inert")).toBe(true);
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
		expect(container.querySelector('[role="dialog"][aria-label="Settings"]')).toBeNull();
		await act(async () => root.unmount());
	});

	it("shows the update action above Metis only when a newer version is available", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api, emitUpdate } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		expect(container.querySelector(".sidebar-update-notice")).toBeNull();

		await act(async () => emitUpdate({ status: "available", version: "0.81.0" }));
		const notice = container.querySelector<HTMLElement>(".sidebar-update-notice")!;
		expect(notice.nextElementSibling?.classList.contains("sidebar-footer")).toBe(true);
		const update = button(notice, "Update to new version");
		expect(update.querySelector("svg")).not.toBeNull();
		await act(async () => update.click());
		expect(api.startUpdate).toHaveBeenCalledOnce();

		await act(async () => emitUpdate({ status: "downloading", version: "0.81.0", progress: 42 }));
		expect(button(notice, "Downloading update 42%").disabled).toBe(true);
		await act(async () => emitUpdate({ status: "ready", version: "0.81.0" }));
		expect(button(notice, "Open installer").disabled).toBe(false);

		await act(async () => root.unmount());
	});

	it("creates a folder-bound Chat and sends the assisted schedule prompt", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		api.listModels = vi.fn().mockResolvedValue({
			models: [{ provider: "test-provider", modelId: "test-model", name: "Test model" }],
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Scheduled tasks").click());
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
		await act(async () => button(container, "Create scheduled task").click());
		const assisted = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
			.find((candidate) => candidate.textContent?.trim() === "Create with Metis")!;
		await act(async () => assisted.click());
		const chooseFolder = [...container.querySelectorAll<HTMLButtonElement>("dialog button")]
			.find((candidate) => candidate.textContent?.includes("Choose folder"))!;
		await act(async () => chooseFolder.click());
		await flush();
		await flush();

		expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({
			mode: "chat",
			cwd: "/work/selected-project",
			name: "Set up a scheduled task",
		}));
		expect(api.startTurn).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "chat-created",
			text: "I want to set up a scheduled task. Briefly explain how scheduled tasks work in Metis, then ask me a few concise questions to determine what it should do, when it should run, and whether it should use an available Skill. Do not create the task until I confirm the details.",
		}));
		await act(async () => root.unmount());
	});

	it("uses a managed Chat when assisted schedule setup skips folder selection", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		api.listModels = vi.fn().mockResolvedValue({
			models: [{ provider: "test-provider", modelId: "test-model", name: "Test model" }],
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Scheduled tasks").click());
		await act(async () => { await new Promise((resolve) => setTimeout(resolve, 220)); });
		await act(async () => button(container, "Create scheduled task").click());
		const assisted = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
			.find((candidate) => candidate.textContent?.trim() === "Create with Metis")!;
		await act(async () => assisted.click());
		const useDefault = [...container.querySelectorAll<HTMLButtonElement>("dialog button")]
			.find((candidate) => candidate.textContent?.includes("Use default workspace"))!;
		await act(async () => useDefault.click());
		await flush();
		await flush();

		const create = vi.mocked(api.createSession).mock.calls[0]![0];
		expect(create).toMatchObject({ mode: "chat", name: "Set up a scheduled task" });
		expect(create).not.toHaveProperty("cwd");
		expect(api.selectProjectFolder).not.toHaveBeenCalled();
		expect(api.startTurn).toHaveBeenCalledTimes(1);
		await act(async () => root.unmount());
	});

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
			localStorage.setItem("metis.projectPreferences.v1", value);
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
		expect([...document.body.querySelectorAll(".project-action-menu [role=menuitem]")].map((item) => item.textContent?.trim())).toEqual([
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
		expect(localStorage.getItem("metis.activeSessionId.chat")).toBe("chat-created");

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
		localStorage.setItem("metis.activeSessionId.chat", unnamed.sessionId);
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

	it("groups scheduled tasks separately and deletes their generated sessions from the row action", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const ordinary = session("chat-session-ordinary", "chat", "/work/shared", "Ordinary task");
		const loose = { ...session("chat-session-loose", "chat", "/work/managed", "Loose task"), cwdOrigin: "managed" as const };
		const task = scheduledTask();
		const scheduledRun = {
			...session("chat-session-scheduled", "chat", "/work/shared", "Generated run"),
			scheduled: { taskId: task.id, runId: "30000000-0000-4000-8000-000000000001" },
		};
		const retainedScheduledRun = {
			...session("chat-session-retained", "chat", "/work/retained", "检查桌面文件"),
			scheduled: {
				taskId: "40000000-0000-4000-8000-000000000001",
				runId: "50000000-0000-4000-8000-000000000001",
			},
		};
		localStorage.setItem("metis.activeSessionId.chat", ordinary.sessionId);
		const { api, emitEvent } = createHarness({
			sessions: [ordinary, loose, scheduledRun, retainedScheduledRun],
			scheduleTasks: [task],
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		expect(container.querySelector(".scheduled-task-quick-list h2")?.textContent).toBe("Scheduled tasks");
		expect(container.textContent).not.toContain("Generated run");
		const sessionList = container.querySelector<HTMLElement>(".project-list")!;
		const scheduledSection = container.querySelector<HTMLElement>(".scheduled-task-quick-list")!;
		expect(sessionList.contains(scheduledSection)).toBe(true);
		expect([
			...sessionList.querySelectorAll(":scope > .session-grouping-label, :scope > .loose-tasks > h2, :scope > .scheduled-task-quick-list > h2"),
		].map((element) => element.textContent)).toEqual(["Projects", "Tasks", "Scheduled tasks"]);
		const retainedRow = button(scheduledSection, "检查桌面文件").closest<HTMLElement>(".session-row")!;
		expect(retainedRow.querySelector(".session-scheduled-badge")).toBeNull();
		expect(container.querySelector(".loose-tasks")?.textContent ?? "").not.toContain("检查桌面文件");
		await act(async () => button(retainedRow, "Actions for 检查桌面文件").click());
		expect([...document.body.querySelectorAll(".session-action-menu [role=menuitem]")].map((item) => item.textContent?.trim())).toEqual(["Delete"]);
		await act(async () => button(document.body, "Delete").click());
		await flush();
		await act(async () => button(container, "Move to Trash").click());
		await flush();
		expect(api.deleteSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: retainedScheduledRun.sessionId }));
		expect(scheduledSection.textContent).not.toContain("检查桌面文件");
		const row = button(container, task.name).closest<HTMLElement>(".scheduled-task-quick-row")!;
		expect(row).not.toBeNull();
		await act(async () => button(row, `Actions for ${task.name}`).click());
		expect(document.body.querySelector(".session-action-menu")?.textContent?.trim()).toBe("Delete");
		await act(async () => button(document.body, "Delete").click());
		expect(container.querySelector('.scheduled-task-delete-option input[type="checkbox"]')).toBeNull();
		expect(container.querySelector(".scheduled-task-delete-dialog")?.textContent).toContain(
			"Moves generated Scheduled sessions",
		);
		await act(async () => button(container, "Delete").click());
		await flush();

		expect(api.deleteSchedule).toHaveBeenCalledWith(expect.objectContaining({
			taskId: task.id,
			deleteSessions: true,
		}));
		await act(async () => emitEvent({
			type: "app-server",
			envelope: {
				jsonrpc: "2.0",
				method: "connection/events",
				params: {
					serverEpoch: EPOCH,
					fromCursor: 1,
					toCursor: 1,
					events: [{ type: "session/invalidated", sessionId: scheduledRun.sessionId, reason: "deleted" }],
				},
			},
		}));
		await flush();
		expect(container.textContent).not.toContain(task.name);
		expect(container.querySelector(".scheduled-task-quick-list")).toBeNull();
		expect(button(container, "Scheduled tasks")).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("renames and deletes ordinary sessions", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const active = session("chat-session-active", "chat", "/work/shared", "Active task");
		const other = session("chat-session-other", "chat", "/work/shared", "Other task");
		const running = { ...session("chat-session-running", "chat", "/work/shared", "Running task"), state: "running" as const };
		localStorage.setItem("metis.activeSessionId.chat", active.sessionId);
		const { api } = createHarness({ sessions: [active, other, running] });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		let otherRow = button(container, "Other task").closest<HTMLElement>(".session-row")!;
		await act(async () => button(otherRow, "Actions for Other task").click());
		expect([...document.body.querySelectorAll(".session-action-menu [role=menuitem]")].map((item) => item.textContent?.trim())).toEqual(["Rename", "Delete"]);
		await act(async () => button(document.body, "Rename").click());
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
		await act(async () => button(document.body, "Delete").click());
		await flush();
		expect(container.querySelector(".project-dialog")?.textContent).toContain("Project memory, Skills, schedules, other sessions, and source files are unchanged");
		await act(async () => button(container, "Move to Trash").click());
		await flush();
		expect(api.deleteSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: other.sessionId }));
		expect(container.textContent).not.toContain("Renamed task");
		expect(container.querySelector('[data-active-session-id="chat-session-active"]')).not.toBeNull();

		const runningRow = button(container, "Running task").closest<HTMLElement>(".session-row")!;
		await act(async () => button(runningRow, "Actions for Running task").click());
		expect(button(document.body, "Delete").disabled).toBe(true);
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

		const activeRow = button(container, "Active task").closest<HTMLElement>(".session-row")!;
		await act(async () => button(activeRow, "Actions for Active task").click());
		await act(async () => button(document.body, "Delete").click());
		await flush();
		await act(async () => button(container, "Move to Trash").click());
		await flush();
		expect(container.textContent).toContain("What can I take off your plate?");
		expect(localStorage.getItem("metis.activeSessionId.chat")).toBeNull();
		await act(async () => root.unmount());
	});

	it("reuses the session delete request id after a lost response", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const active = session("chat-delete-retry", "chat", "/work/retry", "Retry task");
		localStorage.setItem("metis.activeSessionId.chat", active.sessionId);
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
		localStorage.setItem("metis.activeSessionId.chat", chatActive.sessionId);
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
		expect(localStorage.getItem("metis.activeSessionId.chat")).toBeNull();
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
		localStorage.setItem("metis.activeSessionId.chat", chat.sessionId);
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
		expect(localStorage.getItem("metis.activeSessionId.chat")).toBe(chat.sessionId);
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
		expect(sessionDisplayTitle({ cwd: "/Users/example/.metis/agent/workspaces/session-id", cwdOrigin: "managed", name: "" })).toBe("Chat");
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

	it("docks permission approval above the active composer", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api, emitEvent } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		act(() => emitEvent({
			type: "app-server",
			envelope: {
				jsonrpc: "2.0",
				id: "00000000-0000-4000-8000-000000000203",
				method: "interaction/request",
				params: {
					serverEpoch: EPOCH,
					interaction: {
						interactionId: "00000000-0000-4000-8000-000000000204",
						sessionId: "chat-existing",
						title: "Approve bash?",
						message: "Remove the generated cache.\nRisk: destructive\nCommand: rm cache.tmp",
						createdAt: "2026-07-20T00:00:00.000Z",
						kind: "select",
						presentation: "permission_approval",
						operation: {
							toolName: "bash",
							rows: [
								{ label: "Command", value: "rm cache.tmp" },
								{ label: "Working directory", value: "/tmp/work" },
							],
							omittedRows: 0,
							scopeComplete: true,
							irreversible: true,
						},
						choices: [
							{ id: "choice:0", label: "Allow once" },
							{ id: "choice:1", label: "Deny" },
						],
					},
				},
			},
		}));

		const dock = container.querySelector<HTMLElement>(".composer-dock")!;
		const panel = container.querySelector<HTMLElement>(".permission-approval-panel")!;
		expect(panel).not.toBeNull();
		expect(dock.contains(panel)).toBe(true);
		expect(container.querySelector(".modal-backdrop")).toBeNull();
		expect(panel.textContent).toContain("Metis wants to use bash");
		expect(panel.textContent).toContain("Command");
		expect(panel.textContent).toContain("rm cache.tmp");
		expect(panel.textContent).toContain("Working directory");
		expect(panel.textContent).toContain("/tmp/work");
		expect(panel.textContent).not.toContain("Arguments:");
		await act(async () => button(panel, "Allow once").click());
		await flush();
		expect(api.respondToInteraction).toHaveBeenCalledWith({
			interactionId: "00000000-0000-4000-8000-000000000204",
			kind: "select",
			choiceId: "choice:0",
		});
		expect(container.querySelector(".permission-approval-panel")).toBeNull();
		await act(async () => root.unmount());
	});

	it("docks ask_user above the active composer and returns a structured answer", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api, emitEvent } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		act(() => emitEvent({
			type: "app-server",
			envelope: {
				jsonrpc: "2.0",
				id: "00000000-0000-4000-8000-000000000205",
				method: "interaction/request",
				params: {
					serverEpoch: EPOCH,
					interaction: {
						interactionId: "00000000-0000-4000-8000-000000000206",
						sessionId: "chat-existing",
						title: "Metis has questions",
						message: "Answer each question to continue.",
						createdAt: "2026-08-10T00:00:00.000Z",
						kind: "ask_user",
						questions: [{
							id: "question:0",
							question: "Where should the data be stored?",
							multiple: false,
							choices: [
								{ id: "choice:0", label: "Local" },
								{ id: "choice:1", label: "Cloud" },
							],
						}],
					},
				},
			},
		}));

		const dock = container.querySelector<HTMLElement>(".composer-dock")!;
		const panel = container.querySelector<HTMLElement>(".ask-user-panel")!;
		expect(panel).not.toBeNull();
		expect(dock.contains(panel)).toBe(true);
		expect(container.querySelector(".modal-backdrop")).toBeNull();
		expect(container.querySelector(".composer-dock > .ask-user-slot + .composer-chat")).not.toBeNull();
		expect(panel.textContent).toContain("Where should the data be stored?");
		expect(panel.textContent).toContain("Something else");

		await act(async () => [...panel.querySelectorAll<HTMLButtonElement>(".ask-user-option")]
			.find((candidate) => candidate.textContent?.includes("Cloud"))?.click());
		await flush();
		expect(api.respondToInteraction).toHaveBeenCalledWith({
			interactionId: "00000000-0000-4000-8000-000000000206",
			kind: "ask_user",
			cancelled: false,
			answers: [{ questionId: "question:0", choiceIds: ["choice:1"] }],
		});
		expect(container.querySelector(".ask-user-panel")).toBeNull();
		await act(async () => root.unmount());
	});

	it("filters the initial Chat tree and creates the real session only on first send", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
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
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
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
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
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
		expect(localStorage.getItem("metis.activeSessionId.chat")).toBeNull();
		expect(container.querySelector(".new-task-home")).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("removes a remotely deleted project while preserving the other mode", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
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
		expect(localStorage.getItem("metis.activeSessionId.chat")).toBeNull();
		expect(container.querySelector(".new-task-home")).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("marks opened and visibly completed sessions read but preserves background unread state", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const active = { ...session("chat-existing", "chat", "/work/chat-project", "Active"), unread: true };
		const background = session("chat-background", "chat", "/work/other", "Background");
		localStorage.setItem("metis.activeSessionId.chat", active.sessionId);
		const { api, emitEvent } = createHarness({ sessions: [active, background] });
		const store = new AppStore();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={store} />));
		await flush();

		expect(api.markSessionRead).toHaveBeenCalledWith({ sessionId: active.sessionId });
		expect(store.getSnapshot().sessionsById.get(active.sessionId)?.unread).toBe(false);
		vi.mocked(api.markSessionRead).mockClear();

		await act(async () =>
			emitEvent({
				type: "app-server",
				envelope: {
					jsonrpc: "2.0",
					method: "connection/events",
					params: {
						serverEpoch: EPOCH,
						fromCursor: 1,
						toCursor: 1,
						events: [{ type: "session/updated", session: { ...background, unread: true } }],
					},
				},
			}),
		);
		expect(api.markSessionRead).not.toHaveBeenCalled();
		expect(store.getSnapshot().sessionsById.get(background.sessionId)?.unread).toBe(true);

		await act(async () =>
			emitEvent({
				type: "app-server",
				envelope: {
					jsonrpc: "2.0",
					method: "connection/events",
					params: {
						serverEpoch: EPOCH,
						fromCursor: 2,
						toCursor: 2,
						events: [{ type: "session/updated", session: { ...active, unread: true } }],
					},
				},
			}),
		);
		await flush();
		expect(api.markSessionRead).toHaveBeenCalledWith({ sessionId: active.sessionId });
		expect(store.getSnapshot().sessionsById.get(active.sessionId)?.unread).toBe(false);
		await act(async () => root.unmount());
	});

	it("resnapshots the real permission after a partial downgrade failure", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
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
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
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
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
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
		expect(container.textContent).toContain("Choose a folder and Metis will treat its files as project context.");
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
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
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
		expect(container.textContent).toContain("/Users/test/Metis Projects");
		await act(async () => changeInput(container.querySelector<HTMLInputElement>("#code-project-name")!, "Desktop App"));
		await act(async () => container.querySelector<HTMLFormElement>(".code-project-form")!.requestSubmit());
		await flush();
		await flush();

		expect(api.createProjectFolder).toHaveBeenCalledWith({
			parentDirectory: "/Users/test/Metis Projects",
			name: "Desktop App",
			files: [],
		});
		expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({
			mode: "code",
			cwd: "/Users/test/Metis Projects/Desktop App",
		}));
		expect(api.startTurn).not.toHaveBeenCalled();
		await act(async () => root.unmount());
	});

	it("keeps the add menu in an existing Code session composer", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
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
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
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
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
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

		const textarea = container.querySelector("textarea")!;
		expect(button(container, "Stop task")).toBeTruthy();
		expect(container.querySelector('[aria-label="Steer task"]')).toBeNull();
		await act(async () => changeTextarea(textarea, "Follow up"));
		expect(container.querySelector('[aria-label="Stop task"]')).toBeNull();
		expect(button(container, "Steer task").disabled).toBe(false);
		await act(async () => changeTextarea(textarea, ""));
		expect(container.querySelector('[aria-label="Steer task"]')).toBeNull();
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
		expect(container.textContent).toContain("Skills included with Metis");
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
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
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
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
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
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
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
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
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
		expect(container.textContent).not.toContain("Metis Code");
		await act(async () => root.unmount());
	});

	it("keeps the current session synchronized when reopening it fails", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
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
		expect(localStorage.getItem("metis.activeSessionId.chat")).toBe("chat-existing");
		await act(async () => root.unmount());
	});

	it("keeps unrelated navigation enabled while a model change is pending", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
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
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
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
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
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
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
		const { api } = createHarness({ failOpenSessionIds: ["chat-existing"] });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		expect(container.querySelector(".mode-switch")?.getAttribute("data-mode")).toBe("chat");
		expect(container.querySelectorAll(".mode-switch-indicator")).toHaveLength(1);

		await act(async () => button(container, "Code").click());
		await flush();
		expect(container.querySelector(".mode-switch")?.getAttribute("data-mode")).toBe("code");
		await act(async () => button(container, "Chat").click());
		await flush();

		expect(container.textContent).toContain("open failed once");
		expect(container.textContent).toContain("What can I take off your plate?");
		expect(container.textContent).not.toContain("Metis Code");
		await act(async () => root.unmount());
	});

	it("does not flash the mode home while restoring its remembered session", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
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
		expect(container.textContent).not.toContain("Metis Code");

		await act(async () => resolveCodeOpen(snapshot(session("code-existing", "code", "/work/code-project", "Code project task"))));
		expect(container.textContent).toContain("Code project task");
		await act(async () => root.unmount());
	});

	it("does not expose a draft composer while the remembered session is bootstrapping", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
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
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
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
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");

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
		expect(container.textContent).toContain("Review");
		expect(container.textContent).toContain("Files");
		expect(container.textContent).toContain("Subagent");
		await act(async () => button(container, "Subagent").click());
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
		await act(async () => button(container, "Add tool").click());
		const subagentMenuItem = [...container.querySelectorAll<HTMLButtonElement>('.tool-add-menu [role="menuitem"]')]
			.find((candidate) => candidate.textContent?.includes("Subagent"))!;
		await act(async () => subagentMenuItem.click());
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);

		const backendCalls = vi.mocked(api.createSession).mock.calls.length + vi.mocked(api.openSession).mock.calls.length;
		await act(async () => button(container, "Skills").click());
		expect(container.textContent).toContain("Skills included with Metis");
		expect(vi.mocked(api.createSession).mock.calls.length + vi.mocked(api.openSession).mock.calls.length).toBe(backendCalls);

		await act(async () => button(container, "Chat").click());
		await flush();
		expect(api.openSession).toHaveBeenLastCalledWith({ sessionId: "chat-existing" });
		expect(container.textContent).toContain("Chat project task");
		expect(container.textContent).not.toContain("Code project task");
		expect(container.textContent).toContain("Terminal");
		expect(container.textContent).toContain("Browser");
		expect(container.textContent).not.toContain("Side tasks");
		expect(container.textContent).not.toContain("Review");
		expect(container.textContent).not.toContain("Files");
		expect(container.textContent).not.toContain("Subagent");
		expect(container.querySelector('[aria-label="Add to message"]')).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("opens independent terminal tabs and keeps them mounted while the sidebar is collapsed", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Show tools sidebar").click());
		await act(async () => button(container, "Terminal").click());
		await flush();
		expect(api.createTerminal).toHaveBeenCalledTimes(1);
		expect(api.createTerminal).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/work/chat-project" }));
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
		const toolSidebar = container.querySelector<HTMLElement>(".tool-sidebar")!;
		expect(button(toolSidebar, "Hide tools sidebar")).toBeTruthy();
		expect(container.querySelector('.workspace-titlebar-actions [aria-label="Hide tools sidebar"]')).toBeNull();
		expect([...container.querySelector<HTMLElement>(".tool-tabbar")!.children].map((child) => child.className)).toEqual([
			"tool-tabs-scroll",
			"tool-add",
		]);

		await act(async () => button(container, "Code").click());
		await flush();
		await act(async () => button(container, "Chat").click());
		await flush();
		expect(api.createTerminal).toHaveBeenCalledTimes(1);
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);

		await act(async () => button(container, "Hide tools sidebar").click());
		expect(container.querySelector(".tool-sidebar")?.hasAttribute("hidden")).toBe(true);
		await act(async () => button(container, "Show tools sidebar").click());
		expect(api.createTerminal).toHaveBeenCalledTimes(1);
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);

		await act(async () => button(container, "Add tool").click());
		const addMenu = container.querySelector<HTMLElement>(".tool-add-menu")!;
		await act(async () => button(addMenu, "Terminal").click());
		await flush();
		expect(api.createTerminal).toHaveBeenCalledTimes(2);
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);

		await act(async () => button(container, "Close Terminal 2").click());
		expect(api.closeTerminal).toHaveBeenCalledTimes(1);
		await act(async () => button(container, "Close Terminal").click());
		expect(api.closeTerminal).toHaveBeenCalledTimes(2);
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
		expect(container.querySelector(".tool-sidebar-menu")).not.toBeNull();

		await act(async () => root.unmount());
	});

	it("opens one Review tab in Code mode and reselects it instead of duplicating it", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Code").click());
		await flush();
		await act(async () => button(container, "Show tools sidebar").click());
		expect(container.querySelector(".tool-sidebar")?.textContent).toContain("Review");
		await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".tool-sidebar-menu button")]
			.find((candidate) => candidate.querySelector("span")?.textContent === "Review")!.click());
		await flush();
		expect(api.getWorkspaceReview).toHaveBeenCalledWith({ sessionId: "code-existing", revision: "working-tree" });
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
		expect(container.querySelector(".review-panel.is-visible")?.textContent).toContain("No changes");

		await act(async () => button(container, "Add tool").click());
		await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".tool-add-menu button")]
			.find((candidate) => candidate.querySelector("span")?.textContent === "Review")!.click());
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
		expect(api.getWorkspaceReview).toHaveBeenCalledTimes(1);
		await act(async () => button(container, "Close Review").click());
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
		await act(async () => root.unmount());
	});

	it("closes native tools and removes stored file state when a session is deleted", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		await act(async () => button(container, "Code").click());
		await flush();
		await act(async () => button(container, "Show tools sidebar").click());
		await act(async () => button(container, "Terminal").click());
		await flush();
		await act(async () => button(container, "Add tool").click());
		await act(async () => [...container.querySelectorAll<HTMLButtonElement>(".tool-add-menu button")]
			.find((candidate) => candidate.textContent?.includes("Browser"))!.click());
		await flush();
		await act(async () => button(container, "Add tool").click());
		await act(async () => button(container.querySelector<HTMLElement>(".tool-add-menu")!, "Files").click());
		await flush();
		await act(async () => container.querySelector<HTMLButtonElement>('.file-tree-row [title="README.md"]')!.click());
		await flush();
		expect(localStorage.getItem("metis.file-browser.v1:code-existing")).not.toBeNull();

		const activeRow = button(container, "Code project task").closest<HTMLElement>(".session-row")!;
		await act(async () => button(activeRow, "Actions for Code project task").click());
		await act(async () => button(activeRow, "Delete").click());
		await flush();
		await act(async () => button(container, "Move to Trash").click());
		await flush();

		expect(api.closeTerminal).toHaveBeenCalledWith({
			terminalId: vi.mocked(api.createTerminal).mock.calls[0]![0].terminalId,
		});
		expect(api.closeBrowser).toHaveBeenCalledWith({
			browserId: vi.mocked(api.createBrowser).mock.calls[0]![0].browserId,
		});
		expect(localStorage.getItem("metis.file-browser.v1:code-existing")).toBeNull();
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);
		await act(async () => root.unmount());
	});

	it("browses the active Code workspace with replaceable previews and fixed file tabs", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			x: 0, y: 0, top: 0, right: 320, bottom: 600, left: 0, width: 320, height: 600,
			toJSON: () => ({}),
		});
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		let root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		Object.defineProperty(container.querySelector(".workspace"), "clientWidth", { configurable: true, value: 1_200 });

		await act(async () => button(container, "Code").click());
		await flush();
		await act(async () => button(container, "Show tools sidebar").click());
		expect(container.querySelector<HTMLElement>(".tool-sidebar")?.style.width).toBe("528px");
		await act(async () => button(container, "Files").click());
		await flush();
		expect(api.listWorkspaceDirectory).toHaveBeenCalledWith({ sessionId: "code-existing", relativePath: "" });
		expect(container.querySelector('[role="tab"]')?.textContent).toContain("Open file");
		expect(container.querySelector('.file-tree-row [title=".env"]')).not.toBeNull();

		await act(async () => container.querySelector<HTMLButtonElement>('.file-tree-row [title="README.md"]')!.click());
		await flush();
		expect(api.readWorkspaceFile).toHaveBeenCalledWith({ sessionId: "code-existing", relativePath: "README.md" });
		expect(codeEditor(container, "Edit README.md").state.doc.toString()).toBe("# README.md\n\nWorkspace preview.");
		await act(async () => button(container, "Show preview").click());
		expect(container.querySelector(".file-markdown h1")?.textContent).toBe("README.md");
		await act(async () => button(container, "View source").click());
		expect(codeEditor(container, "Edit README.md").state.doc.toString()).toBe("# README.md\n\nWorkspace preview.");
		expect(container.querySelector(".tool-tab")?.classList.contains("is-preview")).toBe(true);

		await act(async () =>
			container.querySelector<HTMLButtonElement>('.file-tree-row [title="README.md"]')!
				.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
		);
		expect(container.querySelector(".tool-tab")?.classList.contains("is-preview")).toBe(false);
		await act(async () => container.querySelector<HTMLButtonElement>('.file-tree-row [title="notes.txt"]')!.click());
		await flush();
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
		expect(container.querySelectorAll(".tool-tab.is-preview")).toHaveLength(1);
		await act(async () => container.querySelector<HTMLButtonElement>('.file-tree-row [title="README.md"]')!.click());
		await flush();
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);

		await act(async () => button(container, "Copy path").click());
		expect(api.writeClipboardText).toHaveBeenCalledWith({ text: "/work/code-project/README.md" });
		await act(async () => button(container, "Copy contents").click());
		expect(api.writeClipboardText).toHaveBeenCalledWith({ text: "# README.md\n\nWorkspace preview." });
		await act(async () => button(container, "Open file actions").click());
		await act(async () => button(container, "Open in default app").click());
		expect(api.openWorkspaceFile).toHaveBeenCalledWith({ sessionId: "code-existing", relativePath: "README.md", action: "default" });

		await act(async () => container.querySelector<HTMLButtonElement>('.file-tree-row [title="docs"]')!.click());
		await flush();
		expect(api.listWorkspaceDirectory).toHaveBeenCalledWith({ sessionId: "code-existing", relativePath: "docs" });
		expect(container.querySelector('.file-tree-row [title="docs/guide.md"]')).not.toBeNull();
		const search = container.querySelector<HTMLInputElement>('[aria-label="Filter files"]')!;
		changeInput(search, "guide");
		await act(async () => new Promise((resolve) => setTimeout(resolve, 140)));
		expect(api.searchWorkspaceFiles).toHaveBeenCalledWith({ sessionId: "code-existing", query: "guide" });
		expect(container.querySelector('.file-tree-row [title="docs/guide.md"]')).not.toBeNull();

		await act(async () =>
			container.querySelector<HTMLElement>('[role="separator"][aria-label="Resize tools sidebar"]')!
				.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })),
		);
		expect(localStorage.getItem("metis.tools-sidebar-width.v2:code-existing")).toBe("544");
		expect(container.querySelectorAll(".cm-editor")).toHaveLength(1);
		const workspace = container.querySelector<HTMLElement>(".workspace")!;
		Object.defineProperty(workspace, "clientWidth", { configurable: true, value: 560 });
		await act(async () => window.dispatchEvent(new Event("resize")));
		expect(container.querySelector<HTMLElement>(".tool-sidebar")?.style.width).toBe("280px");
		expect(localStorage.getItem("metis.tools-sidebar-width.v2:code-existing")).toBe("544");
		Object.defineProperty(workspace, "clientWidth", { configurable: true, value: 1_746 });
		await act(async () => window.dispatchEvent(new Event("resize")));
		expect(container.querySelector<HTMLElement>(".tool-sidebar")?.style.width).toBe("544px");
		Object.defineProperty(workspace, "clientWidth", { configurable: true, value: 1_200 });
		await act(async () => button(container, "Chat").click());
		await flush();
		expect(container.querySelector<HTMLElement>(".tool-sidebar")?.style.width).toBe("528px");
		expect(localStorage.getItem("metis.tools-sidebar-width.v2:chat-existing")).toBeNull();
		expect(container.querySelectorAll(".cm-editor")).toHaveLength(0);
		await act(async () => button(container, "Code").click());
		await flush();
		expect(container.querySelector<HTMLElement>(".tool-sidebar")?.style.width).toBe("544px");
		expect(container.querySelectorAll(".cm-editor")).toHaveLength(1);
		await act(async () => root.unmount());

		root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		await act(async () => button(container, "Code").click());
		await flush();
		await act(async () => button(container, "Show tools sidebar").click());
		expect(container.querySelector<HTMLElement>(".tool-sidebar")?.style.width).toBe("544px");
		await act(async () => button(container, "Files").click());
		await flush();
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(1);
		expect(container.querySelector('[role="tab"]')?.textContent).toContain("README.md");
		expect(container.querySelector(".tool-tab")?.classList.contains("is-preview")).toBe(false);
		await act(async () => root.unmount());
	});

	it("edits workspace text safely and protects unsaved file tabs", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			x: 0, y: 0, top: 0, right: 320, bottom: 600, left: 0, width: 320, height: 600,
			toJSON: () => ({}),
		});
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Code").click());
		await flush();
		await act(async () => button(container, "Show tools sidebar").click());
		await act(async () => button(container, "Files").click());
		await flush();
		await act(async () => container.querySelector<HTMLButtonElement>('.file-tree-row [title="README.md"]')!.click());
		await flush();

		let editor = codeEditor(container, "Edit README.md");
		await act(async () => changeCodeEditor(editor, "# Edited README"));
		await flush();
		expect(container.querySelector(".tool-tab.is-dirty")).not.toBeNull();
		expect(api.setWorkspaceEditState).toHaveBeenLastCalledWith({ dirty: true, language: "en" });
		expect(container.querySelector(".tool-tab.is-preview")).toBeNull();
		const activeRow = button(container, "Code project task").closest<HTMLElement>(".session-row")!;
		await act(async () => button(activeRow, "Actions for Code project task").click());
		await act(async () => button(activeRow, "Delete").click());
		await flush();
		await act(async () => button(container, "Move to Trash").click());
		await flush();
		expect(api.deleteSession).not.toHaveBeenCalled();
		expect(container.querySelector('[role="alert"]')?.textContent).toBe(
			"Save or close unsaved files before deleting this task or project.",
		);
		await act(async () => button(container.querySelector<HTMLElement>(".project-dialog")!, "Cancel").click());
		await act(async () => button(container, "Show preview").click());
		expect(container.querySelector(".file-markdown h1")?.textContent).toBe("Edited README");
		await act(async () => button(container, "View source").click());
		editor = codeEditor(container, "Edit README.md");
		expect(editor.state.doc.toString()).toBe("# Edited README");
		await act(async () => button(container, "Hide tools sidebar").click());
		expect(container.querySelectorAll(".cm-editor")).toHaveLength(0);
		await act(async () => button(container, "Show tools sidebar").click());
		editor = codeEditor(container, "Edit README.md");
		expect(editor.state.doc.toString()).toBe("# Edited README");
		await act(async () => button(container, "Chat").click());
		await flush();
		expect(container.querySelectorAll(".cm-editor")).toHaveLength(0);
		await act(async () => button(container, "Code").click());
		await flush();
		editor = codeEditor(container, "Edit README.md");
		expect(editor.state.doc.toString()).toBe("# Edited README");
		await act(async () => editor.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true })));
		await flush();
		expect(api.writeWorkspaceFile).toHaveBeenLastCalledWith({
			sessionId: "code-existing",
			relativePath: "README.md",
			text: "# Edited README",
			expectedRevision: "a".repeat(64),
		});
		expect(container.querySelector(".tool-tab.is-dirty")).toBeNull();
		expect(api.setWorkspaceEditState).toHaveBeenLastCalledWith({ dirty: false, language: "en" });
		expect(container.querySelector(".file-preview-notice")?.textContent).toBe("File saved");

		let finishWrite!: (result: { readonly revision: string; readonly byteLength: number }) => void;
		vi.mocked(api.writeWorkspaceFile).mockImplementationOnce(() => new Promise((resolve) => { finishWrite = resolve; }));
		await act(async () => changeCodeEditor(editor, "first version"));
		await act(async () => button(container, "Save file").click());
		await flush();
		expect(api.writeWorkspaceFile).toHaveBeenLastCalledWith(expect.objectContaining({ text: "first version" }));
		expect(finishWrite).toBeTypeOf("function");
		expect(button(container, "Close README.md").disabled).toBe(true);
		await act(async () => changeCodeEditor(editor, "newer version"));
		await act(async () => finishWrite({ revision: "c".repeat(64), byteLength: 13 }));
		await flush();
		expect(editor.state.doc.toString()).toBe("newer version");
		expect(container.querySelector(".tool-tab.is-dirty")).not.toBeNull();
		expect(button(container, "Close README.md").disabled).toBe(false);
		await act(async () => editor.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true, bubbles: true, cancelable: true })));
		await flush();
		expect(container.querySelector(".tool-tab.is-dirty")).toBeNull();
		await act(async () => button(container, "Copy contents").click());
		expect(api.writeClipboardText).toHaveBeenLastCalledWith({ text: "newer version" });

		await act(async () => changeCodeEditor(editor, "discard me"));
		await act(async () => button(container, "Close README.md").click());
		expect(container.querySelector('[role="dialog"][aria-label="Unsaved changes"]')).not.toBeNull();
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		expect(container.querySelector('[role="dialog"][aria-label="Unsaved changes"]')).toBeNull();
		await act(async () => button(container, "Close README.md").click());
		await act(async () => button(container, "Cancel").click());
		expect(container.querySelector('[aria-label="Edit README.md"]')).not.toBeNull();
		await act(async () => button(container, "Close README.md").click());
		await act(async () => button(container, "Don’t Save").click());
		expect(container.querySelector('[aria-label="Edit README.md"]')).toBeNull();

		await act(async () => button(container, "Files").click());
		await flush();
		await act(async () => container.querySelector<HTMLButtonElement>('.file-tree-row [title="README.md"]')!.click());
		await flush();
		editor = codeEditor(container, "Edit README.md");
		await act(async () => changeCodeEditor(editor, "save before close"));
		await act(async () => button(container, "Close README.md").click());
		await act(async () => button(container, "Save").click());
		await flush();
		expect(container.querySelector('[aria-label="Edit README.md"]')).toBeNull();

		await act(async () => button(container, "Files").click());
		await flush();
		await act(async () => container.querySelector<HTMLButtonElement>('.file-tree-row [title="README.md"]')!.click());
		await flush();
		editor = codeEditor(container, "Edit README.md");
		await act(async () => changeCodeEditor(editor, "stale draft"));
		vi.mocked(api.writeWorkspaceFile).mockRejectedValueOnce(new Error("Workspace file changed on disk"));
		await act(async () => button(container, "Close README.md").click());
		await act(async () => button(container, "Save").click());
		await flush();
		expect(container.querySelector('[role="dialog"][aria-label="Unsaved changes"]')).not.toBeNull();
		expect(codeEditor(container, "Edit README.md").state.doc.toString()).toBe("stale draft");
		expect(container.querySelector('[role="alert"]')?.textContent).toBe("Workspace file changed on disk");
		await act(async () => button(container, "Don’t Save").click());
		await flush();
		expect(api.setWorkspaceEditState).toHaveBeenLastCalledWith({ dirty: false, language: "en" });
		await act(async () => root.unmount());
	});

	it("creates, renames, moves, and trashes workspace files without losing drafts", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			x: 0, y: 0, top: 0, right: 320, bottom: 600, left: 0, width: 320, height: 600,
			toJSON: () => ({}),
		});
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
		const { api } = createHarness();
		const directories = new Set(["docs", "src", "src/nested"]);
		const files = new Set([".env", "notes.txt", "README.md", "docs/guide.md", "src/a.ts", "src/nested/b.ts"]);
		const parent = (path: string) => path.split("/").slice(0, -1).join("/");
		const remapEntries = (values: Set<string>, previous: string, next: string) => {
			for (const value of [...values]) {
				if (value !== previous && !value.startsWith(`${previous}/`)) continue;
				values.delete(value);
				values.add(`${next}${value.slice(previous.length)}`);
			}
		};
		vi.mocked(api.listWorkspaceDirectory).mockImplementation(async ({ relativePath }) => {
			const entries = [
				...[...directories].filter((path) => parent(path) === relativePath).map((path) => ({
					name: path.split("/").at(-1)!, relativePath: path, kind: "directory" as const,
				})),
				...[...files].filter((path) => parent(path) === relativePath).map((path) => ({
					name: path.split("/").at(-1)!, relativePath: path, kind: "file" as const,
				})),
			];
			return entries;
		});
		vi.mocked(api.mutateWorkspaceEntry).mockImplementation(async (input) => {
			if (input.action === "create") {
				const relativePath = input.parentRelativePath ? `${input.parentRelativePath}/${input.name}` : input.name;
				(input.kind === "directory" ? directories : files).add(relativePath);
				return { action: "create", kind: input.kind, relativePath, absolutePath: `/work/code-project/${relativePath}` };
			}
			const kind = directories.has(input.relativePath) ? "directory" as const : "file" as const;
			if (input.action === "trash") {
				for (const values of [directories, files]) {
					for (const value of [...values]) {
						if (value === input.relativePath || value.startsWith(`${input.relativePath}/`)) values.delete(value);
					}
				}
				return {
					action: "trash", kind, previousRelativePath: input.relativePath,
					previousAbsolutePath: `/work/code-project/${input.relativePath}`,
				};
			}
			const nextParent = input.action === "rename" ? parent(input.relativePath) : input.destinationDirectoryRelativePath;
			const name = input.action === "rename" ? input.name : input.relativePath.split("/").at(-1)!;
			const relativePath = nextParent ? `${nextParent}/${name}` : name;
			remapEntries(directories, input.relativePath, relativePath);
			remapEntries(files, input.relativePath, relativePath);
			return {
				action: input.action,
				kind,
				previousRelativePath: input.relativePath,
				previousAbsolutePath: `/work/code-project/${input.relativePath}`,
				relativePath,
				absolutePath: `/work/code-project/${relativePath}`,
			};
		});

		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		await act(async () => button(container, "Code").click());
		await flush();
		await act(async () => button(container, "Show tools sidebar").click());
		await act(async () => button(container, "Files").click());
		await flush();

		await act(async () => button(container, "New file").click());
		let dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="New file"]')!;
		await act(async () => changeInput(dialog.querySelector<HTMLInputElement>('[aria-label="Name"]')!, "scratch.ts"));
		await act(async () => button(dialog, "Create").click());
		await flush();
		expect(api.mutateWorkspaceEntry).toHaveBeenLastCalledWith({
			action: "create", sessionId: "code-existing", parentRelativePath: "", name: "scratch.ts", kind: "file",
		});
		expect(container.querySelector('[role="tab"]')?.textContent).toContain("scratch.ts");
		expect(container.querySelector(".tool-tab.is-preview")).toBeNull();
		let editor = codeEditor(container, "Edit scratch.ts");
		await act(async () => changeCodeEditor(editor, "export const draft = true;"));

		await openTreeMenu(container, "scratch.ts");
		await act(async () => button(container.querySelector<HTMLElement>('[role="menu"][aria-label="File actions"]')!, "Rename").click());
		dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Rename"]')!;
		await act(async () => changeInput(dialog.querySelector<HTMLInputElement>('[aria-label="Name"]')!, "renamed.ts"));
		await act(async () => button(dialog, "Rename").click());
		await flush();
		expect(container.querySelector('[role="tab"]')?.textContent).toContain("renamed.ts");
		editor = codeEditor(container, "Edit renamed.ts");
		expect(editor.state.doc.toString()).toBe("export const draft = true;");

		await openTreeMenu(container, "renamed.ts");
		await act(async () => button(container.querySelector<HTMLElement>('[role="menu"][aria-label="File actions"]')!, "Move to…").click());
		dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Move to…"]')!;
		await act(async () => changeInput(dialog.querySelector<HTMLInputElement>('[aria-label="Destination folder"]')!, "docs"));
		await act(async () => button(dialog, "Move").click());
		await flush();
		editor = codeEditor(container, "Edit renamed.ts");
		expect(editor.state.doc.toString()).toBe("export const draft = true;");
		await act(async () => button(container, "Save file").click());
		await flush();
		expect(api.writeWorkspaceFile).toHaveBeenLastCalledWith(expect.objectContaining({
			relativePath: "docs/renamed.ts", text: "export const draft = true;",
		}));

		await act(async () => changeCodeEditor(editor, "discard this draft"));
		await act(async () => container.querySelector<HTMLButtonElement>('.file-tree-row [title="docs"]')!.click());
		await flush();
		await openTreeMenu(container, "docs/renamed.ts");
		await act(async () => button(container.querySelector<HTMLElement>('[role="menu"][aria-label="File actions"]')!, "Move to Trash").click());
		dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Move to Trash"]')!;
		expect(dialog.textContent).toContain("Unsaved changes in 1 open file will be discarded.");
		await act(async () => button(dialog, "Cancel").click());
		expect(codeEditor(container, "Edit renamed.ts").state.doc.toString()).toBe("discard this draft");
		await openTreeMenu(container, "docs/renamed.ts");
		await act(async () => button(container.querySelector<HTMLElement>('[role="menu"][aria-label="File actions"]')!, "Move to Trash").click());
		dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Move to Trash"]')!;
		await act(async () => button(dialog, "Move to Trash").click());
		await flush();
		expect(container.querySelector('[role="tab"]')?.textContent).toContain("Open file");
		expect(container.querySelector('[aria-label="Edit renamed.ts"]')).toBeNull();

		await act(async () => container.querySelector<HTMLButtonElement>('.file-tree-row [title="src"]')!.click());
		await flush();
		const sourceA = container.querySelector<HTMLButtonElement>('.file-tree-row [title="src/a.ts"]')!;
		expect(sourceA.querySelector(".file-kind-icon.is-typescript")).not.toBeNull();
		await act(async () => sourceA.click());
		await flush();
		await act(async () => sourceA.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
		await act(async () => container.querySelector<HTMLButtonElement>('.file-tree-row [title="src/nested"]')!.click());
		await flush();
		const sourceB = container.querySelector<HTMLButtonElement>('.file-tree-row [title="src/nested/b.ts"]')!;
		await act(async () => sourceB.click());
		await flush();
		await act(async () => sourceB.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
		expect(container.querySelectorAll(".tool-tab.is-preview")).toHaveLength(0);

		await openTreeMenu(container, "src");
		await act(async () => button(container.querySelector<HTMLElement>('[role="menu"][aria-label="File actions"]')!, "Rename").click());
		dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Rename"]')!;
		await act(async () => changeInput(dialog.querySelector<HTMLInputElement>('[aria-label="Name"]')!, "source"));
		await act(async () => button(dialog, "Rename").click());
		await flush();
		let stored = JSON.parse(localStorage.getItem("metis.file-browser.v1:code-existing")!) as {
			fixedPaths: string[]; expandedPaths: string[];
		};
		expect(stored.fixedPaths).toEqual(expect.arrayContaining(["source/a.ts", "source/nested/b.ts"]));
		expect(stored.expandedPaths).toContain("source/nested");

		await openTreeMenu(container, "source");
		await act(async () => button(container.querySelector<HTMLElement>('[role="menu"][aria-label="File actions"]')!, "Move to…").click());
		dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Move to…"]')!;
		await act(async () => changeInput(dialog.querySelector<HTMLInputElement>('[aria-label="Destination folder"]')!, "docs"));
		await act(async () => button(dialog, "Move").click());
		await flush();
		stored = JSON.parse(localStorage.getItem("metis.file-browser.v1:code-existing")!) as {
			fixedPaths: string[]; expandedPaths: string[];
		};
		expect(stored.fixedPaths).toEqual(expect.arrayContaining(["docs/source/a.ts", "docs/source/nested/b.ts"]));
		expect(stored.expandedPaths).toContain("docs/source/nested");

		await flush();
		await flush();
		await openTreeMenu(container, "docs/source");
		await act(async () => button(container.querySelector<HTMLElement>('[role="menu"][aria-label="File actions"]')!, "Move to Trash").click());
		dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-label="Move to Trash"]')!;
		await act(async () => button(dialog, "Move to Trash").click());
		await flush();
		expect([...container.querySelectorAll('[role="tab"]')].some((tab) => /a\.ts|b\.ts/u.test(tab.textContent ?? ""))).toBe(false);
		stored = JSON.parse(localStorage.getItem("metis.file-browser.v1:code-existing")!) as {
			fixedPaths: string[]; expandedPaths: string[];
		};
		expect(stored.expandedPaths.some((path) => path.startsWith("docs/source"))).toBe(false);
		await act(async () => root.unmount());
	});

	it("retries a failed workspace tree load", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
		const { api } = createHarness();
		vi.mocked(api.listWorkspaceDirectory).mockRejectedValueOnce(new Error("tree unavailable"));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Code").click());
		await flush();
		await act(async () => button(container, "Show tools sidebar").click());
		await act(async () => button(container, "Files").click());
		await flush();
		expect(container.querySelector(".file-tree-empty")?.textContent).toContain("tree unavailable");

		await act(async () => button(container, "Retry").click());
		await flush();
		expect(api.listWorkspaceDirectory).toHaveBeenCalledTimes(2);
		expect(container.querySelector('.file-tree-row [title="README.md"]')).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("opens a real browser tab, navigates it, and keeps native presentation behind overlays", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api, emitBrowser } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Show tools sidebar").click());
		expect(container.querySelector(".tool-sidebar")?.textContent).toContain("Browser");
		const browserButton = [...container.querySelectorAll<HTMLButtonElement>(".tool-sidebar-menu button")]
			.find((candidate) => candidate.querySelector("span")?.textContent === "Browser")!;
		await act(async () => browserButton.click());
		await flush();
		expect(api.createBrowser).toHaveBeenCalledTimes(1);
		expect(container.querySelector('[aria-label="Browser address"]')).not.toBeNull();
		expect(container.textContent).toContain("Start browsing");
		const browserId = vi.mocked(api.createBrowser).mock.calls[0]![0].browserId;
		const address = container.querySelector<HTMLInputElement>('[aria-label="Browser address"]')!;
		changeInput(address, "example.com");
		await act(async () => container.querySelector<HTMLFormElement>(".browser-address-form")!.requestSubmit());
		expect(api.controlBrowser).toHaveBeenCalledWith({ type: "navigate", browserId, url: "example.com" });

		act(() => emitBrowser({
			type: "state",
			state: {
				browserId,
				url: "https://example.com/",
				title: "Example Domain",
				faviconUrl: null,
				loading: false,
				canGoBack: true,
				canGoForward: false,
				zoomPercent: 100,
			},
		}));
		await flush();
		expect(container.querySelector('[role="tab"]')?.textContent).toContain("Example Domain");
		expect(button(container, "Back").disabled).toBe(false);
		expect(button(container, "Forward").disabled).toBe(true);

		vi.mocked(api.controlBrowser).mockClear();
		await act(async () => button(container, "More browser actions").click());
		await flush();
		expect(api.captureBrowserPreview).toHaveBeenCalledWith({ browserId });
		expect(container.querySelector<HTMLImageElement>(".browser-view-preview")?.src).toBe(
			"data:image/png;base64,cHJldmlldw==",
		);
		expect(api.controlBrowser).toHaveBeenCalledWith(expect.objectContaining({
			type: "present",
			browserId,
			visible: false,
		}));
		const menu = container.querySelector('[role="menu"]')!;
		expect(menu.textContent).toContain("Find in page");
		expect(menu.textContent).toContain("Print");
		expect(container.querySelector<HTMLInputElement>('input[aria-label="Zoom percentage"]')?.value).toBe("100");
		expect(menu.textContent).toContain("Screenshot");
		expect(menu.textContent).toContain("Clear browsing data");
		expect(menu.textContent).not.toContain("Open in default browser");
		expect(menu.textContent).not.toContain("Downloads");
		expect(menu.textContent).not.toContain("History");
		expect(menu.textContent).not.toContain("Developer Tools");
		expect(menu.textContent).not.toContain("Settings");

		await act(async () => container.querySelector<HTMLButtonElement>('[data-browser-action="find"]')!.click());
		await flush();
		const findInput = container.querySelector<HTMLInputElement>('input[aria-label="Find in page"]')!;
		changeInput(findInput, "open");
		expect(api.controlBrowser).toHaveBeenCalledWith({
			type: "find",
			browserId,
			text: "open",
			forward: true,
			findNext: true,
		});
		act(() => emitBrowser({ type: "find-result", browserId, activeMatchOrdinal: 2, matches: 52 }));
		expect(container.querySelector(".browser-find-count")?.textContent).toBe("2 / 52 results");
		await act(async () =>
			findInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })),
		);
		expect(api.controlBrowser).toHaveBeenLastCalledWith({
			type: "find",
			browserId,
			text: "open",
			forward: false,
			findNext: false,
		});
		await act(async () =>
			findInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
		);
		expect(api.controlBrowser).toHaveBeenLastCalledWith({ type: "stop-find", browserId });
		expect(container.querySelector(".browser-find-panel")).toBeNull();

		act(() => emitBrowser({ type: "command", browserId, command: "find" }));
		await flush();
		expect(container.querySelector<HTMLInputElement>('input[aria-label="Find in page"]')).not.toBeNull();
		await act(async () =>
			container
				.querySelector<HTMLInputElement>('input[aria-label="Find in page"]')!
				.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
		);
		act(() => emitBrowser({ type: "command", browserId, command: "print" }));
		expect(api.controlBrowser).toHaveBeenCalledWith({ type: "print", browserId });

		await act(async () => button(container, "More browser actions").click());
		await act(async () => button(container, "Zoom in").click());
		await flush();
		expect(api.controlBrowser).toHaveBeenCalledWith({ type: "zoom-in", browserId });
		expect(container.querySelector(".browser-more-menu")).not.toBeNull();
		const zoomInput = container.querySelector<HTMLInputElement>('input[aria-label="Zoom percentage"]')!;
		expect(zoomInput).not.toBeNull();
		changeInput(zoomInput, "137");
		await act(async () =>
			zoomInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
		);
		expect(api.controlBrowser).toHaveBeenCalledWith({ type: "set-zoom", browserId, zoomPercent: 137 });
		act(() => emitBrowser({
			type: "state",
			state: {
				browserId,
				url: "https://example.com/",
				title: "Example Domain",
				faviconUrl: null,
				loading: false,
				canGoBack: true,
				canGoForward: false,
				zoomPercent: 110,
			},
		}));
		await flush();
		expect(container.querySelector<HTMLInputElement>('input[aria-label="Zoom percentage"]')?.value).toBe("110");
		await act(async () => button(container, "More browser actions").click());

		await act(async () => button(container, "More browser actions").click());
		await act(async () => container.querySelector<HTMLButtonElement>('[data-browser-action="clear-data"]')!.click());
		expect(container.querySelector(".browser-clear-dialog")).not.toBeNull();
		await act(async () => container.querySelector<HTMLButtonElement>('[data-browser-confirm-clear]')!.click());
		await flush();
		expect(api.controlBrowser).toHaveBeenCalledWith({ type: "clear-data", browserId });
		expect(container.querySelector(".browser-toolbar-notice")?.textContent).toContain("Browser data cleared");

		await act(async () =>
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "f", metaKey: true })),
		);
		await flush();
		expect(container.querySelector('input[aria-label="Find in page"]')).not.toBeNull();
		await act(async () => button(container, "Close find").click());
		for (const [key, type] of [
			["p", "print"],
			["-", "zoom-out"],
			["=", "zoom-in"],
			["0", "zoom-reset"],
		] as const) {
			await act(async () =>
				window.dispatchEvent(new KeyboardEvent("keydown", { key, metaKey: true })),
			);
			expect(api.controlBrowser).toHaveBeenCalledWith({ type, browserId });
		}

		await act(async () => button(container, "Add tool").click());
		await flush();
		expect(api.controlBrowser).toHaveBeenLastCalledWith(expect.objectContaining({
			type: "present",
			browserId,
			visible: false,
		}));
		const callsWhileHidden = vi.mocked(api.controlBrowser).mock.calls.length;
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", metaKey: true }));
		expect(api.controlBrowser).toHaveBeenCalledTimes(callsWhileHidden);
		const secondBrowserButton = [...container.querySelectorAll<HTMLButtonElement>(".tool-add-menu button")]
			.find((candidate) => candidate.querySelector("span")?.textContent === "Browser")!;
		await act(async () => secondBrowserButton.click());
		await flush();
		expect(api.createBrowser).toHaveBeenCalledTimes(2);
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(2);
		await act(async () => button(container, "Close New tab").click());
		await act(async () => button(container, "Close Example Domain").click());
		expect(api.closeBrowser).toHaveBeenCalledTimes(2);
		expect(api.closeBrowser).toHaveBeenCalledWith({ browserId });
		expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);

		await act(async () => root.unmount());
	});

	it("switches the full shell to Chinese immediately", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Metis").click());
		await act(async () => button(container, "Language").click());
		await act(async () => button(container, "中文").click());

		expect(document.documentElement.lang).toBe("zh-CN");
		expect(container.textContent).toContain("新建任务");
		expect(container.textContent).toContain("技能");
		expect(container.textContent).toContain("定时任务");
		expect(container.textContent).toContain("有什么我可以替你分担的？");
		expect(container.querySelector('[aria-label="隐藏会话侧边栏"]')).not.toBeNull();
		await act(async () => root.unmount());
	});
});
