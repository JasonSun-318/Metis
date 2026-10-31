import type { InteractionView, SessionSummary } from "@metis/app-protocol";
import { useCallback, useRef, useSyncExternalStore } from "react";
import { firstInteractionForSession } from "../session-view-utils.ts";
import type { AppStore, AppStoreSnapshot } from "../store/app-store.ts";
import type { MutableSessionProjection } from "../store/reducer.ts";

export interface SessionProjectionView {
	readonly bucket: MutableSessionProjection | undefined;
	readonly revision: number;
	readonly session: SessionSummary | undefined;
	readonly interaction: InteractionView | undefined;
	readonly interactions: readonly InteractionView[];
	readonly interactionsById: ReadonlyMap<string, InteractionView>;
	readonly serverEpoch: string | null;
	readonly serverReady: boolean;
}

// Non-focused panes stay subscribed but coalesce store notifications so
// streaming updates do not re-render every visible chat on every event.
const UNFOCUSED_NOTIFY_MS = 150;

function subscribeThrottled(store: AppStore, notify: () => void): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let lastNotify = 0;
	const unsubscribe = store.subscribe(() => {
		const now = Date.now();
		const elapsed = now - lastNotify;
		if (elapsed >= UNFOCUSED_NOTIFY_MS) {
			lastNotify = now;
			notify();
			return;
		}
		if (timer !== undefined) return;
		timer = setTimeout(() => {
			timer = undefined;
			lastNotify = Date.now();
			notify();
		}, UNFOCUSED_NOTIFY_MS - elapsed);
	});
	return () => {
		unsubscribe();
		if (timer !== undefined) clearTimeout(timer);
	};
}

function selectSessionView(snapshot: AppStoreSnapshot, sessionId: string): SessionProjectionView {
	const bucket = snapshot.sessions.get(sessionId);
	return {
		bucket,
		revision: bucket?.revision ?? -1,
		session: snapshot.sessionsById.get(sessionId),
		interactions: snapshot.interactionOrder.flatMap((id) => {
			const request = snapshot.interactionsById.get(id);
			return request && (request.actorSessionId ?? request.sessionId) === sessionId ? [request] : [];
		}),
		interaction: firstInteractionForSession(snapshot.interactionOrder, snapshot.interactionsById, sessionId),
		interactionsById: snapshot.interactionsById,
		serverEpoch: snapshot.serverEpoch,
		serverReady: snapshot.supervisor.state === "ready",
	};
}

function sameSessionView(left: SessionProjectionView, right: SessionProjectionView): boolean {
	return (
		left.bucket === right.bucket &&
		left.revision === right.revision &&
		left.session === right.session &&
		left.interaction === right.interaction &&
		left.interactions.length === right.interactions.length &&
		left.interactions.every((request, index) => request === right.interactions[index]) &&
		left.interactionsById === right.interactionsById &&
		left.serverEpoch === right.serverEpoch &&
		left.serverReady === right.serverReady
	);
}

export function useSessionProjection(store: AppStore, sessionId: string, focused: boolean): SessionProjectionView {
	const cache = useRef<{ snapshot: AppStoreSnapshot; view: SessionProjectionView } | undefined>(undefined);
	const getView = useCallback(() => {
		const snapshot = store.getSnapshot();
		if (cache.current?.snapshot === snapshot) return cache.current.view;
		const view = selectSessionView(snapshot, sessionId);
		if (cache.current && sameSessionView(cache.current.view, view)) {
			cache.current = { snapshot, view: cache.current.view };
			return cache.current.view;
		}
		cache.current = { snapshot, view };
		return view;
	}, [sessionId, store]);
	const subscribe = useCallback(
		(notify: () => void) => (focused ? store.subscribe(notify) : subscribeThrottled(store, notify)),
		[focused, store],
	);
	return useSyncExternalStore(subscribe, getView, getView);
}
