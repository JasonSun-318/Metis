import type { SubagentSummaryView } from "@metis/app-protocol";
import { ArrowLeft, CheckCircle, Clock, Robot, SpinnerGap, StopCircle, WarningCircle } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { localeForIntl } from "../i18n.ts";
import type { AppStore } from "../store/app-store.ts";
import { Markdown } from "./Markdown.tsx";
import { Transcript } from "./Transcript.tsx";

interface SubagentPanelProps {
	readonly api: MetisDesktopApi;
	readonly onError: (cause: unknown) => void;
	readonly sessionId: string;
	readonly store: AppStore;
	readonly visible: boolean;
}

const ACTIVE_STATUSES = new Set<SubagentSummaryView["status"]>(["queued", "running"]);
const NOOP_SUBSCRIBE = () => () => undefined;
type SubagentUsage = NonNullable<Exclude<SubagentSummaryView, { status: "closed" }>["usage"]>;

function isActive(agent: SubagentSummaryView): boolean {
	return ACTIVE_STATUSES.has(agent.status);
}

export function groupSubagents(subagents: readonly SubagentSummaryView[]): {
	readonly running: readonly SubagentSummaryView[];
	readonly finished: readonly SubagentSummaryView[];
} {
	return {
		running: subagents.filter(isActive).sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
		finished: subagents.filter((agent) => !isActive(agent)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
	};
}

function tokenTotal(usage: SubagentUsage): number {
	return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function formatElapsed(milliseconds: number): string {
	const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	const hours = Math.floor(minutes / 60);
	return `${hours}h ${minutes % 60}m`;
}

function statusLabel(status: SubagentSummaryView["status"]): string {
	switch (status) {
		case "queued": return "Queued";
		case "running": return "Running";
		case "done": return "Done";
		case "failed": return "Failed";
		case "stopped": return "Stopped";
		case "close_failed": return "Close failed";
		case "closed": return "Closed";
	}
}

function StatusIcon({ status }: { readonly status: SubagentSummaryView["status"] }) {
	if (status === "running") return <SpinnerGap aria-hidden="true" className="is-spinning" size={13} />;
	if (status === "queued") return <Clock aria-hidden="true" size={13} />;
	if (status === "failed" || status === "close_failed") return <WarningCircle aria-hidden="true" size={13} />;
	if (status === "stopped") return <StopCircle aria-hidden="true" size={13} />;
	return <CheckCircle aria-hidden="true" size={13} />;
}

export function SubagentPanel({ api, onError, sessionId, store, visible }: SubagentPanelProps) {
	const { i18n, t } = useTranslation();
	const snapshot = useSyncExternalStore(visible ? store.subscribe : NOOP_SUBSCRIBE, store.getSnapshot);
	const selectedAgentId = snapshot.subagentTranscript.agentId;
	const selectedAgent = snapshot.subagents.find((agent) => agent.agentId === selectedAgentId);
	const readableSelectedAgentId = selectedAgent && selectedAgent.status !== "closed" ? selectedAgentId : null;
	const subagents = visible && snapshot.activeSessionId === sessionId ? snapshot.subagents : [];
	const grouped = useMemo(() => groupSubagents(subagents), [subagents]);
	const [now, setNow] = useState(() => Date.now());
	const [loadingLatest, setLoadingLatest] = useState(false);
	const [loadingOlder, setLoadingOlder] = useState(false);
	const [stopping, setStopping] = useState<ReadonlySet<string>>(new Set());
	const selection = useRef({ sessionId, agentId: selectedAgentId, generation: 0 });
	const latestRequested = useRef(false);
	const readInFlight = useRef(false);
	const olderInFlight = useRef(false);
	const mounted = useRef(true);
	const lastRevision = useRef({ key: "", revision: -1 });
	const returnFocusAgentId = useRef<string | null>(null);
	const cardRefs = useRef(new Map<string, HTMLButtonElement>());
	const backRef = useRef<HTMLButtonElement>(null);
	const number = useMemo(() => new Intl.NumberFormat(localeForIntl(i18n.resolvedLanguage), {
		notation: "compact",
		maximumFractionDigits: 1,
	}), [i18n.resolvedLanguage]);
	const dateTime = useMemo(() => new Intl.DateTimeFormat(localeForIntl(i18n.resolvedLanguage), {
		dateStyle: "medium",
		timeStyle: "short",
	}), [i18n.resolvedLanguage]);

	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			selection.current = { ...selection.current, generation: selection.current.generation + 1 };
			latestRequested.current = false;
		};
	}, []);

	useEffect(() => {
		if (!visible && snapshot.activeSessionId === sessionId && selectedAgentId) {
			store.selectSubagentTranscript(null);
		}
	}, [selectedAgentId, sessionId, snapshot.activeSessionId, store, visible]);

	useEffect(() => {
		if (!visible || grouped.running.length === 0) return;
		setNow(Date.now());
		const timer = window.setInterval(() => setNow(Date.now()), 1_000);
		return () => window.clearInterval(timer);
	}, [grouped.running.length, visible]);

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
						const page = await api.readSubagentItems({
							sessionId: request.sessionId,
							agentId: request.agentId,
							beforeItemId: null,
							limit: 200,
						});
						if (request.generation === selection.current.generation) {
							store.replaceSubagentItems(request.agentId, page);
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
			generation: selection.current.generation + 1,
		};
		latestRequested.current = visible && readableSelectedAgentId !== null;
		requestLatest();
		return () => {
			selection.current = { ...selection.current, generation: selection.current.generation + 1 };
			latestRequested.current = false;
		};
	}, [readableSelectedAgentId, requestLatest, sessionId, visible]);

	useEffect(() => {
		const key = visible && readableSelectedAgentId ? `${sessionId}\0${readableSelectedAgentId}` : "";
		const previous = lastRevision.current;
		lastRevision.current = { key, revision: snapshot.subagentTranscript.journalRevision };
		if (key && previous.key === key && previous.revision !== snapshot.subagentTranscript.journalRevision) {
			requestLatest();
		}
	}, [readableSelectedAgentId, requestLatest, sessionId, snapshot.subagentTranscript.journalRevision, visible]);

	useEffect(() => {
		if (selectedAgentId) backRef.current?.focus();
		else if (returnFocusAgentId.current) {
			cardRefs.current.get(returnFocusAgentId.current)?.focus();
			returnFocusAgentId.current = null;
		}
	}, [selectedAgentId]);

	const openTranscript = (agentId: string) => {
		returnFocusAgentId.current = agentId;
		store.selectSubagentTranscript(agentId);
	};

	const stop = async (agentId: string) => {
		if (stopping.has(agentId)) return;
		setStopping((current) => new Set(current).add(agentId));
		try {
			await api.interruptSubagent({ sessionId, agentId, requestId: crypto.randomUUID() });
		} catch (cause) {
			if (mounted.current) onError(cause);
		} finally {
			if (mounted.current) setStopping((current) => {
				const next = new Set(current);
				next.delete(agentId);
				return next;
			});
		}
	};

	const loadOlder = async () => {
		const request = { ...selection.current };
		const beforeItemId = snapshot.subagentTranscript.nextBeforeItemId;
		if (!request.agentId || !beforeItemId || readInFlight.current || olderInFlight.current) return;
		olderInFlight.current = true;
		setLoadingOlder(true);
		try {
			const page = await api.readSubagentItems({
				sessionId: request.sessionId,
				agentId: request.agentId,
				beforeItemId,
				limit: 200,
			});
			if (request.generation === selection.current.generation) store.prependSubagentItems(request.agentId, page);
		} catch (cause) {
			if (request.generation === selection.current.generation) onError(cause);
		} finally {
			olderInFlight.current = false;
			if (mounted.current) setLoadingOlder(false);
			if (latestRequested.current) requestLatest();
		}
	};

	const elapsedFor = (agent: SubagentSummaryView) => {
		if (isActive(agent)) return formatElapsed(now - Date.parse(agent.createdAt));
		return "usage" in agent && agent.usage ? formatElapsed(agent.usage.elapsedMs) : null;
	};

	const renderCard = (agent: SubagentSummaryView) => {
		const elapsed = elapsedFor(agent);
		const usage = "usage" in agent ? agent.usage : undefined;
		const stoppingAgent = stopping.has(agent.agentId);
		return (
			<article className="subagent-card" data-status={agent.status} key={agent.agentId}>
				<button
					aria-label={t(agent.status === "closed" ? "View summary for {{name}}" : "View transcript for {{name}}", { name: agent.name })}
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
						<span className="subagent-status"><StatusIcon status={agent.status} />{t(statusLabel(agent.status))}</span>
						<span>{agent.taskSummary}</span>
						{elapsed && <span>{t("{{time}} elapsed", { time: elapsed })}</span>}
						{usage && <span>{t("{{count}} tokens", { count: number.format(tokenTotal(usage)) })}</span>}
						{usage?.toolCalls !== undefined && <span>{t("{{count}} tool uses", { count: number.format(usage.toolCalls) })}</span>}
					</span>
				</button>
				{isActive(agent) && (
					<button aria-label={t(stoppingAgent ? "Stopping…" : "Stop {{name}}", { name: agent.name })} className="subagent-stop" disabled={stoppingAgent} onClick={() => void stop(agent.agentId)} type="button">
						{stoppingAgent ? <SpinnerGap aria-hidden="true" className="is-spinning" size={14} /> : <StopCircle aria-hidden="true" size={14} />}
					</button>
				)}
			</article>
		);
	};

	return (
		<section className="subagent-panel" hidden={!visible} id={`subagent-panel-${sessionId}`}>
			{selectedAgentId ? (
				<div className="subagent-detail">
					<header className="subagent-detail-header">
						<button aria-label={t("Back to background tasks")} className="subagent-back" onClick={() => store.selectSubagentTranscript(null)} ref={backRef} type="button"><ArrowLeft aria-hidden="true" size={14} /></button>
						<div className="subagent-detail-title">
							<strong>{selectedAgent?.name ?? t("Subagent")}</strong>
							{selectedAgent && <span><StatusIcon status={selectedAgent.status} />{t(statusLabel(selectedAgent.status))}</span>}
						</div>
						{selectedAgent && isActive(selectedAgent) && (
							<button aria-label={t(stopping.has(selectedAgent.agentId) ? "Stopping…" : "Stop {{name}}", { name: selectedAgent.name })} className="subagent-detail-stop" disabled={stopping.has(selectedAgent.agentId)} onClick={() => void stop(selectedAgent.agentId)} type="button">
								{stopping.has(selectedAgent.agentId) ? <SpinnerGap aria-hidden="true" className="is-spinning" size={14} /> : <StopCircle aria-hidden="true" size={14} />}
							</button>
						)}
					</header>
					{selectedAgent?.status === "closed" ? (
						<div className="subagent-closed-summary transcript-code">
							<div className="code-turn-answer"><Markdown text={selectedAgent.finalSummary ?? t("No summary available")} /></div>
							<time dateTime={selectedAgent.updatedAt}>{t("Closed")} · {dateTime.format(new Date(selectedAgent.updatedAt))}</time>
						</div>
					) : snapshot.subagentTranscript.itemOrder.length > 0 ? (
						<Transcript
							appearance="code"
							ariaLabel="Subagent transcript"
							hasOlder={snapshot.subagentTranscript.nextBeforeItemId !== null}
							itemIds={snapshot.subagentTranscript.itemOrder}
							itemsById={snapshot.subagentTranscript.itemsById}
							latestLabel="New activity"
							loadingOlder={loadingOlder || loadingLatest}
							onLoadOlder={loadOlder}
							olderLabel="Load older activity"
						/>
					) : (
						<div className="subagent-empty-detail"><Robot aria-hidden="true" size={22} /><span>{t(loadingLatest ? "Loading…" : "No activity yet")}</span></div>
					)}
				</div>
			) : (
				<div className="subagent-panel-list">
					<header className="subagent-panel-heading"><Robot aria-hidden="true" size={15} /><strong>{t("Background tasks")}</strong></header>
					{grouped.running.length > 0 && (
						<section className="subagent-section">
							<h2 className="subagent-section-title">{t("Running")}</h2>
							{grouped.running.map(renderCard)}
						</section>
					)}
					<section className="subagent-section">
						<h2 className="subagent-section-title">{t("Finished")}</h2>
						{grouped.finished.length > 0 ? grouped.finished.map(renderCard) : <p className="subagent-section-empty">{t("No finished tasks")}</p>}
					</section>
				</div>
			)}
		</section>
	);
}
