import type { AgentSummaryView } from "@metis/app-protocol";
import { CaretDown, CaretRight, WarningCircle } from "@phosphor-icons/react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import type { AgentConversationTarget } from "../conversation-target.ts";
import { useAgentCatalog } from "../hooks/use-agent-catalog.ts";
import { agentIndicator, type SessionIndicator } from "../session-view-utils.ts";
import { type AgentTreeNode, buildAgentTree } from "./AgentTreePanel.tsx";
import { SessionStatusIndicator } from "./SessionStatusIndicator.tsx";

export interface AgentSidebarNavigation {
	readonly api: MetisDesktopApi;
	readonly active: AgentConversationTarget | null;
	readonly attentionAgentIds?: ReadonlySet<string>;
	readonly onOpen: (target: AgentConversationTarget) => void;
}

function readPreference(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}
function savePreference(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		/* Navigation still works when storage is full. */
	}
}

function readCollapsed(key: string): ReadonlySet<string> {
	try {
		const stored: unknown = JSON.parse(readPreference(key) ?? "[]");
		return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : []);
	} catch {
		return new Set();
	}
}

function agentStatusLabel(agent: AgentSummaryView): string {
	if (agent.runControl === "user_paused") return "Paused";
	if (agent.runControl === "interrupted") return "Stopped";
	return { queued: "Queued", running: "Running", done: "Completed", failed: "Failed", stopped: "Stopped" }[
		agent.status
	];
}

export function AgentSidebarBranch({
	children,
	sessionId,
	navigation,
}: {
	readonly children: (toggle: ReactNode) => ReactNode;
	readonly sessionId: string;
	readonly navigation: AgentSidebarNavigation;
}) {
	const { t } = useTranslation();
	const { agents, error, loading, reload, unreadableAgentCount } = useAgentCatalog(navigation.api, sessionId);
	const storageKey = `metis.agent-tree.${sessionId}`;
	const [open, setOpen] = useState(() => readPreference(storageKey) !== "closed");
	const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => readCollapsed(`${storageKey}.collapsed`));
	const [seen, setSeen] = useState<ReadonlyMap<string, string>>(new Map());
	const [focused, setFocused] = useState<string | null>(null);
	const buttons = useRef(new Map<string, HTMLButtonElement>());
	const tree = useMemo(() => buildAgentTree(agents, sessionId), [agents, sessionId]);
	const activeId = navigation.active?.sessionId === sessionId ? navigation.active.agentId : null;
	const active = agents.find((agent) => agent.agentId === activeId);
	useEffect(() => {
		if (!active) return;
		savePreference(`metis.agent-seen.${active.agentId}`, active.updatedAt);
		setSeen((old) => new Map(old).set(active.agentId, active.updatedAt));
	}, [active]);
	const unread = (agent: AgentSummaryView) =>
		agent.agentId !== activeId &&
		(seen.get(agent.agentId) ?? readPreference(`metis.agent-seen.${agent.agentId}`) ?? "") < agent.updatedAt;
	const indicatorFor = (agent: AgentSummaryView) =>
		agentIndicator(agent, {
			unread: unread(agent),
			attentionRequired: navigation.attentionAgentIds?.has(agent.agentId) ?? false,
			viewing: activeId === agent.agentId,
		});
	const indicators = agents.map(indicatorFor);
	const indicatorPriority: readonly SessionIndicator[] = ["attention", "failed", "completed", "running", "unread"];
	const summaryIndicator = indicatorPriority.find((indicator) => indicators.includes(indicator));
	const statusCounts = new Map<string, number>();
	for (const agent of agents) {
		const label = navigation.attentionAgentIds?.has(agent.agentId) ? "Needs attention" : agentStatusLabel(agent);
		statusCounts.set(label, (statusCounts.get(label) ?? 0) + 1);
	}
	statusCounts.set("Unread", agents.filter(unread).length);
	const summaryDescription = [
		"Needs attention",
		"Failed",
		"Completed",
		"Running",
		"Queued",
		"Paused",
		"Stopped",
		"Unread",
	]
		.flatMap((label) => (statusCounts.get(label) ? [`${t(label)}: ${statusCounts.get(label)}`] : []))
		.join(" · ");
	const visibleAgents: AgentSummaryView[] = [];
	const collect = (nodes: readonly AgentTreeNode[]) => {
		for (const node of nodes) {
			visibleAgents.push(node.agent);
			if (!collapsed.has(node.agent.agentId)) collect(node.children);
		}
	};
	collect(tree);
	const focusedId =
		focused && visibleAgents.some((agent) => agent.agentId === focused)
			? focused
			: visibleAgents.some((agent) => agent.agentId === activeId)
				? activeId
				: visibleAgents[0]?.agentId;
	const toggle = (value: boolean) => {
		setOpen(value);
		savePreference(storageKey, value ? "open" : "closed");
	};
	const toggleChild = (id: string, close: boolean) =>
		setCollapsed((old) => {
			const next = new Set(old);
			if (close) next.add(id);
			else next.delete(id);
			savePreference(`${storageKey}.collapsed`, JSON.stringify([...next]));
			return next;
		});
	const focus = (id: string | undefined) => {
		if (id) {
			setFocused(id);
			buttons.current.get(id)?.focus();
		}
	};
	const renderNode = (node: AgentTreeNode): ReactNode => {
		const { agent } = node;
		const expanded = !collapsed.has(agent.agentId);
		const running =
			(agent.status === "running" || agent.status === "queued") &&
			!agent.archived &&
			agent.runControl !== "user_paused" &&
			agent.runControl !== "interrupted";
		const needsAttention = navigation.attentionAgentIds?.has(agent.agentId) ?? false;
		const statusLabel = agentStatusLabel(agent);
		return (
			<div
				className="agent-sidebar-node"
				tabIndex={-1}
				role="treeitem"
				aria-label={agent.name}
				aria-selected={activeId === agent.agentId}
				aria-expanded={node.children.length ? expanded : undefined}
				key={agent.agentId}
			>
				<div className="agent-sidebar-row">
					<button
						className="agent-sidebar-open"
						type="button"
						aria-current={activeId === agent.agentId ? "page" : undefined}
						aria-busy={running || undefined}
						tabIndex={focusedId === agent.agentId ? 0 : -1}
						onFocus={() => setFocused(agent.agentId)}
						ref={(element) => {
							if (element) buttons.current.set(agent.agentId, element);
							else buttons.current.delete(agent.agentId);
						}}
						title={`${agent.name} · ${t(needsAttention ? "Needs attention" : statusLabel)}`}
						aria-description={`${t(needsAttention ? "Needs attention" : statusLabel)}${unread(agent) ? ` · ${t("Unread")}` : ""}`}
						onClick={() => navigation.onOpen({ sessionId, agentId: agent.agentId, name: agent.name })}
						onKeyDown={(event) => {
							const index = visibleAgents.findIndex((item) => item.agentId === agent.agentId);
							if (event.key === "ArrowDown") focus(visibleAgents[index + 1]?.agentId);
							else if (event.key === "ArrowUp") focus(visibleAgents[index - 1]?.agentId);
							else if (event.key === "Home") focus(visibleAgents[0]?.agentId);
							else if (event.key === "End") focus(visibleAgents.at(-1)?.agentId);
							else if (event.key === "ArrowRight") {
								if (!expanded) toggleChild(agent.agentId, false);
								else focus(node.children[0]?.agent.agentId);
							} else if (event.key === "ArrowLeft") {
								if (expanded && node.children.length) toggleChild(agent.agentId, true);
								else focus(agent.parentSessionId);
							} else return;
							event.preventDefault();
						}}
					>
						<span className="session-button-title">
							<SessionStatusIndicator indicator={indicatorFor(agent)} />
							<span>{agent.name}</span>
						</span>
					</button>
					{node.children.length > 0 && (
						<button
							className="agent-sidebar-toggle"
							type="button"
							tabIndex={-1}
							aria-label={t(expanded ? "Collapse agent tasks" : "Expand agent tasks")}
							onClick={() => toggleChild(agent.agentId, expanded)}
						>
							{expanded ? <CaretDown size={11} /> : <CaretRight size={11} />}
						</button>
					)}
				</div>
				{node.children.length > 0 && expanded && (
					<fieldset className="control-group agent-sidebar-children">{node.children.map(renderNode)}</fieldset>
				)}
			</div>
		);
	};
	return (
		<div className="session-agent-group" data-has-agents={agents.length > 0 || undefined}>
			{children(
				agents.length > 0 ? (
					<button
						className="agent-root-toggle"
						type="button"
						aria-expanded={open}
						aria-label={t(open ? "Collapse agent tasks" : "Expand agent tasks")}
						onClick={() => toggle(!open)}
					>
						{open ? <CaretDown size={10} /> : <CaretRight size={10} />}
					</button>
				) : null,
			)}
			{agents.length > 0 && (
				<>
					{!open && (
						<button
							className="agent-sidebar-summary"
							type="button"
							title={summaryDescription}
							aria-description={summaryDescription}
							onClick={() => toggle(true)}
						>
							<span className="session-button-title">
								<SessionStatusIndicator indicator={summaryIndicator} />
								{t("{{count}} agents", { count: agents.length })}
							</span>
						</button>
					)}
					{open && (
						<div className="agent-sidebar-tree" role="tree" aria-label={t("Agent conversations")}>
							{tree.map(renderNode)}
						</div>
					)}
				</>
			)}
			{unreadableAgentCount > 0 && (
				<button
					className="agent-sidebar-summary"
					type="button"
					onClick={reload}
					title={t("Some agent conversations could not be read. Retry loading to check again.")}
				>
					<WarningCircle size={12} />
					{t("Unreadable agents: {{count}}", { count: unreadableAgentCount })}
				</button>
			)}
			{Boolean(error) && !loading && (
				<button className="agent-sidebar-summary" type="button" onClick={reload}>
					{t("Retry loading agents")}
				</button>
			)}
		</div>
	);
}
