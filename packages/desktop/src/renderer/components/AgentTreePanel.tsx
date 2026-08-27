import type { AgentSummaryView } from "@metis/app-protocol";
import { ArrowLeft, CheckCircle, Clock, Robot, SpinnerGap, StopCircle, WarningCircle } from "@phosphor-icons/react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import type { AppStore } from "../store/app-store.ts";
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
	const [nextAgentCursor, setNextAgentCursor] = useState<string | null>(() =>
		baseAgents.length >= 100 ? (baseAgents.at(-1)?.agentId ?? null) : null,
	);
	const [nextArchivedCursor, setNextArchivedCursor] = useState<string | null>(null);
	const [loadingAgents, setLoadingAgents] = useState(false);
	const agents = useMemo(
		() =>
			mergeAgents(baseAgents, olderAgents, showArchived ? archivedAgents : []).filter(
				(agent) => showArchived || !agent.archived,
			),
		[archivedAgents, baseAgents, olderAgents, showArchived],
	);
	const selectedAgent = agents.find((agent) => agent.agentId === selectedAgentId);
	const readableSelectedAgentId = selectedAgent ? selectedAgentId : null;
	const tree = useMemo(() => buildAgentTree(agents, sessionId), [agents, sessionId]);
	const [now, setNow] = useState(() => Date.now());
	const [loadingLatest, setLoadingLatest] = useState(false);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
	const [mutating, setMutating] = useState<ReadonlySet<string>>(new Set());
	const selection = useRef({ sessionId, agentId: selectedAgentId, taskId: selectedTaskId, generation: 0 });
	const latestRequested = useRef(false);
	const readInFlight = useRef(false);
	const olderInFlight = useRef(false);
	const mounted = useRef(true);
	const lastRevision = useRef({ key: "", revision: -1 });
	const returnFocusAgentId = useRef<string | null>(null);
	const cardRefs = useRef(new Map<string, HTMLButtonElement>());
	const backRef = useRef<HTMLButtonElement>(null);
	const listedSessionId = useRef(sessionId);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			selection.current = { ...selection.current, generation: selection.current.generation + 1 };
			latestRequested.current = false;
		};
	}, []);

	useEffect(() => {
		if (listedSessionId.current === sessionId) return;
		listedSessionId.current = sessionId;
		setOlderAgents([]);
		setArchivedAgents([]);
		setShowArchived(false);
		setNextAgentCursor(baseAgents.length >= 100 ? (baseAgents.at(-1)?.agentId ?? null) : null);
		setNextArchivedCursor(null);
	}, [sessionId]);

	useEffect(() => {
		if (olderAgents.length === 0) {
			setNextAgentCursor(baseAgents.length >= 100 ? (baseAgents.at(-1)?.agentId ?? null) : null);
		}
	}, [baseAgents, olderAgents.length]);

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
							...(request.taskId ? { taskId: request.taskId } : {}),
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
			generation: selection.current.generation + 1,
		};
		latestRequested.current = visible && readableSelectedAgentId !== null;
		requestLatest();
		return () => {
			selection.current = { ...selection.current, generation: selection.current.generation + 1 };
			latestRequested.current = false;
		};
	}, [readableSelectedAgentId, requestLatest, selectedTaskId, sessionId, visible]);

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
		setStopping((current) => new Set(current).add(agentId));
		try {
			await api.interruptAgent({ sessionId, agentId, requestId: crypto.randomUUID() });
		} catch (cause) {
			if (mounted.current) onError(cause);
		} finally {
			if (mounted.current)
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
				...(request.taskId ? { taskId: request.taskId } : {}),
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
		return formatElapsed(now - Date.parse(agent.createdAt));
	};

	const mutate = async (agentId: string, operation: () => Promise<void>) => {
		if (mutating.has(agentId)) return;
		setMutating((current) => new Set(current).add(agentId));
		try {
			await operation();
		} catch (cause) {
			if (mounted.current) onError(cause);
		} finally {
			if (mounted.current) {
				setMutating((current) => {
					const next = new Set(current);
					next.delete(agentId);
					return next;
				});
			}
		}
	};

	const archive = (agent: AgentSummaryView, archived: boolean) =>
		mutate(agent.agentId, async () => {
			const result = await api.archiveAgent({
				sessionId,
				agentId: agent.agentId,
				archived,
				requestId: crypto.randomUUID(),
			});
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
		void mutate(agent.agentId, async () => {
			await api.deleteAgent({ sessionId, agentId: agent.agentId, requestId: crypto.randomUUID() });
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
		if (loadingAgents) return;
		const cursor = includeArchived ? nextArchivedCursor : nextAgentCursor;
		if (!includeArchived && !cursor) return;
		setLoadingAgents(true);
		try {
			const page = await api.listAgents({
				sessionId,
				includeArchived,
				...(cursor ? { afterAgentId: cursor } : {}),
				limit: 100,
			});
			if (includeArchived) {
				setArchivedAgents((current) => mergeAgents(current, page.agents.filter((agent) => agent.archived)));
				setNextArchivedCursor(page.nextAfterAgentId);
			} else {
				setOlderAgents((current) => mergeAgents(current, page.agents));
				setNextAgentCursor(page.nextAfterAgentId);
			}
		} catch (cause) {
			onError(cause);
		} finally {
			if (mounted.current) setLoadingAgents(false);
		}
	};

	const toggleArchived = () => {
		const next = !showArchived;
		setShowArchived(next);
		if (next && archivedAgents.length === 0 && nextArchivedCursor === null) void loadAgentPage(true);
	};

	const renderCard = (agent: AgentSummaryView) => {
		const elapsed = elapsedFor(agent);
		const stoppingAgent = stopping.has(agent.agentId);
		const mutatingAgent = mutating.has(agent.agentId);
		const taskSummary = agentTaskSummary(agent);
		const activeDescendant = hasActiveDescendant(agent, agents);
		return (
			<article
				className="subagent-card"
				data-status={agent.status}
				key={agent.agentId}
				style={agent.depth > 1 ? { marginInlineStart: `${(agent.depth - 1) * 12}px` } : undefined}
			>
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
						<span>{agent.agentType}</span>
						{taskSummary && <span>{taskSummary}</span>}
						{elapsed && <span>{t("{{time}} elapsed", { time: elapsed })}</span>}
						{agent.archived && <span>{t("Archived")}</span>}
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
							disabled={mutatingAgent || (!agent.archived && activeDescendant)}
							onClick={() => void archive(agent, !agent.archived)}
							type="button"
						>
							{t(agent.archived ? "Unarchive agent" : "Archive agent")}
						</button>
						<button disabled={mutatingAgent} onClick={() => remove(agent)} type="button">
							{t("Delete")}
						</button>
					</div>
				)}
			</article>
		);
	};

	const renderNodes = (nodes: readonly AgentTreeNode[]): ReactNode =>
		nodes.map((node) => (
			<div className="subagent-tree-node" key={node.agent.agentId}>
				{renderCard(node.agent)}
				{node.children.length > 0 && <div className="subagent-tree-children">{renderNodes(node.children)}</div>}
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
						<div className="subagent-detail-title">
							<strong>{selectedAgent?.name ?? t("Agents")}</strong>
							{selectedAgent && (
								<>
									<span>
										<StatusIcon status={selectedAgent.status} />
										{t(statusLabel(selectedAgent.status))} · {selectedAgent.agentType}
									</span>
									<code>{selectedAgent.agentId}</code>
								</>
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
									disabled={
										mutating.has(selectedAgent.agentId) ||
										(!selectedAgent.archived && hasActiveDescendant(selectedAgent, agents))
									}
									onClick={() => void archive(selectedAgent, !selectedAgent.archived)}
									type="button"
								>
									{t(selectedAgent.archived ? "Unarchive agent" : "Archive agent")}
								</button>
								<button
									disabled={mutating.has(selectedAgent.agentId)}
									onClick={() => remove(selectedAgent)}
									type="button"
								>
									{t("Delete")}
								</button>
							</div>
						)}
					</header>
					{selectedAgent && (
						<label className="subagent-task-selector">
							<span>{t("Task")}</span>
							<select
								onChange={(event) => store.selectAgentTranscript(selectedAgent.agentId, event.target.value || null)}
								value={selectedTaskId ?? ""}
							>
								<option value="">{t("Latest task")}</option>
								{[...selectedAgent.tasks].reverse().map((task) => (
									<option key={task.taskId} value={task.taskId}>
										{task.taskId.slice(0, 8)} · {task.taskSummary} · {t(statusLabel(task.status))}
									</option>
								))}
							</select>
						</label>
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
						<Robot aria-hidden="true" size={15} />
						<strong>{t("Agents")}</strong>
						<button onClick={toggleArchived} type="button">
							{t(showArchived ? "Hide archived" : "Show archived")}
						</button>
					</header>
					<section className="subagent-section">
						{tree.length > 0 ? (
							renderNodes(tree)
						) : (
							<p className="subagent-section-empty">{t("No agents yet")}</p>
						)}
					</section>
					{nextAgentCursor && (
						<button disabled={loadingAgents} onClick={() => void loadAgentPage(false)} type="button">
							{t(loadingAgents ? "Loading…" : "Load older agents")}
						</button>
					)}
					{showArchived && nextArchivedCursor && (
						<button disabled={loadingAgents} onClick={() => void loadAgentPage(true)} type="button">
							{t(loadingAgents ? "Loading…" : "Load more archived")}
						</button>
					)}
				</div>
			)}
		</section>
	);
}
