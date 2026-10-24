import type { ItemView } from "@metis/app-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MetisDesktopApi } from "../../shared/desktop-api.ts";
import { appendItemDelta } from "../store/reducer.ts";

export function mergeAgentItems(current: readonly ItemView[], incoming: readonly ItemView[]): ItemView[] {
	const items = new Map(current.map((item) => [item.itemId, item]));
	for (const item of incoming) items.set(item.itemId, item);
	return [...items.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

/** A fresh tail replaces temporary live IDs; only previously loaded older pages survive it. */
export function refreshAgentItems(
	current: readonly ItemView[],
	page: readonly ItemView[],
	concurrent: readonly ItemView[],
): ItemView[] {
	const first = page[0]?.createdAt;
	const pageIds = new Set(page.map((item) => item.itemId));
	const overlap = current.findIndex((item) => pageIds.has(item.itemId));
	const older = first
		? current.filter(
				(item, index) =>
					(item.createdAt < first || (overlap >= 0 && index < overlap && item.createdAt === first)) &&
					!item.itemId.startsWith("agent-live:") &&
					!item.itemId.startsWith("agent-input:"),
			)
		: [];
	return mergeAgentItems(mergeAgentItems(older, page), concurrent);
}

/** Each mounted conversation owns its history; two children never share a selected-transcript slot. */
export function useAgentHistory(
	api: Pick<MetisDesktopApi, "readAgentItems" | "subscribe">,
	sessionId: string,
	agentId: string,
) {
	const [items, setItems] = useState<readonly ItemView[]>([]);
	const [cursor, setCursor] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<unknown>();
	const mounted = useRef(false);
	const loadingOlder = useRef(false);
	const hasLoadedOlder = useRef(false);
	const generation = useRef(0);
	const refresh = useRef<() => void>(() => undefined);
	useEffect(() => {
		mounted.current = true;
		setItems([]);
		setCursor(null);
		setLoading(true);
		setError(undefined);
		hasLoadedOlder.current = false;
		const currentGeneration = ++generation.current;
		let reading = false;
		let requested = false;
		let latestEvents = new Map<string, ItemView>();
		const active = () => mounted.current && generation.current === currentGeneration;
		const request = () => {
			requested = true;
			if (reading) return;
			reading = true;
			void (async () => {
				try {
					while (requested && active()) {
						requested = false;
						latestEvents = new Map();
						const page = await api.readAgentItems({ sessionId, agentId, beforeItemId: null, limit: 200 });
						if (!active()) return;
						if (page.items.some((item) => item.sessionId !== agentId))
							throw new Error("History page does not belong to child");
						setItems((old) => refreshAgentItems(old, page.items, [...latestEvents.values()]));
						setCursor((previous) => (hasLoadedOlder.current ? previous : page.nextBeforeItemId));
						setError(undefined);
					}
				} catch (cause) {
					if (active()) setError(cause);
				} finally {
					reading = false;
					if (active()) setLoading(false);
				}
			})();
		};
		refresh.current = request;
		const unsubscribe = api.subscribe((event) => {
			if (!active() || event.type !== "app-server" || event.envelope.method !== "connection/events") return;
			for (const change of event.envelope.params.events) {
				if (!("agentId" in change) || change.agentId !== agentId || change.sessionId !== sessionId) continue;
				if (change.type === "agent/item/started" || change.type === "agent/item/completed") {
					latestEvents.set(change.item.itemId, change.item);
					setItems((old) => mergeAgentItems(old, [change.item]));
				} else if (change.type === "agent/item/delta") {
					setItems((old) =>
						old.map((item) => {
							if (item.itemId !== change.itemId || item.state !== "streaming") return item;
							const next = appendItemDelta(item, change.delta);
							latestEvents.set(item.itemId, next);
							return next;
						}),
					);
				} else if (change.type === "agent/itemsChanged") request();
			}
		});
		request();
		return () => {
			mounted.current = false;
			unsubscribe();
		};
	}, [api, sessionId, agentId]);
	const loadOlder = useCallback(async () => {
		if (!cursor || loadingOlder.current) return;
		loadingOlder.current = true;
		setLoading(true);
		const requestedGeneration = generation.current;
		try {
			const page = await api.readAgentItems({ sessionId, agentId, beforeItemId: cursor, limit: 200 });
			if (!mounted.current || requestedGeneration !== generation.current) return;
			if (page.items.some((item) => item.sessionId !== agentId))
				throw new Error("History page does not belong to child");
			hasLoadedOlder.current = true;
			setItems((old) => mergeAgentItems(page.items, old));
			setCursor(page.nextBeforeItemId);
		} catch (cause) {
			if (mounted.current && requestedGeneration === generation.current) setError(cause);
		} finally {
			loadingOlder.current = false;
			if (mounted.current && requestedGeneration === generation.current) setLoading(false);
		}
	}, [api, sessionId, agentId, cursor]);
	return { items, cursor, loading, error, loadOlder, reload: () => refresh.current() };
}
