import {
	type AgentMode,
	type ClientResult,
	type DomainEvent,
	type InteractionResponseInput,
	type InteractionView,
	type ItemView,
	type McpServerSummaryView,
	type ModelOptionView,
	type ModelSettingsView,
	type PermissionModeView,
	type PlanView,
	type QueuedTurnView,
	RPC_ERROR_CODES,
	type ScheduleTaskView,
	type SessionDeliveredFileView,
	type SessionSummary,
	type SessionStatusView,
	type SkillSummaryView,
	type ThinkingSelectionView,
} from "@metis/app-protocol";
import { Lightbulb, SidebarSimple, XCircle } from "@phosphor-icons/react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopUpdateState, MetisDesktopApi } from "../../shared/desktop-api.ts";
import {
	applyGeneralPreferencesToDocument,
	loadGeneralPreferences,
	resolveReducedMotion,
	saveGeneralPreferences,
} from "../general-preferences.ts";
import { useAppStore } from "../hooks/use-app-store.ts";
import {
	composerPayload,
	composerRequestKey,
	useConversationPlanFlow,
} from "../hooks/use-conversation-plan-flow.ts";
import { useScheduleStore } from "../hooks/use-schedule-store.ts";
import type { AppStore, AppStoreSnapshot } from "../store/app-store.ts";
import { ScheduleStore } from "../store/schedule-store.ts";
import {
	loadProjectPreferences,
	type ProjectPreferenceMap,
	removeProjectPreference,
	saveProjectPreferences,
	setProjectAlias,
	setProjectPinned,
} from "../store/project-preferences.ts";
import { loadSessionPins, saveSessionPins, setSessionPinned } from "../store/session-pins.ts";
import { applyThemeToDocument, loadTheme, resolveTheme, saveTheme, type AppTheme, watchSystemTheme } from "../theme.ts";
import { contextUsagePercent } from "../context-usage.ts";
import { Composer, type ComposerSubmission } from "./Composer.tsx";
import { CodeProjectSetup } from "./CodeProjectSetup.tsx";
import { GoalBar } from "./GoalBar.tsx";
import { InteractionHost } from "./InteractionHost.tsx";
import { ModelSelector } from "./ModelSelector.tsx";
import { NewTaskHome } from "./NewTaskHome.tsx";
import { PermissionSelector } from "./PermissionSelector.tsx";
import { QueuedTurnList } from "./QueuedTurnList.tsx";
import { RecoveryBanner } from "./RecoveryBanner.tsx";
import {
	clampSessionSidebarPreferredWidth,
	clampSessionSidebarWidth,
	sessionSidebarDefaultWidth,
	type ProjectSessionGroup,
	type SidebarDestination,
	SessionSidebar,
} from "./SessionSidebar.tsx";
import { PluginsPanel } from "./PluginsPanel.tsx";
import type { SkillCreationTarget } from "./SkillCreationDialog.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";
import { SessionStatusPanel } from "./SessionStatusPanel.tsx";
import { SCHEDULE_KEEP_AWAKE_KEY, ScheduledTasksPanel } from "./ScheduledTasksPanel.tsx";
import { ThinkingSelector } from "./ThinkingSelector.tsx";
import { TurnRuntimeStatus } from "./TurnRuntimeStatus.tsx";
import { clampToolsSidebarWidth, ToolsSidebar } from "./ToolsSidebar.tsx";
import type { UniversalPreviewTarget } from "./preview/UniversalFilePreviewer.tsx";
import { Transcript } from "./Transcript.tsx";
import { WorkspaceSessionHeader } from "./WorkspaceSessionHeader.tsx";
import { GOAL_SLASH_USAGE, type GoalSlashCommand } from "../goal-slash.ts";
import type { ComposerSlashCommand } from "./SlashCommandMenu.tsx";

interface AppProps {
	readonly api: MetisDesktopApi;
	readonly store: AppStore;
}

interface NewTaskDraft {
	readonly mode: AgentMode;
	readonly folder: string | null;
	readonly sessionId: string | null;
	readonly permissionMode: PermissionModeView;
}

const ASSISTED_SCHEDULE_PROMPT =
	"I want to set up a scheduled task. Briefly explain how scheduled tasks work in Metis, then ask me a few concise questions to determine what it should do, when it should run, and whether it should use an available Skill. Do not create the task until I confirm the details.";
const MCP_STATUS_POLL_MS = 500;
const MCP_RECONNECT_POLL_MS = 4_000;

function emptyNewTaskDraft(mode: AgentMode): NewTaskDraft {
	return { mode, folder: null, sessionId: null, permissionMode: "auto" };
}

function activeSessionKey(mode: AgentMode): string {
	return `metis.activeSessionId.${mode}`;
}

function projectKey(mode: AgentMode, cwd: string): string {
	return JSON.stringify([mode, cwd]);
}

function projectActionError(cause: unknown): Error {
	const code = rpcErrorCode(cause);
	if (code === RPC_ERROR_CODES.BUSY) return new Error("The project changed or is busy. Load a fresh preview and retry.");
	if (code === RPC_ERROR_CODES.SESSION_IN_USE) return new Error("A project session is still in use. Close it and retry.");
	if (code === RPC_ERROR_CODES.SESSION_CORRUPT) return new Error("A project session is corrupt or ambiguous. Nothing was removed.");
	if (code === RPC_ERROR_CODES.SCHEDULE_STORE_CORRUPT) return new Error("Scheduled tasks could not be checked safely. Repair them before retrying.");
	if (code === RPC_ERROR_CODES.OPERATION_FAILED) return new Error("The project could not be moved to Trash. Nothing was permanently deleted.");
	return cause instanceof Error ? cause : new Error("The project operation could not be completed.");
}

function rpcErrorCode(cause: unknown): number | undefined {
	return typeof cause === "object" && cause !== null && "code" in cause ? Number(cause.code) : undefined;
}

function sessionActionError(cause: unknown, action: "rename" | "delete"): Error {
	const code = rpcErrorCode(cause);
	if (code === RPC_ERROR_CODES.SESSION_IN_USE) return new Error("This session is still running or waiting for input.");
	if (code === RPC_ERROR_CODES.READ_ONLY_SESSION) return new Error("Scheduled sessions are read-only.");
	if (code === RPC_ERROR_CODES.OPERATION_FAILED) {
		return new Error(action === "delete" ? "The session could not be moved to Trash." : "The session could not be renamed.");
	}
	return cause instanceof Error ? cause : new Error("The session operation could not be completed.");
}

function queuedTurnActionError(cause: unknown): Error {
	const code = rpcErrorCode(cause);
	if (code === RPC_ERROR_CODES.CONFLICT) return new Error("This queued message changed. Review it and try again.");
	if (code === RPC_ERROR_CODES.BUSY) return new Error("The task state changed before this message could be sent.");
	if (code === RPC_ERROR_CODES.OVERLOADED) return new Error("The message queue is full.");
	if (code === RPC_ERROR_CODES.READ_ONLY_SESSION) return new Error("Scheduled sessions are read-only.");
	return cause instanceof Error ? cause : new Error("The queued message could not be changed.");
}

export function sessionDisplayTitle(session: Pick<SessionSummary, "cwd" | "cwdOrigin" | "name">): string {
	return session.name || (session.cwdOrigin === "managed" ? "Chat" : session.cwd) || "Metis";
}

export function shouldResnapshotAfterReady(
	before: AppStoreSnapshot,
	next: Awaited<ReturnType<MetisDesktopApi["getServerState"]>>,
): boolean {
	return (
		next.state === "ready" &&
		before.activeSessionId !== null &&
		(before.supervisor.state !== "ready" || before.serverEpoch !== next.serverEpoch)
	);
}

export function firstInteractionForSession(
	interactionOrder: readonly string[],
	interactionsById: ReadonlyMap<string, InteractionView>,
	sessionId: string | undefined,
): InteractionView | undefined {
	if (!sessionId) return undefined;
	for (const interactionId of interactionOrder) {
		const interaction = interactionsById.get(interactionId);
		if (interaction?.sessionId === sessionId) return interaction;
	}
	return undefined;
}

export function latestAssistantUsageKey(
	itemOrder: readonly string[],
	itemsById: ReadonlyMap<string, ItemView>,
): string {
	for (let i = itemOrder.length - 1; i >= 0; i--) {
		const item = itemsById.get(itemOrder[i]!);
		if (item?.role !== "assistant" || item.state !== "completed" || !item.usage) continue;
		const usage = item.usage;
		return `${item.itemId}:${usage.inputTokens ?? 0}:${usage.outputTokens ?? 0}:${usage.cacheReadTokens ?? 0}:${usage.cacheWriteTokens ?? 0}`;
	}
	return "";
}

const TOOLS_SIDEBAR_WIDTH_PREFIX = "metis.tools-sidebar-width.v2:";
const SESSION_SIDEBAR_WIDTH_KEY = "metis.session-sidebar-width.v1";

function loadSessionSidebarPreferredWidth(): number {
	try {
		const value = Number.parseInt(localStorage.getItem(SESSION_SIDEBAR_WIDTH_KEY) ?? "", 10);
		if (!Number.isInteger(value)) return sessionSidebarDefaultWidth();
		return clampSessionSidebarPreferredWidth(value);
	} catch {
		return sessionSidebarDefaultWidth();
	}
}

function loadToolsSidebarPreferredWidth(sessionId: string, workspaceWidth: number): number {
	const value = Number.parseInt(localStorage.getItem(`${TOOLS_SIDEBAR_WIDTH_PREFIX}${sessionId}`) ?? "", 10);
	return Number.isInteger(value) && value >= 280 ? value : Math.round(workspaceWidth * 0.44);
}

export function App({ api, store }: AppProps) {
	const { i18n, t } = useTranslation();
	const state = useAppStore(store);
	const scheduleStoreRef = useRef<ScheduleStore | null>(null);
	if (!scheduleStoreRef.current) scheduleStoreRef.current = new ScheduleStore();
	const scheduleStore = scheduleStoreRef.current;
	const scheduleState = useScheduleStore(scheduleStore);
	const [mode, setMode] = useState<AgentMode>("chat");
	const [destination, setDestination] = useState<SidebarDestination>("tasks");
	const [settingsOpen, setSettingsOpen] = useState(false);
	const settingsReturnFocusRef = useRef<HTMLElement | null>(null);
	const [selectedScheduleTaskId, setSelectedScheduleTaskId] = useState<string | null>(null);
	const [projectPreferences, setProjectPreferences] = useState(() => loadProjectPreferences(localStorage));
	const [pinnedSessionIds, setPinnedSessionIds] = useState(() => loadSessionPins(localStorage));
	const [busyProjectKeys, setBusyProjectKeys] = useState<ReadonlySet<string>>(new Set());
	const [newTaskDraft, setNewTaskDraft] = useState<NewTaskDraft | null>(() => emptyNewTaskDraft("chat"));
	const [sessionsSidebarOpen, setSessionsSidebarOpen] = useState(true);
	const [sessionSidebarPreferredWidth, setSessionSidebarPreferredWidth] = useState(loadSessionSidebarPreferredWidth);
	const [sessionSidebarWidth, setSessionSidebarWidth] = useState(() => clampSessionSidebarWidth(sessionSidebarPreferredWidth));
	const [toolsSidebarOpen, setToolsSidebarOpen] = useState(false);
	const [toolsSidebarPreferredWidth, setToolsSidebarPreferredWidth] = useState(393);
	const [toolsSidebarWidth, setToolsSidebarWidth] = useState(393);
	const [previewRequest, setPreviewRequest] = useState<UniversalPreviewTarget | null>(null);
	const [planPreviewRequest, setPlanPreviewRequest] = useState<PlanView | null>(null);
	const [bootstrapped, setBootstrapped] = useState(false);
	const [theme, setTheme] = useState<AppTheme>(() => loadTheme(localStorage));
	const [generalPreferences, setGeneralPreferences] = useState(() => loadGeneralPreferences(localStorage));
	const [reducedMotion, setReducedMotion] = useState(() =>
		resolveReducedMotion(
			generalPreferences.motion,
			globalThis.matchMedia?.("(prefers-reduced-motion: reduce)") ?? { matches: false },
		),
	);
	const [resolvedTheme, setResolvedTheme] = useState<"dark" | "light">(() =>
		resolveTheme(loadTheme(localStorage), globalThis.matchMedia?.("(prefers-color-scheme: light)") ?? { matches: false }),
	);
	const [modelSettings, setModelSettings] = useState<ModelSettingsView | null>(null);
	const [draftBusy, setDraftBusy] = useState(false);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [skills, setSkills] = useState<readonly SkillSummaryView[]>([]);
	const [mcpServers, setMcpServers] = useState<readonly McpServerSummaryView[]>([]);
	const [pluginSection, setPluginSection] = useState<"skills" | "mcp">("skills");
	const [skillCatalogEpoch, setSkillCatalogEpoch] = useState(0);
	const [message, setMessage] = useState("Starting Metis…");
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [composerControl, setComposerControl] = useState<{ readonly id: number; readonly target: "model" | "thinking" | "mcp" | null }>({ id: 0, target: null });
	const [sessionStatusPanel, setSessionStatusPanel] = useState<{
		readonly sessionId: string;
		readonly loading: boolean;
		readonly closing?: boolean;
		readonly status?: SessionStatusView;
		readonly error?: string;
	} | null>(null);
	const [contextStatus, setContextStatus] = useState<SessionStatusView | null>(null);
	const [compactingSession, setCompactingSession] = useState<{ readonly sessionId: string; readonly startedAt: string } | null>(null);
	const [dirtyToolSessionIds, setDirtyToolSessionIds] = useState<readonly string[]>([]);
	const [toolCleanupSessionIds, setToolCleanupSessionIds] = useState<readonly string[]>([]);
	const [updateState, setUpdateState] = useState<DesktopUpdateState>({ status: "unavailable" });
	const openGeneration = useRef(0);
	const mcpListGeneration = useRef(0);
	const modelSettingsGeneration = useRef(0);
	const openingSessionId = useRef<string | null>(null);
	const resnapshots = useRef(new Map<string, Promise<void>>());
	const newTaskCreateRequest = useRef<{ key: string; requestId: string } | null>(null);
	const newTaskTurnRequest = useRef<{ key: string; requestId: string } | null>(null);
	const updateToolsSidebarWidth = useCallback((width: number, persist = true) => {
		setToolsSidebarWidth(width);
		if (persist && state.activeSessionId) {
			setToolsSidebarPreferredWidth(width);
			localStorage.setItem(`${TOOLS_SIDEBAR_WIDTH_PREFIX}${state.activeSessionId}`, String(width));
		}
	}, [state.activeSessionId]);
	const showToolsSidebar = useCallback(() => {
		if (state.activeSessionId) {
			const workspaceWidth = document.querySelector<HTMLElement>(".workspace")?.clientWidth ?? window.innerWidth;
			const preferredWidth = loadToolsSidebarPreferredWidth(state.activeSessionId, workspaceWidth);
			setToolsSidebarPreferredWidth(preferredWidth);
			setToolsSidebarWidth(clampToolsSidebarWidth(preferredWidth, workspaceWidth));
		}
		setToolsSidebarOpen(true);
	}, [state.activeSessionId]);
	const handlePreviewDeliveredFile = useCallback(
		(file: SessionDeliveredFileView) => {
			if (!state.activeSessionId) return;
			setPreviewRequest({
				source: "delivered",
				sessionId: state.activeSessionId,
				fileId: file.fileId,
				name: file.name,
			});
			showToolsSidebar();
		},
		[showToolsSidebar, state.activeSessionId],
	);
	const updateSessionSidebarWidth = useCallback((width: number, persist = true) => {
		const clamped = clampSessionSidebarWidth(width);
		setSessionSidebarWidth(clamped);
		if (!persist) return;
		setSessionSidebarPreferredWidth(clamped);
		try {
			localStorage.setItem(SESSION_SIDEBAR_WIDTH_KEY, String(clamped));
		} catch {
			// The preference remains renderer-local when storage is unavailable.
		}
	}, []);
	useEffect(() => {
		const media = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)");
		const apply = () => {
			const resolvedMedia = media ?? { matches: false };
			applyGeneralPreferencesToDocument(generalPreferences, resolvedMedia);
			setReducedMotion(resolveReducedMotion(generalPreferences.motion, resolvedMedia));
		};
		apply();
		saveGeneralPreferences(localStorage, generalPreferences);
		if (generalPreferences.motion !== "system" || !media) return undefined;
		media.addEventListener("change", apply);
		return () => media.removeEventListener("change", apply);
	}, [generalPreferences]);
	useEffect(() => {
		const apply = () => {
			applyThemeToDocument(theme);
			setResolvedTheme(resolveTheme(theme, globalThis.matchMedia?.("(prefers-color-scheme: light)") ?? { matches: false }));
		};
		apply();
		saveTheme(localStorage, theme);
		void api.setThemePreference(theme).catch(() => undefined);
		if (theme === "system") {
			return watchSystemTheme(apply);
		}
		return undefined;
	}, [api, theme]);
	useEffect(() => {
		const resize = () => updateSessionSidebarWidth(sessionSidebarPreferredWidth, false);
		window.addEventListener("resize", resize);
		resize();
		return () => window.removeEventListener("resize", resize);
	}, [sessionSidebarPreferredWidth, updateSessionSidebarWidth]);
	useEffect(() => {
		if (!toolsSidebarOpen || !state.activeSessionId) return;
		const workspaceWidth = document.querySelector<HTMLElement>(".workspace")?.clientWidth || window.innerWidth;
		const preferredWidth = loadToolsSidebarPreferredWidth(state.activeSessionId, workspaceWidth);
		setToolsSidebarPreferredWidth(preferredWidth);
		setToolsSidebarWidth(clampToolsSidebarWidth(preferredWidth, workspaceWidth));
	}, [state.activeSessionId, toolsSidebarOpen]);
	const skillListGeneration = useRef(0);
	const scheduleSubscriptionGeneration = useRef(0);
	const scheduleSnapshotRequest = useRef<Promise<void> | null>(null);
	const projectCreateRequests = useRef(
		new Map<string, { requestId: string; promise?: Promise<void> }>(),
	);
	const projectDeleteRequests = useRef(new Map<string, { requestId: string; revision: string }>());
	const sessionRenameRequests = useRef(new Map<string, { name: string; requestId: string }>());
	const sessionDeleteRequests = useRef(new Map<string, string>());
	const sessionMarkReadRequests = useRef(new Set<string>());
	const statusGeneration = useRef(0);
	const contextStatusRef = useRef<SessionStatusView | null>(null);
	const visibleSessionId = !settingsOpen && destination === "tasks" && newTaskDraft === null ? state.activeSessionId : null;
	const visibleSessionIdRef = useRef<string | null>(visibleSessionId);
	visibleSessionIdRef.current = visibleSessionId;

	const reportError = useCallback((cause: unknown) => {
		setError(cause instanceof Error ? cause.message : "Metis could not complete the request.");
	}, []);
	const clearError = useCallback(() => setError(null), []);
	useEffect(() => {
		if (notice === null) return;
		const timer = setTimeout(() => setNotice(null), 4000);
		return () => clearTimeout(timer);
	}, [notice]);
	const requestComposerControl = useCallback((target: "model" | "thinking" | "mcp" | null) => {
		setComposerControl((current) => ({ id: current.id + 1, target }));
	}, []);
	const closeSessionStatus = useCallback(() => {
		statusGeneration.current += 1;
		setSessionStatusPanel((current) => current ? { ...current, closing: true } : null);
	}, []);
	useEffect(() => {
		if (!sessionStatusPanel?.closing) return undefined;
		const timer = setTimeout(
			() => setSessionStatusPanel((current) => current?.closing ? null : current),
			reducedMotion ? 0 : 160,
		);
		return () => clearTimeout(timer);
	}, [reducedMotion, sessionStatusPanel?.closing]);
	useEffect(() => {
		let disposed = false;
		let receivedEvent = false;
		const unsubscribe = api.subscribeUpdate((state) => {
			receivedEvent = true;
			if (!disposed) setUpdateState(state);
		});
		void api.getUpdateState()
			.then((state) => {
				if (!disposed && !receivedEvent) setUpdateState(state);
			})
			.catch(() => undefined);
		return () => {
			disposed = true;
			unsubscribe();
		};
	}, [api]);
	const startDesktopUpdate = useCallback(() => {
		void api.startUpdate().catch(reportError);
	}, [api, reportError]);
	const queueToolCleanup = useCallback((sessionIds: readonly string[]) => {
		if (sessionIds.length === 0) return;
		setToolCleanupSessionIds((current) => [...new Set([...current, ...sessionIds])]);
	}, []);
	const handleDirtySessionIdsChange = useCallback((sessionIds: readonly string[]) => {
		setDirtyToolSessionIds((current) => current.join("\0") === sessionIds.join("\0") ? current : sessionIds);
	}, []);
	const handleToolCleanupHandled = useCallback((sessionIds: readonly string[]) => {
		const handled = new Set(sessionIds);
		setToolCleanupSessionIds((current) => current.filter((sessionId) => !handled.has(sessionId)));
	}, []);

	useEffect(() => {
		void api.setWorkspaceEditState({
			dirty: dirtyToolSessionIds.length > 0,
			language: i18n.resolvedLanguage?.startsWith("zh") ? "zh" : "en",
			visibleSessionId,
		}).catch(reportError);
	}, [api, dirtyToolSessionIds.length, i18n.resolvedLanguage, reportError, visibleSessionId]);

	const markSessionRead = useCallback(
		async (sessionId: string): Promise<void> => {
			if (sessionMarkReadRequests.current.has(sessionId)) return;
			if (!store.getSnapshot().sessionsById.get(sessionId)?.unread) return;
			sessionMarkReadRequests.current.add(sessionId);
			try {
				const result = await api.markSessionRead({ sessionId });
				store.upsertSession(result.session);
			} catch (cause) {
				reportError(cause);
			} finally {
				sessionMarkReadRequests.current.delete(sessionId);
			}
		},
		[api, reportError, store],
	);

	const openSession = useCallback(
		async (sessionId: string) => {
			const projectionBeforeOpen = store.getSnapshot();
			const generation = ++openGeneration.current;
			openingSessionId.current = sessionId;
			setError(null);
			store.markResubscribing();
			try {
				const snapshot = await api.openSession({ sessionId });
				if (generation !== openGeneration.current) return snapshot;
				store.applySnapshot(snapshot);
				if (snapshot.session.unread) await markSessionRead(sessionId);
				if (generation !== openGeneration.current) return snapshot;
				localStorage.setItem(activeSessionKey(snapshot.session.mode), sessionId);
				setMessage("Session ready");
				return snapshot;
			} catch (cause) {
				if (generation === openGeneration.current) {
					store.restoreSyncStatusAfterFailedOpen(projectionBeforeOpen);
					const afterFailure = store.getSnapshot();
					if (afterFailure.syncStatus === "resnapshot_required" && projectionBeforeOpen.activeSessionId) {
						try {
							const recovered = await api.openSession({ sessionId: projectionBeforeOpen.activeSessionId });
							if (generation === openGeneration.current) store.applySnapshot(recovered);
						} catch {
							// Keep resnapshot_required so the next server or session event retries recovery.
						}
					}
					reportError(cause);
				}
				throw cause;
			} finally {
				if (generation === openGeneration.current) {
					openingSessionId.current = null;
				}
			}
		},
		[api, markSessionRead, reportError, store],
	);
	const activateBrowserSession = useCallback(
		(sessionId: string) => {
			setDestination("tasks");
			setNewTaskDraft(null);
			setToolsSidebarOpen(true);
			const current = store.getSnapshot();
			const summary = current.sessionsById.get(sessionId);
			if (summary) setMode(summary.mode);
			if (current.activeSessionId === sessionId) return;
			void openSession(sessionId).then(
				(snapshot) => setMode(snapshot.session.mode),
				() => undefined,
			);
		},
		[openSession, store],
	);

	const requestResnapshot = useCallback(
		(sessionId: string) => {
			const existing = resnapshots.current.get(sessionId);
			if (existing) return existing;
			const pending = openSession(sessionId)
				.then(() => undefined)
				.catch(() => undefined)
				.finally(() => {
					if (resnapshots.current.get(sessionId) === pending) resnapshots.current.delete(sessionId);
				});
			resnapshots.current.set(sessionId, pending);
			return pending;
		},
		[openSession],
	);
	const openNotifiedSession = useCallback(
		async (sessionId: string, targetMode: AgentMode) => {
			setMode(targetMode);
			setDestination("tasks");
			try {
				await openSession(sessionId);
				setNewTaskDraft(null);
				newTaskCreateRequest.current = null;
				newTaskTurnRequest.current = null;
			} catch {
				// openSession already reports the error while preserving the current projection.
			}
		},
		[openSession],
	);
	const requestScheduleSnapshot = useCallback(
		(replace = false): Promise<void> => {
			const supervisorEpoch = store.getSnapshot().supervisor.serverEpoch;
			const current = scheduleStore.getSnapshot();
			if (!replace && current.syncStatus === "ready" && current.serverEpoch === supervisorEpoch) {
				return Promise.resolve();
			}
			if (scheduleSnapshotRequest.current) return scheduleSnapshotRequest.current;
			const generation = ++scheduleSubscriptionGeneration.current;
			let pending!: Promise<void>;
			pending = (async () => {
				try {
					if (replace) await api.unsubscribeSchedule().catch(() => undefined);
					const result = await api.subscribeSchedule();
					if (generation === scheduleSubscriptionGeneration.current) scheduleStore.applySnapshot(result.snapshot);
				} catch (cause) {
					if (generation === scheduleSubscriptionGeneration.current) reportError(cause);
				} finally {
					if (scheduleSnapshotRequest.current === pending) scheduleSnapshotRequest.current = null;
				}
			})();
			scheduleSnapshotRequest.current = pending;
			return pending;
		},
		[api, reportError, scheduleStore, store],
	);

	useEffect(() => {
		let active = true;
		void api
			.setScheduleKeepAwake(localStorage.getItem(SCHEDULE_KEEP_AWAKE_KEY) === "true")
			.catch(reportError);
		const unsubscribe = api.subscribe((event) => {
			if (!active) return;
			if (event.type === "open-session") {
				void openNotifiedSession(event.sessionId, event.mode);
				return;
			}
			if (event.type === "interaction-cancelled") {
				store.removeInteraction(event.interactionId);
				return;
			}
			if (event.type === "supervisor") {
				const before = store.getSnapshot();
				store.setSupervisor(event.view);
				if (shouldResnapshotAfterReady(before, event.view)) void requestResnapshot(before.activeSessionId!);
				if (
					event.view.state === "ready" &&
					(before.supervisor.state !== "ready" || before.supervisor.serverEpoch !== event.view.serverEpoch)
				) {
					void requestScheduleSnapshot();
				}
				return;
			}
			const envelope = event.envelope;
			if ("id" in envelope) {
				store.addInteraction(envelope.params.interaction);
				return;
			}
			const before = store.getSnapshot();
			scheduleStore.applyBatch(envelope.params);
			if (scheduleStore.getSnapshot().syncStatus === "resnapshot_required") void requestScheduleSnapshot(true);
			const activeSessionBefore = before.activeSessionId ? before.sessionsById.get(before.activeSessionId) : undefined;
			const deletedInvalidations = envelope.params.events.filter(
				(candidate): candidate is Extract<DomainEvent, { type: "session/invalidated" }> =>
					candidate.type === "session/invalidated" && candidate.reason === "deleted",
			);
			const deletedProjects = envelope.params.events.filter(
				(candidate): candidate is Extract<DomainEvent, { type: "project/invalidated" }> =>
					candidate.type === "project/invalidated" && candidate.reason === "deleted",
			);
			const deletedSessionIds = new Set(deletedInvalidations.map((event) => event.sessionId));
			for (const project of deletedProjects) {
				for (const session of before.sessionsById.values()) {
					if (session.mode === project.mode && session.cwd === project.cwd && session.scheduled === undefined) {
						deletedSessionIds.add(session.sessionId);
					}
				}
			}
			queueToolCleanup([...deletedSessionIds]);
			if (before.activeSessionId === null) {
				for (const updated of envelope.params.events) {
					if (updated.type === "session/updated") store.upsertSession(updated.session);
				}
				for (const deleted of deletedInvalidations) store.removeSession(deleted.sessionId);
				for (const deleted of deletedProjects) store.removeModeProject(deleted.mode, deleted.cwd);
				return;
			}
			const sessionInvalidations = envelope.params.events.filter(
				(candidate): candidate is Extract<DomainEvent, { type: "session/invalidated" }> =>
					candidate.type === "session/invalidated" && candidate.sessionId === before.activeSessionId,
			);
			const invalidation =
				sessionInvalidations.find((candidate) => candidate.reason === "deleted") ?? sessionInvalidations[0];
			const invalidatedSession =
				invalidation?.type === "session/invalidated" ? before.sessionsById.get(invalidation.sessionId) : undefined;
			const projectInvalidations = activeSessionBefore && activeSessionBefore.scheduled === undefined
				? envelope.params.events.filter(
						(candidate): candidate is Extract<DomainEvent, { type: "project/invalidated" }> =>
							candidate.type === "project/invalidated" &&
							candidate.mode === activeSessionBefore.mode &&
							candidate.cwd === activeSessionBefore.cwd,
					)
				: [];
			const projectInvalidation =
				projectInvalidations.find((candidate) => candidate.reason === "deleted") ?? projectInvalidations[0];
			const applyResult = store.applyBatch(envelope.params);
			for (const deleted of deletedInvalidations) store.removeSession(deleted.sessionId);
			for (const deleted of deletedProjects) store.removeModeProject(deleted.mode, deleted.cwd);
			const visibleUnread = envelope.params.events.find(
				(candidate): candidate is Extract<DomainEvent, { type: "session/updated" }> =>
					candidate.type === "session/updated" &&
					openingSessionId.current === null &&
					candidate.session.sessionId === visibleSessionIdRef.current &&
					candidate.session.unread,
			);
			if (visibleUnread) void markSessionRead(visibleUnread.session.sessionId);
			if (
				(invalidation?.type === "session/invalidated" &&
					invalidation.reason === "deleted" &&
					before.activeSessionId === invalidation.sessionId) ||
				(projectInvalidation?.type === "project/invalidated" && projectInvalidation.reason === "deleted")
			) {
				const removedSession = invalidatedSession ?? activeSessionBefore;
				openGeneration.current += 1;
				openingSessionId.current = null;
				if (before.activeSessionId) resnapshots.current.delete(before.activeSessionId);
				newTaskCreateRequest.current = null;
				newTaskTurnRequest.current = null;
				if (removedSession) {
					try {
						if (localStorage.getItem(activeSessionKey(removedSession.mode)) === removedSession.sessionId) {
							localStorage.removeItem(activeSessionKey(removedSession.mode));
						}
					} catch (cause) {
						reportError(cause);
					}
					setMode(removedSession.mode);
					setDestination("tasks");
					setNewTaskDraft(emptyNewTaskDraft(removedSession.mode));
				}
				return;
			}
			if (applyResult === "resnapshot_required") {
				if (openingSessionId.current) return;
				const sessionId = store.getSnapshot().activeSessionId;
				if (sessionId) void requestResnapshot(sessionId);
			}
		});

		void (async () => {
			try {
				store.setSupervisor(await api.getServerState());
				const sessions = await api.listSessions({ limit: 200 });
				await requestScheduleSnapshot();
				if (!active) return;
				store.setSessions(sessions);
				const rememberedSessionId = localStorage.getItem(activeSessionKey("chat"));
				if (rememberedSessionId && sessions.sessions.some((session) => session.mode === "chat" && session.sessionId === rememberedSessionId)) {
					await openSession(rememberedSessionId);
					if (active) setNewTaskDraft(null);
				} else {
					setMessage("Start a new Chat task");
				}
			} catch (cause) {
				if (active) reportError(cause);
			} finally {
				if (active) setBootstrapped(true);
			}
		})();

		return () => {
			active = false;
			openGeneration.current += 1;
			scheduleSubscriptionGeneration.current += 1;
			void api.unsubscribeSchedule().catch(() => undefined);
			unsubscribe();
		};
	}, [api, markSessionRead, openNotifiedSession, openSession, queueToolCleanup, reportError, requestResnapshot, requestScheduleSnapshot, scheduleStore, store]);

	const refreshSessions = async () => {
		store.setSessions(await api.listSessions({ limit: 200 }));
	};

	const setProjectBusy = (key: string, value: boolean) => {
		setBusyProjectKeys((current) => {
			const next = new Set(current);
			if (value) next.add(key);
			else next.delete(key);
			return next;
		});
	};
	const updateProjectPreferences = (
		update: (value: ProjectPreferenceMap) => ProjectPreferenceMap,
	) => {
		setProjectPreferences((current) => {
			const next = update(current);
			try {
				saveProjectPreferences(localStorage, next);
			} catch (cause) {
				reportError(cause);
			}
			return next;
		});
	};
	const renameProject = (group: ProjectSessionGroup, alias: string) => {
		updateProjectPreferences((current) => setProjectAlias(current, group.mode, group.cwd, alias));
	};
	const pinProject = (group: ProjectSessionGroup, pinned: boolean) => {
		updateProjectPreferences((current) => setProjectPinned(current, group.mode, group.cwd, pinned));
	};
	const updateSessionPins = (update: (current: ReadonlySet<string>) => ReadonlySet<string>) => {
		setPinnedSessionIds((current) => {
			const next = update(current);
			if (next === current) return current;
			try {
				saveSessionPins(localStorage, next);
			} catch (cause) {
				reportError(cause);
			}
			return next;
		});
	};
	const pinSession = (session: SessionSummary, pinned: boolean) => {
		updateSessionPins((current) => setSessionPinned(current, session.sessionId, pinned));
	};
	const previewProjectDelete = async (group: ProjectSessionGroup) => {
		try {
			const outcome = await api.previewProjectDelete({ mode: group.mode, cwd: group.cwd });
			if (!outcome.ok) throw outcome.error;
			return outcome.result;
		} catch (cause) {
			throw projectActionError(cause);
		}
	};
	const createEmptySessionInProject = async (projectMode: AgentMode, cwd: string): Promise<void> => {
		const key = projectKey(projectMode, cwd);
		const existing = projectCreateRequests.current.get(key);
		if (existing?.promise) return existing.promise;
		const requestId = existing?.requestId ?? crypto.randomUUID();
		const promise = (async () => {
			setProjectBusy(key, true);
			setError(null);
			try {
				const created = await api.createSession({ requestId, mode: projectMode, cwd });
				setMode(projectMode);
				setDestination("tasks");
				await openSession(created.session.sessionId);
				setNewTaskDraft(null);
				projectCreateRequests.current.delete(key);
				try {
					await refreshSessions();
				} catch (cause) {
					reportError(cause);
				}
			} catch (cause) {
				projectCreateRequests.current.set(key, { requestId });
				reportError(cause);
				throw cause;
			} finally {
				setProjectBusy(key, false);
			}
		})();
		projectCreateRequests.current.set(key, { requestId, promise });
		return promise;
	};
	const createEmptyProjectSession = (group: ProjectSessionGroup): Promise<void> =>
		createEmptySessionInProject(group.mode, group.cwd);
	const deleteProject = async (
		group: ProjectSessionGroup,
		preview: ClientResult<"project/deletePreview">,
	): Promise<void> => {
		const projectSessionIds = [...store.getSnapshot().sessionsById.values()]
			.filter((session) => session.mode === group.mode && session.cwd === group.cwd && session.scheduled === undefined)
			.map((session) => session.sessionId);
		if (projectSessionIds.some((sessionId) => dirtyToolSessionIds.includes(sessionId))) {
			const cause = new Error("Save or close unsaved files before deleting this task or project.");
			reportError(cause);
			throw cause;
		}
		const key = projectKey(group.mode, group.cwd);
		const previousRequest = projectDeleteRequests.current.get(key);
		const requestId = previousRequest?.revision === preview.revision
			? previousRequest.requestId
			: crypto.randomUUID();
		projectDeleteRequests.current.set(key, { requestId, revision: preview.revision });
		setProjectBusy(key, true);
		setError(null);
		try {
			const outcome = await api.deleteProject({
				requestId,
				mode: group.mode,
				cwd: group.cwd,
				expectedRevision: preview.revision,
			});
			if (!outcome.ok) {
				projectDeleteRequests.current.delete(key);
				throw outcome.error;
			}
			projectDeleteRequests.current.delete(key);
			updateSessionPins((current) => {
				const next = new Set(current);
				for (const sessionId of projectSessionIds) next.delete(sessionId);
				return next.size === current.size ? current : next;
			});
			queueToolCleanup(projectSessionIds);
			const before = store.getSnapshot();
			const active = before.activeSessionId ? before.sessionsById.get(before.activeSessionId) : undefined;
			const removedActive = active?.mode === group.mode && active.cwd === group.cwd && active.scheduled === undefined;
			let clearRememberedSession = false;
			try {
				const rememberedId = localStorage.getItem(activeSessionKey(group.mode));
				const remembered = rememberedId ? before.sessionsById.get(rememberedId) : undefined;
				clearRememberedSession =
					remembered?.mode === group.mode &&
					remembered.cwd === group.cwd &&
					remembered.scheduled === undefined;
			} catch (cause) {
				reportError(cause);
			}
			if (removedActive) openGeneration.current += 1;
			store.removeModeProject(group.mode, group.cwd);
			if (clearRememberedSession) {
				try {
					localStorage.removeItem(activeSessionKey(group.mode));
				} catch (cause) {
					reportError(cause);
				}
			}
			updateProjectPreferences((current) => removeProjectPreference(current, group.mode, group.cwd));
			if (removedActive) {
				setMode(group.mode);
				setDestination("tasks");
				setNewTaskDraft(emptyNewTaskDraft(group.mode));
			}
			try {
				await refreshSessions();
			} catch (cause) {
				reportError(cause);
			}
		} catch (cause) {
			const error = projectActionError(cause);
			reportError(error);
			throw error;
		} finally {
			setProjectBusy(key, false);
		}
	};
	const renameSession = async (session: SessionSummary, name: string): Promise<void> => {
		setError(null);
		const previous = sessionRenameRequests.current.get(session.sessionId);
		const requestId = previous?.name === name ? previous.requestId : crypto.randomUUID();
		sessionRenameRequests.current.set(session.sessionId, { name, requestId });
		try {
			await api.renameSession({ sessionId: session.sessionId, requestId, name });
			sessionRenameRequests.current.delete(session.sessionId);
			await refreshSessions();
		} catch (cause) {
			const error = sessionActionError(cause, "rename");
			reportError(error);
			throw error;
		}
	};
	const deleteSession = async (session: SessionSummary): Promise<void> => {
		if (dirtyToolSessionIds.includes(session.sessionId)) {
			const cause = new Error("Save or close unsaved files before deleting this task or project.");
			reportError(cause);
			throw cause;
		}
		setError(null);
		const removedActive = store.getSnapshot().activeSessionId === session.sessionId;
		const requestId = sessionDeleteRequests.current.get(session.sessionId) ?? crypto.randomUUID();
		sessionDeleteRequests.current.set(session.sessionId, requestId);
		try {
			const deleted = await api.deleteSession({ sessionId: session.sessionId, requestId });
			sessionDeleteRequests.current.delete(session.sessionId);
			pinSession(session, false);
			queueToolCleanup([session.sessionId]);
			if (removedActive) {
				openGeneration.current += 1;
				openingSessionId.current = null;
				resnapshots.current.delete(session.sessionId);
			}
			store.removeSession(session.sessionId);
			try {
				if (localStorage.getItem(activeSessionKey(session.mode)) === session.sessionId) {
					localStorage.removeItem(activeSessionKey(session.mode));
				}
			} catch (cause) {
				reportError(cause);
			}
			if (removedActive) {
				setMode(session.mode);
				setDestination("tasks");
				setNewTaskDraft(emptyNewTaskDraft(session.mode));
				newTaskCreateRequest.current = null;
				newTaskTurnRequest.current = null;
			}
			if (deleted.warning) setError(deleted.warning);
			try {
				await refreshSessions();
			} catch (cause) {
				reportError(cause);
			}
		} catch (cause) {
			if (removedActive && rpcErrorCode(cause) === RPC_ERROR_CODES.OPERATION_FAILED) {
				await requestResnapshot(session.sessionId);
			}
			const error = sessionActionError(cause, "delete");
			reportError(error);
			throw error;
		}
	};

	const openVisibleSession = async (sessionId: string) => {
		setDestination("tasks");
		try {
			await openSession(sessionId);
			setNewTaskDraft(null);
			newTaskCreateRequest.current = null;
			newTaskTurnRequest.current = null;
		} catch {
			// openSession already reports the error while preserving the current projection.
		}
	};
	const forkFromReply = async (entryId: string) => {
		const sessionId = state.activeSessionId;
		if (!sessionId) return;
		try {
			const result = await api.forkSession({
				sessionId,
				requestId: crypto.randomUUID(),
				entryId,
			});
			setMessage(t("Forked conversation"));
			await refreshSessions();
			await openVisibleSession(result.session.sessionId);
		} catch (cause) {
			reportError(cause);
		}
	};
	const openScheduledSession = (sessionId: string) => {
		setMode("chat");
		setDestination("tasks");
		void openVisibleSession(sessionId);
	};

	const chooseNewTaskFolder = async () => {
		setDraftBusy(true);
		setError(null);
		try {
			const folder = await api.selectProjectFolder();
			if (folder) {
				setNewTaskDraft((draft) => draft?.mode === mode ? { ...draft, folder } : draft);
			}
		} catch (cause) {
			reportError(cause);
		} finally {
			setDraftBusy(false);
		}
	};
	const chooseCodeProjectFolder = () => api.selectProjectFolder();
	const createCodeProjectFolder = (input: Parameters<MetisDesktopApi["createProjectFolder"]>[0]) =>
		api.createProjectFolder(input);

	const startNewTask = () => {
		setDestination("tasks");
		setError(null);
		setNewTaskDraft(emptyNewTaskDraft(mode));
		newTaskCreateRequest.current = null;
		newTaskTurnRequest.current = null;
	};
	const cancelNewTask = () => {
		setError(null);
		setNewTaskDraft(null);
		newTaskCreateRequest.current = null;
		newTaskTurnRequest.current = null;
	};

	const changeMode = (nextMode: AgentMode) => {
		if (nextMode === mode) return;
		setMode(nextMode);
		setDestination("tasks");
		setError(null);
		const rememberedSessionId = localStorage.getItem(activeSessionKey(nextMode));
		const rememberedSession = rememberedSessionId ? state.sessionsById.get(rememberedSessionId) : undefined;
		if (!rememberedSession || rememberedSession.mode !== nextMode) {
			setNewTaskDraft(emptyNewTaskDraft(nextMode));
			newTaskCreateRequest.current = null;
			newTaskTurnRequest.current = null;
			return;
		}
		void openSession(rememberedSession.sessionId)
			.then(() => {
				setNewTaskDraft(null);
				newTaskCreateRequest.current = null;
				newTaskTurnRequest.current = null;
			})
			.catch(() => {
				setNewTaskDraft(emptyNewTaskDraft(nextMode));
				newTaskCreateRequest.current = null;
				newTaskTurnRequest.current = null;
			});
	};

	const visibleNewTaskDraft = destination === "tasks" && newTaskDraft?.mode === mode ? newTaskDraft : null;

	const submitNewTask = async (draft: NewTaskDraft, input: ComposerSubmission, sessionName?: string) => {
		if (draft.mode === "code" && !draft.folder) return;
		setDraftBusy(true);
		setError(null);
		try {
			let sessionId = draft.sessionId;
			if (!sessionId) {
				const createKey = JSON.stringify({
					mode: draft.mode,
					cwd: draft.folder,
					name: sessionName ?? null,
					permissionMode: draft.permissionMode,
				});
				const createRequest = newTaskCreateRequest.current?.key === createKey
					? newTaskCreateRequest.current
					: { key: createKey, requestId: crypto.randomUUID() };
				newTaskCreateRequest.current = createRequest;
				const created = await api.createSession({
					requestId: createRequest.requestId,
					mode: draft.mode,
					...(draft.folder ? { cwd: draft.folder } : {}),
					...(sessionName ? { name: sessionName } : {}),
					permissionMode: draft.permissionMode,
				});
				sessionId = created.session.sessionId;
				setNewTaskDraft((current) => current?.mode === draft.mode ? { ...current, sessionId } : current);
				newTaskCreateRequest.current = null;
			}
			await refreshSessions();
			await openSession(sessionId);
			const turnKey = JSON.stringify({ sessionId, input: composerRequestKey(input) });
			const turnRequest = newTaskTurnRequest.current?.key === turnKey
				? newTaskTurnRequest.current
				: { key: turnKey, requestId: crypto.randomUUID() };
			newTaskTurnRequest.current = turnRequest;
			await api.startTurn({ sessionId, requestId: turnRequest.requestId, ...composerPayload(input) });
			setNewTaskDraft(null);
			newTaskCreateRequest.current = null;
			newTaskTurnRequest.current = null;
		} catch (cause) {
			reportError(cause);
			throw cause;
		} finally {
			setDraftBusy(false);
		}
	};

	const submitNewTaskDraft = async (input: ComposerSubmission) => {
		if (!visibleNewTaskDraft) return;
		await submitNewTask(visibleNewTaskDraft, input);
	};

	const createScheduleWithMetis = async (cwd: string | null) => {
		const draft = { ...emptyNewTaskDraft("chat"), folder: cwd };
		setMode("chat");
		setDestination("tasks");
		setNewTaskDraft(draft);
		newTaskCreateRequest.current = null;
		newTaskTurnRequest.current = null;
		await submitNewTask(
			draft,
			{ text: ASSISTED_SCHEDULE_PROMPT, attachments: [] },
			t("Set up a scheduled task"),
		);
	};

	const createSkillWithMetis = async (target: SkillCreationTarget) => {
		const draft = { ...emptyNewTaskDraft("chat"), folder: target.cwd };
		const prompt = target.source === "project"
			? `I want to create a project-level Skill in ${target.cwd}. Use the create-skill Skill and ask me for the information you need before creating it.`
			: "I want to create a user-level Skill. Use the create-skill Skill and ask me for the information you need before creating it.";
		setMode("chat");
		setDestination("tasks");
		setNewTaskDraft(draft);
		newTaskCreateRequest.current = null;
		newTaskTurnRequest.current = null;
		await submitNewTask(draft, { text: prompt, attachments: [] });
	};

	const activeSession = state.activeSessionId ? state.sessionsById.get(state.activeSessionId) : undefined;
	const openingSession = openingSessionId.current ? state.sessionsById.get(openingSessionId.current) : undefined;
	const newTaskOpen = visibleNewTaskDraft !== null;
	const visibleActiveSession = destination === "tasks" && activeSession && (activeSession.mode === mode || openingSession?.mode === mode) && !newTaskOpen
		? activeSession
		: undefined;
	const toolsSidebarAvailable = visibleActiveSession !== undefined;
	const running = visibleActiveSession?.state === "running" || (visibleActiveSession !== undefined && state.activeTurnId !== null);
	const serverReady = state.supervisor.state === "ready";
	useEffect(() => {
		statusGeneration.current += 1;
		contextStatusRef.current = null;
		setSessionStatusPanel(null);
		setContextStatus(null);
		requestComposerControl(null);
		setCompactingSession((current) => current?.sessionId === visibleActiveSession?.sessionId ? current : null);
		setPlanPreviewRequest(null);
	}, [requestComposerControl, visibleActiveSession?.sessionId]);
	const skillSessionId = visibleActiveSession?.sessionId ?? visibleNewTaskDraft?.sessionId;
	const shouldListSkills = destination === "tasks" && (newTaskOpen || visibleActiveSession !== undefined);
	useEffect(() => {
		const generation = ++skillListGeneration.current;
		if (!bootstrapped || !serverReady || !shouldListSkills) {
			setSkills([]);
			return;
		}
		setSkills([]);
		void api.listSkills(skillSessionId ? { sessionId: skillSessionId } : { cwd: visibleNewTaskDraft?.folder ?? null })
			.then((result) => {
				if (generation === skillListGeneration.current) setSkills(result.skills);
			})
			.catch((cause) => {
				if (generation !== skillListGeneration.current) return;
				setSkills([]);
				reportError(cause);
			});
		return () => {
			if (generation === skillListGeneration.current) skillListGeneration.current += 1;
		};
	}, [api, bootstrapped, reportError, serverReady, shouldListSkills, skillCatalogEpoch, skillSessionId, visibleNewTaskDraft?.folder]);
	// The new-task page configures the model and thinking effort through the
	// global defaults (new sessions inherit them), so keep the settings view
	// fresh whenever the server is ready and after the settings dialog closes.
	useEffect(() => {
		if (!bootstrapped || !serverReady || settingsOpen) return;
		const generation = ++modelSettingsGeneration.current;
		void api.getModelSettings()
			.then((result) => {
				if (generation === modelSettingsGeneration.current) setModelSettings(result);
			})
			.catch((cause) => {
				if (generation !== modelSettingsGeneration.current) return;
				setModelSettings(null);
				reportError(cause);
			});
		return () => {
			if (generation === modelSettingsGeneration.current) modelSettingsGeneration.current += 1;
		};
	}, [api, bootstrapped, reportError, serverReady, settingsOpen]);
	const visibleMcpSessionId = destination === "tasks" ? visibleActiveSession?.sessionId : undefined;
	useEffect(() => {
		const generation = ++mcpListGeneration.current;
		let timer: ReturnType<typeof setTimeout> | undefined;
		if (!bootstrapped || !serverReady || !visibleMcpSessionId) {
			setMcpServers([]);
			return;
		}
		setMcpServers([]);
		const refresh = () => {
			void api.listMcpServers({ sessionId: visibleMcpSessionId }).then(
				(result) => {
					if (generation !== mcpListGeneration.current) return;
					setMcpServers(result.servers);
					const connecting = result.servers.some((server) => server.effective && server.enabled && server.state === "connecting");
					const reconnecting = result.servers.some((server) => server.effective && server.enabled && server.state === "reconnecting");
					if (connecting || reconnecting) timer = setTimeout(refresh, connecting ? MCP_STATUS_POLL_MS : MCP_RECONNECT_POLL_MS);
				},
				(cause) => {
					if (generation !== mcpListGeneration.current) return;
					setMcpServers([]);
					reportError(cause);
				},
			);
		};
		refresh();
		return () => {
			if (generation === mcpListGeneration.current) mcpListGeneration.current += 1;
			if (timer) clearTimeout(timer);
		};
	}, [api, bootstrapped, reportError, serverReady, visibleMcpSessionId]);
	const interactiveSessionId =
		destination === "tasks" && openingSession?.mode === mode
			? openingSession.sessionId
			: visibleActiveSession?.sessionId ?? visibleNewTaskDraft?.sessionId ?? undefined;
	const visibleInteraction = firstInteractionForSession(
		state.interactionOrder,
		state.interactionsById,
		interactiveSessionId,
	);
	const permissionApproval = visibleInteraction?.kind === "select" &&
		visibleInteraction.presentation === "permission_approval"
		? visibleInteraction
		: undefined;
	const askUserInteraction = visibleInteraction?.kind === "ask_user" ? visibleInteraction : undefined;
	const inlineInteraction = permissionApproval ?? askUserInteraction;
	const latestNotification = [...state.notifications]
		.reverse()
		.find((notification) => notification.sessionId === undefined || notification.sessionId === visibleActiveSession?.sessionId);
	const writableSessionId = visibleActiveSession?.scheduled === undefined ? visibleActiveSession?.sessionId : undefined;
	const {
		collaborationMode: collaborationModeValue,
		collaborationModeBlocked,
		collaborationModeChanging,
		currentProposedPlan,
		planActionsBusy,
		planRevisionTarget,
		submit,
		changeCollaborationMode,
		revisePlan,
		clearPlanRevision,
		startPlan,
		cancelPlan,
	} = useConversationPlanFlow({
		api,
		sessionId: visibleActiveSession?.sessionId,
		writableSessionId,
		running,
		queuedTurnCount: state.queuedTurns.length,
		serverReady,
		syncReady: state.syncStatus === "ready",
		compacting: compactingSession !== null,
		interactionPending: inlineInteraction !== undefined,
		collaborationMode: state.collaborationMode,
		itemOrder: state.itemOrder,
		itemsById: state.itemsById,
		clearError,
		reportError,
	});

	const updateQueuedTurn = async (turn: QueuedTurnView, text: string) => {
		if (!visibleActiveSession) return;
		setError(null);
		try {
			await api.updateQueuedTurn({
				sessionId: visibleActiveSession.sessionId,
				requestId: crypto.randomUUID(),
				queueItemId: turn.queueItemId,
				expectedRevision: turn.revision,
				text,
			});
		} catch (cause) {
			const error = queuedTurnActionError(cause);
			reportError(error);
			throw error;
		}
	};

	const deleteQueuedTurn = async (turn: QueuedTurnView) => {
		if (!visibleActiveSession) return;
		setError(null);
		try {
			await api.deleteQueuedTurn({
				sessionId: visibleActiveSession.sessionId,
				requestId: crypto.randomUUID(),
				queueItemId: turn.queueItemId,
				expectedRevision: turn.revision,
			});
		} catch (cause) {
			const error = queuedTurnActionError(cause);
			reportError(error);
			throw error;
		}
	};

	const sendQueuedTurn = async (turn: QueuedTurnView, delivery: "steer" | "start") => {
		if (!visibleActiveSession) return;
		setError(null);
		try {
			await api.sendQueuedTurn({
				sessionId: visibleActiveSession.sessionId,
				requestId: crypto.randomUUID(),
				queueItemId: turn.queueItemId,
				expectedRevision: turn.revision,
				delivery,
			});
		} catch (cause) {
			const error = queuedTurnActionError(cause);
			reportError(error);
			throw error;
		}
	};

	const interrupt = async () => {
		if (!visibleActiveSession) return;
		try {
			await api.interruptTurn({ sessionId: visibleActiveSession.sessionId, requestId: crypto.randomUUID() });
		} catch (cause) {
			reportError(cause);
			throw cause;
		}
	};

	const loadOlder = async () => {
		if (!visibleActiveSession || !state.nextBeforeItemId || loadingOlder) return;
		setLoadingOlder(true);
		try {
			store.prependItems(await api.readItems({ sessionId: visibleActiveSession.sessionId, beforeItemId: state.nextBeforeItemId, limit: 200 }));
		} catch (cause) {
			reportError(cause);
		} finally {
			setLoadingOlder(false);
		}
	};

	const respond = async (response: InteractionResponseInput) => {
		await api.respondToInteraction(response);
		store.removeInteraction(response.interactionId);
	};

	const changeThinking = async (sessionId: string, selection: AppStoreSnapshot["thinkingSelection"]) => {
		store.setOptimisticThinkingSelection(selection);
		try {
			await api.setThinkingSelection({ sessionId, requestId: crypto.randomUUID(), selection });
		} catch (cause) {
			if (store.getSnapshot().activeSessionId === sessionId) await requestResnapshot(sessionId);
			reportError(cause);
		}
	};

	const changeModel = async (sessionId: string, model: AppStoreSnapshot["availableModels"][number]) => {
		try {
			await api.setModel({
				sessionId,
				requestId: crypto.randomUUID(),
				provider: model.provider,
				modelId: model.modelId,
			});
		} catch (cause) {
			reportError(cause);
		}
	};

	// New sessions inherit the global defaults, so the new-task page edits them
	// directly instead of requiring an existing configuration session.
	const updateGlobalModelDefaults = useCallback(
		async (model: { readonly provider: string; readonly modelId: string } | null, thinkingSelection: ThinkingSelectionView) => {
			try {
				const next = await api.updateModelSettings({
					requestId: crypto.randomUUID(),
					mutation: {
						type: "set_defaults",
						model: model ? { provider: model.provider, modelId: model.modelId } : null,
						thinkingSelection,
					},
				});
				setModelSettings(next);
			} catch (cause) {
				reportError(cause);
			}
		},
		[api, reportError],
	);
	const changeGlobalModel = useCallback(
		(model: ModelOptionView) => {
			void updateGlobalModelDefaults(model, modelSettings?.defaultThinkingSelection ?? "off");
		},
		[modelSettings?.defaultThinkingSelection, updateGlobalModelDefaults],
	);
	const changeGlobalThinking = useCallback(
		(selection: ThinkingSelectionView) => {
			void updateGlobalModelDefaults(modelSettings?.defaultModel ?? null, selection);
		},
		[modelSettings?.defaultModel, updateGlobalModelDefaults],
	);
	const globalAvailableModels = useMemo<readonly ModelOptionView[]>(() => {
		if (!modelSettings) return [];
		return modelSettings.providers
			.filter((provider) => provider.auth.configured)
			.flatMap((provider) =>
				provider.models.map((model) => ({
					provider: model.provider,
					modelId: model.modelId,
					name: model.name,
				})),
			);
	}, [modelSettings]);
	const globalThinkingSelection = modelSettings?.defaultThinkingSelection ?? "off";
	const globalThinkingAvailable = useMemo<ThinkingSelectionView[]>(() => {
		const base: ThinkingSelectionView[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
		return globalThinkingSelection === "ultra" ? [...base, "ultra"] : base;
	}, [globalThinkingSelection]);

	const changePermissionMode = async (sessionId: string, permissionMode: PermissionModeView) => {
		try {
			await api.setPermissionMode({ sessionId, requestId: crypto.randomUUID(), permissionMode });
		} catch (cause) {
			if (store.getSnapshot().activeSessionId === sessionId) await requestResnapshot(sessionId);
			reportError(cause);
			throw cause;
		}
	};

	const configurationSession = visibleActiveSession ?? (
		newTaskOpen && activeSession?.mode === mode ? activeSession : undefined
	);

	const openPlan = useCallback((plan: PlanView) => {
		setPlanPreviewRequest(plan);
		showToolsSidebar();
	}, [showToolsSidebar]);

	const compactBlocked = running || inlineInteraction !== undefined || compactingSession !== null;
	const isCompacting = compactingSession !== null;
	const assistantUsageKey = latestAssistantUsageKey(state.itemOrder, state.itemsById);
	const activeModelKey = state.model ? `${state.model.provider}/${state.model.modelId}` : "";
	const mcpContextKey = mcpServers
		.map((server) =>
			`${server.name}:${server.revision}:${server.effective}:${server.enabled}:${server.state}:${server.toolCount}`,
		)
		.sort()
		.join("|");

	const loadContextStatus = useCallback(async (
		sessionId: string,
		options: { readonly showPanel?: boolean } = {},
	) => {
		const generation = ++statusGeneration.current;
		if (options.showPanel) {
			const cached = contextStatusRef.current;
			setSessionStatusPanel(
				cached?.sessionId === sessionId
					? { sessionId, loading: false, status: cached }
					: { sessionId, loading: true },
			);
		}
		try {
			const status = await api.getSessionStatus({ sessionId });
			if (generation !== statusGeneration.current) return;
			if (store.getSnapshot().activeSessionId !== sessionId) return;
			contextStatusRef.current = status;
			setContextStatus(status);
			setSessionStatusPanel((current) =>
				current?.sessionId === sessionId
					? { sessionId, loading: false, status }
					: current,
			);
		} catch (cause) {
			if (generation !== statusGeneration.current) return;
			if (store.getSnapshot().activeSessionId !== sessionId) return;
			if (options.showPanel) {
				setSessionStatusPanel({
					sessionId,
					loading: false,
					error: cause instanceof Error ? cause.message : "Session status could not be loaded.",
				});
			} else {
				contextStatusRef.current = null;
				setContextStatus(null);
			}
		}
	}, [api, store]);

	useEffect(() => {
		if (!writableSessionId || !serverReady || isCompacting) return;
		void loadContextStatus(writableSessionId);
	}, [
		activeModelKey,
		assistantUsageKey,
		isCompacting,
		loadContextStatus,
		mcpContextKey,
		serverReady,
		skillCatalogEpoch,
		writableSessionId,
	]);
	const { disabledSlashCommands, disabledSlashReasons } = useMemo(() => {
		const commands = new Set<ComposerSlashCommand>();
		const reasons: Partial<Record<ComposerSlashCommand, string>> = {};
		if (!writableSessionId) {
			commands.add("compact");
			commands.add("goal");
			commands.add("plan");
			commands.add("status");
			reasons.compact = "Open a task to use this command";
			reasons.goal = "Open a task to use this command";
			reasons.plan = "Open a task to use this command";
			reasons.status = "Open a task to use this command";
		} else if (compactBlocked) {
			commands.add("compact");
			reasons.compact = compactingSession
				? "Conversation compaction is already running"
				: "Stop the active task before compacting";
		}
		if (writableSessionId && (collaborationModeValue === "plan" || collaborationModeBlocked)) {
			commands.add("plan");
			reasons.plan = currentProposedPlan
				? "Start or cancel the current plan first"
				: collaborationModeValue === "plan"
					? "Plan mode is already active"
					: "Plan mode is unavailable while this task is busy";
		}
		if (!configurationSession && !newTaskOpen) {
			commands.add("model");
			commands.add("thinking");
			reasons.model = "Open a task to use this command";
			reasons.thinking = "Open a task to use this command";
		}
		return { disabledSlashCommands: commands, disabledSlashReasons: reasons };
	}, [collaborationModeBlocked, collaborationModeValue, compactBlocked, compactingSession, configurationSession, currentProposedPlan, writableSessionId]);

	const openSessionStatus = useCallback(async () => {
		if (!writableSessionId) return;
		requestComposerControl(null);
		await loadContextStatus(writableSessionId, { showPanel: true });
	}, [loadContextStatus, requestComposerControl, writableSessionId]);
	const toggleSessionStatus = useCallback(() => {
		if (!writableSessionId) return;
		if (sessionStatusPanel?.sessionId === writableSessionId && !sessionStatusPanel.closing) {
			closeSessionStatus();
			return;
		}
		void openSessionStatus();
	}, [closeSessionStatus, openSessionStatus, sessionStatusPanel, writableSessionId]);

	const compactConversation = useCallback(async () => {
		if (!writableSessionId || compactBlocked) return;
		closeSessionStatus();
		requestComposerControl(null);
		setError(null);
		setNotice(null);
		setCompactingSession({ sessionId: writableSessionId, startedAt: new Date().toISOString() });
		try {
			const result = await api.compactSession({ sessionId: writableSessionId, requestId: crypto.randomUUID() });
			if (result.message) setNotice(result.message);
		} catch (cause) {
			reportError(cause);
		} finally {
			setCompactingSession((current) => current?.sessionId === writableSessionId ? null : current);
		}
	}, [api, closeSessionStatus, compactBlocked, reportError, requestComposerControl, writableSessionId]);

	const mutateSessionGoal = useCallback(
		async (input: { objective?: string; status?: "active" | "paused" } | { clear: true }) => {
			if (!writableSessionId) return;
			try {
				if ("clear" in input) {
					await api.clearSessionGoal({ sessionId: writableSessionId, requestId: crypto.randomUUID() });
					return;
				}
				await api.setSessionGoal({
					sessionId: writableSessionId,
					requestId: crypto.randomUUID(),
					...(input.objective === undefined ? {} : { objective: input.objective }),
					...(input.status === undefined ? {} : { status: input.status }),
				});
			} catch (cause) {
				reportError(cause);
			}
		},
		[api, reportError, writableSessionId],
	);

	const handleGoalCommand = useCallback(
		async (command: GoalSlashCommand) => {
			if (!writableSessionId) return;
			if (command.kind === "usage") {
				setNotice(GOAL_SLASH_USAGE);
				return;
			}
			if (command.kind === "clear") {
				await mutateSessionGoal({ clear: true });
				return;
			}
			if (command.kind === "pause") {
				await mutateSessionGoal({ status: "paused" });
				return;
			}
			if (command.kind === "resume") {
				await mutateSessionGoal({ status: "active" });
				return;
			}
			await mutateSessionGoal({ objective: command.objective });
		},
		[mutateSessionGoal, writableSessionId],
	);

	const handleSlashCommand = useCallback(async (command: ComposerSlashCommand) => {
		if (command === "status") {
			await openSessionStatus();
			return;
		}
		closeSessionStatus();
		if (command === "compact") {
			await compactConversation();
			return;
		}
		if (command === "goal") {
			setNotice(GOAL_SLASH_USAGE);
			return;
		}
		if (command === "plan") {
			if (collaborationModeValue !== "plan") await changeCollaborationMode("plan");
			return;
		}
		requestComposerControl(command);
	}, [changeCollaborationMode, closeSessionStatus, collaborationModeValue, compactConversation, openSessionStatus, requestComposerControl]);
	const modelControl = configurationSession ? (
		<ModelSelector
			available={state.availableModels}
			commandRequest={{ id: composerControl.id, open: composerControl.target === "model" }}
			disabled={!serverReady}
			onChange={(model) => changeModel(configurationSession.sessionId, model)}
			value={state.model}
		/>
	) : newTaskOpen ? (
		<ModelSelector
			available={globalAvailableModels}
			commandRequest={{ id: composerControl.id, open: composerControl.target === "model" }}
			disabled={!serverReady}
			onChange={changeGlobalModel}
			value={modelSettings?.defaultModel ?? undefined}
		/>
	) : undefined;

	const thinkingControl = configurationSession ? (
		<ThinkingSelector
			actualThinkingLevel={state.actualThinkingLevel}
			available={state.availableThinkingSelections}
			commandRequest={{ id: composerControl.id, open: composerControl.target === "thinking" }}
			disabled={!serverReady}
			onChange={(selection) => void changeThinking(configurationSession.sessionId, selection)}
			reducedMotion={reducedMotion}
			value={state.thinkingSelection}
		/>
	) : newTaskOpen ? (
		<ThinkingSelector
			actualThinkingLevel={globalThinkingSelection === "ultra" ? "max" : globalThinkingSelection}
			available={globalThinkingAvailable}
			commandRequest={{ id: composerControl.id, open: composerControl.target === "thinking" }}
			disabled={!serverReady}
			onChange={changeGlobalThinking}
			reducedMotion={reducedMotion}
			value={globalThinkingSelection}
		/>
	) : undefined;
	const permissionSessionId = visibleNewTaskDraft?.sessionId ?? visibleActiveSession?.sessionId;
	const permissionSession = permissionSessionId ? state.sessionsById.get(permissionSessionId) : undefined;
	const permissionSessionOpen = permissionSessionId === undefined || state.activeSessionId === permissionSessionId;
	const permissionSessionRunning = permissionSession?.state === "running" ||
		(permissionSessionId !== undefined && state.activeSessionId === permissionSessionId && state.activeTurnId !== null);
	const draftCreatePending = visibleNewTaskDraft?.sessionId === null && newTaskCreateRequest.current !== null;
	const permissionControl = visibleNewTaskDraft ? (
		<PermissionSelector
			disabled={
				draftBusy ||
				!serverReady ||
				draftCreatePending ||
				!permissionSessionOpen ||
				permissionSessionRunning ||
				visibleInteraction !== undefined
			}
			onChange={(permissionMode) => permissionSessionId
				? changePermissionMode(permissionSessionId, permissionMode)
				: setNewTaskDraft((draft) => draft?.mode === mode ? { ...draft, permissionMode } : draft)}
			value={permissionSessionId && permissionSessionOpen ? state.permissionMode : visibleNewTaskDraft.permissionMode}
		/>
	) : visibleActiveSession ? (
		<PermissionSelector
			disabled={!serverReady || running || visibleInteraction !== undefined}
			onChange={(permissionMode) => changePermissionMode(visibleActiveSession.sessionId, permissionMode)}
			value={state.permissionMode}
		/>
	) : undefined;
	const collaborationControl = visibleActiveSession && collaborationModeValue === "plan" ? (
		<div className="collaboration-mode-control">
			<span aria-hidden="true" className="collaboration-mode-separator" />
			<button
				aria-label={t("Exit Plan mode")}
				className="collaboration-mode-indicator"
				disabled={collaborationModeBlocked}
				onClick={() => void changeCollaborationMode("default").catch(() => undefined)}
				type="button"
			>
				<span aria-hidden="true" className="collaboration-mode-icon">
					<Lightbulb className="collaboration-mode-active-icon" size={14} />
					<XCircle className="collaboration-mode-exit-icon" size={14} weight="fill" />
				</span>
				<span>{t("Plan")}</span>
			</button>
		</div>
	) : undefined;
	const planRevisionChip = planRevisionTarget ? (
		<div className="composer-plan-context">
			<span className="composer-plan-revision-chip">
				{t("Revise plan")}: {planRevisionTarget.title} · r{planRevisionTarget.revision}
			</span>
			<button aria-label={t("Remove revision context")} onClick={clearPlanRevision} type="button">
				×
			</button>
		</div>
	) : null;
	const connectedMcpServers = mcpServers.filter((server) => server.effective && server.enabled && server.state === "connected");
	const mcpConnectionState = mcpServers.some((server) =>
		server.effective && server.enabled && (
			server.state === "auth_required" ||
			server.state === "error" ||
			(server.state === "reconnecting" && Boolean(server.lastError))
		)
	)
		? "failed" as const
		: mcpServers.some((server) => server.effective && server.enabled && (server.state === "connecting" || server.state === "reconnecting"))
			? "connecting" as const
			: undefined;
	const openMcpManagement = () => {
		setPluginSection("mcp");
		setDestination("skills");
	};
	const pickAttachmentFiles = async () => {
		try {
			return await api.selectAttachmentFiles();
		} catch (cause) {
			reportError(cause);
			return [];
		}
	};
	const openSettings = useCallback(() => {
		settingsReturnFocusRef.current = document.querySelector<HTMLElement>(".account-menu-trigger") ?? document.activeElement as HTMLElement | null;
		setSettingsOpen(true);
	}, []);
	const closeSettings = useCallback(() => {
		setSettingsOpen(false);
		requestAnimationFrame(() => settingsReturnFocusRef.current?.focus());
	}, []);
	const deleteScheduledTask = useCallback(async (input: Parameters<MetisDesktopApi["deleteSchedule"]>[0]) => {
		const result = await api.deleteSchedule(input);
		scheduleStore.removeTask(result.taskId);
		setSelectedScheduleTaskId((current) => current === result.taskId ? null : current);
		return result;
	}, [api, scheduleStore]);

	return (
		<>
		<div
			aria-hidden={settingsOpen || undefined}
			className={`app-shell${sessionsSidebarOpen ? "" : " sessions-sidebar-collapsed"}`}
			inert={settingsOpen || undefined}
			style={{ "--sidebar-width": `${sessionSidebarWidth}px` } as CSSProperties}
		>
			{sessionsSidebarOpen && <SessionSidebar
				busy={!bootstrapped || draftBusy || !serverReady}
				destination={destination}
				mode={mode}
				newTaskOpen={newTaskOpen}
				onCreateProjectSession={createEmptyProjectSession}
				onDeleteProject={deleteProject}
				platform={api.platform}
				onDeleteSchedule={deleteScheduledTask}
				onDeleteSession={deleteSession}
				onModeChange={changeMode}
				onNewTask={startNewTask}
				onOpen={openVisibleSession}
				onPinSession={pinSession}
				onPinProject={pinProject}
				onPreviewProjectDelete={previewProjectDelete}
				onRenameProject={renameProject}
					onRenameSession={renameSession}
					onSettings={openSettings}
					onUpdate={startDesktopUpdate}
					onSkills={() => { setPluginSection("skills"); setDestination("skills"); }}
					onSchedules={() => { setDestination("schedules"); setSelectedScheduleTaskId(null); }}
					onOpenSchedule={(taskId) => { setDestination("schedules"); setSelectedScheduleTaskId(taskId); }}
				onToggle={() => setSessionsSidebarOpen(false)}
				onWidthChange={updateSessionSidebarWidth}
				preferences={projectPreferences}
				pinnedSessionIds={pinnedSessionIds}
					projectBusy={(group) => busyProjectKeys.has(projectKey(group.mode, group.cwd))}
					scheduleTasks={scheduleState.taskOrder.map((id) => scheduleState.tasksById.get(id)).filter((task): task is ScheduleTaskView => task !== undefined)}
					selectedScheduleTaskId={selectedScheduleTaskId}
					state={state}
					updateState={updateState}
				width={sessionSidebarWidth}
			/>}
			<main
				className={`workspace${toolsSidebarAvailable && toolsSidebarOpen ? " tools-sidebar-open" : ""}`}
				style={{ "--tool-sidebar-width": `${toolsSidebarWidth}px` } as CSSProperties}
			>
				<div className="workspace-titlebar-actions">
					{!sessionsSidebarOpen && (
						<button aria-label={t("Show sessions sidebar")} onClick={() => setSessionsSidebarOpen(true)} type="button">
							<SidebarSimple aria-hidden="true" size={17} />
						</button>
					)}
					{toolsSidebarAvailable && <button
						aria-label={t(toolsSidebarOpen ? "Hide tools sidebar" : "Show tools sidebar")}
						aria-pressed={toolsSidebarOpen}
						className="details-sidebar-toggle"
						onClick={() => {
							if (toolsSidebarOpen) setToolsSidebarOpen(false);
							else showToolsSidebar();
						}}
						type="button"
					>
						<SidebarSimple aria-hidden="true" size={17} />
					</button>}
				</div>
				{visibleActiveSession && <WorkspaceSessionHeader
					deleteDisabled={running || visibleInteraction !== undefined}
					disabled={!serverReady || draftBusy}
					displayName={sessionDisplayTitle(visibleActiveSession)}
					onCopy={(displayName) => api.writeClipboardText({ text: displayName })}
					onDelete={deleteSession}
					onPin={pinSession}
					onRename={renameSession}
					pinned={pinnedSessionIds.has(visibleActiveSession.sessionId)}
					session={visibleActiveSession}
				/>}
				{state.supervisor.state === "failed" && (
					<div className="server-banner" role="alert">
						<span>{t(state.supervisor.failure || "App Server could not recover.")}</span>
						<button onClick={() => void api.retryServer().catch(reportError)} type="button">{t("Retry")}</button>
					</div>
				)}
				{state.supervisor.state === "restarting" && (
					<div className="server-banner" role="status">{t("App Server is recovering. Your saved session is safe.")}</div>
				)}
				{!bootstrapped ? null : destination === "skills" ? (
					<PluginsPanel api={api} initialSection={pluginSection} onCreateSkillWithMetis={createSkillWithMetis} onSkillsChanged={() => setSkillCatalogEpoch((value) => value + 1)} preferences={projectPreferences} serverReady={serverReady} state={state} />
				) : destination === "schedules" && mode === "chat" ? (
					<ScheduledTasksPanel api={api} onCreateWithMetis={createScheduleWithMetis} onOpenSession={openScheduledSession} onSelectTask={setSelectedScheduleTaskId} selectedTaskId={selectedScheduleTaskId} serverReady={serverReady} sessions={state.sessionOrder.map((id) => state.sessionsById.get(id)).filter((session): session is SessionSummary => session !== undefined)} store={scheduleStore} />
				) : newTaskOpen && mode === "code" ? (
					<CodeProjectSetup
						busy={draftBusy || !serverReady}
						onCancel={cancelNewTask}
						onChooseExisting={chooseCodeProjectFolder}
						onChooseLocation={chooseCodeProjectFolder}
						onCreateProject={createCodeProjectFolder}
						onGetDefaultLocation={api.getDefaultProjectLocation}
						onOpenProject={(cwd) => createEmptySessionInProject("code", cwd)}
						onPickFiles={pickAttachmentFiles}
						onResolveDroppedFiles={api.resolveDroppedFiles}
					/>
				) : newTaskOpen ? (
					<NewTaskHome
						busy={draftBusy || !serverReady}
						commandRequest={{ id: composerControl.id, open: composerControl.target === "mcp" }}
						disabledSlashCommands={disabledSlashCommands}
						disabledSlashReasons={disabledSlashReasons}
						folder={visibleNewTaskDraft.folder}
						folderLocked={visibleNewTaskDraft.sessionId !== null}
						mode={mode}
						modelControl={modelControl}
						permissionControl={permissionControl}
						onChooseFolder={chooseNewTaskFolder}
						onManageMcp={openMcpManagement}
						onManageSkills={() => { setPluginSection("skills"); setDestination("skills"); }}
						onPickFiles={pickAttachmentFiles}
						onResolveDroppedFiles={api.resolveDroppedFiles}
						reducedMotion={reducedMotion}
						onSlashCommand={handleSlashCommand}
						onSubmit={submitNewTaskDraft}
						skills={skills}
						thinkingControl={thinkingControl}
					/>
				) : visibleActiveSession ? (
					<div className="workspace-body">
						<div className="conversation-column">
							<RecoveryBanner session={visibleActiveSession} />
							<Transcript
								activeTurnId={state.activeTurnId}
								activeTurnStartedAt={state.activeTurnId ? state.turnsById.get(state.activeTurnId)?.startedAt : undefined}
								appearance={visibleActiveSession.mode}
								autoLoadOlder
								hasOlder={state.nextBeforeItemId !== null}
								itemIds={state.itemOrder}
								itemsById={state.itemsById}
								loadingOlder={loadingOlder}
								onCancelPlan={(plan) => void cancelPlan(plan)}
								onCopy={(text) => void api.writeClipboardText({ text }).catch(reportError)}
								onFork={forkFromReply}
								onLoadOlder={loadOlder}
								onOpenDeliveredFile={(fileId, action) => void api.openDeliveredFile({ sessionId: visibleActiveSession.sessionId, fileId, action }).catch(reportError)}
								onOpenPlan={openPlan}
								onPreviewDeliveredFile={handlePreviewDeliveredFile}
								onRevisePlan={revisePlan}
								onStartPlan={(plan) => void startPlan(plan)}
								planActionsBusy={planActionsBusy}
							/>
							{compactingSession?.sessionId === visibleActiveSession.sessionId && (
								<TurnRuntimeStatus items={[]} running startedAt={compactingSession.startedAt} variant="compaction" />
							)}
								<Composer
									appearance={visibleActiveSession.mode}
									collaborationControl={collaborationControl}
									contextControl={planRevisionChip}
									contextUsageExpanded={sessionStatusPanel?.sessionId === visibleActiveSession.sessionId && !sessionStatusPanel.closing}
									contextUsagePercent={contextStatus && contextStatus.sessionId === visibleActiveSession.sessionId
										? contextUsagePercent(contextStatus)
										: null}
									onOpenContextUsage={writableSessionId ? toggleSessionStatus : undefined}
								commandPanel={sessionStatusPanel?.sessionId === visibleActiveSession.sessionId ? <SessionStatusPanel closing={sessionStatusPanel.closing} error={sessionStatusPanel.error} loading={sessionStatusPanel.loading} onClose={closeSessionStatus} status={sessionStatusPanel.status} /> : undefined}
								commandRequest={{ id: composerControl.id, open: composerControl.target === "mcp" }}
								disabled={!serverReady || state.syncStatus !== "ready" || compactingSession !== null || collaborationModeChanging}
								disabledSlashCommands={disabledSlashCommands}
								disabledSlashReasons={disabledSlashReasons}
								interactionControl={inlineInteraction ? <InteractionHost interaction={inlineInteraction} key={inlineInteraction.interactionId} onRespond={respond} /> : undefined}
								goalControl={
									<GoalBar
										goal={state.goal}
										onClear={() => void mutateSessionGoal({ clear: true })}
										onPause={() => void mutateSessionGoal({ status: "paused" })}
										onResume={() => void mutateSessionGoal({ status: "active" })}
									/>
								}
								key={visibleActiveSession.sessionId}
								mcpConnectionState={mcpConnectionState}
								mcpServers={connectedMcpServers}
								modelControl={modelControl}
								onGoalCommand={handleGoalCommand}
								onInterrupt={interrupt}
								onManageMcp={openMcpManagement}
								onManageSkills={() => { setPluginSection("skills"); setDestination("skills"); }}
								onPickFiles={pickAttachmentFiles}
								onResolveDroppedFiles={api.resolveDroppedFiles}
								onSlashCommand={handleSlashCommand}
								onSubmit={submit}
								permissionControl={permissionControl}
								placeholder={t(
									planRevisionTarget
										? "Describe what should change in this plan…"
										: running || state.queuedTurns.length > 0
											? "Add a queued message…"
											: "Write a message…",
								)}
								queuedTurnControl={<QueuedTurnList disabled={!serverReady || state.syncStatus !== "ready" || compactingSession !== null} onDelete={deleteQueuedTurn} onSend={sendQueuedTurn} onUpdate={updateQueuedTurn} running={running} turns={state.queuedTurns} />}
								queueing={state.queuedTurns.length > 0}
								running={running}
								skills={skills}
								taskListEpoch={state.serverEpoch}
								tasks={state.tasks}
								thinkingControl={thinkingControl}
							/>
						</div>
					</div>
				) : null}
				<ToolsSidebar
					activeSession={visibleActiveSession ?? null}
					api={api}
					cleanupSessionIds={toolCleanupSessionIds}
					mode={mode}
					onActivateSession={activateBrowserSession}
					onClose={() => setToolsSidebarOpen(false)}
					onCleanupSessionIdsHandled={handleToolCleanupHandled}
					onDirtySessionIdsChange={handleDirtySessionIdsChange}
					onError={reportError}
					onWidthChange={updateToolsSidebarWidth}
					open={toolsSidebarAvailable && toolsSidebarOpen && !settingsOpen}
					planPreviewRequest={planPreviewRequest}
					preferredWidth={toolsSidebarPreferredWidth}
					previewRequest={previewRequest}
					store={store}
					theme={resolvedTheme}
					width={toolsSidebarWidth}
				/>
					<div className="sr-only" aria-live="polite">{t(error || notice || latestNotification?.message || message)}</div>
					{error && <div className="toast toast-error" role="alert">{t(error)}</div>}
					{!error && notice && <div className="toast" role="status">{t(notice)}</div>}
					{latestNotification && !error && !notice && <div className="toast" role="status">{t(latestNotification.message)}</div>}
			</main>
			<InteractionHost interaction={inlineInteraction ? undefined : visibleInteraction} key={inlineInteraction ? "none" : visibleInteraction?.interactionId ?? "none"} onRespond={respond} />
		</div>
		{settingsOpen ? (
			<SettingsDialog
				api={api}
				generalPreferences={generalPreferences}
				onClose={closeSettings}
				onGeneralPreferencesChange={setGeneralPreferences}
				onThemeChange={setTheme}
				serverReady={serverReady}
				theme={theme}
			/>
		) : null}
		</>
	);
}
