import {
	type AgentMode,
	type InteractionResponseInput,
	type InteractionView,
	type ItemView,
	type McpServerSummaryView,
	type ModelOptionView,
	type ModelSettingsView,
	type PermissionPresetView,
	type PlanView,
	type QueuedTurnView,
	RPC_ERROR_CODES,
	type ScheduleTaskView,
	type SessionDeliveredFileView,
	type SessionStatusView,
	type SessionSummary,
	type SkillSummaryView,
	type ThinkingSelectionView,
} from "@metis/app-protocol";
import { ArrowLeft, ArrowRight, Lightbulb, SidebarSimple, XCircle } from "@phosphor-icons/react";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopApiEvent, DesktopUpdateState, MetisDesktopApi } from "../../shared/desktop-api.ts";
import type { ConversationSubmission } from "../composer-submission.ts";
import { contextUsagePercent } from "../context-usage.ts";
import {
	applyGeneralPreferencesToDocument,
	loadGeneralPreferences,
	resolveReducedMotion,
	saveGeneralPreferences,
} from "../general-preferences.ts";
import { GOAL_SLASH_USAGE, type GoalSlashCommand } from "../goal-slash.ts";
import { useAppStore } from "../hooks/use-app-store.ts";
import { useConversationPlanFlow } from "../hooks/use-conversation-plan-flow.ts";
import { useScheduleStore } from "../hooks/use-schedule-store.ts";
import { useSessionWorkspace } from "../hooks/use-session-workspace.ts";
import { animateNewTaskComposer } from "../new-task-composer-transition.ts";
import { rpcErrorCode } from "../rpc-error.ts";
import { SessionWorkspaceWorkflow, sessionProjectKey, type NewTaskDraft } from "../session-workspace-workflow.ts";
import type { AppStore, AppStoreSnapshot } from "../store/app-store.ts";
import { ScheduleStore } from "../store/schedule-store.ts";
import { type AppTheme, applyThemeToDocument, loadTheme, resolveTheme, saveTheme, watchSystemTheme } from "../theme.ts";
import type { AskUserDraft } from "./AskUserPanel.tsx";
import { CodeProjectSetup } from "./CodeProjectSetup.tsx";
import { Composer, type ComposerPrefillRequest, type ComposerSubmission } from "./Composer.tsx";
import { GoalBar } from "./GoalBar.tsx";
import { InteractionHost } from "./InteractionHost.tsx";
import { ModelSelector } from "./ModelSelector.tsx";
import { NewTaskHome, recentProjectsFromGroups } from "./NewTaskHome.tsx";
import { PermissionSelector } from "./PermissionSelector.tsx";
import { PluginsPanel } from "./PluginsPanel.tsx";
import { FileSelectionProvider } from "./preview/FileSelectionContext.tsx";
import type { UniversalPreviewTarget } from "./preview/UniversalFilePreviewer.tsx";
import { QueuedTurnList } from "./QueuedTurnList.tsx";
import { RecoveryBanner } from "./RecoveryBanner.tsx";
import { ReleaseNotesPopover } from "./ReleaseNotesPopover.tsx";
import { HomeProjectPicker } from "./HomeProjectPicker.tsx";
import { SCHEDULE_KEEP_AWAKE_KEY, ScheduledTasksPanel } from "./ScheduledTasksPanel.tsx";
import {
	buildSessionTree,
	clampSessionSidebarPreferredWidth,
	clampSessionSidebarWidth,
	type ProjectSessionGroup,
	SessionSidebar,
	type SessionSidebarState,
	type SidebarDestination,
	sessionSidebarDefaultWidth,
} from "./SessionSidebar.tsx";
import { SessionStatusPanel } from "./SessionStatusPanel.tsx";
import { SettingsDialog } from "./SettingsDialog.tsx";
import type { SkillCreationTarget } from "./SkillCreationDialog.tsx";
import type { ComposerSlashCommand } from "./SlashCommandMenu.tsx";
import { SystemNotice, systemErrorNotice, type SystemNoticeTone } from "./SystemNotice.tsx";
import { ThinkingSelector } from "./ThinkingSelector.tsx";
import { SessionWorkspaceView } from "./SessionWorkspace.tsx";
import { Transcript } from "./Transcript.tsx";
import { TurnRuntimeStatus } from "./TurnRuntimeStatus.tsx";
import { WorkspaceSessionHeader } from "./WorkspaceSessionHeader.tsx";

interface AppProps {
	readonly api: MetisDesktopApi;
	readonly store: AppStore;
}

type WindowsNavigationLocation =
	| { readonly view: "settings" }
	| { readonly view: "tasks"; readonly mode: AgentMode; readonly sessionId: string | null }
	| { readonly view: "skills"; readonly mode: AgentMode; readonly section: "skills" | "mcp" }
	| { readonly view: "schedules"; readonly mode: AgentMode; readonly taskId: string | null };

const ASSISTED_SCHEDULE_PROMPT =
	"I want to set up a scheduled task. Briefly explain how scheduled tasks work in Metis, then ask me a few concise questions to determine what it should do, when it should run, and whether it should use an available Skill. Do not create the task until I confirm the details.";
const MCP_STATUS_POLL_MS = 500;
const MCP_RECONNECT_POLL_MS = 4_000;

interface CodeProjectSetupRequest {
	readonly draft: NewTaskDraft;
	readonly generation: number;
}

interface TransientSystemNotice {
	readonly tone: SystemNoticeTone;
	readonly title: string;
	readonly message?: string;
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

const SESSION_SIDEBAR_WIDTH_KEY = "metis.session-sidebar-width.v1";
const selectSidebarRevision = (snapshot: AppStoreSnapshot) => snapshot.sidebarRevision;

function loadSessionSidebarPreferredWidth(): number {
	try {
		const value = Number.parseInt(localStorage.getItem(SESSION_SIDEBAR_WIDTH_KEY) ?? "", 10);
		if (!Number.isInteger(value)) return sessionSidebarDefaultWidth();
		return clampSessionSidebarPreferredWidth(value);
	} catch {
		return sessionSidebarDefaultWidth();
	}
}

export function App({ api, store }: AppProps) {
	const { i18n, t } = useTranslation();
	const state = useAppStore(store);
	const sidebarRevision = useAppStore(store, selectSidebarRevision);
	const sidebarState = useMemo<SessionSidebarState>(
		() => ({
			sessionsById: state.sessionsById,
			sessionOrder: state.sessionOrder,
			activeSessionId: state.activeSessionId,
			activeTurnId: state.activeTurnId,
			interactionsById: state.interactionsById,
			interactionOrder: state.interactionOrder,
		}),
		[
			sidebarRevision,
			state.activeSessionId,
			state.activeTurnId,
			state.interactionOrder,
			state.interactionsById,
			state.sessionOrder,
			state.sessionsById,
		],
	);
	const scheduleStoreRef = useRef<ScheduleStore | null>(null);
	if (!scheduleStoreRef.current) scheduleStoreRef.current = new ScheduleStore();
	const scheduleStore = scheduleStoreRef.current;
	const scheduleState = useScheduleStore(scheduleStore);
	const workspaceEventObserver = useRef<(event: DesktopApiEvent) => void>(() => undefined);
	const workspaceVisibleSession = useRef<string | null>(null);
	const workspaceWorkflowRef = useRef<SessionWorkspaceWorkflow | null>(null);
	if (!workspaceWorkflowRef.current) {
		workspaceWorkflowRef.current = new SessionWorkspaceWorkflow({
			api,
			store,
			storage: localStorage,
			getVisibleSessionId: () => workspaceVisibleSession.current,
			onDesktopEvent: (event) => workspaceEventObserver.current(event),
		});
	}
	const workspaceWorkflow = workspaceWorkflowRef.current;
	const workspaceState = useSessionWorkspace(workspaceWorkflow);
	const mode = workspaceState.mode;
	const newTaskDraft = workspaceState.draft;
	const bootstrapped = workspaceState.bootstrapped;
	const draftBusy = workspaceState.draftBusy;
	const [destination, setDestination] = useState<SidebarDestination>("tasks");
	const askUserDrafts = useRef(new Map<string, AskUserDraft>());
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [codeProjectSetupOpen, setCodeProjectSetupOpen] = useState(false);
	const codeProjectSetupGeneration = useRef(0);
	const codeProjectSetupRequest = useRef<CodeProjectSetupRequest | null>(null);
	const settingsReturnFocusRef = useRef<HTMLElement | null>(null);
	const [selectedScheduleTaskId, setSelectedScheduleTaskId] = useState<string | null>(null);
	const projectPreferences = workspaceState.projectPreferences;
	const pinnedSessionIds = workspaceState.pinnedSessionIds;
	const [sessionsSidebarOpen, setSessionsSidebarOpen] = useState(true);
	const [sessionSidebarPreferredWidth, setSessionSidebarPreferredWidth] = useState(loadSessionSidebarPreferredWidth);
	const [sessionSidebarWidth, setSessionSidebarWidth] = useState(() => clampSessionSidebarWidth(sessionSidebarPreferredWidth));
	const [knowledgeRequest, setKnowledgeRequest] = useState<{ id: number; sessionId: string }>();
	const [previewRequest, setPreviewRequest] = useState<UniversalPreviewTarget | null>(null);
	const [planPreviewRequest, setPlanPreviewRequest] = useState<PlanView | null>(null);
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
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [skills, setSkills] = useState<readonly SkillSummaryView[]>([]);
	const [mcpServers, setMcpServers] = useState<readonly McpServerSummaryView[]>([]);
	const [pluginSection, setPluginSection] = useState<"skills" | "mcp">("skills");
	const [navigationBack, setNavigationBack] = useState<WindowsNavigationLocation[]>([]);
	const [navigationForward, setNavigationForward] = useState<WindowsNavigationLocation[]>([]);
	const [navigationBusy, setNavigationBusy] = useState(false);
	const [skillCatalogEpoch, setSkillCatalogEpoch] = useState(0);
	const [message, setMessage] = useState("Starting Metis…");
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [updateNotice, setUpdateNotice] = useState<TransientSystemNotice | null>(null);
	const [conversationPrefillRequest, setConversationPrefillRequest] = useState<ComposerPrefillRequest>();
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
	const dirtyToolSessionIds = [...workspaceState.dirtySessionIds];
	const toolCleanupSessionIds = workspaceState.cleanupSessionIds;
	const [checkingUpdate, setCheckingUpdate] = useState(false);
	const [updateCheckFailure, setUpdateCheckFailure] = useState<"failed" | "unsupported" | null>(null);
	const updateCheckTask = useRef<Promise<void> | null>(null);
	const [updateState, setUpdateState] = useState<DesktopUpdateState>({ status: "unavailable" });
	const [fullscreen, setFullscreen] = useState(false);
	const currentNavigationLocation = useMemo<WindowsNavigationLocation>(() => {
		if (settingsOpen) return { view: "settings" };
		if (destination === "skills") return { view: "skills", mode, section: pluginSection };
		if (destination === "schedules") return { view: "schedules", mode, taskId: selectedScheduleTaskId };
		return { view: "tasks", mode, sessionId: newTaskDraft ? null : state.activeSessionId };
	}, [destination, mode, newTaskDraft, pluginSection, selectedScheduleTaskId, settingsOpen, state.activeSessionId]);
	const rememberCurrentNavigation = useCallback(() => {
		if (api.platform !== "win32") return;
		setNavigationBack((entries) => {
			const previous = entries.at(-1);
			return previous && JSON.stringify(previous) === JSON.stringify(currentNavigationLocation)
				? entries
				: [...entries.slice(-49), currentNavigationLocation];
		});
		setNavigationForward([]);
	}, [api.platform, currentNavigationLocation]);
	useEffect(() => {
		let cancelled = false;
		if (api.isFullScreen) {
			void api.isFullScreen().then((isFull) => {
				if (!cancelled) setFullscreen(isFull);
			}).catch(() => undefined);
		}
		const unsubscribe = api.subscribeFullScreen?.((isFull) => {
			if (!cancelled) setFullscreen(isFull);
		});
		return () => {
			cancelled = true;
			unsubscribe?.();
		};
	}, [api]);
	const mcpListGeneration = useRef(0);
	const modelSettingsGeneration = useRef(0);
	const handlePreviewDeliveredFile = useCallback(
		(file: SessionDeliveredFileView) => {
			if (!state.activeSessionId) return;
			setPreviewRequest({
				source: "delivered",
				sessionId: state.activeSessionId,
				fileId: file.fileId,
				name: file.name,
			});
		},
		[state.activeSessionId],
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
	const skillListGeneration = useRef(0);
	const scheduleSubscriptionGeneration = useRef(0);
	const scheduleSnapshotRequest = useRef<Promise<void> | null>(null);
	const statusGeneration = useRef(0);
	const contextStatusRef = useRef<SessionStatusView | null>(null);
	const visibleSessionId = !settingsOpen && destination === "tasks" && newTaskDraft === null ? state.activeSessionId : null;
	workspaceVisibleSession.current = visibleSessionId;
	const reportError = useCallback((cause: unknown) => {
		setError(cause instanceof Error ? cause.message : "Metis could not complete the request.");
	}, []);
	const clearError = useCallback(() => {
		setError(null);
		workspaceWorkflow.dismissFailure();
	}, [workspaceWorkflow]);
	useEffect(() => {
		setError(workspaceState.failure?.reason ?? null);
	}, [workspaceState.failure]);
	useEffect(() => setMessage(workspaceState.message), [workspaceState.message]);
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
	const checkDesktopUpdate = useCallback(() => {
		if (updateCheckTask.current) return;
		setUpdateNotice(null);
		setUpdateCheckFailure(null);
		setCheckingUpdate(true);
		const task = api
			.checkForUpdate()
			.then((next) => {
				setUpdateState((current) => {
					if (current.status === "downloading" || current.status === "ready") return current;
					return next;
				});
				if (next.status === "unavailable") setUpdateNotice({ tone: "success", title: "Metis is up to date" });
			})
			.catch((error: unknown) => {
				const message = error instanceof Error ? error.message : String(error);
				if (message.includes("unavailable in this build") || message.includes("not supported in this build")) {
					setUpdateCheckFailure("unsupported");
					setUpdateNotice({ tone: "info", title: "Update checks are not supported in this build" });
				} else {
					setUpdateCheckFailure("failed");
					setUpdateNotice({
						tone: "error",
						title: "Update check failed",
						message: "Could not check for updates. Check your connection and try again.",
					});
				}
			})
			.finally(() => {
				updateCheckTask.current = null;
				setCheckingUpdate(false);
			});
		updateCheckTask.current = task;
	}, [api, t]);
	const startDesktopUpdate = useCallback(() => {
		void api.startUpdate().catch(reportError);
	}, [api, reportError]);
	const handleDirtySessionIdsChange = useCallback(
		(sessionIds: readonly string[]) => workspaceWorkflow.reportDirtySessionIds(sessionIds),
		[workspaceWorkflow],
	);
	const handleToolCleanupHandled = useCallback(
		(sessionIds: readonly string[]) => workspaceWorkflow.acknowledgeCleanup(sessionIds),
		[workspaceWorkflow],
	);

	useEffect(() => {
		void api.setWorkspaceEditState({
			dirty: dirtyToolSessionIds.length > 0,
			language: i18n.resolvedLanguage?.startsWith("zh") ? "zh" : "en",
			visibleSessionId,
		}).catch(reportError);
	}, [api, dirtyToolSessionIds.length, i18n.resolvedLanguage, reportError, visibleSessionId]);

	const homeComposerFormRef = useRef<HTMLFormElement>(null);
	const conversationComposerFormRef = useRef<HTMLFormElement>(null);
	const pendingHomeTransition = useRef<{
		source: DOMRectReadOnly;
		home: HTMLFormElement;
		sessionId: string | null;
	} | null>(null);
	const homeTransitionAnimation = useRef<Animation | null>(null);
	const cancelHomeTransition = useCallback(() => {
		pendingHomeTransition.current = null;
		homeTransitionAnimation.current?.cancel();
		homeTransitionAnimation.current = null;
	}, []);
	useEffect(() => () => cancelHomeTransition(), [cancelHomeTransition]);

	const activateBrowserSession = useCallback(
		(sessionId: string) => {
			if (currentNavigationLocation.view !== "tasks" || currentNavigationLocation.sessionId !== sessionId) {
				rememberCurrentNavigation();
			}
			cancelHomeTransition();
			setDestination("tasks");
			if (store.getSnapshot().activeSessionId === sessionId) {
				workspaceWorkflow.cancelNewTask();
				return;
			}
			void workspaceWorkflow.openVisibleSession(sessionId).catch(() => undefined);
		},
		[cancelHomeTransition, currentNavigationLocation, rememberCurrentNavigation, store, workspaceWorkflow],
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

	workspaceEventObserver.current = (event) => {
		if (event.type === "open-session") {
			setDestination("tasks");
			return;
		}
		if (event.type === "supervisor") {
			if (event.view.state === "ready") void requestScheduleSnapshot();
			return;
		}
		if (event.type !== "app-server" || "id" in event.envelope) return;
		scheduleStore.applyBatch(event.envelope.params);
		if (scheduleStore.getSnapshot().syncStatus === "resnapshot_required") void requestScheduleSnapshot(true);
	};

	useEffect(() => {
		let active = true;
		void api
			.setScheduleKeepAwake(localStorage.getItem(SCHEDULE_KEEP_AWAKE_KEY) === "true")
			.catch(reportError);
		void workspaceWorkflow.start().then(() => {
			if (active) void requestScheduleSnapshot();
		});

		return () => {
			active = false;
			workspaceWorkflow.dispose();
			scheduleSubscriptionGeneration.current += 1;
			void api.unsubscribeSchedule().catch(() => undefined);
		};
	}, [api, reportError, requestScheduleSnapshot, workspaceWorkflow]);

	const renameProject = useCallback(
		(group: ProjectSessionGroup, alias: string) => workspaceWorkflow.renameProject(group, alias),
		[workspaceWorkflow],
	);
	const pinProject = useCallback(
		(group: ProjectSessionGroup, pinned: boolean) => workspaceWorkflow.pinProject(group, pinned),
		[workspaceWorkflow],
	);
	const pinSession = useCallback(
		(session: SessionSummary, pinned: boolean) => workspaceWorkflow.pinSession(session, pinned),
		[workspaceWorkflow],
	);
	const previewProjectDelete = useCallback(
		(group: ProjectSessionGroup) => workspaceWorkflow.previewProjectDelete({ mode: group.mode, cwd: group.cwd }),
		[workspaceWorkflow],
	);
	const closeCodeProjectSetup = useCallback(() => {
		codeProjectSetupGeneration.current += 1;
		codeProjectSetupRequest.current = null;
		setCodeProjectSetupOpen(false);
	}, []);
	const restoreWindowsNavigation = useCallback(async (target: WindowsNavigationLocation) => {
		setNavigationBusy(true);
		try {
			cancelHomeTransition();
			closeCodeProjectSetup();
			setError(null);
			if (target.view === "settings") {
				setSettingsOpen(true);
				return;
			}
			setSettingsOpen(false);
			if (target.view === "tasks") {
				setDestination("tasks");
				if (target.sessionId && store.getSnapshot().sessionsById.has(target.sessionId)) {
					await workspaceWorkflow.openVisibleSession(target.sessionId);
				} else {
					workspaceWorkflow.startNewTask(target.mode);
				}
				return;
			}
			if (workspaceWorkflow.getSnapshot().mode !== target.mode) {
				await workspaceWorkflow.selectMode(target.mode);
			}
			if (target.view === "skills") {
				setPluginSection(target.section);
				setDestination("skills");
				return;
			}
			setSelectedScheduleTaskId(target.taskId);
			setDestination("schedules");
		} finally {
			setNavigationBusy(false);
		}
	}, [cancelHomeTransition, closeCodeProjectSetup, store, workspaceWorkflow]);
	const navigateBack = useCallback(() => {
		const target = navigationBack.at(-1);
		if (!target || navigationBusy) return;
		setNavigationBack((entries) => entries.slice(0, -1));
		setNavigationForward((entries) => [...entries.slice(-49), currentNavigationLocation]);
		void restoreWindowsNavigation(target).catch(reportError);
	}, [currentNavigationLocation, navigationBack, navigationBusy, reportError, restoreWindowsNavigation]);
	const navigateForward = useCallback(() => {
		const target = navigationForward.at(-1);
		if (!target || navigationBusy) return;
		setNavigationForward((entries) => entries.slice(0, -1));
		setNavigationBack((entries) => [...entries.slice(-49), currentNavigationLocation]);
		void restoreWindowsNavigation(target).catch(reportError);
	}, [currentNavigationLocation, navigationBusy, navigationForward, reportError, restoreWindowsNavigation]);
	const createEmptySessionInProject = useCallback(async (projectMode: AgentMode, cwd: string): Promise<void> => {
		rememberCurrentNavigation();
		if (projectMode === "code") {
			cancelHomeTransition();
			setDestination("tasks");
			closeCodeProjectSetup();
			workspaceWorkflow.startNewTask("code");
			workspaceWorkflow.setDraftFolder(cwd);
			return;
		}
		setDestination("tasks");
		await workspaceWorkflow.createSessionInProject(projectMode, cwd);
	}, [cancelHomeTransition, closeCodeProjectSetup, rememberCurrentNavigation, workspaceWorkflow]);
	const createEmptyProjectSession = useCallback(
		(group: ProjectSessionGroup): Promise<void> => createEmptySessionInProject(group.mode, group.cwd),
		[createEmptySessionInProject],
	);
	const deleteProject = useCallback(
		(group: ProjectSessionGroup, preview: Parameters<SessionWorkspaceWorkflow["deleteProject"]>[1]) =>
			workspaceWorkflow.deleteProject(group, preview),
		[workspaceWorkflow],
	);
	const renameSession = useCallback(
		(session: SessionSummary, name: string) => workspaceWorkflow.renameSession(session, name),
		[workspaceWorkflow],
	);
	const deleteSession = useCallback(
		(session: SessionSummary) => workspaceWorkflow.deleteSession(session),
		[workspaceWorkflow],
	);

	const openVisibleSession = useCallback(async (sessionId: string) => {
		if (currentNavigationLocation.view !== "tasks" || currentNavigationLocation.sessionId !== sessionId) {
			rememberCurrentNavigation();
		}
		cancelHomeTransition();
		setDestination("tasks");
		closeCodeProjectSetup();
		try {
			await workspaceWorkflow.openVisibleSession(sessionId);
		} catch {
			// The workflow reports the error while preserving the current projection.
		}
	}, [cancelHomeTransition, closeCodeProjectSetup, currentNavigationLocation, rememberCurrentNavigation, workspaceWorkflow]);
	const forkFromReply = async (entryId: string) => {
		try {
			await workspaceWorkflow.forkSession(entryId);
		} catch (cause) {
			reportError(cause);
		}
	};
	const openScheduledSession = (sessionId: string) => {
		setDestination("tasks");
		void openVisibleSession(sessionId);
	};

	const chooseNewTaskFolder = () => workspaceWorkflow.chooseDraftFolder().catch(() => undefined);
	const chooseCodeProjectFolder = () => api.selectProjectFolder();
	const createCodeProjectFolder = (input: Parameters<MetisDesktopApi["createProjectFolder"]>[0]) =>
		api.createProjectFolder(input);
	const openCodeProjectSetup = useCallback(() => {
		const draft = workspaceWorkflow.getSnapshot().draft;
		if (!draft || draft.mode !== "code" || draft.sessionId !== null) return;
		const request = {
			draft,
			generation: codeProjectSetupGeneration.current + 1,
		};
		codeProjectSetupGeneration.current = request.generation;
		codeProjectSetupRequest.current = request;
		setCodeProjectSetupOpen(true);
	}, [workspaceWorkflow]);
	const setHomeDraftFolder = useCallback((projectMode: AgentMode, cwd: string | null) => {
		const draft = workspaceWorkflow.getSnapshot().draft;
		if (!draft || draft.mode !== projectMode || draft.sessionId !== null) return;
		workspaceWorkflow.setDraftFolder(cwd);
	}, [workspaceWorkflow]);
	const selectHomeProject = useCallback((projectMode: AgentMode, cwd: string) => {
		setHomeDraftFolder(projectMode, cwd);
	}, [setHomeDraftFolder]);
	const clearHomeProject = useCallback((projectMode: AgentMode) => {
		setHomeDraftFolder(projectMode, null);
	}, [setHomeDraftFolder]);
	const selectCodeProject = useCallback((cwd: string, request: CodeProjectSetupRequest | null) => {
		const current = workspaceWorkflow.getSnapshot().draft;
		const active = codeProjectSetupRequest.current;
		if (
			!request ||
			active?.generation !== request.generation ||
			active.draft !== request.draft ||
			current !== request.draft ||
			current.mode !== "code" ||
			current.sessionId !== null
		) return;
		workspaceWorkflow.setDraftFolder(cwd);
		closeCodeProjectSetup();
	}, [closeCodeProjectSetup, workspaceWorkflow]);
	const handleCodeProjectCreated = useCallback((cwd: string, request: CodeProjectSetupRequest | null) => {
		selectCodeProject(cwd, request);
	}, [selectCodeProject]);

	const startNewTask = useCallback(() => {
		if (currentNavigationLocation.view !== "tasks" || currentNavigationLocation.sessionId !== null) {
			rememberCurrentNavigation();
		}
		cancelHomeTransition();
		setDestination("tasks");
		closeCodeProjectSetup();
		setError(null);
		workspaceWorkflow.startNewTask();
	}, [cancelHomeTransition, closeCodeProjectSetup, currentNavigationLocation, rememberCurrentNavigation, workspaceWorkflow]);
	const cancelNewTask = () => {
		cancelHomeTransition();
		closeCodeProjectSetup();
		setError(null);
		workspaceWorkflow.cancelNewTask();
	};

	const changeMode = useCallback((nextMode: AgentMode) => {
		if (nextMode === mode) return;
		rememberCurrentNavigation();
		cancelHomeTransition();
		setDestination("tasks");
		closeCodeProjectSetup();
		setError(null);
		void workspaceWorkflow.selectMode(nextMode);
	}, [cancelHomeTransition, closeCodeProjectSetup, mode, rememberCurrentNavigation, workspaceWorkflow]);

	const visibleNewTaskDraft = destination === "tasks" && newTaskDraft?.mode === mode ? newTaskDraft : null;
	const homeProjects = useMemo(
		() => buildSessionTree(state, mode, projectPreferences).projects,
		[mode, projectPreferences, state],
	);
	const recentCodeProjects = useMemo(
		() => mode === "code" ? recentProjectsFromGroups(homeProjects) : [],
		[homeProjects, mode],
	);
	const activeCodeProjectSetupRequest = codeProjectSetupRequest.current;

	const submitNewTaskDraft = async (input: ComposerSubmission) => {
		if (!visibleNewTaskDraft) return;
		const home = homeComposerFormRef.current;
		const ticket = home && !reducedMotion ? {
			source: home.getBoundingClientRect(),
			home,
			sessionId: visibleNewTaskDraft.sessionId,
		} : null;
		pendingHomeTransition.current = ticket;
		try {
			await workspaceWorkflow.submitNewTask(input);
		} catch (cause) {
			if (pendingHomeTransition.current === ticket) cancelHomeTransition();
			throw cause;
		}
	};

	const createScheduleWithMetis = async (cwd: string | null) => {
		rememberCurrentNavigation();
		setDestination("tasks");
		workspaceWorkflow.startNewTask("chat");
		workspaceWorkflow.setDraftFolder(cwd);
		await workspaceWorkflow.submitNewTask(
			{ text: ASSISTED_SCHEDULE_PROMPT, attachments: [] },
			t("Set up a scheduled task"),
		);
	};

	const createSkillWithMetis = async (target: SkillCreationTarget) => {
		rememberCurrentNavigation();
		const prompt = target.source === "project"
			? `I want to create a project-level Skill in ${target.cwd}. Use the create-skill Skill and ask me for the information you need before creating it.`
			: "I want to create a user-level Skill. Use the create-skill Skill and ask me for the information you need before creating it.";
		setDestination("tasks");
		workspaceWorkflow.startNewTask("chat");
		workspaceWorkflow.setDraftFolder(target.cwd);
		await workspaceWorkflow.submitNewTask({ text: prompt, attachments: [] });
	};

	const activeSession = state.activeSessionId ? state.sessionsById.get(state.activeSessionId) : undefined;
	const openingSession = workspaceState.openingSessionId
		? state.sessionsById.get(workspaceState.openingSessionId)
		: undefined;
	const newTaskOpen = visibleNewTaskDraft !== null;
	const visibleActiveSession = destination === "tasks" && activeSession && (activeSession.mode === mode || openingSession?.mode === mode) && !newTaskOpen
		? activeSession
		: undefined;
	const toolsSession = visibleActiveSession ?? (visibleNewTaskDraft?.sessionId
		? state.sessionsById.get(visibleNewTaskDraft.sessionId)
			?? { sessionId: visibleNewTaskDraft.sessionId, cwd: visibleNewTaskDraft.folder }
		: undefined);
	const openKnowledge = (sessionId: string) => {
		setKnowledgeRequest({ id: Date.now(), sessionId });
	};
	const projectContext = visibleActiveSession?.cwd
		? { mode: visibleActiveSession.mode, cwd: visibleActiveSession.cwd }
		: undefined;
	const openNewSessionInProject = projectContext
		? () => void createEmptySessionInProject(projectContext.mode, projectContext.cwd)
		: undefined;
	const running = visibleActiveSession?.state === "running" || (visibleActiveSession !== undefined && state.activeTurnId !== null);
	const serverReady = state.supervisor.state === "ready";
	useLayoutEffect(() => {
		if (destination !== "tasks" || settingsOpen || reducedMotion || workspaceState.failure) {
			cancelHomeTransition();
			return;
		}
		const pending = pendingHomeTransition.current;
		if (!pending) return;
		if (newTaskOpen) {
			if (homeComposerFormRef.current !== pending.home) {
				cancelHomeTransition();
				return;
			}
			pending.source = pending.home.getBoundingClientRect();
			pending.sessionId = visibleNewTaskDraft?.sessionId ?? pending.sessionId;
			return;
		}
		const target = conversationComposerFormRef.current;
		pendingHomeTransition.current = null;
		if (!target || !visibleActiveSession ||
				(pending.sessionId !== null && pending.sessionId !== visibleActiveSession.sessionId)) return;
		homeTransitionAnimation.current?.cancel();
		const animation = animateNewTaskComposer(target, pending.source, reducedMotion);
		homeTransitionAnimation.current = animation;
		const focusTarget = () => {
			if (!target.isConnected || conversationComposerFormRef.current !== target) return;
			if (document.activeElement !== document.body && document.activeElement !== target) return;
			target.querySelector<HTMLElement>(".composer-editable-input")?.focus({ preventScroll: true });
		};
		if (animation) void animation.finished.then(focusTarget).catch(() => undefined);
		else focusTarget();
	});
	useEffect(() => {
		const resize = () => {
			const pending = pendingHomeTransition.current;
			if (pending?.home.isConnected) pending.source = pending.home.getBoundingClientRect();
			homeTransitionAnimation.current?.cancel();
			homeTransitionAnimation.current = null;
		};
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, []);
	useEffect(() => {
		homeTransitionAnimation.current?.cancel();
		homeTransitionAnimation.current = null;
	}, [sessionSidebarWidth]);
	useEffect(() => {
		statusGeneration.current += 1;
		contextStatusRef.current = null;
		setSessionStatusPanel(null);
		setContextStatus(null);
		requestComposerControl(null);
		setCompactingSession((current) => current?.sessionId === visibleActiveSession?.sessionId ? current : null);
		setPlanPreviewRequest(null);
		setConversationPrefillRequest(undefined);
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
	const waitingForAnswer = visibleInteraction?.kind === "ask_user";
	useEffect(() => {
		if (state.syncStatus !== "ready") return;
		for (const id of askUserDrafts.current.keys()) {
			const draft = askUserDrafts.current.get(id)!;
			if (!state.sessionsById.has(draft.sessionId) || (draft.sessionId === state.activeSessionId && !state.interactionsById.has(id))) askUserDrafts.current.delete(id);
		}
	}, [state.activeSessionId, state.interactionOrder, state.sessionOrder, state.syncStatus]);
	const inlineInteraction =
		visibleInteraction?.kind === "ask_user" || visibleInteraction?.kind === "session_permission_approval"
			? visibleInteraction
			: undefined;
	const visibleNotifications = state.notifications.filter(
		(notification) => notification.sessionId === undefined || notification.sessionId === visibleActiveSession?.sessionId,
	);
	const latestNotification = visibleNotifications.at(-1);
	const latestTurnErrorCode = state.turnOrder.length > 0
		? state.turnsById.get(state.turnOrder[state.turnOrder.length - 1]!)?.error?.name
		: undefined;
	const errorNotice = error ? systemErrorNotice(error) : undefined;
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

	const editQueuedTurn = async (turn: QueuedTurnView) => {
		await deleteQueuedTurn(turn);
		setConversationPrefillRequest((current) => ({
			id: (current?.id ?? 0) + 1,
			text: turn.text,
		}));
		if (turn.attachments.length > 0) {
			setNotice("The message was returned to the composer. Add its attachments again before sending.");
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
		try {
			await api.respondToInteraction(response);
			store.removeInteraction(response.interactionId);
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			if (/stale|unavailable|cancelled|no longer/iu.test(message)) {
				store.removeInteraction(response.interactionId);
				reportError(new Error("This interaction is no longer available."));
			}
			throw cause;
		}
	};

	const changeThinking = async (sessionId: string, selection: AppStoreSnapshot["thinkingSelection"]) => {
		store.setOptimisticThinkingSelection(selection);
		try {
			await api.setThinkingSelection({ sessionId, requestId: crypto.randomUUID(), selection });
		} catch (cause) {
			if (store.getSnapshot().activeSessionId === sessionId) await workspaceWorkflow.resnapshotSession(sessionId);
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
	const globalThinkingAvailable = useMemo<ThinkingSelectionView[]>(
		() => {
			const selected = modelSettings?.defaultModel;
			if (!selected) return ["off"];
			const model = modelSettings.providers
				.find((provider) => provider.provider === selected.provider)
				?.models.find((candidate) => candidate.modelId === selected.modelId);
			return model ? [...model.thinkingLevels] : ["off"];
		},
		[modelSettings],
	);

	const changePermissionPreset = async (sessionId: string, permissionPreset: PermissionPresetView) => {
		try {
			await api.setPermissionPreset({ sessionId, requestId: crypto.randomUUID(), permissionPreset });
			if (store.getSnapshot().activeSessionId === sessionId)
				setNotice(t("Permissions updated. Applies to subsequent tools; running operations continue."));
		} catch (cause) {
			if (store.getSnapshot().activeSessionId === sessionId) await workspaceWorkflow.resnapshotSession(sessionId);
			reportError(cause);
			throw cause;
		}
	};
	const setupWindowsSandbox = async () => {
		try {
			const result = await api.installWorkspaceSandbox();
			if (result === "cancelled") {
				setNotice(t("Windows sandbox setup was cancelled."));
				return;
			}
			if (result === "unsupported") {
				setNotice(t("Windows sandbox setup is not supported on this device."));
				return;
			}
			const activeSessionId = store.getSnapshot().activeSessionId;
			if (activeSessionId) await workspaceWorkflow.resnapshotSession(activeSessionId);
			setNotice(t("Windows sandbox is ready."));
		} catch (cause) {
			reportError(cause);
		}
	};

	const configurationSession = visibleActiveSession ?? (
		newTaskOpen && visibleNewTaskDraft?.sessionId && activeSession?.sessionId === visibleNewTaskDraft.sessionId ? activeSession : undefined
	);

	const openPlan = useCallback((plan: PlanView) => {
		setPlanPreviewRequest(plan);
	}, []);

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
			actualThinkingLevel={globalThinkingSelection}
			available={globalThinkingAvailable}
			commandRequest={{ id: composerControl.id, open: composerControl.target === "thinking" }}
			disabled={!serverReady}
			onChange={changeGlobalThinking}
			reducedMotion={reducedMotion}
			value={globalThinkingSelection}
		/>
	) : undefined;
	const permissionSessionId = visibleNewTaskDraft?.sessionId ?? visibleActiveSession?.sessionId;
	const permissionSessionOpen = permissionSessionId === undefined || state.activeSessionId === permissionSessionId;
	const draftCreatePending = workspaceState.draftCreatePending;
	const permissionView = permissionSessionId && permissionSessionOpen
		? {
			constrainedByParent: state.constrainedByParent,
			sandboxHealth: state.sandboxHealth,
			activeReview: state.activeReview,
		}
		: {
			constrainedByParent: false,
			sandboxHealth: "healthy" as const,
			activeReview: undefined,
		};
	const permissionControl = visibleNewTaskDraft ? (
		<PermissionSelector
			activeReview={permissionView.activeReview}
			constrainedByParent={permissionView.constrainedByParent}
			disabled={draftBusy || !serverReady || draftCreatePending || !permissionSessionOpen}
			onChange={(permissionPreset) => permissionSessionId
				? changePermissionPreset(permissionSessionId, permissionPreset)
				: workspaceWorkflow.setDraftPermission(permissionPreset)}
			onSetupSandbox={api.platform === "win32" ? setupWindowsSandbox : undefined}
			sandboxHealth={permissionView.sandboxHealth}
			value={permissionSessionId && permissionSessionOpen ? state.permissionPreset : visibleNewTaskDraft.permissionPreset}
		/>
	) : visibleActiveSession ? (
		<PermissionSelector
			activeReview={state.activeReview}
			constrainedByParent={state.constrainedByParent}
			disabled={!serverReady}
			onChange={(permissionPreset) => changePermissionPreset(visibleActiveSession.sessionId, permissionPreset)}
			onSetupSandbox={api.platform === "win32" ? setupWindowsSandbox : undefined}
			sandboxHealth={state.sandboxHealth}
			value={state.permissionPreset}
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
		rememberCurrentNavigation();
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
		settingsReturnFocusRef.current = document.activeElement instanceof HTMLElement && document.activeElement !== document.body
			? document.activeElement : document.querySelector<HTMLElement>(".account-menu-trigger");
		rememberCurrentNavigation();
		setSettingsOpen(true);
	}, [rememberCurrentNavigation]);
	const closeSettings = useCallback(() => {
		setSettingsOpen(false);
		if (api.platform === "win32") {
			setNavigationBack((entries) => entries.slice(0, -1));
			setNavigationForward([]);
		}
		requestAnimationFrame(() => settingsReturnFocusRef.current?.focus());
	}, [api.platform]);
	const deleteScheduledTask = useCallback(async (input: Parameters<MetisDesktopApi["deleteSchedule"]>[0]) => {
		const result = await api.deleteSchedule(input);
		scheduleStore.removeTask(result.taskId);
		setSelectedScheduleTaskId((current) => current === result.taskId ? null : current);
		return result;
	}, [api, scheduleStore]);
	const sidebarScheduleTasks = useMemo(
		() => scheduleState.taskOrder
			.map((id) => scheduleState.tasksById.get(id))
			.filter((task): task is ScheduleTaskView => task !== undefined),
		[scheduleState.taskOrder, scheduleState.tasksById],
	);
	const openSkillsDestination = useCallback(() => {
		if (currentNavigationLocation.view !== "skills" || currentNavigationLocation.section !== "skills") {
			rememberCurrentNavigation();
		}
		setPluginSection("skills");
		setDestination("skills");
	}, [currentNavigationLocation, rememberCurrentNavigation]);
	const openSchedulesDestination = useCallback(() => {
		if (currentNavigationLocation.view !== "schedules" || currentNavigationLocation.taskId !== null) {
			rememberCurrentNavigation();
		}
		setDestination("schedules");
		setSelectedScheduleTaskId(null);
	}, [currentNavigationLocation, rememberCurrentNavigation]);
	const openSchedule = useCallback((taskId: string) => {
		if (currentNavigationLocation.view !== "schedules" || currentNavigationLocation.taskId !== taskId) {
			rememberCurrentNavigation();
		}
		setDestination("schedules");
		setSelectedScheduleTaskId(taskId);
	}, [currentNavigationLocation, rememberCurrentNavigation]);
	const [sidebarClosing, setSidebarClosing] = useState(false);
	const sidebarClosingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const hideSessionSidebar = useCallback(() => {
		const runtime = globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT?: boolean; process?: { env?: { NODE_ENV?: string } } };
		const isActEnv = Boolean(runtime.IS_REACT_ACT_ENVIRONMENT || runtime.process?.env?.NODE_ENV === "test");
		if (isActEnv) {
			setSessionsSidebarOpen(false);
			return;
		}
		setSidebarClosing(true);
		if (sidebarClosingTimeoutRef.current) clearTimeout(sidebarClosingTimeoutRef.current);
		sidebarClosingTimeoutRef.current = setTimeout(() => {
			setSessionsSidebarOpen(false);
			setSidebarClosing(false);
			sidebarClosingTimeoutRef.current = null;
		}, 200);
	}, []);

	const showSessionSidebar = useCallback(() => {
		if (sidebarClosingTimeoutRef.current) {
			clearTimeout(sidebarClosingTimeoutRef.current);
			sidebarClosingTimeoutRef.current = null;
		}
		setSidebarClosing(false);
		setSessionsSidebarOpen(true);
	}, []);

	useEffect(() => {
		return () => {
			if (sidebarClosingTimeoutRef.current) clearTimeout(sidebarClosingTimeoutRef.current);
		};
	}, []);

	const sidebarProjectBusy = useCallback(
		(group: ProjectSessionGroup) => workspaceState.busyProjectKeys.has(sessionProjectKey(group.mode, group.cwd)),
		[workspaceState.busyProjectKeys],
	);
	const sidebarWorkspace = useMemo(() => ({
		busy: !bootstrapped || draftBusy || !serverReady,
		mode,
		newTaskOpen,
		onCreateProjectSession: createEmptyProjectSession,
		onDeleteProject: deleteProject,
		onDeleteSession: deleteSession,
		onModeChange: changeMode,
		onNewTask: startNewTask,
		onOpen: openVisibleSession,
		onPinProject: pinProject,
		onPinSession: pinSession,
		onPreviewProjectDelete: previewProjectDelete,
		onRenameProject: renameProject,
		onRenameSession: renameSession,
		pinnedSessionIds,
		preferences: projectPreferences,
		projectBusy: sidebarProjectBusy,
	}), [
		bootstrapped,
		changeMode,
		createEmptyProjectSession,
		deleteProject,
		deleteSession,
		draftBusy,
		mode,
		newTaskOpen,
		openVisibleSession,
		pinProject,
		pinSession,
		pinnedSessionIds,
		previewProjectDelete,
		projectPreferences,
		renameProject,
		renameSession,
		serverReady,
		sidebarProjectBusy,
		startNewTask,
	]);

	const isCollapsed = !sessionsSidebarOpen || sidebarClosing;
	const toggleSessionsSidebar = () => {
		if (sessionsSidebarOpen && !sidebarClosing) hideSessionSidebar();
		else showSessionSidebar();
	};

	const homePage = visibleNewTaskDraft ? (
		<>
			<NewTaskHome
				key={mode}
				busy={draftBusy || !serverReady}
				commandRequest={{ id: composerControl.id, open: composerControl.target === "mcp" }}
				composerFormRef={homeComposerFormRef}
				disabledSlashCommands={disabledSlashCommands}
				disabledSlashReasons={disabledSlashReasons}
				folder={visibleNewTaskDraft.folder}
				folderLocked={visibleNewTaskDraft.sessionId !== null}
				mode={mode}
				modelControl={modelControl}
				knowledge={{
					api,
					sessionId: visibleNewTaskDraft.sessionId ?? undefined,
					disabled: draftBusy || !serverReady || (mode === "code" && !visibleNewTaskDraft.folder),
					onPrepare: () => workspaceWorkflow.prepareNewTask(),
					onOpen: openKnowledge,
				}}
				permissionControl={permissionControl}
				onChooseFolder={chooseNewTaskFolder}
				projectControl={
					<HomeProjectPicker
						busy={draftBusy || !serverReady}
						folder={visibleNewTaskDraft.folder}
						folderLocked={visibleNewTaskDraft.sessionId !== null}
						mode={mode}
						onChooseFolder={chooseNewTaskFolder}
						onClearFolder={mode === "chat" ? () => clearHomeProject("chat") : undefined}
						onCreateProject={mode === "code" ? openCodeProjectSetup : undefined}
					/>
				}
				onManageMcp={openMcpManagement}
				onManageSkills={openSkillsDestination}
				onPickFiles={pickAttachmentFiles}
				onResolveDroppedFiles={api.resolveDroppedFiles}
				onSelectRecentProject={(cwd) => selectHomeProject("code", cwd)}
				reducedMotion={reducedMotion}
				onSlashCommand={handleSlashCommand}
				onSubmit={submitNewTaskDraft}
				recentProjects={recentCodeProjects}
				skills={skills}
				thinkingControl={thinkingControl}
			/>
			{mode === "code" && codeProjectSetupOpen && (
				<CodeProjectSetup
					busy={draftBusy || !serverReady}
					initialStep="create"
					onCancel={closeCodeProjectSetup}
					onChooseExisting={chooseCodeProjectFolder}
					onChooseLocation={chooseCodeProjectFolder}
					onCreateProject={createCodeProjectFolder}
					onGetDefaultLocation={api.getDefaultProjectLocation}
					onOpenProject={async (cwd) => selectCodeProject(cwd, activeCodeProjectSetupRequest)}
					onProjectCreated={(cwd) => handleCodeProjectCreated(cwd, activeCodeProjectSetupRequest)}
					onPickFiles={pickAttachmentFiles}
					onResolveDroppedFiles={api.resolveDroppedFiles}
				/>
			)}
		</>
	) : null;

	return (
		<FileSelectionProvider
			sessionId={writableSessionId ?? null}
			enabled={Boolean(
				writableSessionId && serverReady && state.syncStatus === "ready" &&
				compactingSession === null && !collaborationModeChanging && !visibleInteraction
			)}
			onSubmit={submit}
		>

		{api.platform === "win32" && (
			<nav aria-label={t("Window navigation")} className="windows-titlebar-navigation">
				<button
					aria-label={t(sessionsSidebarOpen && !sidebarClosing ? "Hide sessions sidebar" : "Show sessions sidebar")}
					aria-pressed={sessionsSidebarOpen && !sidebarClosing}
					className="sessions-sidebar-toggle-fixed"
					onClick={toggleSessionsSidebar}
					type="button"
				>
					<SidebarSimple aria-hidden="true" size={16} />
				</button>
				<button
					aria-label={t("Go back")}
					disabled={navigationBusy || navigationBack.length === 0}
					onClick={navigateBack}
					type="button"
				>
					<ArrowLeft aria-hidden="true" size={16} />
				</button>
				<button
					aria-label={t("Go forward")}
					disabled={navigationBusy || navigationForward.length === 0}
					onClick={navigateForward}
					type="button"
				>
					<ArrowRight aria-hidden="true" size={16} />
				</button>
			</nav>
		)}
		<div
			aria-hidden={settingsOpen || undefined}
			className={`app-shell${isCollapsed ? " sessions-sidebar-collapsed" : ""}`}
			data-fullscreen={fullscreen || undefined}
			inert={settingsOpen || undefined}
			style={{ "--sidebar-width": `${sessionSidebarWidth}px` } as CSSProperties}
		>
			{sessionsSidebarOpen && <SessionSidebar
				destination={destination}
				isClosing={sidebarClosing}
				onDeleteSchedule={deleteScheduledTask}
				onSettings={openSettings}
				onUpdate={startDesktopUpdate}
				onCheckUpdate={checkDesktopUpdate}
				checkingUpdate={checkingUpdate}
				onSkills={openSkillsDestination}
				onSchedules={openSchedulesDestination}
				onOpenSchedule={openSchedule}
				onWidthChange={updateSessionSidebarWidth}
				scheduleTasks={sidebarScheduleTasks}
				selectedScheduleTaskId={selectedScheduleTaskId}
				state={sidebarState}
				updateState={updateState}
				width={sessionSidebarWidth}
				workspace={sidebarWorkspace}
			/>}
			<main
				className="workspace"
			>
				<div className="workspace-titlebar-actions">
					{api.platform !== "win32" && (
						<button
							aria-label={t(sessionsSidebarOpen && !sidebarClosing ? "Hide sessions sidebar" : "Show sessions sidebar")}
							aria-pressed={sessionsSidebarOpen && !sidebarClosing}
							className="sessions-sidebar-toggle-fixed"
							onClick={toggleSessionsSidebar}
							type="button"
						>
							<SidebarSimple aria-hidden="true" size={17} />
						</button>
					)}
					{toolsSession !== undefined && (
						<div className="workspace-titlebar-end">
							<ReleaseNotesPopover
								loadChangelog={api.getChangelog}
								availableVersion={"version" in updateState ? updateState.version : null}
							/>
						</div>
					)}
				</div>
				<div className="system-notice-stack">
					{state.supervisor.state === "failed" && (
						<SystemNotice
							action={{ label: "Retry", onClick: () => void api.retryServer().catch(reportError) }}
							message={state.supervisor.failure || "App Server could not recover."}
							title="Metis service stopped"
							tone="error"
						/>
					)}
					{state.supervisor.state === "restarting" && (
						<SystemNotice title="App Server is recovering. Your saved session is safe." tone="info" />
					)}
					{visibleActiveSession && <RecoveryBanner errorCode={latestTurnErrorCode} session={visibleActiveSession} />}
					{errorNotice && (
						<SystemNotice message={errorNotice.message} onDismiss={clearError} title={errorNotice.title} tone="error" />
					)}
					{!errorNotice && updateNotice && (
						<SystemNotice message={updateNotice.message} onDismiss={() => setUpdateNotice(null)} title={updateNotice.title} tone={updateNotice.tone} />
					)}
					{!errorNotice && !updateNotice && notice && (
						<SystemNotice onDismiss={() => setNotice(null)} title={notice} tone="info" />
					)}
					{latestNotification && !errorNotice && !updateNotice && !notice && (
						<SystemNotice
							key={latestNotification.notificationId}
							onDismiss={() => store.dismissNotifications(visibleNotifications.map((notification) => notification.notificationId))}
							title={latestNotification.translation ? t(latestNotification.translation.key, latestNotification.translation.values) : latestNotification.message}
							tone={latestNotification.level}
						/>
					)}
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
				{!bootstrapped ? null : destination === "skills" ? (
					<PluginsPanel api={api} initialSection={pluginSection} onCreateSkillWithMetis={createSkillWithMetis} onSkillsChanged={() => setSkillCatalogEpoch((value) => value + 1)} preferences={projectPreferences} serverReady={serverReady} state={state} />
				) : destination === "schedules" && mode === "chat" ? (
					<ScheduledTasksPanel api={api} onCreateWithMetis={createScheduleWithMetis} onOpenSession={openScheduledSession} onSelectTask={setSelectedScheduleTaskId} selectedTaskId={selectedScheduleTaskId} serverReady={serverReady} sessions={state.sessionOrder.map((id) => state.sessionsById.get(id)).filter((session): session is SessionSummary => session !== undefined)} store={scheduleStore} />
				) : null}
				{bootstrapped ? (
					<SessionWorkspaceView
						activeSession={toolsSession ?? null}
						api={api}
						chat={newTaskOpen || !visibleActiveSession ? homePage : (
							<div className="workspace-body">
						<div className="conversation-column" data-mode={visibleActiveSession.mode}>
							<Transcript
								showNavigation
								activeTurnId={state.activeTurnId}
								waitingForAnswer={waitingForAnswer}
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
							<div className="conversation-composer">
								<Composer
									knowledge={serverReady && writableSessionId ? { api, sessionId: writableSessionId, onOpen: openKnowledge } : undefined}
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
								formRef={conversationComposerFormRef}
								interactionControl={inlineInteraction ? <InteractionHost interaction={inlineInteraction} key={inlineInteraction.interactionId} onRespond={respond} sandboxHealth={state.sandboxHealth} askUserDrafts={askUserDrafts.current} disabled={!serverReady || state.syncStatus !== "ready"} /> : undefined}
								awaitingAnswer={waitingForAnswer}
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
								onManageSkills={openSkillsDestination}
								onPickFiles={pickAttachmentFiles}
								onResolveDroppedFiles={api.resolveDroppedFiles}
								onSlashCommand={handleSlashCommand}
								onSubmit={submit}
								permissionControl={permissionControl}
								placeholder={t(
									waitingForAnswer ? "Answer the questions above to continue." : planRevisionTarget
										? "Describe what should change in this plan…"
										: running || state.queuedTurns.length > 0
											? "Add a queued message…"
											: "Write a message…",
								)}
								prefillRequest={conversationPrefillRequest}
								queuedTurnControl={<QueuedTurnList disabled={!serverReady || state.syncStatus !== "ready" || compactingSession !== null} onDelete={deleteQueuedTurn} onEdit={editQueuedTurn} onSend={sendQueuedTurn} running={running} turns={state.queuedTurns} />}
								queueing={state.queuedTurns.length > 0}
								running={running}
								skills={skills}
								taskListEpoch={state.serverEpoch}
								tasks={state.tasks}
								thinkingControl={thinkingControl}
							/>
							</div>
						</div>
					</div>
						)}
						chatTitle={visibleActiveSession ? sessionDisplayTitle(visibleActiveSession) : t("New task")}
						cleanupSessionIds={toolCleanupSessionIds}
						mode={mode}
						onActivateSession={activateBrowserSession}
						onCleanupSessionIdsHandled={handleToolCleanupHandled}
						onDirtySessionIdsChange={handleDirtySessionIdsChange}
						onError={reportError}
						onNewSession={openNewSessionInProject}
						planPreviewRequest={planPreviewRequest}
						previewRequest={previewRequest}
						knowledgeRequest={knowledgeRequest}
						process={visibleActiveSession?.sessionId === state.activeSessionId ? state.process : undefined}
						store={store}
						theme={resolvedTheme}
						visible={!settingsOpen && destination === "tasks" && (newTaskOpen || visibleActiveSession !== undefined)}
					/>
				) : null}
					<div className="sr-only" aria-live="polite">{t(message)}</div>
			</main>
			<InteractionHost interaction={inlineInteraction ? undefined : visibleInteraction} key={inlineInteraction ? "none" : visibleInteraction?.interactionId ?? "none"} onRespond={respond} sandboxHealth={state.sandboxHealth} />
		</div>
		{settingsOpen ? (
			<SettingsDialog
				api={api}
				generalPreferences={generalPreferences}
				onClose={closeSettings}
				onGeneralPreferencesChange={setGeneralPreferences}
				onThemeChange={setTheme}
				serverReady={serverReady}
				sessionId={state.activeSessionId ?? undefined}
				theme={theme}
			/>
		) : null}
		</FileSelectionProvider>
	);
}
