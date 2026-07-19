import type { ItemView, SessionSnapshot } from "@arcmind/app-protocol";
import { useEffect, useMemo, useState } from "react";
import type { ArcMindDesktopApi } from "../../shared/desktop-api.ts";
import { Transcript } from "./Transcript.tsx";

interface SubagentPanelProps {
	readonly api: ArcMindDesktopApi;
	readonly sessionId: string;
	readonly subagents: SessionSnapshot["subagents"];
}

function shortId(agentId: string): string {
	return agentId.length <= 12 ? agentId : `${agentId.slice(0, 8)}…${agentId.slice(-4)}`;
}

function usage(agent: SessionSnapshot["subagents"][number]): string | undefined {
	if (!agent.usage) return undefined;
	const tokens = agent.usage.input + agent.usage.output + agent.usage.cacheRead + agent.usage.cacheWrite;
	return `${tokens.toLocaleString()} tokens · ${(agent.usage.elapsedMs / 1000).toFixed(1)}s`;
}

export function SubagentPanel({ api, sessionId, subagents }: SubagentPanelProps) {
	const [collapsed, setCollapsed] = useState(false);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [items, setItems] = useState<ItemView[]>([]);
	const [beforeItemId, setBeforeItemId] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const selected = subagents.find((agent) => agent.agentId === selectedId);
	const itemsById = useMemo(() => new Map(items.map((item) => [item.itemId, item])), [items]);

	useEffect(() => {
		setSelectedId(null);
		setItems([]);
		setBeforeItemId(null);
		setError(null);
	}, [sessionId]);

	const load = async (agentId: string, before?: string) => {
		setLoading(true);
		setError(null);
		try {
			const page = await api.readSubagentItems({
				sessionId,
				agentId,
				limit: 100,
				...(before ? { beforeItemId: before } : {}),
			});
			setItems((current) => (before ? [...page.items, ...current] : [...page.items]));
			setBeforeItemId(page.nextBeforeItemId);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Child activity could not be loaded.");
		} finally {
			setLoading(false);
		}
	};

	const select = (agent: SessionSnapshot["subagents"][number]) => {
		setSelectedId(agent.agentId);
		setItems([]);
		setBeforeItemId(null);
		setError(null);
		if (agent.status !== "closed") void load(agent.agentId);
	};

	return (
		<aside aria-label="Subagents" className={`subagent-panel${collapsed ? " is-collapsed" : ""}`}>
			<div className="subagent-panel-heading">
				<h2>Subagents</h2>
				<button aria-expanded={!collapsed} onClick={() => setCollapsed((value) => !value)} type="button">
					{collapsed ? "Show" : "Hide"}
				</button>
			</div>
			{!collapsed && (
				<>
					<div className="subagent-list">
						{subagents.map((agent) => {
							const metadata = agent.configuration;
							return (
								<button
									aria-pressed={selectedId === agent.agentId}
									className="subagent-card"
									key={agent.agentId}
									onClick={() => select(agent)}
									type="button"
								>
									<div><strong>{agent.name}</strong><span className={`subagent-status status-${agent.status}`}>{agent.status.replace("_", " ")}</span></div>
									<span className="subagent-id">{shortId(agent.agentId)}</span>
									<p>{agent.taskSummary}</p>
									{metadata && <p>{metadata.mode} · {metadata.permissionMode} · {metadata.model.provider}/{metadata.model.modelId}</p>}
									{usage(agent) && <p>{usage(agent)}</p>}
									{agent.finalSummary && <p className="subagent-result">{agent.finalSummary}</p>}
									{agent.error && <p className="subagent-error">{agent.error}</p>}
									{agent.residualPath && <p className="subagent-error">Residual data: {agent.residualPath}</p>}
								</button>
							);
						})}
					</div>
					{selected && (
						<section aria-label={`${selected.name} activity`} className="subagent-activity">
							<h3>{selected.name} activity</h3>
							{selected.status === "closed" ? (
								<p className="subagent-empty">This child was permanently closed; only its tombstone remains.</p>
							) : (
								<Transcript
									hasOlder={beforeItemId !== null}
									itemIds={items.map((item) => item.itemId)}
									itemsById={itemsById}
									loadingOlder={loading}
									onLoadOlder={async () => {
										if (beforeItemId) await load(selected.agentId, beforeItemId);
									}}
									olderLabel="Load older activity"
								/>
							)}
							{error && <p className="subagent-error" role="alert">{error}</p>}
						</section>
					)}
				</>
			)}
		</aside>
	);
}
