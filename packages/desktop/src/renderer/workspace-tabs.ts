import type { PlanView, SessionProcessView } from "@metis/app-protocol";
import type { DesktopBrowserHandoffReason } from "../shared/desktop-api.ts";
import type { UniversalPreviewTarget } from "./components/preview/UniversalFilePreviewer.tsx";

export interface ChatTab {
	readonly kind: "chat";
	readonly id: string;
	readonly sessionId: string | null;
}

export interface TerminalTab {
	readonly kind: "terminal";
	readonly id: string;
	readonly sessionId: string;
	readonly title: string;
	readonly cwd: string;
}

export interface BrowserTab {
	readonly kind: "browser";
	readonly id: string;
	readonly sessionId: string;
	readonly title: string;
	readonly url: string;
	readonly profileId: string;
	readonly profileName: string;
	readonly controlState: "idle" | "agent" | "handoff";
	readonly handoffReason?: DesktopBrowserHandoffReason;
}

export interface FileTab {
	readonly kind: "file";
	readonly id: string;
	readonly sessionId: string;
	readonly title: string;
	readonly cwd: string;
	readonly relativePath: string | null;
	readonly fixed: boolean;
}

export interface ReviewTab {
	readonly kind: "review";
	readonly id: string;
	readonly sessionId: string;
	readonly title: string;
}

export interface AgentTab {
	readonly kind: "agent";
	readonly id: string;
	readonly sessionId: string;
	readonly title: string;
}

export interface PlanTab {
	readonly kind: "plan";
	readonly id: string;
	readonly sessionId: string;
	readonly title: string;
	readonly plan: PlanView;
}

export interface PreviewTab {
	readonly kind: "preview";
	readonly id: string;
	readonly sessionId: string;
	readonly title: string;
	readonly file: UniversalPreviewTarget;
}

export interface ProcessTab {
	readonly kind: "process";
	readonly id: string;
	readonly sessionId: string;
	readonly title: string;
	readonly process: SessionProcessView;
}

export interface KnowledgeTab {
	readonly kind: "knowledge";
	readonly id: string;
	readonly sessionId: string;
	readonly title: string;
}

export type WorkspaceTab =
	| ChatTab
	| KnowledgeTab
	| ProcessTab
	| TerminalTab
	| BrowserTab
	| FileTab
	| ReviewTab
	| AgentTab
	| PreviewTab
	| PlanTab;

export interface WorkspacePane {
	readonly id: string;
	readonly tabs: readonly WorkspaceTab[];
	readonly activeId: string;
}

export interface SessionWorkspace {
	readonly panes: readonly WorkspacePane[];
	readonly activePaneId: string;
	readonly nextNumber: number;
}

export function chatTab(sessionId: string | null): ChatTab {
	return { kind: "chat", id: `chat-${crypto.randomUUID()}`, sessionId };
}

export function defaultWorkspace(): SessionWorkspace {
	const paneId = "pane-1";
	return {
		panes: [{ id: paneId, tabs: [], activeId: "" }],
		activePaneId: paneId,
		nextNumber: 1,
	};
}

export function findChatTab(workspace: SessionWorkspace, sessionId: string | null): ChatTab | undefined {
	return workspaceTabs(workspace).find((tab): tab is ChatTab => tab.kind === "chat" && tab.sessionId === sessionId);
}

export function focusedChatTab(workspace: SessionWorkspace): ChatTab | undefined {
	const pane = activePane(workspace);
	const tab = pane.tabs.find((candidate) => candidate.id === pane.activeId);
	return tab?.kind === "chat" ? tab : undefined;
}

export function workspaceTabs(workspace: SessionWorkspace): readonly WorkspaceTab[] {
	return workspace.panes.flatMap((pane) => pane.tabs);
}

export interface TabLocation {
	readonly paneIndex: number;
	readonly tabIndex: number;
}

export function findTabLocation(workspace: SessionWorkspace, tabId: string): TabLocation | null {
	for (let paneIndex = 0; paneIndex < workspace.panes.length; paneIndex += 1) {
		const tabIndex = workspace.panes[paneIndex]!.tabs.findIndex((tab) => tab.id === tabId);
		if (tabIndex >= 0) return { paneIndex, tabIndex };
	}
	return null;
}

export function activePane(workspace: SessionWorkspace): WorkspacePane {
	return workspace.panes.find((pane) => pane.id === workspace.activePaneId) ?? workspace.panes[0]!;
}

export function paneForTab(workspace: SessionWorkspace, tabId: string): WorkspacePane | undefined {
	return workspace.panes.find((pane) => pane.tabs.some((tab) => tab.id === tabId));
}

function collapseEmptyPanes(workspace: SessionWorkspace): SessionWorkspace {
	const nonEmpty = workspace.panes.filter((pane) => pane.tabs.length > 0);
	const panes = nonEmpty.length > 0 ? nonEmpty : [workspace.panes[0]!];
	const activePaneId = panes.some((pane) => pane.id === workspace.activePaneId)
		? workspace.activePaneId
		: panes.at(-1)!.id;
	return { ...workspace, panes, activePaneId };
}

export function setActivePane(workspace: SessionWorkspace, paneId: string): SessionWorkspace {
	if (!workspace.panes.some((pane) => pane.id === paneId) || workspace.activePaneId === paneId) return workspace;
	return { ...workspace, activePaneId: paneId };
}

export function activateTab(workspace: SessionWorkspace, tabId: string): SessionWorkspace {
	const location = findTabLocation(workspace, tabId);
	if (!location) return workspace;
	const pane = workspace.panes[location.paneIndex]!;
	if (pane.activeId === tabId && workspace.activePaneId === pane.id) return workspace;
	const panes = workspace.panes.map((candidate, index) =>
		index === location.paneIndex ? { ...candidate, activeId: tabId } : candidate,
	);
	return { ...workspace, panes, activePaneId: pane.id };
}

export function addTab(
	workspace: SessionWorkspace,
	tab: WorkspaceTab,
	paneId = workspace.activePaneId,
	activate = true,
): SessionWorkspace {
	const paneIndex = workspace.panes.findIndex((pane) => pane.id === paneId);
	if (paneIndex < 0) return workspace;
	const panes = workspace.panes.map((pane, index) =>
		index === paneIndex ? { ...pane, tabs: [...pane.tabs, tab], activeId: activate ? tab.id : pane.activeId } : pane,
	);
	return { ...workspace, panes, activePaneId: activate ? paneId : workspace.activePaneId };
}

export function removeTab(workspace: SessionWorkspace, tabId: string): SessionWorkspace {
	const location = findTabLocation(workspace, tabId);
	if (!location) return workspace;
	const pane = workspace.panes[location.paneIndex]!;
	const remaining = pane.tabs.filter((tab) => tab.id !== tabId);
	const activeId =
		pane.activeId === tabId
			? (remaining[Math.min(location.tabIndex, remaining.length - 1)]?.id ?? "")
			: pane.activeId;
	const panes = workspace.panes.map((candidate, index) =>
		index === location.paneIndex ? { ...candidate, tabs: remaining, activeId } : candidate,
	);
	return collapseEmptyPanes({ ...workspace, panes });
}

export function mapTabs(
	workspace: SessionWorkspace,
	update: (tab: WorkspaceTab) => WorkspaceTab | null,
): SessionWorkspace {
	const panes = workspace.panes.map((pane) => {
		const tabs = pane.tabs.flatMap((tab) => {
			const next = update(tab);
			return next === null ? [] : [next];
		});
		const activeId = tabs.some((tab) => tab.id === pane.activeId) ? pane.activeId : (tabs.at(-1)?.id ?? "");
		return { ...pane, tabs, activeId };
	});
	return collapseEmptyPanes({ ...workspace, panes });
}

export function moveTab(
	workspace: SessionWorkspace,
	tabId: string,
	targetPaneId: string,
	index?: number,
): SessionWorkspace {
	const location = findTabLocation(workspace, tabId);
	const targetIndex = workspace.panes.findIndex((pane) => pane.id === targetPaneId);
	if (!location || targetIndex < 0) return workspace;
	const source = workspace.panes[location.paneIndex]!;
	const tab = source.tabs[location.tabIndex]!;
	const panes = workspace.panes.map((pane, paneIndex) => {
		if (paneIndex === location.paneIndex && paneIndex === targetIndex) {
			const without = pane.tabs.filter((candidate) => candidate.id !== tabId);
			const insertAt = index === undefined ? without.length : Math.min(Math.max(index, 0), without.length);
			const tabs = [...without.slice(0, insertAt), tab, ...without.slice(insertAt)];
			return { ...pane, tabs, activeId: tabId };
		}
		if (paneIndex === location.paneIndex) {
			const without = pane.tabs.filter((candidate) => candidate.id !== tabId);
			const activeId = pane.activeId === tabId ? (without.at(-1)?.id ?? "") : pane.activeId;
			return { ...pane, tabs: without, activeId };
		}
		if (paneIndex === targetIndex) {
			const insertAt = index === undefined ? pane.tabs.length : Math.min(Math.max(index, 0), pane.tabs.length);
			const tabs = [...pane.tabs.slice(0, insertAt), tab, ...pane.tabs.slice(insertAt)];
			return { ...pane, tabs, activeId: tabId };
		}
		return pane;
	});
	return collapseEmptyPanes({ ...workspace, panes, activePaneId: targetPaneId });
}

export function splitTabRight(workspace: SessionWorkspace, tabId: string): SessionWorkspace {
	const location = findTabLocation(workspace, tabId);
	if (!location) return workspace;
	return splitTabBeside(workspace, tabId, workspace.panes[location.paneIndex]!.id);
}

export function splitTabBeside(workspace: SessionWorkspace, tabId: string, besidePaneId: string): SessionWorkspace {
	const location = findTabLocation(workspace, tabId);
	const besideIndex = workspace.panes.findIndex((pane) => pane.id === besidePaneId);
	if (!location || besideIndex < 0) return workspace;
	const paneId = `pane-${crypto.randomUUID()}`;
	const tab = workspace.panes[location.paneIndex]!.tabs[location.tabIndex]!;
	const panes = workspace.panes.flatMap((pane, index) => {
		if (index === location.paneIndex) {
			const without = pane.tabs.filter((candidate) => candidate.id !== tabId);
			const activeId = pane.activeId === tabId ? (without.at(-1)?.id ?? "") : pane.activeId;
			const source = { ...pane, tabs: without, activeId };
			return index === besideIndex ? [source, { id: paneId, tabs: [tab], activeId: tabId }] : [source];
		}
		if (index === besideIndex) {
			return [pane, { id: paneId, tabs: [tab], activeId: tabId }];
		}
		return [pane];
	});
	return collapseEmptyPanes({ ...workspace, panes, activePaneId: paneId });
}

export function removeTabs(workspace: SessionWorkspace, tabIds: ReadonlySet<string>): SessionWorkspace {
	let next = workspace;
	for (const id of tabIds) next = removeTab(next, id);
	return next;
}
