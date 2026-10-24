import type { AgentSummaryView } from "@metis/app-protocol";
import { useCallback, useEffect, useState } from "react";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";

export function mergeAgentCatalog(
	current: readonly AgentSummaryView[],
	incoming: readonly AgentSummaryView[],
): AgentSummaryView[] {
	const agents = new Map(current.map((agent) => [agent.agentId, agent]));
	for (const agent of incoming) {
		const previous = agents.get(agent.agentId);
		if (!previous || previous.updatedAt <= agent.updatedAt) agents.set(agent.agentId, agent);
	}
	return [...agents.values()]
		.filter((agent) => !agent.archived)
		.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.agentId.localeCompare(b.agentId));
}

/** Reads the durable catalog without opening a runtime. Live changes arrive over the root connection. */
export function useAgentCatalog(api: Pick<MetisDesktopApi, "listAgents" | "subscribe">, sessionId: string) {
	const [agents, setAgents] = useState<readonly AgentSummaryView[]>([]);
	const [error, setError] = useState<unknown>();
	const [loading, setLoading] = useState(true);
	const [unreadableAgentCount, setUnreadableAgentCount] = useState(0);
	const [revision, setRevision] = useState(0);
	const reload = useCallback(() => setRevision((value) => value + 1), []);
	// biome-ignore lint/correctness/useExhaustiveDependencies(revision): An explicit retry reloads the cold catalog.
	useEffect(() => {
		let current = true;
		const deleted = new Set<string>();
		const liveUpdates = new Map<string, AgentSummaryView>();
		setLoading(true);
		setError(undefined);
		setUnreadableAgentCount(0);
		const unsubscribe = api.subscribe((event) => {
			if (event.type !== "app-server" || event.envelope.method !== "connection/events") return;
			for (const change of event.envelope.params.events) {
				if (!("sessionId" in change) || change.sessionId !== sessionId) continue;
				if (change.type === "agent/updated") {
					liveUpdates.set(change.agent.agentId, change.agent);
					setAgents((old) => mergeAgentCatalog(old, [change.agent]));
				} else if (change.type === "agent/deleted") {
					for (const id of change.deletedAgentIds) deleted.add(id);
					setAgents((old) => old.filter((agent) => !deleted.has(agent.agentId)));
				}
			}
		});
		void (async () => {
			try {
				const collected: AgentSummaryView[] = [];
				const cursors = new Set<string>();
				let afterAgentId: string | undefined;
				do {
					const page = await api.listAgents({ sessionId, limit: 100, ...(afterAgentId ? { afterAgentId } : {}) });
					if (!current) return;
					collected.push(...page.agents);
					setUnreadableAgentCount(page.unreadableAgentCount ?? 0);
					afterAgentId = page.nextAfterAgentId ?? undefined;
					if (afterAgentId && cursors.has(afterAgentId)) throw new Error("Repeated agent catalog cursor");
					if (afterAgentId) cursors.add(afterAgentId);
				} while (afterAgentId);
				setAgents(
					mergeAgentCatalog(collected, [...liveUpdates.values()]).filter((agent) => !deleted.has(agent.agentId)),
				);
			} catch (cause) {
				if (current) setError(cause);
			} finally {
				if (current) setLoading(false);
			}
		})();
		return () => {
			current = false;
			unsubscribe();
		};
	}, [api, sessionId, revision]);
	return { agents, loading, error, reload, unreadableAgentCount };
}
