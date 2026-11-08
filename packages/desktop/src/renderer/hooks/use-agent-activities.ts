import type { SessionSummary } from "@metis/app-protocol";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { type AgentActivity, agentActivity } from "../agent-activity.ts";
import { acquireAgentCatalog } from "../store/agent-catalog-store.ts";

const emptyActivity: ReadonlyMap<string, AgentActivity> = new Map();
interface AgentActivitiesSnapshot {
	readonly activityBySession: ReadonlyMap<string, AgentActivity>;
	readonly layoutKey: string;
}

/** Keep catalog observers above movable sidebar rows so grouping never drops activity. */
export function useAgentActivities(
	api: Pick<MetisDesktopApi, "listAgents" | "subscribe"> | undefined,
	sessions: readonly SessionSummary[],
	attentionAgentIds?: ReadonlySet<string>,
): AgentActivitiesSnapshot {
	const sessionKey = [
		...new Set(
			sessions
				.filter((session) => session.state !== "corrupt" && session.state !== "unsupported")
				.map((session) => session.sessionId),
		),
	]
		.sort()
		.join("\n");
	const collection = useMemo(() => {
		const handles =
			api && sessionKey ? sessionKey.split("\n").map((id) => [id, acquireAgentCatalog(api, id)] as const) : [];
		let previous: ReturnType<(typeof handles)[number][1]["store"]["getSnapshot"]>[] = [];
		let activity = emptyActivity;
		let result: AgentActivitiesSnapshot = { activityBySession: activity, layoutKey: "" };
		return {
			handles,
			subscribe: (notify: () => void) => {
				const cleanups = handles.map(([, handle]) => handle.store.subscribe(notify));
				return () => {
					for (const cleanup of cleanups) cleanup();
				};
			},
			getSnapshot: () => {
				const snapshots = handles.map(([, handle]) => handle.store.getSnapshot());
				if (
					snapshots.length === previous.length &&
					snapshots.every((snapshot, index) => snapshot === previous[index])
				)
					return result;
				previous = snapshots;
				activity = new Map(
					handles.map(([id], index) => [id, agentActivity(snapshots[index]!.agents, attentionAgentIds)]),
				);
				result = {
					activityBySession: activity,
					layoutKey: JSON.stringify(
						snapshots.map((snapshot, index) => [
							handles[index]![0],
							snapshot.loading,
							Boolean(snapshot.error),
							snapshot.unreadableAgentCount > 0,
							snapshot.agents.map((agent) => [agent.agentId, agent.agentPath]),
						]),
					),
				};
				return result;
			},
		};
	}, [api, sessionKey, attentionAgentIds]);
	useEffect(() => {
		for (const [, handle] of collection.handles) handle.retain();
		return () => {
			for (const [, handle] of collection.handles) handle.release();
		};
	}, [collection]);
	return useSyncExternalStore(collection.subscribe, collection.getSnapshot, collection.getSnapshot);
}
