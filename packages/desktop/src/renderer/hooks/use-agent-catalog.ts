import { useEffect, useSyncExternalStore } from "react";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { acquireAgentCatalog } from "../store/agent-catalog-store.ts";

export { mergeAgentCatalog } from "../store/agent-catalog-store.ts";

/** Reads the durable catalog without opening a runtime. Live changes arrive over the root connection. */
export function useAgentCatalog(api: Pick<MetisDesktopApi, "listAgents" | "subscribe">, sessionId: string) {
	const handle = acquireAgentCatalog(api, sessionId);
	const store = handle.store;
	useEffect(() => {
		handle.retain();
		return handle.release;
	}, [handle]);
	const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
	return {
		agents: snapshot.agents,
		loading: snapshot.loading,
		error: snapshot.error,
		reload: store.reload,
		unreadableAgentCount: snapshot.unreadableAgentCount,
	};
}
