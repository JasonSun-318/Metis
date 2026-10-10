// @vitest-environment jsdom

import type { AgentSummaryView, ClientResult, McpServerSummaryView, ScheduleTaskView, SessionSnapshot, SessionSummary } from "@metis/app-protocol";
import { EditorView } from "@codemirror/view";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	App,
	sessionDisplayTitle,
} from "../src/renderer/components/App.tsx";
import { firstInteractionForSession } from "../src/renderer/session-view-utils.ts";
import { buildSessionTree, clampSessionSidebarWidth } from "../src/renderer/components/SessionSidebar.tsx";
import { PluginsPanel } from "../src/renderer/components/PluginsPanel.tsx";
import { RELEASE_NOTES_READ_VERSION_STORAGE_KEY } from "../src/renderer/components/ReleaseNotesPopover.tsx";
import { GENERAL_PREFERENCES_STORAGE_KEY } from "../src/renderer/general-preferences.ts";
import { setLocale } from "../src/renderer/i18n.ts";
import { getHomePeriod, HOME_GREETINGS } from "../src/renderer/new-task-home-content.ts";
import { DEFAULT_PROFILE_IDENTITY, saveProfileIdentity } from "../src/renderer/profile-identity.ts";
import { AppStore } from "../src/renderer/store/app-store.ts";
import {
	loadProjectPreferences,
	removeProjectPreference,
	saveProjectPreferences,
	setProjectAlias,
	setProjectPinned,
} from "../src/renderer/store/project-preferences.ts";
import { loadSessionPins, saveSessionPins } from "../src/renderer/store/session-pins.ts";
import {
	DEFAULT_BROWSER_PROFILE_ID,
	type DesktopChangelog,
	type DesktopUpdateState,
	type MetisDesktopApi,
} from "../src/shared/desktop-api.ts";

const EPOCH = "11111111-1111-4111-8111-111111111111";
const RELEASE_NOTES = "## Highlights\n\n- Added release notes";
const CHANGELOG: DesktopChangelog = {
	schemaVersion: 1,
	releases: [
		{ version: "0.82.0", notes: "## Highlights\n\n- Added changelog history" },
		{ version: "0.81.0", notes: RELEASE_NOTES },
	],
};

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

function mcpServer(
	state: McpServerSummaryView["state"] = "connected",
	lastError?: string,
): McpServerSummaryView {
	return {
		name: "deepwiki",
		scope: "user",
		effective: true,
		revision: "a".repeat(64),
		transport: "http",
		enabled: true,
		required: false,
		url: "https://mcp.deepwiki.com/mcp",
		disabledTools: [],
		state,
		credentialConfigured: false,
		toolCount: state === "connected" ? 3 : 0,
		resourceCount: 0,
		resourceTemplateCount: 0,
		promptCount: 0,
		capabilities: state === "connected" ? ["tools"] : [],
		...(lastError ? { lastError } : {}),
	};
}

function snapshot(summary: SessionSummary): SessionSnapshot {
	return {
		session: summary,
		collaborationMode: "default",
		permissionPreset: "ask",
		effectiveSettings: { sandboxPolicy: "workspace-write", approvalPolicy: "user" },
		constrainedByParent: false,
		sandboxHealth: "healthy",
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

function button(container: HTMLElement, label: string): HTMLButtonElement {
	const matches = (root: ParentNode) => [...root.querySelectorAll<HTMLButtonElement>("button")]
		.find((candidate) => candidate.getAttribute("aria-label") === label || candidate.textContent?.trim() === label);
	const portalMatch = [...document.querySelectorAll(".session-action-menu, .project-action-menu, .modal-backdrop")]
		.map((root) => matches(root))
		.find((candidate) => candidate !== undefined);
	const match = matches(container) ?? portalMatch;
	if (!match) throw new Error(`Missing button: ${label}`);
	return match;
}

function activeWorkspace(container: HTMLElement): HTMLElement {
	// The top row's tab strips are portaled into the titlebar, so tab strip
	// queries scope to the whole workspace column.
	const instance = container.querySelector<HTMLElement>("main.workspace");
	if (!instance) throw new Error("Missing visible workspace");
	return instance;
}

async function addTool(container: HTMLElement, label: string): Promise<void> {
	const workspace = activeWorkspace(container);
	await act(async () => workspace.querySelector<HTMLButtonElement>(".tool-add-trigger")!.click());
	const menu = workspace.querySelector<HTMLElement>(".tool-add-menu");
	if (!menu) throw new Error("Missing .tool-add-menu");
	await act(async () => button(menu, label).click());
}

function projectDialog(): HTMLElement {
	const dialog = document.querySelector<HTMLElement>(".project-dialog");
	if (!dialog) throw new Error("Missing project dialog");
	return dialog;
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

function changeTextarea(textarea: HTMLElement, value: string) {
	if (textarea instanceof HTMLTextAreaElement) {
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, value);
	} else {
		(textarea as unknown as { value: string }).value = value;
	}
	textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

function changeInput(input: HTMLInputElement, value: string) {
	Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
	input.dispatchEvent(new Event("input", { bubbles: true }));
}

function changeSelect(select: HTMLSelectElement, value: string) {
	Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
	select.dispatchEvent(new Event("change", { bubbles: true }));
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
	const row = label?.closest(".file-tree-row");
	if (!row) throw new Error(`Missing tree row for ${title}`);
	await act(async () => row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 80 })));
}

async function openRootTreeMenu(container: HTMLElement): Promise<void> {
	const tree = container.querySelector<HTMLElement>(".file-tree-scroll");
	if (!tree) throw new Error("Missing file tree");
	await act(async () => tree.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 24, clientY: 24 })));
}

async function submitTreeName(container: HTMLElement, name: string): Promise<void> {
	const input = container.querySelector<HTMLInputElement>(".file-tree-name-input");
	if (!input) throw new Error("Missing inline name input");
	await act(async () => {
		changeInput(input, name);
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
	});
}

function createHarness(options: {
	failFirstOpen?: boolean;
	failOpenSessionIds?: readonly string[];
	loseFirstCreateResponse?: boolean;
	loseFirstStartResponse?: boolean;
	scheduleTasks?: readonly ScheduleTaskView[];
	sessions?: readonly SessionSummary[];
	mcpLists?: readonly (readonly McpServerSummaryView[])[];
	changelog?: DesktopChangelog;
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
	let mcpListIndex = 0;
	const mcpLists = options.mcpLists ?? [[mcpServer()]];
	const api = {
		platform: "win32",
		getServerState: vi.fn().mockResolvedValue({ state: "ready", serverEpoch: EPOCH, restartAttempt: 0, failure: null }),
		getModelSettings: vi.fn().mockResolvedValue({
			defaultModel: null,
			defaultThinkingSelection: "off",
			providers: [],
			loadError: null,
		}),
		updateModelSettings: vi.fn(),
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
		listMcpServers: vi.fn(async () => ({
			servers: mcpLists[Math.min(mcpListIndex++, mcpLists.length - 1)] ?? [],
		})),
		getSkill: vi.fn(),
		upsertSkill: vi.fn(),
		removeSkill: vi.fn(),
		inspectSkillImport: vi.fn(),
		importSkills: vi.fn(),
		openSkillFolder: vi.fn(),
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
			profileId: input.profileId,
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
		listBrowserDownloads: vi.fn().mockResolvedValue([]),
		controlBrowserDownload: vi.fn().mockResolvedValue(undefined),
		listBrowserProfiles: vi.fn().mockResolvedValue([{
			profileId: DEFAULT_BROWSER_PROFILE_ID,
			name: "Default",
			sourceId: null,
			sourceProfileId: null,
		}]),
		listBrowserImportSources: vi.fn().mockResolvedValue([]),
		importBrowserData: vi.fn(),
		listBrowserHistory: vi.fn().mockResolvedValue([]),
		clearBrowserHistory: vi.fn().mockResolvedValue(undefined),
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
		retainWorkspaceSessions: vi.fn().mockResolvedValue(undefined),
		getWebSearchSettings: vi.fn().mockResolvedValue({ enabled: false, provider: "brave", authConfigured: false }),
		updateWebSearchSettings: vi.fn().mockResolvedValue({ enabled: false, provider: "brave", authConfigured: false }),
		getChangelog: vi.fn().mockResolvedValue(options.changelog ?? CHANGELOG),
		getUpdateState: vi.fn(async () => updateState),
		checkForUpdate: vi.fn(async () => updateState),
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
		forkSession: vi.fn(async ({ sessionId, entryId }) => {
			const current = sessions.find((candidate) => candidate.sessionId === sessionId);
			if (!current) throw new Error("missing session");
			const forked: SessionSummary = {
				...current,
				sessionId: "forked-session-1",
				name: `fork ${current.name ?? ""}`.trim(),
			};
			sessions = [...sessions, forked];
			return { session: forked, entryId };
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
		focusSession: vi.fn(async ({ sessionId }) => {
			order.push("focus");
			if (failFirstOpen || failOpenSessionIds.delete(sessionId)) {
				failFirstOpen = false;
				throw new Error("open failed once");
			}
		}),
		subscribeSession: vi.fn(async ({ sessionId }) => {
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
		queueTurn: vi.fn().mockResolvedValue({}),
		updateQueuedTurn: vi.fn().mockResolvedValue({}),
		deleteQueuedTurn: vi.fn().mockResolvedValue({}),
		sendQueuedTurn: vi.fn().mockResolvedValue({}),
		interruptTurn: vi.fn().mockResolvedValue({}),
		readItems: vi.fn().mockResolvedValue({ items: [], nextBeforeItemId: null }),
		getSessionStatus: vi.fn(async ({ sessionId }) => ({
			sessionId,
			mode: "code" as const,
			contextTokens: 64_000,
			contextWindow: 128_000,
			contextBasis: "reported_total" as const,
			contextBreakdown: [{ category: "conversation" as const, tokens: 64_000 }],
			remainingPercent: 50,
			cacheHitPercent: 25,
		})),
		compactSession: vi.fn(async ({ sessionId }) => ({
			sessionId,
			tokensBefore: 64_000,
			estimatedTokensAfter: 8_000,
		})),
		setSessionGoal: vi.fn(async ({ sessionId, objective, status }) => ({
			sessionId,
			goal: {
				goalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
				objective: objective ?? "keep tests green",
				status: status ?? "active",
				timeUsedSeconds: 0,
				activeStartedAt: status === "paused" ? null : "2026-08-17T00:00:00.000Z",
			},
		})),
		clearSessionGoal: vi.fn(async ({ sessionId }) => ({ sessionId, cleared: true })),
		readAgentItems: vi.fn().mockResolvedValue({ items: [], nextBeforeItemId: null }),
		interruptAgent: vi.fn().mockResolvedValue({}),
		setThinkingSelection: vi.fn().mockResolvedValue({}),
		setPermissionPreset: vi.fn(async ({ permissionPreset }) => ({ permissionPreset })),
		setCollaborationMode: vi.fn(async ({ collaborationMode }) => ({ collaborationMode })),
		startPlanExecution: vi.fn(async () => ({})),
		cancelPlan: vi.fn(async () => ({ collaborationMode: "default" as const })),
		setModel: vi.fn().mockResolvedValue({}),
		respondToInteraction: vi.fn().mockResolvedValue(undefined),
		retryServer: vi.fn().mockResolvedValue(undefined),
		getThemePreference: vi.fn().mockResolvedValue("dark"),
		setThemePreference: vi.fn().mockResolvedValue(undefined),
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
	Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
		configurable: true,
		value: vi.fn(),
	});
	Object.defineProperty(HTMLElement.prototype, "scrollTo", {
		configurable: true,
		value: vi.fn(),
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	localStorage.clear();
	document.body.replaceChildren();
});

describe("Chat desktop shell", () => {
	it.each(["en", "zh-CN"] as const)("dismisses memory event notifications after five seconds without replaying older notices (%s)", async (locale) => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const active = session("chat-memory", "chat", "/work/chat-project", "Memory");
		localStorage.setItem("metis.activeSessionId.chat", active.sessionId);
		const { api, emitEvent } = createHarness({ sessions: [active] });
		const store = new AppStore();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<App api={api} store={store} />));
			await flush();
			await act(async () => { await setLocale(locale); });
			vi.useFakeTimers();
			const notify = async (cursor: number, slug: string) => act(async () => emitEvent({
				type: "app-server",
				envelope: {
					jsonrpc: "2.0", method: "connection/events",
					params: { serverEpoch: EPOCH, fromCursor: cursor, toCursor: cursor, events: [{
						type: "memory/changed",
						entry: { id: `memory-${cursor}`, ts: new Date().toISOString(), actor: { kind: "agent", sessionId: active.sessionId }, op: "create", scope: "global", target: { slug } },
					}] },
				},
			}));
			await notify(1, "older-note");
			await notify(2, "user-jason-profile");
			expect(container.querySelector(".system-notice")?.textContent).toContain(locale === "zh-CN" ? "已保存记忆：“user-jason-profile”" : 'Saved memory: note "user-jason-profile"');
			await act(async () => vi.advanceTimersByTime(4_999));
			expect(container.querySelector(".system-notice")).not.toBeNull();
			await act(async () => store.upsertSession({ ...active, name: "Updated while chatting" }));
			await act(async () => vi.advanceTimersByTime(1));
			expect(container.querySelector(".system-notice")).toBeNull();
			await act(async () => store.upsertSession(active));
			expect(container.querySelector(".system-notice")).toBeNull();
			await notify(3, "new-note");
			await act(async () => vi.advanceTimersByTime(4_000));
			await notify(4, "new-note");
			await act(async () => vi.advanceTimersByTime(1_000));
			expect(container.querySelector(".system-notice")?.textContent).toContain("new-note");
			await act(async () => button(container, locale === "zh-CN" ? "关闭提醒" : "Dismiss notification").click());
			expect(container.querySelector(".system-notice")).toBeNull();
		} finally {
			await act(async () => root.unmount());
			vi.useRealTimers();
		}
	});

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
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		expect(api.setWorkspaceEditState).toHaveBeenLastCalledWith({
			dirty: false,
			language: "en",
			visibleSessionId: "chat-existing",
		});

		await act(async () => button(container, "Metis User").click());
		expect(document.activeElement?.textContent).toBe("Settings");
		await act(async () => button(container, "Settings").click());
		await flush();
		expect(api.setWorkspaceEditState).toHaveBeenLastCalledWith({
			dirty: false,
			language: "en",
			visibleSessionId: null,
		});
		await act(async () => button(container, "Profile").click());
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

	it("lights the unread bell when an update arrives after the previous release was read", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		localStorage.setItem(RELEASE_NOTES_READ_VERSION_STORAGE_KEY, "0.81.0");
		const { api, emitUpdate } = createHarness({
			changelog: { schemaVersion: 1, releases: [CHANGELOG.releases[1]!] },
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<App api={api} store={new AppStore()} />));
			await flush();
			expect(button(container, "Open release notes")).toBeTruthy();
			expect(container.querySelector(".release-notes-unread-dot")).toBeNull();
			vi.mocked(api.getChangelog).mockResolvedValue(CHANGELOG);
			await act(async () => emitUpdate({ status: "available", version: "0.82.0", releaseNotes: "" }));
			await flush();
			expect(container.querySelector(".sidebar-update-notice")).not.toBeNull();
			expect(container.querySelector(".release-notes-unread-dot")).not.toBeNull();
			await act(async () => button(container, "Open unread release notes").click());
			expect(container.querySelector('[role="dialog"]')?.textContent).toContain("0.82.0");
			expect(container.querySelector(".release-notes-unread-dot")).toBeNull();
			await act(async () => button(container, "Close release notes").click());
			const loadsAfterRead = vi.mocked(api.getChangelog).mock.calls.length;
			for (const progress of [10, 50, 100]) {
				await act(async () => emitUpdate({ status: "downloading", version: "0.82.0", releaseNotes: "", progress }));
			}
			await act(async () => emitUpdate({ status: "ready", version: "0.82.0", releaseNotes: "" }));
			expect(api.getChangelog).toHaveBeenCalledTimes(loadsAfterRead);
			expect(container.querySelector(".release-notes-unread-dot")).toBeNull();
		} finally {
			await act(async () => root.unmount());
		}
	});

	it("shows the update action above Metis only when a newer version is available and handles manual check flow", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
		const available = { status: "available" as const, version: "0.81.0", releaseNotes: RELEASE_NOTES };
		const { api, emitUpdate } = createHarness();
		let resolveCheck: ((state: typeof available) => void) | undefined;
		api.checkForUpdate = vi.fn()
			.mockImplementationOnce(() => new Promise<typeof available>((resolve) => { resolveCheck = resolve; }))
			.mockResolvedValue(available);

		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		expect(container.querySelector(".sidebar-update-notice")).toBeNull();

		const refreshBtn = container.querySelector<HTMLButtonElement>(".account-update-check")!;
		expect(refreshBtn).not.toBeNull();
		expect(refreshBtn.disabled).toBe(false);
		expect(refreshBtn.getAttribute("aria-busy")).toBe("false");

		await act(async () => refreshBtn.click());
		expect(api.checkForUpdate).toHaveBeenCalledTimes(1);
		expect(refreshBtn.disabled).toBe(true);
		expect(refreshBtn.getAttribute("aria-busy")).toBe("true");
		expect(refreshBtn.querySelector(".is-spinning")).not.toBeNull();

		await act(async () => refreshBtn.click());
		expect(api.checkForUpdate).toHaveBeenCalledTimes(1);

		await act(async () => emitUpdate(available));
		await act(async () => resolveCheck!(available));
		await flush();

		expect(refreshBtn.disabled).toBe(false);
		expect(refreshBtn.getAttribute("aria-busy")).toBe("false");

		const updateCallsBeforeBell = vi.mocked(api.checkForUpdate).mock.calls.length;
		const changelogCallsBeforeBell = vi.mocked(api.getChangelog).mock.calls.length;
		await act(async () => button(container, "Open unread release notes").click());
		await flush();
		expect(api.checkForUpdate).toHaveBeenCalledTimes(updateCallsBeforeBell);
		expect(api.getChangelog).toHaveBeenCalledTimes(changelogCallsBeforeBell + 1);
		expect(container.querySelector('[role="dialog"]')?.textContent).toContain("0.82.0");
		expect(container.querySelector('[role="dialog"]')?.textContent).toContain("Added changelog history");
		expect(container.querySelector(".release-notes-unread-dot")).toBeNull();
		expect(container.querySelector(".system-notice")?.textContent ?? "").not.toContain("Metis is up to date");

		const notice = container.querySelector<HTMLElement>(".sidebar-update-notice")!;
		expect(notice).not.toBeNull();
		expect(notice.nextElementSibling?.classList.contains("sidebar-footer")).toBe(true);
		const update = button(notice, "Update to new version");
		expect(update.querySelector("svg")).not.toBeNull();
		await act(async () => update.click());
		expect(api.startUpdate).toHaveBeenCalledOnce();

		await act(async () => emitUpdate({ status: "downloading", version: "0.81.0", releaseNotes: RELEASE_NOTES, progress: 42 }));
		expect(button(notice, "Downloading update 42%").disabled).toBe(true);
		await act(async () => emitUpdate({ status: "ready", version: "0.81.0", releaseNotes: RELEASE_NOTES }));
		expect(button(notice, "Open installer").disabled).toBe(false);

		await act(async () => root.unmount());
	});

	it("shows up-to-date and failure notices and protects downloading/ready states against stale check results", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api, emitUpdate } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		const refreshBtn = container.querySelector<HTMLButtonElement>(".account-update-check")!;

		// 1. Up-to-date notice
		api.checkForUpdate = vi.fn().mockResolvedValueOnce({ status: "unavailable" });
		await act(async () => refreshBtn.click());
		await flush();
		const upToDate = container.querySelector('.system-notice[data-tone="success"]');
		expect(upToDate?.textContent).toBe("Metis is up to date");
		expect(upToDate?.closest(".workspace")).not.toBeNull();
		expect(container.querySelector(".sidebar-toast")).toBeNull();

		// 2. Failure notice and retry
		api.checkForUpdate = vi.fn().mockRejectedValueOnce(new Error("offline"));
		await act(async () => refreshBtn.click());
		await flush();
		const failed = container.querySelector('.system-notice[data-tone="error"]');
		expect(failed?.textContent).toContain("Update check failed");
		expect(failed?.textContent).toContain("Could not check for updates. Check your connection and try again.");
		expect(refreshBtn.disabled).toBe(false);

		// Retry succeeds
		api.checkForUpdate = vi.fn().mockResolvedValueOnce({ status: "unavailable" });
		await act(async () => refreshBtn.click());
		await flush();
		expect(container.querySelector('.system-notice[data-tone="success"]')?.textContent).toBe("Metis is up to date");

		// 3. Unsupported build notice
		api.checkForUpdate = vi.fn().mockRejectedValueOnce(new Error("Update checks are unavailable in this build"));
		await act(async () => refreshBtn.click());
		await flush();
		expect(container.querySelector('.system-notice[data-tone="info"]')?.textContent).toBe("Update checks are not supported in this build");

		// 4. Stale check does not overwrite downloading/ready state
		let resolveDelayedCheck: ((val: { status: "unavailable" }) => void) | undefined;
		api.checkForUpdate = vi.fn(
			() =>
				new Promise<{ status: "unavailable" }>((resolve) => {
					resolveDelayedCheck = resolve;
				}),
		);
		await act(async () => refreshBtn.click());
		await act(async () => emitUpdate({ status: "downloading", version: "0.81.0", releaseNotes: RELEASE_NOTES, progress: 60 }));
		const notice = container.querySelector<HTMLElement>(".sidebar-update-notice")!;
		expect(button(notice, "Downloading update 60%")).not.toBeNull();

		await act(async () => resolveDelayedCheck!({ status: "unavailable" }));
		await flush();
		expect(button(notice, "Downloading update 60%")).not.toBeNull();

		await act(async () => root.unmount());
	});

	it("places release notes in the workspace titlebar", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
		const { api } = createHarness({
			updateState: { status: "available", version: "0.81.0", releaseNotes: RELEASE_NOTES },
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		const end = container.querySelector<HTMLElement>(".workspace-titlebar-end")!;
		expect(end).not.toBeNull();
		expect([...end.children].map((child) => child.className)).toEqual(["release-notes-control"]);
		expect(button(container, "Open unread release notes")).toBeTruthy();
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

	it("requests Plugin Skills through the active task runtime", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const store = new AppStore();
		store.setSessions({
			sessions: [
				session("chat-shared", "chat", "/work/shared", "Chat"),
				session("code-other", "code", "/work/other", "Code"),
			],
			nextAfterSessionId: null,
		});
		const listSkills = vi.fn().mockResolvedValue({
			skills: [{ name: "shared", description: "Shared", source: "project" }],
		});
		const skillApi = { listSkills };
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(
			<PluginsPanel api={skillApi} preferences={new Map()} serverReady state={{ ...store.getSnapshot(), activeSessionId: "chat-shared" }} />,
		));
		await flush();
		expect(listSkills).toHaveBeenLastCalledWith({ sessionId: "chat-shared" });
		await act(async () => root.render(
			<PluginsPanel api={skillApi} preferences={new Map()} serverReady state={{ ...store.getSnapshot(), activeSessionId: "code-other" }} />,
		));
		await flush();
		expect(listSkills).toHaveBeenLastCalledWith({ sessionId: "code-other" });
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
		expect(api.renameSession).not.toHaveBeenCalled();
		expect(order).toEqual(["start"]);
		expect(api.startTurn).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "chat-created",
			text: "Inspect this project",
		}));
		await act(async () => root.unmount());
	});

	it("submits an unnamed session without renderer-side naming", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const unnamed = session("chat-unnamed", "chat", "/work/chat-project");
		localStorage.setItem("metis.activeSessionId.chat", unnamed.sessionId);
		const { api } = createHarness({ sessions: [unnamed] });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		const textarea = container.querySelector<HTMLTextAreaElement>("#composer-input")!;
		await act(async () => changeTextarea(textarea, "Keep the turn"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();
		expect(api.renameSession).not.toHaveBeenCalled();
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
		expect([...document.body.querySelectorAll(".session-action-menu [role=menuitem]")].map((item) => item.textContent?.trim())).toEqual(["Pin", "Copy title", "Delete"]);
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
		expect([...document.body.querySelectorAll(".session-action-menu [role=menuitem]")].map((item) => item.textContent?.trim())).toEqual(["Pin", "Copy title", "Rename", "Delete"]);
		await act(async () => button(document.body, "Pin").click());
		expect(button(container, "Pinned")).toBeTruthy();
		otherRow = button(container, "Other task").closest<HTMLElement>(".session-row")!;
		await act(async () => button(otherRow, "Actions for Other task").click());
		await act(async () => button(document.body, "Unpin").click());
		otherRow = button(container, "Other task").closest<HTMLElement>(".session-row")!;
		await act(async () => button(otherRow, "Actions for Other task").click());
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
		const runningButton = button(runningRow, "Running task");
		expect(runningButton.getAttribute("aria-busy")).toBe("true");
		expect(runningButton.querySelector(".session-button-title i.running")).not.toBeNull();
		expect(runningButton.querySelector("small")).toBeNull();
		await act(async () => button(runningRow, "Actions for Running task").click());
		expect(button(document.body, "Delete").disabled).toBe(true);
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

		const activeRow = button(container, "Active task").closest<HTMLElement>(".session-row")!;
		await act(async () => button(activeRow, "Actions for Active task").click());
		await act(async () => button(document.body, "Delete").click());
		await flush();
		await act(async () => button(container, "Move to Trash").click());
		await flush();
		expect(container.querySelector(".new-task-home")).not.toBeNull();
		expect(localStorage.getItem("metis.activeSessionId.chat")).toBeNull();
		await act(async () => root.unmount());
	});

	it("shows outcome notifications only until the user views that session", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const active = { ...session("chat-active", "chat", "/work/shared", "Active task"), unread: true, lastTurnOutcome: "completed" as const };
		const completed = {
			...session("chat-completed", "chat", "/work/shared", "Completed task"),
			state: "running" as const,
			unread: true,
			lastTurnOutcome: "completed" as const,
		};
		const failed = { ...session("chat-failed", "chat", "/work/shared", "Failed task"), unread: true, lastTurnOutcome: "failed" as const };
		const read = { ...session("chat-read", "chat", "/work/shared", "Read task"), lastTurnOutcome: "completed" as const };
		const attention = {
			...session("chat-attention", "chat", "/work/shared", "Attention task"),
			state: "running" as const,
			unread: true,
			lastTurnOutcome: "failed" as const,
			attentionRequired: true,
		};
		localStorage.setItem("metis.activeSessionId.chat", active.sessionId);
		const { api } = createHarness({ sessions: [active, completed, failed, read, attention] });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		expect(button(container, "Active task").querySelector("i.completed")).toBeNull();
		expect(button(container, "Read task").querySelector("i.completed")).toBeNull();
		expect(button(container, "Completed task").querySelector("i.completed")).not.toBeNull();
		expect(button(container, "Failed task").querySelector("i.failed")).not.toBeNull();
		const attentionButton = button(container, "Attention task");
		expect(attentionButton.querySelector("i.attention")).not.toBeNull();
		expect(attentionButton.getAttribute("aria-busy")).toBe("true");

		await act(async () => button(container, "Completed task").click());
		await flush();
		expect(api.markSessionRead).toHaveBeenCalledWith({ sessionId: completed.sessionId });
		expect(button(container, "Completed task").querySelector("i.completed")).toBeNull();
		await act(async () => button(container, "Failed task").click());
		await flush();
		expect(button(container, "Completed task").querySelector("i.completed")).toBeNull();

		await act(async () => root.unmount());
	});

	it("exposes rename, pin, copy, and delete through the session actions", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const active = session("chat-header-actions", "chat", "/work/shared", "Active task");
		localStorage.setItem("metis.activeSessionId.chat", active.sessionId);
		const { api } = createHarness({ sessions: [active] });
		const container = document.createElement("div");
		document.body.append(container);
		let root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Actions for Active task").click());
		expect([...document.body.querySelectorAll(".session-action-menu [role=menuitem]")].map((item) => item.textContent?.trim())).toEqual([
			"Pin",
			"Copy title",
			"Rename",
			"Delete",
		]);
		await act(async () => button(document.body, "Rename").click());
		let input = document.body.querySelector<HTMLInputElement>("#session-rename-input")!;
		expect(input.value).toBe("Active task");
		await act(async () => button(document.body, "Cancel").click());
		expect(api.renameSession).not.toHaveBeenCalled();

		await act(async () => button(document.body, "Rename").click());
		input = document.body.querySelector<HTMLInputElement>("#session-rename-input")!;
		await act(async () => changeInput(input, "Renamed active task"));
		await act(async () => input.form!.requestSubmit());
		await flush();
		expect(api.renameSession).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: active.sessionId,
			name: "Renamed active task",
		}));

		await act(async () => button(container, "Actions for Renamed active task").click());
		await act(async () => button(document.body, "Pin").click());
		const pinnedSection = button(container, "Pinned").closest<HTMLElement>(".session-section")!;
		expect(pinnedSection.textContent).toContain("Renamed active task");
		expect([...container.querySelectorAll<HTMLButtonElement>(".session-button")].filter((candidate) => candidate.getAttribute("aria-label") === "Renamed active task")).toHaveLength(1);
		const pinnedProject = projectRow(container, "/work/shared");
		expect(button(pinnedProject, "New task in shared")).not.toBeNull();
		expect(localStorage.getItem("metis.sessionPins.v1")).toBe(
			'{"version":1,"sessionIds":["chat-header-actions"]}',
		);

		await act(async () => root.unmount());
		root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		expect(button(container, "Pinned")).toBeTruthy();
		await act(async () => button(container, "Actions for Renamed active task").click());
		expect(button(document.body, "Unpin")).toBeTruthy();
		await act(async () => button(document.body, "Unpin").click());
		expect([...container.querySelectorAll<HTMLButtonElement>(".session-section-heading")].some((candidate) => candidate.textContent?.trim() === "Pinned")).toBe(false);
		expect(projectRow(container, "/work/shared").textContent).toContain("Renamed active task");

		await act(async () => button(container, "Actions for Renamed active task").click());
		await act(async () => button(document.body, "Copy title").click());
		expect(api.writeClipboardText).toHaveBeenCalledWith({ text: "Renamed active task" });

		await act(async () => button(container, "Actions for Renamed active task").click());
		await act(async () => button(document.body, "Delete").click());
		expect(container.querySelector(".project-dialog")?.textContent).toContain("Delete session?");
		await act(async () => button(container, "Cancel").click());
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
		expect(container.querySelector(".new-task-home")).not.toBeNull();
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
		const input = document.querySelector<HTMLInputElement>("#project-rename-input")!;
		expect(document.activeElement).toBe(input);
		await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
		await flush();
		expect(document.querySelector(".project-dialog")).toBeNull();
		expect(document.activeElement?.textContent?.trim()).toBe("Rename");
		await act(async () => button(chatGroup, "Rename").click());
		await flush();
		const reopenedInput = document.querySelector<HTMLInputElement>("#project-rename-input")!;
		await act(async () => changeInput(reopenedInput, "  Chat alias  "));
		await act(async () => button(projectDialog(), "Rename").click());
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
		saveSessionPins(localStorage, new Set([chatActive.sessionId, chatArchived.sessionId, code.sessionId]));
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
		expect(api.previewProjectDelete).toHaveBeenCalledWith({ mode: "chat", cwd: "/work/shared" });
		expect(projectDialog().textContent).toContain("2 Chat sessions");
		expect(projectDialog().textContent).toContain("/canonical/shared");
		expect(projectDialog().textContent).toContain("Code project and its memory are unchanged");
		expect(projectDialog().textContent).toContain("source folder and its files are unchanged");
		expect(projectDialog().textContent).toContain("Schedules are not deleted automatically");
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
		expect(container.querySelector(".new-task-home")).not.toBeNull();
		expect(localStorage.getItem("metis.activeSessionId.chat")).toBeNull();
		expect([...loadProjectPreferences(localStorage).values()]).toEqual([
			{ mode: "code", cwd: "/work/shared", alias: "Code local", pinned: false },
		]);
		expect(loadSessionPins(localStorage)).toEqual(new Set([code.sessionId]));
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
		expect(projectDialog().textContent).toContain("delete response was lost");
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
		expect(projectDialog().textContent).toContain("Checking project data");
		await act(async () => button(container, "Cancel").click());
		await act(async () => button(groupB, "Project actions").click());
		await act(async () => button(groupB, "Delete").click());
		await flush();
		expect(projectDialog().textContent).toContain("/canonical/b");
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
		expect(projectDialog().textContent).toContain("/canonical/b");
		expect(projectDialog().textContent).not.toContain("/canonical/a");
		await act(async () => root.unmount());
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
						message: "Remove the generated cache.",
						createdAt: "2026-07-20T00:00:00.000Z",
						kind: "session_permission_approval",
						requestId: "00000000-0000-4000-8000-000000000204",
						actionId: "action-bash-cache",
						toolLabel: "bash",
						riskLevel: "critical",
						executionTarget: "sandbox",
						reason: "Remove the generated cache.",
						scopeComplete: true,
						details: [
							{ label: "Command", value: "rm cache.tmp" },
							{ label: "Working directory", value: "/tmp/work" },
						],
						choices: ["allow-once", "always-allow-exact", "deny-once"],
					},
				},
			},
		}));

		const panel = container.querySelector<HTMLElement>(".permission-approval-panel")!;
		expect(panel).not.toBeNull();
		expect(container.querySelector(".composer-dock > .permission-approval-slot + .composer-chat")).not.toBeNull();
		expect(container.querySelector(".modal-backdrop")).toBeNull();
		expect(panel.getAttribute("aria-modal")).toBeNull();
		expect(panel.textContent).toContain("Metis wants to use bash");
		expect(panel.textContent).toContain("Command");
		expect(panel.textContent).toContain("rm cache.tmp");
		expect(panel.textContent).toContain("Working directory");
		expect(panel.textContent).toContain("/tmp/work");
		expect(panel.textContent).toContain("workspace sandbox");
		expect(panel.textContent).toContain("Always allow this exact action");
		expect(panel.querySelector("#permission-approval-reason")?.textContent).toContain(
			"Remove the generated cache.",
		);
		expect(panel.textContent).not.toContain("Arguments:");
		await act(async () => button(panel, "Allow once").click());
		await flush();
		expect(api.respondToInteraction).toHaveBeenCalledWith({
			interactionId: "00000000-0000-4000-8000-000000000204",
			kind: "session_permission_approval",
			choice: "allow-once",
		});
		expect(container.querySelector(".permission-approval-panel")).toBeNull();
		await act(async () => root.unmount());
	});

	it("opens ask_user from the composer and confirms before returning a structured answer", async () => {
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
		expect(dock.querySelector(".composer")?.classList.contains("is-awaiting-answer")).toBe(true);
		expect(dock.querySelector(".composer-editable-input")?.getAttribute("contenteditable")).toBe("false");
		expect(container.querySelector(".modal-backdrop")).toBeNull();
		expect(container.querySelector(".conversation-column > .ask-user-slot")).toBeNull();
		expect(panel.textContent).toContain("Where should the data be stored?");
		expect(panel.textContent).toContain("Something else");

		await act(async () => [...panel.querySelectorAll<HTMLButtonElement>(".ask-user-option")]
			.find((candidate) => candidate.textContent?.includes("Cloud"))?.click());
		expect(api.respondToInteraction).not.toHaveBeenCalled();
		await act(async () => { panel.querySelector<HTMLButtonElement>(".ask-user-step")!.click(); await new Promise(r => setTimeout(r, 180)); });
		await flush();
		expect(api.respondToInteraction).toHaveBeenCalledWith({
			interactionId: "00000000-0000-4000-8000-000000000206",
			kind: "ask_user",
			cancelled: false,
			answers: [{ questionId: "question:0", choiceIds: ["choice:1"] }],
		});
		expect(container.querySelector(".ask-user-panel")).toBeNull();
		expect(document.activeElement).toBe(dock.querySelector(".composer-editable-input"));
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
		expect(container.querySelector(".new-task-home")).not.toBeNull();
		expect(container.querySelector(".workspace-tabbar")).not.toBeNull();
		await act(async () => activeWorkspace(container).querySelector<HTMLButtonElement>(".tool-add-trigger")!.click());
		expect(container.querySelector<HTMLButtonElement>(".tool-add-menu button")!.disabled).toBe(true);
		expect(container.querySelector(".home-project-picker-select")).toBeNull();
		expect(container.querySelectorAll<HTMLButtonElement>('.home-project-picker button[aria-label="Choose folder"]')).toHaveLength(1);

		await act(async () => button(container, "Choose folder").click());
		await flush();
		expect(api.selectProjectFolder).toHaveBeenCalledTimes(1);
		expect(api.createSession).not.toHaveBeenCalled();
		expect(container.textContent).toContain("selected-project");

		const textarea = (container.querySelector("textarea") ?? container.querySelector("#composer-input"))!;
		await act(async () => changeTextarea(textarea, "  Analyze this repository\ncarefully  "));
		order.length = 0;
		await act(async () => textarea.form!.requestSubmit());
		await flush();
		await flush();

		expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({
			mode: "chat",
			cwd: "/work/selected-project",
		}));
		expect(vi.mocked(api.createSession).mock.calls[0]![0]).not.toHaveProperty("name");
		expect(api.startTurn).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "chat-created",
			text: "Analyze this repository\ncarefully",
		}));
		expect(order).toEqual(["create", "list", "focus", "start"]);
		expect(container.querySelector(".tool-add-trigger")).not.toBeNull();

		await act(async () => root.unmount());
	});

	it("offers nine starters without creating a session until the user sends", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		await act(async () => button(container, "New task").click());
		const heading = container.querySelector(".new-task-home-heading h1")?.textContent;
		expect(container.querySelector(".new-task-home-heading p")).toBeNull();
		expect(container.querySelectorAll(".new-task-starter")).toHaveLength(9);
		expect(container.querySelector(".new-task-side-rays")).not.toBeNull();
		const creates = vi.mocked(api.createSession).mock.calls.length;
		await act(async () => container.querySelector<HTMLButtonElement>('[data-starter-id="slides"]')!.click());
		const editor = container.querySelector<HTMLElement>("#composer-input")!;
		expect(editor.textContent).toContain("editable presentation");
		expect(vi.mocked(api.createSession).mock.calls.length).toBe(creates);
		expect(api.startTurn).not.toHaveBeenCalled();
		await act(async () => changeTextarea(editor, "My slide topic"));
		expect(container.querySelector(".new-task-home-heading h1")?.textContent).toBe(heading);
		await act(async () => root.unmount());
	});

	it("renders a stable configured-name greeting and updates the nickname", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const poolFor = (previousId?: string) => HOME_GREETINGS.filter(
			(item) => (item.period === getHomePeriod(new Date()) || item.period === "anytime") && item.id !== previousId,
		);
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			// Prime the module-level previous greeting, then aim the random mock at
			// "anytime-task" inside the pool that excludes it.
			const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
			await act(async () => root.render(<App api={api} store={new AppStore()} />));
			await flush();
			await act(async () => button(container, "New task").click());
			const primed = container.querySelector(".new-task-home-heading h1")?.textContent;
			const primedId = HOME_GREETINGS.find(
				(item) => item.key.replace("{{name}}", DEFAULT_PROFILE_IDENTITY.displayName) === primed,
			)?.id;
			expect(primedId).toBeDefined();
			expect(primed).toContain(DEFAULT_PROFILE_IDENTITY.displayName);
			await act(async () => root.unmount());

			const target = poolFor(primedId).findIndex((item) => item.id === "anytime-task");
			vi.spyOn(Math, "random").mockReturnValue(target / poolFor(primedId).length);
			saveProfileIdentity({ displayName: "小林", avatarDataUrl: null });
			const root2 = createRoot(container);
			await act(async () => root2.render(<App api={api} store={new AppStore()} />));
			await flush();
			await act(async () => button(container, "New task").click());
			const heading = () => container.querySelector(".new-task-home-heading h1")?.textContent;
			expect(heading()).toContain("小林");
			expect(heading()).not.toContain("Metis User");
			const sentence = heading();
			await act(async () => saveProfileIdentity({ displayName: "元宝", avatarDataUrl: null }));
			await flush();
			expect(heading()).toContain("元宝");
			expect(heading()).toBe(sentence?.replace("小林", "元宝"));
			const editor = container.querySelector<HTMLElement>("#composer-input")!;
			await act(async () => changeTextarea(editor, "typing must not reshuffle the greeting"));
			expect(heading()).toBe(sentence?.replace("小林", "元宝"));
			await act(async () => root2.unmount());
		} finally {
			vi.restoreAllMocks();
			saveProfileIdentity(DEFAULT_PROFILE_IDENTITY);
		}
	});

	it("prefills the localized prompt and keeps the greeting stable while typing", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		await setLocale("zh-CN", localStorage);
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		await act(async () => button(container, "新建任务").click());
		const before = container.querySelector(".new-task-home-heading h1")?.textContent;
		await act(async () => container.querySelector<HTMLButtonElement>('[data-starter-id="report"]')!.click());
		const editor = container.querySelector<HTMLElement>("#composer-input")!;
		expect(editor.textContent).toContain("请帮我做一份关于[汇报主题]的汇报");
		await act(async () => changeTextarea(editor, "我的季度汇报"));
		expect(container.querySelector(".new-task-home-heading h1")?.textContent).toBe(before);
		expect(api.startTurn).not.toHaveBeenCalled();
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
		const textarea = (container.querySelector<HTMLElement>("textarea") ?? container.querySelector<HTMLElement>("#composer-input"))!;
		await act(async () => changeTextarea(textarea, "Start without a folder"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();
		await flush();

		const createInput = vi.mocked(api.createSession).mock.calls[0]![0];
		expect(createInput).toMatchObject({
			mode: "chat",
		});
		expect(createInput).not.toHaveProperty("cwd");
		expect(createInput).not.toHaveProperty("name");
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
		const trigger = button(container, "Select permissions, current Auto");
		await act(async () => trigger.click());
		expect(container.querySelector('[role="menu"]')).not.toBeNull();
		await act(async () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
		expect(container.querySelector('[role="menu"]')).toBeNull();
		expect(document.activeElement).toBe(trigger);

		await act(async () => trigger.click());
		await act(async () => menuOption(container, "Full").click());
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(button(container, "Select permissions, current Full")).not.toBeNull();
		const textarea = (container.querySelector<HTMLElement>("textarea") ?? container.querySelector<HTMLElement>("#composer-input"))!;
		await act(async () => changeTextarea(textarea, "Run with full access"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();
		await flush();

		expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({
			mode: "chat",
			permissionPreset: "full",
		}));
		expect(api.setPermissionPreset).not.toHaveBeenCalled();
		await act(async () => root.unmount());
	});

	it("keeps a session permission change local to its control until the server event arrives", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api, emitEvent } = createHarness();
		let resolveChange!: (result: { permissionPreset: "full" }) => void;
		vi.mocked(api.setPermissionPreset).mockImplementationOnce(() => new Promise((resolve) => {
			resolveChange = resolve;
		}));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Select permissions, current Ask").click());
		await act(async () => menuOption(container, "Full").click());
		const pendingTrigger = button(container, "Select permissions, current Ask");
		expect(pendingTrigger.disabled).toBe(true);
		for (const label of ["Chat", "Code", "New task", "Customize", "Chat project task"]) {
			expect(button(container, label).disabled, label).toBe(false);
		}

		await act(async () => resolveChange({ permissionPreset: "full" }));
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
						type: "session/permissionPresetChanged",
						sessionId: "chat-existing",
						permissionPreset: "full",
						effectiveSettings: { sandboxPolicy: "danger-full-access", approvalPolicy: "user" },
						constrainedByParent: false,
						sandboxHealth: "healthy",
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
		expect(container.querySelector(".new-task-side-rays")).not.toBeNull();
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

	it("preserves a completion notification while switching away from the session", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const active = session("chat-active", "chat", "/work/shared", "Active task");
		const next = session("chat-next", "chat", "/work/shared", "Next task");
		localStorage.setItem("metis.activeSessionId.chat", active.sessionId);
		const { api, emitEvent } = createHarness({ sessions: [active, next] });
		const store = new AppStore();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={store} />));
		await flush();

		let resolveOpen!: (value: SessionSnapshot) => void;
		vi.mocked(api.openSession).mockImplementationOnce(() => new Promise((resolve) => {
			resolveOpen = resolve;
		}));
		act(() => button(container, "Next task").click());
		await act(async () => resolveOpen(snapshot(next)));
		await act(async () => emitEvent({
			type: "app-server",
			envelope: {
				jsonrpc: "2.0",
				method: "connection/events",
				params: {
					serverEpoch: EPOCH,
					fromCursor: 3,
					toCursor: 3,
					events: [{
						type: "session/updated",
						session: { ...active, unread: true, lastTurnOutcome: "completed" },
					}],
				},
			},
		}));

		expect(api.markSessionRead).not.toHaveBeenCalled();
		expect(button(container, "Active task").querySelector("i.completed")).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("resnapshots the real permission after a partial downgrade failure", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		const summary = session("chat-existing", "chat", "/work/chat-project", "Chat project task");
		vi.mocked(api.openSession)
			.mockResolvedValueOnce({ ...snapshot(summary), permissionPreset: "full" })
			.mockResolvedValueOnce({ ...snapshot(summary), permissionPreset: "ask" });
		vi.mocked(api.setPermissionPreset).mockRejectedValueOnce(new Error("child downgrade failed"));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Select permissions, current Full").click());
		await act(async () => menuOption(container, "Ask").click());
		await flush();
		await flush();

		expect(api.openSession).toHaveBeenCalledTimes(2);
		expect(button(container, "Select permissions, current Ask")).not.toBeNull();
		expect(container.textContent).toContain("child downgrade failed");
		await act(async () => root.unmount());
	});

	it.each([false, true])("allows live permission changes without stopping the turn (waiting approval=%s)", async (waiting) => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api, emitEvent } = createHarness();
		const running = { ...session("chat-existing", "chat", "/work/chat-project", "Chat project task"), state: "running" as const };
		const interactionId = "22222222-2222-4222-8222-222222222222";
		vi.mocked(api.openSession).mockResolvedValueOnce({
			...snapshot(running), activeTurnId: "turn-running",
			pendingInteractions: waiting ? [{ interactionId, sessionId: "chat-existing", title: "Approve bash?",
				message: "Approval required", createdAt: "2026-09-20T00:00:00.000Z", kind: "session_permission_approval",
				requestId: interactionId, actionId: "bash-call", toolLabel: "bash", riskLevel: "low", executionTarget: "sandbox",
				reason: "Approval required", scopeComplete: true, details: [], choices: ["allow-once", "deny-once"] }] : [],
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		const store = new AppStore();
		await act(async () => root.render(<App api={api} store={store} />));
		await flush();
		expect(button(container, "Select permissions, current Ask").disabled).toBe(false);
		await act(async () => button(container, "Select permissions, current Ask").click());
		await act(async () => menuOption(container, "Full").click());
		expect(api.setPermissionPreset).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "chat-existing", permissionPreset: "full" }));
		expect(api.interruptTurn).not.toHaveBeenCalled();
		expect(store.getSnapshot().activeTurnId).toBe("turn-running");
		if (waiting) {
			expect(store.getSnapshot().interactionsById.has(interactionId)).toBe(true);
			await act(async () => emitEvent({ type: "interaction-cancelled", interactionId }));
			expect(store.getSnapshot().interactionsById.has(interactionId)).toBe(false);
			expect(container.querySelector(".permission-approval-panel")).toBeNull();
		}
		await act(async () => root.unmount());
	});

	it("enters Plan mode with /plan and disables sending while the change is in flight", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api, emitEvent } = createHarness();
		let resolveMode!: (value: { collaborationMode: "plan" }) => void;
		vi.mocked(api.setCollaborationMode).mockImplementationOnce(
			() => new Promise((resolve) => {
				resolveMode = resolve;
			}),
		);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		const editor = container.querySelector<HTMLElement>("#composer-input")!;
		await act(async () => changeTextarea(editor, "/plan"));
		const option = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
			.find((candidate) => candidate.querySelector("strong")?.textContent === "/plan")!;
		await act(async () => option.click());
		expect(api.setCollaborationMode).toHaveBeenCalledWith(expect.objectContaining({ collaborationMode: "plan" }));
		expect(button(container, "Exit Plan mode").disabled).toBe(true);
		expect(container.querySelector(".collaboration-mode-indicator")?.textContent).toBe("Plan");
		await act(async () => changeTextarea(editor, "Create a safe plan"));
		expect(button(container, "Send message").disabled).toBe(true);
		await act(async () => editor.closest("form")!.requestSubmit());
		expect(api.startTurn).not.toHaveBeenCalled();

		await act(async () => resolveMode({ collaborationMode: "plan" }));
		await act(async () => {
			emitEvent({
				type: "app-server",
				envelope: {
					jsonrpc: "2.0",
					method: "connection/events",
					params: {
						serverEpoch: EPOCH,
						fromCursor: 1,
						toCursor: 1,
						events: [{
							type: "session/collaborationModeChanged",
							sessionId: "chat-existing",
							collaborationMode: "plan",
						}],
					},
				},
			});
		});
		await flush();
		const exitPlanMode = button(container, "Exit Plan mode");
		expect(exitPlanMode.disabled).toBe(false);
		const leading = container.querySelector(".composer-leading")!;
		expect(leading.children[0]?.classList.contains("composer-add")).toBe(true);
		expect(leading.children[1]?.classList.contains("permission-selector")).toBe(true);
		expect(leading.children[2]?.classList.contains("collaboration-mode-control")).toBe(true);
		expect(exitPlanMode.querySelector(".collaboration-mode-active-icon")).not.toBeNull();
		expect(exitPlanMode.querySelector(".collaboration-mode-exit-icon")).not.toBeNull();

		await act(async () => changeTextarea(editor, "/plan"));
		const activePlanOption = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
			.find((candidate) => candidate.querySelector("strong")?.textContent === "/plan")!;
		expect(activePlanOption.getAttribute("aria-disabled")).toBe("true");
		await act(async () => activePlanOption.click());
		expect(api.setCollaborationMode).toHaveBeenCalledTimes(1);

		await act(async () => exitPlanMode.click());
		expect(api.setCollaborationMode).toHaveBeenLastCalledWith(expect.objectContaining({ collaborationMode: "default" }));
		expect(container.querySelector(".collaboration-mode-control")).toBeNull();
		await act(async () => root.unmount());
	});

	it("disables /plan while a turn is running", async () => {
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

		const editor = container.querySelector<HTMLElement>("#composer-input")!;
		await act(async () => changeTextarea(editor, "/plan"));
		const option = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
			.find((candidate) => candidate.querySelector("strong")?.textContent === "/plan")!;
		expect(option.getAttribute("aria-disabled")).toBe("true");
		await act(async () => option.click());
		expect(api.setCollaborationMode).not.toHaveBeenCalled();
		await act(async () => root.unmount());
	});

	it("keeps Code project selection in the draft until first send", async () => {
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

		expect(container.querySelector(".new-task-home")).not.toBeNull();
		expect(container.querySelectorAll("#composer-input")).toHaveLength(1);
		expect(api.selectProjectFolder).not.toHaveBeenCalled();
		expect(api.createSession).not.toHaveBeenCalled();
		expect(container.querySelector(".home-project-picker-select")).toBeNull();
		expect(
			[...container.querySelectorAll<HTMLButtonElement>(".home-project-picker button")]
				.slice(0, 2)
				.map((candidate) => candidate.getAttribute("aria-label")),
		).toEqual(["Choose folder", "Create a new project"]);

		const editor = container.querySelector<HTMLElement>("#composer-input")!;
		await act(async () => changeTextarea(editor, "Keep this draft while choosing a project"));
		const recentProjectRow = [...container.querySelectorAll<HTMLButtonElement>(".new-task-recent-project")]
			.find((candidate) => candidate.textContent?.includes("code-project"));
		expect(recentProjectRow).not.toBeUndefined();
		await act(async () => recentProjectRow!.click());
		expect(container.textContent).toContain("code-project");
		expect(editor.value).toBe("Keep this draft while choosing a project");
		expect(document.activeElement).toBe(editor);
		expect(api.createSession).not.toHaveBeenCalled();

		await act(async () => button(container, "Choose folder").click());
		await flush();
		expect(api.selectProjectFolder).toHaveBeenCalledTimes(1);
		expect(api.createSession).not.toHaveBeenCalled();
		expect(container.textContent).toContain("selected-project");

		await act(async () => changeTextarea(editor, "Inspect this codebase"));
		order.length = 0;
		await act(async () => editor.form!.requestSubmit());
		await flush();
		await flush();

		expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({
			mode: "code",
			cwd: "/work/selected-project",
		}));
		expect(api.startTurn).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "code-created",
			text: "Inspect this codebase",
		}));
		expect(order).toEqual(["create", "list", "focus", "start"]);
		expect(container.querySelector(".new-task-home")).toBeNull();
		await act(async () => root.unmount());
	});

	it("opens the Code home without opening a project setup dialog", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Code").click());
		await flush();
		expect(container.querySelector('[role="dialog"]')).toBeNull();
		expect(container.querySelector(".new-task-home")).not.toBeNull();
		expect(container.querySelectorAll("#composer-input")).toHaveLength(1);
		const editor = container.querySelector<HTMLElement>("#composer-input")!;
		await act(async () => changeTextarea(editor, "A Code task still needs a project"));
		expect(button(container, "Send message").disabled).toBe(true);
		await act(async () => editor.form!.requestSubmit());
		expect(api.createSession).not.toHaveBeenCalled();
		expect(projectRow(container, "/work/code-project")).not.toBeNull();
		expect(container.querySelector('[data-active-session-id="code-existing"]')).toBeNull();
		expect(api.openSession).not.toHaveBeenCalled();
		expect(api.createSession).not.toHaveBeenCalled();
		await act(async () => root.unmount());
	});

	it("isolates the home draft when switching from Chat to a historyless Code mode", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		saveProfileIdentity({ displayName: "Ava", avatarDataUrl: null });
		vi.spyOn(Math, "random").mockReturnValue(0.999999);
		const { api } = createHarness({ sessions: [] });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<App api={api} store={new AppStore()} />));
			await flush();
			expect(container.querySelector<HTMLElement>(".new-task-home")?.dataset.mode).toBe("chat");
			expect(container.querySelectorAll(".new-task-starter")).toHaveLength(9);
			const chatEditor = container.querySelector<HTMLElement>("#composer-input")!;
			await act(async () => changeTextarea(chatEditor, "Chat draft must not follow the mode switch"));

			await act(async () => button(container, "Code").click());
			await flush();

			expect(container.querySelector<HTMLElement>(".new-task-home")?.dataset.mode).toBe("code");
			expect(container.querySelectorAll(".new-task-starter")).toHaveLength(6);
			const codeEditor = container.querySelector<HTMLElement>("#composer-input")!;
			expect(codeEditor.value).toBe("");
			expect(container.querySelector(".new-task-home-heading h1")?.textContent).toContain("build");
		} finally {
			saveProfileIdentity(DEFAULT_PROFILE_IDENTITY);
			await act(async () => root.unmount());
		}
	});

	it("keeps a newly created Code project in the draft until first send", async () => {
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
		const draftEditor = container.querySelector<HTMLElement>("#composer-input")!;
		await act(async () => changeTextarea(draftEditor, "Draft survives project setup cancellation"));
		await act(async () => button(container, "Create a new project").click());
		await flush();
		await act(async () => button(container, "Cancel").click());
		expect(container.querySelector("[role=dialog]")).toBeNull();
		expect(draftEditor.value).toBe("Draft survives project setup cancellation");
		expect(api.createSession).not.toHaveBeenCalled();

		await act(async () => button(container, "Create a new project").click());
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
		expect(container.querySelector("[role=dialog]")).toBeNull();
		expect(container.querySelector(".new-task-home")).not.toBeNull();
		expect(container.textContent).toContain("Desktop App");
		expect(api.createSession).not.toHaveBeenCalled();

		const editor = container.querySelector<HTMLElement>("#composer-input")!;
		await act(async () => changeTextarea(editor, "Initialize the app"));
		await act(async () => editor.form!.requestSubmit());
		await flush();
		await flush();

		expect(api.createSession).toHaveBeenCalledWith(expect.objectContaining({
			mode: "code",
			cwd: "/Users/test/Metis Projects/Desktop App",
		}));
		expect(api.startTurn).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "code-created",
			text: "Initialize the app",
		}));
		await act(async () => root.unmount());
	});

	it("ignores a stale Code project creation callback after the draft changes", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		let resolveCreate!: (cwd: string) => void;
		api.createProjectFolder = vi.fn(() => new Promise<string>((resolve) => {
			resolveCreate = resolve;
		}));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		await act(async () => button(container, "Code").click());
		await flush();
		await act(async () => button(container, "New task").click());
		await act(async () => button(container, "Create a new project").click());
		await flush();
		await act(async () => changeInput(container.querySelector<HTMLInputElement>("#code-project-name")!, "Stale Project"));
		await act(async () => container.querySelector<HTMLFormElement>(".code-project-form")!.requestSubmit());
		await flush();

		await act(async () => button(container, "Chat").click());
		await flush();
		await act(async () => button(container, "Code").click());
		await flush();
		expect(container.querySelector(".new-task-home")).not.toBeNull();
		expect(container.textContent).not.toContain("Stale Project");

		await act(async () => resolveCreate("/work/stale-project"));
		await flush();
		expect(container.textContent).not.toContain("stale-project");
		expect(api.createSession).not.toHaveBeenCalled();
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
		expect(container.querySelector(".composer-file-card")?.textContent).toContain("report.pdf");
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

	it("routes slash commands to existing controls and the session status panel", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		expect(container.querySelector(".composer-cache-hit")).toBeNull();
		const textarea = (container.querySelector("textarea") ?? container.querySelector("#composer-input"))!;
		const run = async (command: string) => {
			await act(async () => changeTextarea(textarea, `/${command}`));
			const option = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
				.find((candidate) => candidate.querySelector("strong")?.textContent === `/${command}`)!;
			await act(async () => option.click());
			await flush();
		};

		await run("status");
		expect(api.getSessionStatus).toHaveBeenCalledWith({ sessionId: "chat-existing" });
		expect(container.querySelector(".session-status-panel")?.textContent).toContain("50% Full");
		expect(container.querySelector(".session-status-panel")?.textContent).toContain("~64.0K / 128K");
		expect(container.querySelector(".session-status-panel")?.textContent).toContain("Cache hit rate");
		expect(container.querySelector(".session-status-panel")?.textContent).toContain("25%");
		expect(container.querySelector(".context-usage-ring")).not.toBeNull();

		await run("model");
		expect(container.querySelector(".session-status-panel.is-closing")).not.toBeNull();
		expect(container.querySelector('.model-selector-popover[role="menu"]')).not.toBeNull();
		await act(async () => new Promise((resolve) => setTimeout(resolve, 180)));
		expect(container.querySelector(".session-status-panel")).toBeNull();
		await run("thinking");
		expect(container.querySelector(".model-selector-popover")).toBeNull();
		expect(container.querySelector(".effort-popover")).not.toBeNull();
		await run("mcp");
		expect(container.querySelector(".effort-popover")).toBeNull();
		expect(container.querySelector(".composer-mcp-menu")?.textContent).toContain("deepwiki");
		await act(async () => root.unmount());
	});

	it("keeps the newest context status when an older request resolves last", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		vi.mocked(api.listMcpServers).mockResolvedValue({ servers: [] });
		const pending: Array<{
			resolve: (status: ClientResult<"session/status">) => void;
		}> = [];
		vi.mocked(api.getSessionStatus).mockImplementation(() =>
			new Promise<ClientResult<"session/status">>((resolve) => pending.push({ resolve })),
		);
		const status = (tokens: number, contextWindow: number): ClientResult<"session/status"> => ({
			sessionId: "chat-existing",
			mode: "code",
			contextTokens: tokens,
			contextWindow,
			contextBasis: "estimated_total",
			contextBreakdown: [{ category: "conversation", tokens }],
			remainingPercent: Math.max(0, 100 - (tokens / contextWindow) * 100),
			cacheHitPercent: null,
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		const older = [...pending];
		await act(async () => container.querySelector<HTMLButtonElement>(".context-usage-ring")!.click());
		await flush();
		const newest = pending.at(-1)!;
		await act(async () => newest.resolve(status(200_000, 1_000_000)));
		await flush();
		expect(container.querySelector(".context-usage-ring")?.getAttribute("aria-label")).toContain("20%");

		await act(async () => {
			for (const request of older) request.resolve(status(64_000, 128_000));
		});
		await flush();
		expect(container.querySelector(".context-usage-ring")?.getAttribute("aria-label")).toContain("20%");
		expect(container.querySelector(".context-usage-ring")?.getAttribute("aria-label")).not.toContain("50%");
		await act(async () => root.unmount());
	});

	it("toggles the context status panel from the usage ring", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		const ring = container.querySelector<HTMLButtonElement>(".context-usage-ring")!;

		await act(async () => ring.click());
		await flush();
		expect(container.querySelector(".session-status-panel")).not.toBeNull();
		expect(ring.getAttribute("aria-expanded")).toBe("true");

		await act(async () => ring.dispatchEvent(new Event("pointerdown", { bubbles: true })));
		expect(container.querySelector(".session-status-panel.is-closing")).toBeNull();
		expect(ring.getAttribute("aria-expanded")).toBe("true");
		await act(async () => ring.click());
		expect(container.querySelector(".session-status-panel.is-closing")).not.toBeNull();
		expect(ring.getAttribute("aria-expanded")).toBe("false");
		await act(async () => new Promise((resolve) => setTimeout(resolve, 180)));
		expect(container.querySelector(".session-status-panel")).toBeNull();
		await act(async () => root.unmount());
	});

	it("refreshes context status when the active model snapshot changes", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		const store = new AppStore();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={store} />));
		await flush();
		vi.mocked(api.getSessionStatus).mockClear();
		const summary = session("chat-existing", "chat", "/work/chat-project", "Chat project task");
		await act(async () => store.applySnapshot({
			...snapshot(summary),
			model: { provider: "test-provider", modelId: "other-model" },
		}));
		await flush();
		expect(api.getSessionStatus).toHaveBeenCalledWith({ sessionId: "chat-existing" });
		await act(async () => root.unmount());
	});

	it("routes /goal text to setSessionGoal without starting a turn", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		const textarea = (container.querySelector("textarea") ?? container.querySelector("#composer-input"))!;
		await act(async () => changeTextarea(textarea, "/goal keep tests green"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();
		expect(api.setSessionGoal).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "chat-existing",
				objective: "keep tests green",
			}),
		);
		expect(api.startTurn).not.toHaveBeenCalled();
		await act(async () => root.unmount());
	})
	// --- First-send composer transition ---

	function spyHomeTransition() {
		const originalAnimate = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "animate");
		const originalRect = HTMLElement.prototype.getBoundingClientRect;
		const animate = vi.fn().mockReturnValue({
			finished: Promise.resolve(),
			cancel: vi.fn(),
		} as unknown as Animation);
		Object.defineProperty(HTMLElement.prototype, "animate", { configurable: true, value: animate });
		const rectSpy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect")
			.mockImplementation(function (this: HTMLElement) {
				if (this.matches(".new-task-home .composer")) return new DOMRect(410, 196, 770, 132);
				if (this.matches(".conversation-column .composer")) return new DOMRect(410, 700, 770, 120);
				return originalRect.call(this);
			});
		return {
			animate,
			restore: async (root?: { unmount: () => Promise<void> }) => {
				if (root) await act(async () => root.unmount());
				rectSpy.mockRestore();
				if (originalAnimate) Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
				else Reflect.deleteProperty(HTMLElement.prototype, "animate");
			},
		};
	}

	it("keeps a failed first message editable on the home page", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		vi.mocked(api.startTurn).mockRejectedValueOnce(new Error("offline"));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		await act(async () => button(container, "New task").click());
		const editor = container.querySelector<HTMLElement>("#composer-input")!;
		await act(async () => changeTextarea(editor, "Keep this report draft"));
		await act(async () => container.querySelector<HTMLFormElement>(".new-task-home form")!.requestSubmit());
		await flush();
		expect(container.querySelector(".new-task-home")).not.toBeNull();
		expect(editor.textContent).toBe("Keep this report draft");
		expect(editor.getAttribute("contenteditable")).toBe("true");
		expect(container.querySelector('[data-home-transition="running"]')).toBeNull();
		await act(async () => root.unmount());
	});

	it("animates the real conversation composer once after the first successful send", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const transition = spyHomeTransition();
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<App api={api} store={new AppStore()} />));
			await flush();
			await act(async () => button(container, "New task").click());
			const editor = container.querySelector<HTMLElement>("#composer-input")!;
			await act(async () => changeTextarea(editor, "Create a report"));
			await act(async () => container.querySelector<HTMLFormElement>(".new-task-home form")!.requestSubmit());
			await flush();
			await flush();
			expect(api.startTurn).toHaveBeenCalledTimes(1);
			expect(container.querySelector(".new-task-home")).toBeNull();
			expect(container.querySelectorAll("#composer-input")).toHaveLength(1);
			expect(transition.animate).toHaveBeenCalledTimes(1);
			expect(transition.animate.mock.calls[0]?.[0]).toEqual([
				{ transform: "translate(0px, -504px)", width: "770px" },
				{ transform: "translate(0px, 0px)", width: "770px" },
			]);
		} finally {
			await transition.restore(root);
		}
	});

	it("animates once when the retried first send succeeds", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const transition = spyHomeTransition();
		const { api } = createHarness({ loseFirstStartResponse: true });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<App api={api} store={new AppStore()} />));
			await flush();
			await act(async () => button(container, "New task").click());
			const editor = container.querySelector<HTMLElement>("#composer-input")!;
			await act(async () => changeTextarea(editor, "Report draft that survives a lost response"));
			const form = container.querySelector<HTMLFormElement>(".new-task-home form")!;
			await act(async () => form.requestSubmit());
			await flush();
			expect(container.querySelector(".new-task-home")).not.toBeNull();
			expect(transition.animate).not.toHaveBeenCalled();
			await act(async () => form.requestSubmit());
			await flush();
			await flush();
			expect(api.createSession).toHaveBeenCalledTimes(1);
			expect(api.startTurn).toHaveBeenCalledTimes(2);
			expect(container.querySelector(".new-task-home")).toBeNull();
			expect(transition.animate).toHaveBeenCalledTimes(1);
		} finally {
			await transition.restore(root);
		}
	});

	it("does not animate when the user opens settings during the first send", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const transition = spyHomeTransition();
		const { api } = createHarness();
		let release!: () => void;
		const pendingStart = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.mocked(api.startTurn).mockImplementationOnce(async () => {
			await pendingStart;
			return {};
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<App api={api} store={new AppStore()} />));
			await flush();
			await act(async () => button(container, "New task").click());
			const editor = container.querySelector<HTMLElement>("#composer-input")!;
			await act(async () => changeTextarea(editor, "A draft that is still being submitted"));
			await act(async () => container.querySelector<HTMLFormElement>(".new-task-home form")!.requestSubmit());
			await flush();
			expect(container.querySelector(".new-task-home")).not.toBeNull();
			expect(transition.animate).not.toHaveBeenCalled();
			// Sidebar navigation is disabled while the draft is busy, but the account
			// menu stays available: opening settings must cancel the pending ticket.
			await act(async () => button(container, "Metis User").click());
			await act(async () => button(container, "Settings").click());
			await flush();
			await act(async () => button(container, "Back to app").click());
			await flush();
			await act(async () => release());
			await flush();
			expect(container.querySelector(".new-task-home")).toBeNull();
			expect(transition.animate).not.toHaveBeenCalled();
		} finally {
			await transition.restore(root);
		}
	});

	it("plays the transition once across a resize while the first send is in flight", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const transition = spyHomeTransition();
		const { api } = createHarness();
		let release!: () => void;
		const pendingStart = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.mocked(api.startTurn).mockImplementationOnce(async () => {
			await pendingStart;
			return {};
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<App api={api} store={new AppStore()} />));
			await flush();
			await act(async () => button(container, "New task").click());
			const editor = container.querySelector<HTMLElement>("#composer-input")!;
			await act(async () => changeTextarea(editor, "Resized during submit"));
			await act(async () => container.querySelector<HTMLFormElement>(".new-task-home form")!.requestSubmit());
			await flush();
			await act(async () => window.dispatchEvent(new Event("resize")));
			await act(async () => release());
			await flush();
			await flush();
			expect(transition.animate).toHaveBeenCalledTimes(1);
			expect(container.querySelector(".new-task-home")).toBeNull();
		} finally {
			await transition.restore(root);
		}
	});

	it("does not replay the home transition for follow-up sends in a conversation", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const transition = spyHomeTransition();
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		try {
			await act(async () => root.render(<App api={api} store={new AppStore()} />));
			await flush();
			await act(async () => button(container, "Chat project task").click());
			await flush();
			await flush();
			const editor = container.querySelector<HTMLElement>("#composer-input")!;
			await act(async () => changeTextarea(editor, "A later message"));
			await act(async () => container.querySelector<HTMLFormElement>(".conversation-column form")!.requestSubmit());
			await flush();
			expect(api.startTurn).toHaveBeenCalledTimes(1);
			expect(transition.animate).not.toHaveBeenCalled();
		} finally {
			await transition.restore(root);
		}
	});

	it("skips the transition entirely under reduced motion and after unmount", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem(GENERAL_PREFERENCES_STORAGE_KEY, JSON.stringify({ motion: "reduced" }));
		const transition = spyHomeTransition();
		const { api } = createHarness();
		let release!: () => void;
		const pendingStart = new Promise<void>((resolve) => {
			release = resolve;
		});
		vi.mocked(api.startTurn).mockImplementationOnce(async () => {
			await pendingStart;
			return {};
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		await act(async () => button(container, "New task").click());
		const editor = container.querySelector<HTMLElement>("#composer-input")!;
		await act(async () => changeTextarea(editor, "Reduced motion draft"));
		await act(async () => container.querySelector<HTMLFormElement>(".new-task-home form")!.requestSubmit());
		await flush();
		// Unmount while the request is in flight: the pending ticket must die with the app.
		await transition.restore(root);
		await act(async () => release());
		await flush();
		expect(transition.animate).not.toHaveBeenCalled();
	});

	it("forks a conversation from an assistant reply and opens the forked session", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api, emitEvent } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

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
						type: "item/completed",
						item: {
							itemId: "assistant-reply-1",
							sessionId: "chat-existing",
							turnId: "turn-1",
							role: "assistant",
							state: "completed",
							content: [{ type: "text", text: "Here is the reply" }],
							createdAt: "2026-08-13T00:00:00.000Z",
							completedAt: "2026-08-13T00:00:00.000Z",
						},
					}],
				},
			},
		}));
		await flush();

		const forkButton = container.querySelector<HTMLButtonElement>('[aria-label="Fork conversation"]');
		expect(forkButton).not.toBeNull();
		expect(container.textContent).toContain("Here is the reply");

		await act(async () => forkButton!.click());
		await flush();
		expect(api.forkSession).toHaveBeenCalledWith({
			sessionId: "chat-existing",
			requestId: expect.any(String),
			entryId: "assistant-reply-1",
		});
		expect(api.openSession).toHaveBeenCalledWith({ sessionId: "forked-session-1" });
		expect(container.textContent).toContain("fork Chat project task");
		await act(async () => root.unmount());
	});

	it("copies the user message and assistant reply text in Chat mode", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api, emitEvent } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => emitEvent({
			type: "app-server",
			envelope: {
				jsonrpc: "2.0",
				method: "connection/events",
				params: {
					serverEpoch: EPOCH,
					fromCursor: 1,
					toCursor: 2,
					events: [{
						type: "item/completed",
						item: {
							itemId: "user-message-1",
							sessionId: "chat-existing",
							turnId: "turn-1",
							role: "user",
							state: "completed",
							content: [{ type: "text", text: "hello metis" }],
							createdAt: "2026-08-13T00:00:00.000Z",
							completedAt: "2026-08-13T00:00:00.000Z",
						},
					}, {
						type: "item/completed",
						item: {
							itemId: "assistant-reply-2",
							sessionId: "chat-existing",
							turnId: "turn-1",
							role: "assistant",
							state: "completed",
							content: [{ type: "text", text: "Here is the reply" }],
							createdAt: "2026-08-13T00:00:01.000Z",
							completedAt: "2026-08-13T00:00:01.000Z",
						},
					}],
				},
			},
		}));
		await flush();

		const copyButtons = container.querySelectorAll<HTMLButtonElement>('[aria-label="Copy message"]');
		expect(copyButtons).toHaveLength(2);
		expect(container.querySelector(".turn-actions")).not.toBeNull();

		await act(async () => copyButtons[0]!.click());
		await flush();
		expect(api.writeClipboardText).toHaveBeenCalledWith({ text: "hello metis" });
		await act(async () => copyButtons[1]!.click());
		await flush();
		expect(api.writeClipboardText).toHaveBeenCalledWith({ text: "Here is the reply" });
		await act(async () => root.unmount());
	});

	it("copies the user message and assistant reply text in Code mode", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
		const { api, emitEvent } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		await act(async () => button(container, "Code").click());
		await flush();

		await act(async () => emitEvent({
			type: "app-server",
			envelope: {
				jsonrpc: "2.0",
				method: "connection/events",
				params: {
					serverEpoch: EPOCH,
					fromCursor: 1,
					toCursor: 2,
					events: [{
						type: "item/completed",
						item: {
							itemId: "code-user-message-1",
							sessionId: "code-existing",
							turnId: "code-turn-1",
							role: "user",
							state: "completed",
							content: [{ type: "text", text: "build the app" }],
							createdAt: "2026-08-13T00:00:00.000Z",
							completedAt: "2026-08-13T00:00:00.000Z",
						},
					}, {
						type: "item/completed",
						item: {
							itemId: "code-reply-2",
							sessionId: "code-existing",
							turnId: "code-turn-1",
							role: "assistant",
							state: "completed",
							content: [{ type: "text", text: "Code reply here" }],
							createdAt: "2026-08-13T00:00:01.000Z",
							completedAt: "2026-08-13T00:00:01.000Z",
						},
					}],
				},
			},
		}));
		await flush();

		const copyButtons = container.querySelectorAll<HTMLButtonElement>('[aria-label="Copy message"]');
		expect(copyButtons).toHaveLength(2);
		await act(async () => copyButtons[0]!.click());
		await flush();
		expect(api.writeClipboardText).toHaveBeenCalledWith({ text: "build the app" });
		await act(async () => copyButtons[1]!.click());
		await flush();
		expect(api.writeClipboardText).toHaveBeenCalledWith({ text: "Code reply here" });
		await act(async () => root.unmount());
	});

	it("shows the fork button on a Code mode assistant reply and forks it", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
		const { api, emitEvent } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		await act(async () => button(container, "Code").click());
		await flush();

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
						type: "item/completed",
						item: {
							itemId: "code-reply-1",
							sessionId: "code-existing",
							turnId: "turn-1",
							role: "assistant",
							state: "completed",
							content: [{ type: "text", text: "Code reply here" }],
							createdAt: "2026-08-13T00:00:00.000Z",
							completedAt: "2026-08-13T00:00:00.000Z",
						},
					}],
				},
			},
		}));
		await flush();

		const forkButton = container.querySelector<HTMLButtonElement>('[aria-label="Fork conversation"]');
		expect(forkButton).not.toBeNull();
		expect(container.textContent).toContain("Code reply here");
		await act(async () => forkButton!.click());
		await flush();
		expect(api.forkSession).toHaveBeenCalledWith(expect.objectContaining({ entryId: "code-reply-1" }));
		await act(async () => root.unmount());
	});

	it("shows compacting progress, disables the composer, and projects the persisted divider", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api, emitEvent } = createHarness();
		let resolveCompact!: (result: ClientResult<"session/compact">) => void;
		vi.mocked(api.compactSession).mockImplementationOnce(() => new Promise((resolve) => {
			resolveCompact = resolve;
		}));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		const textarea = (container.querySelector("textarea") ?? container.querySelector("#composer-input"))!;
		await act(async () => changeTextarea(textarea, "/compact"));
		const option = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
			.find((candidate) => candidate.querySelector("strong")?.textContent === "/compact")!;
		await act(async () => option.click());
		expect(api.compactSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "chat-existing" }));
		expect(container.querySelector('[aria-label="Compacting conversation…"]')).not.toBeNull();
		expect(textarea.disabled).toBe(true);

		await act(async () => resolveCompact({ sessionId: "chat-existing", tokensBefore: 64_000, estimatedTokensAfter: 8_000 }));
		await flush();
		expect(container.querySelector('[aria-label="Compacting conversation…"]')).toBeNull();
		expect(textarea.disabled).toBe(false);
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
						type: "item/completed",
						item: {
							itemId: "compaction-1",
							sessionId: "chat-existing",
							role: "system",
							state: "completed",
							content: [{ type: "compaction" }],
							createdAt: "2026-08-13T00:00:00.000Z",
							completedAt: "2026-08-13T00:00:00.000Z",
						},
					}],
				},
			},
		}));
		expect(container.querySelector(".transcript-compaction-row")?.textContent).toBe("Compacted");
		await act(async () => root.unmount());
	});

	it("reports failed compaction without adding a false divider", async () => {
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		vi.mocked(api.compactSession).mockRejectedValueOnce(new Error("Nothing to compact"));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		const textarea = (container.querySelector("textarea") ?? container.querySelector("#composer-input"))!;
		await act(async () => changeTextarea(textarea, "/compact"));
		const option = [...container.querySelectorAll<HTMLButtonElement>('[role="option"]')]
			.find((candidate) => candidate.querySelector("strong")?.textContent === "/compact")!;
		await act(async () => option.click());
		await flush();
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Nothing to compact");
		expect(container.querySelector(".transcript-compaction-row")).toBeNull();
		expect(textarea.disabled).toBe(false);
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

		const textarea = (container.querySelector("textarea") ?? container.querySelector("#composer-input"))!;
		expect(button(container, "Stop task")).toBeTruthy();
		expect(container.querySelector('[aria-label="Queue message"]')).toBeNull();
		await act(async () => changeTextarea(textarea, "Follow up"));
		expect(container.querySelector('[aria-label="Stop task"]')).toBeNull();
		expect(button(container, "Queue message").disabled).toBe(false);
		await act(async () => changeTextarea(textarea, ""));
		expect(container.querySelector('[aria-label="Queue message"]')).toBeNull();
		await act(async () => button(container, "Stop task").click());
		await flush();

		expect(api.interruptTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "chat-existing" }));
		expect(container.textContent).toContain("interrupt failed");
		await act(async () => root.unmount());
	});

	it("recalls a queued message into the composer for editing", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api, emitEvent } = createHarness();
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

		const textarea = container.querySelector<HTMLTextAreaElement>("#composer-input")!;
		await act(async () => changeTextarea(textarea, "Check the failing test next"));
		await act(async () => button(container, "Queue message").click());
		await flush();
		expect(api.queueTurn).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "chat-existing",
			text: "Check the failing test next",
		}));
		expect(api.steerTurn).not.toHaveBeenCalled();
		expect(textarea.value).toBe("");

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
						type: "turn/queueChanged",
						sessionId: "chat-existing",
						queuedTurns: [{
							queueItemId: "queue-1",
							revision: "revision-1",
							state: "queued",
							text: "Check the failing test next",
							attachments: [],
						}],
					}],
				},
			},
		}));
		expect(container.querySelector(".queued-turn-text")?.textContent).toBe("Check the failing test next");

		await act(async () => button(container, "Edit queued message").click());
		await flush();
		expect(api.deleteQueuedTurn).toHaveBeenCalledWith(expect.objectContaining({
			queueItemId: "queue-1",
			expectedRevision: "revision-1",
		}));
		expect(textarea.value).toBe("Check the failing test next");
		expect(document.activeElement).toBe(textarea);
		expect(api.updateQueuedTurn).not.toHaveBeenCalled();
		expect(api.sendQueuedTurn).not.toHaveBeenCalled();
		await act(async () => root.unmount());
	});

	it("submits selected files and one hidden skill on first Chat send", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		vi.mocked(api.selectAttachmentFiles).mockResolvedValue([{
			path: "/tmp/photo.png",
			name: "photo.png",
			previewDataUrl: "data:image/png;base64,cHJldmlldw==",
		}]);
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

		expect(container.querySelector('.composer-image-preview img[alt="photo.png"]')).not.toBeNull();
		expect(container.querySelector('[aria-label="Remove skill pdf"]')).not.toBeNull();
		expect([...container.querySelectorAll("button")].some((candidate) => candidate.textContent?.trim() === "Browse skills")).toBe(false);
		const textarea = (container.querySelector("textarea") ?? container.querySelector("#composer-input"))!;
		await act(async () => changeTextarea(textarea, "Summarize this"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();
		await flush();

		expect(api.createSession).toHaveBeenCalledTimes(1);
		expect(api.startTurn).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "chat-created",
			text: "/skill:pdf Summarize this",
			attachments: [{ path: "/tmp/photo.png", name: "photo.png" }],
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
		expect(container.textContent).toContain("Customize");
		expect(container.textContent).toContain("pdf");
		await act(async () => root.unmount());
	});

	it("shows connected MCP servers in the add menu and opens MCP management", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Add to message").click());
		await act(async () => button(container.querySelector<HTMLElement>(".composer-add-menu")!, "MCP").click());
		expect(container.querySelector(".composer-mcp-menu")?.textContent).toContain("deepwiki");
		await act(async () => button(container.querySelector<HTMLElement>(".composer-mcp-menu")!, "Manage MCP").click());
		await flush();

		expect(button(container, "MCP").getAttribute("aria-selected")).toBe("true");
		expect(container.querySelector('[aria-label="Search MCP servers"]')).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("polls MCP only while it is connecting", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api } = createHarness({
			mcpLists: [[mcpServer("connecting")], [mcpServer("connected")]],
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		expect(container.querySelector('[role="status"]')?.textContent).toContain("MCP connecting");
		await act(async () => new Promise((resolve) => setTimeout(resolve, 550)));
		expect(vi.mocked(api.listMcpServers)).toHaveBeenCalledTimes(2);
		expect(container.textContent).not.toContain("MCP connecting");
		await act(async () => new Promise((resolve) => setTimeout(resolve, 550)));
		expect(vi.mocked(api.listMcpServers)).toHaveBeenCalledTimes(2);
		await act(async () => root.unmount());
	});

	it("links MCP failures to management", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api } = createHarness({ mcpLists: [[mcpServer("reconnecting", "offline")]] });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		expect(container.textContent).toContain("MCP connection failed");
		await act(async () => button(container, "MCP connection failed").click());
		await flush();
		expect(button(container, "MCP").getAttribute("aria-selected")).toBe("true");
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
		await act(async () => (container.querySelector<HTMLTextAreaElement>("textarea") ?? container.querySelector<HTMLElement>("#composer-input"))!.closest("form")!.requestSubmit());
		await flush();
		await flush();

		expect(api.startTurn).toHaveBeenCalledWith(expect.objectContaining({
			text: "",
			attachments: [{ path: "/tmp/report.pdf", name: "report.pdf" }],
		}));
		await act(async () => root.unmount());
	});

	it("uses the default model's native effort levels on the new-task page", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
		const { api } = createHarness();
		const settings: ModelSettingsView = {
			defaultModel: { provider: "glm", modelId: "glm-5.3-flash" },
			defaultThinkingSelection: "max",
			vision: null,
			providers: [{
				provider: "glm",
				name: "GLM",
				builtin: false,
				baseUrl: "https://open.bigmodel.cn/api/paas/v4",
				api: "openai-completions",
				auth: { configured: true, source: "stored" },
				models: [{ provider: "glm", modelId: "glm-5.3-flash", name: "GLM 5.3 Flash", contextWindow: 128_000, maxOutputTokens: 16_384, reasoning: true, thinkingLevels: ["low", "high", "max"], reasoningMode: "auto", reasoningSource: "catalog", imageInput: false, custom: true }],
			}],
			loadError: null,
		};
		vi.mocked(api.getModelSettings).mockResolvedValue(settings);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		const effort = button(container, "Select effort, current Max");
		await act(async () => effort.click());
		expect(container.querySelectorAll(".effort-ticks > span")).toHaveLength(3);
		expect(container.querySelector<HTMLInputElement>('.thinking-control input[type="range"]')?.max).toBe("2");
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
		const textarea = (container.querySelector("textarea") ?? container.querySelector("#composer-input"))!;
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
		expect(container.querySelector(".composer-file-card")).toBeNull();
		expect(container.querySelector(".composer-skill-token")).toBeNull();
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
			availableThinkingSelections: ["off", "low", "medium", "high", "max"] as const,
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

		expect(api.setThinkingSelection).toHaveBeenCalledWith(expect.objectContaining({ selection: "max" }));
		expect(trigger.textContent).toContain("Max");
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
		await act(async () => button(container, "Metis User").click());
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
		const textarea = (container.querySelector("textarea") ?? container.querySelector("#composer-input"))!;
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
		const textarea = (container.querySelector("textarea") ?? container.querySelector("#composer-input"))!;
		await act(async () => changeTextarea(textarea, "Keep this draft"));
		await act(async () => textarea.form!.requestSubmit());
		await flush();

		expect(container.textContent).toContain("open failed once");
		expect(textarea.value).toBe("Keep this draft");
		expect(api.createSession).toHaveBeenCalledTimes(1);
		expect(button(container, "Select permissions, current Auto").disabled).toBe(true);
		await act(async () => textarea.form!.requestSubmit());
		await flush();
		await flush();

		expect(api.createSession).toHaveBeenCalledTimes(1);
		expect(api.startTurn).toHaveBeenCalledTimes(1);
		await act(async () => root.unmount());
	});

	it("keeps a Code draft retryable after the first open fails", async () => {
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
		await act(async () => button(container, "Choose folder").click());
		await flush();
		expect(api.createSession).not.toHaveBeenCalled();
		const editor = container.querySelector<HTMLElement>("#composer-input")!;
		await act(async () => changeTextarea(editor, "Retry this Code task"));
		await act(async () => editor.form!.requestSubmit());
		await flush();

		expect(container.textContent).toContain("open failed once");
		expect(api.createSession).toHaveBeenCalledTimes(1);
		await act(async () => editor.form!.requestSubmit());
		await flush();
		await flush();

		expect(api.createSession).toHaveBeenCalledTimes(1);
		expect(api.startTurn).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "code-created",
			text: "Retry this Code task",
		}));
		expect(container.querySelector(".new-task-home")).toBeNull();
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

		await act(async () => container.querySelector<HTMLButtonElement>(".folder-picker")!.click());
		await flush();
		const textarea = (container.querySelector("textarea") ?? container.querySelector("#composer-input"))!;
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
		const textarea = (container.querySelector("textarea") ?? container.querySelector("#composer-input"))!;

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
		const textarea = (container.querySelector("textarea") ?? container.querySelector("#composer-input"))!;
		await act(async () => changeTextarea(textarea, "Retry the same create"));

		await act(async () => textarea.form!.requestSubmit());
		await flush();
		expect(container.textContent).toContain("create response lost");
		expect(textarea.value).toBe("Retry the same create");
		expect(button(container, "Select permissions, current Auto").disabled).toBe(true);

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
		const textarea = (container.querySelector("textarea") ?? container.querySelector("#composer-input"))!;
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
		expect(container.querySelector(".new-task-home")).not.toBeNull();
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
		const provider = [...container.querySelectorAll<HTMLButtonElement>(".model-selector-provider")]
			.find((candidate) => candidate.textContent?.includes("Test Provider"));
		if (!provider) throw new Error("Missing Test Provider option");
		act(() => provider.click());
		const otherModel = [...container.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')]
			.find((candidate) => candidate.textContent?.includes("Other model"));
		if (!otherModel) throw new Error("Missing Other model option");
		act(() => otherModel.click());
		await flush();

		expect(button(container, "Select model").disabled).toBe(true);
		expect(container.querySelectorAll(".session-sidebar button:disabled")).toHaveLength(0);
		for (const label of ["Chat", "Code", "New task", "Customize", "Chat project task"]) {
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
		for (const label of ["Chat", "Code", "New task", "Customize", "Chat project task"]) {
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
					events: [
						{ type: "project/invalidated", mode: "chat", cwd: "/work/chat-project", reason: "reload_required" },
					],
				},
			},
		});
		expect(store.getSnapshot().syncStatus).toBe("resubscribing");
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
		expect(container.querySelector(".new-task-home")).not.toBeNull();
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

		expect(container.querySelector(".new-task-home")).toBeNull();
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
		expect(container.querySelector(".new-task-home")).toBeNull();
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

		const sidebarToggle = container.querySelector<HTMLButtonElement>('[aria-label="Hide sessions sidebar"]')!;
		expect(sidebarToggle.classList.contains("sessions-sidebar-toggle-fixed")).toBe(true);
		await act(async () => sidebarToggle.click());
		expect(container.querySelector<HTMLButtonElement>('[aria-label="Show sessions sidebar"]')).toBe(sidebarToggle);
		expect(container.querySelector(".session-sidebar")).toBeNull();
		await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Show sessions sidebar"]')!.click());
		expect(container.querySelector(".session-sidebar")).not.toBeNull();
		await act(async () => activeWorkspace(container).querySelector<HTMLButtonElement>(".tool-add-trigger")!.click());
		const toolMenu = activeWorkspace(container).querySelector<HTMLElement>(".tool-add-menu")!;
		expect(toolMenu.textContent).toContain("Review");
		expect(toolMenu.textContent).toContain("Files");
		expect(toolMenu.textContent).toContain("Agents");
		await act(async () => button(toolMenu, "Agents").click());
		expect(activeWorkspace(container).querySelectorAll('[role="tab"]')).toHaveLength(2);
		await act(async () => button(activeWorkspace(container), "Add tool").click());
		const agentMenuItem = [...activeWorkspace(container).querySelectorAll<HTMLButtonElement>('.tool-add-menu [role="menuitem"]')]
			.find((candidate) => candidate.textContent?.includes("Agents"))!;
		await act(async () => agentMenuItem.click());
		expect(activeWorkspace(container).querySelectorAll('[role="tab"]')).toHaveLength(2);

		const backendCalls = vi.mocked(api.createSession).mock.calls.length + vi.mocked(api.openSession).mock.calls.length;
		await act(async () => button(container, "Customize").click());
		expect(container.textContent).toContain("Customize");
		expect(container.textContent).toContain("pdf");
		expect(vi.mocked(api.createSession).mock.calls.length + vi.mocked(api.openSession).mock.calls.length).toBe(backendCalls);

		await act(async () => button(container, "Chat").click());
		await flush();
		expect(api.openSession).toHaveBeenLastCalledWith({ sessionId: "chat-existing" });
		const visiblePanel = activeWorkspace(container).querySelector<HTMLElement>(".workspace-panel:not([hidden]) > *")!;
		expect(visiblePanel.className).toContain("workspace-chat-panel");
		const modeTabs = [...activeWorkspace(container).querySelectorAll('[role="tab"]')];
		expect(modeTabs.find((tab) => tab.getAttribute("aria-label") === "Chat project task")?.getAttribute("aria-selected")).toBe("true");
		expect(modeTabs.find((tab) => tab.getAttribute("aria-label") === "Code project task")?.getAttribute("aria-selected")).not.toBe("true");
		expect(container.querySelector('[aria-label="Add to message"]')).not.toBeNull();
		await act(async () => activeWorkspace(container).querySelector<HTMLButtonElement>(".tool-add-trigger")!.click());
		const chatToolMenu = activeWorkspace(container).querySelector<HTMLElement>(".tool-add-menu")!;
		expect(chatToolMenu.textContent).toContain("Terminal");
		expect(chatToolMenu.textContent).toContain("Browser");
		expect(chatToolMenu.textContent).not.toContain("Review");
		expect(chatToolMenu.textContent).not.toContain("Files");
		expect(chatToolMenu.textContent).not.toContain("Agents");
		await act(async () => root.unmount());
	});

	it("keeps Windows navigation in the compact title bar and supports back and forward", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		const titlebar = container.querySelector<HTMLElement>(".windows-titlebar-navigation")!;
		expect(titlebar).not.toBeNull();
		expect(titlebar.querySelector(".sessions-sidebar-toggle-fixed")).not.toBeNull();
		expect(titlebar.querySelector('[aria-label="Go back"]')).not.toBeNull();
		expect(titlebar.querySelector('[aria-label="Go forward"]')).not.toBeNull();
		expect(titlebar.querySelector(".mode-switch")).toBeNull();
		expect(container.querySelector(".session-sidebar .mode-switch")).not.toBeNull();
		expect(button(container, "Go back").disabled).toBe(true);
		expect(button(container, "Go forward").disabled).toBe(true);

		await act(async () => button(container, "Customize").click());
		expect(container.querySelector(".plugins-catalog-page")).not.toBeNull();
		expect(button(container, "Go back").disabled).toBe(false);

		await act(async () => button(container, "Go back").click());
		await flush();
		expect(container.querySelector(".new-task-home")).not.toBeNull();
		expect(button(container, "Go forward").disabled).toBe(false);

		await act(async () => button(container, "Go forward").click());
		await flush();
		expect(container.querySelector(".plugins-catalog-page")).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("starts project Skill creation in a normal auto Chat bound to the chosen directory", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Customize").click());
		await act(async () => button(container, "New Skill").click());
		await act(async () => button(document.body.querySelector<HTMLElement>(".plugins-new-menu")!, "Project").click());
		const dialog = container.querySelector<HTMLElement>('[role="dialog"]')!;
		await act(async () => button(dialog, "Choose folder…").click());
		await flush();
		await act(async () => {
			button(dialog, "Create with Metis").click();
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		const create = vi.mocked(api.createSession).mock.calls.at(-1)![0];
		expect(create).toMatchObject({ mode: "chat", cwd: "/work/selected-project", permissionPreset: "auto" });
		expect(create).not.toHaveProperty("name");
		expect(api.startTurn).toHaveBeenLastCalledWith(expect.objectContaining({
			sessionId: "chat-created",
			text: "I want to create a project-level Skill in /work/selected-project. Use the create-skill Skill and ask me for the information you need before creating it.",
		}));
		await act(async () => root.unmount());
	});

	it("starts user Skill creation in a managed auto Chat without inventing a project", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Customize").click());
		await act(async () => button(container, "New Skill").click());
		await act(async () => button(document.body.querySelector<HTMLElement>(".plugins-new-menu")!, "User").click());
		await act(async () => {
			button(container.querySelector<HTMLElement>('[role="dialog"]')!, "Create with Metis").click();
			await new Promise((resolve) => setTimeout(resolve, 0));
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		const create = vi.mocked(api.createSession).mock.calls.at(-1)![0];
		expect(create).toMatchObject({ mode: "chat", permissionPreset: "auto" });
		expect(create).not.toHaveProperty("cwd");
		expect(api.startTurn).toHaveBeenLastCalledWith(expect.objectContaining({
			text: "I want to create a user-level Skill. Use the create-skill Skill and ask me for the information you need before creating it.",
		}));
		await act(async () => root.unmount());
	});

	it("opens independent terminal tabs and keeps them mounted while another tab is active", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await addTool(container, "Terminal");
		await flush();
		expect(api.createTerminal).toHaveBeenCalledTimes(1);
		expect(api.createTerminal).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/work/chat-project" }));
		expect(activeWorkspace(container).querySelectorAll('[role="tab"]')).toHaveLength(2);
		expect(activeWorkspace(container).querySelector<HTMLElement>('[aria-selected="true"]')?.getAttribute("aria-label")).toBe("Terminal");
		expect([...activeWorkspace(container).querySelector<HTMLElement>(".workspace-tabbar")!.children].map((child) => child.className)).toEqual([
			"tool-tabs-scroll",
			"tool-add",
			"workspace-tabbar-fill",
		]);

		await act(async () => button(container, "Code").click());
		await flush();
		await act(async () => button(container, "Chat").click());
		await flush();
		expect(api.createTerminal).toHaveBeenCalledTimes(1);
		expect(activeWorkspace(container).querySelectorAll('[role="tab"]')).toHaveLength(3);

		const tabbar = activeWorkspace(container).querySelector<HTMLElement>(".workspace-tabbar")!;
		await act(async () => button(tabbar, "Chat project task").click());
		expect(container.querySelector(".terminal-panel")).not.toBeNull();
		expect(container.querySelector(".terminal-panel.is-visible")).toBeNull();
		await act(async () => button(tabbar, "Terminal").click());
		expect(api.createTerminal).toHaveBeenCalledTimes(1);
		expect(activeWorkspace(container).querySelectorAll('[role="tab"]')).toHaveLength(3);

		await act(async () => button(activeWorkspace(container), "Add tool").click());
		const addMenu = activeWorkspace(container).querySelector<HTMLElement>(".tool-add-menu")!;
		await act(async () => button(addMenu, "Terminal").click());
		await flush();
		expect(api.createTerminal).toHaveBeenCalledTimes(2);
		expect(activeWorkspace(container).querySelectorAll('[role="tab"]')).toHaveLength(4);

		await act(async () => button(container, "Close Terminal 2").click());
		expect(api.closeTerminal).toHaveBeenCalledTimes(1);
		await act(async () => button(container, "Close Terminal").click());
		expect(api.closeTerminal).toHaveBeenCalledTimes(2);
		expect(activeWorkspace(container).querySelectorAll('[role="tab"]')).toHaveLength(2);
		expect(container.querySelector(".workspace-tabbar")).not.toBeNull();

		await act(async () => root.unmount());
	});

	it("keeps tab contents mounted when tabs are split or moved between panes", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			x: 0, y: 0, top: 0, right: 1600, bottom: 900, left: 0, width: 1600, height: 900,
			toJSON: () => ({}),
		});
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await addTool(container, "Terminal");
		await flush();
		expect(api.createTerminal).toHaveBeenCalledTimes(1);
		const terminalPanel = container.querySelector<HTMLElement>(".terminal-panel")!;
		expect(terminalPanel).not.toBeNull();
		const composer = container.querySelector<HTMLElement>("#composer-input")!;
		expect(composer).not.toBeNull();

		const tabFor = (label: string) => [...activeWorkspace(container).querySelectorAll<HTMLElement>(".tool-tab")]
			.find((candidate) => candidate.querySelector(`[role="tab"][aria-label="${label}"]`))!;
		await act(async () => tabFor("Terminal").dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 20 }),
		));
		await act(async () => button(container, "Split right").click());
		await flush();
		expect(activeWorkspace(container).querySelectorAll(".workspace-pane")).toHaveLength(2);
		expect(api.createTerminal).toHaveBeenCalledTimes(1);
		expect(terminalPanel.isConnected).toBe(true);

		await act(async () => tabFor("Chat project task").dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 20 }),
		));
		const moveItem = [...container.querySelectorAll<HTMLButtonElement>('.workspace-tab-menu [role="menuitem"]')]
			.find((candidate) => candidate.textContent?.includes("Move to pane"))!;
		await act(async () => moveItem.click());
		await flush();
		expect(container.querySelector("#composer-input")).toBe(composer);

		await act(async () => root.unmount());
	});

	it("declares retained sessions from the session ids of open tabs", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api } = createHarness({
			sessions: [
				session("chat-existing", "chat", "/work/chat-project", "Chat project task"),
				session("chat-other", "chat", "/work/other-project", "Other task"),
			],
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await addTool(container, "Terminal");
		await flush();
		expect(api.retainWorkspaceSessions).toHaveBeenLastCalledWith({
			sessionIds: ["chat-existing"],
			liveSessionIds: [],
		});

		await act(async () => button(container, "Other task").click());
		await flush();
		expect(api.retainWorkspaceSessions).toHaveBeenLastCalledWith({
			sessionIds: ["chat-existing", "chat-other"],
			liveSessionIds: ["chat-other"],
		});

		await act(async () => button(container, "Close Chat project task").click());
		await act(async () => button(container, "Close Terminal").click());
		await flush();
		expect(api.retainWorkspaceSessions).toHaveBeenLastCalledWith({
			sessionIds: ["chat-other"],
			liveSessionIds: ["chat-other"],
		});

		await act(async () => root.unmount());
	});

	it("subscribes a second session when its chat tab is split into another pane", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			x: 0, y: 0, top: 0, right: 1600, bottom: 900, left: 0, width: 1600, height: 900,
			toJSON: () => ({}),
		});
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api } = createHarness({
			sessions: [
				session("chat-existing", "chat", "/work/chat-project", "Chat project task"),
				session("chat-other", "chat", "/work/other-project", "Other task"),
			],
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Other task").click());
		await flush();
		expect(api.subscribeSession).not.toHaveBeenCalled();

		const tabFor = (label: string) => [...activeWorkspace(container).querySelectorAll<HTMLElement>(".tool-tab")]
			.find((candidate) => candidate.querySelector(`[role="tab"][aria-label="${label}"]`))!;
		await act(async () => tabFor("Other task").dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 20 }),
		));
		await act(async () => button(container, "Split right").click());
		await flush();

		expect(activeWorkspace(container).querySelectorAll(".workspace-pane")).toHaveLength(2);
		expect(api.subscribeSession).toHaveBeenCalledWith({ sessionId: "chat-existing" });
		expect(api.retainWorkspaceSessions).toHaveBeenLastCalledWith({
			sessionIds: ["chat-existing", "chat-other"],
			liveSessionIds: ["chat-existing", "chat-other"],
		});

		await act(async () => root.unmount());
	});

	it("renders a live chat view in every visible chat pane and keeps it mounted across focus", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			x: 0, y: 0, top: 0, right: 1600, bottom: 900, left: 0, width: 1600, height: 900,
			toJSON: () => ({}),
		});
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api } = createHarness({
			sessions: [
				session("chat-existing", "chat", "/work/chat-project", "Chat project task"),
				session("chat-other", "chat", "/work/other-project", "Other task"),
			],
		});
		vi.mocked(api.subscribeSession).mockResolvedValue({
			...snapshot(session("chat-existing", "chat", "/work/chat-project", "Chat project task")),
			recentItems: [{
				itemId: "item-background",
				sessionId: "chat-existing",
				role: "assistant",
				state: "completed",
				content: [{ type: "text", text: "background reply" }],
				createdAt: "2026-07-20T00:00:00.000Z",
			}],
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Other task").click());
		await flush();
		const tabFor = (label: string) => [...activeWorkspace(container).querySelectorAll<HTMLElement>(".tool-tab")]
			.find((candidate) => candidate.querySelector(`[role="tab"][aria-label="${label}"]`))!;
		await act(async () => tabFor("Other task").dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 20 }),
		));
		await act(async () => button(container, "Split right").click());
		await flush();
		await flush();

		expect(activeWorkspace(container).querySelectorAll(".workspace-pane")).toHaveLength(2);
		// Both panes render a live conversation — no focus placeholder remains.
		const livePanels = [...activeWorkspace(container).querySelectorAll<HTMLElement>(".workspace-panel:not([hidden])")];
		expect(livePanels).toHaveLength(2);
		expect(livePanels.every((panel) => panel.querySelector(".conversation-column"))).toBe(true);
		expect(activeWorkspace(container).textContent).not.toContain("This session is not in focus.");
		// Only the projected session's composer keeps the canonical id.
		const focusedPanel = livePanels.find((panel) => panel.querySelector("#composer-input"))!;
		const backgroundPanel = livePanels.find((panel) => panel !== focusedPanel)!;
		const backgroundComposer = backgroundPanel.querySelector<HTMLElement>("#composer-input-chat-existing")!;
		expect(backgroundComposer).not.toBeNull();
		expect(backgroundPanel.textContent).toContain("background reply");

		await act(async () => tabFor("Chat project task").querySelector<HTMLElement>('[role="tab"]')!.click());
		await flush();

		// The already-live bucket takes focus without a resubscribe, so the pane
		// keeps its DOM — the composer gains the canonical id in place.
		expect(api.subscribeSession).toHaveBeenCalledTimes(1);
		expect(backgroundComposer.isConnected).toBe(true);
		expect(backgroundComposer.id).toBe("composer-input");
		expect(backgroundPanel.textContent).toContain("background reply");
		expect(focusedPanel.querySelector("#composer-input-chat-other")).not.toBeNull();

		await act(async () => root.unmount());
	});

	it("keeps a hidden chat tab's composer draft mounted across tab switches", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			x: 0, y: 0, top: 0, right: 1600, bottom: 900, left: 0, width: 1600, height: 900,
			toJSON: () => ({}),
		});
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api } = createHarness({
			sessions: [
				session("chat-existing", "chat", "/work/chat-project", "Chat project task"),
				session("chat-other", "chat", "/work/other-project", "Other task"),
			],
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Other task").click());
		await flush();
		const tabFor = (label: string) => [...activeWorkspace(container).querySelectorAll<HTMLElement>(".tool-tab")]
			.find((candidate) => candidate.querySelector(`[role="tab"][aria-label="${label}"]`))!;
		await act(async () => tabFor("Other task").dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 20 }),
		));
		await act(async () => button(container, "Split right").click());
		await flush();
		// Focus the first pane's chat so the second pane's composer is the
		// non-focused view exercised below.
		await act(async () => tabFor("Chat project task").querySelector<HTMLElement>('[role="tab"]')!.click());
		await flush();
		await flush();

		// Top-row strips live in the titlebar, so a pane is addressed through its strip.
		const otherPane = [...activeWorkspace(container).querySelectorAll<HTMLElement>(".workspace-tabbar")]
			.find((strip) => strip.querySelector('[role="tab"][aria-label="Other task"]'))!;
		const editor = container.querySelector<HTMLElement>("#composer-input-chat-other")!;
		expect(editor).not.toBeNull();
		await act(async () => {
			editor.textContent = "unsent pane draft";
			editor.dispatchEvent(new InputEvent("input", { bubbles: true }));
		});

		await act(async () => otherPane.querySelector<HTMLButtonElement>(".tool-add-trigger")!.click());
		const menu = otherPane.querySelector<HTMLElement>(".tool-add-menu")!;
		expect(menu).not.toBeNull();
		await act(async () => button(menu, "Terminal").click());
		await flush();
		expect(otherPane.querySelector('[role="tab"][aria-label="Terminal"]')?.getAttribute("aria-selected")).toBe("true");

		await act(async () => tabFor("Other task").querySelector<HTMLElement>('[role="tab"]')!.click());
		await flush();
		await flush();

		// The hidden view never unmounted: the same editor node kept its draft
		// and only gained the canonical id once its session was focused again.
		expect(container.querySelector("#composer-input")).toBe(editor);
		expect(editor.textContent).toBe("unsent pane draft");
		await act(async () => root.unmount());
	});

	it("renders a pending modal interaction for a session without a chat pane in the global host", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api, emitEvent } = createHarness({
			sessions: [
				session("chat-existing", "chat", "/work/chat-project", "Chat project task"),
				session("chat-other", "chat", "/work/other-project", "Other task"),
			],
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		act(() => emitEvent({
			type: "app-server",
			envelope: {
				jsonrpc: "2.0",
				id: "00000000-0000-4000-8000-000000000207",
				method: "interaction/request",
				params: {
					serverEpoch: EPOCH,
					interaction: {
						interactionId: "00000000-0000-4000-8000-000000000208",
						sessionId: "chat-other",
						title: "Purge old logs?",
						message: "The hidden session asks for confirmation.",
						createdAt: "2026-07-20T00:00:00.000Z",
						kind: "confirm",
					},
				},
			},
		}));
		await flush();

		const backdrop = container.querySelector<HTMLElement>(".modal-backdrop")!;
		expect(backdrop).not.toBeNull();
		expect(backdrop.closest(".workspace-panel")).toBeNull();
		expect(backdrop.textContent).toContain("Purge old logs?");
		await act(async () => button(backdrop, "Confirm").click());
		await flush();
		expect(api.respondToInteraction).toHaveBeenCalledWith({
			interactionId: "00000000-0000-4000-8000-000000000208",
			kind: "confirm",
			confirmed: true,
		});
		expect(container.querySelector(".modal-backdrop")).toBeNull();
		await act(async () => root.unmount());
	});

	it("renders a pending modal interaction inside the live session's own pane", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			x: 0, y: 0, top: 0, right: 1600, bottom: 900, left: 0, width: 1600, height: 900,
			toJSON: () => ({}),
		});
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api, emitEvent } = createHarness({
			sessions: [
				session("chat-existing", "chat", "/work/chat-project", "Chat project task"),
				session("chat-other", "chat", "/work/other-project", "Other task"),
			],
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Other task").click());
		await flush();
		const tabFor = (label: string) => [...activeWorkspace(container).querySelectorAll<HTMLElement>(".tool-tab")]
			.find((candidate) => candidate.querySelector(`[role="tab"][aria-label="${label}"]`))!;
		await act(async () => tabFor("Other task").dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 20 }),
		));
		await act(async () => button(container, "Split right").click());
		await flush();

		act(() => emitEvent({
			type: "app-server",
			envelope: {
				jsonrpc: "2.0",
				id: "00000000-0000-4000-8000-000000000209",
				method: "interaction/request",
				params: {
					serverEpoch: EPOCH,
					interaction: {
						interactionId: "00000000-0000-4000-8000-000000000210",
						sessionId: "chat-existing",
						title: "Purge old logs?",
						message: "The unfocused live session asks for confirmation.",
						createdAt: "2026-07-20T00:00:00.000Z",
						kind: "confirm",
					},
				},
			},
		}));
		// The unfocused pane coalesces store notifications (~150ms throttle).
		await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
		await flush();

		const backdrops = [...container.querySelectorAll<HTMLElement>(".modal-backdrop")];
		expect(backdrops).toHaveLength(1);
		const backdrop = backdrops[0]!;
		const hostPanel = backdrop.closest<HTMLElement>(".workspace-panel");
		expect(hostPanel).not.toBeNull();
		// The dialog is hosted by the pane that owns this session's chat view —
		// not by the global host and not by the focused pane.
		expect(hostPanel!.querySelector("#composer-input-chat-existing")).not.toBeNull();
		await act(async () => button(backdrop, "Confirm").click());
		await flush();
		expect(api.respondToInteraction).toHaveBeenCalledWith({
			interactionId: "00000000-0000-4000-8000-000000000210",
			kind: "confirm",
			confirmed: true,
		});
		// The unfocused pane's throttled subscription removes the dialog a beat later.
		await act(async () => new Promise((resolve) => setTimeout(resolve, 220)));
		expect(container.querySelector(".modal-backdrop")).toBeNull();
		await act(async () => root.unmount());
	});

	it("routes a file selection change request through the owning session's composer", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			x: 0, y: 0, top: 0, right: 1600, bottom: 900, left: 0, width: 1600, height: 900,
			toJSON: () => ({}),
		});
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
		const { api } = createHarness({
			sessions: [
				session("chat-existing", "chat", "/work/chat-project", "Chat project task"),
				session("code-existing", "code", "/work/code-project", "Code project task"),
				session("code-other", "code", "/work/other-project", "Other task"),
			],
		});
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Code").click());
		await flush();
		await act(async () => button(container, "Other task").click());
		await flush();
		const tabFor = (label: string) => [...activeWorkspace(container).querySelectorAll<HTMLElement>(".tool-tab")]
			.find((candidate) => candidate.querySelector(`[role="tab"][aria-label="${label}"]`))!;
		await act(async () => tabFor("Other task").dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 20 }),
		));
		await act(async () => button(container, "Split right").click());
		await flush();

		// Open the workspace tree in the pane that targets the other session.
		// Top-row strips live in the titlebar, so a pane is addressed through its strip.
		const otherPane = [...activeWorkspace(container).querySelectorAll<HTMLElement>(".workspace-tabbar")]
			.find((strip) => strip.querySelector('[role="tab"][aria-label="Other task"]'))!;
		await act(async () => otherPane.querySelector<HTMLButtonElement>(".tool-add-trigger")!.click());
		await act(async () => button(otherPane.querySelector<HTMLElement>(".tool-add-menu")!, "Files").click());
		await flush();
		const filesPanel = container.querySelector<HTMLElement>("#file-panel-code-other")!;
		expect(filesPanel).not.toBeNull();
		await act(async () => filesPanel.querySelector<HTMLButtonElement>('.file-tree-row [title="notes.txt"]')!.click());
		await flush();
		expect(api.readWorkspaceFile).toHaveBeenCalledWith({ sessionId: "code-other", relativePath: "notes.txt" });

		const selectText = async (from: number, to: number) => {
			const view = codeEditor(filesPanel, "Edit notes.txt");
			await act(async () => view.dispatch({ selection: { anchor: from, head: to } }));
			const content = filesPanel.querySelector<HTMLElement>(".cm-content")!;
			const textNode = content.firstChild!.firstChild!;
			const range = document.createRange();
			range.setStart(textNode, from);
			range.setEnd(textNode, to);
			const selection = window.getSelection()!;
			selection.removeAllRanges();
			selection.addRange(range);
			await act(async () => {
				filesPanel.querySelector<HTMLElement>(".file-code-editor")!.dispatchEvent(
					new MouseEvent("mouseup", { bubbles: true, button: 0 }),
				);
				await new Promise((resolve) => requestAnimationFrame(resolve));
			});
		};
		const popover = () => container.querySelector<HTMLElement>(".file-selection-popover");
		const otherChatPanel = () => container.querySelector<HTMLElement>("#composer-input")!.closest<HTMLElement>(".workspace-panel")!;
		const focusedChatPanel = () => container.querySelector<HTMLElement>("#composer-input-code-existing")!.closest<HTMLElement>(".workspace-panel")!;

		await selectText(0, 8);
		expect(popover()).not.toBeNull();
		await act(async () => button(popover()!, "Add to conversation").click());
		await flush();

		// The reference lands only on the owning session's staged selections;
		// that composer's chat view stays mounted while its pane shows Files.
		expect(otherChatPanel().hidden).toBe(true);
		expect(otherChatPanel().querySelector(".composer-selections")?.textContent).toContain("notes.txt");
		expect(focusedChatPanel().querySelector(".composer-selections")).toBeNull();

		await selectText(9, 19);
		expect(popover()).not.toBeNull();
		await act(async () => button(popover()!, "Request changes").click());
		const instruction = popover()!.querySelector<HTMLTextAreaElement>('[aria-label="Describe the change"]')!;
		await act(async () => changeTextarea(instruction, "please tidy"));
		await act(async () => popover()!.querySelector<HTMLButtonElement>('[aria-label="Send change request"]')!.click());
		await flush();

		expect(api.startTurn).toHaveBeenCalledOnce();
		expect(api.startTurn).toHaveBeenCalledWith(expect.objectContaining({
			sessionId: "code-other",
			text: expect.stringContaining("please tidy"),
		}));
		expect(vi.mocked(api.startTurn).mock.calls[0]?.[0].fileSelections).toHaveLength(1);
		await act(async () => root.unmount());
	});

	it("renders a live agent tree for a session that is not the focused chat", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			x: 0, y: 0, top: 0, right: 1600, bottom: 900, left: 0, width: 1600, height: 900,
			toJSON: () => ({}),
		});
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
		const workerTask = {
			taskId: "task-1",
			status: "done" as const,
			taskSummary: "Analyze code",
			createdAt: "2026-07-20T00:00:00.000Z",
			updatedAt: "2026-07-20T00:00:00.000Z",
		};
		const worker: AgentSummaryView = {
			agentId: "worker-1",
			name: "Code worker",
			agentType: "worker",
			depth: 1,
			status: "done",
			archived: false,
			parentSessionId: "code-existing",
			rootSessionId: "code-existing",
			agentPath: ["worker-1"],
			tasks: [workerTask],
			latestTask: workerTask,
			createdAt: "2026-07-20T00:00:00.000Z",
			updatedAt: "2026-07-20T00:00:00.000Z",
		};
		const { api } = createHarness({
			sessions: [
				session("chat-existing", "chat", "/work/chat-project", "Chat project task"),
				session("code-existing", "code", "/work/code-project", "Code project task"),
				session("code-other", "code", "/work/other-project", "Other code task"),
			],
		});
		const summaries: Record<string, SessionSummary> = {
			"chat-existing": session("chat-existing", "chat", "/work/chat-project", "Chat project task"),
			"code-existing": session("code-existing", "code", "/work/code-project", "Code project task"),
			"code-other": session("code-other", "code", "/work/other-project", "Other code task"),
		};
		vi.mocked(api.openSession).mockImplementation(async ({ sessionId }) => ({
			...snapshot(summaries[sessionId]!),
			agents: sessionId === "code-existing" ? [worker] : [],
		}));
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await act(async () => button(container, "Code").click());
		await flush();
		await addTool(container, "Agents");
		await flush();

		const tabFor = (label: string) => [...activeWorkspace(container).querySelectorAll<HTMLElement>(".tool-tab")]
			.find((candidate) => candidate.querySelector(`[role="tab"][aria-label="${label}"]`))!;
		await act(async () => tabFor("Agents").dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 20 }),
		));
		await act(async () => button(container, "Split right").click());
		await flush();
		expect(activeWorkspace(container).querySelectorAll(".workspace-pane")).toHaveLength(2);

		await act(async () => button(container, "Other code task").click());
		await flush();
		expect(api.openSession).toHaveBeenLastCalledWith({ sessionId: "code-other" });

		// Re-activating the agent tab leaves the other session's chat projected.
		await act(async () => tabFor("Agents").querySelector<HTMLElement>('[role="tab"]')!.click());
		await flush();
		expect(api.retainWorkspaceSessions).toHaveBeenLastCalledWith(
			expect.objectContaining({ liveSessionIds: ["code-existing"] }),
		);

		const visiblePanels = [...activeWorkspace(container).querySelectorAll<HTMLElement>(".workspace-panel:not([hidden])")];
		const agentPanel = visiblePanels.find((panel) => panel.querySelector(".subagent-panel"));
		expect(agentPanel).toBeTruthy();
		expect(agentPanel!.textContent).toContain("Code worker");
		expect(activeWorkspace(container).textContent).not.toContain("This session is not in focus.");

		await act(async () => button(agentPanel!, "View transcript for Code worker").click());
		await flush();
		expect(api.readAgentItems).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: "code-existing", agentId: "worker-1" }),
		);

		await act(async () => root.unmount());
	});

	it("splits panes into a second row and reports when a split is blocked", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			x: 0, y: 0, top: 0, right: 1600, bottom: 900, left: 0, width: 1600, height: 900,
			toJSON: () => ({}),
		});
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		const tabFor = (label: string) => [...activeWorkspace(container).querySelectorAll<HTMLElement>(".tool-tab")]
			.find((candidate) => candidate.querySelector(`[role="tab"][aria-label="${label}"]`))!;
		const openMenu = async (label: string) => {
			await act(async () => tabFor(label).dispatchEvent(
				new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 20 }),
			));
		};

		await addTool(container, "Terminal");
		await addTool(container, "Knowledge");
		await flush();

		await openMenu("Knowledge");
		await act(async () => button(container, "Split down").click());
		await flush();
		expect(activeWorkspace(container).querySelectorAll(".workspace-row")).toHaveLength(2);

		await openMenu("Terminal");
		await act(async () => button(container, "Split right").click());
		await addTool(container, "Terminal");
		await flush();
		await openMenu("Terminal 2");
		await act(async () => button(container, "Split right").click());
		await flush();
		expect(activeWorkspace(container).querySelectorAll(".workspace-row")[0]!.querySelectorAll(".workspace-pane")).toHaveLength(3);

		await openMenu("Chat project task");
		const splitRight = button(container, "Split right");
		expect(splitRight.disabled).toBe(true);
		expect(splitRight.title).toBe("Up to 6 panes");
		expect(button(container, "Split down").disabled).toBe(false);

		await act(async () => root.unmount());
	});

	it("disables splits when the workspace is too small", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			x: 0, y: 0, top: 0, right: 600, bottom: 500, left: 0, width: 600, height: 500,
			toJSON: () => ({}),
		});
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await addTool(container, "Terminal");
		await flush();
		const tab = [...activeWorkspace(container).querySelectorAll<HTMLElement>(".tool-tab")]
			.find((candidate) => candidate.querySelector('[role="tab"][aria-label="Terminal"]'))!;
		await act(async () => tab.dispatchEvent(
			new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 20 }),
		));
		const splitRight = button(container, "Split right");
		expect(splitRight.disabled).toBe(true);
		expect(splitRight.title).toBe("Not enough room to split");
		const splitDown = button(container, "Split down");
		expect(splitDown.disabled).toBe(true);
		expect(splitDown.title).toBe("Not enough room to split");

		await act(async () => root.unmount());
	});

	it("activates an automatically opened Process tab during the turn and returns to chat after it", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		const store = new AppStore();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={store} />));
		await flush();

		const running = { ...session("chat-existing", "chat", "/work/chat-project", "Chat project task"), state: "running" as const };
		await act(async () => store.applySnapshot({
			...snapshot(running),
			activeTurnId: "turn-running",
			process: { processId: "process-one", command: "echo one", output: "one\n", state: "running", truncated: false },
		}));
		expect(activeWorkspace(container).querySelector('[role="tab"][aria-label="Process"][aria-selected="true"]')).not.toBeNull();

		await act(async () => store.applySnapshot({
			...snapshot(session("chat-existing", "chat", "/work/chat-project", "Chat project task")),
			process: { processId: "process-one", command: "echo one", output: "one\n", state: "completed", truncated: false },
		}));
		expect(activeWorkspace(container).querySelector<HTMLElement>('[aria-selected="true"]')?.getAttribute("aria-label")).toBe("Chat project task");
		expect(activeWorkspace(container).querySelector('[role="tab"][aria-label="Process"]')).not.toBeNull();

		const tabbar = activeWorkspace(container).querySelector<HTMLElement>(".workspace-tabbar")!;
		await act(async () => button(tabbar, "Process").click());
		expect(container.querySelector(".process-panel:not([hidden])")?.textContent).toContain("Command completed");
		await act(async () => root.unmount());
	});

	it("reactivates the Process tab for each new command even after the user returns to chat", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		const store = new AppStore();
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={store} />));
		await flush();

		const running = { ...session("chat-existing", "chat", "/work/chat-project", "Chat project task"), state: "running" as const };
		await act(async () => store.applySnapshot({
			...snapshot(running),
			activeTurnId: "turn-running",
			process: { processId: "process-one", command: "echo one", output: "one\n", state: "running", truncated: false },
		}));
		const tabbar = activeWorkspace(container).querySelector<HTMLElement>(".workspace-tabbar")!;
		const chatTab = () => button(tabbar, "Chat project task");
		const processTab = () => button(tabbar, "Process");
		await act(async () => chatTab().click());

		await act(async () => store.applySnapshot({
			...snapshot(running),
			activeTurnId: "turn-running",
			process: { processId: "process-two", command: "echo two", output: "two\n", state: "running", truncated: false },
		}));
		expect(processTab().getAttribute("aria-selected")).toBe("true");
		expect(container.querySelector(".process-panel:not([hidden]) .process-command")?.textContent).toContain("echo two");

		await act(async () => store.applySnapshot({
			...snapshot(session("chat-existing", "chat", "/work/chat-project", "Chat project task")),
			process: { processId: "process-two", command: "echo two", output: "two\n", state: "completed", truncated: false },
		}));
		expect(chatTab().getAttribute("aria-selected")).toBe("true");

		await act(async () => store.applySnapshot({
			...snapshot(running),
			activeTurnId: "turn-next",
			process: { processId: "process-three", command: "echo three", output: "", state: "running", truncated: false },
		}));
		expect(processTab().getAttribute("aria-selected")).toBe("true");
		expect(container.querySelector(".process-panel:not([hidden]) .process-command")?.textContent).toContain("echo three");
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
		await addTool(container, "Review");
		await flush();
		expect(api.getWorkspaceReview).toHaveBeenCalledWith({ sessionId: "code-existing", revision: "working-tree" });
		expect(activeWorkspace(container).querySelectorAll('[role="tab"]')).toHaveLength(2);
		expect(container.querySelector(".review-panel.is-visible")?.textContent).toContain("No changes");

		await act(async () => button(activeWorkspace(container), "Add tool").click());
		await act(async () => [...activeWorkspace(container).querySelectorAll<HTMLButtonElement>(".tool-add-menu button")]
			.find((candidate) => candidate.querySelector("span")?.textContent === "Review")!.click());
		expect(activeWorkspace(container).querySelectorAll('[role="tab"]')).toHaveLength(2);
		expect(api.getWorkspaceReview).toHaveBeenCalledTimes(1);
		await act(async () => button(container, "Close Review").click());
		expect(activeWorkspace(container).querySelectorAll('[role="tab"]')).toHaveLength(1);
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
		await addTool(container, "Terminal");
		await flush();
		await addTool(container, "Browser");
		await flush();
		await addTool(container, "Files");
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
			sessionId: "code-existing",
			browserId: vi.mocked(api.createBrowser).mock.calls[0]![0].browserId,
		});
		expect(localStorage.getItem("metis.file-browser.v1:code-existing")).toBeNull();
		expect(activeWorkspace(container).querySelectorAll('[role="tab"]')).toHaveLength(1);
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
		await addTool(container, "Files");
		await flush();
		expect(api.listWorkspaceDirectory).toHaveBeenCalledWith({ sessionId: "code-existing", relativePath: "" });
		expect(activeWorkspace(container).querySelector('[aria-selected="true"]')?.textContent).toContain("Open file");
		expect(container.querySelector('.file-tree-row [title=".env"]')).not.toBeNull();

		await act(async () => container.querySelector<HTMLButtonElement>('.file-tree-row [title="README.md"]')!.click());
		await flush();
		expect(api.readWorkspaceFile).toHaveBeenCalledWith({ sessionId: "code-existing", relativePath: "README.md" });
		expect(codeEditor(container, "Edit README.md").state.doc.toString()).toBe("# README.md\n\nWorkspace preview.");
		await act(async () => button(container, "Show preview").click());
		expect(container.querySelector(".file-markdown h1")?.textContent).toBe("README.md");
		await act(async () => button(container, "View source").click());
		expect(codeEditor(container, "Edit README.md").state.doc.toString()).toBe("# README.md\n\nWorkspace preview.");
		expect(container.querySelector(".tool-tab.is-preview")).not.toBeNull();

		await act(async () =>
			container.querySelector<HTMLButtonElement>('.file-tree-row [title="README.md"]')!
				.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
		);
		expect(container.querySelector(".tool-tab.is-preview")).toBeNull();
		await act(async () => container.querySelector<HTMLButtonElement>('.file-tree-row [title="notes.txt"]')!.click());
		await flush();
		expect(activeWorkspace(container).querySelectorAll('[role="tab"]')).toHaveLength(4);
		expect(container.querySelectorAll(".tool-tab.is-preview")).toHaveLength(1);
		await act(async () => container.querySelector<HTMLButtonElement>('.file-tree-row [title="README.md"]')!.click());
		await flush();
		expect(activeWorkspace(container).querySelectorAll('[role="tab"]')).toHaveLength(4);

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

		expect(container.querySelectorAll(".cm-editor")).toHaveLength(1);
		await act(async () => button(container, "Chat").click());
		await flush();
		expect(container.querySelectorAll(".cm-editor")).toHaveLength(0);
		await act(async () => button(container, "Code").click());
		await flush();
		await act(async () => button(activeWorkspace(container), "README.md").click());
		await flush();
		expect(codeEditor(container, "Edit README.md").state.doc.toString()).toBe("# README.md\n\nWorkspace preview.");
		await act(async () => root.unmount());

		root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		await act(async () => button(container, "Code").click());
		await flush();
		await addTool(container, "Files");
		await flush();
		expect(activeWorkspace(container).querySelectorAll('[role="tab"]')).toHaveLength(3);
		expect(activeWorkspace(container).querySelector('[aria-selected="true"]')?.textContent).toContain("README.md");
		expect(container.querySelector(".tool-tab.is-preview")).toBeNull();
		await act(async () => root.unmount());
	});

	it("does not toast when a workspace preview target is not a file", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
			x: 0, y: 0, top: 0, right: 320, bottom: 600, left: 0, width: 320, height: 600,
			toJSON: () => ({}),
		});
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		localStorage.setItem("metis.activeSessionId.code", "code-existing");
		const { api } = createHarness();
		vi.mocked(api.readWorkspaceFile).mockRejectedValue(
			new Error("Error invoking remote method 'metis:read-workspace-file': Error: Workspace target is not a file"),
		);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		await act(async () => button(container, "Code").click());
		await flush();
		await addTool(container, "Files");
		await flush();
		await act(async () => container.querySelector<HTMLButtonElement>('.file-tree-row [title="README.md"]')!.click());
		await flush();
		expect(container.querySelector(".file-empty-state.is-error")?.textContent).toContain("File could not be opened");
		expect(container.querySelector('[role="alert"]')?.textContent ?? "").not.toContain("metis:read-workspace-file");
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
		await addTool(container, "Files");
		await flush();
		await act(async () => container.querySelector<HTMLButtonElement>('.file-tree-row [title="README.md"]')!.click());
		await flush();

		let editor = codeEditor(container, "Edit README.md");
		await act(async () => changeCodeEditor(editor, "# Edited README"));
		await flush();
		expect(container.querySelector(".tool-tab.is-dirty")).not.toBeNull();
		expect(api.setWorkspaceEditState).toHaveBeenLastCalledWith({
			dirty: true,
			language: "en",
			visibleSessionId: "code-existing",
		});
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
		const fileTabbar = activeWorkspace(container).querySelector<HTMLElement>(".workspace-tabbar")!;
		await act(async () => button(fileTabbar, "Code project task").click());
		expect([...container.querySelectorAll(".cm-editor")].filter((node) => !node.closest("[hidden]"))).toHaveLength(0);
		await act(async () => button(fileTabbar, "README.md").click());
		editor = codeEditor(container, "Edit README.md");
		expect(editor.state.doc.toString()).toBe("# Edited README");
		await act(async () => button(container, "Chat").click());
		await flush();
		expect([...container.querySelectorAll(".cm-editor")].filter((node) => !node.closest("[hidden]"))).toHaveLength(0);
		await act(async () => button(container, "Code").click());
		await flush();
		await act(async () => button(fileTabbar, "README.md").click());
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
		expect(api.setWorkspaceEditState).toHaveBeenLastCalledWith({
			dirty: false,
			language: "en",
			visibleSessionId: "code-existing",
		});
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

		await addTool(container, "Files");
		await flush();
		await act(async () => container.querySelector<HTMLButtonElement>('.file-tree-row [title="README.md"]')!.click());
		await flush();
		editor = codeEditor(container, "Edit README.md");
		await act(async () => changeCodeEditor(editor, "save before close"));
		await act(async () => button(container, "Close README.md").click());
		await act(async () => button(container, "Save").click());
		await flush();
		expect(container.querySelector('[aria-label="Edit README.md"]')).toBeNull();

		await addTool(container, "Files");
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
		expect(container.querySelector('[role="alert"]')?.textContent).toContain("Workspace file changed on disk");
		await act(async () => button(container, "Don’t Save").click());
		await flush();
		expect(api.setWorkspaceEditState).toHaveBeenLastCalledWith({
			dirty: false,
			language: "en",
			visibleSessionId: "code-existing",
		});
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
		await addTool(container, "Files");
		await flush();

		await openRootTreeMenu(container);
		await act(async () => button(container.querySelector<HTMLElement>('[role="menu"][aria-label="File actions"]')!, "New file").click());
		expect(container.querySelector(".file-tree-name-input")).not.toBeNull();
		expect(api.mutateWorkspaceEntry).not.toHaveBeenCalled();
		await act(async () => {
			container.querySelector(".file-tree-name-input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
		});
		expect(container.querySelector(".file-tree-name-input")).toBeNull();
		expect(api.mutateWorkspaceEntry).not.toHaveBeenCalled();

		await openRootTreeMenu(container);
		await act(async () => button(container.querySelector<HTMLElement>('[role="menu"][aria-label="File actions"]')!, "New file").click());
		await submitTreeName(container, "scratch.ts");
		await flush();
		expect(api.mutateWorkspaceEntry).toHaveBeenLastCalledWith({
			action: "create", sessionId: "code-existing", parentRelativePath: "", name: "scratch.ts", kind: "file",
		});
		expect(activeWorkspace(container).querySelector('[aria-selected="true"]')?.textContent).toContain("scratch.ts");
		expect(container.querySelector(".tool-tab.is-preview")).toBeNull();
		let editor = codeEditor(container, "Edit scratch.ts");
		await act(async () => changeCodeEditor(editor, "export const draft = true;"));

		await openTreeMenu(container, "scratch.ts");
		await act(async () => button(container.querySelector<HTMLElement>('[role="menu"][aria-label="File actions"]')!, "Rename").click());
		await submitTreeName(container, "renamed.ts");
		await flush();
		expect(activeWorkspace(container).querySelector('[aria-selected="true"]')?.textContent).toContain("renamed.ts");
		editor = codeEditor(container, "Edit renamed.ts");
		expect(editor.state.doc.toString()).toBe("export const draft = true;");

		await act(async () => button(container, "Save file").click());
		await flush();
		expect(api.writeWorkspaceFile).toHaveBeenLastCalledWith(expect.objectContaining({
			relativePath: "renamed.ts", text: "export const draft = true;",
		}));

		await act(async () => changeCodeEditor(editor, "discard this draft"));
		await openTreeMenu(container, "renamed.ts");
		await act(async () => button(container.querySelector<HTMLElement>('[role="menu"][aria-label="File actions"]')!, "Move to Trash").click());
		let dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="file-trash-title"]')!;
		expect(dialog.textContent).toContain("Unsaved changes in 1 open file will be discarded.");
		await act(async () => button(dialog, "Cancel").click());
		expect(codeEditor(container, "Edit renamed.ts").state.doc.toString()).toBe("discard this draft");
		await openTreeMenu(container, "renamed.ts");
		await act(async () => button(container.querySelector<HTMLElement>('[role="menu"][aria-label="File actions"]')!, "Move to Trash").click());
		dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="file-trash-title"]')!;
		await act(async () => button(dialog, "Move to Trash").click());
		await flush();
		expect([...activeWorkspace(container).querySelectorAll('[role="tab"]')].map((tab) => tab.textContent)).toContain("Open file");
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
		await submitTreeName(container, "source");
		await flush();
		let stored = JSON.parse(localStorage.getItem("metis.file-browser.v1:code-existing")!) as {
			fixedPaths: string[]; expandedPaths: string[];
		};
		expect(stored.fixedPaths).toEqual(expect.arrayContaining(["source/a.ts", "source/nested/b.ts"]));
		expect(stored.expandedPaths).toContain("source/nested");

		await openTreeMenu(container, "source");
		await act(async () => button(container.querySelector<HTMLElement>('[role="menu"][aria-label="File actions"]')!, "Move to Trash").click());
		dialog = container.querySelector<HTMLElement>('[role="dialog"][aria-labelledby="file-trash-title"]')!;
		await act(async () => button(dialog, "Move to Trash").click());
		await flush();
		expect([...activeWorkspace(container).querySelectorAll('[role="tab"]')].some((tab) => /a\.ts|b\.ts/u.test(tab.textContent ?? ""))).toBe(false);
		stored = JSON.parse(localStorage.getItem("metis.file-browser.v1:code-existing")!) as {
			fixedPaths: string[]; expandedPaths: string[];
		};
		expect(stored.expandedPaths.some((path) => path.startsWith("source"))).toBe(false);

		await openTreeMenu(container, "docs");
		const mutationCalls = vi.mocked(api.mutateWorkspaceEntry).mock.calls.length;
		await act(async () => button(container.querySelector<HTMLElement>('[role="menu"][aria-label="File actions"]')!, "New file").click());
		expect(vi.mocked(api.mutateWorkspaceEntry).mock.calls.length).toBe(mutationCalls);
		await submitTreeName(container, "inside-docs.ts");
		await flush();
		expect(api.mutateWorkspaceEntry).toHaveBeenLastCalledWith({
			action: "create", sessionId: "code-existing", parentRelativePath: "docs", name: "inside-docs.ts", kind: "file",
		});
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
		await addTool(container, "Files");
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

		await act(async () => activeWorkspace(container).querySelector<HTMLButtonElement>(".tool-add-trigger")!.click());
		expect(activeWorkspace(container).querySelector(".tool-add-menu")?.textContent).toContain("Browser");
		const browserButton = [...activeWorkspace(container).querySelectorAll<HTMLButtonElement>(".tool-add-menu button")]
			.find((candidate) => candidate.querySelector("span")?.textContent === "Browser")!;
		await act(async () => browserButton.click());
		await flush();
		expect(api.createBrowser).toHaveBeenCalledTimes(1);
		expect(api.createBrowser).toHaveBeenCalledWith(expect.objectContaining({
			profileId: DEFAULT_BROWSER_PROFILE_ID,
		}));
		expect(container.querySelector('[aria-label="Browser address"]')).not.toBeNull();
		expect(container.textContent).toContain("Start browsing");
		const browserId = vi.mocked(api.createBrowser).mock.calls[0]![0].browserId;
		const address = container.querySelector<HTMLInputElement>('[aria-label="Browser address"]')!;
		changeInput(address, "example.com");
		await act(async () => container.querySelector<HTMLFormElement>(".browser-address-form")!.requestSubmit());
		expect(api.controlBrowser).toHaveBeenCalledWith({
			type: "navigate",
			sessionId: "chat-existing",
			browserId,
			url: "example.com",
		});

		act(() => emitBrowser({
			type: "state",
			state: {
				browserId,
				profileId: DEFAULT_BROWSER_PROFILE_ID,
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
		expect(activeWorkspace(container).querySelector('[aria-selected="true"]')?.textContent).toContain("Example Domain");
		expect(button(container, "Back").disabled).toBe(false);
		expect(button(container, "Forward").disabled).toBe(true);

		vi.mocked(api.controlBrowser).mockClear();
		await act(async () => button(container, "More browser actions").click());
		await flush();
		expect(api.captureBrowserPreview).toHaveBeenCalledWith({ sessionId: "chat-existing", browserId });
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
			sessionId: "chat-existing",
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
			sessionId: "chat-existing",
			browserId,
			text: "open",
			forward: false,
			findNext: false,
		});
		await act(async () =>
			findInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })),
		);
		expect(api.controlBrowser).toHaveBeenLastCalledWith({
			type: "stop-find",
			sessionId: "chat-existing",
			browserId,
		});
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
		expect(api.controlBrowser).toHaveBeenCalledWith({ type: "print", sessionId: "chat-existing", browserId });

		await act(async () => button(container, "More browser actions").click());
		await act(async () => button(container, "Zoom in").click());
		await flush();
		expect(api.controlBrowser).toHaveBeenCalledWith({ type: "zoom-in", sessionId: "chat-existing", browserId });
		expect(container.querySelector(".browser-more-menu")).not.toBeNull();
		const zoomInput = container.querySelector<HTMLInputElement>('input[aria-label="Zoom percentage"]')!;
		expect(zoomInput).not.toBeNull();
		changeInput(zoomInput, "137");
		await act(async () =>
			zoomInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })),
		);
		expect(api.controlBrowser).toHaveBeenCalledWith({
			type: "set-zoom",
			sessionId: "chat-existing",
			browserId,
			zoomPercent: 137,
		});
		act(() => emitBrowser({
			type: "state",
			state: {
				browserId,
				profileId: DEFAULT_BROWSER_PROFILE_ID,
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
		expect(api.controlBrowser).toHaveBeenCalledWith({
			type: "clear-data",
			sessionId: "chat-existing",
			browserId,
		});
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
			expect(api.controlBrowser).toHaveBeenCalledWith({ type, sessionId: "chat-existing", browserId });
		}

		await act(async () => button(activeWorkspace(container), "Add tool").click());
		await flush();
		expect(api.controlBrowser).toHaveBeenLastCalledWith(expect.objectContaining({
			type: "present",
			browserId,
			visible: false,
		}));
		const callsWhileHidden = vi.mocked(api.controlBrowser).mock.calls.length;
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "p", metaKey: true }));
		expect(api.controlBrowser).toHaveBeenCalledTimes(callsWhileHidden);
		const secondBrowserButton = [...activeWorkspace(container).querySelectorAll<HTMLButtonElement>(".tool-add-menu button")]
			.find((candidate) => candidate.querySelector("span")?.textContent === "Browser")!;
		await act(async () => secondBrowserButton.click());
		await flush();
		expect(api.createBrowser).toHaveBeenCalledTimes(2);
		expect(activeWorkspace(container).querySelectorAll('[role="tab"]')).toHaveLength(3);
		await act(async () => button(container, "Close New tab").click());
		await act(async () => button(container, "Close Example Domain").click());
		expect(api.closeBrowser).toHaveBeenCalledTimes(2);
		expect(api.closeBrowser).toHaveBeenCalledWith({ sessionId: "chat-existing", browserId });
		expect(activeWorkspace(container).querySelectorAll('[role="tab"]')).toHaveLength(1);

		await act(async () => root.unmount());
	});

	it("opens a browser with the selected isolated profile", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		localStorage.setItem("metis.activeSessionId.chat", "chat-existing");
		const { api } = createHarness();
		vi.mocked(api.listBrowserProfiles).mockResolvedValue([
			{ profileId: DEFAULT_BROWSER_PROFILE_ID, name: "Default", sourceId: null, sourceProfileId: null },
			{ profileId: "22222222-2222-4222-8222-222222222222", name: "Work", sourceId: "chrome", sourceProfileId: "Profile 2" },
		]);
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();

		await addTool(container, "Browser");
		await flush();
		expect(api.createBrowser).toHaveBeenLastCalledWith(expect.objectContaining({
			profileId: DEFAULT_BROWSER_PROFILE_ID,
		}));
		await act(async () => button(container, "Browser profile: Metis — Default profile").click());
		await flush();
		expect(document.body.textContent).toContain("Google Chrome — Work");
		await act(async () => button(document.body, "Google Chrome — Work").click());
		await flush();

		expect(api.createBrowser).toHaveBeenLastCalledWith(expect.objectContaining({
			profileId: "22222222-2222-4222-8222-222222222222",
		}));
		expect(localStorage.getItem("metis.browser-profile.v1")).toBe("22222222-2222-4222-8222-222222222222");
		expect(container.querySelector('.browser-panel.is-visible button[aria-label="Browser profile: Google Chrome — Work"] svg')).not.toBeNull();
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

		await act(async () => button(container, "Metis User").click());
		await act(async () => button(container, "Settings").click());
		await act(async () => button(container, "General").click());
		await act(async () => button(container, "中文").click());
		await act(async () => button(container, "返回应用").click());

		expect(document.documentElement.lang).toBe("zh-CN");
		expect(container.textContent).toContain("新建任务");
		expect(container.textContent).toContain("自定义");
		expect(container.textContent).toContain("定时任务");
		expect(container.querySelector(".new-task-starters-label")).toBeNull();
		expect(container.querySelector(".home-project-picker-hint")).toBeNull();
		expect(container.querySelector('[aria-label="隐藏会话侧边栏"]')).not.toBeNull();
		await act(async () => root.unmount());
	});

	it("opens the originating session from a desktop notification", async () => {
		(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
		const active = session("session-active", "chat", "/tmp/chat", "Active");
		const target = session("session-target", "code", "/tmp/code", "检查登录流程");
		const { api, emitEvent } = createHarness({ sessions: [active, target] });
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		await act(async () => root.render(<App api={api} store={new AppStore()} />));
		await flush();
		expect(api.setWorkspaceEditState).toHaveBeenLastCalledWith({
			dirty: false,
			language: "en",
			visibleSessionId: null,
		});

		await act(async () => emitEvent({ type: "open-session", sessionId: target.sessionId, mode: "code" }));
		await flush();

		expect(api.openSession).toHaveBeenLastCalledWith({ sessionId: target.sessionId });
		expect(container.querySelector(".mode-switch")?.getAttribute("data-mode")).toBe("code");
		expect(api.setWorkspaceEditState).toHaveBeenLastCalledWith({
			dirty: false,
			language: "en",
			visibleSessionId: target.sessionId,
		});
		await act(async () => root.unmount());
	});
});
