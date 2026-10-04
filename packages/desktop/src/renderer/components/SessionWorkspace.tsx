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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
	CHAT_TAB_ID,
	defaultWorkspace,
	findTabLocation,
	moveTab,
	paneForTab,
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

interface WorkspaceEntry {
	readonly slotId: string;
	readonly workspace: SessionWorkspace;
}

interface TabMenuState {
	readonly sessionId: string;
	readonly paneId: string;
	readonly tabId: string;
	readonly x: number;
	readonly y: number;
}

interface DragState {
	readonly sessionId: string;
	readonly tabId: string;
}

type DropTarget =
	| { readonly sessionId: string; readonly paneId: string; readonly index: number }
	| { readonly sessionId: string; readonly splitBeside: string };

interface SessionWorkspaceViewProps {
	readonly activeSession: Pick<SessionSummary, "sessionId" | "cwd"> | null;
	readonly api: MetisDesktopApi;
	readonly chat: ReactNode;
	readonly chatTitle: string;
	readonly cleanupSessionIds: readonly string[];
	readonly mode: AgentMode;
	readonly onActivateSession: (sessionId: string) => void;
	readonly onCleanupSessionIdsHandled: (sessionIds: readonly string[]) => void;
	readonly onDirtySessionIdsChange: (sessionIds: readonly string[]) => void;
	readonly onError: (cause: unknown) => void;
	readonly onNewSession?: () => void;
	readonly planPreviewRequest?: PlanView | null;
	readonly previewRequest?: UniversalPreviewTarget | null;
	readonly knowledgeRequest?: { readonly id: number; readonly sessionId: string };
	readonly process?: SessionProcessView;
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
		fixedPaths: tabs.flatMap((tab) => tab.kind === "file" && tab.fixed && tab.relativePath ? [tab.relativePath] : []).slice(0, 64),
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

function isEmptyWorkspace(workspace: SessionWorkspace): boolean {
	return workspace.panes.length === 1
		&& workspace.panes[0]!.tabs.length === 1
		&& workspace.panes[0]!.tabs[0]!.kind === "chat";
}

export function SessionWorkspaceView({
	activeSession,
	api,
	chat,
	chatTitle,
	cleanupSessionIds,
	mode,
	onActivateSession,
	onCleanupSessionIdsHandled,
	onDirtySessionIdsChange,
	onError,
	onNewSession,
	planPreviewRequest,
	previewRequest,
	knowledgeRequest,
	process,
	store,
	theme,
	visible,
}: SessionWorkspaceViewProps) {
	const { t } = useTranslation();
	const [workspaces, setWorkspaces] = useState<ReadonlyMap<string, WorkspaceEntry>>(new Map());
	const [expandedBySession, setExpandedBySession] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
	const [fileDrafts, setFileDrafts] = useState<ReadonlyMap<string, WorkspaceFileDraft>>(new Map());
	const [savingFileTabIds, setSavingFileTabIds] = useState<ReadonlySet<string>>(new Set());
	const [pendingFileClose, setPendingFileClose] = useState<PendingFileClose | null>(null);
	const [menuTarget, setMenuTarget] = useState<{ readonly sessionId: string; readonly paneId: string } | null>(null);
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
	const sessionId = activeSession?.sessionId ?? null;
	const displayedSessionId = sessionId ?? "__home__";
	const displayedSessionIdRef = useRef(displayedSessionId);
	displayedSessionIdRef.current = displayedSessionId;
	// A draft session's workspace keeps its slot when the draft materializes into
	// a real session, so the chat subtree is never remounted mid-send.
	if (sessionId !== null && workspaces.has("__home__") && !workspaces.has(sessionId)) {
		setWorkspaces((current) => {
			const home = current.get("__home__");
			if (!home || current.has(sessionId)) return current;
			const next = new Map(current);
			next.delete("__home__");
			next.set(sessionId, home);
			return next;
		});
	}
	if (!workspaces.has(displayedSessionId)) {
		setWorkspaces((current) => current.has(displayedSessionId)
			? current
			: new Map(current).set(displayedSessionId, { slotId: crypto.randomUUID(), workspace: defaultWorkspace() }));
	}
	const workspace = workspaces.get(displayedSessionId)?.workspace ?? defaultWorkspace();
	const dirtySessionIds = useMemo(
		() => [...workspaces]
			.filter(([, owner]) => workspaceTabs(owner.workspace).some((tab) => {
				const draft = tab.kind === "file" ? fileDrafts.get(tab.id) : undefined;
				return draft !== undefined && draft.text !== draft.savedText;
			}))
			.map(([ownerSessionId]) => ownerSessionId)
			.sort(),
		[fileDrafts, workspaces],
	);
	const dirtySessionKey = dirtySessionIds.join("");

	const seenProcesses = useRef(new Map<string, string>());
	const autoOpenedProcessSessions = useRef(new Set<string>());

	const updateWorkspace = useCallback(
		(ownerSessionId: string, update: (workspace: SessionWorkspace) => SessionWorkspace) => {
			setWorkspaces((current) => {
				const previous = current.get(ownerSessionId)?.workspace ?? defaultWorkspace();
				const next = update(previous);
				if (next === previous) return current;
				const map = new Map(current);
				if (isEmptyWorkspace(next) && ownerSessionId !== displayedSessionIdRef.current) map.delete(ownerSessionId);
				else map.set(ownerSessionId, {
					slotId: current.get(ownerSessionId)?.slotId ?? crypto.randomUUID(),
					workspace: next,
				});
				return map;
			});
		},
		[],
	);

	const openProcess = useCallback(() => {
		if (!sessionId || !process) return;
		const id = `process-${sessionId}`;
		const tab: WorkspaceTab = { kind: "process", id, title: "Process", process };
		updateWorkspace(sessionId, (current) => {
			const existing = findTabLocation(current, id);
			const replaced = existing
				? { ...current, panes: current.panes.map((pane, index) => index === existing.paneIndex
						? { ...pane, tabs: pane.tabs.map((item, tabIndex) => tabIndex === existing.tabIndex ? tab : item) }
						: pane) }
				: addTab(current, tab);
			return activateTab(replaced, id);
		});
	}, [process, sessionId, updateWorkspace]);

	useEffect(() => {
		if (!sessionId) return;
		if (!process) {
			seenProcesses.current.delete(sessionId);
			return;
		}
		const previousId = seenProcesses.current.get(sessionId);
		seenProcesses.current.set(sessionId, process.processId);
		if (previousId !== process.processId) {
			autoOpenedProcessSessions.current.add(sessionId);
			openProcess();
			return;
		}
		updateWorkspace(sessionId, (current) => {
			const location = findTabLocation(current, `process-${sessionId}`);
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
	}, [openProcess, process, sessionId, updateWorkspace]);

	useEffect(() => {
		if (!sessionId || !process || process.state === "running") return;
		if (!autoOpenedProcessSessions.current.has(sessionId)) return;
		autoOpenedProcessSessions.current.delete(sessionId);
		updateWorkspace(sessionId, (current) => activateTab(current, CHAT_TAB_ID));
	}, [process, sessionId, updateWorkspace]);

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
					updateWorkspace(event.sessionId, (workspace) => {
						if (workspaceTabs(workspace).some(({ id }) => id === event.browserId)) return workspace;
						return addTab(workspace, {
							kind: "browser",
							id: event.browserId,
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
					updateWorkspace(event.sessionId, (workspace) =>
						workspaceTabs(workspace).some(({ id }) => id === event.browserId)
							? removeTab(workspace, event.browserId)
							: workspace,
					);
					return;
				}
				if (event.type !== "activity" && event.type !== "handoff") return;
				updateWorkspace(event.sessionId, (workspace) => {
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
	}, [mode, sessionId]);
	useEffect(() => onDirtySessionIdsChange(dirtySessionIds), [dirtySessionKey, onDirtySessionIdsChange]);
	useEffect(() => {
		if (cleanupSessionIds.length === 0) return;
		const removedTabIds = new Set<string>();
		for (const ownerSessionId of cleanupSessionIds) {
			previewBytesCache.deleteSession(ownerSessionId);
			const owner = workspaces.get(ownerSessionId)?.workspace;
			for (const tab of owner ? workspaceTabs(owner) : []) {
				removedTabIds.add(tab.id);
				if (tab.kind === "terminal") void api.closeTerminal({ terminalId: tab.id }).catch(onError);
				else if (tab.kind === "browser") void api.closeBrowser({ sessionId: ownerSessionId, browserId: tab.id }).catch(onError);
			}
			try {
				localStorage.removeItem(`${FILE_BROWSER_STORAGE_PREFIX}${ownerSessionId}`);
			} catch (cause) {
				onError(cause);
			}
		}
		const removedSessions = new Set(cleanupSessionIds);
		setWorkspaces((current) => new Map([...current].filter(([id]) => !removedSessions.has(id))));
		setExpandedBySession((current) => new Map([...current].filter(([id]) => !removedSessions.has(id))));
		setFileDrafts((current) => new Map([...current].filter(([id]) => !removedTabIds.has(id))));
		setSavingFileTabIds((current) => new Set([...current].filter((id) => !removedTabIds.has(id))));
		setPendingFileClose((current) => current && removedSessions.has(current.sessionId) ? null : current);
		onCleanupSessionIdsHandled(cleanupSessionIds);
	}, [api, cleanupSessionIds, onCleanupSessionIdsHandled, onError, workspaces]);

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
		if (!previewRequest || !sessionId) return;
		updateWorkspace(sessionId, (workspace) => {
			const existing = workspaceTabs(workspace).find(
				(tab): tab is Extract<WorkspaceTab, { kind: "preview" }> =>
					tab.kind === "preview" &&
					tab.file.source === previewRequest.source &&
					(previewRequest.fileId ? tab.file.fileId === previewRequest.fileId : tab.file.relativePath === previewRequest.relativePath),
			);
			if (existing) return activateTab(workspace, existing.id);
			const tab: WorkspaceTab = {
				kind: "preview",
				id: crypto.randomUUID(),
				title: previewRequest.name,
				file: previewRequest,
			};
			return addTab(workspace, tab);
		});
	}, [previewRequest, sessionId, updateWorkspace]);

	useEffect(() => {
		if (!planPreviewRequest || !sessionId) return;
		updateWorkspace(sessionId, (workspace) => {
			const existing = workspaceTabs(workspace).find(
				(tab): tab is Extract<WorkspaceTab, { kind: "plan" }> => tab.kind === "plan" && tab.plan.planId === planPreviewRequest.planId,
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
				title: planPreviewRequest.title,
				plan: planPreviewRequest,
			});
		});
	}, [planPreviewRequest, sessionId, updateWorkspace]);

	const addTerminal = (paneId: string) => {
		if (!activeSession?.cwd) return;
		const cwd = activeSession.cwd;
		const ownerSessionId = activeSession.sessionId;
		const id = crypto.randomUUID();
		updateWorkspace(ownerSessionId, (workspace) => {
			const number = workspace.nextNumber;
			const tab: WorkspaceTab = {
				kind: "terminal",
				id,
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
		if (!activeSession || !profile) return;
		const ownerSessionId = activeSession.sessionId;
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
			title: t("New tab"),
			url: "",
			profileId: profile.profileId,
			profileName: profile.name,
			controlState: "idle",
		};
		updateWorkspace(ownerSessionId, (workspace) => addTab(workspace, tab, paneId));
		setMenuTarget(null);
	};

	const browserProfileImported = (profile: DesktopBrowserProfile) => {
		setBrowserProfiles((current) => current.some((candidate) => candidate.profileId === profile.profileId)
			? current.map((candidate) => candidate.profileId === profile.profileId ? profile : candidate)
			: [...current, profile]);
		if (workspace) addBrowser(activePane(workspace).id, profile);
	};

	const addFiles = (paneId: string) => {
		if (!activeSession?.cwd || mode !== "code") return;
		const ownerSessionId = activeSession.sessionId;
		const cwd = activeSession.cwd;
		const stored = loadStoredFiles(ownerSessionId, cwd);
		setExpandedBySession((values) => {
			if (values.has(ownerSessionId)) return values;
			const next = new Map(values);
			next.set(ownerSessionId, stored.expandedPaths);
			return next;
		});
		updateWorkspace(ownerSessionId, (workspace) => {
			const existing = [...workspaceTabs(workspace)].reverse().find((tab) => tab.kind === "file");
			if (existing) return activateTab(workspace, existing.id);
			const restored: WorkspaceTab[] = stored.fixedPaths.map((relativePath) => ({
				kind: "file" as const,
				id: crypto.randomUUID(),
				title: displayFileName(relativePath),
				cwd,
				relativePath,
				fixed: true,
			}));
			const files = restored.length > 0 ? restored : [{
				kind: "file" as const,
				id: crypto.randomUUID(),
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
		if (!activeSession?.cwd || mode !== "code") return;
		const ownerSessionId = activeSession.sessionId;
		updateWorkspace(ownerSessionId, (workspace) => {
			const existing = workspaceTabs(workspace).find((tab) => tab.kind === "review");
			if (existing) return activateTab(workspace, existing.id);
			const tab: WorkspaceTab = { kind: "review", id: crypto.randomUUID(), title: t("Review") };
			return addTab(workspace, tab, paneId);
		});
		setMenuTarget(null);
	};

	const addAgent = (paneId: string) => {
		if (!activeSession || mode !== "code") return;
		const ownerSessionId = activeSession.sessionId;
		updateWorkspace(ownerSessionId, (workspace) => {
			const existing = workspaceTabs(workspace).find((tab) => tab.kind === "agent");
			const tab: WorkspaceTab = existing ?? { kind: "agent", id: crypto.randomUUID(), title: t("Agents") };
			return existing ? activateTab(workspace, existing.id) : addTab(workspace, tab, paneId);
		});
		setMenuTarget(null);
	};

	const addKnowledge = useCallback((paneId?: string) => {
		if (!sessionId) return;
		updateWorkspace(sessionId, (workspace) => {
			const existing = workspaceTabs(workspace).find((tab) => tab.kind === "knowledge");
			const tab: WorkspaceTab = existing ?? { kind: "knowledge", id: crypto.randomUUID(), title: t("Knowledge") };
			return existing
				? activateTab(workspace, existing.id)
				: addTab(workspace, tab, paneId ?? workspace.activePaneId);
		});
		setMenuTarget(null);
	}, [sessionId, t, updateWorkspace]);
	const handledKnowledgeRequest = useRef<number | undefined>(undefined);
	useEffect(() => {
		if (!knowledgeRequest || knowledgeRequest.sessionId !== sessionId || knowledgeRequest.id === handledKnowledgeRequest.current) return;
		handledKnowledgeRequest.current = knowledgeRequest.id;
		addKnowledge();
	}, [addKnowledge, knowledgeRequest, sessionId]);

	const openFile = (ownerSessionId: string, cwd: string, relativePath: string, fix: boolean, paneId: string) => {
		updateWorkspace(ownerSessionId, (workspace) => {
			const existing = workspaceTabs(workspace).find((tab) => tab.kind === "file" && tab.relativePath === relativePath);
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
				const preview = workspaceTabs(workspace).find((tab) => tab.kind === "file" && !tab.fixed);
				const nextTab: WorkspaceTab = {
					kind: "file",
					id: preview?.id ?? crypto.randomUUID(),
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
		updateWorkspace(ownerSessionId, (workspace) => {
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
		const ownerWorkspace = workspaces.get(ownerSessionId);
		const tab = ownerWorkspace ? workspaceTabs(ownerWorkspace.workspace).find((candidate) => candidate.id === tabId) : undefined;
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
		const ownerWorkspace = workspaces.get(ownerSessionId);
		if (ownerWorkspace) saveStoredFiles(ownerSessionId, cwd, workspaceTabs(ownerWorkspace.workspace), paths);
	};

	const applyWorkspaceMutation = (ownerSessionId: string, cwd: string, result: DesktopWorkspaceMutationResult, paneId: string) => {
		if (result.action === "create") {
			if (result.kind === "file") openFile(ownerSessionId, cwd, result.relativePath, true, paneId);
			return;
		}

		if (result.action === "trash") {
			const owner = workspaces.get(ownerSessionId)?.workspace;
			if (!owner) return;
			const removedIds = new Set(workspaceTabs(owner).flatMap((tab) =>
				tab.kind === "file" && tab.relativePath && pathIsWithin(tab.relativePath, result.previousRelativePath)
					? [tab.id] : [],
			));
			const expandedPaths = (expandedBySession.get(ownerSessionId) ?? [])
				.filter((path) => !pathIsWithin(path, result.previousRelativePath));
			setExpandedBySession((current) => new Map(current).set(ownerSessionId, expandedPaths));
			setFileDrafts((current) => new Map([...current].filter(([id]) => !removedIds.has(id))));
			updateWorkspace(ownerSessionId, (latest) => {
				let next = removeTabs(latest, removedIds);
				if (!workspaceTabs(next).some((tab) => tab.kind === "file")) {
					const pane = paneForTab(next, CHAT_TAB_ID) ?? activePane(next);
					const placeholder: WorkspaceTab = {
						kind: "file",
						id: crypto.randomUUID(),
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
		updateWorkspace(ownerSessionId, (latest) => {
			const next = {
				...latest,
				panes: latest.panes.map((pane) => ({
					...pane,
					tabs: pane.tabs.map((tab) => {
						if (tab.kind !== "file" || !tab.relativePath || !pathIsWithin(tab.relativePath, result.previousRelativePath)) return tab;
						const relativePath = remapPath(tab.relativePath, result.previousRelativePath, result.relativePath);
						return { ...tab, relativePath, title: displayFileName(relativePath) };
					}),
				})),
			};
			saveStoredFiles(ownerSessionId, cwd, workspaceTabs(next), expandedPaths);
			return next;
		});
	};

	const selectTab = (ownerSessionId: string, id: string) => {
		updateWorkspace(ownerSessionId, (workspace) => activateTab(workspace, id));
	};

	const removeTabInternal = (ownerSessionId: string, id: string) => {
		const ownerWorkspace = workspaces.get(ownerSessionId);
		const closing = ownerWorkspace ? workspaceTabs(ownerWorkspace.workspace).find((tab) => tab.id === id) : undefined;
		if (!closing || closing.kind === "chat") return;
		if (closing.kind === "terminal") void api.closeTerminal({ terminalId: id }).catch(onError);
		else if (closing.kind === "browser") void api.closeBrowser({ sessionId: ownerSessionId, browserId: id }).catch(onError);
		else if (closing.kind === "agent" && ownerSessionId === sessionId) store.selectAgentTranscript(null);
		setFileDrafts((current) => {
			if (!current.has(id)) return current;
			const next = new Map(current);
			next.delete(id);
			return next;
		});
		updateWorkspace(ownerSessionId, (workspace) => {
			const next = removeTab(workspace, id);
			if (closing.kind === "file") {
				saveStoredFiles(
					ownerSessionId,
					closing.cwd,
					workspaceTabs(next),
					expandedBySession.get(ownerSessionId) ?? loadStoredFiles(ownerSessionId, closing.cwd).expandedPaths,
				);
			}
			return next;
		});
	};

	const closeTab = (ownerSessionId: string, id: string) => {
		const ownerWorkspace = workspaces.get(ownerSessionId);
		const closing = ownerWorkspace ? workspaceTabs(ownerWorkspace.workspace).find((tab) => tab.id === id) : undefined;
		if (!closing || closing.kind === "chat" || savingFileTabIds.has(id)) return;
		const draft = closing.kind === "file" ? fileDrafts.get(id) : undefined;
		if (draft && draft.text !== draft.savedText) {
			setPendingFileClose({ sessionId: ownerSessionId, tabId: id, name: closing.title });
			return;
		}
		removeTabInternal(ownerSessionId, id);
	};

	const discardPendingFile = () => {
		if (!pendingFileClose) return;
		removeTabInternal(pendingFileClose.sessionId, pendingFileClose.tabId);
		setPendingFileClose(null);
	};

	const saveAndClosePendingFile = async () => {
		if (!pendingFileClose) return;
		try {
			await saveFileTab(pendingFileClose.sessionId, pendingFileClose.tabId);
			removeTabInternal(pendingFileClose.sessionId, pendingFileClose.tabId);
			setPendingFileClose(null);
		} catch (cause) {
			onError(cause);
		}
	};

	const updateBrowserState = (ownerSessionId: string, state: DesktopBrowserState) => {
		updateWorkspace(ownerSessionId, (workspace) => {
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

	const handleDropOnStrip = (ownerSessionId: string, paneId: string, index: number) => {
		const drag = dragState;
		setDragState(null);
		setDropTarget(null);
		if (!drag || drag.tabId === CHAT_TAB_ID) return;
		updateWorkspace(drag.sessionId, (workspace) => moveTab(workspace, drag.tabId, paneId, index));
	};

	const handleDropSplit = (ownerSessionId: string, besidePaneId: string) => {
		const drag = dragState;
		setDragState(null);
		setDropTarget(null);
		if (!drag || drag.tabId === CHAT_TAB_ID) return;
		updateWorkspace(drag.sessionId, (workspace) => splitTabBeside(workspace, drag.tabId, besidePaneId));
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

	const toolMenu = (ownerSessionId: string, paneId: string) => (
		<nav
			aria-label={t("Available tools")}
			className="tool-add-menu"
			role="menu"
		>
			<button disabled={!activeSession} onClick={() => addKnowledge(paneId)} role="menuitem" type="button">
				<div className="tool-menu-icon"><Books aria-hidden="true" size={14} /></div>
				<span>{t("Knowledge")}</span>
			</button>
			{mode === "code" && (
				<button disabled={!activeSession?.cwd} onClick={() => addReview(paneId)} role="menuitem" title={activeSession?.cwd ? undefined : t("Open a task before reviewing changes")} type="button">
					<div className="tool-menu-icon"><ClipboardText aria-hidden="true" size={14} /></div>
					<span>{t("Review")}</span>
				</button>
			)}
			<button disabled={!activeSession?.cwd} onClick={() => addTerminal(paneId)} role="menuitem" title={activeSession?.cwd ? undefined : t("Open a task before starting a terminal")} type="button">
				<div className="tool-menu-icon"><TerminalWindow aria-hidden="true" size={14} /></div>
				<span>{t("Terminal")}</span>
			</button>
			<button disabled={!activeSession} onClick={() => addBrowser(paneId)} role="menuitem" title={activeSession ? undefined : t("Open a task before starting a browser")} type="button">
				<div className="tool-menu-icon"><Globe aria-hidden="true" size={14} /></div>
				<span>{t("Browser")}</span>
			</button>
			{mode === "code" && (
				<button disabled={!activeSession?.cwd} onClick={() => addFiles(paneId)} role="menuitem" title={activeSession?.cwd ? undefined : t("Open a task before browsing files")} type="button">
					<div className="tool-menu-icon"><FileText aria-hidden="true" size={14} /></div>
					<span>{t("Files")}</span>
				</button>
			)}
			{mode === "code" && (
				<button disabled={!activeSession} onClick={() => addAgent(paneId)} role="menuitem" type="button">
					<div className="tool-menu-icon"><Robot aria-hidden="true" size={14} /></div>
					<span>{t("Agents")}</span>
				</button>
			)}
			<div aria-hidden="true" className="workspace-add-menu-separator" />
			<button disabled={!onNewSession} onClick={() => { onNewSession?.(); setMenuTarget(null); }} role="menuitem" title={onNewSession ? undefined : t("Open a session in a project first")} type="button">
				<div className="tool-menu-icon"><ChatCircle aria-hidden="true" size={14} /></div>
				<span>{t("New session")}</span>
			</button>
		</nav>
	);

	const renderTabStrip = (ownerSessionId: string, ownerWorkspace: SessionWorkspace, pane: WorkspacePane, isOwner: boolean) => (
		<div
			className={`workspace-tabbar${dropTarget && "paneId" in dropTarget && dropTarget.paneId === pane.id ? " is-drop-target" : ""}`}
			onDragLeave={() => setDropTarget((current) => current && "paneId" in current && current.paneId === pane.id ? null : current)}
			onDragOver={(event) => {
				if (!dragState || dragState.tabId === CHAT_TAB_ID || dragState.sessionId !== ownerSessionId) return;
				event.preventDefault();
				event.stopPropagation();
				event.dataTransfer.dropEffect = "move";
				setDropTarget({ sessionId: ownerSessionId, paneId: pane.id, index: stripDropIndex(event) });
			}}
			onDrop={(event) => {
				event.preventDefault();
				event.stopPropagation();
				handleDropOnStrip(ownerSessionId, pane.id, stripDropIndex(event));
			}}
			role="tablist"
		>
			<div className="tool-tabs-scroll">
				{pane.tabs.map((tab) => {
					const displayTitle = tab.kind === "chat"
						? (isOwner ? chatTitle : t("Chat"))
						: tab.kind === "browser" && tab.url === ""
							? t("New tab")
							: tab.kind === "file" && tab.relativePath === null ? t("Open file") : tab.title;
					const draft = tab.kind === "file" ? fileDrafts.get(tab.id) : undefined;
					const dirty = draft !== undefined && draft.text !== draft.savedText;
					const saving = savingFileTabIds.has(tab.id);
					return (
						<div
							className={`tool-tab${pane.activeId === tab.id ? " is-active" : ""}${tab.kind === "file" && !tab.fixed ? " is-preview" : ""}${dirty ? " is-dirty" : ""}`}
							draggable={tab.kind !== "chat"}
							key={tab.id}
							onDragEnd={() => { setDragState(null); setDropTarget(null); }}
							onDragStart={(event) => {
								if (tab.kind === "chat") return;
								event.dataTransfer.setData("text/plain", tab.id);
								event.dataTransfer.effectAllowed = "move";
								setDragState({ sessionId: ownerSessionId, tabId: tab.id });
							}}
							onContextMenu={(event) => {
								event.preventDefault();
								if (tab.kind === "chat") return;
								setMenuTarget(null);
								setTabMenu({ sessionId: ownerSessionId, paneId: pane.id, tabId: tab.id, x: event.clientX, y: event.clientY });
							}}
						>
							<button
								aria-selected={pane.activeId === tab.id}
								aria-label={dirty ? `${displayTitle}, ${t("Unsaved")}` : displayTitle}
								className="tool-tab-select"
								onClick={() => selectTab(ownerSessionId, tab.id)}
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
							{tab.kind !== "chat" && (
								<button
									aria-label={t("Close {{name}}", { name: displayTitle })}
									className="tool-tab-close"
									disabled={saving}
									onClick={() => closeTab(ownerSessionId, tab.id)}
									type="button"
								>
									<X aria-hidden="true" size={11} />
								</button>
							)}
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
					onClick={() => setMenuTarget((current) => current?.paneId === pane.id ? null : { sessionId: ownerSessionId, paneId: pane.id })}
					type="button"
				>
					<Plus aria-hidden="true" size={13} />
				</button>
				{menuTarget?.paneId === pane.id && toolMenu(ownerSessionId, pane.id)}
			</div>
		</div>
	);

	const renderPanePanels = (ownerSessionId: string, ownerWorkspace: SessionWorkspace, pane: WorkspacePane, isOwner: boolean) => {
		const paneFileTabs = pane.tabs.filter((tab): tab is Extract<WorkspaceTab, { kind: "file" }> => tab.kind === "file");
		const activeFileTab = paneFileTabs.find((tab) => tab.id === pane.activeId);
		const dirtyPaths = paneFileTabs.flatMap((tab) => {
			const draft = fileDrafts.get(tab.id);
			return tab.relativePath && draft && draft.text !== draft.savedText ? [tab.relativePath] : [];
		});
		const savingPaths = paneFileTabs.flatMap((tab) =>
			tab.relativePath && savingFileTabIds.has(tab.id) ? [tab.relativePath] : [],
		);
		const panelVisible = (tabId: string) =>
			isOwner && visible && pane.activeId === tabId
			&& !(menuTarget?.paneId === pane.id && menuTarget.sessionId === ownerSessionId)
			&& !(tabMenu?.paneId === pane.id && tabMenu.sessionId === ownerSessionId);
		return (
			<>
				{isOwner && pane.tabs.some((tab) => tab.kind === "chat") && (
					<div className="workspace-chat-panel" hidden={pane.activeId !== CHAT_TAB_ID}>
						{chat}
					</div>
				)}
				{pane.tabs.flatMap((tab) =>
					tab.kind === "process" ? (
						<ProcessPanel
							key={tab.id}
							panelId={`process-panel-${tab.id}`}
							process={tab.process}
							theme={theme}
							onError={onError}
							visible={panelVisible(tab.id)}
						/>
					) : tab.kind === "terminal" ? (
						<TerminalPanel
							api={api}
							cwd={tab.cwd}
							key={tab.id}
							terminalId={tab.id}
							theme={theme}
							visible={panelVisible(tab.id)}
						/>
					) : tab.kind === "browser" ? (
						<BrowserPanel
							api={api}
							browserId={tab.id}
							controlState={tab.controlState}
							handoffReason={tab.handoffReason}
							sessionId={ownerSessionId}
							key={tab.id}
							onError={onError}
							onOpenProfile={(profile) => {
								const selected = browserProfiles.find((candidate) => candidate.profileId === profile.profileId);
								if (selected) addBrowser(pane.id, selected);
							}}
							onProfileImported={browserProfileImported}
							onState={(state) => updateBrowserState(ownerSessionId, state)}
							profile={{ profileId: tab.profileId, name: tab.profileName }}
							profiles={browserProfiles}
							visible={panelVisible(tab.id)}
						/>
					) : tab.kind === "knowledge" ? (
						<KnowledgePanel api={api} key={tab.id} sessionId={ownerSessionId} visible={panelVisible(tab.id)} />
					) : tab.kind === "review" ? (
						<ReviewPanel
							api={api}
							key={tab.id}
							sessionId={ownerSessionId}
							theme={theme}
							visible={panelVisible(tab.id)}
						/>
					) : tab.kind === "agent" && isOwner ? (
						<AgentTreePanel
							api={api}
							key={tab.id}
							onError={onError}
							sessionId={ownerSessionId}
							store={store}
							visible={panelVisible(tab.id)}
						/>
					) : tab.kind === "plan" ? (
						<div
							className="tool-panel plan-panel"
							hidden={!panelVisible(tab.id)}
							id={`plan-panel-${tab.id}`}
							key={tab.id}
							role="tabpanel"
						>
							<PlanPreview plan={tab.plan} />
						</div>
					) : tab.kind === "preview" ? (
						<div
							className="tool-panel preview-panel"
							hidden={!panelVisible(tab.id)}
							id={`preview-panel-${tab.id}`}
							key={tab.id}
							role="tabpanel"
						>
							<UniversalFilePreviewer
								active={panelVisible(tab.id)}
								api={api}
								file={tab.file}
								onClose={() => closeTab(ownerSessionId, tab.id)}
								onError={onError}
							/>
						</div>
					) : [],
				)}
				{paneFileTabs.length > 0 && (
					<FilePanel
						activePath={activeFileTab?.relativePath ?? null}
						api={api}
						cwd={paneFileTabs[0]!.cwd}
						draft={activeFileTab ? fileDrafts.get(activeFileTab.id) ?? null : null}
						dirtyPaths={dirtyPaths}
						expandedPaths={expandedBySession.get(ownerSessionId) ?? []}
						key={`files-${ownerSessionId}-${pane.id}`}
						onDraftChange={(text) => { if (activeFileTab) updateFileDraft(ownerSessionId, activeFileTab.id, text); }}
						onDraftLoaded={(file) => { if (activeFileTab) loadFileDraft(activeFileTab.id, file); }}
						onError={onError}
						onExpandedPathsChange={(paths) => updateExpandedPaths(ownerSessionId, paneFileTabs[0]!.cwd, paths)}
						onOpenFile={(relativePath, fix) => openFile(ownerSessionId, paneFileTabs[0]!.cwd, relativePath, fix, pane.id)}
						onSave={async () => { if (activeFileTab) await saveFileTab(ownerSessionId, activeFileTab.id); }}
						onWorkspaceMutation={(result) => applyWorkspaceMutation(ownerSessionId, paneFileTabs[0]!.cwd, result, pane.id)}
						saving={activeFileTab ? savingFileTabIds.has(activeFileTab.id) : false}
						savingPaths={savingPaths}
						sessionId={ownerSessionId}
						visible={isOwner && visible && activeFileTab !== undefined
							&& !(menuTarget?.paneId === pane.id && menuTarget.sessionId === ownerSessionId)
							&& !(tabMenu?.paneId === pane.id && tabMenu.sessionId === ownerSessionId)}
					/>
				)}
			</>
		);
	};

	const renderWorkspace = (ownerSessionId: string, ownerWorkspace: SessionWorkspace, isOwner: boolean, slotId: string) => (
		<div className="session-workspace-instance" hidden={!isOwner} key={slotId}>
			<div className="session-workspace-panes">
				{ownerWorkspace.panes.map((pane) => (
					<section
						className={`workspace-pane${dropTarget && "splitBeside" in dropTarget && dropTarget.splitBeside === pane.id ? " is-split-target" : ""}`}
						key={pane.id}
						onDragLeave={(event) => {
							if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
							setDropTarget((current) => current && "splitBeside" in current && current.splitBeside === pane.id ? null : current);
						}}
						onDragOver={(event) => {
							if (!dragState || dragState.tabId === CHAT_TAB_ID || dragState.sessionId !== ownerSessionId) return;
							event.preventDefault();
							const rect = event.currentTarget.getBoundingClientRect();
							const edge = Math.min(120, rect.width * 0.25);
							if (rect.right - event.clientX <= edge) {
								event.dataTransfer.dropEffect = "move";
								setDropTarget({ sessionId: ownerSessionId, splitBeside: pane.id });
							} else {
								setDropTarget({ sessionId: ownerSessionId, paneId: pane.id, index: pane.tabs.length });
							}
						}}
						onDrop={(event) => {
							event.preventDefault();
							const rect = event.currentTarget.getBoundingClientRect();
							const edge = Math.min(120, rect.width * 0.25);
							if (rect.right - event.clientX <= edge) handleDropSplit(ownerSessionId, pane.id);
							else handleDropOnStrip(ownerSessionId, pane.id, pane.tabs.length);
						}}
					>
						{renderTabStrip(ownerSessionId, ownerWorkspace, pane, isOwner)}
						<div className="workspace-pane-body">
							{renderPanePanels(ownerSessionId, ownerWorkspace, pane, isOwner)}
						</div>
					</section>
				))}
			</div>
		</div>
	);

	const workspaceEntries = [...workspaces.entries()];
	if (!workspaces.has(displayedSessionId)) {
		workspaceEntries.push([displayedSessionId, { slotId: `pending:${displayedSessionId}`, workspace }]);
	}

	return (
		<div className="session-workspace-root" hidden={!visible}>
			{workspaceEntries.map(([ownerSessionId, ownerEntry]) =>
				renderWorkspace(ownerSessionId, ownerEntry.workspace, ownerSessionId === displayedSessionId, ownerEntry.slotId),
			)}
			{tabMenu && (() => {
				const menuWorkspace = workspaces.get(tabMenu.sessionId)?.workspace;
				const otherPanes = menuWorkspace?.panes.filter((pane) => pane.id !== tabMenu.paneId) ?? [];
				const menuStyle: CSSProperties = { left: `${tabMenu.x}px`, top: `${tabMenu.y}px` };
				return (
					<nav aria-label={t("Tab actions")} className="tool-add-menu workspace-tab-menu" role="menu" style={menuStyle}>
						<button onClick={() => { updateWorkspace(tabMenu.sessionId, (ws) => splitTabRight(ws, tabMenu.tabId)); setTabMenu(null); }} role="menuitem" type="button">
							<span>{t("Split right")}</span>
						</button>
						{otherPanes.map((pane, index) => (
							<button key={pane.id} onClick={() => { updateWorkspace(tabMenu.sessionId, (ws) => moveTab(ws, tabMenu.tabId, pane.id)); setTabMenu(null); }} role="menuitem" type="button">
								<span>{t("Move to pane {{index}}", { index: index + 1 })}</span>
							</button>
						))}
						<button onClick={() => { closeTab(tabMenu.sessionId, tabMenu.tabId); setTabMenu(null); }} role="menuitem" type="button">
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
