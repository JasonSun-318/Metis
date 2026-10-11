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
import { createPortal } from "react-dom";
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
	collapsedTabIds,
	chatTab,
	defaultWorkspace,
	findChatTab,
	findTabLocation,
	focusedChatTab,
	canSplit,
	moveTab,
	moveTabGroup,
	normalizeTabGroups,
	relatedInsertIndex,
	removeTab,
	revealTab,
	removeTabs,
	type SessionWorkspace,
	setActivePane,
	type SplitDirection,
	splitTab,
	tabGroupRuns,
	toggleTabGroup,
	type WorkspacePane,
	type WorkspaceTab,
	workspaceTabs,
} from "../workspace-tabs.ts";
import { SESSION_INDICATOR_LABELS, sessionIndicator } from "../session-view-utils.ts";
import type { AppStore } from "../store/app-store.ts";
import {
	displayFileName,
	FILE_BROWSER_STORAGE_PREFIX,
	loadStoredFiles,
	pathIsWithin,
	remapPath,
	saveStoredFiles,
} from "../workspace-files.ts";
import { BrowserPanel } from "./BrowserPanel.tsx";
import { KnowledgePanel } from "./KnowledgePanel.tsx";
import { FilePanel, type WorkspaceFileDraft } from "./FilePanel.tsx";
import { UniversalFilePreviewer, type UniversalPreviewTarget } from "./preview/UniversalFilePreviewer.tsx";
import { previewBytesCache } from "./preview/preview-bytes-cache.ts";
import { PlanPreview } from "./PlanPreview.tsx";
import { ReviewPanel } from "./ReviewPanel.tsx";
import { AgentTreePanel } from "./AgentTreePanel.tsx";
import { ProcessPanel } from "./ProcessPanel.tsx";
import { SessionChatView, type SessionChatViewContext } from "./SessionChatView.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";
import { WorkspaceFileIcon } from "./WorkspaceFileIcon.tsx";

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

// A drag carries one tab, or a whole project group when it starts on the group's label.
type DragState =
	| { readonly tabId: string }
	| { readonly group: { readonly paneId: string; readonly key: string } };

type DropTarget =
	| { readonly paneId: string; readonly index: number }
	| { readonly split: { readonly paneId: string; readonly direction: SplitDirection } };

// The add menu belongs to one pane strip; the stored paneId is the target
// captured at open time so the menu keeps acting on it if focus moves while
// open. `align` flips the menu leftward when the trigger sits near the edge.
interface MenuTarget {
	readonly paneId: string;
	readonly align: "start" | "end";
}

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

type PlaceTab = (workspace: SessionWorkspace, tab: WorkspaceTab, paneId?: string, activate?: boolean) => SessionWorkspace;

const MIN_PANE_WIDTH = 360;
const MIN_PANE_HEIGHT = 280;

interface SessionWorkspaceViewProps {
	readonly api: MetisDesktopApi;
	readonly chat: ReactNode;
	readonly chatCwd: string | null;
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
		Pick<SessionSummary, "sessionId" | "cwd" | "mode">
			& Partial<Pick<SessionSummary, "state" | "unread" | "attentionRequired" | "lastTurnOutcome">>
	>;
	readonly sessionTitleFor: (sessionId: string) => string;
	readonly store: AppStore;
	readonly theme: "dark" | "light";
	readonly titlebarTabsSlot?: HTMLElement | null;
	readonly visible: boolean;
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
	place: PlaceTab,
): SessionWorkspace {
	const pane = activePane(workspace);
	const activeTab = pane.tabs.find((tab) => tab.id === pane.activeId);
	const shouldFocus = activeTab === undefined || activeTab.kind === "chat"
		|| pendingSessionId === chatSessionId;
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
					tabs: candidate.tabs.map((tab) => tab.id === draftTab.id ? { ...tab, sessionId: chatSessionId } : tab),
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
	visible,
}: SessionWorkspaceViewProps) {
	const { t } = useTranslation();
	const [workspace, setWorkspace] = useState<SessionWorkspace>(() => workspaceSeed(chatSessionId));
	const [expandedBySession, setExpandedBySession] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
	const [fileDrafts, setFileDrafts] = useState<ReadonlyMap<string, WorkspaceFileDraft>>(new Map());
	const [savingFileTabIds, setSavingFileTabIds] = useState<ReadonlySet<string>>(new Set());
	const [pendingFileClose, setPendingFileClose] = useState<PendingFileClose | null>(null);
	const [menuTarget, setMenuTarget] = useState<MenuTarget | null>(null);
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
	// Each strip's underline is one shared element slid under the active tab.
	// Grouped tabs sit inside group wrappers, so it is positioned by measuring
	// the tab's rect rather than a per-tab pseudo-element.
	const tabStripEls = useRef(new Map<string, HTMLDivElement>());
	const tabStripObserver = useRef<ResizeObserver | null>(null);
	const tabStripRefCallbacks = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
	const tabStripActiveTab = useRef(new WeakMap<HTMLElement, Element>());
	const syncTabIndicators = useCallback(() => {
		for (const scrollEl of tabStripEls.current.values()) {
			const indicator = scrollEl.querySelector<HTMLElement>(".tool-tab-indicator");
			if (!indicator) continue;
			const tabEl = scrollEl.querySelector<HTMLElement>(".tool-tab.is-active");
			if (!tabEl) {
				indicator.classList.remove("is-set");
				continue;
			}
			if (tabStripActiveTab.current.get(scrollEl) !== tabEl) {
				tabStripActiveTab.current.set(scrollEl, tabEl);
				// Keep the new pick visible now that overflowing strips scroll.
				tabEl.scrollIntoView?.({ block: "nearest", inline: "nearest" });
			}
			const tabRect = tabEl.getBoundingClientRect();
			indicator.style.width = `${Math.max(0, tabRect.width - 20)}px`;
			indicator.style.transform = `translateX(${tabRect.left - scrollEl.getBoundingClientRect().left + scrollEl.scrollLeft + 10}px)`;
			// Grouped strips tint the line with the tab's group accent color.
			indicator.style.setProperty("--tab-group-color", getComputedStyle(tabEl).getPropertyValue("--tab-group-color"));
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
			};
			tabStripRefCallbacks.current.set(paneId, callback);
		}
		return callback;
	};
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
	const liveKey = useMemo(
		() => [...new Set(workspace.panes.flatMap((pane) => {
			const tab = pane.tabs.find((candidate) => candidate.id === pane.activeId);
			return (tab?.kind === "chat" || tab?.kind === "agent") && tab.sessionId !== null ? [tab.sessionId] : [];
		}))].sort().join("\n"),
		[workspace],
	);
	// Sessions with a pane-active chat tab host their own modal interactions;
	// the App-level host covers sessions without a visible chat pane.
	const chatLiveKey = useMemo(
		() => [...new Set(workspace.panes.flatMap((pane) => {
			const tab = pane.tabs.find((candidate) => candidate.id === pane.activeId);
			return tab?.kind === "chat" && tab.sessionId !== null ? [tab.sessionId] : [];
		}))].sort().join("\n"),
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
		[groupOf],
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
	const openGroupKeys = new Set(workspaceTabs(workspace).flatMap((tab) => {
		const project = tab.sessionId === null ? null : projectFor(tab.sessionId);
		return project ? [project.key] : [];
	}));
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
			const next = normalizeTabGroups(update(workspaceRef.current), groupOf);
			if (next === workspaceRef.current) return;
			workspaceRef.current = next;
			setWorkspace(next);
			const focused = focusedChatTab(next);
			if (focused && focused.sessionId !== chatSessionIdRef.current && pendingChatFocus.current !== focused.sessionId) {
				pendingChatFocus.current = focused.sessionId;
				onChatSessionRef.current(focused.sessionId);
			}
		},
		[groupOf],
	);


	// Collapsing a group animates its tab body shut like a drawer before the
	// model commits; expanding commits first and the fresh body animates open.
	// Reduced motion (or DOMs without Web Animations) toggles instantly.
	const groupAnims = useRef(new Map<string, { anim: Animation; closing: boolean }>());
	const expandingGroups = useRef(new Set<string>());
	const groupBodyRefCallbacks = useRef(new Map<string, (el: HTMLDivElement | null) => void>());
	// While a drawer closes the label already looks collapsed, so the count and
	// chip shape arrive with the animation instead of popping in at the commit.
	const [closingGroups, setClosingGroups] = useState<ReadonlySet<string>>(new Set());
	const groupsCanAnimate = () =>
		typeof HTMLElement.prototype.animate === "function" &&
		!(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)") ?? { matches: false }).matches;
	const setGroupClosing = (id: string, closing: boolean) => {
		setClosingGroups((current) => {
			const next = new Set(current);
			if (closing) next.add(id); else next.delete(id);
			return next;
		});
	};

	const collapseGroupBody = (body: HTMLElement, id: string, paneId: string, key: string) => {
		const anim = body.animate(
			[{ maxWidth: `${body.getBoundingClientRect().width}px`, opacity: 1 }, { maxWidth: "0px", opacity: 0 }],
			{ duration: 220, easing: "cubic-bezier(.16,1,.3,1)", fill: "forwards" },
		);
		groupAnims.current.set(id, { anim, closing: true });
		setGroupClosing(id, true);
		anim.finished.then(() => {
			if (groupAnims.current.get(id)?.anim === anim) {
				groupAnims.current.delete(id);
				mutateWorkspace((current) => toggleTabGroup(current, paneId, key, groupOf));
				setGroupClosing(id, false);
			}
		}, () => {});
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
			if (groupsCanAnimate()) expandingGroups.current.add(id);
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
					[{ maxWidth: "0px", opacity: 0 }, { maxWidth: `${el.scrollWidth}px`, opacity: 1 }],
					{ duration: 220, easing: "cubic-bezier(.16,1,.3,1)" },
				);
				groupAnims.current.set(id, { anim, closing: false });
				anim.finished.then(() => {
					if (groupAnims.current.get(id)?.anim === anim) groupAnims.current.delete(id);
				}, () => {});
			};
			groupBodyRefCallbacks.current.set(id, callback);
		}
		return callback;
	};

	// A tab's project can resolve after the tab opens (the session list loads
	// later); regroup whenever the project behind any tab changes.
	const groupSignature = workspace.panes
		.map((pane) => pane.tabs.map((tab) => groupOf(tab) ?? "").join("\n"))
		.join("\0");
	useEffect(() => {
		updateWorkspace((current) => current);
	}, [groupSignature, updateWorkspace]);

	// Keep one chat tab per session in sync with the projected session. Tabs
	// adopt the draft's real sessionId when it materializes so the chat subtree
	// (and the composer's editable DOM) survives the draft -> session transition.
	useEffect(() => {
		updateWorkspace((current) => syncChatTabs(current, chatSessionId, chatIsDraft, pendingChatFocus.current, placeTab));
	}, [chatIsDraft, chatSessionId, placeTab, updateWorkspace]);

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
				? placeTab(current, chatTab(chatFocusRequest.sessionId))
				: current;
		});
	}, [chatFocusRequest, chatSessionId, placeTab, updateWorkspace]);

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
				const chat = findChatTab(next, sessionId);
				return chat ? revealTab(next, chat.id) : next;
			}, current),
		);
	}, [inlineInteractions, updateWorkspace]);

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
				: placeTab(current, tab);
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
						return placeTab(workspace, {
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
		[api, onActivateSession, placeTab, t, updateWorkspace],
	);

	useEffect(() => {
		setMenuTarget(null);
		setTabMenu(null);
	}, [mode, chatSessionId]);
	useEffect(() => onDirtySessionIdsChange(dirtySessionIds), [dirtySessionKey, onDirtySessionIdsChange]);
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
			return placeTab(workspace, tab);
		});
	}, [placeTab, previewRequest, updateWorkspace]);

	useEffect(() => {
		if (!planPreviewRequest) return;
		const { sessionId, plan } = planPreviewRequest;
		updateWorkspace((workspace) => {
			const existing = workspaceTabs(workspace).find(
				(tab): tab is Extract<WorkspaceTab, { kind: "plan" }> =>
					tab.kind === "plan" && tab.sessionId === sessionId && tab.plan.planId === plan.planId,
			);
			if (existing) {
				return activateTab({
					...workspace,
					panes: workspace.panes.map((pane) => ({
						...pane,
						tabs: pane.tabs.map((tab) =>
							tab.kind === "plan" && tab.sessionId === sessionId && tab.plan.planId === plan.planId
								? { ...tab, title: plan.title, plan }
								: tab,
						),
					})),
				}, existing.id);
			}
			return placeTab(workspace, {
				kind: "plan",
				id: plan.planId,
				sessionId,
				title: plan.title,
				plan,
			});
		});
	}, [placeTab, planPreviewRequest, updateWorkspace]);

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
			return { ...placeTab(workspace, tab, paneId), nextNumber: number + 1 };
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
		updateWorkspace((workspace) => placeTab(workspace, tab, paneId));
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
			const withAll = files.reduce((acc, tab) => placeTab(acc, tab, paneId), workspace);
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
			return placeTab(workspace, tab, paneId);
		});
		setMenuTarget(null);
	};

	const addAgent = (paneId: string) => {
		const { sessionId: ownerSessionId } = paneTarget(paneId);
		if (!ownerSessionId || mode !== "code") return;
		updateWorkspace((workspace) => {
			const existing = workspaceTabs(workspace).find((tab) => tab.kind === "agent" && tab.sessionId === ownerSessionId);
			const tab: WorkspaceTab = existing ?? { kind: "agent", id: crypto.randomUUID(), sessionId: ownerSessionId, title: t("Agents") };
			return existing ? activateTab(workspace, existing.id) : placeTab(workspace, tab, paneId);
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
				: placeTab(workspace, tab, paneId ?? workspace.activePaneId);
		});
		setMenuTarget(null);
	}, [placeTab, t, updateWorkspace]);
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
					next = placeTab(workspace, nextTab, paneId);
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

	// Working inside a pane (typing, scrolling a terminal) focuses it, so shortcuts
	// and the projected session follow the pane the user is actually using.
	const focusPane = (paneId: string) => {
		mutateWorkspace((workspace) => setActivePane(workspace, paneId));
	};

	const removeTabInternal = (id: string) => {
		const closing = workspaceTabs(workspace).find((tab) => tab.id === id);
		if (!closing) return;
		if (closing.kind === "terminal") void api.closeTerminal({ terminalId: id }).catch(onError);
		else if (closing.kind === "browser") void api.closeBrowser({ sessionId: closing.sessionId, browserId: id }).catch(onError);
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

	closeTabRef.current = closeTab;

	useEffect(() => {
		if (closeTabRequest === undefined || closeTabRequest === handledCloseTabRequest.current) return;
		handledCloseTabRequest.current = closeTabRequest;
		if (!visible) return;
		const pane = activePane(workspaceRef.current);
		if (pane.activeId) closeTabRef.current(pane.activeId);
	}, [closeTabRequest, visible]);

	// Ctrl+Tab / Ctrl+Shift+Tab cycle the focused pane's visible tabs; tabs
	// folded into a collapsed group are skipped, as in a browser.
	useEffect(() => {
		if (!visible) return;
		const cycle = (event: KeyboardEvent) => {
			if (event.key !== "Tab" || !event.ctrlKey || event.metaKey || event.altKey) return;
			const pane = activePane(workspaceRef.current);
			const hidden = collapsedTabIds(pane, groupOf);
			const tabs = pane.tabs.filter((tab) => !hidden.has(tab.id));
			if (tabs.length < 2) return;
			event.preventDefault();
			const index = tabs.findIndex((tab) => tab.id === pane.activeId);
			const next = tabs[(index + (event.shiftKey ? -1 : 1) + tabs.length) % tabs.length]!;
			mutateWorkspace((current) => activateTab(current, next.id));
		};
		// Capture phase: terminals and editors stop keydown propagation inside their panes.
		document.addEventListener("keydown", cycle, true);
		return () => document.removeEventListener("keydown", cycle, true);
	}, [groupOf, mutateWorkspace, visible]);

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
		mutateWorkspace((workspace) => "group" in drag
			? moveTabGroup(workspace, drag.group.paneId, drag.group.key, groupOf, paneId, index)
			: moveTab(workspace, drag.tabId, paneId, index));
	};

	const handleDropSplit = (paneId: string, direction: SplitDirection) => {
		const drag = dragState;
		setDragState(null);
		setDropTarget(null);
		if (!drag || "group" in drag) return;
		mutateWorkspace((workspace) => splitTab(workspace, drag.tabId, paneId, direction));
	};

	const rowCount = (row: 0 | 1) => workspace.panes.filter((pane) => pane.row === row).length;

	const fitsSplit = (paneId: string, direction: SplitDirection): boolean => {
		const root = panesRef.current;
		const target = workspace.panes.find((pane) => pane.id === paneId);
		if (!root || !target) return false;
		const rect = root.getBoundingClientRect();
		if (direction === "left" || direction === "right") {
			return rect.width / (rowCount(target.row) + 1) >= MIN_PANE_WIDTH;
		}
		const otherRow = direction === "down" ? 1 : 0;
		const otherRowCount = rowCount(otherRow);
		return otherRowCount === 0
			? rect.height / 2 >= MIN_PANE_HEIGHT
			: rect.width / (otherRowCount + 1) >= MIN_PANE_WIDTH;
	};

	const splitDropDirection = (event: DragEvent<HTMLElement>, paneId: string): SplitDirection | null => {
		// A dragged group lands in a strip; only single tabs open a new split.
		if (dragState && "group" in dragState) return null;
		const rect = event.currentTarget.getBoundingClientRect();
		const horizontal = Math.min(120, rect.width * 0.25);
		const vertical = Math.min(120, rect.height * 0.25);
		const nearest = ([
			{ direction: "left" as const, distance: event.clientX - rect.left, edge: horizontal },
			{ direction: "right" as const, distance: rect.right - event.clientX, edge: horizontal },
			{ direction: "up" as const, distance: event.clientY - rect.top, edge: vertical },
			{ direction: "down" as const, distance: rect.bottom - event.clientY, edge: vertical },
		])
			.filter((candidate) => candidate.distance >= 0 && candidate.distance <= candidate.edge)
			.sort((a, b) => a.distance - b.distance)[0];
		return nearest && canSplit(workspace, paneId, nearest.direction) && fitsSplit(paneId, nearest.direction)
			? nearest.direction
			: null;
	};

	// Drop slots are the visible tabs and group labels; each carries its index
	// in the pane's tabs, since a collapsed group's tabs are not on screen.
	const stripDropIndex = (event: DragEvent<HTMLElement>, pane: WorkspacePane): number => {
		const slots = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-drop-index]")];
		for (const slot of slots) {
			const rect = slot.getBoundingClientRect();
			if (event.clientX < rect.left + rect.width / 2) return Number(slot.dataset.dropIndex);
		}
		return pane.tabs.length;
	};

	const toolMenu = (paneId: string, align: MenuTarget["align"]) => {
		const target = paneTarget(paneId);
		const targetMode = target.sessionId === null ? mode : (sessionsById.get(target.sessionId)?.mode ?? mode);
		const sessionTarget = target.sessionId === null || target.cwd === null
			? null
			: { mode: sessionsById.get(target.sessionId)?.mode ?? mode, cwd: target.cwd };
		return (
		<nav
			aria-label={t("Available tools")}
			className={`tool-add-menu${align === "end" ? " is-align-end" : ""}`}
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

	const openToolMenu = (paneId: string, trigger: HTMLElement) => {
		const rect = trigger.getBoundingClientRect();
		setTabMenu(null);
		setMenuTarget((current) => current?.paneId === paneId
			? null
			: { paneId, align: rect.left + 216 > window.innerWidth ? "end" : "start" });
	};

	const tabIcon = (tab: WorkspaceTab): ReactNode =>
		tab.kind === "chat" ? <ChatCircle aria-hidden="true" size={13} />
			: tab.kind === "knowledge" ? <Books aria-hidden="true" size={13} />
			: tab.kind === "terminal" || tab.kind === "process" ? <TerminalWindow aria-hidden="true" size={13} />
			: tab.kind === "browser" ? <Globe aria-hidden="true" size={13} />
			: tab.kind === "file" ? (tab.relativePath ? <WorkspaceFileIcon path={tab.relativePath} size={13} /> : <FileText aria-hidden="true" size={13} />)
			: tab.kind === "review" ? <ClipboardText aria-hidden="true" size={13} />
			: tab.kind === "agent" ? <Robot aria-hidden="true" size={13} />
			: tab.kind === "plan" ? <FileText aria-hidden="true" size={13} />
			: <WorkspaceFileIcon path={tab.title} size={13} />;

	const renderTab = (pane: WorkspacePane, tab: WorkspaceTab, project: WorkspaceProject | null) => {
		const displayTitle = tab.kind === "chat"
			? (tab.sessionId === null ? t("New task") : sessionTitleFor(tab.sessionId))
			: tab.kind === "browser" && tab.url === ""
				? t("New tab")
				: tab.kind === "file" && tab.relativePath === null ? t("Open file") : tab.title;
		const draft = tab.kind === "file" ? fileDrafts.get(tab.id) : undefined;
		const dirty = draft !== undefined && draft.text !== draft.savedText;
		const saving = savingFileTabIds.has(tab.id);
		const active = pane.activeId === tab.id;
		// Chat tabs carry their session's live status so background panes stay readable at a glance.
		const session = tab.kind === "chat" && tab.sessionId !== null ? sessionsById.get(tab.sessionId) : undefined;
		const indicator = session
			? sessionIndicator(session, visible && active && tab.sessionId === chatSessionId)
			: undefined;
		const indicatorLabel = indicator ? SESSION_INDICATOR_LABELS[indicator] : undefined;
		// The status goes in the description, like the sidebar, so a tab keeps a stable name.
		const label = dirty ? `${displayTitle}, ${t("Unsaved")}` : displayTitle;
		return (
			<div
				className={`tool-tab${active ? " is-active" : ""}${tab.kind === "file" && !tab.fixed ? " is-preview" : ""}${dirty ? " is-dirty" : ""}`}
				data-drop-index={pane.tabs.indexOf(tab)}
				draggable
				key={tab.id}
				onAuxClick={(event) => {
					// Middle-click closes, matching browsers and editors.
					if (event.button !== 1) return;
					event.preventDefault();
					closeTab(tab.id);
				}}
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
					aria-description={indicatorLabel ? t(indicatorLabel) : undefined}
					aria-selected={active}
					aria-label={label}
					className="tool-tab-select"
					onClick={() => selectTab(tab.id)}
					role="tab"
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
		const menuOpen = menuTarget?.paneId === pane.id;
		return (
			<div
				className={`workspace-tabbar${inTitlebar ? " workspace-tabbar--titlebar" : ""}${focused ? " is-focused" : ""}${split && !focused ? " is-unfocused" : ""}${dropTarget && "paneId" in dropTarget && dropTarget.paneId === pane.id ? " is-drop-target" : ""}`}
				data-pane-id={pane.id}
				onDragLeave={() => setDropTarget((current) => current && "paneId" in current && current.paneId === pane.id ? null : current)}
				onDragOver={(event) => {
					if (!dragState) return;
					event.preventDefault();
					event.stopPropagation();
					event.dataTransfer.dropEffect = "move";
					setDropTarget({ paneId: pane.id, index: stripDropIndex(event, pane) });
				}}
				onDrop={(event) => {
					event.preventDefault();
					event.stopPropagation();
					handleDropOnStrip(pane.id, stripDropIndex(event, pane));
				}}
				role="tablist"
			>
				<div className="tool-tabs-scroll" ref={tabStripRef(pane.id)}>
					{grouped ? runs.map((run, index) => {
						const first = run.tabs[0]!;
						if (!run.group) {
							const tabs = run.tabs.map((tab) => renderTab(pane, tab, null));
							return index === 0 ? tabs : [<span aria-hidden="true" className="tool-tab-group-gap" key={`gap-${first.id}`} />, ...tabs];
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
									aria-description={shownCollapsed
										? t("{{count}} tabs hidden", { count: run.tabs.length })
										: undefined}
									aria-expanded={!shownCollapsed}
									aria-label={groupLabel}
									className="tool-tab-group-label"
									data-drop-index={pane.tabs.indexOf(first)}
									draggable
onClick={(event) => toggleGroupAnimated(event.currentTarget, pane.id, group.key, collapsed)}
									onDragEnd={() => { setDragState(null); setDropTarget(null); }}
									onDragStart={(event) => {
										event.dataTransfer.setData("text/plain", group.key);
										event.dataTransfer.effectAllowed = "move";
										setDragState({ group: { paneId: pane.id, key: group.key } });
									}}
									title={group.cwd}
									type="button"
								>
									<span className="tool-tab-group-name">{group.name}</span>
{shownCollapsed && <span aria-hidden="true" className="tool-tab-group-count">{run.tabs.length}</span>}
								</button>
								{!collapsed && (
									<div className="tool-tab-group-body" ref={groupBodyRef(pane.id, group.key)}>
										{run.tabs.map((tab) => renderTab(pane, tab, group))}
									</div>
								)}
							</div>
						);
					}) : pane.tabs.map((tab) => renderTab(pane, tab, tab.sessionId === null ? null : projectFor(tab.sessionId)))}
					<span aria-hidden="true" className="tool-tab-indicator" />
				</div>
				<div className="tool-add" ref={menuOpen ? menuRef : undefined}>
					<button
						aria-expanded={menuOpen}
						aria-haspopup="menu"
						aria-label={t("Add tool")}
						className="tool-add-trigger"
						onClick={(event) => openToolMenu(pane.id, event.currentTarget)}
						type="button"
					>
						<Plus aria-hidden="true" size={13} />
					</button>
					{menuOpen && toolMenu(pane.id, menuTarget.align)}
				</div>
				<div aria-hidden="true" className="workspace-tabbar-fill" />
			</div>
		);
	};

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
				<div className="workspace-panel" data-pane-id={pane.id} hidden={!panelVisible(tabId)} key={tabId} onPointerDownCapture={() => focusPane(pane.id)}>
					{content}
				</div>
			);
			const chatViewFor = (tab: WorkspaceTab, isHost: boolean): ReactNode => {
				// The host pane keeps showing the draft/loading node while it is
				// provided; once App hands down null, the pane's own live view takes
				// over — including the projected session the host tab belongs to.
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
						onPointerDownCapture={() => focusPane(pane.id)}
					>
						<div className="workspace-chat-panel">{chatViewFor(host.tab, true)}</div>
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
					) : tab.kind === "chat" ? (
						// Every chat tab keeps its own view mounted so composer drafts
						// and transcript scroll survive tab switches; the host tab
						// renders through the host panel above.
						tab === host?.tab || tab.sessionId === null
							? []
							: wrap(tab.id, <div className="workspace-chat-panel">{chatViewFor(tab, false)}</div>)
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
						<AgentTreePanel
							api={api}
							onError={onError}
							sessionId={tab.sessionId}
							store={store}
							visible={panelVisible(tab.id)}
						/>,
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
							onPointerDownCapture={() => focusPane(pane.id)}
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

	const splitTarget = dropTarget && "split" in dropTarget ? dropTarget.split : null;

	// The top row's strips ride inside the window titlebar, one cell per pane,
	// so the chrome stays a single row whether or not the workspace is split;
	// cells share the panes' flex sizing and borders, so they line up with the
	// columns below. A second row keeps its strips inside its panes. Without a
	// titlebar slot (standalone rendering/tests) every strip stays in its pane.
	const stripsInTitlebar = titlebarTabsSlot != null;
	const topPanes = workspace.panes.filter((pane) => pane.row === 0);

	return (
		<div className="session-workspace-root" hidden={!visible}>
			{visible && stripsInTitlebar
				? createPortal(
					<div className="workspace-titlebar-strips">
						{topPanes.map((pane) => (
							<div className="workspace-titlebar-cell" key={pane.id}>{renderTabStrip(pane, true)}</div>
						))}
					</div>,
					titlebarTabsSlot!,
				)
				: null}
			<div className="session-workspace-instance">
				<div className={`session-workspace-panes${dragState ? " is-dragging" : ""}`} ref={panesRef}>
					{([0, 1] as const).map((row) => {
						const rowPanes = workspace.panes.filter((pane) => pane.row === row);
						if (rowPanes.length === 0) return null;
						return (
							<div className="workspace-row" key={row}>
								{rowPanes.map((pane) => (
									<section
										className={`workspace-pane${splitTarget?.paneId === pane.id ? " is-split-target" : ""}`}
										data-split-direction={splitTarget?.paneId === pane.id ? splitTarget.direction : undefined}
										key={pane.id}
										onDragLeave={(event) => {
											if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
											setDropTarget((current) => current && "split" in current && current.split.paneId === pane.id ? null : current);
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
												<div className="workspace-empty" role="tabpanel">
													<p>{t("Pick a session from the sidebar or use + to open a tool.")}</p>
													{onNewSession && (
														<button className="button-secondary" onClick={() => onNewSession(null)} type="button">
															<Plus aria-hidden="true" size={13} />
															{t("Start a new task")}
														</button>
													)}
												</div>
											)}
										</div>
									</section>
								))}
							</div>
						);
					})}
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
						{(["right", "down"] as const).map((direction) => {
							const reason = !canSplit(workspace, tabMenu.paneId, direction)
								? t("Up to 6 panes")
								: !fitsSplit(tabMenu.paneId, direction)
									? t("Not enough room to split")
									: undefined;
							return (
								<button
									disabled={reason !== undefined}
									key={direction}
									onClick={() => { mutateWorkspace((ws) => splitTab(ws, tabMenu.tabId, tabMenu.paneId, direction)); setTabMenu(null); }}
									role="menuitem"
									title={reason}
									type="button"
								>
									<span>{direction === "right" ? t("Split right") : t("Split down")}</span>
								</button>
							);
						})}
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
