import { type AgentSummaryView, RPC_ERROR_CODES } from "@metis/app-protocol";
import {
	Archive,
	ArrowLeft,
	CaretDown,
	CaretRight,
	CheckCircle,
	Clock,
	Robot,
	SpinnerGap,
	StopCircle,
	Trash,
	WarningCircle,
} from "@phosphor-icons/react";
import {
	type KeyboardEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import type { AppStore } from "../store/app-store.ts";
import { MenuSelect } from "./MenuSelect.tsx";
import { Transcript } from "./Transcript.tsx";

interface AgentTreePanelProps {
	readonly api: MetisDesktopApi;
	readonly onError: (cause: unknown) => void;
	readonly sessionId: string;
	readonly store: AppStore;
	readonly visible: boolean;
}

const ACTIVE_STATUSES = new Set<AgentSummaryView["status"]>(["queued", "running"]);
const NOOP_SUBSCRIBE = () => () => undefined;

export interface AgentTreeNode {
	readonly agent: AgentSummaryView;
	readonly children: readonly AgentTreeNode[];
}

function isActive(agent: AgentSummaryView): boolean {
	return ACTIVE_STATUSES.has(agent.status);
}

function agentTaskSummary(agent: AgentSummaryView): string {
	return agent.currentTask?.taskSummary ?? agent.latestTask?.taskSummary ?? "";
}

const TASK_OPTION_SUMMARY_CHARS = 48;

function taskOptionSummary(summary: string): string {
	const chars = Array.from(summary);
	return chars.length <= TASK_OPTION_SUMMARY_CHARS ? summary : `${chars.slice(0, TASK_OPTION_SUMMARY_CHARS).join("")}…`;
}

function agentUsage(agent: AgentSummaryView): { readonly tokens: number; readonly toolUses: number } {
	return agent.tasks.reduce(
		(total, task) => ({
			tokens:
				total.tokens +
				(task.usage?.input ?? 0) +
				(task.usage?.output ?? 0) +
				(task.usage?.cacheRead ?? 0) +
				(task.usage?.cacheWrite ?? 0),
			toolUses: total.toolUses + (task.usage?.toolCalls ?? 0),
		}),
		{ tokens: 0, toolUses: 0 },
	);
}

function mergeAgents(...groups: readonly (readonly AgentSummaryView[])[]): AgentSummaryView[] {
	const byId = new Map<string, AgentSummaryView>();
	for (const group of groups) for (const agent of group) byId.set(agent.agentId, agent);
	return [...byId.values()].sort(
		(left, right) => right.updatedAt.localeCompare(left.updatedAt) || right.agentId.localeCompare(left.agentId),
	);
}

export function buildAgentTree(agents: readonly AgentSummaryView[], rootSessionId: string): readonly AgentTreeNode[] {
	const byParent = new Map<string, AgentSummaryView[]>();
	const visited = new Set<string>();
	for (const agent of agents) {
		const siblings = byParent.get(agent.parentSessionId) ?? [];
		siblings.push(agent);
		byParent.set(agent.parentSessionId, siblings);
	}
	const buildAgent = (agent: AgentSummaryView): AgentTreeNode | undefined => {
		if (visited.has(agent.agentId)) return undefined;
		visited.add(agent.agentId);
		const children = (byParent.get(agent.agentId) ?? [])
			.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
			.map(buildAgent)
			.filter((node): node is AgentTreeNode => node !== undefined);
		return { agent, children };
	};
	const tree = (byParent.get(rootSessionId) ?? [])
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt))
		.map(buildAgent)
		.filter((node): node is AgentTreeNode => node !== undefined);
	for (const orphan of agents) {
		const node = buildAgent(orphan);
		if (node) tree.push(node);
	}
	return tree;
}

function formatElapsed(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function hasActiveDescendant(agent: AgentSummaryView, agents: readonly AgentSummaryView[]): boolean {
	return agents.some(
		(candidate) =>
			candidate.agentId !== agent.agentId &&
			isActive(candidate) &&
			agent.agentPath.every((id, index) => candidate.agentPath[index] === id),
	);
}

function statusLabel(status: AgentSummaryView["status"]): string {
	switch (status) {
		case "queued":
			return "Queued";
		case "running":
			return "Running";
		case "done":
			return "Done";
		case "failed":
			return "Failed";
		case "stopped":
			return "Stopped";
	}
}

function StatusIcon({ status }: { readonly status: AgentSummaryView["status"] }) {
	if (status === "running") return <SpinnerGap aria-hidden="true" className="is-spinning" size={13} />;
	if (status === "queued") return <Clock aria-hidden="true" size={13} />;
	if (status === "failed") return <WarningCircle aria-hidden="true" size={13} />;
	if (status === "stopped") return <StopCircle aria-hidden="true" size={13} />;
	return <CheckCircle aria-hidden="true" size={13} />;
}

export function AgentTreePanel({ api, onError, sessionId, store, visible }: AgentTreePanelProps) {
	const { t } = useTranslation();
	const snapshot = useSyncExternalStore(visible ? store.subscribe : NOOP_SUBSCRIBE, store.getSnapshot);
	const baseAgents = visible && snapshot.activeSessionId === sessionId ? snapshot.agents : [];
	const selectedAgentId = snapshot.agentTranscript.agentId;
	const selectedTaskId = snapshot.agentTranscript.taskId;
	const [olderAgents, setOlderAgents] = useState<readonly AgentSummaryView[]>([]);
	const [archivedAgents, setArchivedAgents] = useState<readonly AgentSummaryView[]>([]);
	const [showArchived, setShowArchived] = useState(false);
	const [collapsedAgents, setCollapsedAgents] = useState<ReadonlySet<string>>(new Set());
	const [nextAgentCursor, setNextAgentCursor] = useState<string | null>(() =>
		snapshot.nextAgentAfterId ?? (baseAgents.length >= 100 ? (baseAgents.at(-1)?.agentId ?? null) : null),
	);
	const [nextArchivedCursor, setNextArchivedCursor] = useState<string | null>(null);
	const [loadingAgents, setLoadingAgents] = useState(false);
	const agents = useMemo(
		() =>
			mergeAgents(olderAgents, showArchived ? archivedAgents : [], baseAgents).filter(
				(agent) => showArchived || !agent.archived,
			),
		[archivedAgents, baseAgents, olderAgents, showArchived],
	);
	const selectedAgent = agents.find((agent) => agent.agentId === selectedAgentId);
	const readableSelectedAgentId = selectedAgent ? selectedAgentId : null;
	const requestedTaskId = selectedTaskId ?? selectedAgent?.currentTask?.taskId ?? selectedAgent?.latestTask?.taskId ?? null;
	const tree = useMemo(() => buildAgentTree(agents, sessionId), [agents, sessionId]);
	const visibleTreeAgents = useMemo(() => {
		const flattened: AgentSummaryView[] = [];
		const visit = (nodes: readonly AgentTreeNode[]) => {
			for (const node of nodes) {
				flattened.push(node.agent);
				if (!collapsedAgents.has(node.agent.agentId)) visit(node.children);
			}
		};
		visit(tree);
		return flattened;
	}, [collapsedAgents, tree]);
	const [now, setNow] = useState(() => Date.now());
	const [loadingLatest, setLoadingLatest] = useState(false);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
	const [mutating, setMutating] = useState<ReadonlySet<string>>(new Set());
	const selection = useRef({
		sessionId,
		agentId: selectedAgentId,
		taskId: selectedTaskId,
		requestedTaskId,
		generation: 0,
	});
	const latestRequested = useRef(false);
	const readInFlight = useRef(false);
	const olderInFlight = useRef(false);
	const mounted = useRef(true);
	const lastRevision = useRef({ key: "", revision: -1 });
	const returnFocusAgentId = useRef<string | null>(null);
	const cardRefs = useRef(new Map<string, HTMLButtonElement>());
	const treeItemRefs = useRef(new Map<string, HTMLDivElement>());
	const activeCursorTrail = useRef<string[]>(baseAgents.map((agent) => agent.agentId));
	const archivedCursorTrail = useRef<string[]>([]);
	const [focusedAgentId, setFocusedAgentId] = useState<string | null>(null);
	const backRef = useRef<HTMLButtonElement>(null);
	const listedCollection = useRef({ sessionId, revision: snapshot.agentCollectionRevision });
	const agentListGeneration = useRef(0);
	const agentListRequest = useRef<symbol | undefined>(undefined);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			selection.current = { ...selection.current, generation: selection.current.generation + 1 };
			latestRequested.current = false;
		};
	}, []);

	useEffect(() => {
		if (
			listedCollection.current.sessionId === sessionId &&
			listedCollection.current.revision === snapshot.agentCollectionRevision
		)
			return;
		listedCollection.current = { sessionId, revision: snapshot.agentCollectionRevision };
		agentListGeneration.current += 1;
		agentListRequest.current = undefined;
		setOlderAgents([]);
		setArchivedAgents([]);
		setShowArchived(false);
		setCollapsedAgents(new Set());
		setFocusedAgentId(null);
		activeCursorTrail.current = baseAgents.map((agent) => agent.agentId);
		archivedCursorTrail.current = [];
		setNextAgentCursor(
			snapshot.nextAgentAfterId ?? (baseAgents.length >= 100 ? (baseAgents.at(-1)?.agentId ?? null) : null),
		);
		setNextArchivedCursor(null);
		setLoadingAgents(false);
		setStopping(new Set());
		setMutating(new Set());
		if (selectedAgentId && !baseAgents.some((agent) => agent.agentId === selectedAgentId)) {
			store.selectAgentTranscript(null);
		}
	}, [baseAgents, selectedAgentId, sessionId, snapshot.agentCollectionRevision, snapshot.nextAgentAfterId, store]);

	useEffect(() => {
		if (focusedAgentId && visibleTreeAgents.some((agent) => agent.agentId === focusedAgentId)) return;
		setFocusedAgentId(visibleTreeAgents[0]?.agentId ?? null);
	}, [focusedAgentId, visibleTreeAgents]);

	useEffect(() => {
		if (olderAgents.length === 0) {
			activeCursorTrail.current = [
				...new Set([...activeCursorTrail.current, ...baseAgents.map((agent) => agent.agentId)]),
			];
			if (nextAgentCursor === null && (snapshot.nextAgentAfterId || baseAgents.length >= 100)) {
				setNextAgentCursor(snapshot.nextAgentAfterId ?? baseAgents.at(-1)?.agentId ?? null);
			}
		}
	}, [baseAgents, nextAgentCursor, olderAgents.length, snapshot.nextAgentAfterId]);

	useEffect(() => {
		if (!visible && snapshot.activeSessionId === sessionId && selectedAgentId) {
			store.selectAgentTranscript(null);
		}
	}, [selectedAgentId, sessionId, snapshot.activeSessionId, store, visible]);

	useEffect(() => {
		if (!visible || !agents.some(isActive)) return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, [agents, visible]);

	const requestLatest = useCallback(() => {
		if (!selection.current.agentId) return;
		latestRequested.current = true;
		if (readInFlight.current || olderInFlight.current) return;
		readInFlight.current = true;
		if (mounted.current) setLoadingLatest(true);
		void (async () => {
			try {
				while (latestRequested.current) {
					latestRequested.current = false;
					const request = { ...selection.current };
					if (!request.agentId) continue;
					try {
						const page = await api.readAgentItems({
							sessionId: request.sessionId,
							agentId: request.agentId,
							...(request.requestedTaskId ? { taskId: request.requestedTaskId } : {}),
							beforeItemId: null,
							limit: 200,
						});
						if (request.generation === selection.current.generation) {
							store.replaceAgentItems(request.agentId, request.taskId, page);
						}
					} catch (cause) {
						if (request.generation === selection.current.generation) onError(cause);
					}
				}
			} finally {
				readInFlight.current = false;
				if (mounted.current) setLoadingLatest(false);
			}
		})();
	}, [api, onError, store]);

	useEffect(() => {
		selection.current = {
			sessionId,
			agentId: visible ? readableSelectedAgentId : null,
			taskId: visible ? selectedTaskId : null,
			requestedTaskId: visible ? requestedTaskId : null,
			generation: selection.current.generation + 1,
		};
		latestRequested.current = visible && readableSelectedAgentId !== null;
		requestLatest();
		return () => {
			selection.current = { ...selection.current, generation: selection.current.generation + 1 };
			latestRequested.current = false;
		};
	}, [readableSelectedAgentId, requestLatest, requestedTaskId, selectedTaskId, sessionId, visible]);

	useEffect(() => {
		const key = visible && readableSelectedAgentId ? `${sessionId}\0${readableSelectedAgentId}` : "";
		const previous = lastRevision.current;
		lastRevision.current = { key, revision: snapshot.agentTranscript.journalRevision };
		if (key && previous.key === key && previous.revision !== snapshot.agentTranscript.journalRevision) {
			requestLatest();
		}
	}, [readableSelectedAgentId, requestLatest, sessionId, snapshot.agentTranscript.journalRevision, visible]);

	useEffect(() => {
		if (selectedAgentId) backRef.current?.focus();
		else if (returnFocusAgentId.current) {
			cardRefs.current.get(returnFocusAgentId.current)?.focus();
			returnFocusAgentId.current = null;
		}
	}, [selectedAgentId]);

	const openTranscript = (agentId: string) => {
		returnFocusAgentId.current = agentId;
		store.selectAgentTranscript(agentId, null);
	};

	const stop = async (agentId: string) => {
		if (stopping.has(agentId)) return;
		const generation = agentListGeneration.current;
		const requestSessionId = sessionId;
		const isCurrent = () =>
			mounted.current &&
			generation === agentListGeneration.current &&
			requestSessionId === listedCollection.current.sessionId;
		setStopping((current) => new Set(current).add(agentId));
		try {
			await api.interruptAgent({ sessionId: requestSessionId, agentId, requestId: crypto.randomUUID() });
		} catch (cause) {
			if (isCurrent()) onError(cause);
		} finally {
			if (isCurrent())
				setStopping((current) => {
					const next = new Set(current);
					next.delete(agentId);
					return next;
				});
		}
	};

	const loadOlder = async () => {
		const request = { ...selection.current };
		const beforeItemId = snapshot.agentTranscript.nextBeforeItemId;
		if (!request.agentId || !beforeItemId || readInFlight.current || olderInFlight.current) return;
		olderInFlight.current = true;
		setLoadingOlder(true);
		try {
			const page = await api.readAgentItems({
				sessionId: request.sessionId,
				agentId: request.agentId,
				...(request.requestedTaskId ? { taskId: request.requestedTaskId } : {}),
				beforeItemId,
				limit: 200,
			});
			if (request.generation === selection.current.generation) {
				store.prependAgentItems(request.agentId, request.taskId, page);
			}
		} catch (cause) {
			if (request.generation === selection.current.generation) onError(cause);
		} finally {
			olderInFlight.current = false;
			if (mounted.current) setLoadingOlder(false);
			if (latestRequested.current) requestLatest();
		}
	};

	const elapsedFor = (agent: AgentSummaryView) => {
		if (!isActive(agent)) return null;
		const startedAt =
			agent.currentTask?.status === "running"
				? agent.currentTask.updatedAt
				: (agent.currentTask ?? agent.latestTask)?.createdAt ?? agent.createdAt;
		return formatElapsed(now - Date.parse(startedAt));
	};

	const mutate = async (agentId: string, operation: (isCurrent: () => boolean) => Promise<void>) => {
		if (mutating.has(agentId)) return;
		const generation = agentListGeneration.current;
		const requestSessionId = sessionId;
		const isCurrent = () =>
			mounted.current &&
			generation === agentListGeneration.current &&
			requestSessionId === listedCollection.current.sessionId;
		setMutating((current) => new Set(current).add(agentId));
		try {
			await operation(isCurrent);
		} catch (cause) {
			if (isCurrent()) onError(cause);
		} finally {
			if (isCurrent()) {
				setMutating((current) => {
					const next = new Set(current);
					next.delete(agentId);
					return next;
				});
			}
		}
	};

	const archive = (agent: AgentSummaryView, archived: boolean) =>
		mutate(agent.agentId, async (isCurrent) => {
			const result = await api.archiveAgent({
				sessionId,
				agentId: agent.agentId,
				archived,
				requestId: crypto.randomUUID(),
			});
			if (!isCurrent()) return;
			setArchivedAgents((current) =>
				archived ? mergeAgents(current, [result.agent]) : current.filter((entry) => entry.agentId !== agent.agentId),
			);
			setOlderAgents((current) =>
				archived ? current.filter((entry) => entry.agentId !== agent.agentId) : mergeAgents(current, [result.agent]),
			);
			if (archived && selectedAgentId === agent.agentId && !showArchived) store.selectAgentTranscript(null);
		});

	const remove = (agent: AgentSummaryView) => {
		if (
			!window.confirm(
				t("Permanently delete {{name}} and all descendant agent history? Project files are not deleted.", {
					name: agent.name,
				}),
			)
		)
			return;
		void mutate(agent.agentId, async (isCurrent) => {
			await api.deleteAgent({ sessionId, agentId: agent.agentId, requestId: crypto.randomUUID() });
			if (!isCurrent()) return;
			const ids = new Set(
				agents
					.filter(
						(candidate) =>
							candidate.agentId === agent.agentId ||
							agent.agentPath.every((id, index) => candidate.agentPath[index] === id),
					)
					.map((candidate) => candidate.agentId),
			);
			setOlderAgents((current) => current.filter((candidate) => !ids.has(candidate.agentId)));
			setArchivedAgents((current) => current.filter((candidate) => !ids.has(candidate.agentId)));
			if (selectedAgentId && ids.has(selectedAgentId)) store.selectAgentTranscript(null);
		});
	};

	const loadAgentPage = async (includeArchived: boolean) => {
		if (agentListRequest.current) return;
		const cursor = includeArchived ? nextArchivedCursor : nextAgentCursor;
		if (!includeArchived && !cursor) return;
		const generation = agentListGeneration.current;
		const requestSessionId = sessionId;
		const token = Symbol("agent-list-request");
		const isCurrent = () =>
			mounted.current &&
			generation === agentListGeneration.current &&
			requestSessionId === listedCollection.current.sessionId &&
			agentListRequest.current === token;
		agentListRequest.current = token;
		setLoadingAgents(true);
		try {
			const trail = includeArchived ? archivedCursorTrail : activeCursorTrail;
			let requestCursor = cursor;
			let page: Awaited<ReturnType<typeof api.listAgents>>;
			for (;;) {
				try {
					page = await api.listAgents({
						sessionId: requestSessionId,
						includeArchived,
						...(requestCursor ? { afterAgentId: requestCursor } : {}),
						limit: 100,
					});
					if (!isCurrent()) return;
					trail.current = [...new Set([...trail.current, ...page.agents.map((agent) => agent.agentId)])];
					if (!includeArchived || page.agents.some((agent) => agent.archived) || !page.nextAfterAgentId) break;
					requestCursor = page.nextAfterAgentId;
				} catch (cause) {
					const code =
						typeof cause === "object" && cause !== null && "code" in cause ? Number(cause.code) : undefined;
					if (code !== RPC_ERROR_CODES.INVALID_CURSOR || !requestCursor) throw cause;
					const index = trail.current.lastIndexOf(requestCursor);
					requestCursor = index > 0 ? trail.current[index - 1]! : null;
				}
			}
			if (!isCurrent()) return;
			if (includeArchived) {
				setArchivedAgents((current) => mergeAgents(current, page.agents.filter((agent) => agent.archived)));
				setNextArchivedCursor(page.nextAfterAgentId);
			} else {
				setOlderAgents((current) => mergeAgents(current, page.agents));
				setNextAgentCursor(page.nextAfterAgentId);
			}
		} catch (cause) {
			if (isCurrent()) onError(cause);
		} finally {
			if (agentListRequest.current === token) agentListRequest.current = undefined;
			if (
				mounted.current &&
				generation === agentListGeneration.current &&
				requestSessionId === listedCollection.current.sessionId
			) {
				setLoadingAgents(false);
			}
		}
	};

	const toggleArchived = () => {
		const next = !showArchived;
		setShowArchived(next);
		if (next && archivedAgents.length === 0 && nextArchivedCursor === null) void loadAgentPage(true);
	};

	const toggleCollapsed = (agentId: string) => {
		setCollapsedAgents((current) => {
			const next = new Set(current);
			if (next.has(agentId)) next.delete(agentId);
			else next.add(agentId);
			return next;
		});
	};

	const focusTreeItem = (agentId: string | undefined) => {
		if (!agentId) return;
		setFocusedAgentId(agentId);
		treeItemRefs.current.get(agentId)?.focus();
	};

	const navigateTree = (event: KeyboardEvent<HTMLDivElement>, node: AgentTreeNode) => {
		if ((event.target as Element).closest('[role="treeitem"]') !== event.currentTarget) return;
		const index = visibleTreeAgents.findIndex((agent) => agent.agentId === node.agent.agentId);
		if (index < 0) return;
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				focusTreeItem(visibleTreeAgents[index + 1]?.agentId);
				return;
			case "ArrowUp":
				event.preventDefault();
				focusTreeItem(visibleTreeAgents[index - 1]?.agentId);
				return;
			case "Home":
				event.preventDefault();
				focusTreeItem(visibleTreeAgents[0]?.agentId);
				return;
			case "End":
				event.preventDefault();
				focusTreeItem(visibleTreeAgents.at(-1)?.agentId);
				return;
			case "ArrowRight":
				if (node.children.length === 0) return;
				event.preventDefault();
				if (collapsedAgents.has(node.agent.agentId)) toggleCollapsed(node.agent.agentId);
				else focusTreeItem(node.children[0]?.agent.agentId);
				return;
			case "ArrowLeft":
				event.preventDefault();
				if (node.children.length > 0 && !collapsedAgents.has(node.agent.agentId)) {
					toggleCollapsed(node.agent.agentId);
				} else {
					focusTreeItem(
						visibleTreeAgents.find((agent) => agent.agentId === node.agent.parentSessionId)?.agentId,
					);
				}
		}
	};

	const renderCard = (node: AgentTreeNode) => {
		const agent = node.agent;
		const elapsed = elapsedFor(agent);
		const stoppingAgent = stopping.has(agent.agentId);
		const mutatingAgent = mutating.has(agent.agentId);
		const taskSummary = agentTaskSummary(agent);
		const activeDescendant = hasActiveDescendant(agent, agents);
		const usage = agentUsage(agent);
		const hasChildren = node.children.length > 0;
		const expanded = hasChildren && !collapsedAgents.has(agent.agentId);
		return (
			<article
				className="subagent-card"
				data-status={agent.status}
				key={agent.agentId}
				style={agent.depth > 1 ? { marginInlineStart: `${(agent.depth - 1) * 12}px` } : undefined}
			>
				{hasChildren && (
					<button
						aria-expanded={expanded}
						aria-label={t(expanded ? "Collapse {{name}}" : "Expand {{name}}", { name: agent.name })}
						className="subagent-fold"
						onClick={() => toggleCollapsed(agent.agentId)}
						type="button"
					>
						{expanded ? <CaretDown aria-hidden="true" size={13} /> : <CaretRight aria-hidden="true" size={13} />}
					</button>
				)}
				{!hasChildren && <span aria-hidden="true" className="subagent-fold-spacer" />}
				<button
					aria-label={t(
						agent.archived ? "View summary for {{name}}" : "View transcript for {{name}}",
						{ name: agent.name },
					)}
					className="subagent-card-open"
					onClick={() => openTranscript(agent.agentId)}
					ref={(node) => {
						if (node) cardRefs.current.set(agent.agentId, node);
						else cardRefs.current.delete(agent.agentId);
					}}
					type="button"
				>
					<span className="subagent-card-title">{agent.name}</span>
					<span className="subagent-card-meta">
						<span className="subagent-status">
							<StatusIcon status={agent.status} />
							{t(statusLabel(agent.status))}
						</span>
						<span className="subagent-type-tag">{agent.agentType}</span>
						{elapsed && <span className="subagent-meta-item">{t("{{time}} elapsed", { time: elapsed })}</span>}
						{usage.tokens > 0 && <span className="subagent-meta-item">{t("{{count}} tokens", { count: usage.tokens })}</span>}
						{usage.toolUses > 0 && (
							<span className="subagent-meta-item">{usage.toolUses === 1 ? t("1 tool use") : t("{{count}} tool uses", { count: usage.toolUses })}</span>
						)}
						{agent.archived && <span className="subagent-meta-item">{t("Archived")}</span>}
						{taskSummary && <span className="subagent-card-summary">{taskSummary}</span>}
					</span>
				</button>
				{isActive(agent) && (
					<button
						aria-label={t(stoppingAgent ? "Stopping…" : "Stop {{name}}", { name: agent.name })}
						className="subagent-stop"
						disabled={stoppingAgent}
						onClick={() => void stop(agent.agentId)}
						type="button"
					>
						{stoppingAgent ? (
							<SpinnerGap aria-hidden="true" className="is-spinning" size={14} />
						) : (
							<StopCircle aria-hidden="true" size={14} />
						)}
					</button>
				)}
				{!isActive(agent) && (
					<div className="subagent-card-actions">
						<button
							className="subagent-action-button"
							disabled={mutatingAgent || (!agent.archived && activeDescendant)}
							onClick={() => void archive(agent, !agent.archived)}
							type="button"
						>
							<Archive aria-hidden="true" size={12} />
							<span>{t(agent.archived ? "Unarchive agent" : "Archive agent")}</span>
						</button>
						<button className="subagent-action-button subagent-action-delete" disabled={mutatingAgent} onClick={() => remove(agent)} type="button">
							<Trash aria-hidden="true" size={12} />
							<span>{t("Delete")}</span>
						</button>
					</div>
				)}
			</article>
		);
	};

	const renderNodes = (nodes: readonly AgentTreeNode[]): ReactNode =>
			nodes.map((node) => (
			<div
				aria-expanded={node.children.length > 0 ? !collapsedAgents.has(node.agent.agentId) : undefined}
				aria-level={node.agent.depth}
				className="subagent-tree-node"
				key={node.agent.agentId}
				onFocus={(event) => {
					if (event.currentTarget === event.target) setFocusedAgentId(node.agent.agentId);
				}}
				onKeyDown={(event) => navigateTree(event, node)}
				ref={(element) => {
					if (element) treeItemRefs.current.set(node.agent.agentId, element);
					else treeItemRefs.current.delete(node.agent.agentId);
				}}
				role="treeitem"
				tabIndex={
					focusedAgentId === node.agent.agentId || (!focusedAgentId && visibleTreeAgents[0]?.agentId === node.agent.agentId)
						? 0
						: -1
				}
			>
				{renderCard(node)}
				{node.children.length > 0 && !collapsedAgents.has(node.agent.agentId) && (
					<div className="subagent-tree-children" role="group">
						{renderNodes(node.children)}
					</div>
				)}
			</div>
		));

	return (
		<section className="subagent-panel" hidden={!visible} id={`agent-panel-${sessionId}`}>
			{selectedAgentId ? (
				<div className="subagent-detail">
					<header className="subagent-detail-header">
						<button
							aria-label={t("Back to agents")}
							className="subagent-back"
							onClick={() => store.selectAgentTranscript(null)}
							ref={backRef}
							type="button"
						>
							<ArrowLeft aria-hidden="true" size={14} />
						</button>
						<div className="subagent-detail-title" title={selectedAgent?.agentId}>
							<strong>{selectedAgent?.name ?? t("Agents")}</strong>
							{selectedAgent && (
								<span>
									<StatusIcon status={selectedAgent.status} />
									{t(statusLabel(selectedAgent.status))} · {selectedAgent.agentType}
								</span>
							)}
						</div>
						{selectedAgent && isActive(selectedAgent) && (
							<button
								aria-label={t(
									stopping.has(selectedAgent.agentId) ? "Stopping…" : "Stop {{name}}",
									{ name: selectedAgent.name },
								)}
								className="subagent-detail-stop"
								disabled={stopping.has(selectedAgent.agentId)}
								onClick={() => void stop(selectedAgent.agentId)}
								type="button"
							>
								{stopping.has(selectedAgent.agentId) ? (
									<SpinnerGap aria-hidden="true" className="is-spinning" size={14} />
								) : (
									<StopCircle aria-hidden="true" size={14} />
								)}
							</button>
						)}
						{selectedAgent && !isActive(selectedAgent) && (
							<div className="subagent-detail-actions">
								<button
									className="subagent-action-button"
									disabled={
										mutating.has(selectedAgent.agentId) ||
										(!selectedAgent.archived && hasActiveDescendant(selectedAgent, agents))
									}
									onClick={() => void archive(selectedAgent, !selectedAgent.archived)}
									type="button"
								>
									<Archive aria-hidden="true" size={12} />
									<span>{t(selectedAgent.archived ? "Unarchive agent" : "Archive agent")}</span>
								</button>
								<button
									className="subagent-action-button subagent-action-delete"
									disabled={mutating.has(selectedAgent.agentId)}
									onClick={() => remove(selectedAgent)}
									type="button"
								>
									<Trash aria-hidden="true" size={12} />
									<span>{t("Delete")}</span>
								</button>
							</div>
						)}
					</header>
					{selectedAgent && selectedAgent.tasks.length > 1 && (
						<div className="subagent-task-selector">
							<span>{t("Task")}</span>
							<MenuSelect
								ariaLabel={t("Task")}
								className="subagent-task-menu"
								onChange={(taskId) => store.selectAgentTranscript(selectedAgent.agentId, taskId || null)}
								options={[
									{ value: "", label: t("Latest task") },
									...[...selectedAgent.tasks].reverse().map((task) => ({
										label: `${task.taskId.slice(0, 8)} · ${taskOptionSummary(task.taskSummary)} · ${t(statusLabel(task.status))}`,
										value: task.taskId,
									})),
								]}
								placeholder={t("Latest task")}
								value={selectedTaskId ?? ""}
							/>
						</div>
					)}
					{snapshot.agentTranscript.itemOrder.length > 0 ? (
						<Transcript
							appearance="code"
							ariaLabel="Agent transcript"
							hasOlder={snapshot.agentTranscript.nextBeforeItemId !== null}
							itemIds={snapshot.agentTranscript.itemOrder}
							itemsById={snapshot.agentTranscript.itemsById}
							latestLabel="New activity"
							loadingOlder={loadingOlder || loadingLatest}
							onLoadOlder={loadOlder}
							olderLabel="Load older activity"
						/>
					) : (
						<div className="subagent-empty-detail">
							<Robot aria-hidden="true" size={22} />
							<span>{t(loadingLatest ? "Loading…" : "No activity yet")}</span>
						</div>
					)}
				</div>
			) : (
				<div className="subagent-panel-list">
					<header className="subagent-panel-heading">
						<span className="subagent-panel-heading-title">
							<Robot aria-hidden="true" size={15} />
							<strong>{t("Agents")}</strong>
						</span>
						<button className="subagent-heading-toggle" onClick={toggleArchived} type="button">
							<Archive aria-hidden="true" size={12} />
							<span>{t(showArchived ? "Hide archived" : "Show archived")}</span>
						</button>
					</header>
					<section aria-label={t("Agent tree")} className="subagent-section" role="tree">
						{tree.length > 0 ? (
							renderNodes(tree)
						) : (
							<p className="subagent-section-empty">{t("No agents yet")}</p>
						)}
					</section>
					{nextAgentCursor && (
						<button className="subagent-load-more" disabled={loadingAgents} onClick={() => void loadAgentPage(false)} type="button">
							{t(loadingAgents ? "Loading…" : "Load older agents")}
						</button>
					)}
					{showArchived && nextArchivedCursor && (
						<button className="subagent-load-more" disabled={loadingAgents} onClick={() => void loadAgentPage(true)} type="button">
							{t(loadingAgents ? "Loading…" : "Load more archived")}
						</button>
					)}
				</div>
			)}
		</section>
	);
}
