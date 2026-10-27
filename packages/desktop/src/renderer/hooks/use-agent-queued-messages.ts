import type { QueuedTurnView } from "@metis/app-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";

/** The child scheduler owns persistence; this hook only reconciles its queue view. */
export function useAgentQueuedMessages(
	api: Pick<MetisDesktopApi, "readAgentQueuedMessages" | "subscribe">,
	sessionId: string,
	agentId: string,
) {
	const identity = `${sessionId}:${agentId}`;
	const [snapshot, setSnapshot] = useState<{
		identity: string;
		turns: readonly QueuedTurnView[];
		loading: boolean;
		error?: unknown;
	}>({ identity, turns: [], loading: true });
	const refresh = useRef<() => void>(() => undefined);
	useEffect(() => {
		let active = true;
		let reading = false;
		let requested = false;
		let deleted = false;
		let knownEpoch: string | null | undefined;
		let supervisorState: string | undefined;
		setSnapshot({ identity, turns: [], loading: true });
		const request = () => {
			if (!active || deleted) return;
			requested = true;
			if (reading || !active) return;
			reading = true;
			void (async () => {
				try {
					while (active && !deleted && requested) {
						requested = false;
						const result = await api.readAgentQueuedMessages({ sessionId, agentId });
						// An update arrived while reading: finish reconciliation before exposing a stale queue.
						if (active && !deleted && !requested)
							setSnapshot({ identity, turns: result.queuedTurns, loading: false });
					}
				} catch (error) {
					if (active && !deleted) setSnapshot((old) => ({ ...old, loading: false, error }));
				} finally {
					reading = false;
					if (active && requested) request();
				}
			})();
		};
		refresh.current = request;
		const unsubscribe = api.subscribe((event) => {
			if (event.type === "supervisor") {
				const changed = knownEpoch !== undefined && knownEpoch !== event.view.serverEpoch;
				const becameReady = supervisorState !== "ready";
				knownEpoch = event.view.serverEpoch;
				supervisorState = event.view.state;
				if (event.view.state === "ready" && (changed || becameReady)) request();
				return;
			}
			if (event.type !== "app-server" || event.envelope.method !== "connection/events") return;
			const { serverEpoch, events } = event.envelope.params;
			if (
				events.some(
					(change) =>
						change.type === "agent/deleted" &&
						change.sessionId === sessionId &&
						change.deletedAgentIds.includes(agentId),
				)
			) {
				deleted = true;
				requested = false;
				setSnapshot({ identity, turns: [], loading: false });
				return;
			}
			const changed = knownEpoch !== undefined && knownEpoch !== serverEpoch;
			knownEpoch = serverEpoch;
			if (
				changed ||
				events.some(
					(change) =>
						"sessionId" in change &&
						change.sessionId === sessionId &&
						((change.type === "agent/updated" && change.agent.agentId === agentId) ||
							(change.type === "agent/itemsChanged" && change.agentId === agentId)),
				)
			)
				request();
		});
		request();
		return () => {
			active = false;
			unsubscribe();
		};
	}, [api, sessionId, agentId, identity]);
	const reload = useCallback(() => refresh.current(), []);
	return snapshot.identity === identity
		? { ...snapshot, reload }
		: { identity, turns: [] as readonly QueuedTurnView[], loading: true, error: undefined, reload };
}
