import type { AgentMode, PlanView, SessionProcessView, SessionSummary } from "@metis/app-protocol";
import type {
	CSSProperties,
	DragEvent,
	KeyboardEvent as ReactKeyboardEvent,
	ReactNode,
	PointerEvent as ReactPointerEvent,
} from "react";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
	DEFAULT_BROWSER_PROFILE_ID,
	type DesktopBrowserProfile,
	type DesktopBrowserState,
	type DesktopWorkspaceMutationResult,
	type MetisDesktopApi,
} from "../../shared/desktop-api.ts";
import type { AgentConversationTarget } from "../conversation-target.ts";
import { Books, ChatCircle, ClipboardText, Code, FileText, Globe, Plus, Robot, TerminalWindow, X } from "../icons.tsx";
import { SESSION_INDICATOR_LABELS, sessionIndicator } from "../session-view-utils.ts";
import type { AppStore } from "../store/app-store.ts";
import { useWorkspaceLayout } from "../use-workspace-layout.ts";
import {
	displayFileName,
	FILE_BROWSER_STORAGE_PREFIX,
	loadStoredFiles,
	pathIsWithin,
	remapPath,
	saveStoredFiles,
} from "../workspace-files.ts";
import { projectPaneSizes } from "../workspace-layout.ts";
import { tabMotionAnimationsSupported, tabMotionReduced, tabStripLayout } from "../workspace-tab-motion.ts";
import { applyWorkspaceTabSizing, useWorkspaceTabSizing } from "../workspace-tab-sizing.ts";
import {
	activateTab,
	activePane,
	addTab,
	canSplit,
	chatTab,
	closeEmptyPane,
	collapsedTabIds,
	findChatTab,
	findToolLocation,
	focusedChatTab,
	getSplitLimitReason,
	mapTabs,
	moveTab,
	moveTabGroup,
	moveToolTab,
	normalizeTabGroups,
	relatedInsertIndex,
	removeTab,
	removeTabs,
	revealTab,
	type SessionWorkspace,
	type SplitDirection,
	type SplitLimitReason,
	setActivePane,
	setPaneWeights,
	setRowWeights,
	splitTab,
	tabGroupRuns,
	toggleTabGroup,
	toolStripOf,
	type WorkspacePane,
	type WorkspaceTab,
	workspaceTabs,
} from "../workspace-tabs.ts";
import { AgentConversation } from "./AgentConversation.tsx";
import { AgentTreePanel } from "./AgentTreePanel.tsx";
import { BrowserPanel } from "./BrowserPanel.tsx";
import { CodeChangesNavigationContext } from "./CodeChangesNavigationContext.ts";
import { FilePanel, type WorkspaceFileDraft } from "./FilePanel.tsx";
import { KnowledgePanel } from "./KnowledgePanel.tsx";
import { PlanPreview } from "./PlanPreview.tsx";
import { ProcessPanel } from "./ProcessPanel.tsx";
import { previewBytesCache } from "./preview/preview-bytes-cache.ts";
import type { UniversalPreviewTarget } from "./preview/preview-kinds.ts";
import { UniversalFilePreviewer } from "./preview/UniversalFilePreviewer.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { SessionChatView, type SessionChatViewContext } from "./SessionChatView.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";
import { WorkspaceFileIcon } from "./WorkspaceFileIcon.tsx";
import { WorkspacePaneResizer } from "./WorkspacePaneResizer.tsx";
import { WorkspaceTabMotion } from "./WorkspaceTabMotion.tsx";
import "../styles/workspace-pane-layout.css";
import { WorkspaceTabMenu, type WorkspaceTabMenuItem } from "./WorkspaceTabMenu.tsx";

const BROWSER_PROFILE_STORAGE_KEY = "metis.browser-profile.v1";

function revealTabInStrip(tab: HTMLElement, strip: HTMLElement): void {
	const { left, width } = tabStripLayout(tab, strip);
	if (left < strip.scrollLeft) strip.scrollLeft = left;
	else if (left + width > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = left + width - strip.clientWidth;
}

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
	/** The tab button that opened the menu; non-null for keyboard activation. */
	readonly trigger: HTMLElement | null;
	readonly focusTrigger?: HTMLElement | null;
}

// Split refusal copy distinguishes grid limits from a window that is too small.
const SPLIT_LIMIT_LABEL: Record<SplitLimitReason, string> = {
	"missing-pane": "Up to 6 panes",
	"pane-limit": "Up to 6 panes",
	"row-limit": "Up to 6 panes",
	"column-limit": "Up to 6 panes",
};

// A drag carries one tab, or a whole project group when it starts on the group's label.
type DragState = { readonly tabId: string } | { readonly group: { readonly paneId: string; readonly key: string } };

type DropTarget =
	| { readonly paneId: string; readonly index: number }
	| { readonly split: { readonly paneId: string; readonly direction: SplitDirection } };

/** The project a tab belongs to; tabs of one project share a labelled group in the strip. */
export interface WorkspaceProject {
	readonly key: string;
	readonly name: string;
	readonly cwd: string;
}

// Group accents stay legible on both themes.
const TAB_GROUP_COLORS = ["#5b8def", "#3fb68b", "#d9963b", "#b77ae0", "#e0707a", "#45b0c4"] as const;

const noProject = (): WorkspaceProject | null => null;
const noInteractions: NonNullable<SessionWorkspaceViewProps["inlineInteractions"]> = [];

type PlaceTab = (
	workspace: SessionWorkspace,
	tab: WorkspaceTab,
	paneId?: string,
	activate?: boolean,
) => SessionWorkspace;

const MIN_PANE_WIDTH = 360;
const MIN_PANE_HEIGHT = 280;

/** Keep the chat column wide enough for the composer input and its action rows. */
const TOOLS_SIDEBAR_MAIN_MIN_WIDTH = 560;
/** Below the main-column minimum the sidebar stops shrinking rather than becoming unusable. */
const TOOLS_SIDEBAR_MIN_WIDTH = 280;
/** The resize handle overlays this much of the pane's right edge. */
const TOOLS_SIDEBAR_SEPARATOR_WIDTH = 8;

interface SessionWorkspaceViewProps {
	readonly api: MetisDesktopApi;
	readonly chat: ReactNode;
	readonly chatCwd: string | null;
	readonly agentFocusRequest?: { readonly nonce: number; readonly target: AgentConversationTarget } | null;
	readonly onAgentConversationFocus?: (target: AgentConversationTarget | null) => void;
	readonly chatFocusRequest: { readonly nonce: number; readonly sessionId: string | null } | null;
	readonly chatIsDraft: boolean;
	readonly chatSessionId: string | null;
	readonly cleanupSessionIds: readonly string[];
	/** Bumped by the Cmd/Ctrl+W shortcut to close the focused tab. */
	readonly closeTabRequest?: number;
	readonly mode: AgentMode;
	readonly onActivateSession: (sessionId: string) => void;
	readonly onChatSession: (sessionId: string | null) => void;
	readonly onCleanupSessionIdsHandled: (sessionIds: readonly string[]) => void;
	readonly onDirtySessionIdsChange: (sessionIds: readonly string[]) => void;
	readonly onError: (cause: unknown) => void;
	readonly onLiveSessionsChange: (sessionIds: readonly string[], chatSessionIds: readonly string[]) => void;
	readonly onNewSession?: (target: { readonly mode: AgentMode; readonly cwd: string } | null) => void;
	readonly chatView: SessionChatViewContext;
	/** Pending questions and approvals; they render only inside their session's conversation. */
	readonly inlineInteractions?: readonly { readonly interactionId: string; readonly sessionId: string }[];
	readonly planPreviewRequest?: { readonly sessionId: string; readonly plan: PlanView } | null;
	readonly previewRequest?: UniversalPreviewTarget | null;
	readonly knowledgeRequest?: { readonly id: number; readonly sessionId: string };
	readonly process?: SessionProcessView;
	/** Resolves a session's project for tab grouping; without it tabs are ungrouped. */
	readonly projectFor?: (sessionId: string) => WorkspaceProject | null;
	readonly sessionsById: ReadonlyMap<
		string,
		Pick<SessionSummary, "sessionId" | "cwd" | "mode"> &
			Partial<Pick<SessionSummary, "state" | "unread" | "attentionRequired" | "lastTurnOutcome">>
	>;
	readonly sessionTitleFor: (sessionId: string) => string;
	readonly store: AppStore;
	readonly theme: "dark" | "light";
	readonly titlebarTabsSlot?: HTMLElement | null;
	/** Titlebar region (right end) that hosts the tools strip; it owns the sidebar's width. */
	readonly titlebarToolsSlot?: HTMLElement | null;
	readonly toolsSidebarOpen?: boolean;
	readonly toolsSidebarClosing?: boolean;
	readonly toolsSidebarWidth?: number;
	readonly onToolsSidebarOpenChange?: (open: boolean) => void;
	readonly onToolsSidebarWidthChange?: (width: number) => void;
	readonly visible: boolean;
}

export function clampToolsSidebarWidth(
	value: number,
	workspaceWidth = document.querySelector<HTMLElement>(".workspace")?.clientWidth || window.innerWidth,
): number {
	// Reserve a usable chat column before growing the sidebar. When the window is
	// too narrow to satisfy both minimums, the sidebar stays at its own minimum
	// and the chat column wraps its action rows instead of clipping them.
	const maximum = Math.max(
		TOOLS_SIDEBAR_MIN_WIDTH,
		Math.floor(workspaceWidth - TOOLS_SIDEBAR_MAIN_MIN_WIDTH - TOOLS_SIDEBAR_SEPARATOR_WIDTH),
	);
	return Math.max(TOOLS_SIDEBAR_MIN_WIDTH, Math.min(maximum, value));
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
	place: PlaceTab,
): SessionWorkspace {
	const pane = activePane(workspace);
	// An intentional empty split waits for an explicit sidebar/new-task gesture.
	if (pane.placeholder && pendingSessionId === undefined) return workspace;
	const activeTab = pane.tabs.find((tab) => tab.id === pane.activeId);
	const shouldFocus =
		activeTab === undefined ||
		(activeTab.kind === "chat" && !activeTab.agentId) ||
		pendingSessionId === chatSessionId;
	if (chatIsDraft) {
		const draftTab = findChatTab(workspace, null);
		if (chatSessionId === null) {
			let next = draftTab ? workspace : place(workspace, chatTab(null), workspace.activePaneId, false);
			if (shouldFocus) next = activateTab(next, findChatTab(next, null)!.id);
			return next;
		}
		let next = workspace;
		if (draftTab) {
			next = {
				...next,
				panes: next.panes.map((candidate) => ({
					...candidate,
					tabs: candidate.tabs.map((tab) => (tab.id === draftTab.id ? { ...tab, sessionId: chatSessionId } : tab)),
				})),
			};
		}
		if (!findChatTab(next, chatSessionId)) next = place(next, chatTab(chatSessionId), next.activePaneId, false);
		if (shouldFocus) next = activateTab(next, findChatTab(next, chatSessionId)!.id);
		return next;
	}
	if (chatSessionId === null) return workspace;
	let next = workspace;
	const staleDraft = findChatTab(next, null);
	if (staleDraft) next = removeTab(next, staleDraft.id);
	if (!findChatTab(next, chatSessionId)) next = place(next, chatTab(chatSessionId), next.activePaneId, false);
	if (shouldFocus) next = activateTab(next, findChatTab(next, chatSessionId)!.id);
	return next;
}

export function SessionWorkspaceView({
	api,
	chat,
	chatCwd,
	chatFocusRequest,
	agentFocusRequest,
	onAgentConversationFocus,
	chatIsDraft,
	chatSessionId,
	cleanupSessionIds,
	closeTabRequest,
	mode,
	onActivateSession,
	onChatSession,
	onCleanupSessionIdsHandled,
	onDirtySessionIdsChange,
	onError,
	onLiveSessionsChange,
	onNewSession,
	chatView,
	inlineInteractions = noInteractions,
	planPreviewRequest,
	previewRequest,
	knowledgeRequest,
	process,
	projectFor = noProject,
	sessionsById,
	sessionTitleFor,
	store,
	theme,
	titlebarTabsSlot,
	titlebarToolsSlot,
	toolsSidebarOpen,
	toolsSidebarClosing,
	toolsSidebarWidth = 360,
	onToolsSidebarOpenChange,
	onToolsSidebarWidthChange,
	visible,
}: SessionWorkspaceViewProps) {
	const { t } = useTranslation();
	const { workspace, setWorkspace, cancelRestore, markLayoutIntent, setLayoutResizing } = useWorkspaceLayout({
		api,
		sessionsById,
		chatSessionId,
		store,
	});
	const [reviewFocus, setReviewFocus] = useState<{ sessionId: string; path?: string; id: string }>();
	const [paneViewport, setPaneViewport] = useState({ width: 0, height: 0 });
	const [resizingAxis, setResizingAxis] = useState<"column" | "row" | null>(null);
	const [toolsResizing, setToolsResizing] = useState(false);
	const [expandedBySession, setExpandedBySession] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
	const [fileDrafts, setFileDrafts] = useState<ReadonlyMap<string, WorkspaceFileDraft>>(new Map());
	const [savingFileTabIds, setSavingFileTabIds] = useState<ReadonlySet<string>>(new Set());
	const [pendingFileClose, setPendingFileClose] = useState<PendingFileClose | null>(null);
	const [tabMenu, setTabMenu] = useState<TabMenuState | null>(null);
	const [dragState, setDragState] = useState<DragState | null>(null);
	const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
	const [browserProfiles, setBrowserProfiles] = useState<readonly DesktopBrowserProfile[]>([
		{
			profileId: DEFAULT_BROWSER_PROFILE_ID,
			name: "Default",
			sourceId: null,
			sourceProfileId: null,
		},
	]);
	const browserProfilesRef = useRef(browserProfiles);
	browserProfilesRef.current = browserProfiles;
	const browserProfilesRevision = useRef(0);
	const preferredBrowserProfileId = useRef(localStorage.getItem(BROWSER_PROFILE_STORAGE_KEY));
	const panesRef = useRef<HTMLDivElement>(null);
	const panelLayerRef = useRef<HTMLDivElement>(null);
	const paneBodiesRef = useRef(new Map<string, HTMLElement>());
	const panelRectsRef = useRef(new WeakMap<HTMLElement, { x: number; y: number; width: number; height: number }>());
	// Each strip's underline is one shared element slid under the active tab.
	// Grouped tabs sit inside group wrappers, so it is positioned by measuring
	// the tab's rect rather than a per-tab pseudo-element.
	const tabStripEls = useRef(new Map<string, HTMLDivElement>());
	const tabStripObserver = useRef<ResizeObserver | null>(null);
	const tabStripRefCallbacks = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
	const tabStripActiveTab = useRef(new WeakMap<HTMLElement, Element>());
	// A narrower projection can leave the same active tab outside the viewport;
	// reveal only when the width changes so unrelated renders never move scroll.
	const revealActiveTabAfterSizing = useCallback((strip: HTMLDivElement) => {
		const tab = strip.querySelector<HTMLElement>(".tool-tab.is-active:not([inert])");
		if (tab) revealTabInStrip(tab, strip);
	}, []);
	const registerTabSizing = useWorkspaceTabSizing(revealActiveTabAfterSizing);
	const syncTabIndicators = useCallback(() => {
		for (const scrollEl of tabStripEls.current.values()) {
			const indicator = scrollEl.querySelector<HTMLElement>(".tool-tab-indicator");
			if (!indicator) continue;
			const tabEl = scrollEl.querySelector<HTMLElement>(".tool-tab.is-active");
			if (!tabEl) {
				indicator.classList.remove("is-set");
				continue;
			}
			const layout = tabStripLayout(tabEl, scrollEl);
			if (tabStripActiveTab.current.get(scrollEl) !== tabEl) {
				tabStripActiveTab.current.set(scrollEl, tabEl);
				// Reveal only within this strip; ancestor panes keep their scroll positions.
				revealTabInStrip(tabEl, scrollEl);
			}
			indicator.style.width = `${Math.max(0, layout.width - 20)}px`;
			indicator.style.transform = `translateX(${layout.left + 10}px)`;
			// Grouped strips tint the line with the tab's group accent color.
			indicator.style.setProperty(
				"--tab-group-color",
				getComputedStyle(tabEl).getPropertyValue("--tab-group-color"),
			);
			indicator.classList.add("is-set");
		}
	}, []);
	useLayoutEffect(() => {
		if (visible) syncTabIndicators();
	});
	useEffect(() => {
		const observer = new ResizeObserver(syncTabIndicators);
		tabStripObserver.current = observer;
		for (const scrollEl of tabStripEls.current.values()) observer.observe(scrollEl);
		return () => {
			tabStripObserver.current = null;
			observer.disconnect();
		};
	}, [syncTabIndicators]);
	// Vertical wheel scrolls the strip horizontally; the listener is native
	// because React's delegated wheel handlers cannot preventDefault.
	const onTabStripWheel = useCallback((event: WheelEvent) => {
		const el = event.currentTarget as HTMLElement;
		if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
		event.preventDefault();
		el.scrollLeft += event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
	}, []);
	const tabStripRef = (paneId: string) => {
		let callback = tabStripRefCallbacks.current.get(paneId);
		if (!callback) {
			callback = (el) => {
				const previous = tabStripEls.current.get(paneId);
				if (previous && previous !== el) {
					tabStripObserver.current?.unobserve(previous);
					previous.removeEventListener("wheel", onTabStripWheel);
				}
				if (el) {
					tabStripEls.current.set(paneId, el);
					tabStripObserver.current?.observe(el);
					el.addEventListener("wheel", onTabStripWheel, { passive: false });
				} else {
					tabStripEls.current.delete(paneId);
				}
				registerTabSizing(el, previous);
			};
			tabStripRefCallbacks.current.set(paneId, callback);
		}
		return callback;
	};
	// The tools strip wants wheel scrolling but no shared indicator.
	const toolsScrollEl = useRef<HTMLDivElement | null>(null);
	const toolsScrollRef = (el: HTMLDivElement | null) => {
		const previous = toolsScrollEl.current;
		if (previous && previous !== el) previous.removeEventListener("wheel", onTabStripWheel);
		if (el) el.addEventListener("wheel", onTabStripWheel, { passive: false });
		toolsScrollEl.current = el;
		registerTabSizing(el, previous);
	};
	// The tools sidebar follows the focused pane's session.
	const focusedChatSession = focusedChatTab(workspace)?.sessionId;
	// The aside stays mounted through the slide-out animation.
	const sidebarOpen = toolsSidebarOpen ?? true;
	const sidebarClosing = toolsSidebarClosing ?? false;
	const toolsStrip =
		focusedChatSession === undefined || focusedChatSession === null
			? { tabs: [] as readonly WorkspaceTab[], activeId: "" }
			: toolStripOf(workspace, focusedChatSession);
	const toolsActiveTab = useRef<HTMLElement | null>(null);
	useLayoutEffect(() => {
		if (!visible || !sidebarOpen) return;
		const strip = toolsScrollEl.current;
		const tab = strip?.querySelector<HTMLElement>(".tool-tab.is-active");
		if (!strip || !tab || toolsActiveTab.current === tab) return;
		toolsActiveTab.current = tab;
		revealTabInStrip(tab, strip);
	});
	// Titlebar tabs and keyboard focus participate too: tools portal outside the aside.
	const toolsFocusedRef = useRef(false);
	const pendingCloseCancelRef = useRef<HTMLButtonElement>(null);
	const onToolsSidebarOpenChangeRef = useRef(onToolsSidebarOpenChange);
	onToolsSidebarOpenChangeRef.current = onToolsSidebarOpenChange;
	const showToolsSidebar = useCallback(() => {
		onToolsSidebarOpenChangeRef.current?.(true);
	}, []);
	// A newly added tool opens the sidebar once; closing stays closed afterwards.
	const toolTabCount = [...workspace.tools.values()].reduce((count, strip) => count + strip.tabs.length, 0);
	const seenToolTabCount = useRef(toolTabCount);
	useEffect(() => {
		const grew = toolTabCount > seenToolTabCount.current;
		seenToolTabCount.current = toolTabCount;
		if (grew && !sidebarOpen) onToolsSidebarOpenChangeRef.current?.(true);
	}, [sidebarOpen, toolTabCount]);
	const dirtySessionIds = useMemo(
		() =>
			[
				...new Set(
					workspaceTabs(workspace).flatMap((tab) => {
						if (tab.sessionId === null) return [];
						const draft = tab.kind === "file" ? fileDrafts.get(tab.id) : undefined;
						return draft !== undefined && draft.text !== draft.savedText ? [tab.sessionId] : [];
					}),
				),
			].sort(),
		[fileDrafts, workspace],
	);
	const dirtySessionKey = dirtySessionIds.join("\n");
	const retainedKey = useMemo(
		() =>
			[...new Set(workspaceTabs(workspace).flatMap((tab) => (tab.sessionId === null ? [] : [tab.sessionId])))]
				.sort()
				.join("\n"),
		[workspace],
	);
	const liveKey = useMemo(() => {
		const live = new Set(
			workspace.panes.flatMap((pane) => {
				const tab = pane.tabs.find((candidate) => candidate.id === pane.activeId);
				// Child chat tabs carry their owning root sessionId; keeping that root
				// subscribed is what lets the visible child recover live updates.
				return (tab?.kind === "chat" || tab?.kind === "agent") && tab.sessionId !== null ? [tab.sessionId] : [];
			}),
		);
		// An open Agents tool tab keeps its session live even off the chat pane.
		const activeTool = toolsStrip.tabs.find((tab) => tab.id === toolsStrip.activeId);
		if (sidebarOpen && activeTool?.kind === "agent" && focusedChatSession) live.add(focusedChatSession);
		return [...live].sort().join("\n");
	}, [workspace, sidebarOpen, toolsStrip, focusedChatSession]);
	// Sessions with a pane-active chat tab host their own modal interactions;
	// the App-level host covers sessions without a visible chat pane.
	const chatLiveKey = useMemo(
		() =>
			[
				...new Set(
					workspace.panes.flatMap((pane) => {
						const tab = pane.tabs.find((candidate) => candidate.id === pane.activeId);
						return tab?.kind === "chat" && tab.sessionId !== null ? [tab.agentId ?? tab.sessionId] : [];
					}),
				),
			]
				.sort()
				.join("\n"),
		[workspace],
	);

	const seenProcesses = useRef(new Map<string, string>());
	const autoOpenedProcessSessions = useRef(new Set<string>());

	const workspaceRef = useRef(workspace);
	workspaceRef.current = workspace;
	const chatSessionIdRef = useRef(chatSessionId);
	chatSessionIdRef.current = chatSessionId;
	const onAgentConversationFocusRef = useRef(onAgentConversationFocus);
	onAgentConversationFocusRef.current = onAgentConversationFocus;
	const onChatSessionRef = useRef(onChatSession);
	onChatSessionRef.current = onChatSession;

	// The session a chat tab is about to project. Set by focus requests and by
	// chat-tab gestures until the projected session catches up; while set, the
	// sync pass treats that tab as the desired focus.
	const pendingChatFocus = useRef<string | null | undefined>(undefined);
	const handledFocusNonce = useRef(0);
	// Shortcut and browser-view handlers outlive renders, so they close tabs through the latest closeTab.
	const closeTabRef = useRef<(id: string) => void>(() => undefined);
	const handledCloseTabRequest = useRef(closeTabRequest);

	const projectForRef = useRef(projectFor);
	projectForRef.current = projectFor;
	const groupOf = useCallback(
		(tab: WorkspaceTab): string | null =>
			tab.sessionId === null ? null : (projectForRef.current(tab.sessionId)?.key ?? null),
		[],
	);

	// Every mutation lands grouped, so each project shows up once per strip
	// however its tabs were opened, dragged or moved between panes.
	const updateWorkspace = useCallback(
		(update: (workspace: SessionWorkspace) => SessionWorkspace) => {
			setWorkspace((current) => {
				const next = normalizeTabGroups(update(current), groupOf);
				workspaceRef.current = next;
				return next === current ? current : next;
			});
		},
		[groupOf, setWorkspace],
	);

	// A project keeps its group color while it has tabs open; new projects take
	// the first free color so groups on screen never share one.
	const groupColors = useRef(new Map<string, number>());
	const tabGroupColor = (key: string): string => {
		let index = groupColors.current.get(key);
		if (index === undefined) {
			const used = new Set(groupColors.current.values());
			index = TAB_GROUP_COLORS.findIndex((_, candidate) => !used.has(candidate));
			if (index < 0) index = groupColors.current.size % TAB_GROUP_COLORS.length;
			groupColors.current.set(key, index);
		}
		return TAB_GROUP_COLORS[index]!;
	};
	const openGroupKeys = new Set(
		workspaceTabs(workspace).flatMap((tab) => {
			const project = tab.sessionId === null ? null : projectFor(tab.sessionId);
			return project ? [project.key] : [];
		}),
	);
	for (const key of groupColors.current.keys()) {
		if (!openGroupKeys.has(key)) groupColors.current.delete(key);
	}

	// New tabs join their session's (or project's) tabs so every group stays one labelled run.
	const placeTab = useCallback<PlaceTab>(
		(workspace, tab, paneId = workspace.activePaneId, activate = true) => {
			const pane = workspace.panes.find((candidate) => candidate.id === paneId);
			if (!pane) return workspace;
			return addTab(workspace, tab, paneId, activate, relatedInsertIndex(pane, tab, groupOf));
		},
		[groupOf],
	);

	// User gestures (tab click, close, drag, pane pick) report the resulting
	// focused chat straight from the mutation — no reactive effect, so the
	// projection never sees a stale commit window. Effect-driven updates go
	// through updateWorkspace and stay silent.
	const mutateWorkspace = useCallback(
		(update: (workspace: SessionWorkspace) => SessionWorkspace) => {
			markLayoutIntent();
			const next = normalizeTabGroups(update(workspaceRef.current), groupOf);
			if (next === workspaceRef.current) return;
			workspaceRef.current = next;
			setWorkspace(next);
			const focused = focusedChatTab(next);
			onAgentConversationFocusRef.current?.(
				focused?.agentId && focused.sessionId
					? { sessionId: focused.sessionId, agentId: focused.agentId, name: focused.agentName ?? focused.agentId }
					: null,
			);
			// Closing the final conversation returns to the existing new-task flow.
			// Empty split panes stay intentional while another conversation is open.
			if (next.panes.every((pane) => pane.tabs.length === 0)) {
				pendingChatFocus.current = null;
				onChatSessionRef.current(null);
				return;
			}
			if (
				focused &&
				!focused.agentId &&
				focused.sessionId !== chatSessionIdRef.current &&
				pendingChatFocus.current !== focused.sessionId
			) {
				pendingChatFocus.current = focused.sessionId;
				onChatSessionRef.current(focused.sessionId);
			}
		},
		[groupOf, markLayoutIntent, setWorkspace],
	);

	const openAgentConversation = useCallback(
		(target: AgentConversationTarget) => {
			pendingChatFocus.current = undefined;
			mutateWorkspace((current) => {
				const existing = findChatTab(current, target.sessionId, target.agentId);
				return existing
					? activateTab(current, existing.id)
					: placeTab(current, {
							...chatTab(target.sessionId),
							agentId: target.agentId,
							agentName: target.name,
						});
			});
		},
		[mutateWorkspace, placeTab],
	);
	const handledAgentFocus = useRef(0);
	useEffect(() => {
		if (!agentFocusRequest || handledAgentFocus.current === agentFocusRequest.nonce) return;
		handledAgentFocus.current = agentFocusRequest.nonce;
		openAgentConversation(agentFocusRequest.target);
	}, [agentFocusRequest, openAgentConversation]);

	// Collapsing a group animates its tab body shut like a drawer before the
	// model commits; expanding commits first and the fresh body animates open.
	// Reduced motion (or DOMs without Web Animations) toggles instantly.
	const groupAnims = useRef(new Map<string, { anim: Animation; closing: boolean }>());
	const expandingGroups = useRef(new Set<string>());
	const groupBodyRefCallbacks = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
	// While a drawer closes the label already looks collapsed, so the count and
	// chip shape arrive with the animation instead of popping in at the commit.
	const [closingGroups, setClosingGroups] = useState<ReadonlySet<string>>(new Set());
	// Expanding bodies mount while their drawer animation runs; both directions
	// suppress tab motion until the drawer owns the layout again.
	const [expandingGroupKeys, setExpandingGroupKeys] = useState<ReadonlySet<string>>(new Set());
	const groupsCanAnimate = () => tabMotionAnimationsSupported() && !tabMotionReduced();
	const setGroupClosing = (id: string, closing: boolean) => {
		setClosingGroups((current) => {
			const next = new Set(current);
			if (closing) next.add(id);
			else next.delete(id);
			return next;
		});
	};
	const setGroupExpanding = (id: string, expanding: boolean) => {
		setExpandingGroupKeys((current) => {
			if (current.has(id) === expanding) return current;
			const next = new Set(current);
			if (expanding) next.add(id);
			else next.delete(id);
			return next;
		});
	};
	// A live reduced-motion change cancels drawers already in flight, not just
	// the next gesture.
	useEffect(() => {
		const cancel = () => {
			if (!tabMotionReduced()) return;
			for (const { anim } of groupAnims.current.values()) {
				try {
					anim.cancel();
				} catch {
					// Animations may already have finished or been detached.
				}
			}
			groupAnims.current.clear();
			expandingGroups.current.clear();
			setClosingGroups(new Set());
			setExpandingGroupKeys(new Set());
		};
		const observer = typeof MutationObserver === "function" ? new MutationObserver(cancel) : null;
		observer?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-motion"] });
		const media = typeof matchMedia === "function" ? matchMedia("(prefers-reduced-motion: reduce)") : null;
		media?.addEventListener("change", cancel);
		return () => {
			observer?.disconnect();
			media?.removeEventListener("change", cancel);
		};
	}, []);

	const collapseGroupBody = (body: HTMLElement, id: string, paneId: string, key: string) => {
		const anim = body.animate(
			[
				{ maxWidth: `${body.getBoundingClientRect().width}px`, opacity: 1 },
				{ maxWidth: "0px", opacity: 0 },
			],
			{ duration: 220, easing: "cubic-bezier(.16,1,.3,1)", fill: "forwards" },
		);
		groupAnims.current.set(id, { anim, closing: true });
		setGroupClosing(id, true);
		anim.finished.then(
			() => {
				if (groupAnims.current.get(id)?.anim === anim) {
					groupAnims.current.delete(id);
					mutateWorkspace((current) => toggleTabGroup(current, paneId, key, groupOf));
					// Keep the strip suppressed through the drawer's layout commit.
					const release = () => setGroupClosing(id, false);
					if (typeof requestAnimationFrame === "function") requestAnimationFrame(release);
					else release();
				}
			},
			() => {},
		);
	};

	const toggleGroupAnimated = (label: HTMLElement, paneId: string, key: string, collapsed: boolean) => {
		const id = `${paneId}${key}`;
		const running = groupAnims.current.get(id);
		if (running?.closing) {
			// Second click mid-collapse plays the drawer back open and keeps it.
			running.anim.reverse();
			groupAnims.current.delete(id);
			setGroupClosing(id, false);
			void running.anim.finished.catch(() => {});
			return;
		}
		running?.anim.cancel();
		groupAnims.current.delete(id);
		if (collapsed) {
			if (groupsCanAnimate()) {
				expandingGroups.current.add(id);
				setGroupExpanding(id, true);
			}
		} else {
			const body = label.parentElement?.querySelector<HTMLElement>(".tool-tab-group-body");
			if (body && groupsCanAnimate()) {
				collapseGroupBody(body, id, paneId, key);
				return;
			}
		}
		mutateWorkspace((current) => toggleTabGroup(current, paneId, key, groupOf));
	};

	const groupBodyRef = (paneId: string, key: string) => {
		const id = `${paneId}${key}`;
		let callback = groupBodyRefCallbacks.current.get(id);
		if (!callback) {
			callback = (el) => {
				if (!el || !expandingGroups.current.delete(id)) return;
				const anim = el.animate(
					[
						{ maxWidth: "0px", opacity: 0 },
						{ maxWidth: `${el.scrollWidth}px`, opacity: 1 },
					],
					{ duration: 220, easing: "cubic-bezier(.16,1,.3,1)" },
				);
				groupAnims.current.set(id, { anim, closing: false });
				const settle = () => {
					if (groupAnims.current.get(id)?.anim === anim) groupAnims.current.delete(id);
					setGroupExpanding(id, false);
				};
				anim.finished.then(settle, settle).catch(() => undefined);
			};
			groupBodyRefCallbacks.current.set(id, callback);
		}
		return callback;
	};

	// Drag, split/sidebar resize and group drawers own layout geometry while they
	// run; strip motion cancels instead of fighting those gestures.
	const tabMotionSuspended =
		dragState !== null ||
		resizingAxis !== null ||
		toolsResizing ||
		closingGroups.size > 0 ||
		expandingGroupKeys.size > 0;

	// A tab's project can resolve after the tab opens (the session list loads
	// later); regroup whenever the project behind any tab changes.
	const groupSignature = workspace.panes
		.map((pane) => pane.tabs.map((tab) => groupOf(tab) ?? "").join("\n"))
		.join("\0");
	// biome-ignore lint/correctness/useExhaustiveDependencies(groupSignature): Resolved project identities regroup tabs after the session list arrives.
	useEffect(() => {
		updateWorkspace((current) => current);
	}, [groupSignature, updateWorkspace]);

	// Keep one chat tab per session in sync with the projected session. Tabs
	// adopt the draft's real sessionId when it materializes so the chat subtree
	// (and the composer's editable DOM) survives the draft -> session transition.
	useEffect(() => {
		updateWorkspace((current) =>
			syncChatTabs(current, chatSessionId, chatIsDraft, pendingChatFocus.current, placeTab),
		);
	}, [chatIsDraft, chatSessionId, placeTab, updateWorkspace]);

	// Once the projected session's tab is focused, the pending focus request is
	// satisfied and gesture reporting is free to observe the next divergence.
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
		markLayoutIntent();
		onAgentConversationFocusRef.current?.(null);
		pendingChatFocus.current = chatFocusRequest.sessionId;
		updateWorkspace((current) => {
			const existing = findChatTab(current, chatFocusRequest.sessionId);
			if (existing) return activateTab(current, existing.id);
			return chatFocusRequest.sessionId === chatSessionId
				? placeTab(current, chatTab(chatFocusRequest.sessionId))
				: current;
		});
	}, [chatFocusRequest, chatSessionId, markLayoutIntent, placeTab, updateWorkspace]);

	// A question or approval blocks its session until answered, but it renders
	// only inside that session's conversation. When another tab (an auto-opened
	// Process tab, a terminal) covers the conversation, bring it to the front of
	// its pane once per request; focus stays where the user is working.
	const revealedInteractions = useRef(new Set<string>());
	useEffect(() => {
		const pending = new Set(inlineInteractions.map(({ interactionId }) => interactionId));
		for (const interactionId of revealedInteractions.current) {
			if (!pending.has(interactionId)) revealedInteractions.current.delete(interactionId);
		}
		const fresh = inlineInteractions.filter(({ interactionId }) => !revealedInteractions.current.has(interactionId));
		if (fresh.length === 0) return;
		for (const { interactionId } of fresh) revealedInteractions.current.add(interactionId);
		updateWorkspace((current) =>
			fresh.reduce((next, { sessionId }) => {
				const chat =
					findChatTab(next, sessionId) ??
					workspaceTabs(next).find((tab) => tab.kind === "chat" && tab.agentId === sessionId);
				return chat ? revealTab(next, chat.id) : next;
			}, current),
		);
	}, [inlineInteractions, updateWorkspace]);

	const openProcess = useCallback(() => {
		if (!chatSessionId || !process) return;
		const id = `process-${chatSessionId}`;
		const tab: WorkspaceTab = { kind: "process", id, sessionId: chatSessionId, title: "Process", process };
		updateWorkspace((current) => {
			const existing = workspaceTabs(current).some((candidate) => candidate.id === id);
			const replaced = existing ? mapTabs(current, (item) => (item.id === id ? tab : item)) : placeTab(current, tab);
			return activateTab(replaced, id);
		});
	}, [process, chatSessionId, placeTab, updateWorkspace]);

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
		updateWorkspace((current) =>
			mapTabs(current, (tab) =>
				tab.id === `process-${chatSessionId}` && tab.kind === "process" ? { ...tab, process } : tab,
			),
		);
	}, [openProcess, process, chatSessionId, updateWorkspace]);

	useEffect(() => {
		if (!chatSessionId || !process || (process.state !== "completed" && process.state !== "failed")) return;
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
		void api.listBrowserProfiles().then((profiles) => {
			if (active && profiles.length > 0 && browserProfilesRevision.current === revision) {
				setBrowserProfiles(profiles);
			}
		}, onError);
		return () => {
			active = false;
		};
	}, [api, onError]);

	useEffect(
		() =>
			api.subscribeBrowser((event) => {
				if (event.type === "command") {
					// Cmd/Ctrl+W inside a page view closes that browser tab, like the shortcut elsewhere.
					if (event.command === "close-tab") closeTabRef.current(event.browserId);
					return;
				}
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
						return placeTab(
							workspace,
							{
								kind: "browser",
								id: event.browserId,
								sessionId: event.sessionId,
								title: t("New tab"),
								url: "",
								profileId: event.profileId,
								profileName: profile?.name ?? t("Browser"),
								controlState: "idle",
							},
							workspace.activePaneId,
							false,
						);
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
					const next = mapTabs(workspace, (tab) => {
						if (tab.kind !== "browser" || tab.id !== event.browserId) return tab;
						changed = true;
						if (event.type === "activity") {
							return {
								...tab,
								controlState: event.active ? ("agent" as const) : ("idle" as const),
								handoffReason: undefined,
							};
						}
						return event.status === "requested"
							? { ...tab, controlState: "handoff" as const, handoffReason: event.reason }
							: { ...tab, controlState: "idle" as const, handoffReason: undefined };
					});
					if (!changed) return workspace;
					return event.type === "handoff" && event.status === "requested"
						? activateTab(next, event.browserId)
						: next;
				});
				if (event.type === "handoff" && event.status === "requested") {
					onActivateSession(event.sessionId);
				}
			}),
		[api, onActivateSession, placeTab, t, updateWorkspace],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies(chatSessionId): Changing sessions dismisses tab actions and remeasures the active panes.
	// biome-ignore lint/correctness/useExhaustiveDependencies(mode): Changing workspace mode dismisses the previous tab action menu.
	useEffect(() => {
		setTabMenu(null);
	}, [mode, chatSessionId]);
	useEffect(
		() => onDirtySessionIdsChange(dirtySessionKey ? dirtySessionKey.split("\n") : []),
		[dirtySessionKey, onDirtySessionIdsChange],
	);
	useEffect(() => {
		void api
			.retainWorkspaceSessions({
				sessionIds: retainedKey === "" ? [] : retainedKey.split("\n"),
				liveSessionIds: liveKey === "" ? [] : liveKey.split("\n"),
			})
			.catch(onError);
	}, [api, retainedKey, liveKey, onError]);
	useEffect(() => {
		onLiveSessionsChange(
			liveKey === "" ? [] : liveKey.split("\n"),
			chatLiveKey === "" ? [] : chatLiveKey.split("\n"),
		);
	}, [chatLiveKey, liveKey, onLiveSessionsChange]);
	useEffect(() => {
		if (cleanupSessionIds.length === 0) return;
		const removedSessions = new Set(cleanupSessionIds);
		const removedTabIds = new Set<string>();
		for (const tab of workspaceTabs(workspace)) {
			if (tab.sessionId === null || !removedSessions.has(tab.sessionId)) continue;
			removedTabIds.add(tab.id);
			if (tab.kind === "terminal") void api.closeTerminal({ terminalId: tab.id }).catch(onError);
			else if (tab.kind === "browser")
				void api.closeBrowser({ sessionId: tab.sessionId, browserId: tab.id }).catch(onError);
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
		setPendingFileClose((current) => (current && removedSessions.has(current.sessionId) ? null : current));
		onCleanupSessionIdsHandled(cleanupSessionIds);
	}, [api, cleanupSessionIds, onCleanupSessionIdsHandled, onError, updateWorkspace, workspace]);

	// The menu's own portal handles focus, outside presses and Escape; here it
	// only closes when split or close actions remove its target tab or pane.
	useEffect(() => {
		if (!tabMenu) return;
		// "tools" is the sidebar strip's sentinel pane id, not a real pane.
		const paneGone = tabMenu.paneId !== "tools" && !workspace.panes.some((pane) => pane.id === tabMenu.paneId);
		const tabGone =
			findToolLocation(workspace, tabMenu.tabId) === null &&
			!workspace.panes.some((pane) => pane.tabs.some((tab) => tab.id === tabMenu.tabId));
		if (paneGone || tabGone) setTabMenu(null);
	}, [tabMenu, workspace]);

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
		showToolsSidebar();
		updateWorkspace((workspace) => {
			const existing = workspaceTabs(workspace).find(
				(tab): tab is Extract<WorkspaceTab, { kind: "preview" }> =>
					tab.kind === "preview" &&
					tab.sessionId === (previewRequest.rootSessionId ?? previewRequest.sessionId) &&
					tab.file.sessionId === previewRequest.sessionId &&
					tab.file.source === previewRequest.source &&
					(previewRequest.fileId
						? tab.file.fileId === previewRequest.fileId
						: tab.file.relativePath === previewRequest.relativePath),
			);
			if (existing) return activateTab(workspace, existing.id);
			const tab: WorkspaceTab = {
				kind: "preview",
				id: crypto.randomUUID(),
				sessionId: previewRequest.rootSessionId ?? previewRequest.sessionId,
				title: previewRequest.name,
				file: previewRequest,
			};
			return placeTab(workspace, tab);
		});
	}, [placeTab, previewRequest, showToolsSidebar, updateWorkspace]);

	useEffect(() => {
		if (!planPreviewRequest) return;
		showToolsSidebar();
		const { sessionId, plan } = planPreviewRequest;
		updateWorkspace((workspace) => {
			const existing = workspaceTabs(workspace).find(
				(tab): tab is Extract<WorkspaceTab, { kind: "plan" }> =>
					tab.kind === "plan" && tab.sessionId === sessionId && tab.plan.planId === plan.planId,
			);
			if (existing) {
				return activateTab(
					mapTabs(workspace, (tab) =>
						tab.id === existing.id && tab.kind === "plan" ? { ...tab, title: plan.title, plan } : tab,
					),
					existing.id,
				);
			}
			return placeTab(workspace, {
				kind: "plan",
				id: plan.planId,
				sessionId,
				title: plan.title,
				plan,
			});
		});
	}, [placeTab, planPreviewRequest, showToolsSidebar, updateWorkspace]);

	// A pane's tool target is the session of its current tab, falling back to
	// the projected session when the pane is empty.
	const paneTarget = (paneId: string): { sessionId: string | null; cwd: string | null } => {
		const pane = workspace.panes.find((candidate) => candidate.id === paneId);
		const active = pane?.tabs.find((tab) => tab.id === pane.activeId);
		const sessionId = active?.sessionId ?? chatSessionId;
		if (sessionId === null) return { sessionId: null, cwd: null };
		return { sessionId, cwd: sessionsById.get(sessionId)?.cwd ?? (sessionId === chatSessionId ? chatCwd : null) };
	};

	// The "+ " in a pane strip starts a session beside that pane's context.
	const sessionTargetFor = (paneId: string) => {
		const target = paneTarget(paneId);
		return target.sessionId === null || target.cwd === null
			? null
			: { mode: sessionsById.get(target.sessionId)?.mode ?? mode, cwd: target.cwd };
	};

	// Tools always attach to the session behind the focused pane.
	const toolsTarget = useMemo(
		() => ({
			sessionId: focusedChatSession ?? null,
			cwd: focusedChatSession
				? (sessionsById.get(focusedChatSession)?.cwd ?? (focusedChatSession === chatSessionId ? chatCwd : null))
				: null,
		}),
		[focusedChatSession, sessionsById, chatSessionId, chatCwd],
	);

	const addTerminal = (target: { sessionId: string | null; cwd: string | null }) => {
		const { sessionId: ownerSessionId, cwd } = target;
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
			return { ...placeTab(workspace, tab), nextNumber: number + 1 };
		});
	};

	const addBrowser = useCallback(
		(
			target: { sessionId: string | null; cwd: string | null },
			profile = browserProfiles.find((candidate) => candidate.profileId === preferredBrowserProfileId.current) ??
				browserProfiles[0],
			onlyIfEmpty = false,
		) => {
			const { sessionId: ownerSessionId } = target;
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
			updateWorkspace((workspace) =>
				onlyIfEmpty && toolStripOf(workspace, ownerSessionId).tabs.length > 0
					? workspace
					: placeTab(workspace, tab),
			);
		},
		[browserProfiles, placeTab, t, updateWorkspace],
	);

	useEffect(() => {
		if (!visible || !sidebarOpen || sidebarClosing || !toolsTarget.sessionId || toolsStrip.tabs.length > 0) return;
		addBrowser(toolsTarget, undefined, true);
	}, [addBrowser, sidebarClosing, sidebarOpen, toolsTarget, toolsStrip.tabs.length, visible]);

	const browserProfileImported = (profile: DesktopBrowserProfile) => {
		setBrowserProfiles((current) =>
			current.some((candidate) => candidate.profileId === profile.profileId)
				? current.map((candidate) => (candidate.profileId === profile.profileId ? profile : candidate))
				: [...current, profile],
		);
		addBrowser(toolsTarget, profile);
	};

	const addFiles = (target: { sessionId: string | null; cwd: string | null }) => {
		const { sessionId: ownerSessionId, cwd } = target;
		if (!ownerSessionId || !cwd || mode !== "code") return;
		const stored = loadStoredFiles(ownerSessionId, cwd);
		setExpandedBySession((values) => {
			if (values.has(ownerSessionId)) return values;
			const next = new Map(values);
			next.set(ownerSessionId, stored.expandedPaths);
			return next;
		});
		updateWorkspace((workspace) => {
			const existing = [...workspaceTabs(workspace)]
				.reverse()
				.find((tab) => tab.kind === "file" && tab.sessionId === ownerSessionId);
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
			const files =
				restored.length > 0
					? restored
					: [
							{
								kind: "file" as const,
								id: crypto.randomUUID(),
								sessionId: ownerSessionId,
								title: t("Open file"),
								cwd,
								relativePath: null,
								fixed: false,
							},
						];
			const withAll = files.reduce((acc, tab) => placeTab(acc, tab), workspace);
			return activateTab(withAll, files[0]!.id);
		});
	};

	const addReview = useCallback(
		(target: { sessionId: string | null; cwd: string | null }) => {
			const { sessionId: ownerSessionId, cwd } = target;
			if (!ownerSessionId || !cwd || mode !== "code") return;
			updateWorkspace((workspace) => {
				const existing = workspaceTabs(workspace).find(
					(tab) => tab.kind === "review" && tab.sessionId === ownerSessionId,
				);
				if (existing) return activateTab(workspace, existing.id);
				const tab: WorkspaceTab = {
					kind: "review",
					id: crypto.randomUUID(),
					sessionId: ownerSessionId,
					title: t("Review"),
				};
				return placeTab(workspace, tab);
			});
		},
		[mode, placeTab, t, updateWorkspace],
	);

	const openCodeChanges = useCallback(
		(ownerSessionId: string, path?: string) => {
			showToolsSidebar();
			setReviewFocus({ sessionId: ownerSessionId, path, id: crypto.randomUUID() });
			addReview({
				sessionId: ownerSessionId,
				cwd: sessionsById.get(ownerSessionId)?.cwd ?? projectFor(ownerSessionId)?.cwd ?? null,
			});
		},
		[addReview, projectFor, sessionsById, showToolsSidebar],
	);

	const addAgent = (target: { sessionId: string | null; cwd: string | null }) => {
		const { sessionId: ownerSessionId } = target;
		if (!ownerSessionId) return;
		updateWorkspace((workspace) => {
			const existing = workspaceTabs(workspace).find(
				(tab) => tab.kind === "agent" && tab.sessionId === ownerSessionId,
			);
			const tab: WorkspaceTab = existing ?? {
				kind: "agent",
				id: crypto.randomUUID(),
				sessionId: ownerSessionId,
				title: t("Agents"),
			};
			return existing ? activateTab(workspace, existing.id) : placeTab(workspace, tab);
		});
	};

	const addKnowledge = useCallback(
		(targetSessionId: string | null) => {
			if (!targetSessionId) return;
			updateWorkspace((workspace) => {
				const existing = workspaceTabs(workspace).find(
					(tab) => tab.kind === "knowledge" && tab.sessionId === targetSessionId,
				);
				const tab: WorkspaceTab = existing ?? {
					kind: "knowledge",
					id: crypto.randomUUID(),
					sessionId: targetSessionId,
					title: t("Knowledge"),
				};
				return existing ? activateTab(workspace, existing.id) : placeTab(workspace, tab);
			});
		},
		[placeTab, t, updateWorkspace],
	);
	const handledKnowledgeRequest = useRef<number | undefined>(undefined);
	useEffect(() => {
		if (!knowledgeRequest || knowledgeRequest.id === handledKnowledgeRequest.current) return;
		handledKnowledgeRequest.current = knowledgeRequest.id;
		showToolsSidebar();
		addKnowledge(knowledgeRequest.sessionId);
	}, [addKnowledge, knowledgeRequest, showToolsSidebar]);

	const openFile = (ownerSessionId: string, cwd: string, relativePath: string, fix: boolean) => {
		mutateWorkspace((workspace) => {
			const existing = workspaceTabs(workspace).find(
				(tab) => tab.kind === "file" && tab.sessionId === ownerSessionId && tab.relativePath === relativePath,
			);
			let next = workspace;
			if (existing) {
				next = activateTab(workspace, existing.id);
				if (fix && existing.kind === "file" && !existing.fixed) {
					next = mapTabs(next, (tab) =>
						tab.id === existing.id && tab.kind === "file" ? { ...tab, fixed: true } : tab,
					);
				}
			} else {
				const preview = workspaceTabs(workspace).find(
					(tab) => tab.kind === "file" && tab.sessionId === ownerSessionId && !tab.fixed,
				);
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
					next = activateTab(
						mapTabs(workspace, (tab) => (tab.id === preview.id ? nextTab : tab)),
						nextTab.id,
					);
				} else {
					next = placeTab(workspace, nextTab);
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
			)
				return current;
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
			const fileTab = workspaceTabs(workspace).find(
				(tab): tab is Extract<WorkspaceTab, { kind: "file" }> => tab.kind === "file" && tab.id === tabId,
			);
			if (!fileTab || fileTab.fixed) return workspace;
			const next = mapTabs(workspace, (tab) => (tab.id === tabId ? { ...fileTab, fixed: true } : tab));
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
		)
			return;
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

	const applyWorkspaceMutation = (ownerSessionId: string, cwd: string, result: DesktopWorkspaceMutationResult) => {
		if (result.action === "create") {
			if (result.kind === "file") openFile(ownerSessionId, cwd, result.relativePath, true);
			return;
		}

		if (result.action === "trash") {
			const removedIds = new Set(
				workspaceTabs(workspace).flatMap((tab) =>
					tab.kind === "file" &&
					tab.sessionId === ownerSessionId &&
					tab.relativePath &&
					pathIsWithin(tab.relativePath, result.previousRelativePath)
						? [tab.id]
						: [],
				),
			);
			const expandedPaths = (expandedBySession.get(ownerSessionId) ?? []).filter(
				(path) => !pathIsWithin(path, result.previousRelativePath),
			);
			setExpandedBySession((current) => new Map(current).set(ownerSessionId, expandedPaths));
			setFileDrafts((current) => new Map([...current].filter(([id]) => !removedIds.has(id))));
			mutateWorkspace((latest) => {
				let next = removeTabs(latest, removedIds);
				if (!workspaceTabs(next).some((tab) => tab.kind === "file" && tab.sessionId === ownerSessionId)) {
					const placeholder: WorkspaceTab = {
						kind: "file",
						id: crypto.randomUUID(),
						sessionId: ownerSessionId,
						title: t("Open file"),
						cwd,
						relativePath: null,
						fixed: false,
					};
					next = activateTab(addTab(next, placeholder), placeholder.id);
				}
				saveStoredFiles(ownerSessionId, cwd, workspaceTabs(next), expandedPaths);
				return next;
			});
			return;
		}

		setFileDrafts(
			(current) =>
				new Map(
					[...current].map(([id, draft]) => {
						if (!pathIsWithin(draft.file.relativePath, result.previousRelativePath)) return [id, draft] as const;
						return [
							id,
							{
								...draft,
								file: {
									...draft.file,
									relativePath: remapPath(
										draft.file.relativePath,
										result.previousRelativePath,
										result.relativePath,
									),
									absolutePath: remapPath(
										draft.file.absolutePath,
										result.previousAbsolutePath,
										result.absolutePath,
									),
								},
							},
						] as const;
					}),
				),
		);
		const expandedPaths = (expandedBySession.get(ownerSessionId) ?? []).map((path) =>
			pathIsWithin(path, result.previousRelativePath)
				? remapPath(path, result.previousRelativePath, result.relativePath)
				: path,
		);
		setExpandedBySession((current) => new Map(current).set(ownerSessionId, expandedPaths));
		mutateWorkspace((latest) => {
			const next = mapTabs(latest, (tab) => {
				if (
					tab.kind !== "file" ||
					tab.sessionId !== ownerSessionId ||
					!tab.relativePath ||
					!pathIsWithin(tab.relativePath, result.previousRelativePath)
				)
					return tab;
				const relativePath = remapPath(tab.relativePath, result.previousRelativePath, result.relativePath);
				return { ...tab, relativePath, title: displayFileName(relativePath) };
			});
			saveStoredFiles(ownerSessionId, cwd, workspaceTabs(next), expandedPaths);
			return next;
		});
	};

	const selectTab = (id: string) => {
		toolsFocusedRef.current = findToolLocation(workspaceRef.current, id) !== null;
		mutateWorkspace((workspace) => activateTab(workspace, id));
	};

	// Working inside a pane (typing, scrolling a terminal) focuses it, so shortcuts
	// and the projected session follow the pane the user is actually using.
	const focusPane = (paneId: string) => {
		toolsFocusedRef.current = false;
		mutateWorkspace((workspace) => setActivePane(workspace, paneId));
	};
	const focusPaneContent = (paneId: string, target: EventTarget) => {
		// A background session's modal autofocus must not change the projected chat.
		if ((target as HTMLElement).closest('[role="dialog"], dialog')) return;
		focusPane(paneId);
	};

	const removeTabInternal = (id: string) => {
		const closing = workspaceTabs(workspace).find((tab) => tab.id === id);
		if (!closing) return;
		if (closing.kind === "terminal") void api.closeTerminal({ terminalId: id }).catch(onError);
		else if (closing.kind === "browser")
			void api.closeBrowser({ sessionId: closing.sessionId, browserId: id }).catch(onError);
		else if (closing.kind === "agent") store.selectAgentTranscript(closing.sessionId, null);
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
					expandedBySession.get(closing.sessionId) ??
						loadStoredFiles(closing.sessionId, closing.cwd).expandedPaths,
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

	closeTabRef.current = closeTab;

	useEffect(() => {
		if (closeTabRequest === undefined || closeTabRequest === handledCloseTabRequest.current) return;
		handledCloseTabRequest.current = closeTabRequest;
		if (!visible) return;
		const current = workspaceRef.current;
		if (sidebarOpen && toolsFocusedRef.current) {
			const sessionId = focusedChatTab(current)?.sessionId;
			const activeTool =
				sessionId === null || sessionId === undefined ? "" : toolStripOf(current, sessionId).activeId;
			if (activeTool) {
				closeTabRef.current(activeTool);
				return;
			}
		}
		const pane = activePane(current);
		if (pane.activeId) closeTabRef.current(pane.activeId);
	}, [closeTabRequest, sidebarOpen, visible]);

	// Ctrl+Tab / Ctrl+Shift+Tab cycle the focused pane's visible tabs; tabs
	// folded into a collapsed group are skipped, as in a browser.
	useEffect(() => {
		if (!visible) return;
		const cycle = (event: KeyboardEvent) => {
			if (event.key !== "Tab" || !event.ctrlKey || event.metaKey || event.altKey) return;
			const current = workspaceRef.current;
			const pane = activePane(current);
			const hidden = collapsedTabIds(pane, groupOf);
			const sessionId = focusedChatTab(current)?.sessionId;
			const strip = sidebarOpen && toolsFocusedRef.current && sessionId ? toolStripOf(current, sessionId) : pane;
			const tabs = strip.tabs.filter((tab) => !hidden.has(tab.id));
			if (tabs.length < 2) return;
			event.preventDefault();
			const index = tabs.findIndex((tab) => tab.id === strip.activeId);
			const next = tabs[(index + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length]!;
			mutateWorkspace((current) => activateTab(current, next.id));
		};
		// Capture phase: terminals and editors stop keydown propagation inside their panes.
		document.addEventListener("keydown", cycle, true);
		return () => document.removeEventListener("keydown", cycle, true);
	}, [groupOf, mutateWorkspace, sidebarOpen, visible]);

	useEffect(() => {
		if (pendingFileClose?.tabId) pendingCloseCancelRef.current?.focus();
	}, [pendingFileClose?.tabId]);

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
			const next = mapTabs(workspace, (tab) => {
				if (tab.kind !== "browser" || tab.id !== state.browserId) return tab;
				changed = tab.title !== state.title || tab.url !== state.url;
				return changed ? { ...tab, title: state.title, url: state.url } : tab;
			});
			return changed ? next : workspace;
		});
	};

	const handleDropOnStrip = (paneId: string, index: number) => {
		const drag = dragState;
		setDragState(null);
		setDropTarget(null);
		// Tool tabs live in the sidebar; only chat tabs can land on a pane strip.
		if (!drag || ("tabId" in drag && findToolLocation(workspace, drag.tabId) !== null)) return;
		mutateWorkspace((workspace) =>
			"group" in drag
				? moveTabGroup(workspace, drag.group.paneId, drag.group.key, groupOf, paneId, index)
				: moveTab(workspace, drag.tabId, paneId, index),
		);
	};

	const handleDropSplit = (paneId: string, direction: SplitDirection) => {
		const drag = dragState;
		setDragState(null);
		setDropTarget(null);
		if (!drag || "group" in drag || findToolLocation(workspace, drag.tabId) !== null) return;
		mutateWorkspace((workspace) => splitTab(workspace, drag.tabId, paneId, direction));
	};

	const rowCount = (row: 0 | 1) => workspace.panes.filter((pane) => pane.row === row).length;

	const fitsSplit = (paneId: string, direction: SplitDirection): boolean => {
		const root = panesRef.current;
		const target = workspace.panes.find((pane) => pane.id === paneId);
		if (!root || !target) return false;
		const rect = root.getBoundingClientRect();
		const width = Math.max(0, rect.width - (sidebarOpen && !sidebarClosing ? toolsSidebarWidth : 0));
		if (direction === "left" || direction === "right") {
			return width / (rowCount(target.row) + 1) >= MIN_PANE_WIDTH;
		}
		const otherRow = direction === "down" ? 1 : 0;
		const otherRowCount = rowCount(otherRow);
		return otherRowCount === 0 ? rect.height / 2 >= MIN_PANE_HEIGHT : width / (otherRowCount + 1) >= MIN_PANE_WIDTH;
	};

	const splitDropDirection = (event: DragEvent<HTMLElement>, paneId: string): SplitDirection | null => {
		// A dragged group lands in a strip; only single chat tabs open a new split.
		if (!dragState || "group" in dragState) return null;
		if (findToolLocation(workspace, dragState.tabId) !== null) return null;
		const rect = event.currentTarget.getBoundingClientRect();
		const horizontal = Math.min(120, rect.width * 0.25);
		const vertical = Math.min(120, rect.height * 0.25);
		const nearest = [
			{ direction: "left" as const, distance: event.clientX - rect.left, edge: horizontal },
			{ direction: "right" as const, distance: rect.right - event.clientX, edge: horizontal },
			{ direction: "up" as const, distance: event.clientY - rect.top, edge: vertical },
			{ direction: "down" as const, distance: rect.bottom - event.clientY, edge: vertical },
		]
			.filter((candidate) => candidate.distance >= 0 && candidate.distance <= candidate.edge)
			.sort((a, b) => a.distance - b.distance)[0];
		return nearest && canSplit(workspace, paneId, nearest.direction) && fitsSplit(paneId, nearest.direction)
			? nearest.direction
			: null;
	};

	// Drop slots are the visible tabs and group labels; each carries its index
	// in the strip's tabs, since a collapsed group's tabs are not on screen.
	const stripDropIndex = (event: DragEvent<HTMLElement>, fallback: number): number => {
		const slots = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-drop-index]")];
		for (const slot of slots) {
			const rect = slot.getBoundingClientRect();
			if (event.clientX < rect.left + rect.width / 2) return Number(slot.dataset.dropIndex);
		}
		return fallback;
	};

	const toolLauncher = (target: { sessionId: string | null; cwd: string | null }) => {
		const targetMode = target.sessionId === null ? mode : (sessionsById.get(target.sessionId)?.mode ?? mode);
		return (
			<nav aria-label={t("Available tools")} className="tool-sidebar-menu">
				{targetMode === "code" && (
					<button disabled={!target.cwd} onClick={() => addReview(target)} type="button">
						<ClipboardText aria-hidden="true" size={18} />
						<span>{t("Review")}</span>
					</button>
				)}
				<button disabled={!target.cwd} onClick={() => addTerminal(target)} type="button">
					<TerminalWindow aria-hidden="true" size={18} />
					<span>{t("Terminal")}</span>
				</button>
				{targetMode === "code" && (
					<button disabled={!target.cwd} onClick={() => addFiles(target)} type="button">
						<FileText aria-hidden="true" size={18} />
						<span>{t("Files")}</span>
					</button>
				)}
				<button disabled={!target.sessionId} onClick={() => addAgent(target)} type="button">
					<Robot aria-hidden="true" size={18} />
					<span>{t("Agents")}</span>
				</button>
				<button disabled={!target.sessionId} onClick={() => addKnowledge(target.sessionId)} type="button">
					<Books aria-hidden="true" size={18} />
					<span>{t("Knowledge")}</span>
				</button>
			</nav>
		);
	};

	useLayoutEffect(() => {
		const root = panesRef.current;
		if (!root || !visible) return;
		const measure = () => {
			const rect = root.getBoundingClientRect();
			const width = Math.max(0, rect.width - (sidebarOpen && !sidebarClosing ? toolsSidebarWidth : 0));
			const height = rect.height;
			setPaneViewport((current) =>
				current.width === width && current.height === height ? current : { width, height },
			);
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(root);
		return () => observer.disconnect();
	}, [sidebarOpen, sidebarClosing, toolsSidebarWidth, visible]);

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
				previous?.x === next.x &&
				previous.y === next.y &&
				previous.width === next.width &&
				previous.height === next.height
			)
				continue;
			panelRectsRef.current.set(panel, next);
			panel.style.transform = `translate(${next.x}px, ${next.y}px)`;
			panel.style.width = `${next.width}px`;
			panel.style.height = `${next.height}px`;
			panel.dispatchEvent(new Event("workspace-panel-layout"));
		}
	}, []);

	// biome-ignore lint/correctness/useExhaustiveDependencies(visible): Visibility changes require layout and observer registration.
	// biome-ignore lint/correctness/useExhaustiveDependencies(chatIsDraft): Switching between a draft and a session changes the mounted pane geometry.
	// biome-ignore lint/correctness/useExhaustiveDependencies(chatSessionId): Changing sessions dismisses tab actions and remeasures the active panes.
	// biome-ignore lint/correctness/useExhaustiveDependencies(workspace): Workspace changes mount different pane bodies and require layout and observer registration.
	// biome-ignore lint/correctness/useExhaustiveDependencies(paneViewport): Grid track projections change panel bounds.
	useLayoutEffect(() => {
		layoutPanels();
	}, [layoutPanels, workspace, chatSessionId, chatIsDraft, visible, paneViewport]);

	// biome-ignore lint/correctness/useExhaustiveDependencies(visible): Visibility changes require layout and observer registration.
	// biome-ignore lint/correctness/useExhaustiveDependencies(chatSessionId): Changing sessions dismisses tab actions and remeasures the active panes.
	// biome-ignore lint/correctness/useExhaustiveDependencies(workspace): Workspace changes mount different pane bodies and require layout and observer registration.
	useEffect(() => {
		const observer = new ResizeObserver(layoutPanels);
		if (panesRef.current) observer.observe(panesRef.current);
		for (const body of paneBodiesRef.current.values()) observer.observe(body);
		return () => observer.disconnect();
	}, [layoutPanels, workspace, chatSessionId, visible]);

	const tabIcon = (tab: WorkspaceTab): ReactNode => {
		if (tab.kind === "chat") {
			const tabMode = (tab.sessionId === null ? undefined : sessionsById.get(tab.sessionId)?.mode) ?? mode;
			return tabMode === "code" ? (
				<Code aria-hidden="true" data-mode="code" size={13} />
			) : (
				<ChatCircle aria-hidden="true" data-mode="chat" size={13} />
			);
		}
		return tab.kind === "knowledge" ? (
			<Books aria-hidden="true" size={13} />
		) : tab.kind === "terminal" || tab.kind === "process" ? (
			<TerminalWindow aria-hidden="true" size={13} />
		) : tab.kind === "browser" ? (
			<Globe aria-hidden="true" size={13} />
		) : tab.kind === "file" ? (
			tab.relativePath ? (
				<WorkspaceFileIcon path={tab.relativePath} size={13} />
			) : (
				<FileText aria-hidden="true" size={13} />
			)
		) : tab.kind === "review" ? (
			<ClipboardText aria-hidden="true" size={13} />
		) : tab.kind === "agent" ? (
			<Robot aria-hidden="true" size={13} />
		) : tab.kind === "plan" ? (
			<FileText aria-hidden="true" size={13} />
		) : (
			<WorkspaceFileIcon path={tab.title} size={13} />
		);
	};

	// One tab element serves pane strips and the tools strip; `stripId` is the
	// pane id or the "tools" sentinel, and drives context-menu scoping.
	const renderTab = (
		stripId: string,
		tabs: readonly WorkspaceTab[],
		activeId: string,
		tab: WorkspaceTab,
		project: WorkspaceProject | null,
	) => {
		const displayTitle =
			tab.kind === "chat"
				? tab.agentId
					? (tab.agentName ?? tab.agentId)
					: tab.sessionId === null
						? t("New task")
						: sessionTitleFor(tab.sessionId)
				: tab.kind === "browser" && tab.url === ""
					? t("New tab")
					: tab.kind === "file" && tab.relativePath === null
						? t("Open file")
						: tab.title;
		const draft = tab.kind === "file" ? fileDrafts.get(tab.id) : undefined;
		const dirty = draft !== undefined && draft.text !== draft.savedText;
		const saving = savingFileTabIds.has(tab.id);
		const active = activeId === tab.id;
		// Chat tabs carry their session's live status so background panes stay readable at a glance.
		const session = tab.kind === "chat" && tab.sessionId !== null ? sessionsById.get(tab.sessionId) : undefined;
		const indicator = session
			? sessionIndicator(session, visible && active && tab.sessionId === chatSessionId)
			: undefined;
		const indicatorLabel = indicator ? SESSION_INDICATOR_LABELS[indicator] : undefined;
		// The status goes in the description, like the sidebar, so a tab keeps a stable name.
		const label = dirty ? `${displayTitle}, ${t("Unsaved")}` : displayTitle;
		const openMenu = (anchor: {
			x: number;
			y: number;
			trigger: HTMLElement | null;
			focusTrigger?: HTMLElement | null;
		}) => {
			setTabMenu({ paneId: stripId, tabId: tab.id, ...anchor });
		};
		return (
			// biome-ignore lint/a11y/noStaticElementInteractions: The tab wrapper owns dragging and pointer shortcuts; its native buttons supply the same keyboard actions.
			<div
				className={`tool-tab${active ? " is-active" : ""}${tab.kind === "file" && !tab.fixed ? " is-preview" : ""}${dirty ? " is-dirty" : ""}`}
				onAuxClick={(event) => {
					// Middle-click closes, matching browsers and editors.
					if (event.button !== 1) return;
					event.preventDefault();
					closeTab(tab.id);
				}}
				onContextMenu={(event) => {
					event.preventDefault();
					openMenu({
						x: event.clientX,
						y: event.clientY,
						trigger: null,
						focusTrigger: event.currentTarget.querySelector<HTMLElement>(".tool-tab-select"),
					});
				}}
				data-drop-index={tabs.indexOf(tab)}
				data-tab-motion-key={tab.id}
				draggable
				key={tab.id}
				onDragEnd={() => {
					setDragState(null);
					setDropTarget(null);
				}}
				onDragStart={(event) => {
					event.dataTransfer.setData("text/plain", tab.id);
					event.dataTransfer.effectAllowed = "move";
					setDragState({ tabId: tab.id });
				}}
			>
				<button
					aria-description={indicatorLabel ? t(indicatorLabel) : undefined}
					aria-selected={active}
					aria-label={label}
					className="tool-tab-select"
					data-tab-id={tab.id}
					onClick={() => selectTab(tab.id)}
					onFocus={() => {
						toolsFocusedRef.current = stripId === "tools";
					}}
					onKeyDown={(event) => {
						// Keyboard context menu (Menu key / Shift+F10) anchors to the tab.
						if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
						event.preventDefault();
						const rect = event.currentTarget.getBoundingClientRect();
						openMenu({ x: rect.left, y: rect.bottom, trigger: event.currentTarget });
					}}
					role="tab"
					tabIndex={active ? 0 : -1}
					title={project ? `${displayTitle}\n${project.cwd}` : displayTitle}
					type="button"
				>
					{tabIcon(tab)}
					<span>{displayTitle}</span>
					{indicator && <i aria-hidden="true" className="tool-tab-status" data-status={indicator} />}
				</button>
				<button
					aria-label={t("Close {{name}}", { name: displayTitle })}
					className="tool-tab-close"
					disabled={saving}
					onClick={() => closeTab(tab.id)}
					tabIndex={active ? 0 : -1}
					type="button"
				>
					<X aria-hidden="true" size={11} />
				</button>
			</div>
		);
	};

	// Roving focus across one strip's tabs: arrows/Home/End move focus and
	// selection together, matching the Ctrl+Tab cycle; the strip's own DOM
	// order already skips tabs folded into collapsed groups.
	const handleStripKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
		const current = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]');
		if (!current) return;
		const tabs = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]')];
		const index = tabs.indexOf(current);
		if (index < 0) return;
		const delta = event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0;
		const target =
			delta !== 0
				? tabs[(index + delta + tabs.length) % tabs.length]
				: event.key === "Home"
					? tabs[0]
					: event.key === "End"
						? tabs[tabs.length - 1]
						: undefined;
		if (target === undefined) return;
		event.preventDefault();
		target.focus({ preventScroll: true });
		const strip = target.closest<HTMLElement>(".tool-tabs-scroll");
		if (strip) revealTabInStrip(target.closest<HTMLElement>(".tool-tab") ?? target, strip);
		const tabId = target.dataset.tabId;
		if (tabId) selectTab(tabId);
	};

	const renderTabStrip = (pane: WorkspacePane, inTitlebar = false) => {
		const runs = tabGroupRuns(
			pane.tabs,
			(tab) => (tab.sessionId === null ? null : projectFor(tab.sessionId)),
			(project) => project.key,
		);
		// A pane holding one project needs no labels; with several, each project
		// is one labelled, collapsible group.
		const grouped = new Set(runs.flatMap((run) => (run.group ? [run.group.key] : []))).size > 1;
		const hidden = grouped ? collapsedTabIds(pane, groupOf) : new Set<string>();
		// With several panes, the focused pane's active tab stays bright and the others dim.
		const split = workspace.panes.length > 1;
		const focused = split && pane.id === workspace.activePaneId;
		return (
			<div
				className={`workspace-tabbar${inTitlebar ? " workspace-tabbar--titlebar" : ""}${focused ? " is-focused" : ""}${split && !focused ? " is-unfocused" : ""}${dropTarget && "paneId" in dropTarget && dropTarget.paneId === pane.id ? " is-drop-target" : ""}`}
				data-pane-id={pane.id}
				onFocusCapture={() => {
					toolsFocusedRef.current = false;
				}}
				onKeyDown={handleStripKeyDown}
				onPointerDownCapture={() => {
					toolsFocusedRef.current = false;
				}}
				onDragLeave={() =>
					setDropTarget((current) =>
						current && "paneId" in current && current.paneId === pane.id ? null : current,
					)
				}
				onDragOver={(event) => {
					if (!dragState) return;
					if ("tabId" in dragState && findToolLocation(workspace, dragState.tabId) !== null) return;
					event.preventDefault();
					event.stopPropagation();
					event.dataTransfer.dropEffect = "move";
					setDropTarget({ paneId: pane.id, index: stripDropIndex(event, pane.tabs.length) });
				}}
				onDrop={(event) => {
					event.preventDefault();
					event.stopPropagation();
					handleDropOnStrip(pane.id, stripDropIndex(event, pane.tabs.length));
				}}
				role="tablist"
			>
				<div className="tool-tabs-scroll" ref={tabStripRef(pane.id)}>
					<WorkspaceTabMotion
						layoutKey={pane.tabs.map((tab) => tab.id).join("\0")}
						onSettled={syncTabIndicators}
						prepareLayout={applyWorkspaceTabSizing}
						scope={pane.id}
						suspended={tabMotionSuspended}
					>
						{grouped
							? runs.map((run, index) => {
									const first = run.tabs[0]!;
									if (!run.group) {
										const tabs = run.tabs.map((tab) =>
											renderTab(pane.id, pane.tabs, pane.activeId, tab, null),
										);
										return index === 0
											? tabs
											: [
													<span
														aria-hidden="true"
														className="tool-tab-group-gap"
														key={`gap-${first.id}`}
													/>,
													...tabs,
												];
									}
									const group = run.group;
									const collapsed = run.tabs.every((tab) => hidden.has(tab.id));
									// A drawer on its way shut already wears the collapsed look.
									const shownCollapsed = collapsed || closingGroups.has(`${pane.id}${group.key}`);
									const groupLabel = t("{{name}} tab group", { name: group.name });
									return (
										<div
											className={`tool-tab-group${shownCollapsed ? " is-collapsed" : ""}`}
											key={`group-${group.key}`}
											role="presentation"
											style={{ "--tab-group-color": tabGroupColor(group.key) } as CSSProperties}
										>
											<button
												aria-description={
													shownCollapsed
														? t("{{count}} tabs hidden", { count: run.tabs.length })
														: undefined
												}
												aria-expanded={!shownCollapsed}
												aria-label={groupLabel}
												className="tool-tab-group-label"
												data-drop-index={pane.tabs.indexOf(first)}
												draggable
												onClick={(event) =>
													toggleGroupAnimated(event.currentTarget, pane.id, group.key, collapsed)
												}
												onDragEnd={() => {
													setDragState(null);
													setDropTarget(null);
												}}
												onDragStart={(event) => {
													event.dataTransfer.setData("text/plain", group.key);
													event.dataTransfer.effectAllowed = "move";
													setDragState({ group: { paneId: pane.id, key: group.key } });
												}}
												title={group.cwd}
												type="button"
											>
												<span className="tool-tab-group-name">{group.name}</span>
												{shownCollapsed && (
													<span aria-hidden="true" className="tool-tab-group-count">
														{run.tabs.length}
													</span>
												)}
											</button>
											{!collapsed && (
												<div className="tool-tab-group-body" ref={groupBodyRef(pane.id, group.key)}>
													{run.tabs.map((tab) => renderTab(pane.id, pane.tabs, pane.activeId, tab, group))}
												</div>
											)}
										</div>
									);
								})
							: pane.tabs.map((tab) =>
									renderTab(
										pane.id,
										pane.tabs,
										pane.activeId,
										tab,
										tab.sessionId === null ? null : projectFor(tab.sessionId),
									),
								)}
					</WorkspaceTabMotion>
					<span aria-hidden="true" className="tool-tab-indicator" />
				</div>
				<div className="tool-add">
					<button
						aria-label={t("New session")}
						className="session-add-trigger"
						onClick={() => {
							focusPane(pane.id);
							onNewSession?.(sessionTargetFor(pane.id));
						}}
						type="button"
					>
						<Plus aria-hidden="true" size={13} />
					</button>
				</div>
				<div aria-hidden="true" className="workspace-tabbar-fill" />
			</div>
		);
	};

	const renderPanels = () => {
		let chatHost: { pane: WorkspacePane; tab: WorkspaceTab } | null = null;
		for (const pane of workspace.panes) {
			const tab = pane.tabs.find(
				(candidate) =>
					candidate.kind === "chat" &&
					!candidate.agentId &&
					(candidate.sessionId === chatSessionId || (chatIsDraft && candidate.sessionId === null)),
			);
			if (tab) {
				chatHost = { pane, tab };
				break;
			}
		}
		return workspace.panes.flatMap((pane) => {
			// The portal tab menu no longer hides pane content; only native browser
			// surfaces need covering while it is open.
			const panelVisible = (tabId: string) => visible && pane.activeId === tabId;
			const host = chatHost && chatHost.pane === pane ? chatHost : null;
			const wrap = (tabId: string, content: ReactNode) => (
				<div
					className="workspace-panel"
					data-pane-id={pane.id}
					hidden={!panelVisible(tabId)}
					key={tabId}
					onFocusCapture={(event) => focusPaneContent(pane.id, event.target)}
					onPointerDownCapture={() => focusPane(pane.id)}
				>
					{content}
				</div>
			);
			const chatViewFor = (tab: WorkspaceTab, isHost: boolean): ReactNode => {
				// The host pane keeps showing the draft/loading node while it is
				// provided; once App hands down null, the pane's own live view takes
				// over — including the projected session the host tab belongs to.
				if (tab.kind === "chat" && tab.agentId && tab.sessionId)
					return (
						<AgentConversation
							target={{ sessionId: tab.sessionId, agentId: tab.agentId, name: tab.agentName ?? tab.agentId }}
							context={chatView}
							visible={panelVisible(tab.id)}
							onOpenParent={(target) => {
								if (typeof target === "string") {
									onAgentConversationFocusRef.current?.(null);
									onChatSessionRef.current(target);
									const existing = findChatTab(workspaceRef.current, target);
									if (existing) mutateWorkspace((current) => activateTab(current, existing.id));
								} else openAgentConversation(target);
							}}
						/>
					);
				if (isHost && (chat !== null || tab.sessionId === null)) return chat;
				if (tab.sessionId === null) return null;
				const tabVisible = panelVisible(tab.id);
				return (
					<SessionChatView
						{...chatView}
						canonicalComposer={chat === null && tab.sessionId === chatSessionId}
						focused={tab.sessionId === chatSessionId && tabVisible}
						sessionId={tab.sessionId}
						visible={tabVisible}
					/>
				);
			};
			return [
				host ? (
					<div
						className="workspace-panel"
						data-pane-id={pane.id}
						hidden={pane.activeId !== host.tab.id || !visible}
						key={host.tab.id}
						onFocusCapture={(event) => focusPaneContent(pane.id, event.target)}
						onPointerDownCapture={() => focusPane(pane.id)}
					>
						<div className="workspace-chat-panel">{chatViewFor(host.tab, true)}</div>
					</div>
				) : null,
				// Every chat tab keeps its own view mounted so composer drafts and
				// transcript scroll survive tab switches; the host tab renders
				// through the host panel above.
				...pane.tabs.flatMap((tab) =>
					tab === host?.tab || tab.sessionId === null
						? []
						: wrap(tab.id, <div className="workspace-chat-panel">{chatViewFor(tab, false)}</div>),
				),
			];
		});
	};

	// Every session's tool tabs stay mounted (hidden) so terminals and editors
	// keep their state; only the focused session's strip shows.
	const renderToolPanels = () =>
		[...workspace.tools.entries()].flatMap(([toolSessionId, strip]) => {
			const stripFocused = toolSessionId === focusedChatSession;
			const ownerTarget = { sessionId: toolSessionId, cwd: sessionsById.get(toolSessionId)?.cwd ?? null };
			const fileTabs = strip.tabs.filter(
				(tab): tab is Extract<WorkspaceTab, { kind: "file" }> => tab.kind === "file",
			);
			const activeTab = strip.tabs.find((tab) => tab.id === strip.activeId);
			const panelVisible = (tabId: string) => visible && sidebarOpen && stripFocused && strip.activeId === tabId;
			const wrap = (tabId: string, content: ReactNode) => (
				<div className="tool-sidebar-panel" hidden={!panelVisible(tabId)} key={tabId}>
					{content}
				</div>
			);
			return [
				...strip.tabs.flatMap((tab) =>
					tab.kind === "process"
						? wrap(
								tab.id,
								<ProcessPanel
									panelId={`process-panel-${tab.id}`}
									process={tab.process}
									theme={theme}
									onError={onError}
									visible={panelVisible(tab.id)}
								/>,
							)
						: tab.kind === "terminal"
							? wrap(
									tab.id,
									<TerminalPanel
										api={api}
										cwd={tab.cwd}
										terminalId={tab.id}
										theme={theme}
										visible={panelVisible(tab.id)}
									/>,
								)
							: tab.kind === "browser"
								? wrap(
										tab.id,
										<BrowserPanel
											api={api}
											browserId={tab.id}
											controlState={tab.controlState}
											covered={tabMenu !== null || resizingAxis !== null}
											handoffReason={tab.handoffReason}
											sessionId={tab.sessionId}
											onError={onError}
											onOpenProfile={(profile) => {
												const selected = browserProfiles.find(
													(candidate) => candidate.profileId === profile.profileId,
												);
												if (selected) addBrowser(ownerTarget, selected);
											}}
											onProfileImported={browserProfileImported}
											onState={updateBrowserState}
											profile={{ profileId: tab.profileId, name: tab.profileName }}
											profiles={browserProfiles}
											startPageTools={toolLauncher(ownerTarget)}
											visible={panelVisible(tab.id)}
										/>,
									)
								: tab.kind === "knowledge"
									? wrap(
											tab.id,
											<KnowledgePanel api={api} sessionId={tab.sessionId} visible={panelVisible(tab.id)} />,
										)
									: tab.kind === "review"
										? wrap(
												tab.id,
												<ReviewPanel
													focusRequest={reviewFocus?.sessionId === tab.sessionId ? reviewFocus : undefined}
													api={api}
													sessionId={tab.sessionId}
													theme={theme}
													visible={panelVisible(tab.id)}
												/>,
											)
										: tab.kind === "agent"
											? wrap(
													tab.id,
													<AgentTreePanel
														onOpenConversation={(agent) =>
															openAgentConversation({
																sessionId: tab.sessionId,
																agentId: agent.agentId,
																name: agent.name,
															})
														}
														api={api}
														onError={onError}
														sessionId={tab.sessionId}
														store={store}
														visible={panelVisible(tab.id)}
													/>,
												)
											: tab.kind === "plan"
												? wrap(
														tab.id,
														<div
															className="tool-panel plan-panel"
															id={`plan-panel-${tab.id}`}
															role="tabpanel"
														>
															<PlanPreview plan={tab.plan} />
														</div>,
													)
												: tab.kind === "preview"
													? wrap(
															tab.id,
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
														)
													: [],
				),
				// All file tabs of one session share a single FilePanel (tree + editor).
				fileTabs.length > 0
					? (() => {
							const fileSessionId = toolSessionId;
							const groupActiveTab = activeTab?.kind === "file" ? activeTab : fileTabs.at(-1);
							const cwd = fileTabs[0]!.cwd;
							const dirtyPaths = fileTabs.flatMap((tab) => {
								const draft = fileDrafts.get(tab.id);
								return tab.relativePath && draft && draft.text !== draft.savedText ? [tab.relativePath] : [];
							});
							const savingPaths = fileTabs.flatMap((tab) =>
								tab.relativePath && savingFileTabIds.has(tab.id) ? [tab.relativePath] : [],
							);
							const groupVisible = visible && sidebarOpen && stripFocused && activeTab?.kind === "file";
							return (
								<div className="tool-sidebar-panel" hidden={!groupVisible} key={`files-${fileSessionId}`}>
									<FilePanel
										activePath={groupActiveTab?.relativePath ?? null}
										api={api}
										cwd={cwd}
										draft={groupActiveTab ? (fileDrafts.get(groupActiveTab.id) ?? null) : null}
										dirtyPaths={dirtyPaths}
										expandedPaths={expandedBySession.get(fileSessionId) ?? []}
										onDraftChange={(text) => {
											if (groupActiveTab) updateFileDraft(fileSessionId, groupActiveTab.id, text);
										}}
										onDraftLoaded={(file) => {
											if (groupActiveTab) loadFileDraft(groupActiveTab.id, file);
										}}
										onError={onError}
										onExpandedPathsChange={(paths) => updateExpandedPaths(fileSessionId, cwd, paths)}
										onOpenFile={(relativePath, fix) => openFile(fileSessionId, cwd, relativePath, fix)}
										onSave={async () => {
											if (groupActiveTab) await saveFileTab(fileSessionId, groupActiveTab.id);
										}}
										onWorkspaceMutation={(result) => applyWorkspaceMutation(fileSessionId, cwd, result)}
										saving={groupActiveTab ? savingFileTabIds.has(groupActiveTab.id) : false}
										savingPaths={savingPaths}
										sessionId={fileSessionId}
										visible={groupVisible}
									/>
								</div>
							);
						})()
					: null,
			];
		});

	// The tools strip sits level with the session strips in the titlebar row;
	// it shares the same measured tab width and scrolls when the sidebar is narrow.
	const renderToolsStrip = () => {
		return (
			<div
				className={`workspace-tabbar workspace-tabbar--titlebar tool-sidebar-tabbar${dropTarget && "paneId" in dropTarget && dropTarget.paneId === "tools" ? " is-drop-target" : ""}`}
				onDragLeave={() =>
					setDropTarget((current) =>
						current && "paneId" in current && current.paneId === "tools" ? null : current,
					)
				}
				onDragOver={(event) => {
					if (!dragState || "group" in dragState) return;
					// Only tool tabs may reorder inside the sidebar strip.
					if (findToolLocation(workspace, dragState.tabId) === null) return;
					event.preventDefault();
					event.stopPropagation();
					event.dataTransfer.dropEffect = "move";
					setDropTarget({ paneId: "tools", index: stripDropIndex(event, toolsStrip.tabs.length) });
				}}
				onDrop={(event) => {
					event.preventDefault();
					event.stopPropagation();
					const drag = dragState;
					setDragState(null);
					setDropTarget(null);
					if (drag && "tabId" in drag) {
						mutateWorkspace((current) =>
							moveToolTab(current, drag.tabId, stripDropIndex(event, toolsStrip.tabs.length)),
						);
					}
				}}
				onFocusCapture={() => {
					toolsFocusedRef.current = true;
				}}
				onKeyDown={handleStripKeyDown}
				onPointerDownCapture={() => {
					toolsFocusedRef.current = true;
				}}
				role="tablist"
			>
				<div className="tool-tabs-scroll" ref={toolsScrollRef}>
					<WorkspaceTabMotion
						layoutKey={toolsStrip.tabs.map((tab) => tab.id).join("\0")}
						prepareLayout={applyWorkspaceTabSizing}
						scope={`tools:${focusedChatSession ?? ""}`}
						suspended={tabMotionSuspended}
					>
						{toolsStrip.tabs.map((tab) =>
							renderTab(
								"tools",
								toolsStrip.tabs,
								toolsStrip.activeId,
								tab,
								tab.sessionId ? projectFor(tab.sessionId) : null,
							),
						)}
					</WorkspaceTabMotion>
				</div>
				{toolsStrip.tabs.length > 0 && (
					<div className="tool-add">
						<button
							aria-label={t("New browser tab")}
							className="tool-add-trigger"
							onClick={() => addBrowser(toolsTarget)}
							type="button"
						>
							<Plus aria-hidden="true" size={13} />
						</button>
					</div>
				)}
			</div>
		);
	};

	const startToolsResize = (event: ReactPointerEvent<HTMLElement>) => {
		if (!onToolsSidebarWidthChange) return;
		event.preventDefault();
		setToolsResizing(true);
		const startX = event.clientX;
		const startWidth = toolsSidebarWidth;
		const move = (moveEvent: globalThis.PointerEvent) => {
			onToolsSidebarWidthChange(clampToolsSidebarWidth(startWidth + startX - moveEvent.clientX));
		};
		const up = () => {
			window.removeEventListener("pointermove", move);
			window.removeEventListener("pointerup", up);
			window.removeEventListener("pointercancel", up);
			setToolsResizing(false);
		};
		window.addEventListener("pointermove", move);
		window.addEventListener("pointerup", up);
		window.addEventListener("pointercancel", up);
	};

	const splitTarget = dropTarget && "split" in dropTarget ? dropTarget.split : null;

	// The top row's strips ride inside the window titlebar, one cell per pane,
	// so the chrome stays a single row whether or not the workspace is split;
	// cells share the panes' flex sizing and borders, so they line up with the
	// columns below. A second row keeps its strips inside its panes. Without a
	// titlebar slot (standalone rendering/tests) every strip stays in its pane.
	const stripsInTitlebar = titlebarTabsSlot != null;
	const topPanes = workspace.panes.filter((pane) => pane.row === 0);
	const rows = ([0, 1] as const).filter((row) => workspace.panes.some((pane) => pane.row === row));
	const rowSizes = projectPaneSizes(
		rows.map((row) => workspace.rowWeights?.[row] ?? 1),
		Math.max(0, paneViewport.height - (rows.length - 1)),
		MIN_PANE_HEIGHT,
	);
	const gridTracks = (sizes: readonly number[], weights: readonly number[], measured: number) =>
		sizes
			.map(
				(size, index) =>
					`${index ? "1px " : ""}${measured > 0 ? `${size}px` : `minmax(0, ${weights[index] ?? 1}fr)`}`,
			)
			.join(" ");
	const columnSizes = (panes: readonly WorkspacePane[]) =>
		projectPaneSizes(
			panes.map((pane) => pane.weight ?? 1),
			Math.max(0, paneViewport.width - (panes.length - 1)),
			MIN_PANE_WIDTH,
		);
	const columnTemplate = (panes: readonly WorkspacePane[]) =>
		gridTracks(
			columnSizes(panes),
			panes.map((pane) => pane.weight ?? 1),
			paneViewport.width,
		);
	const resizeState = (axis: "column" | "row", active: boolean) => {
		setResizingAxis(active ? axis : null);
		setLayoutResizing(active);
	};
	const columnResizer = (panes: readonly WorkspacePane[], boundary: number, header = false) => (
		<WorkspacePaneResizer
			axis="column"
			label={t("Resize workspace columns")}
			sizes={columnSizes(panes)}
			boundary={boundary}
			minimum={MIN_PANE_WIDTH}
			focusable={!header}
			groupKey={panes.map((pane) => pane.id).join(",")}
			onChange={(sizes) => {
				markLayoutIntent();
				updateWorkspace((current) =>
					setPaneWeights(current, panes[0]!.row, new Map(panes.map((pane, index) => [pane.id, sizes[index]!]))),
				);
			}}
			onCommit={markLayoutIntent}
			onResizingChange={(active) => resizeState("column", active)}
			onReset={() => {
				markLayoutIntent();
				updateWorkspace((current) =>
					setPaneWeights(current, panes[0]!.row, new Map(panes.map((pane) => [pane.id, 1]))),
				);
			}}
		/>
	);

	const workspaceContent = (
		<div
			className={`session-workspace-root${resizingAxis ? ` is-pane-resizing is-pane-resizing--${resizingAxis}` : ""}`}
			hidden={!visible}
			onPointerDownCapture={cancelRestore}
			onKeyDownCapture={cancelRestore}
		>
			{visible && stripsInTitlebar
				? createPortal(
						<div
							className="workspace-titlebar-strips"
							style={{ display: "grid", gridTemplateColumns: columnTemplate(topPanes) }}
						>
							{topPanes.map((pane, index) => (
								<Fragment key={pane.id}>
									{index > 0 && columnResizer(topPanes, index, true)}
									<div
										className="workspace-titlebar-cell"
										key={pane.id}
										style={{
											paddingRight:
												index === topPanes.length - 1 && (!sidebarOpen || sidebarClosing) ? 36 : 0,
										}}
									>
										{renderTabStrip(pane, true)}
									</div>
								</Fragment>
							))}
						</div>,
						titlebarTabsSlot!,
					)
				: null}
			{visible && sidebarOpen && titlebarToolsSlot ? createPortal(renderToolsStrip(), titlebarToolsSlot) : null}
			<div className="session-workspace-instance">
				<div
					className={`session-workspace-panes${dragState ? " is-dragging" : ""}`}
					ref={panesRef}
					style={{
						paddingRight: sidebarOpen && !sidebarClosing ? toolsSidebarWidth : 0,
						display: "grid",
						gridTemplateRows: gridTracks(
							rowSizes,
							rows.map((row) => workspace.rowWeights?.[row] ?? 1),
							paneViewport.height,
						),
					}}
				>
					{rows.map((row, rowIndex) => {
						const rowPanes = workspace.panes.filter((pane) => pane.row === row);
						if (rowPanes.length === 0) return null;
						return (
							<Fragment key={row}>
								{rowIndex > 0 && (
									<WorkspacePaneResizer
										axis="row"
										label={t("Resize workspace rows")}
										sizes={rowSizes}
										boundary={rowIndex}
										minimum={MIN_PANE_HEIGHT}
										groupKey={rows.join(",")}
										onChange={(sizes) => {
											markLayoutIntent();
											updateWorkspace((current) => setRowWeights(current, sizes));
										}}
										onCommit={markLayoutIntent}
										onResizingChange={(active) => resizeState("row", active)}
										onReset={() => {
											markLayoutIntent();
											updateWorkspace((current) => setRowWeights(current, [1, 1]));
										}}
									/>
								)}
								<div
									className="workspace-row"
									style={{ display: "grid", gridTemplateColumns: columnTemplate(rowPanes) }}
								>
									{rowPanes.map((pane, index) => (
										<Fragment key={pane.id}>
											{index > 0 && columnResizer(rowPanes, index)}
											<section
												aria-label={t("Workspace")}
												className={`workspace-pane${splitTarget?.paneId === pane.id ? " is-split-target" : ""}`}
												data-split-direction={
													splitTarget?.paneId === pane.id ? splitTarget.direction : undefined
												}
												key={pane.id}
												onDragLeave={(event) => {
													if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
													setDropTarget((current) =>
														current && "split" in current && current.split.paneId === pane.id
															? null
															: current,
													);
												}}
												onDragOver={(event) => {
													if (!dragState) return;
													event.preventDefault();
													const direction = splitDropDirection(event, pane.id);
													if (direction) {
														event.dataTransfer.dropEffect = "move";
														setDropTarget({ split: { paneId: pane.id, direction } });
													} else {
														setDropTarget({ paneId: pane.id, index: pane.tabs.length });
													}
												}}
												onDrop={(event) => {
													event.preventDefault();
													const direction = splitDropDirection(event, pane.id);
													if (direction) handleDropSplit(pane.id, direction);
													else handleDropOnStrip(pane.id, pane.tabs.length);
												}}
											>
												{stripsInTitlebar && pane.row === 0 ? null : renderTabStrip(pane)}
												<div
													className="workspace-pane-body"
													ref={(element) => {
														if (element) paneBodiesRef.current.set(pane.id, element);
														else paneBodiesRef.current.delete(pane.id);
													}}
												>
													{pane.tabs.length === 0 && (
														<div
															className="workspace-empty"
															role="tabpanel"
															onPointerDown={() => focusPane(pane.id)}
														>
															<p>{t("Pick a session from the sidebar.")}</p>
															{onNewSession && (
																<button
																	className="button-secondary"
																	onClick={() => {
																		focusPane(pane.id);
																		onNewSession(null);
																	}}
																	type="button"
																>
																	<Plus aria-hidden="true" size={13} />
																	{t("Start a new task")}
																</button>
															)}
															{workspace.panes.length > 1 && (
																<button
																	className="button-secondary"
																	type="button"
																	onClick={() =>
																		mutateWorkspace((current) => closeEmptyPane(current, pane.id))
																	}
																>
																	{t("Close empty pane")}
																</button>
															)}
														</div>
													)}
												</div>
											</section>
										</Fragment>
									))}
								</div>
							</Fragment>
						);
					})}
					<div className="workspace-panel-layer" ref={panelLayerRef}>
						{renderPanels()}
					</div>
				</div>
				{/* The aside stays mounted when closed: hidden instead of unmounted so
			    terminals, browsers and editors keep their sessions and state. */}
				<aside
					className={`tool-sidebar${sidebarClosing ? " is-closing" : ""}`}
					hidden={!sidebarOpen}
					onFocusCapture={() => {
						toolsFocusedRef.current = true;
					}}
					onPointerDownCapture={() => {
						toolsFocusedRef.current = true;
					}}
					style={{ width: `${toolsSidebarWidth}px` }}
				>
					<hr
						aria-valuenow={toolsSidebarWidth}
						aria-valuemin={clampToolsSidebarWidth(0)}
						aria-valuemax={clampToolsSidebarWidth(Number.MAX_SAFE_INTEGER)}
						aria-label={t("Resize tools sidebar")}
						aria-orientation="vertical"
						className="tool-sidebar-resizer"
						onKeyDown={(event) => {
							if (!onToolsSidebarWidthChange) return;
							if (event.key === "ArrowLeft")
								onToolsSidebarWidthChange(clampToolsSidebarWidth(toolsSidebarWidth + 16));
							else if (event.key === "ArrowRight")
								onToolsSidebarWidthChange(clampToolsSidebarWidth(toolsSidebarWidth - 16));
							else return;
							event.preventDefault();
						}}
						onPointerDown={startToolsResize}
						tabIndex={0}
					/>
					{titlebarToolsSlot ? null : <div className="tool-sidebar-head">{renderToolsStrip()}</div>}
					<div className="tool-sidebar-body">{renderToolPanels()}</div>
				</aside>
			</div>
			{tabMenu &&
				(() => {
					const isToolTab = findToolLocation(workspace, tabMenu.tabId) !== null;
					const otherPanes = workspace.panes.filter((pane) => pane.id !== tabMenu.paneId);
					const items: WorkspaceTabMenuItem[] = [
						...(isToolTab
							? []
							: (["right", "down"] as const).flatMap((direction): WorkspaceTabMenuItem[] => {
									// Grid limits and a too-small window get distinct copy.
									const limit = getSplitLimitReason(workspace, tabMenu.paneId, direction);
									const reason = limit
										? t(SPLIT_LIMIT_LABEL[limit])
										: !fitsSplit(tabMenu.paneId, direction)
											? t("Not enough room to split")
											: undefined;
									return [
										{
											key: `split-${direction}`,
											label: direction === "right" ? t("Split right") : t("Split down"),
											disabled: reason !== undefined,
											title: reason,
											onSelect: () =>
												mutateWorkspace((ws) => splitTab(ws, tabMenu.tabId, tabMenu.paneId, direction)),
										},
									];
								})),
						...(isToolTab
							? []
							: otherPanes.map(
									(pane, index): WorkspaceTabMenuItem => ({
										key: `move-${pane.id}`,
										label: t("Move to pane {{index}}", { index: index + 1 }),
										onSelect: () => mutateWorkspace((ws) => moveTab(ws, tabMenu.tabId, pane.id)),
									}),
								)),
						{
							key: "close",
							label: t("Close"),
							onSelect: () => closeTab(tabMenu.tabId),
						},
					];
					return (
						<WorkspaceTabMenu
							anchor={
								tabMenu.trigger
									? { kind: "element", element: tabMenu.trigger }
									: { kind: "point", x: tabMenu.x, y: tabMenu.y }
							}
							ariaLabel={t("Tab actions")}
							items={items}
							onClose={() => setTabMenu(null)}
							restoreFocusTo={tabMenu.focusTrigger ?? tabMenu.trigger}
						/>
					);
				})()}
			{pendingFileClose && (
				<div className="modal-backdrop">
					<div
						aria-describedby="unsaved-file-message"
						aria-label={t("Unsaved changes")}
						aria-modal="true"
						className="interaction-dialog unsaved-file-dialog"
						role="dialog"
					>
						<h2>{t("Save changes to {{name}}?", { name: pendingFileClose.name })}</h2>
						<p id="unsaved-file-message">{t("Your changes will be lost if you don’t save them.")}</p>
						<div className="interaction-actions">
							<button
								ref={pendingCloseCancelRef}
								className="button-secondary"
								onClick={() => setPendingFileClose(null)}
								type="button"
							>
								{t("Cancel")}
							</button>
							<button className="button-secondary" onClick={discardPendingFile} type="button">
								{t("Don’t Save")}
							</button>
							<button
								disabled={savingFileTabIds.has(pendingFileClose.tabId)}
								onClick={() => void saveAndClosePendingFile()}
								type="button"
							>
								{t(savingFileTabIds.has(pendingFileClose.tabId) ? "Saving…" : "Save")}
							</button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
	return (
		<CodeChangesNavigationContext.Provider value={openCodeChanges}>
			{workspaceContent}
		</CodeChangesNavigationContext.Provider>
	);
}
