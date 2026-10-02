import type { AgentMode, PlanView, SessionProcessView, SessionSummary } from "@metis/app-protocol";
import { Books, ClipboardText, FileText, Globe, Plus, Robot, SidebarSimple, TerminalWindow, X } from "@phosphor-icons/react";
import type { CSSProperties } from "react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	DEFAULT_BROWSER_PROFILE_ID,
	type DesktopBrowserHandoffReason,
	type DesktopBrowserProfile,
	type DesktopBrowserState,
	type DesktopWorkspaceMutationResult,
	type MetisDesktopApi,
} from "../../shared/desktop-api.ts";
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

interface TerminalTab {
	readonly kind: "terminal";
	readonly id: string;
	readonly title: string;
	readonly cwd: string;
}

interface BrowserTab {
	readonly kind: "browser";
	readonly id: string;
	readonly title: string;
	readonly url: string;
	readonly profileId: string;
	readonly profileName: string;
	readonly controlState: "idle" | "agent" | "handoff";
	readonly handoffReason?: DesktopBrowserHandoffReason;
}

interface FileTab {
	readonly kind: "file";
	readonly id: string;
	readonly title: string;
	readonly cwd: string;
	readonly relativePath: string | null;
	readonly fixed: boolean;
}

interface ReviewTab {
	readonly kind: "review";
	readonly id: string;
	readonly title: string;
}

interface AgentTab {
	readonly kind: "agent";
	readonly id: string;
	readonly title: string;
}

interface PlanTab {
	readonly kind: "plan";
	readonly id: string;
	readonly title: string;
	readonly plan: PlanView;
}

interface PreviewTab {
	readonly kind: "preview";
	readonly id: string;
	readonly title: string;
	readonly file: UniversalPreviewTarget;
}

interface ProcessTab {
	readonly kind: "process";
	readonly id: string;
	readonly title: string;
	readonly process: SessionProcessView;
}

interface KnowledgeTab {
	readonly kind: "knowledge";
	readonly id: string;
	readonly title: string;
}

type ToolTab = KnowledgeTab | ProcessTab | TerminalTab | BrowserTab | FileTab | ReviewTab | AgentTab | PreviewTab | PlanTab;

interface ToolWorkspace {
	readonly tabs: readonly ToolTab[];
	readonly activeId: string;
	readonly nextNumber: number;
}

interface PendingFileClose {
	readonly sessionId: string;
	readonly tabId: string;
	readonly name: string;
}

interface ToolsSidebarProps {
	readonly activeSession: Pick<SessionSummary, "sessionId" | "cwd"> | null;
	readonly api: MetisDesktopApi;
	readonly cleanupSessionIds: readonly string[];
	readonly mode: AgentMode;
	readonly onClose: () => void;
	readonly onOpen?: (sessionId: string) => void;
	readonly process?: SessionProcessView;
	readonly onActivateSession: (sessionId: string) => void;
	readonly onCleanupSessionIdsHandled: (sessionIds: readonly string[]) => void;
	readonly onDirtySessionIdsChange: (sessionIds: readonly string[]) => void;
	readonly onError: (cause: unknown) => void;
	readonly onWidthChange: (width: number, persist?: boolean) => void;
	readonly open: boolean;
	readonly preferredWidth: number;
	readonly previewRequest?: UniversalPreviewTarget | null;
	readonly planPreviewRequest?: PlanView | null;
	readonly knowledgeRequest?: { readonly id: number; readonly sessionId: string };
	readonly store: AppStore;
	readonly theme: "dark" | "light";
	readonly width: number;
}

export function clampToolsSidebarWidth(
	value: number,
	workspaceWidth = document.querySelector<HTMLElement>(".workspace")?.clientWidth || window.innerWidth,
): number {
	const maximum = Math.max(280, Math.min(Math.floor(workspaceWidth * 0.85), workspaceWidth - 280 - 7));
	return Math.max(280, Math.min(maximum, value));
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

function saveStoredFiles(sessionId: string, cwd: string, tabs: readonly ToolTab[], expandedPaths: readonly string[]): void {
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

export function ToolsSidebar({ activeSession, api, cleanupSessionIds, mode, onActivateSession, onClose, onOpen, process, onCleanupSessionIdsHandled, onDirtySessionIdsChange, onError, onWidthChange, open, planPreviewRequest, knowledgeRequest, preferredWidth, previewRequest, store, theme, width }: ToolsSidebarProps) {
	const { t } = useTranslation();
	const [workspaces, setWorkspaces] = useState<ReadonlyMap<string, ToolWorkspace>>(new Map());
	const [expandedBySession, setExpandedBySession] = useState<ReadonlyMap<string, readonly string[]>>(new Map());
	const [fileDrafts, setFileDrafts] = useState<ReadonlyMap<string, WorkspaceFileDraft>>(new Map());
	const [savingFileTabIds, setSavingFileTabIds] = useState<ReadonlySet<string>>(new Set());
	const [pendingFileClose, setPendingFileClose] = useState<PendingFileClose | null>(null);
	const [menuOpen, setMenuOpen] = useState(false);
	const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
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
	const resizeRef = useRef<{ readonly pointerId: number; readonly x: number; readonly width: number } | null>(null);
	const sessionId = activeSession?.sessionId ?? null;
	const workspace = sessionId ? workspaces.get(sessionId) : undefined;
	const tabs = workspace?.tabs ?? [];
	const dirtySessionIds = useMemo(() => [...workspaces]
		.filter(([, owner]) => owner.tabs.some((tab) => {
			const draft = tab.kind === "file" ? fileDrafts.get(tab.id) : undefined;
			return draft !== undefined && draft.text !== draft.savedText;
		}))
		.map(([ownerSessionId]) => ownerSessionId)
		.sort(), [fileDrafts, workspaces]);
	const dirtySessionKey = dirtySessionIds.join("\0");

	const seenProcesses = useRef(new Map<string, string>());

	const openProcess = useCallback(() => {
		if (!sessionId || !process) return;
		const id = `process-${sessionId}`;
		setWorkspaces((current) => {
			const owner = current.get(sessionId) ?? { tabs: [], activeId: id, nextNumber: 1 };
			const tab: ProcessTab = { kind: "process", id, title: "Process", process };
			const tabs = owner.tabs.some((item) => item.id === id) ? owner.tabs.map((item) => item.id === id ? tab : item) : [...owner.tabs, tab];
			return new Map(current).set(sessionId, { ...owner, tabs, activeId: id });
		});
		setMenuOpen(false);
		onOpen?.(sessionId);
	}, [onOpen, process, sessionId]);

	useEffect(() => {
		if (!sessionId || !process) return;
		const previousId = seenProcesses.current.get(sessionId);
		seenProcesses.current.set(sessionId, process.processId);
		if (previousId !== process.processId) {
			openProcess();
			return;
		}
		setWorkspaces((current) => {
			const owner = current.get(sessionId);
			if (!owner?.tabs.some((tab) => tab.kind === "process")) return current;
			return new Map(current).set(sessionId, { ...owner, tabs: owner.tabs.map((tab) => tab.kind === "process" ? { ...tab, process } : tab) });
		});
	}, [openProcess, process, sessionId]);

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
					setWorkspaces((current) => {
						const workspace = current.get(event.sessionId) ?? { tabs: [], activeId: "", nextNumber: 1 };
						if (workspace.tabs.some(({ id }) => id === event.browserId)) return current;
						const next = new Map(current);
						next.set(event.sessionId, {
							...workspace,
							activeId: event.browserId,
							tabs: [
								...workspace.tabs,
								{
									kind: "browser",
									id: event.browserId,
									title: t("New tab"),
									url: "",
									profileId: event.profileId,
									profileName: profile?.name ?? t("Browser"),
									controlState: "idle",
								},
							],
						});
						return next;
					});
					return;
				}
				if (event.type === "closed") {
					setWorkspaces((current) => {
						const workspace = current.get(event.sessionId);
						if (!workspace?.tabs.some(({ id }) => id === event.browserId)) return current;
						const tabs = workspace.tabs.filter(({ id }) => id !== event.browserId);
						const next = new Map(current);
						next.set(event.sessionId, {
							...workspace,
							tabs,
							activeId: workspace.activeId === event.browserId ? (tabs.at(-1)?.id ?? "") : workspace.activeId,
						});
						return next;
					});
					return;
				}
				if (event.type !== "activity" && event.type !== "handoff") return;
				setWorkspaces((current) => {
					const workspace = current.get(event.sessionId);
					if (!workspace) return current;
					let changed = false;
					const tabs = workspace.tabs.map((tab) => {
						if (tab.kind !== "browser" || tab.id !== event.browserId) return tab;
						changed = true;
						if (event.type === "activity") {
							return { ...tab, controlState: event.active ? "agent" as const : "idle" as const, handoffReason: undefined };
						}
						return event.status === "requested"
							? { ...tab, controlState: "handoff" as const, handoffReason: event.reason }
							: { ...tab, controlState: "idle" as const, handoffReason: undefined };
					});
					if (!changed) return current;
					const next = new Map(current);
					next.set(event.sessionId, {
						...workspace,
						tabs,
						activeId: event.type === "handoff" && event.status === "requested"
							? event.browserId
							: workspace.activeId,
					});
					return next;
				});
				if (event.type === "handoff" && event.status === "requested") {
					onActivateSession(event.sessionId);
				}
			}),
		[api, onActivateSession, t],
	);

	useEffect(() => setMenuOpen(false), [mode, sessionId]);
	useEffect(() => onDirtySessionIdsChange(dirtySessionIds), [dirtySessionKey, onDirtySessionIdsChange]);
	useEffect(() => {
		if (cleanupSessionIds.length === 0) return;
		const removedTabIds = new Set<string>();
		for (const ownerSessionId of cleanupSessionIds) {
			previewBytesCache.deleteSession(ownerSessionId);
			for (const tab of workspaces.get(ownerSessionId)?.tabs ?? []) {
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
		const resize = () => onWidthChange(clampToolsSidebarWidth(preferredWidth), false);
		window.addEventListener("resize", resize);
		resize();
		return () => window.removeEventListener("resize", resize);
	}, [onWidthChange, preferredWidth]);
	const updateMenuPosition = useCallback(() => {
		if (!menuRef.current) return;
		const trigger = menuRef.current;
		const sidebar = trigger.closest<HTMLElement>(".tool-sidebar");
		if (!sidebar) return;
		const triggerRect = trigger.getBoundingClientRect();
		const sidebarRect = sidebar.getBoundingClientRect();
		if (triggerRect.width === 0 || sidebarRect.width === 0) return;
		const menuWidth = 200;
		const spaceRight = sidebarRect.right - triggerRect.left - 8;
		const offset = Math.min(0, spaceRight - menuWidth);
		const minLeft = sidebarRect.left + 8 - triggerRect.left;
		const left = Math.max(minLeft, offset);
		setMenuStyle({ left: `${Math.round(left)}px` });
	}, []);

	useLayoutEffect(() => {
		if (!menuOpen) {
			setMenuStyle({});
			return;
		}
		updateMenuPosition();
		window.addEventListener("resize", updateMenuPosition);
		return () => window.removeEventListener("resize", updateMenuPosition);
	}, [menuOpen, updateMenuPosition]);

	useEffect(() => {
		if (!menuOpen) return;
		const close = (event: PointerEvent) => {
			if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
		};
		const escape = (event: KeyboardEvent) => {
			if (event.key === "Escape") setMenuOpen(false);
		};
		document.addEventListener("pointerdown", close);
		document.addEventListener("keydown", escape);
		return () => {
			document.removeEventListener("pointerdown", close);
			document.removeEventListener("keydown", escape);
		};
	}, [menuOpen]);
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
		setWorkspaces((current) => {
			const previous = current.get(sessionId) ?? { tabs: [], activeId: "", nextNumber: 1 };
			const existing = previous.tabs.find(
				(tab): tab is PreviewTab =>
					tab.kind === "preview" &&
					tab.file.source === previewRequest.source &&
					(previewRequest.fileId ? tab.file.fileId === previewRequest.fileId : tab.file.relativePath === previewRequest.relativePath),
			);
			if (existing) {
				const next = new Map(current);
				next.set(sessionId, { ...previous, activeId: existing.id });
				return next;
			}
			const nextTabId = crypto.randomUUID();
			const previewTab: PreviewTab = {
				kind: "preview",
				id: nextTabId,
				title: previewRequest.name,
				file: previewRequest,
			};
			const next = new Map(current);
			next.set(sessionId, {
				...previous,
				tabs: [...previous.tabs, previewTab],
				activeId: nextTabId,
			});
			return next;
		});
	}, [previewRequest, sessionId]);

	useEffect(() => {
		if (!planPreviewRequest || !sessionId) return;
		setWorkspaces((current) => {
			const previous = current.get(sessionId) ?? { tabs: [], activeId: "", nextNumber: 1 };
			const existing = previous.tabs.find(
				(tab): tab is PlanTab => tab.kind === "plan" && tab.plan.planId === planPreviewRequest.planId,
			);
			if (existing) {
				const tabs = previous.tabs.map((tab) =>
					tab.kind === "plan" && tab.plan.planId === planPreviewRequest.planId
						? { ...tab, title: planPreviewRequest.title, plan: planPreviewRequest }
						: tab,
				);
				const next = new Map(current);
				next.set(sessionId, { ...previous, tabs, activeId: existing.id });
				return next;
			}
			const planTab: PlanTab = {
				kind: "plan",
				id: planPreviewRequest.planId,
				title: planPreviewRequest.title,
				plan: planPreviewRequest,
			};
			const next = new Map(current);
			next.set(sessionId, {
				...previous,
				tabs: [...previous.tabs, planTab],
				activeId: planTab.id,
			});
			return next;
		});
	}, [planPreviewRequest, sessionId]);

	const addTerminal = () => {
		if (!activeSession?.cwd) return;
		const cwd = activeSession.cwd;
		const id = crypto.randomUUID();
		setWorkspaces((current) => {
			const next = new Map(current);
			const previous = current.get(activeSession.sessionId) ?? { tabs: [], activeId: "", nextNumber: 1 };
			const number = previous.nextNumber;
			const tab: TerminalTab = {
				kind: "terminal",
				id,
				cwd,
				title: number === 1 ? t("Terminal") : t("Terminal {{number}}", { number }),
			};
			next.set(activeSession.sessionId, {
				tabs: [...previous.tabs, tab],
				activeId: id,
				nextNumber: number + 1,
			});
			return next;
		});
		setMenuOpen(false);
	};

	const addBrowser = (
		profile = browserProfiles.find((candidate) => candidate.profileId === preferredBrowserProfileId.current)
			?? browserProfiles[0],
	) => {
		if (!activeSession || !profile) return;
		preferredBrowserProfileId.current = profile.profileId;
		try {
			localStorage.setItem(BROWSER_PROFILE_STORAGE_KEY, profile.profileId);
		} catch {
			// Browsing still works when preference storage is unavailable.
		}
		const id = crypto.randomUUID();
		setWorkspaces((current) => {
			const next = new Map(current);
			const previous = current.get(activeSession.sessionId) ?? { tabs: [], activeId: "", nextNumber: 1 };
			const tab: BrowserTab = {
				kind: "browser",
				id,
				title: t("New tab"),
				url: "",
				profileId: profile.profileId,
				profileName: profile.name,
				controlState: "idle",
			};
			next.set(activeSession.sessionId, {
				...previous,
				tabs: [...previous.tabs, tab],
				activeId: id,
			});
			return next;
		});
		setMenuOpen(false);
	};

	const browserProfileImported = (profile: DesktopBrowserProfile) => {
		setBrowserProfiles((current) => current.some((candidate) => candidate.profileId === profile.profileId)
			? current.map((candidate) => candidate.profileId === profile.profileId ? profile : candidate)
			: [...current, profile]);
		addBrowser(profile);
	};

	const addFiles = () => {
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
		setWorkspaces((current) => {
			const previous = current.get(ownerSessionId) ?? { tabs: [], activeId: "", nextNumber: 1 };
			const existing = [...previous.tabs].reverse().find((tab) => tab.kind === "file");
			if (existing) {
				const next = new Map(current);
				next.set(ownerSessionId, { ...previous, activeId: existing.id });
				return next;
			}
			const restored: FileTab[] = stored.fixedPaths.map((relativePath) => ({
				kind: "file",
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
			const next = new Map(current);
			next.set(ownerSessionId, {
				...previous,
				tabs: [...previous.tabs, ...files],
				activeId: files[0]!.id,
			});
			return next;
		});
		setMenuOpen(false);
	};

	const addReview = () => {
		if (!activeSession?.cwd || mode !== "code") return;
		const ownerSessionId = activeSession.sessionId;
		setWorkspaces((current) => {
			const previous = current.get(ownerSessionId) ?? { tabs: [], activeId: "", nextNumber: 1 };
			const existing = previous.tabs.find((tab) => tab.kind === "review");
			const next = new Map(current);
			if (existing) next.set(ownerSessionId, { ...previous, activeId: existing.id });
			else {
				const tab: ReviewTab = { kind: "review", id: crypto.randomUUID(), title: t("Review") };
				next.set(ownerSessionId, { ...previous, tabs: [...previous.tabs, tab], activeId: tab.id });
			}
			return next;
		});
		setMenuOpen(false);
	};

	const addAgent = () => {
		if (!activeSession || mode !== "code") return;
		const ownerSessionId = activeSession.sessionId;
		setWorkspaces((current) => {
			const previous = current.get(ownerSessionId) ?? { tabs: [], activeId: "", nextNumber: 1 };
			const existing = previous.tabs.find((tab) => tab.kind === "agent");
			const tab: AgentTab = existing ?? { kind: "agent", id: crypto.randomUUID(), title: t("Agents") };
			const next = new Map(current);
			next.set(ownerSessionId, {
				...previous,
				tabs: existing ? previous.tabs : [...previous.tabs, tab],
				activeId: tab.id,
			});
			return next;
		});
		setMenuOpen(false);
	};

	const addKnowledge = useCallback(() => {
		if (!sessionId) return;
		setWorkspaces((current) => {
			const previous = current.get(sessionId) ?? { tabs: [], activeId: "", nextNumber: 1 };
			const existing = previous.tabs.find((tab) => tab.kind === "knowledge");
			const tab: KnowledgeTab = existing ?? { kind: "knowledge", id: crypto.randomUUID(), title: t("Knowledge") };
			return new Map(current).set(sessionId, {
				...previous,
				tabs: existing ? previous.tabs : [...previous.tabs, tab],
				activeId: tab.id,
			});
		});
		setMenuOpen(false);
	}, [sessionId, t]);
	const handledKnowledgeRequest = useRef<number | undefined>(undefined);
	useEffect(() => {
		if (!knowledgeRequest || knowledgeRequest.sessionId !== sessionId || knowledgeRequest.id === handledKnowledgeRequest.current) return;
		handledKnowledgeRequest.current = knowledgeRequest.id;
		addKnowledge();
	}, [addKnowledge, knowledgeRequest, sessionId]);

	const openFile = (ownerSessionId: string, cwd: string, relativePath: string, fix: boolean) => {
		setWorkspaces((current) => {
			const previous = current.get(ownerSessionId);
			if (!previous) return current;
			const existing = previous.tabs.find((tab) => tab.kind === "file" && tab.relativePath === relativePath);
			let tabs: readonly ToolTab[];
			let activeId: string;
			if (existing) {
				activeId = existing.id;
				tabs = fix && existing.kind === "file" && !existing.fixed
					? previous.tabs.map((tab) => tab.id === existing.id ? { ...existing, fixed: true } : tab)
					: previous.tabs;
			} else {
				const preview = previous.tabs.find((tab) => tab.kind === "file" && !tab.fixed);
				const nextTab: FileTab = {
					kind: "file",
					id: preview?.id ?? crypto.randomUUID(),
					title: displayFileName(relativePath),
					cwd,
					relativePath,
					fixed: fix,
				};
				activeId = nextTab.id;
				tabs = preview
					? previous.tabs.map((tab) => tab.id === preview.id ? nextTab : tab)
					: [...previous.tabs, nextTab];
			}
			const next = new Map(current);
			next.set(ownerSessionId, { ...previous, tabs, activeId });
			saveStoredFiles(
				ownerSessionId,
				cwd,
				tabs,
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
		setWorkspaces((current) => {
			const owner = current.get(ownerSessionId);
			const fileTab = owner?.tabs.find((tab): tab is FileTab => tab.kind === "file" && tab.id === tabId);
			if (!owner || !fileTab || fileTab.fixed) return current;
			const tabs = owner.tabs.map((tab) => tab.id === tabId ? { ...fileTab, fixed: true } : tab);
			const next = new Map(current);
			next.set(ownerSessionId, { ...owner, tabs });
			saveStoredFiles(
				ownerSessionId,
				fileTab.cwd,
				tabs,
				expandedBySession.get(ownerSessionId) ?? loadStoredFiles(ownerSessionId, fileTab.cwd).expandedPaths,
			);
			return next;
		});
	};

	const saveFileTab = async (ownerSessionId: string, tabId: string): Promise<void> => {
		const tab = workspaces.get(ownerSessionId)?.tabs.find((candidate) => candidate.id === tabId);
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
		if (ownerWorkspace) saveStoredFiles(ownerSessionId, cwd, ownerWorkspace.tabs, paths);
	};

	const applyWorkspaceMutation = (ownerSessionId: string, cwd: string, result: DesktopWorkspaceMutationResult) => {
		if (result.action === "create") {
			if (result.kind === "file") openFile(ownerSessionId, cwd, result.relativePath, true);
			return;
		}

		if (result.action === "trash") {
			const owner = workspaces.get(ownerSessionId);
			if (!owner) return;
			const removedIds = new Set(owner.tabs.flatMap((tab) =>
				tab.kind === "file" && tab.relativePath && pathIsWithin(tab.relativePath, result.previousRelativePath)
					? [tab.id] : [],
			));
			const expandedPaths = (expandedBySession.get(ownerSessionId) ?? [])
				.filter((path) => !pathIsWithin(path, result.previousRelativePath));
			setExpandedBySession((current) => new Map(current).set(ownerSessionId, expandedPaths));
			setFileDrafts((current) => new Map([...current].filter(([id]) => !removedIds.has(id))));
			setWorkspaces((current) => {
				const latest = current.get(ownerSessionId);
				if (!latest) return current;
				let tabs = latest.tabs.filter((tab) => !removedIds.has(tab.id));
				if (!tabs.some((tab) => tab.kind === "file")) {
					tabs = [...tabs, {
						kind: "file",
						id: crypto.randomUUID(),
						title: t("Open file"),
						cwd,
						relativePath: null,
						fixed: false,
					}];
				}
				const activeId = tabs.some((tab) => tab.id === latest.activeId)
					? latest.activeId
					: ([...tabs].reverse().find((tab) => tab.kind === "file") ?? tabs.at(-1))!.id;
				const next = new Map(current).set(ownerSessionId, { ...latest, tabs, activeId });
				saveStoredFiles(ownerSessionId, cwd, tabs, expandedPaths);
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
		setWorkspaces((current) => {
			const latest = current.get(ownerSessionId);
			if (!latest) return current;
			const tabs = latest.tabs.map((tab) => {
				if (tab.kind !== "file" || !tab.relativePath || !pathIsWithin(tab.relativePath, result.previousRelativePath)) return tab;
				const relativePath = remapPath(tab.relativePath, result.previousRelativePath, result.relativePath);
				return { ...tab, relativePath, title: displayFileName(relativePath) };
			});
			const next = new Map(current).set(ownerSessionId, { ...latest, tabs });
			saveStoredFiles(ownerSessionId, cwd, tabs, expandedPaths);
			return next;
		});
	};

	const selectTab = (id: string) => {
		if (!sessionId || !workspace || workspace.activeId === id) return;
		setWorkspaces((current) => {
			const next = new Map(current);
			next.set(sessionId, { ...workspace, activeId: id });
			return next;
		});
	};

	const removeTab = (ownerSessionId: string, id: string) => {
		const closing = workspaces.get(ownerSessionId)?.tabs.find((tab) => tab.id === id);
		if (!closing) return;
		if (closing.kind === "terminal") void api.closeTerminal({ terminalId: id }).catch(onError);
		else if (closing.kind === "browser") void api.closeBrowser({ sessionId: ownerSessionId, browserId: id }).catch(onError);
		else if (closing.kind === "agent" && ownerSessionId === sessionId) store.selectAgentTranscript(null);
		setFileDrafts((current) => {
			if (!current.has(id)) return current;
			const next = new Map(current);
			next.delete(id);
			return next;
		});
		setWorkspaces((current) => {
			const next = new Map(current);
			const latest = current.get(ownerSessionId);
			if (!latest) return current;
			const index = latest.tabs.findIndex((tab) => tab.id === id);
			const remaining = latest.tabs.filter((tab) => tab.id !== id);
			if (closing.kind === "file") {
				saveStoredFiles(
					ownerSessionId,
					closing.cwd,
					remaining,
					expandedBySession.get(ownerSessionId) ?? loadStoredFiles(ownerSessionId, closing.cwd).expandedPaths,
				);
			}
			if (remaining.length === 0) next.delete(ownerSessionId);
			else next.set(ownerSessionId, {
				...latest,
				tabs: remaining,
				activeId: latest.activeId === id ? remaining[Math.min(index, remaining.length - 1)]!.id : latest.activeId,
			});
			return next;
		});
	};

	const closeTab = (id: string) => {
		if (!sessionId || !workspace) return;
		const closing = workspace.tabs.find((tab) => tab.id === id);
		if (!closing || savingFileTabIds.has(id)) return;
		const draft = closing.kind === "file" ? fileDrafts.get(id) : undefined;
		if (draft && draft.text !== draft.savedText) {
			setPendingFileClose({ sessionId, tabId: id, name: closing.title });
			return;
		}
		removeTab(sessionId, id);
	};

	const discardPendingFile = () => {
		if (!pendingFileClose) return;
		removeTab(pendingFileClose.sessionId, pendingFileClose.tabId);
		setPendingFileClose(null);
	};

	const saveAndClosePendingFile = async () => {
		if (!pendingFileClose) return;
		try {
			await saveFileTab(pendingFileClose.sessionId, pendingFileClose.tabId);
			removeTab(pendingFileClose.sessionId, pendingFileClose.tabId);
			setPendingFileClose(null);
		} catch (cause) {
			onError(cause);
		}
	};

	const updateBrowserState = (ownerSessionId: string, state: DesktopBrowserState) => {
		setWorkspaces((current) => {
			const ownerWorkspace = current.get(ownerSessionId);
			if (!ownerWorkspace) return current;
			let changed = false;
			const updatedTabs = ownerWorkspace.tabs.map((tab) => {
				if (tab.kind !== "browser" || tab.id !== state.browserId) return tab;
				changed = tab.title !== state.title || tab.url !== state.url;
				return changed ? { ...tab, title: state.title, url: state.url } : tab;
			});
			if (!changed) return current;
			const next = new Map(current);
			next.set(ownerSessionId, { ...ownerWorkspace, tabs: updatedTabs });
			return next;
		});
	};

	const toolMenu = (compact: boolean) => (
		<nav
			aria-label={t("Available tools")}
			className={compact ? "tool-add-menu" : "tool-sidebar-menu"}
			role={compact ? "menu" : undefined}
			style={compact ? menuStyle : undefined}
		>
			<button aria-label={t("Knowledge")} disabled={!activeSession} onClick={addKnowledge} role={compact ? "menuitem" : undefined} type="button">
				<div className="tool-menu-icon"><Books aria-hidden="true" size={compact ? 14 : 20} /></div>
				<span>{t("Knowledge")}</span>
			</button>
			{mode === "code" && (
				<button aria-label={t("Review")} disabled={!activeSession?.cwd} onClick={addReview} role={compact ? "menuitem" : undefined} title={activeSession?.cwd ? undefined : t("Open a task before reviewing changes")} type="button">
					<div className="tool-menu-icon"><ClipboardText aria-hidden="true" size={compact ? 14 : 20} /></div>
					<span>{t("Review")}</span>
				</button>
			)}
			<button aria-label={t("Terminal")} disabled={!activeSession?.cwd} onClick={addTerminal} role={compact ? "menuitem" : undefined} title={activeSession?.cwd ? undefined : t("Open a task before starting a terminal")} type="button">
				<div className="tool-menu-icon"><TerminalWindow aria-hidden="true" size={compact ? 14 : 20} /></div>
				<span>{t("Terminal")}</span>
			</button>
			<button aria-label={t("Browser")} disabled={!activeSession} onClick={() => addBrowser()} role={compact ? "menuitem" : undefined} title={activeSession ? undefined : t("Open a task before starting a browser")} type="button">
				<div className="tool-menu-icon"><Globe aria-hidden="true" size={compact ? 14 : 20} /></div>
				<span>{t("Browser")}</span>
			</button>
			{mode === "code" && (
				<button aria-label={t("Files")} disabled={!activeSession?.cwd} onClick={addFiles} role={compact ? "menuitem" : undefined} title={activeSession?.cwd ? undefined : t("Open a task before browsing files")} type="button">
					<div className="tool-menu-icon"><FileText aria-hidden="true" size={compact ? 14 : 20} /></div>
					<span>{t("Files")}</span>
				</button>
			)}
			{mode === "code" && (
				<button aria-label={t("Agents")} disabled={!activeSession} onClick={addAgent} role={compact ? "menuitem" : undefined} type="button">
					<div className="tool-menu-icon"><Robot aria-hidden="true" size={compact ? 14 : 20} /></div>
					<span>{t("Agents")}</span>
				</button>
			)}
		</nav>
	);

	return (
		<aside
			aria-label={t("{{mode}} tools", { mode: t(mode === "chat" ? "Chat" : "Code") })}
			className={`tool-sidebar${open ? " is-open" : ""}`}
			hidden={!open}
			style={{ width }}
		>
			<div
				aria-label={t("Resize tools sidebar")}
				aria-orientation="vertical"
				className="tool-sidebar-resizer"
				onKeyDown={(event) => {
					if (event.key === "ArrowLeft") onWidthChange(clampToolsSidebarWidth(width + 16));
					else if (event.key === "ArrowRight") onWidthChange(clampToolsSidebarWidth(width - 16));
					else return;
					event.preventDefault();
				}}
				onPointerDown={(event) => {
					resizeRef.current = { pointerId: event.pointerId, x: event.clientX, width };
					event.currentTarget.setPointerCapture(event.pointerId);
				}}
				onPointerMove={(event) => {
					const start = resizeRef.current;
					if (!start || start.pointerId !== event.pointerId) return;
					onWidthChange(clampToolsSidebarWidth(start.width + start.x - event.clientX));
				}}
				onPointerUp={(event) => {
					if (resizeRef.current?.pointerId === event.pointerId) resizeRef.current = null;
					event.currentTarget.releasePointerCapture(event.pointerId);
				}}
				role="separator"
				tabIndex={0}
			/>

			<header className={`tool-sidebar-header${tabs.length === 0 ? " is-empty" : ""}`}>
				{tabs.length > 0 && (
					<div aria-label={t("Tool tabs")} className="tool-tabbar" role="tablist">
						<div className="tool-tabs-scroll">
							{tabs.map((tab) => {
								const displayTitle = tab.kind === "browser" && tab.url === ""
									? t("New tab")
									: tab.kind === "file" && tab.relativePath === null ? t("Open file") : tab.title;
								const draft = tab.kind === "file" ? fileDrafts.get(tab.id) : undefined;
								const dirty = draft !== undefined && draft.text !== draft.savedText;
								const saving = savingFileTabIds.has(tab.id);
								return (
								<div className={`tool-tab${workspace?.activeId === tab.id ? " is-active" : ""}${tab.kind === "file" && !tab.fixed ? " is-preview" : ""}${dirty ? " is-dirty" : ""}`} key={tab.id}>
									<button
									aria-controls={tab.kind === "knowledge" ? `knowledge-panel-${sessionId}` : tab.kind === "file" ? `file-panel-${sessionId}` : tab.kind === "review" ? `review-panel-${sessionId}` : tab.kind === "agent" ? `agent-panel-${sessionId}` : `${tab.kind}-panel-${tab.id}`}
										aria-label={dirty ? `${displayTitle}, ${t("Unsaved")}` : displayTitle}
										aria-selected={workspace?.activeId === tab.id}
										className="tool-tab-select"
										onClick={() => selectTab(tab.id)}
										role="tab"
										type="button"
									>{tab.kind === "knowledge" ? <Books aria-hidden="true" size={13} /> : tab.kind === "terminal" || tab.kind === "process" ? <TerminalWindow aria-hidden="true" size={13} /> : tab.kind === "browser" ? <Globe aria-hidden="true" size={13} /> : tab.kind === "file" ? (tab.relativePath ? <WorkspaceFileIcon path={tab.relativePath} size={13} /> : <FileText aria-hidden="true" size={13} />) : tab.kind === "review" ? <ClipboardText aria-hidden="true" size={13} /> : tab.kind === "agent" ? <Robot aria-hidden="true" size={13} /> : tab.kind === "plan" ? <FileText aria-hidden="true" size={13} /> : tab.kind === "preview" ? <WorkspaceFileIcon path={tab.title} size={13} /> : null}<span>{displayTitle}</span>{dirty && <span aria-hidden="true" className="tool-tab-dirty" />}</button>
									<button aria-label={t("Close {{name}}", { name: displayTitle })} className="tool-tab-close" disabled={saving} onClick={() => closeTab(tab.id)} type="button"><X aria-hidden="true" size={11} /></button>
								</div>
								);
							})}
						</div>
						<div className="tool-add" ref={menuRef}>
							<button aria-expanded={menuOpen} aria-haspopup="menu" aria-label={t("Add tool")} className="tool-add-trigger" onClick={() => setMenuOpen((value) => !value)} type="button"><Plus aria-hidden="true" size={13} /></button>
							{menuOpen && toolMenu(true)}
						</div>
					</div>
				)}
			</header>
			{tabs.length === 0 && toolMenu(false)}
			<div className="tool-stage" hidden={tabs.length === 0}>
				{[...workspaces.entries()].flatMap(([ownerSessionId, ownerWorkspace]) => {
					const ownerFileTabs = ownerWorkspace.tabs.filter((tab): tab is FileTab => tab.kind === "file");
					const activeFileTab = ownerFileTabs.find((tab) => tab.id === ownerWorkspace.activeId);
					const dirtyPaths = ownerFileTabs.flatMap((tab) => {
						const draft = fileDrafts.get(tab.id);
						return tab.relativePath && draft && draft.text !== draft.savedText ? [tab.relativePath] : [];
					});
					const savingPaths = ownerFileTabs.flatMap((tab) =>
						tab.relativePath && savingFileTabIds.has(tab.id) ? [tab.relativePath] : [],
					);
					const panels = ownerWorkspace.tabs.flatMap((tab) =>
						tab.kind === "process" ? (
							<ProcessPanel
								key={tab.id}
								panelId={`process-panel-${tab.id}`}
								process={tab.process}
								theme={theme}
								onError={onError}
								visible={open && !menuOpen && ownerSessionId === sessionId && ownerWorkspace.activeId === tab.id}
							/>
						) : tab.kind === "terminal" ? (
							<TerminalPanel
								api={api}
								cwd={tab.cwd}
								key={tab.id}
								terminalId={tab.id}
								theme={theme}
								visible={open && !menuOpen && ownerSessionId === sessionId && ownerWorkspace.activeId === tab.id}
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
									if (selected) addBrowser(selected);
								}}
								onProfileImported={browserProfileImported}
								onState={(state) => updateBrowserState(ownerSessionId, state)}
								profile={{ profileId: tab.profileId, name: tab.profileName }}
								profiles={browserProfiles}
								visible={open && !menuOpen && ownerSessionId === sessionId && ownerWorkspace.activeId === tab.id}
							/>
						) : tab.kind === "knowledge" ? (
							<KnowledgePanel api={api} key={tab.id} sessionId={ownerSessionId} visible={open && ownerSessionId === sessionId && ownerWorkspace.activeId === tab.id} />
						) : tab.kind === "review" ? (
							<ReviewPanel
								api={api}
								key={tab.id}
								sessionId={ownerSessionId}
								theme={theme}
								visible={open && ownerSessionId === sessionId && ownerWorkspace.activeId === tab.id}
							/>
						) : tab.kind === "agent" && ownerSessionId === sessionId ? (
							<AgentTreePanel
								api={api}
								key={tab.id}
								onError={onError}
								sessionId={ownerSessionId}
								store={store}
								visible={open && ownerWorkspace.activeId === tab.id}
							/>
						) : tab.kind === "plan" ? (
							<div
								aria-labelledby={`tab-${tab.id}`}
								className="tool-panel plan-panel"
								hidden={!open || ownerSessionId !== sessionId || ownerWorkspace.activeId !== tab.id}
								id={`plan-panel-${tab.id}`}
								key={tab.id}
								role="tabpanel"
							>
								<PlanPreview plan={tab.plan} />
							</div>
						) : tab.kind === "preview" ? (
							<div
								aria-labelledby={`tab-${tab.id}`}
								className="tool-panel preview-panel"
								hidden={!open || ownerSessionId !== sessionId || ownerWorkspace.activeId !== tab.id}
								id={`preview-panel-${tab.id}`}
								key={tab.id}
								role="tabpanel"
							>
								<UniversalFilePreviewer
									active={open && ownerSessionId === sessionId && ownerWorkspace.activeId === tab.id}
									api={api}
									file={tab.file}
									onClose={() => closeTab(tab.id)}
									onError={onError}
								/>
							</div>
						) : [],
					);
					if (ownerFileTabs.length > 0) panels.push(
						<FilePanel
							activePath={activeFileTab?.relativePath ?? null}
							api={api}
							cwd={ownerFileTabs[0]!.cwd}
							draft={activeFileTab ? fileDrafts.get(activeFileTab.id) ?? null : null}
							dirtyPaths={dirtyPaths}
							expandedPaths={expandedBySession.get(ownerSessionId) ?? []}
							key={`files-${ownerSessionId}`}
							onDraftChange={(text) => { if (activeFileTab) updateFileDraft(ownerSessionId, activeFileTab.id, text); }}
							onDraftLoaded={(file) => { if (activeFileTab) loadFileDraft(activeFileTab.id, file); }}
							onError={onError}
							onExpandedPathsChange={(paths) => updateExpandedPaths(ownerSessionId, ownerFileTabs[0]!.cwd, paths)}
							onOpenFile={(relativePath, fix) => openFile(ownerSessionId, ownerFileTabs[0]!.cwd, relativePath, fix)}
							onSave={async () => { if (activeFileTab) await saveFileTab(ownerSessionId, activeFileTab.id); }}
							onWorkspaceMutation={(result) => applyWorkspaceMutation(ownerSessionId, ownerFileTabs[0]!.cwd, result)}
							saving={activeFileTab ? savingFileTabIds.has(activeFileTab.id) : false}
							savingPaths={savingPaths}
							sessionId={ownerSessionId}
							visible={open && ownerSessionId === sessionId && activeFileTab !== undefined}
						/>,
					);
					return panels;
				})}
			</div>
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
		</aside>
	);
}
