import type { PlanView, SessionProcessView } from "@metis/app-protocol";
import type { DesktopBrowserHandoffReason } from "../shared/desktop-api.ts";
import type { UniversalPreviewTarget } from "./components/preview/preview-kinds.ts";

export interface ChatTab {
	readonly kind: "chat";
	readonly id: string;
	readonly sessionId: string | null;
	readonly agentId?: string;
	readonly agentName?: string;
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

export const MAX_ROW_PANES = 3;
export type SplitDirection = "left" | "right" | "up" | "down";

export interface WorkspacePane {
	readonly id: string;
	readonly row: 0 | 1;
	/** Chat tabs only; tool tabs live in `tools` keyed by their session. */
	readonly tabs: readonly WorkspaceTab[];
	readonly activeId: string;
	/** Project groups whose tabs this pane's strip folds behind their label. */
	readonly collapsedGroups?: readonly string[];
	/** Preferred share of the pane's row; positive finite, siblings may normalize it to sum 1. */
	readonly weight?: number;
	/** Explicit empty split source awaiting session selection; cleared once tabs land in it. */
	readonly placeholder?: boolean;
}

/** One session's tool tabs (terminal, files, …) shown in the tools sidebar. */
export interface ToolStrip {
	readonly tabs: readonly WorkspaceTab[];
	readonly activeId: string;
}

export interface SessionWorkspace {
	readonly panes: readonly WorkspacePane[];
	readonly activePaneId: string;
	readonly nextNumber: number;
	/** Tool tabs keyed by owning sessionId. */
	readonly tools: ReadonlyMap<string, ToolStrip>;
	/** Preferred share of the top and bottom rows; positive finite, may be normalized to sum 1. */
	readonly rowWeights?: readonly [number, number];
}

export function chatTab(sessionId: string | null): ChatTab {
	return { kind: "chat", id: `chat-${crypto.randomUUID()}`, sessionId };
}

export function defaultWorkspace(): SessionWorkspace {
	const paneId = "pane-1";
	return {
		panes: [{ id: paneId, row: 0, tabs: [], activeId: "" }],
		activePaneId: paneId,
		nextNumber: 1,
		tools: new Map(),
	};
}

export function findChatTab(
	workspace: SessionWorkspace,
	sessionId: string | null,
	agentId?: string,
): ChatTab | undefined {
	return workspaceTabs(workspace).find(
		(tab): tab is ChatTab => tab.kind === "chat" && tab.sessionId === sessionId && tab.agentId === agentId,
	);
}

export function focusedChatTab(workspace: SessionWorkspace): ChatTab | undefined {
	const pane = activePane(workspace);
	const tab = pane.tabs.find((candidate) => candidate.id === pane.activeId);
	return tab?.kind === "chat" ? tab : undefined;
}

export function workspaceTabs(workspace: SessionWorkspace): readonly WorkspaceTab[] {
	return [
		...workspace.panes.flatMap((pane) => pane.tabs),
		...[...workspace.tools.values()].flatMap((strip) => strip.tabs),
	];
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

export interface ToolTabLocation {
	readonly sessionId: string;
	readonly tabIndex: number;
}

/** Where a tool tab sits in its session's sidebar strip. */
export function findToolLocation(workspace: SessionWorkspace, tabId: string): ToolTabLocation | null {
	for (const [sessionId, strip] of workspace.tools) {
		const tabIndex = strip.tabs.findIndex((tab) => tab.id === tabId);
		if (tabIndex >= 0) return { sessionId, tabIndex };
	}
	return null;
}

/** The tool strip of one session, always defined so callers can append freely. */
export function toolStripOf(workspace: SessionWorkspace, sessionId: string): ToolStrip {
	return workspace.tools.get(sessionId) ?? { tabs: [], activeId: "" };
}

function updateToolStrip(
	workspace: SessionWorkspace,
	sessionId: string,
	update: (strip: ToolStrip) => ToolStrip,
): SessionWorkspace {
	const strip = update(toolStripOf(workspace, sessionId));
	const tools = new Map(workspace.tools);
	if (strip.tabs.length === 0) tools.delete(sessionId);
	else tools.set(sessionId, strip);
	return { ...workspace, tools };
}

export function activePane(workspace: SessionWorkspace): WorkspacePane {
	return workspace.panes.find((pane) => pane.id === workspace.activePaneId) ?? workspace.panes[0]!;
}

function collapseEmptyPanes(workspace: SessionWorkspace): SessionWorkspace {
	// Placeholder panes are explicit empty splits kept for session selection; they survive collapse.
	const nonEmpty = workspace.panes.filter((pane) => pane.tabs.length > 0 || pane.placeholder === true);
	const kept = nonEmpty.length > 0 ? nonEmpty : [workspace.panes[0]!];
	const panes = kept.some((pane) => pane.row === 0) ? kept : kept.map((pane) => ({ ...pane, row: 0 as const }));
	const activePaneId = panes.some((pane) => pane.id === workspace.activePaneId)
		? workspace.activePaneId
		: panes.at(-1)!.id;
	// Row weights are meaningless once a single row remains.
	const next: SessionWorkspace = { ...workspace, panes, activePaneId };
	if (!panes.some((pane) => pane.row === 1)) {
		const { rowWeights: _dropped, ...rest } = next;
		return rest;
	}
	return next;
}

function positiveFinite(value: number | undefined): value is number {
	return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** Applies preferred pane weights within one row, normalizing valid entries to sum 1. */
export function setPaneWeights(
	workspace: SessionWorkspace,
	row: 0 | 1,
	weightsById: ReadonlyMap<string, number>,
): SessionWorkspace {
	const applied = new Map<string, number>();
	for (const pane of workspace.panes) {
		if (pane.row !== row) continue;
		const weight = weightsById.get(pane.id);
		if (positiveFinite(weight)) applied.set(pane.id, weight);
	}
	if (applied.size === 0) return workspace;
	const maximum = Math.max(...applied.values());
	const total = [...applied.values()].reduce((sum, weight) => sum + weight / maximum, 0);
	const panes = workspace.panes.map((pane) => {
		const weight = applied.get(pane.id);
		return weight === undefined ? pane : { ...pane, weight: weight / maximum / total };
	});
	return { ...workspace, panes };
}

/** Applies preferred row weights, normalizing the pair to sum 1; invalid input is a no-op. */
export function setRowWeights(workspace: SessionWorkspace, weights: readonly number[]): SessionWorkspace {
	if (weights.length !== 2 || !weights.every((weight) => positiveFinite(weight))) return workspace;
	const maximum = Math.max(weights[0]!, weights[1]!);
	const first = weights[0]! / maximum;
	const second = weights[1]! / maximum;
	const total = first + second;
	return { ...workspace, rowWeights: [first / total, second / total] };
}

/** Closes one pane, but only while it holds no tabs (e.g. an explicit empty split placeholder). */
export function closeEmptyPane(workspace: SessionWorkspace, paneId: string): SessionWorkspace {
	const pane = workspace.panes.find((candidate) => candidate.id === paneId);
	if (!pane || pane.tabs.length > 0) return workspace;
	const remaining = workspace.panes.filter((candidate) => candidate.id !== paneId);
	if (remaining.length === 0) return workspace;
	return collapseEmptyPanes({ ...workspace, panes: remaining });
}

export function setActivePane(workspace: SessionWorkspace, paneId: string): SessionWorkspace {
	if (!workspace.panes.some((pane) => pane.id === paneId) || workspace.activePaneId === paneId) return workspace;
	return { ...workspace, activePaneId: paneId };
}

export function activateTab(workspace: SessionWorkspace, tabId: string): SessionWorkspace {
	const location = findTabLocation(workspace, tabId);
	if (!location) {
		const tool = findToolLocation(workspace, tabId);
		if (!tool) return workspace;
		return updateToolStrip(workspace, tool.sessionId, (strip) =>
			strip.activeId === tabId ? strip : { ...strip, activeId: tabId },
		);
	}
	const pane = workspace.panes[location.paneIndex]!;
	if (pane.activeId === tabId && workspace.activePaneId === pane.id) return workspace;
	const panes = workspace.panes.map((candidate, index) =>
		index === location.paneIndex ? { ...candidate, activeId: tabId } : candidate,
	);
	return { ...workspace, panes, activePaneId: pane.id };
}

/** Brings a tab to the front of its own pane without moving focus to that pane. */
export function revealTab(workspace: SessionWorkspace, tabId: string): SessionWorkspace {
	const location = findTabLocation(workspace, tabId);
	if (!location) return activateTab(workspace, tabId);
	if (workspace.panes[location.paneIndex]!.activeId === tabId) return workspace;
	const panes = workspace.panes.map((pane, index) =>
		index === location.paneIndex ? { ...pane, activeId: tabId } : pane,
	);
	return { ...workspace, panes };
}

export function addTab(
	workspace: SessionWorkspace,
	tab: WorkspaceTab,
	paneId = workspace.activePaneId,
	activate = true,
	index?: number,
): SessionWorkspace {
	if (tab.kind !== "chat") {
		// Tools live in their session's sidebar strip regardless of the pane hint.
		return updateToolStrip(workspace, tab.sessionId, (strip) => ({
			tabs: [...strip.tabs, tab],
			activeId: activate || strip.activeId === "" ? tab.id : strip.activeId,
		}));
	}
	const paneIndex = workspace.panes.findIndex((pane) => pane.id === paneId);
	if (paneIndex < 0) return workspace;
	const panes = workspace.panes.map((pane, current) => {
		if (current !== paneIndex) return pane;
		const at = index === undefined ? pane.tabs.length : Math.min(Math.max(index, 0), pane.tabs.length);
		const tabs = [...pane.tabs.slice(0, at), tab, ...pane.tabs.slice(at)];
		// Landing content in a placeholder pane turns it back into a normal pane.
		return pane.placeholder
			? { ...pane, tabs, activeId: activate ? tab.id : pane.activeId, placeholder: false }
			: { ...pane, tabs, activeId: activate ? tab.id : pane.activeId };
	});
	return { ...workspace, panes, activePaneId: activate ? paneId : workspace.activePaneId };
}

/** Reorders a tool tab inside its own session strip (sidebar drag). */
export function moveToolTab(workspace: SessionWorkspace, tabId: string, index: number): SessionWorkspace {
	const location = findToolLocation(workspace, tabId);
	if (!location) return workspace;
	return updateToolStrip(workspace, location.sessionId, (strip) => {
		const without = strip.tabs.filter((candidate) => candidate.id !== tabId);
		const at = Math.min(Math.max(index, 0), without.length);
		const tabs = [...without.slice(0, at), strip.tabs[location.tabIndex]!, ...without.slice(at)];
		return { ...strip, tabs, activeId: tabId };
	});
}

/**
 * Where a new tab joins a pane: after the last tab of its own session, else after the last tab of
 * its group (project), else at the end. Keeping related tabs adjacent lets the strip label each group once.
 */
export function relatedInsertIndex(
	pane: WorkspacePane,
	tab: WorkspaceTab,
	groupOf: (tab: WorkspaceTab) => string | null,
): number {
	const afterLast = (matches: (candidate: WorkspaceTab) => boolean): number | null => {
		for (let index = pane.tabs.length - 1; index >= 0; index -= 1) {
			if (matches(pane.tabs[index]!)) return index + 1;
		}
		return null;
	};
	const group = groupOf(tab);
	return (
		(tab.sessionId === null ? null : afterLast((candidate) => candidate.sessionId === tab.sessionId)) ??
		(group === null ? null : afterLast((candidate) => groupOf(candidate) === group)) ??
		pane.tabs.length
	);
}

/** Splits a strip into runs of adjacent tabs that share a group, for rendering one label per run. */
export function tabGroupRuns<T>(
	tabs: readonly WorkspaceTab[],
	groupOf: (tab: WorkspaceTab) => T | null,
	keyOf: (group: T) => string,
): { readonly group: T | null; readonly tabs: readonly WorkspaceTab[] }[] {
	const runs: { group: T | null; tabs: WorkspaceTab[] }[] = [];
	for (const tab of tabs) {
		const group = groupOf(tab);
		const last = runs.at(-1);
		const sameGroup =
			last !== undefined &&
			(last.group === null || group === null ? last.group === group : keyOf(last.group) === keyOf(group));
		if (sameGroup) last.tabs.push(tab);
		else runs.push({ group, tabs: [tab] });
	}
	return runs;
}

/**
 * Keeps every project's tabs adjacent in each pane (groups in order of first appearance, ungrouped tabs
 * last) so a strip labels each project once, and drops collapse marks that no longer apply: groups with no
 * tabs left, the active tab's group, and every group of a pane that holds a single project.
 */
export function normalizeTabGroups(
	workspace: SessionWorkspace,
	groupOf: (tab: WorkspaceTab) => string | null,
): SessionWorkspace {
	let changed = false;
	const panes = workspace.panes.map((pane) => {
		const groups = new Map<string, WorkspaceTab[]>();
		const ungrouped: WorkspaceTab[] = [];
		for (const tab of pane.tabs) {
			const key = groupOf(tab);
			if (key === null) ungrouped.push(tab);
			else groups.set(key, [...(groups.get(key) ?? []), tab]);
		}
		const ordered = [...[...groups.values()].flat(), ...ungrouped];
		const reordered = ordered.some((tab, index) => tab !== pane.tabs[index]);
		const activeTab = pane.tabs.find((tab) => tab.id === pane.activeId);
		const activeGroup = activeTab ? groupOf(activeTab) : null;
		const collapsed =
			groups.size < 2 ? [] : (pane.collapsedGroups ?? []).filter((key) => groups.has(key) && key !== activeGroup);
		const pruned = collapsed.length !== (pane.collapsedGroups?.length ?? 0);
		if (!reordered && !pruned) return pane;
		changed = true;
		return {
			...pane,
			tabs: reordered ? ordered : pane.tabs,
			collapsedGroups: collapsed.length > 0 ? collapsed : undefined,
		};
	});
	return changed ? { ...workspace, panes } : workspace;
}

/** Tabs a pane's strip folds away: those of collapsed groups, never the active tab's group. */
export function collapsedTabIds(
	pane: WorkspacePane,
	groupOf: (tab: WorkspaceTab) => string | null,
): ReadonlySet<string> {
	const collapsed = new Set(pane.collapsedGroups ?? []);
	if (collapsed.size === 0) return new Set();
	const activeTab = pane.tabs.find((tab) => tab.id === pane.activeId);
	const activeGroup = activeTab ? groupOf(activeTab) : null;
	return new Set(
		pane.tabs.flatMap((tab) => {
			const key = groupOf(tab);
			return key !== null && key !== activeGroup && collapsed.has(key) ? [tab.id] : [];
		}),
	);
}

/**
 * Collapses or expands a project group in one pane. Collapsing the active tab's group activates the nearest
 * tab outside it, like a browser; a group that holds every tab of the pane stays open.
 */
export function toggleTabGroup(
	workspace: SessionWorkspace,
	paneId: string,
	key: string,
	groupOf: (tab: WorkspaceTab) => string | null,
): SessionWorkspace {
	const pane = workspace.panes.find((candidate) => candidate.id === paneId);
	if (!pane || !pane.tabs.some((tab) => groupOf(tab) === key)) return workspace;
	const collapsed = pane.collapsedGroups ?? [];
	let next: WorkspacePane;
	if (collapsed.includes(key)) {
		const remaining = collapsed.filter((candidate) => candidate !== key);
		next = { ...pane, collapsedGroups: remaining.length > 0 ? remaining : undefined };
	} else {
		let activeId = pane.activeId;
		const activeIndex = pane.tabs.findIndex((tab) => tab.id === activeId);
		if (activeIndex >= 0 && groupOf(pane.tabs[activeIndex]!) === key) {
			const outside = (tab: WorkspaceTab) => groupOf(tab) !== key;
			const replacement =
				pane.tabs.slice(activeIndex + 1).find(outside) ?? pane.tabs.slice(0, activeIndex).reverse().find(outside);
			if (!replacement) return workspace;
			activeId = replacement.id;
		}
		next = { ...pane, activeId, collapsedGroups: [...collapsed, key] };
	}
	const panes = workspace.panes.map((candidate) => (candidate.id === paneId ? next : candidate));
	return { ...workspace, panes, activePaneId: paneId };
}

/**
 * Moves every tab of a project group from one pane to an index of another (or the same) pane. The index
 * counts the target pane's tabs before the move; a collapsed group stays collapsed where it lands.
 */
export function moveTabGroup(
	workspace: SessionWorkspace,
	paneId: string,
	key: string,
	groupOf: (tab: WorkspaceTab) => string | null,
	targetPaneId: string,
	index: number,
): SessionWorkspace {
	const source = workspace.panes.find((pane) => pane.id === paneId);
	const target = workspace.panes.find((pane) => pane.id === targetPaneId);
	if (!source || !target) return workspace;
	const moving = source.tabs.filter((tab) => groupOf(tab) === key);
	if (moving.length === 0) return workspace;
	const movingIds = new Set(moving.map((tab) => tab.id));
	const carriesActive = movingIds.has(source.activeId);
	const wasCollapsed = source.collapsedGroups?.includes(key) ?? false;
	const panes = workspace.panes.map((pane) => {
		if (pane.id !== source.id && pane.id !== target.id) return pane;
		const remaining = pane.tabs.filter((tab) => !movingIds.has(tab.id));
		if (pane.id === target.id) {
			const movedBefore =
				pane.id === source.id ? pane.tabs.slice(0, index).filter((tab) => movingIds.has(tab.id)).length : 0;
			const at = Math.min(Math.max(index - movedBefore, 0), remaining.length);
			const collapsedGroups =
				pane.id !== source.id && wasCollapsed && !carriesActive
					? [...(pane.collapsedGroups ?? []).filter((candidate) => candidate !== key), key]
					: pane.collapsedGroups;
			const tabs = [...remaining.slice(0, at), ...moving, ...remaining.slice(at)];
			// A group landing in a placeholder pane fills it with real content.
			const filled = pane.placeholder ? { placeholder: false } : {};
			return {
				...pane,
				tabs,
				activeId: carriesActive ? source.activeId : pane.activeId,
				collapsedGroups,
				...filled,
			};
		}
		const collapsedGroups = pane.collapsedGroups?.filter((candidate) => candidate !== key);
		return {
			...pane,
			tabs: remaining,
			activeId: carriesActive ? (remaining.at(-1)?.id ?? "") : pane.activeId,
			collapsedGroups: collapsedGroups && collapsedGroups.length > 0 ? collapsedGroups : undefined,
		};
	});
	return collapseEmptyPanes({ ...workspace, panes, activePaneId: target.id });
}

export function removeTab(workspace: SessionWorkspace, tabId: string): SessionWorkspace {
	const location = findTabLocation(workspace, tabId);
	if (!location) {
		const tool = findToolLocation(workspace, tabId);
		if (!tool) return workspace;
		return updateToolStrip(workspace, tool.sessionId, (strip) => {
			const remaining = strip.tabs.filter((tab) => tab.id !== tabId);
			const activeId =
				strip.activeId === tabId
					? (remaining[Math.min(tool.tabIndex, remaining.length - 1)]?.id ?? "")
					: strip.activeId;
			return { ...strip, tabs: remaining, activeId };
		});
	}
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
	const apply = (tabs: readonly WorkspaceTab[]) =>
		tabs.flatMap((tab) => {
			const next = update(tab);
			return next === null ? [] : [next];
		});
	const panes = workspace.panes.map((pane) => {
		const tabs = apply(pane.tabs);
		const activeId = tabs.some((tab) => tab.id === pane.activeId) ? pane.activeId : (tabs.at(-1)?.id ?? "");
		return { ...pane, tabs, activeId };
	});
	const tools = new Map(
		[...workspace.tools].flatMap(([sessionId, strip]) => {
			const tabs = apply(strip.tabs);
			if (tabs.length === 0) return [];
			const activeId = tabs.some((tab) => tab.id === strip.activeId) ? strip.activeId : (tabs.at(-1)?.id ?? "");
			return [[sessionId, { tabs, activeId }]];
		}),
	);
	return collapseEmptyPanes({ ...workspace, panes, tools });
}

export function moveTab(
	workspace: SessionWorkspace,
	tabId: string,
	targetPaneId: string,
	index?: number,
): SessionWorkspace {
	// Tool tabs only reorder inside their own strip; they never enter a pane.
	const location = findTabLocation(workspace, tabId);
	if (location === null) return moveToolTab(workspace, tabId, index ?? Number.MAX_SAFE_INTEGER);
	const targetIndex = workspace.panes.findIndex((pane) => pane.id === targetPaneId);
	if (!location || targetIndex < 0) return workspace;
	const source = workspace.panes[location.paneIndex]!;
	const tab = source.tabs[location.tabIndex]!;
	const panes = workspace.panes.map((pane, paneIndex) => {
		if (paneIndex === location.paneIndex && paneIndex === targetIndex) {
			const without = pane.tabs.filter((candidate) => candidate.id !== tabId);
			const insertAt = index === undefined ? without.length : Math.min(Math.max(index, 0), without.length);
			const tabs = [...without.slice(0, insertAt), tab, ...without.slice(insertAt)];
			return pane.placeholder
				? { ...pane, tabs, activeId: tabId, placeholder: false }
				: { ...pane, tabs, activeId: tabId };
		}
		if (paneIndex === location.paneIndex) {
			const without = pane.tabs.filter((candidate) => candidate.id !== tabId);
			const activeId = pane.activeId === tabId ? (without.at(-1)?.id ?? "") : pane.activeId;
			return { ...pane, tabs: without, activeId };
		}
		if (paneIndex === targetIndex) {
			const insertAt = index === undefined ? pane.tabs.length : Math.min(Math.max(index, 0), pane.tabs.length);
			const tabs = [...pane.tabs.slice(0, insertAt), tab, ...pane.tabs.slice(insertAt)];
			return pane.placeholder
				? { ...pane, tabs, activeId: tabId, placeholder: false }
				: { ...pane, tabs, activeId: tabId };
		}
		return pane;
	});
	return collapseEmptyPanes({ ...workspace, panes, activePaneId: targetPaneId });
}

export type SplitLimitReason = "missing-pane" | "pane-limit" | "row-limit" | "column-limit";

/** Why a split would be refused, or null when it fits the 2-row × 3-column grid. */
export function getSplitLimitReason(
	workspace: SessionWorkspace,
	targetPaneId: string,
	direction: SplitDirection,
): SplitLimitReason | null {
	const target = workspace.panes.find((pane) => pane.id === targetPaneId);
	if (!target) return "missing-pane";
	if (workspace.panes.length >= MAX_ROW_PANES * 2) return "pane-limit";
	if (direction === "left" || direction === "right") {
		return workspace.panes.filter((pane) => pane.row === target.row).length >= MAX_ROW_PANES ? "column-limit" : null;
	}
	if (target.row !== (direction === "down" ? 0 : 1)) return "row-limit";
	const otherRow = direction === "down" ? 1 : 0;
	return workspace.panes.filter((pane) => pane.row === otherRow).length >= MAX_ROW_PANES ? "row-limit" : null;
}

export function canSplit(workspace: SessionWorkspace, targetPaneId: string, direction: SplitDirection): boolean {
	return getSplitLimitReason(workspace, targetPaneId, direction) === null;
}

export function splitTab(
	workspace: SessionWorkspace,
	tabId: string,
	targetPaneId: string,
	direction: SplitDirection,
): SessionWorkspace {
	const location = findTabLocation(workspace, tabId);
	const targetIndex = workspace.panes.findIndex((pane) => pane.id === targetPaneId);
	if (!location || targetIndex < 0 || !canSplit(workspace, targetPaneId, direction)) return workspace;
	const target = workspace.panes[targetIndex]!;
	const source = workspace.panes[location.paneIndex]!;
	const tab = source.tabs[location.tabIndex]!;
	const without = source.tabs.filter((candidate) => candidate.id !== tabId);
	const sourceActiveId = source.activeId === tabId ? (without.at(-1)?.id ?? "") : source.activeId;
	const paneId = `pane-${crypto.randomUUID()}`;
	const row: 0 | 1 = direction === "down" ? 1 : direction === "up" ? 0 : target.row;
	// Horizontal splits share the target's existing width; moving a tab from elsewhere must not
	// resize its source. Missing weights use the same equal-share default as the renderer.
	const targetWeight = positiveFinite(target.weight) ? target.weight : 1;
	const splitWeight = row === target.row ? { weight: targetWeight / 2 } : {};
	// Opening the second row seeds balanced row weights unless a preference already exists.
	const rowWeights =
		row !== target.row && !workspace.panes.some((pane) => pane.row === row)
			? (workspace.rowWeights ?? [1, 1])
			: workspace.rowWeights;
	const targetColumn = workspace.panes.slice(0, targetIndex + 1).filter((pane) => pane.row === target.row).length - 1;
	let insertIndex: number;
	if (direction === "right") insertIndex = targetIndex + 1;
	else if (direction === "left") insertIndex = targetIndex;
	else if (direction === "down") {
		const rowPanes = workspace.panes.filter((pane) => pane.row === 1);
		const firstRowIndex = workspace.panes.findIndex((pane) => pane.row === 1);
		insertIndex =
			(firstRowIndex < 0 ? workspace.panes.length : firstRowIndex) + Math.min(targetColumn, rowPanes.length);
	} else {
		const rowPanes = workspace.panes.filter((pane) => pane.row === 0);
		insertIndex = Math.min(targetColumn, rowPanes.length);
	}
	const panes = [
		...workspace.panes.slice(0, insertIndex),
		{ id: paneId, row, tabs: [tab], activeId: tabId, ...splitWeight },
		...workspace.panes.slice(insertIndex),
	].map((pane) => {
		const next = pane.id === target.id ? { ...pane, ...splitWeight } : pane;
		if (pane.id !== source.id) return next;
		// Splitting a pane's sole tab leaves the source as an explicit empty placeholder.
		if (without.length === 0) return { ...next, tabs: without, activeId: "", placeholder: true };
		return { ...next, tabs: without, activeId: sourceActiveId };
	});
	const collapsed = collapseEmptyPanes({ ...workspace, panes, activePaneId: paneId });
	return rowWeights === undefined ? collapsed : { ...collapsed, rowWeights };
}

export function removeTabs(workspace: SessionWorkspace, tabIds: ReadonlySet<string>): SessionWorkspace {
	let next = workspace;
	for (const id of tabIds) next = removeTab(next, id);
	return next;
}
