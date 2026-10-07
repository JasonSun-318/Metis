import {
	type AgentMode,
	type InteractionResponseInput,
	type ModelOptionView,
	type ModelSettingsView,
	type PermissionPresetView,
	type PlanView,
	type ScheduleTaskView,
	type SessionDeliveredFileView,
	type SessionSummary,
	type SkillSummaryView,
	type ThinkingSelectionView,
} from "@metis/app-protocol";
import { ArrowLeft, ArrowRight, SidebarSimple } from "@phosphor-icons/react";
import { type CSSProperties, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopApiEvent, DesktopUpdateState, MetisDesktopApi } from "../../shared/desktop-api.ts";
import type { ConversationSubmission } from "../composer-submission.ts";
import {
	applyGeneralPreferencesToDocument,
	loadGeneralPreferences,
	resolveReducedMotion,
	saveGeneralPreferences,
} from "../general-preferences.ts";
import { useAppStore } from "../hooks/use-app-store.ts";
import { useScheduleStore } from "../hooks/use-schedule-store.ts";
import { useSessionWorkspace } from "../hooks/use-session-workspace.ts";
import { animateNewTaskComposer } from "../new-task-composer-transition.ts";
import { firstInteractionForSession } from "../session-view-utils.ts";
import { SessionWorkspaceWorkflow, sessionProjectKey, type NewTaskDraft } from "../session-workspace-workflow.ts";
import type { AppStore, AppStoreSnapshot } from "../store/app-store.ts";
import { ScheduleStore } from "../store/schedule-store.ts";
import { type AppTheme, applyThemeToDocument, loadTheme, resolveTheme, saveTheme, watchSystemTheme } from "../theme.ts";
import { CodeProjectSetup } from "./CodeProjectSetup.tsx";
import type { ComposerSubmission } from "./Composer.tsx";
import { InteractionHost } from "./InteractionHost.tsx";
import { ModelSelector } from "./ModelSelector.tsx";
import { NewTaskHome, recentProjectsFromGroups } from "./NewTaskHome.tsx";
import { PermissionSelector } from "./PermissionSelector.tsx";
import { PluginsPanel } from "./PluginsPanel.tsx";
import { FileSelectionProvider } from "./preview/FileSelectionContext.tsx";
import type { UniversalPreviewTarget } from "./preview/UniversalFilePreviewer.tsx";
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
import { SettingsDialog } from "./SettingsDialog.tsx";
import type { SessionChatSubmit, SessionChatViewContext } from "./SessionChatView.tsx";
import type { SkillCreationTarget } from "./SkillCreationDialog.tsx";
import type { ComposerSlashCommand } from "./SlashCommandMenu.tsx";
import { SystemNotice, systemErrorNotice, type SystemNoticeTone } from "./SystemNotice.tsx";
import { ThinkingSelector } from "./ThinkingSelector.tsx";
import { SessionWorkspaceView } from "./SessionWorkspace.tsx";

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

interface CodeProjectSetupRequest {
	readonly draft: NewTaskDraft;
	readonly generation: number;
}

interface TransientSystemNotice {
	readonly tone: SystemNoticeTone;
	readonly title: string;
	readonly message?: string;
}

export function sessionDisplayTitle(session: Pick<SessionSummary, "cwd" | "cwdOrigin" | "name">): string {
	return session.name || (session.cwdOrigin === "managed" ? "Chat" : session.cwd) || "Metis";
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
	const [planPreviewRequest, setPlanPreviewRequest] = useState<{ readonly sessionId: string; readonly plan: PlanView } | null>(null);
	const chatFocusNonce = useRef(0);
	const [chatFocusRequest, setChatFocusRequest] = useState<{ nonce: number; sessionId: string | null } | null>(null);
	const requestChatFocus = useCallback((sessionId: string | null) => {
		setChatFocusRequest({ nonce: chatFocusNonce.current += 1, sessionId });
	}, []);
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
	const [skills, setSkills] = useState<readonly SkillSummaryView[]>([]);
	const [pluginSection, setPluginSection] = useState<"skills" | "mcp">("skills");
	const [navigationBack, setNavigationBack] = useState<WindowsNavigationLocation[]>([]);
	const [navigationForward, setNavigationForward] = useState<WindowsNavigationLocation[]>([]);
	const [navigationBusy, setNavigationBusy] = useState(false);
	const [skillCatalogEpoch, setSkillCatalogEpoch] = useState(0);
	const [message, setMessage] = useState("Starting Metis…");
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [updateNotice, setUpdateNotice] = useState<TransientSystemNotice | null>(null);
	const [composerControl, setComposerControl] = useState<{ readonly id: number; readonly target: "model" | "thinking" | "mcp" | null }>({ id: 0, target: null });
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
	const modelSettingsGeneration = useRef(0);
	const handlePreviewDeliveredFile = useCallback(
		(sessionId: string, file: SessionDeliveredFileView) => {
			setPreviewRequest({
				source: "delivered",
				sessionId,
				fileId: file.fileId,
				name: file.name,
			});
		},
		[],
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
	// The workspace portals its lone pane's tab strip and the shared add-tool
	// trigger into these titlebar slots; null until the header mounts.
	const [titlebarTabsSlot, setTitlebarTabsSlot] = useState<HTMLDivElement | null>(null);
	const [titlebarAddSlot, setTitlebarAddSlot] = useState<HTMLDivElement | null>(null);
	// Every mounted SessionChatView registers its own submit here so the shared
	// file-selection provider can route "request change" actions to the owning
	// session's composer.
	const conversationSubmitsRef = useRef(new Map<string, SessionChatSubmit>());
	const registerChatSubmit = useCallback((sessionId: string, submit: SessionChatSubmit) => {
		conversationSubmitsRef.current.set(sessionId, submit);
	}, []);
	const unregisterChatSubmit = useCallback((sessionId: string, submit: SessionChatSubmit) => {
		if (conversationSubmitsRef.current.get(sessionId) === submit) conversationSubmitsRef.current.delete(sessionId);
	}, []);
	const submitFileSelection = useCallback((sessionId: string, input: ConversationSubmission) => {
		const submit = conversationSubmitsRef.current.get(sessionId);
		return submit
			? submit(input)
			: Promise.reject(new Error("This conversation is not ready to send"));
	}, []);
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
	const copySessionTitle = useCallback(
		(title: string) => api.writeClipboardText({ text: title }),
		[api],
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
			requestChatFocus(null);
			return;
		}
		setDestination("tasks");
		await workspaceWorkflow.createSessionInProject(projectMode, cwd);
		const created = store.getSnapshot().activeSessionId;
		if (created) requestChatFocus(created);
	}, [cancelHomeTransition, closeCodeProjectSetup, rememberCurrentNavigation, requestChatFocus, store, workspaceWorkflow]);
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
		requestChatFocus(sessionId);
		try {
			await workspaceWorkflow.openVisibleSession(sessionId);
		} catch {
			// The workflow reports the error while preserving the current projection.
		}
	}, [cancelHomeTransition, closeCodeProjectSetup, currentNavigationLocation, rememberCurrentNavigation, requestChatFocus, workspaceWorkflow]);
	const forkFromReply = useCallback(
		async (sessionId: string, entryId: string) => {
			try {
				await workspaceWorkflow.forkSession(entryId, sessionId);
			} catch (cause) {
				reportError(cause);
			}
		},
		[reportError, workspaceWorkflow],
	);
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
		requestChatFocus(null);
	}, [cancelHomeTransition, closeCodeProjectSetup, currentNavigationLocation, rememberCurrentNavigation, requestChatFocus, workspaceWorkflow]);
	const cancelNewTask = () => {
		cancelHomeTransition();
		closeCodeProjectSetup();
		setError(null);
		workspaceWorkflow.cancelNewTask();
	};

	const focusWorkspaceSession = useCallback((sessionId: string | null) => {
		if (sessionId === null) {
			startNewTask();
			return;
		}
		void openVisibleSession(sessionId);
	}, [openVisibleSession, startNewTask]);

	const sessionTitleFor = useCallback((sessionId: string) => {
		const session = store.getSnapshot().sessionsById.get(sessionId);
		return session ? sessionDisplayTitle(session) : t("New task");
	}, [store, t]);

	const changeMode = useCallback((nextMode: AgentMode) => {
		if (nextMode === mode) return;
		rememberCurrentNavigation();
		cancelHomeTransition();
		setDestination("tasks");
		closeCodeProjectSetup();
		setError(null);
		void workspaceWorkflow.selectMode(nextMode).then(() => {
			const landedDraft = workspaceWorkflow.getSnapshot().draft;
			requestChatFocus(landedDraft ? landedDraft.sessionId : store.getSnapshot().activeSessionId);
		});
	}, [cancelHomeTransition, closeCodeProjectSetup, mode, rememberCurrentNavigation, requestChatFocus, store, workspaceWorkflow]);

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
	const openKnowledge = useCallback((sessionId: string) => {
		setKnowledgeRequest({ id: Date.now(), sessionId });
	}, []);
	const workspaceProjectName = (() => {
		const cwd = visibleActiveSession?.cwd ?? visibleNewTaskDraft?.folder ?? null;
		const contextMode = visibleActiveSession?.mode ?? visibleNewTaskDraft?.mode ?? mode;
		if (!cwd) return "Metis";
		const name = cwd.split(/[\\/]/u).filter(Boolean).at(-1) ?? cwd;
		return projectPreferences.get(sessionProjectKey(contextMode, cwd))?.alias ?? name;
	})();

	useEffect(() => {
		document.title = workspaceProjectName === "Metis" ? "Metis" : `${workspaceProjectName} — Metis`;
	}, [workspaceProjectName]);

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
		requestComposerControl(null);
		setPlanPreviewRequest(null);
	}, [requestComposerControl, visibleActiveSession?.sessionId]);
	// The projected session's chat view fetches its own catalog; this list only
	// feeds the new-task draft composer.
	const skillSessionId = visibleNewTaskDraft?.sessionId;
	const shouldListSkills = destination === "tasks" && newTaskOpen;
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
	const interactiveSessionId =
		destination === "tasks" && openingSession?.mode === mode
			? openingSession.sessionId
			: visibleActiveSession?.sessionId ?? visibleNewTaskDraft?.sessionId ?? undefined;
	const visibleInteraction = firstInteractionForSession(
		state.interactionOrder,
		state.interactionsById,
		interactiveSessionId,
	);
	// Sessions with a pane-active chat tab host their own modal interactions;
	// the global host below picks the first pending modal for any other
	// session. The array-equality guard keeps the workspace's per-render
	// reports from looping React state.
	const [chatPaneSessionIds, setChatPaneSessionIds] = useState<readonly string[]>([]);
	const handleLiveSessionsChange = useCallback(
		(sessionIds: readonly string[], chatSessionIds: readonly string[]) => {
			workspaceWorkflow.setLiveSessions(sessionIds);
			setChatPaneSessionIds((current) =>
				current.length === chatSessionIds.length &&
					current.every((id, index) => id === chatSessionIds[index])
					? current
					: chatSessionIds,
			);
		},
		[workspaceWorkflow],
	);
	const chatPaneSessions = new Set(chatPaneSessionIds);
	const globalInteraction = state.interactionOrder
		.map((interactionId) => state.interactionsById.get(interactionId))
		.find(
			(interaction) =>
				interaction !== undefined &&
				interaction.kind !== "ask_user" &&
				interaction.kind !== "session_permission_approval" &&
				!chatPaneSessions.has(interaction.sessionId),
		);
	const visibleNotifications = state.notifications.filter(
		(notification) => notification.sessionId === undefined || notification.sessionId === visibleActiveSession?.sessionId,
	);
	const latestNotification = visibleNotifications.at(-1);
	const latestTurnErrorCode = state.turnOrder.length > 0
		? state.turnsById.get(state.turnOrder[state.turnOrder.length - 1]!)?.error?.name
		: undefined;
	const errorNotice = error ? systemErrorNotice(error) : undefined;
	const writableSessionId = visibleActiveSession?.scheduled === undefined ? visibleActiveSession?.sessionId : undefined;

	const respond = useCallback(
		async (response: InteractionResponseInput) => {
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
		},
		[api, reportError, store],
	);

	const changeThinking = useCallback(
		async (sessionId: string, selection: AppStoreSnapshot["thinkingSelection"]) => {
			store.setOptimisticThinkingSelection(sessionId, selection);
			try {
				await api.setThinkingSelection({ sessionId, requestId: crypto.randomUUID(), selection });
			} catch (cause) {
				await workspaceWorkflow.resnapshotSession(sessionId);
				reportError(cause);
			}
		},
		[api, reportError, store, workspaceWorkflow],
	);

	const changeModel = useCallback(
		async (sessionId: string, model: AppStoreSnapshot["availableModels"][number]) => {
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
		},
		[api, reportError],
	);

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

	const changePermissionPreset = useCallback(
		async (sessionId: string, permissionPreset: PermissionPresetView) => {
			try {
				await api.setPermissionPreset({ sessionId, requestId: crypto.randomUUID(), permissionPreset });
				if (store.getSnapshot().activeSessionId === sessionId)
					setNotice(t("Permissions updated. Applies to subsequent tools; running operations continue."));
			} catch (cause) {
				await workspaceWorkflow.resnapshotSession(sessionId);
				reportError(cause);
				throw cause;
			}
		},
		[api, reportError, store, t, workspaceWorkflow],
	);
	const setupWindowsSandbox = useCallback(async () => {
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
	}, [api, reportError, store, t, workspaceWorkflow]);

	const configurationSession = visibleActiveSession ?? (
		newTaskOpen && visibleNewTaskDraft?.sessionId && activeSession?.sessionId === visibleNewTaskDraft.sessionId ? activeSession : undefined
	);

	const openPlan = useCallback((sessionId: string, plan: PlanView) => {
		setPlanPreviewRequest({ sessionId, plan });
	}, []);

	// The draft composer only serves commands that do not need a session;
	// session-bound commands live inside each SessionChatView.
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
		}
		if (!configurationSession && !newTaskOpen) {
			commands.add("model");
			commands.add("thinking");
			reasons.model = "Open a task to use this command";
			reasons.thinking = "Open a task to use this command";
		}
		return { disabledSlashCommands: commands, disabledSlashReasons: reasons };
	}, [configurationSession, newTaskOpen, writableSessionId]);

	const handleSlashCommand = useCallback(async (command: ComposerSlashCommand) => {
		if (command === "model" || command === "thinking" || command === "mcp") requestComposerControl(command);
	}, [requestComposerControl]);
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
	const permissionSessionId = visibleNewTaskDraft?.sessionId;
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
	) : undefined;
	const openMcpManagement = useCallback(() => {
		rememberCurrentNavigation();
		setPluginSection("mcp");
		setDestination("skills");
	}, [rememberCurrentNavigation]);
	const pickAttachmentFiles = useCallback(async () => {
		try {
			return await api.selectAttachmentFiles();
		} catch (cause) {
			reportError(cause);
			return [];
		}
	}, [api, reportError]);
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
		onCopySessionTitle: copySessionTitle,
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
		copySessionTitle,
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

	// Shared context handed to every visible SessionChatView. Kept referentially
	// stable so memoized chat views only re-render on their own bucket changes.
	const chatView = useMemo<SessionChatViewContext>(() => ({
		api,
		bootstrapped,
		composerFormRef: conversationComposerFormRef,
		registerSubmit: registerChatSubmit,
		unregisterSubmit: unregisterChatSubmit,
		onChangeModel: changeModel,
		onChangePermissionPreset: changePermissionPreset,
		onChangeThinking: changeThinking,
		onClearError: clearError,
		onError: reportError,
		onFork: forkFromReply,
		onManageMcp: openMcpManagement,
		onManageSkills: openSkillsDestination,
		onNotice: setNotice,
		onOpenKnowledge: openKnowledge,
		onOpenPlan: openPlan,
		onPickFiles: pickAttachmentFiles,
		onPreviewDeliveredFile: handlePreviewDeliveredFile,
		onResolveDroppedFiles: api.resolveDroppedFiles,
		onRespond: respond,
		onSetupSandbox: api.platform === "win32" ? setupWindowsSandbox : undefined,
		reducedMotion,
		skillCatalogEpoch,
		store,
	}), [
		api,
		bootstrapped,
		changeModel,
		changePermissionPreset,
		changeThinking,
		clearError,
		forkFromReply,
		handlePreviewDeliveredFile,
		openKnowledge,
		openMcpManagement,
		openPlan,
		openSkillsDestination,
		pickAttachmentFiles,
		reducedMotion,
		registerChatSubmit,
		reportError,
		respond,
		setupWindowsSandbox,
		skillCatalogEpoch,
		store,
		unregisterChatSubmit,
	]);

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
				selectionSessionId={visibleNewTaskDraft.sessionId}
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
			enabled={Boolean(serverReady && !visibleInteraction)}
			onSubmit={submitFileSelection}
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
				projectName={workspaceProjectName}
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
				<header
				className="workspace-titlebar"
				data-active-session-id={visibleActiveSession?.sessionId}
			>
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
					<div className="workspace-titlebar-tabs" ref={setTitlebarTabsSlot} />
					<div className="workspace-titlebar-end">
						{toolsSession !== undefined && (
							<ReleaseNotesPopover
								loadChangelog={api.getChangelog}
								availableVersion={"version" in updateState ? updateState.version : null}
							/>
						)}
						<div className="workspace-titlebar-add" ref={setTitlebarAddSlot} />
					</div>
				</header>
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
				{!bootstrapped ? null : destination === "skills" ? (
					<PluginsPanel api={api} initialSection={pluginSection} onCreateSkillWithMetis={createSkillWithMetis} onSkillsChanged={() => setSkillCatalogEpoch((value) => value + 1)} preferences={projectPreferences} serverReady={serverReady} state={state} />
				) : destination === "schedules" && mode === "chat" ? (
					<ScheduledTasksPanel api={api} onCreateWithMetis={createScheduleWithMetis} onOpenSession={openScheduledSession} onSelectTask={setSelectedScheduleTaskId} selectedTaskId={selectedScheduleTaskId} serverReady={serverReady} sessions={state.sessionOrder.map((id) => state.sessionsById.get(id)).filter((session): session is SessionSummary => session !== undefined)} store={scheduleStore} />
				) : null}
				{bootstrapped ? (
					<SessionWorkspaceView
						api={api}
						chat={newTaskOpen || !visibleActiveSession ? homePage : null}
						chatView={chatView}
						chatCwd={toolsSession?.cwd ?? null}
						chatFocusRequest={chatFocusRequest}
						chatIsDraft={newTaskOpen}
						chatSessionId={toolsSession?.sessionId ?? null}
						cleanupSessionIds={toolCleanupSessionIds}
						mode={mode}
						onActivateSession={activateBrowserSession}
						onChatSession={focusWorkspaceSession}
						onCleanupSessionIdsHandled={handleToolCleanupHandled}
						onDirtySessionIdsChange={handleDirtySessionIdsChange}
						onError={reportError}
						onLiveSessionsChange={handleLiveSessionsChange}
						onNewSession={(target) => {
							if (target) void createEmptySessionInProject(target.mode, target.cwd);
							else startNewTask();
						}}
						planPreviewRequest={planPreviewRequest}
						previewRequest={previewRequest}
						knowledgeRequest={knowledgeRequest}
						process={visibleActiveSession?.sessionId === state.activeSessionId ? state.process : undefined}
						sessionsById={state.sessionsById}
						sessionTitleFor={sessionTitleFor}
						store={store}
						theme={resolvedTheme}
						titlebarAddSlot={titlebarAddSlot}
						titlebarTabsSlot={titlebarTabsSlot}
						visible={!settingsOpen && destination === "tasks" && (newTaskOpen || visibleActiveSession !== undefined)}
					/>
				) : null}
					<div className="sr-only" aria-live="polite">{t(message)}</div>
			</main>
			<InteractionHost
				interaction={globalInteraction}
				key={globalInteraction?.interactionId ?? "none"}
				onRespond={respond}
				sandboxHealth={globalInteraction ? state.sessions.get(globalInteraction.sessionId)?.sandboxHealth : state.sandboxHealth}
			/>
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
