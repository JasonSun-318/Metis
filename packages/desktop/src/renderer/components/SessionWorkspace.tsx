import type { AgentMode, PlanView, SessionProcessView, SessionSummary } from "@metis/app-protocol";
import {
	Books,
	ChatCircle,
	ClipboardText,
	FileText,
	Globe,
	Plus,
	Robot,
	TerminalWindow,
	X,
} from "@phosphor-icons/react";
import type { CSSProperties, DragEvent, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	DEFAULT_BROWSER_PROFILE_ID,
	type DesktopBrowserProfile,
	type DesktopBrowserState,
	type DesktopWorkspaceMutationResult,
	type MetisDesktopApi,
} from "../../shared/desktop-api.ts";
import {
	activateTab,
	activePane,
	addTab,
	chatTab,
	defaultWorkspace,
	findChatTab,
	findTabLocation,
	focusedChatTab,
	moveTab,
	removeTab,
	removeTabs,
	type SessionWorkspace,
	splitTabBeside,
	splitTabRight,
	type WorkspacePane,
	type WorkspaceTab,
	workspaceTabs,
} from "../workspace-tabs.ts";
import type { AppStore } from "../store/app-store.ts";
import { BrowserPanel } from "./BrowserPanel.tsx";
import { KnowledgePanel } from "./KnowledgePanel.tsx";
import { FilePanel, type WorkspaceFileDraft } from "./FilePanel.tsx";
import { UniversalFilePreviewer, type UniversalPreviewTarget } from "./preview/UniversalFilePreviewer.tsx";
import { previewBytesCache } from "./preview/preview-bytes-cache.ts";
import { PlanPreview } from "./PlanPreview.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { AgentTreePanel } from "./AgentTreePanel.tsx";
import { ProcessPanel } from "./ProcessPanel.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";
import { WorkspaceFileIcon } from "./WorkspaceFileIcon.tsx";

const FILE_BROWSER_STORAGE_PREFIX = "metis.file-browser.v1:";
const BROWSER_PROFILE_STORAGE_KEY = "metis.browser-profile.v1";

interface PendingFileClose {
	readonly sessionId: string;
	readonly tabId: string;
	readonly name: string;
}

interface TabMenuState {
	readonly paneId: string;
	readonly tabId: string;
	readonly x: number;
	readonly y: number;
}

interface DragState {
	readonly tabId: string;
}

type DropTarget =
	| { readonly paneId: string; readonly index: number }
	| { readonly splitBeside: string };

interface SessionWorkspaceViewProps {
	readonly api: MetisDesktopApi;
	readonly chat: ReactNode;
	readonly chatCwd: string | null;
	readonly chatFocusRequest: { readonly nonce: number; readonly sessionId: string | null } | null;
	readonly chatIsDraft: boolean;
	readonly chatSessionId: string | null;
	readonly cleanupSessionIds: readonly string[];
	readonly mode: AgentMode;
	readonly onActivateSession: (sessionId: string) => void;
	readonly onChatSession: (sessionId: string | null) => void;
	readonly onCleanupSessionIdsHandled: (sessionIds: readonly string[]) => void;
	readonly onDirtySessionIdsChange: (sessionIds: readonly string[]) => void;
	readonly onError: (cause: unknown) => void;
	readonly onNewSession?: (target: { readonly mode: AgentMode; readonly cwd: string } | null) => void;
	readonly planPreviewRequest?: PlanView | null;
	readonly previewRequest?: UniversalPreviewTarget | null;
	readonly knowledgeRequest?: { readonly id: number; readonly sessionId: string };
	readonly process?: SessionProcessView;
	readonly sessionsById: ReadonlyMap<string, Pick<SessionSummary, "sessionId" | "cwd" | "mode">>;
	readonly sessionTitleFor: (sessionId: string) => string;
	readonly store: AppStore;
	readonly theme: "dark" | "light";
	readonly visible: boolean;
}

interface StoredFileWorkspace {
	readonly version: 1;
	readonly cwd: string;
	readonly fixedPaths: readonly string[];
	readonly expandedPaths: readonly string[];
}

function isRelativeWorkspacePath(value: unknown): value is string {
	return typeof value === "string"
		&& value.length > 0
		&& value.length <= 4_096
		&& !value.startsWith("/")
		&& !value.includes("\\")
		&& value.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

function loadStoredFiles(sessionId: string, cwd: string): StoredFileWorkspace {
	const empty: StoredFileWorkspace = { version: 1, cwd, fixedPaths: [], expandedPaths: [] };
	try {
		const value = JSON.parse(localStorage.getItem(`${FILE_BROWSER_STORAGE_PREFIX}${sessionId}`) ?? "null") as Partial<StoredFileWorkspace> | null;
		if (value?.version !== 1 || value.cwd !== cwd) return empty;
		return {
			version: 1,
			cwd,
			fixedPaths: Array.isArray(value.fixedPaths) ? value.fixedPaths.filter(isRelativeWorkspacePath).slice(0, 64) : [],
			expandedPaths: Array.isArray(value.expandedPaths) ? value.expandedPaths.filter(isRelativeWorkspacePath).slice(0, 256) : [],
		};
	} catch {
		return empty;
	}
}

function saveStoredFiles(sessionId: string, cwd: string, tabs: readonly WorkspaceTab[], expandedPaths: readonly string[]): void {
	const value: StoredFileWorkspace = {
		version: 1,
		cwd,
		fixedPaths: tabs.flatMap((tab) =>
			tab.kind === "file" && tab.sessionId === sessionId && tab.fixed && tab.relativePath ? [tab.relativePath] : []).slice(0, 64),
		expandedPaths: expandedPaths.filter(isRelativeWorkspacePath).slice(0, 256),
	};
	localStorage.setItem(`${FILE_BROWSER_STORAGE_PREFIX}${sessionId}`, JSON.stringify(value));
}

function displayFileName(relativePath: string): string {
	return relativePath.split("/").at(-1) ?? relativePath;
}

function pathIsWithin(path: string, parent: string): boolean {
	return path === parent || path.startsWith(`${parent}/`);
}

function remapPath(path: string, previous: string, next: string): string {
	return path === previous ? next : `${next}${path.slice(previous.length)}`;
}

function workspaceSeed(chatSessionId: string | null): SessionWorkspace {
	const workspace = defaultWorkspace();
	const tab = chatTab(chatSessionId);
	return {
		...workspace,
		panes: [{ ...workspace.panes[0]!, tabs: [tab], activeId: tab.id }],
	};
}

// Keeps one chat tab per session in sync with the projected session. A draft
// tab adopts the real sessionId when it materializes; a stale draft tab is
// removed once the draft is gone. `pendingSessionId` forces focus onto the
// projected session's tab while an explicit focus request is in flight.
function syncChatTabs(
	workspace: SessionWorkspace,
	chatSessionId: string | null,
	chatIsDraft: boolean,
	pendingSessionId: string | null | undefined,
): SessionWorkspace {
	const pane = activePane(workspace);
	const activeTab = pane.tabs.find((tab) => tab.id === pane.activeId);
	const shouldFocus = activeTab === undefined || activeTab.kind === "chat"
		|| pendingSessionId === chatSessionId;
	if (chatIsDraft) {
		const draftTab = findChatTab(workspace, null);
		if (chatSessionId === null) {
			let next = draftTab ? workspace : addTab(workspace, chatTab(null), workspace.activePaneId, false);
			if (shouldFocus) next = activateTab(next, findChatTab(next, null)!.id);
			return next;
		}
		let next = workspace;
		if (draftTab) {
			next = {
				...next,
				panes: next.panes.map((candidate) => ({
					...candidate,
					tabs: candidate.tabs.map((tab) => tab.id === draftTab.id ? { ...tab, sessionId: chatSessionId } : tab),
				})),
			};
		}
		if (!findChatTab(next, chatSessionId)) next = addTab(next, chatTab(chatSessionId), next.activePaneId, false);
		if (shouldFocus) next = activateTab(next, findChatTab(next, chatSessionId)!.id);
		return next;
	}
	if (chatSessionId === null) return workspace;
	let next = workspace;
	const staleDraft = findChatTab(next, null);
	if (staleDraft) next = removeTab(next, staleDraft.id);
	if (!findChatTab(next, chatSessionId)) next = addTab(next, chatTab(chatSessionId), next.activePaneId, false);
	if (shouldFocus) next = activateTab(next, findChatTab(next, chatSessionId)!.id);
	return next;
}

export function SessionWorkspaceView({
	api,
	chat,
	chatCwd,
	chatFocusRequest,
	chatIsDraft,
	chatSessionId,
	cleanupSessionIds,
	mode,
	onActivateSession,
	onChatSession,
	onCleanupSessionIdsHandled,
	onDirtySessionIdsChange,
	onError,
	onNewSession,
	planPreviewRequest,
	previewRequest,
	knowledgeRequest,
	process,
	sessionsById,
	sessionTitleFor,
	store,
	theme,
	visible,
}: SessionWorkspaceViewProps) {
	const { t } = useTranslation();
	const [workspace, setWorkspace] = useState<SessionWorkspace>(() => workspaceSeed(chatSessionId));
	const [expandedBySession, setExpandedBySession] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
	const [fileDrafts, setFileDrafts] = useState<ReadonlyMap<string, WorkspaceFileDraft>>(new Map());
	const [savingFileTabIds, setSavingFileTabIds] = useState<ReadonlySet<string>>(new Set());
	const [pendingFileClose, setPendingFileClose] = useState<PendingFileClose | null>(null);
	const [menuTarget, setMenuTarget] = useState<{ readonly paneId: string } | null>(null);
	const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null);
	const [dragState, setDragState] = useState<DragState | null>(null);
	const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
	const [browserProfiles, setBrowserProfiles] = useState<readonly DesktopBrowserProfile[]>([{
		profileId: DEFAULT_BROWSER_PROFILE_ID,
		name: "Default",
		sourceId: null,
		sourceProfileId: null,
	}]);
	const browserProfilesRef = useRef(browserProfiles);
	browserProfilesRef.current = browserProfiles;
	const browserProfilesRevision = useRef(0);
	const preferredBrowserProfileId = useRef(localStorage.getItem(BROWSER_PROFILE_STORAGE_KEY));
	const menuRef = useRef<HTMLDivElement>(null);
	const panesRef = useRef<HTMLDivElement>(null);
	const panelLayerRef = useRef<HTMLDivElement>(null);
	const paneBodiesRef = useRef(new Map<string, HTMLElement>());
	const panelRectsRef = useRef(new WeakMap<HTMLElement, { x: number; y: number; width: number; height: number }>());
	const dirtySessionIds = useMemo(
		() => [...new Set(workspaceTabs(workspace).flatMap((tab) => {
			if (tab.sessionId === null) return [];
			const draft = tab.kind === "file" ? fileDrafts.get(tab.id) : undefined;
			return draft !== undefined && draft.text !== draft.savedText ? [tab.sessionId] : [];
		}))].sort(),
		[fileDrafts, workspace],
	);
	const dirtySessionKey = dirtySessionIds.join("");
	const retainedKey = useMemo(
		() => [...new Set(workspaceTabs(workspace).flatMap((tab) => (tab.sessionId === null ? [] : [tab.sessionId])))]
			.sort().join("\n"),
		[workspace],
	);

	const seenProcesses = useRef(new Map<string, string>());
	const autoOpenedProcessSessions = useRef(new Set<string>());

	const workspaceRef = useRef(workspace);
	workspaceRef.current = workspace;
	const chatSessionIdRef = useRef(chatSessionId);
	chatSessionIdRef.current = chatSessionId;
	const onChatSessionRef = useRef(onChatSession);
	onChatSessionRef.current = onChatSession;

	// The session a chat tab is about to project. Set by focus requests and by
	// chat-tab gestures until the projected session catches up; while set, the
	// sync pass treats that tab as the desired focus.
	const pendingChatFocus = useRef<string | null | undefined>(undefined);
	const handledFocusNonce = useRef(0);

	const updateWorkspace = useCallback(
		(update: (workspace: SessionWorkspace) => SessionWorkspace) => {
			setWorkspace((current) => {
				const next = update(current);
				workspaceRef.current = next;
				return next === current ? current : next;
			});
		},
		[],
	);

	// User gestures (tab click, close, drag, pane pick) report the resulting
	// focused chat straight from the mutation — no reactive effect, so the
	// projection never sees a stale commit window. Effect-driven updates go
	// through updateWorkspace and stay silent.
	const mutateWorkspace = useCallback(
		(update: (workspace: SessionWorkspace) => SessionWorkspace) => {
			const next = update(workspaceRef.current);
			if (next === workspaceRef.current) return;
			workspaceRef.current = next;
			setWorkspace(next);
			const focused = focusedChatTab(next);
			if (focused && focused.sessionId !== chatSessionIdRef.current && pendingChatFocus.current !== focused.sessionId) {
				pendingChatFocus.current = focused.sessionId;
				onChatSessionRef.current(focused.sessionId);
			}
		},
		[],
	);

	// Keep one chat tab per session in sync with the projected session. Tabs
	// adopt the draft's real sessionId when it materializes so the chat subtree
	// (and the composer's editable DOM) survives the draft -> session transition.
	useEffect(() => {
		updateWorkspace((current) => syncChatTabs(current, chatSessionId, chatIsDraft, pendingChatFocus.current));
	}, [chatIsDraft, chatSessionId, updateWorkspace]);

	// Once the projected session's tab is focused, the pending focus request is
	// satisfied and gesture reporting is free to observe the next divergence.
	const focusedChatSession = focusedChatTab(workspace)?.sessionId;
	useEffect(() => {
		if (focusedChatSession !== undefined && focusedChatSession === chatSessionId) {
			pendingChatFocus.current = undefined;
		}
	}, [chatSessionId, focusedChatSession]);

	// Sidebar opens and "new session" intents focus the chat tab explicitly. The
	// tab is created immediately only when its session is already projected;
	// otherwise the sync pass above adds it once the session lands, so a failed
	// open never leaves a dead placeholder tab.
	useEffect(() => {
		if (!chatFocusRequest || chatFocusRequest.nonce === handledFocusNonce.current) return;
		handledFocusNonce.current = chatFocusRequest.nonce;
		pendingChatFocus.current = chatFocusRequest.sessionId;
		updateWorkspace((current) => {
			const existing = findChatTab(current, chatFocusRequest.sessionId);
			if (existing) return activateTab(current, existing.id);
			return chatFocusRequest.sessionId === chatSessionId
				? addTab(current, chatTab(chatFocusRequest.sessionId))
				: current;
		});
	}, [chatFocusRequest, chatSessionId, updateWorkspace]);

	const openProcess = useCallback(() => {
		if (!chatSessionId || !process) return;
		const id = `process-${chatSessionId}`;
		const tab: WorkspaceTab = { kind: "process", id, sessionId: chatSessionId, title: "Process", process };
		updateWorkspace((current) => {
			const existing = findTabLocation(current, id);
			const replaced = existing
				? { ...current, panes: current.panes.map((pane, index) => index === existing.paneIndex
						? { ...pane, tabs: pane.tabs.map((item, tabIndex) => tabIndex === existing.tabIndex ? tab : item) }
						: pane) }
				: addTab(current, tab);
			return activateTab(replaced, id);
		});
	}, [process, chatSessionId, updateWorkspace]);

	useEffect(() => {
		if (!chatSessionId) return;
		if (!process) {
			seenProcesses.current.delete(chatSessionId);
			return;
		}
		const previousId = seenProcesses.current.get(chatSessionId);
		seenProcesses.current.set(chatSessionId, process.processId);
		if (previousId !== process.processId) {
			autoOpenedProcessSessions.current.add(chatSessionId);
			openProcess();
			return;
		}
		updateWorkspace((current) => {
			const location = findTabLocation(current, `process-${chatSessionId}`);
			if (!location) return current;
			const pane = current.panes[location.paneIndex]!;
			return {
				...current,
				panes: current.panes.map((candidate, index) => index !== location.paneIndex ? candidate : {
					...candidate,
					tabs: candidate.tabs.map((tab, tabIndex) => tabIndex === location.tabIndex && tab.kind === "process" ? { ...tab, process } : tab),
				}),
			};
		});
	}, [openProcess, process, chatSessionId, updateWorkspace]);

	useEffect(() => {
		if (!chatSessionId || !process || process.state === "running") return;
		if (!autoOpenedProcessSessions.current.has(chatSessionId)) return;
		autoOpenedProcessSessions.current.delete(chatSessionId);
		updateWorkspace((current) => {
			const chat = findChatTab(current, chatSessionId);
			return chat ? activateTab(current, chat.id) : current;
		});
	}, [process, chatSessionId, updateWorkspace]);

	useEffect(() => {
		let active = true;
		const revision = browserProfilesRevision.current;
		void api.listBrowserProfiles().then(
			(profiles) => {
				if (active && profiles.length > 0 && browserProfilesRevision.current === revision) {
					setBrowserProfiles(profiles);
				}
			},
			onError,
		);
		return () => { active = false; };
	}, [api, onError]);

	useEffect(
		() =>
			api.subscribeBrowser((event) => {
				if (event.type === "profiles") {
					if (event.profiles.length > 0) {
						browserProfilesRevision.current += 1;
						setBrowserProfiles(event.profiles);
					}
					return;
				}
				if (event.type === "opened") {
					const profile = browserProfilesRef.current.find(({ profileId }) => profileId === event.profileId);
					updateWorkspace((workspace) => {
						if (workspaceTabs(workspace).some(({ id }) => id === event.browserId)) return workspace;
						return addTab(workspace, {
							kind: "browser",
							id: event.browserId,
							sessionId: event.sessionId,
							title: t("New tab"),
							url: "",
							profileId: event.profileId,
							profileName: profile?.name ?? t("Browser"),
							controlState: "idle",
						}, workspace.activePaneId, false);
					});
					return;
				}
				if (event.type === "closed") {
					updateWorkspace((workspace) =>
						workspaceTabs(workspace).some(({ id }) => id === event.browserId)
							? removeTab(workspace, event.browserId)
							: workspace,
					);
					return;
				}
				if (event.type !== "activity" && event.type !== "handoff") return;
				updateWorkspace((workspace) => {
					let changed = false;
					const next = {
						...workspace,
						panes: workspace.panes.map((pane) => ({
							...pane,
							tabs: pane.tabs.map((tab) => {
								if (tab.kind !== "browser" || tab.id !== event.browserId) return tab;
								changed = true;
								if (event.type === "activity") {
									return { ...tab, controlState: event.active ? "agent" as const : "idle" as const, handoffReason: undefined };
								}
								return event.status === "requested"
									? { ...tab, controlState: "handoff" as const, handoffReason: event.reason }
									: { ...tab, controlState: "idle" as const, handoffReason: undefined };
							}),
						})),
					};
					if (!changed) return workspace;
					return event.type === "handoff" && event.status === "requested"
						? activateTab(next, event.browserId)
						: next;
				});
				if (event.type === "handoff" && event.status === "requested") {
					onActivateSession(event.sessionId);
				}
			}),
		[api, onActivateSession, t, updateWorkspace],
	);

	useEffect(() => {
		setMenuTarget(null);
		setTabMenu(null);
	}, [mode, chatSessionId]);
	useEffect(() => onDirtySessionIdsChange(dirtySessionIds), [dirtySessionKey, onDirtySessionIdsChange]);
	useEffect(() => {
		void api.retainWorkspaceSessions({ sessionIds: retainedKey === "" ? [] : retainedKey.split("\n") }).catch(onError);
	}, [api, retainedKey, onError]);
	useEffect(() => {
		if (cleanupSessionIds.length === 0) return;
		const removedSessions = new Set(cleanupSessionIds);
		const removedTabIds = new Set<string>();
		for (const tab of workspaceTabs(workspace)) {
			if (tab.sessionId === null || !removedSessions.has(tab.sessionId)) continue;
			removedTabIds.add(tab.id);
			if (tab.kind === "terminal") void api.closeTerminal({ terminalId: tab.id }).catch(onError);
			else if (tab.kind === "browser") void api.closeBrowser({ sessionId: tab.sessionId, browserId: tab.id }).catch(onError);
		}
		for (const ownerSessionId of cleanupSessionIds) {
			previewBytesCache.deleteSession(ownerSessionId);
			try {
				localStorage.removeItem(`${FILE_BROWSER_STORAGE_PREFIX}${ownerSessionId}`);
			} catch (cause) {
				onError(cause);
			}
		}
		updateWorkspace((current) => removeTabs(current, removedTabIds));
		setExpandedBySession((current) => new Map([...current].filter(([id]) => !removedSessions.has(id))));
		setFileDrafts((current) => new Map([...current].filter(([id]) => !removedTabIds.has(id))));
		setSavingFileTabIds((current) => new Set([...current].filter((id) => !removedTabIds.has(id))));
		setPendingFileClose((current) => current && removedSessions.has(current.sessionId) ? null : current);
		onCleanupSessionIdsHandled(cleanupSessionIds);
	}, [api, cleanupSessionIds, onCleanupSessionIdsHandled, onError, updateWorkspace, workspace]);

	useEffect(() => {
		if (!menuTarget && !tabMenu) return;
		const close = (event: PointerEvent) => {
			const target = event.target as Node;
			if (menuRef.current?.contains(target)) return;
			if ((target as HTMLElement | null)?.closest?.(".workspace-tab-menu")) return;
			setMenuTarget(null);
			setTabMenu(null);
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setMenuTarget(null);
				setTabMenu(null);
			}
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", escape);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", escape);
		};
	}, [menuTarget, tabMenu]);

	useEffect(() => {
		if (!pendingFileClose) return;
		const cancel = (event: KeyboardEvent) => {
			if (event.key === "Escape") setPendingFileClose(null);
		};
		document.addEventListener("keydown", cancel);
		return () => document.removeEventListener("keydown", cancel);
	}, [pendingFileClose]);

	useEffect(() => {
		if (!previewRequest) return;
		updateWorkspace((workspace) => {
			const existing = workspaceTabs(workspace).find(
				(tab): tab is Extract<WorkspaceTab, { kind: "preview" }> =>
					tab.kind === "preview" &&
					tab.sessionId === previewRequest.sessionId &&
					tab.file.source === previewRequest.source &&
					(previewRequest.fileId ? tab.file.fileId === previewRequest.fileId : tab.file.relativePath === previewRequest.relativePath),
			);
			if (existing) return activateTab(workspace, existing.id);
			const tab: WorkspaceTab = {
				kind: "preview",
				id: crypto.randomUUID(),
				sessionId: previewRequest.sessionId,
				title: previewRequest.name,
				file: previewRequest,
			};
			return addTab(workspace, tab);
		});
	}, [previewRequest, updateWorkspace]);

	useEffect(() => {
		if (!planPreviewRequest || !chatSessionId) return;
		const sessionId = chatSessionId;
		updateWorkspace((workspace) => {
			const existing = workspaceTabs(workspace).find(
				(tab): tab is Extract<WorkspaceTab, { kind: "plan" }> =>
					tab.kind === "plan" && tab.sessionId === sessionId && tab.plan.planId === planPreviewRequest.planId,
			);
			if (existing) {
				return activateTab({
					...workspace,
					panes: workspace.panes.map((pane) => ({
						...pane,
						tabs: pane.tabs.map((tab) =>
							tab.kind === "plan" && tab.plan.planId === planPreviewRequest.planId
								? { ...tab, title: planPreviewRequest.title, plan: planPreviewRequest }
								: tab,
						),
					})),
				}, existing.id);
			}
			return addTab(workspace, {
				kind: "plan",
				id: planPreviewRequest.planId,
				sessionId,
				title: planPreviewRequest.title,
				plan: planPreviewRequest,
			});
		});
	}, [planPreviewRequest, chatSessionId, updateWorkspace]);

	// A pane's tool target is the session of its current tab, falling back to
	// the projected session when the pane is empty.
	const paneTarget = (paneId: string): { sessionId: string | null; cwd: string | null } => {
		const pane = workspace.panes.find((candidate) => candidate.id === paneId);
		const active = pane?.tabs.find((tab) => tab.id === pane.activeId);
		const sessionId = active?.sessionId ?? chatSessionId;
		if (sessionId === null) return { sessionId: null, cwd: null };
		return { sessionId, cwd: sessionsById.get(sessionId)?.cwd ?? (sessionId === chatSessionId ? chatCwd : null) };
	};

	const addTerminal = (paneId: string) => {
		const { sessionId: ownerSessionId, cwd } = paneTarget(paneId);
		if (!ownerSessionId || !cwd) return;
		const id = crypto.randomUUID();
		updateWorkspace((workspace) => {
			const number = workspace.nextNumber;
			const tab: WorkspaceTab = {
				kind: "terminal",
				id,
				sessionId: ownerSessionId,
				cwd,
				title: number === 1 ? t("Terminal") : t("Terminal {{number}}", { number }),
			};
			return { ...addTab(workspace, tab, paneId), nextNumber: number + 1 };
		});
		setMenuTarget(null);
	};

	const addBrowser = (
		paneId: string,
		profile = browserProfiles.find((candidate) => candidate.profileId === preferredBrowserProfileId.current)
			?? browserProfiles[0],
	) => {
		const { sessionId: ownerSessionId } = paneTarget(paneId);
		if (!ownerSessionId || !profile) return;
		preferredBrowserProfileId.current = profile.profileId;
		try {
			localStorage.setItem(BROWSER_PROFILE_STORAGE_KEY, profile.profileId);
		} catch {
			// Browsing still works when preference storage is unavailable.
		}
		const id = crypto.randomUUID();
		const tab: WorkspaceTab = {
			kind: "browser",
			id,
			sessionId: ownerSessionId,
			title: t("New tab"),
			url: "",
			profileId: profile.profileId,
			profileName: profile.name,
			controlState: "idle",
		};
		updateWorkspace((workspace) => addTab(workspace, tab, paneId));
		setMenuTarget(null);
	};

	const browserProfileImported = (profile: DesktopBrowserProfile) => {
		setBrowserProfiles((current) => current.some((candidate) => candidate.profileId === profile.profileId)
			? current.map((candidate) => candidate.profileId === profile.profileId ? profile : candidate)
			: [...current, profile]);
		addBrowser(activePane(workspace).id, profile);
	};

	const addFiles = (paneId: string) => {
		const { sessionId: ownerSessionId, cwd } = paneTarget(paneId);
		if (!ownerSessionId || !cwd || mode !== "code") return;
		const stored = loadStoredFiles(ownerSessionId, cwd);
		setExpandedBySession((values) => {
			if (values.has(ownerSessionId)) return values;
			const next = new Map(values);
			next.set(ownerSessionId, stored.expandedPaths);
			return next;
		});
		updateWorkspace((workspace) => {
			const existing = [...workspaceTabs(workspace)].reverse().find((tab) => tab.kind === "file" && tab.sessionId === ownerSessionId);
			if (existing) return activateTab(workspace, existing.id);
			const restored: WorkspaceTab[] = stored.fixedPaths.map((relativePath) => ({
				kind: "file" as const,
				id: crypto.randomUUID(),
				sessionId: ownerSessionId,
				title: displayFileName(relativePath),
				cwd,
				relativePath,
				fixed: true,
			}));
			const files = restored.length > 0 ? restored : [{
				kind: "file" as const,
				id: crypto.randomUUID(),
				sessionId: ownerSessionId,
				title: t("Open file"),
				cwd,
				relativePath: null,
				fixed: false,
			}];
			const withAll = files.reduce((acc, tab) => addTab(acc, tab, paneId), workspace);
			return activateTab(withAll, files[0]!.id);
		});
		setMenuTarget(null);
	};

	const addReview = (paneId: string) => {
		const { sessionId: ownerSessionId, cwd } = paneTarget(paneId);
		if (!ownerSessionId || !cwd || mode !== "code") return;
		updateWorkspace((workspace) => {
			const existing = workspaceTabs(workspace).find((tab) => tab.kind === "review" && tab.sessionId === ownerSessionId);
			if (existing) return activateTab(workspace, existing.id);
			const tab: WorkspaceTab = { kind: "review", id: crypto.randomUUID(), sessionId: ownerSessionId, title: t("Review") };
			return addTab(workspace, tab, paneId);
		});
		setMenuTarget(null);
	};

	const addAgent = (paneId: string) => {
		const { sessionId: ownerSessionId } = paneTarget(paneId);
		if (!ownerSessionId || mode !== "code") return;
		updateWorkspace((workspace) => {
			const existing = workspaceTabs(workspace).find((tab) => tab.kind === "agent" && tab.sessionId === ownerSessionId);
			const tab: WorkspaceTab = existing ?? { kind: "agent", id: crypto.randomUUID(), sessionId: ownerSessionId, title: t("Agents") };
			return existing ? activateTab(workspace, existing.id) : addTab(workspace, tab, paneId);
		});
		setMenuTarget(null);
	};

	const addKnowledge = useCallback((targetSessionId: string | null, paneId?: string) => {
		if (!targetSessionId) return;
		updateWorkspace((workspace) => {
			const existing = workspaceTabs(workspace).find((tab) => tab.kind === "knowledge" && tab.sessionId === targetSessionId);
			const tab: WorkspaceTab = existing ?? { kind: "knowledge", id: crypto.randomUUID(), sessionId: targetSessionId, title: t("Knowledge") };
			return existing
				? activateTab(workspace, existing.id)
				: addTab(workspace, tab, paneId ?? workspace.activePaneId);
		});
		setMenuTarget(null);
	}, [t, updateWorkspace]);
	const handledKnowledgeRequest = useRef<number | undefined>(undefined);
	useEffect(() => {
		if (!knowledgeRequest || knowledgeRequest.id === handledKnowledgeRequest.current) return;
		handledKnowledgeRequest.current = knowledgeRequest.id;
		addKnowledge(knowledgeRequest.sessionId);
	}, [addKnowledge, knowledgeRequest]);

	const openFile = (ownerSessionId: string, cwd: string, relativePath: string, fix: boolean, paneId: string) => {
		mutateWorkspace((workspace) => {
			const existing = workspaceTabs(workspace).find((tab) => tab.kind === "file" && tab.sessionId === ownerSessionId && tab.relativePath === relativePath);
			let next = workspace;
			if (existing) {
				next = activateTab(workspace, existing.id);
				if (fix && existing.kind === "file" && !existing.fixed) {
					next = {
						...next,
						panes: next.panes.map((pane) => ({
							...pane,
							tabs: pane.tabs.map((tab) => tab.id === existing.id && tab.kind === "file" ? { ...tab, fixed: true } : tab),
						})),
					};
				}
			} else {
				const preview = workspaceTabs(workspace).find((tab) => tab.kind === "file" && tab.sessionId === ownerSessionId && !tab.fixed);
				const nextTab: WorkspaceTab = {
					kind: "file",
					id: preview?.id ?? crypto.randomUUID(),
					sessionId: ownerSessionId,
					title: displayFileName(relativePath),
					cwd,
					relativePath,
					fixed: fix,
				};
				if (preview) {
					const location = findTabLocation(workspace, preview.id);
					next = {
						...workspace,
						panes: workspace.panes.map((pane, index) => index === location?.paneIndex
							? { ...pane, tabs: pane.tabs.map((tab) => tab.id === preview.id ? nextTab : tab) }
							: pane),
					};
					next = activateTab(next, nextTab.id);
				} else {
					next = addTab(workspace, nextTab, paneId);
				}
			}
			saveStoredFiles(
				ownerSessionId,
				cwd,
				workspaceTabs(next),
				expandedBySession.get(ownerSessionId) ?? loadStoredFiles(ownerSessionId, cwd).expandedPaths,
			);
			return next;
		});
	};

	const loadFileDraft = (tabId: string, file: WorkspaceFileDraft["file"]) => {
		setFileDrafts((current) => {
			const existing = current.get(tabId);
			if (
				existing?.file.relativePath === file.relativePath &&
				(existing.text !== existing.savedText || existing.file.revision === file.revision)
			) return current;
			return new Map(current).set(tabId, { file, savedText: file.text, text: file.text });
		});
	};

	const updateFileDraft = (ownerSessionId: string, tabId: string, text: string) => {
		setFileDrafts((current) => {
			const draft = current.get(tabId);
			if (!draft) return current;
			return new Map(current).set(tabId, { ...draft, text });
		});
		mutateWorkspace((workspace) => {
			const fileTab = workspaceTabs(workspace).find((tab): tab is Extract<WorkspaceTab, { kind: "file" }> =>
				tab.kind === "file" && tab.id === tabId,
			);
			if (!fileTab || fileTab.fixed) return workspace;
			const next = {
				...workspace,
				panes: workspace.panes.map((pane) => ({
					...pane,
					tabs: pane.tabs.map((tab) => tab.id === tabId ? { ...fileTab, fixed: true } : tab),
				})),
			};
			saveStoredFiles(
				ownerSessionId,
				fileTab.cwd,
				workspaceTabs(next),
				expandedBySession.get(ownerSessionId) ?? loadStoredFiles(ownerSessionId, fileTab.cwd).expandedPaths,
			);
			return next;
		});
	};

	const saveFileTab = async (ownerSessionId: string, tabId: string): Promise<void> => {
		const tab = workspaceTabs(workspace).find((candidate) => candidate.id === tabId);
		const draft = fileDrafts.get(tabId);
		if (
			!tab ||
			tab.kind !== "file" ||
			!tab.relativePath ||
			!draft ||
			draft.text === draft.savedText ||
			savingFileTabIds.has(tabId)
		) return;
		const textToSave = draft.text;
		setSavingFileTabIds((current) => new Set(current).add(tabId));
		try {
			const result = await api.writeWorkspaceFile({
				sessionId: ownerSessionId,
				relativePath: tab.relativePath,
				text: textToSave,
				expectedRevision: draft.file.revision,
			});
			setFileDrafts((current) => {
				const latest = current.get(tabId);
				if (!latest) return current;
				return new Map(current).set(tabId, {
					file: {
						...latest.file,
						text: textToSave,
						revision: result.revision,
						byteLength: result.byteLength,
					},
					savedText: textToSave,
					text: latest.text,
				});
			});
		} catch (cause) {
			const message = cause instanceof Error ? cause.message : String(cause);
			for (const expected of ["Workspace file changed on disk", "Workspace file is too large to save"]) {
				if (message.includes(expected)) throw new Error(expected);
			}
			throw cause;
		} finally {
			setSavingFileTabIds((current) => {
				const next = new Set(current);
				next.delete(tabId);
				return next;
			});
		}
	};

	const updateExpandedPaths = (ownerSessionId: string, cwd: string, paths: readonly string[]) => {
		setExpandedBySession((current) => {
			const next = new Map(current);
			next.set(ownerSessionId, paths);
			return next;
		});
		saveStoredFiles(ownerSessionId, cwd, workspaceTabs(workspace), paths);
	};

	const applyWorkspaceMutation = (ownerSessionId: string, cwd: string, result: DesktopWorkspaceMutationResult, paneId: string) => {
		if (result.action === "create") {
			if (result.kind === "file") openFile(ownerSessionId, cwd, result.relativePath, true, paneId);
			return;
		}

		if (result.action === "trash") {
			const removedIds = new Set(workspaceTabs(workspace).flatMap((tab) =>
				tab.kind === "file" && tab.sessionId === ownerSessionId
					&& tab.relativePath && pathIsWithin(tab.relativePath, result.previousRelativePath)
					? [tab.id] : [],
			));
			const expandedPaths = (expandedBySession.get(ownerSessionId) ?? [])
				.filter((path) => !pathIsWithin(path, result.previousRelativePath));
			setExpandedBySession((current) => new Map(current).set(ownerSessionId, expandedPaths));
			setFileDrafts((current) => new Map([...current].filter(([id]) => !removedIds.has(id))));
			mutateWorkspace((latest) => {
				let next = removeTabs(latest, removedIds);
				if (!workspaceTabs(next).some((tab) => tab.kind === "file" && tab.sessionId === ownerSessionId)) {
					const pane = activePane(next);
					const placeholder: WorkspaceTab = {
						kind: "file",
						id: crypto.randomUUID(),
						sessionId: ownerSessionId,
						title: t("Open file"),
						cwd,
						relativePath: null,
						fixed: false,
					};
					next = activateTab({
						...next,
						panes: next.panes.map((candidate) => candidate.id === pane.id ? {
							...candidate,
							tabs: [...candidate.tabs, placeholder],
						} : candidate),
					}, placeholder.id);
				}
				saveStoredFiles(ownerSessionId, cwd, workspaceTabs(next), expandedPaths);
				return next;
			});
			return;
		}

		setFileDrafts((current) => new Map([...current].map(([id, draft]) => {
			if (!pathIsWithin(draft.file.relativePath, result.previousRelativePath)) return [id, draft] as const;
			return [id, {
				...draft,
				file: {
					...draft.file,
					relativePath: remapPath(draft.file.relativePath, result.previousRelativePath, result.relativePath),
					absolutePath: remapPath(draft.file.absolutePath, result.previousAbsolutePath, result.absolutePath),
				},
			}] as const;
		})));
		const expandedPaths = (expandedBySession.get(ownerSessionId) ?? []).map((path) =>
			pathIsWithin(path, result.previousRelativePath)
				? remapPath(path, result.previousRelativePath, result.relativePath)
				: path,
		);
		setExpandedBySession((current) => new Map(current).set(ownerSessionId, expandedPaths));
		mutateWorkspace((latest) => {
			const next = {
				...latest,
				panes: latest.panes.map((pane) => ({
					...pane,
					tabs: pane.tabs.map((tab) => {
						if (tab.kind !== "file" || tab.sessionId !== ownerSessionId || !tab.relativePath || !pathIsWithin(tab.relativePath, result.previousRelativePath)) return tab;
						const relativePath = remapPath(tab.relativePath, result.previousRelativePath, result.relativePath);
						return { ...tab, relativePath, title: displayFileName(relativePath) };
					}),
				})),
			};
			saveStoredFiles(ownerSessionId, cwd, workspaceTabs(next), expandedPaths);
			return next;
		});
	};

	const selectTab = (id: string) => {
		mutateWorkspace((workspace) => activateTab(workspace, id));
	};

	const removeTabInternal = (id: string) => {
		const closing = workspaceTabs(workspace).find((tab) => tab.id === id);
		if (!closing) return;
		if (closing.kind === "terminal") void api.closeTerminal({ terminalId: id }).catch(onError);
		else if (closing.kind === "browser") void api.closeBrowser({ sessionId: closing.sessionId, browserId: id }).catch(onError);
		else if (closing.kind === "agent" && closing.sessionId === chatSessionId) store.selectAgentTranscript(null);
		setFileDrafts((current) => {
			if (!current.has(id)) return current;
			const next = new Map(current);
			next.delete(id);
			return next;
		});
		mutateWorkspace((workspace) => {
			const next = removeTab(workspace, id);
			if (closing.kind === "file") {
				saveStoredFiles(
					closing.sessionId,
					closing.cwd,
					workspaceTabs(next),
					expandedBySession.get(closing.sessionId) ?? loadStoredFiles(closing.sessionId, closing.cwd).expandedPaths,
				);
			}
			return next;
		});
	};

	const closeTab = (id: string) => {
		const closing = workspaceTabs(workspace).find((tab) => tab.id === id);
		if (!closing || savingFileTabIds.has(id)) return;
		if (closing.kind === "file") {
			const draft = fileDrafts.get(id);
			if (draft && draft.text !== draft.savedText) {
				setPendingFileClose({ sessionId: closing.sessionId, tabId: id, name: closing.title });
				return;
			}
		}
		removeTabInternal(id);
	};

	const discardPendingFile = () => {
		if (!pendingFileClose) return;
		removeTabInternal(pendingFileClose.tabId);
		setPendingFileClose(null);
	};

	const saveAndClosePendingFile = async () => {
		if (!pendingFileClose) return;
		try {
			await saveFileTab(pendingFileClose.sessionId, pendingFileClose.tabId);
			removeTabInternal(pendingFileClose.tabId);
			setPendingFileClose(null);
		} catch (cause) {
			onError(cause);
		}
	};

	const updateBrowserState = (state: DesktopBrowserState) => {
		updateWorkspace((workspace) => {
			let changed = false;
			const panes = workspace.panes.map((pane) => ({
				...pane,
				tabs: pane.tabs.map((tab) => {
					if (tab.kind !== "browser" || tab.id !== state.browserId) return tab;
					changed = tab.title !== state.title || tab.url !== state.url;
					return changed ? { ...tab, title: state.title, url: state.url } : tab;
				}),
			}));
			return changed ? { ...workspace, panes } : workspace;
		});
	};

	const handleDropOnStrip = (paneId: string, index: number) => {
		const drag = dragState;
		setDragState(null);
		setDropTarget(null);
		if (!drag) return;
		mutateWorkspace((workspace) => moveTab(workspace, drag.tabId, paneId, index));
	};

	const handleDropSplit = (besidePaneId: string) => {
		const drag = dragState;
		setDragState(null);
		setDropTarget(null);
		if (!drag) return;
		mutateWorkspace((workspace) => splitTabBeside(workspace, drag.tabId, besidePaneId));
	};

	const stripDropIndex = (event: DragEvent<HTMLElement>): number => {
		const strip = event.currentTarget;
		const tabs = [...strip.querySelectorAll<HTMLElement>(".tool-tab")];
		let index = tabs.length;
		for (let i = 0; i < tabs.length; i += 1) {
			const rect = tabs[i]!.getBoundingClientRect();
			if (event.clientX < rect.left + rect.width / 2) {
				index = i;
				break;
			}
		}
		return index;
	};

	const toolMenu = (paneId: string) => {
		const target = paneTarget(paneId);
		const targetMode = target.sessionId === null ? mode : (sessionsById.get(target.sessionId)?.mode ?? mode);
		const sessionTarget = target.sessionId === null || target.cwd === null
			? null
			: { mode: sessionsById.get(target.sessionId)?.mode ?? mode, cwd: target.cwd };
		return (
		<nav
			aria-label={t("Available tools")}
			className="tool-add-menu"
			role="menu"
		>
			<button disabled={!target.sessionId} onClick={() => addKnowledge(target.sessionId, paneId)} role="menuitem" type="button">
				<div className="tool-menu-icon"><Books aria-hidden="true" size={14} /></div>
				<span>{t("Knowledge")}</span>
			</button>
			{targetMode === "code" && (
				<button disabled={!target.cwd} onClick={() => addReview(paneId)} role="menuitem" title={target.cwd ? undefined : t("Open a task before reviewing changes")} type="button">
					<div className="tool-menu-icon"><ClipboardText aria-hidden="true" size={14} /></div>
					<span>{t("Review")}</span>
				</button>
			)}
			<button disabled={!target.cwd} onClick={() => addTerminal(paneId)} role="menuitem" title={target.cwd ? undefined : t("Open a task before starting a terminal")} type="button">
				<div className="tool-menu-icon"><TerminalWindow aria-hidden="true" size={14} /></div>
				<span>{t("Terminal")}</span>
			</button>
			<button disabled={!target.sessionId} onClick={() => addBrowser(paneId)} role="menuitem" title={target.sessionId ? undefined : t("Open a task before starting a browser")} type="button">
				<div className="tool-menu-icon"><Globe aria-hidden="true" size={14} /></div>
				<span>{t("Browser")}</span>
			</button>
			{targetMode === "code" && (
				<button disabled={!target.cwd} onClick={() => addFiles(paneId)} role="menuitem" title={target.cwd ? undefined : t("Open a task before browsing files")} type="button">
					<div className="tool-menu-icon"><FileText aria-hidden="true" size={14} /></div>
					<span>{t("Files")}</span>
				</button>
			)}
			{targetMode === "code" && (
				<button disabled={!target.sessionId} onClick={() => addAgent(paneId)} role="menuitem" type="button">
					<div className="tool-menu-icon"><Robot aria-hidden="true" size={14} /></div>
					<span>{t("Agents")}</span>
				</button>
			)}
			<div aria-hidden="true" className="workspace-add-menu-separator" />
			<button onClick={() => { onNewSession?.(sessionTarget); setMenuTarget(null); }} role="menuitem" type="button">
				<div className="tool-menu-icon"><ChatCircle aria-hidden="true" size={14} /></div>
				<span>{t("New session")}</span>
			</button>
		</nav>
		);
	};

	const layoutPanels = useCallback(() => {
		const root = panesRef.current;
		const layer = panelLayerRef.current;
		if (!root || !layer) return;
		const rootRect = root.getBoundingClientRect();
		for (const panel of layer.querySelectorAll<HTMLElement>(".workspace-panel")) {
			const body = paneBodiesRef.current.get(panel.dataset.paneId ?? "");
			if (!body) continue;
			const rect = body.getBoundingClientRect();
			const next = {
				x: rect.left - rootRect.left,
				y: rect.top - rootRect.top,
				width: rect.width,
				height: rect.height,
			};
			const previous = panelRectsRef.current.get(panel);
			if (
				previous?.x === next.x && previous.y === next.y
				&& previous.width === next.width && previous.height === next.height
			) continue;
			panelRectsRef.current.set(panel, next);
			panel.style.transform = `translate(${next.x}px, ${next.y}px)`;
			panel.style.width = `${next.width}px`;
			panel.style.height = `${next.height}px`;
			panel.dispatchEvent(new Event("workspace-panel-layout"));
		}
	}, []);

	useLayoutEffect(() => {
		layoutPanels();
	}, [layoutPanels, workspace, chatSessionId, chatIsDraft, visible]);

	useEffect(() => {
		const observer = new ResizeObserver(layoutPanels);
		if (panesRef.current) observer.observe(panesRef.current);
		for (const body of paneBodiesRef.current.values()) observer.observe(body);
		return () => observer.disconnect();
	}, [layoutPanels, workspace, chatSessionId, visible]);

	const renderTabStrip = (pane: WorkspacePane) => (
		<div
			className={`workspace-tabbar${dropTarget && "paneId" in dropTarget && dropTarget.paneId === pane.id ? " is-drop-target" : ""}`}
			onDragLeave={() => setDropTarget((current) => current && "paneId" in current && current.paneId === pane.id ? null : current)}
			onDragOver={(event) => {
				if (!dragState) return;
				event.preventDefault();
				event.stopPropagation();
				event.dataTransfer.dropEffect = "move";
				setDropTarget({ paneId: pane.id, index: stripDropIndex(event) });
			}}
			onDrop={(event) => {
				event.preventDefault();
				event.stopPropagation();
				handleDropOnStrip(pane.id, stripDropIndex(event));
			}}
			role="tablist"
		>
			<div className="tool-tabs-scroll">
				{pane.tabs.map((tab) => {
					const displayTitle = tab.kind === "chat"
						? (tab.sessionId === null ? t("New task") : sessionTitleFor(tab.sessionId))
						: tab.kind === "browser" && tab.url === ""
							? t("New tab")
							: tab.kind === "file" && tab.relativePath === null ? t("Open file") : tab.title;
					const draft = tab.kind === "file" ? fileDrafts.get(tab.id) : undefined;
					const dirty = draft !== undefined && draft.text !== draft.savedText;
					const saving = savingFileTabIds.has(tab.id);
					return (
						<div
							className={`tool-tab${pane.activeId === tab.id ? " is-active" : ""}${tab.kind === "file" && !tab.fixed ? " is-preview" : ""}${dirty ? " is-dirty" : ""}`}
							draggable
							key={tab.id}
							onDragEnd={() => { setDragState(null); setDropTarget(null); }}
							onDragStart={(event) => {
								event.dataTransfer.setData("text/plain", tab.id);
								event.dataTransfer.effectAllowed = "move";
								setDragState({ tabId: tab.id });
							}}
							onContextMenu={(event) => {
								event.preventDefault();
								setMenuTarget(null);
								setTabMenu({ paneId: pane.id, tabId: tab.id, x: event.clientX, y: event.clientY });
							}}
						>
							<button
								aria-selected={pane.activeId === tab.id}
								aria-label={dirty ? `${displayTitle}, ${t("Unsaved")}` : displayTitle}
								className="tool-tab-select"
								onClick={() => selectTab(tab.id)}
								role="tab"
								type="button"
							>
								{tab.kind === "chat" ? <ChatCircle aria-hidden="true" size={13} />
									: tab.kind === "knowledge" ? <Books aria-hidden="true" size={13} />
									: tab.kind === "terminal" || tab.kind === "process" ? <TerminalWindow aria-hidden="true" size={13} />
									: tab.kind === "browser" ? <Globe aria-hidden="true" size={13} />
									: tab.kind === "file" ? (tab.relativePath ? <WorkspaceFileIcon path={tab.relativePath} size={13} /> : <FileText aria-hidden="true" size={13} />)
									: tab.kind === "review" ? <ClipboardText aria-hidden="true" size={13} />
									: tab.kind === "agent" ? <Robot aria-hidden="true" size={13} />
									: tab.kind === "plan" ? <FileText aria-hidden="true" size={13} />
									: tab.kind === "preview" ? <WorkspaceFileIcon path={tab.title} size={13} /> : null}
								<span>{displayTitle}</span>
								{dirty && <span aria-hidden="true" className="tool-tab-dirty" />}
							</button>
							<button
								aria-label={t("Close {{name}}", { name: displayTitle })}
								className="tool-tab-close"
								disabled={saving}
								onClick={() => closeTab(tab.id)}
								type="button"
							>
								<X aria-hidden="true" size={11} />
							</button>
						</div>
					);
				})}
			</div>
			<div className="tool-add" ref={menuTarget?.paneId === pane.id ? menuRef : undefined}>
				<button
					aria-expanded={menuTarget?.paneId === pane.id}
					aria-haspopup="menu"
					aria-label={t("Add tool")}
					className="tool-add-trigger"
					onClick={() => setMenuTarget((current) => current?.paneId === pane.id ? null : { paneId: pane.id })}
					type="button"
				>
					<Plus aria-hidden="true" size={13} />
				</button>
				{menuTarget?.paneId === pane.id && toolMenu(pane.id)}
			</div>
		</div>
	);

	// Tabs bound to the transcript projection (chat, agent tree) show a focus
	// prompt while another session is projected; every other tool talks to the
	// desktop API by sessionId and stays live for any session.
	const sessionPlaceholder = (tab: WorkspaceTab) => (
		<div className="workspace-session-placeholder" role="tabpanel">
			<p>{t("This session is not in focus.")}</p>
			<button className="button-secondary" onClick={() => onChatSession(tab.sessionId)} type="button">
				{t("Focus this session")}
			</button>
		</div>
	);

	const renderPanels = () => {
		let chatHost: { pane: WorkspacePane; tab: WorkspaceTab } | null = null;
		for (const pane of workspace.panes) {
			const tab = pane.tabs.find((candidate) =>
				candidate.kind === "chat"
				&& (candidate.sessionId === chatSessionId || (chatIsDraft && candidate.sessionId === null)));
			if (tab) {
				chatHost = { pane, tab };
				break;
			}
		}
		return workspace.panes.flatMap((pane) => {
			const paneFileTabs = pane.tabs.filter((tab): tab is Extract<WorkspaceTab, { kind: "file" }> => tab.kind === "file");
			const fileSessionIds = [...new Set(paneFileTabs.map((tab) => tab.sessionId))];
			const activeTab = pane.tabs.find((tab) => tab.id === pane.activeId);
			const panelVisible = (tabId: string) =>
				visible && pane.activeId === tabId
				&& menuTarget?.paneId !== pane.id
				&& tabMenu?.paneId !== pane.id;
			const host = chatHost && chatHost.pane === pane ? chatHost : null;
			const wrap = (tabId: string, content: ReactNode) => (
				<div className="workspace-panel" data-pane-id={pane.id} hidden={!panelVisible(tabId)} key={tabId}>
					{content}
				</div>
			);
			return [
				host ? (
					<div
						className="workspace-panel"
						data-pane-id={pane.id}
						hidden={pane.activeId !== host.tab.id || !visible}
						key={host.tab.id}
					>
						<div className="workspace-chat-panel">{chat}</div>
					</div>
				) : null,
				activeTab?.kind === "chat" && activeTab !== host?.tab ? (
					<div className="workspace-panel" data-pane-id={pane.id} key={activeTab.id}>
						{sessionPlaceholder(activeTab)}
					</div>
				) : null,
				...pane.tabs.flatMap((tab) =>
					tab.kind === "process" ? wrap(tab.id,
						<ProcessPanel
							panelId={`process-panel-${tab.id}`}
							process={tab.process}
							theme={theme}
							onError={onError}
							visible={panelVisible(tab.id)}
						/>,
					) : tab.kind === "terminal" ? wrap(tab.id,
						<TerminalPanel
							api={api}
							cwd={tab.cwd}
							terminalId={tab.id}
							theme={theme}
							visible={panelVisible(tab.id)}
						/>,
					) : tab.kind === "browser" ? wrap(tab.id,
						<BrowserPanel
							api={api}
							browserId={tab.id}
							controlState={tab.controlState}
							handoffReason={tab.handoffReason}
							sessionId={tab.sessionId}
							onError={onError}
							onOpenProfile={(profile) => {
								const selected = browserProfiles.find((candidate) => candidate.profileId === profile.profileId);
								if (selected) addBrowser(pane.id, selected);
							}}
							onProfileImported={browserProfileImported}
							onState={updateBrowserState}
							profile={{ profileId: tab.profileId, name: tab.profileName }}
							profiles={browserProfiles}
							visible={panelVisible(tab.id)}
						/>,
					) : tab.kind === "knowledge" ? wrap(tab.id,
						<KnowledgePanel api={api} sessionId={tab.sessionId} visible={panelVisible(tab.id)} />,
					) : tab.kind === "review" ? wrap(tab.id,
						<ReviewPanel
							api={api}
							sessionId={tab.sessionId}
							theme={theme}
							visible={panelVisible(tab.id)}
						/>,
					) : tab.kind === "agent" ? wrap(tab.id,
						tab.sessionId === chatSessionId ? (
							<AgentTreePanel
								api={api}
								onError={onError}
								sessionId={tab.sessionId}
								store={store}
								visible={panelVisible(tab.id)}
							/>
						) : sessionPlaceholder(tab),
					) : tab.kind === "plan" ? wrap(tab.id,
						<div
							className="tool-panel plan-panel"
							id={`plan-panel-${tab.id}`}
							role="tabpanel"
						>
							<PlanPreview plan={tab.plan} />
						</div>,
					) : tab.kind === "preview" ? wrap(tab.id,
						<div
							className="tool-panel preview-panel"
							id={`preview-panel-${tab.id}`}
							role="tabpanel"
						>
							<UniversalFilePreviewer
								active={panelVisible(tab.id)}
								api={api}
								file={tab.file}
								onClose={() => closeTab(tab.id)}
								onError={onError}
							/>
						</div>,
					) : [],
				),
				...fileSessionIds.map((fileSessionId) => {
					const groupTabs = paneFileTabs.filter((tab) => tab.sessionId === fileSessionId);
					const groupActiveTab = activeTab?.kind === "file" && activeTab.sessionId === fileSessionId ? activeTab : groupTabs.at(-1);
					const cwd = groupTabs[0]!.cwd;
					const dirtyPaths = groupTabs.flatMap((tab) => {
						const draft = fileDrafts.get(tab.id);
						return tab.relativePath && draft && draft.text !== draft.savedText ? [tab.relativePath] : [];
					});
					const savingPaths = groupTabs.flatMap((tab) =>
						tab.relativePath && savingFileTabIds.has(tab.id) ? [tab.relativePath] : [],
					);
					const groupVisible = visible && activeTab?.kind === "file" && activeTab.sessionId === fileSessionId
						&& menuTarget?.paneId !== pane.id && tabMenu?.paneId !== pane.id;
					return (
						<div
							className="workspace-panel"
							data-pane-id={pane.id}
							hidden={!groupVisible}
							key={`files-${fileSessionId}-${pane.id}`}
						>
							<FilePanel
								activePath={groupActiveTab?.relativePath ?? null}
								api={api}
								cwd={cwd}
								draft={groupActiveTab ? fileDrafts.get(groupActiveTab.id) ?? null : null}
								dirtyPaths={dirtyPaths}
								expandedPaths={expandedBySession.get(fileSessionId) ?? []}
								onDraftChange={(text) => { if (groupActiveTab) updateFileDraft(fileSessionId, groupActiveTab.id, text); }}
								onDraftLoaded={(file) => { if (groupActiveTab) loadFileDraft(groupActiveTab.id, file); }}
								onError={onError}
								onExpandedPathsChange={(paths) => updateExpandedPaths(fileSessionId, cwd, paths)}
								onOpenFile={(relativePath, fix) => openFile(fileSessionId, cwd, relativePath, fix, pane.id)}
								onSave={async () => { if (groupActiveTab) await saveFileTab(fileSessionId, groupActiveTab.id); }}
								onWorkspaceMutation={(result) => applyWorkspaceMutation(fileSessionId, cwd, result, pane.id)}
								saving={groupActiveTab ? savingFileTabIds.has(groupActiveTab.id) : false}
								savingPaths={savingPaths}
								sessionId={fileSessionId}
								visible={groupVisible}
							/>
						</div>
					);
				}),
			];
		});
	};

	return (
		<div className="session-workspace-root" hidden={!visible}>
			<div className="session-workspace-instance">
				<div className={`session-workspace-panes${dragState ? " is-dragging" : ""}`} ref={panesRef}>
					{workspace.panes.map((pane) => (
						<section
							className={`workspace-pane${dropTarget && "splitBeside" in dropTarget && dropTarget.splitBeside === pane.id ? " is-split-target" : ""}`}
							key={pane.id}
							onDragLeave={(event) => {
								if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
								setDropTarget((current) => current && "splitBeside" in current && current.splitBeside === pane.id ? null : current);
							}}
							onDragOver={(event) => {
								if (!dragState) return;
								event.preventDefault();
								const rect = event.currentTarget.getBoundingClientRect();
								const edge = Math.min(120, rect.width * 0.25);
								if (rect.right - event.clientX <= edge) {
									event.dataTransfer.dropEffect = "move";
									setDropTarget({ splitBeside: pane.id });
								} else {
									setDropTarget({ paneId: pane.id, index: pane.tabs.length });
								}
							}}
							onDrop={(event) => {
								event.preventDefault();
								const rect = event.currentTarget.getBoundingClientRect();
								const edge = Math.min(120, rect.width * 0.25);
								if (rect.right - event.clientX <= edge) handleDropSplit(pane.id);
								else handleDropOnStrip(pane.id, pane.tabs.length);
							}}
						>
							{renderTabStrip(pane)}
							<div
								className="workspace-pane-body"
								ref={(element) => {
									if (element) paneBodiesRef.current.set(pane.id, element);
									else paneBodiesRef.current.delete(pane.id);
								}}
							>
								{pane.tabs.length === 0 && (
									<div className="workspace-empty" role="tabpanel">
										<p>{t("Pick a session from the sidebar or use + to open a tool.")}</p>
									</div>
								)}
							</div>
						</section>
					))}
					<div className="workspace-panel-layer" ref={panelLayerRef}>
						{renderPanels()}
					</div>
				</div>
			</div>
			{tabMenu && (() => {
				const otherPanes = workspace.panes.filter((pane) => pane.id !== tabMenu.paneId);
				const menuStyle: CSSProperties = { left: `${tabMenu.x}px`, top: `${tabMenu.y}px` };
				return (
					<nav aria-label={t("Tab actions")} className="tool-add-menu workspace-tab-menu" role="menu" style={menuStyle}>
						<button onClick={() => { mutateWorkspace((ws) => splitTabRight(ws, tabMenu.tabId)); setTabMenu(null); }} role="menuitem" type="button">
							<span>{t("Split right")}</span>
						</button>
						{otherPanes.map((pane, index) => (
							<button key={pane.id} onClick={() => { mutateWorkspace((ws) => moveTab(ws, tabMenu.tabId, pane.id)); setTabMenu(null); }} role="menuitem" type="button">
								<span>{t("Move to pane {{index}}", { index: index + 1 })}</span>
							</button>
						))}
						<button onClick={() => { closeTab(tabMenu.tabId); setTabMenu(null); }} role="menuitem" type="button">
							<span>{t("Close")}</span>
						</button>
					</nav>
				);
			})()}
			{pendingFileClose && (
				<div className="modal-backdrop">
					<div aria-describedby="unsaved-file-message" aria-label={t("Unsaved changes")} aria-modal="true" className="interaction-dialog unsaved-file-dialog" role="dialog">
						<h2>{t("Save changes to {{name}}?", { name: pendingFileClose.name })}</h2>
						<p id="unsaved-file-message">{t("Your changes will be lost if you don’t save them.")}</p>
						<div className="interaction-actions">
							<button autoFocus className="button-secondary" onClick={() => setPendingFileClose(null)} type="button">{t("Cancel")}</button>
							<button className="button-secondary" onClick={discardPendingFile} type="button">{t("Don’t Save")}</button>
							<button disabled={savingFileTabIds.has(pendingFileClose.tabId)} onClick={() => void saveAndClosePendingFile()} type="button">{t(savingFileTabIds.has(pendingFileClose.tabId) ? "Saving…" : "Save")}</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}
